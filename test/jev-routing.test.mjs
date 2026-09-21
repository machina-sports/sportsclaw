/**
 * Opt-in skill routing (`src/routing/skill-routing.ts`) as the engine actually
 * reaches it — through `routePromptToSkills` — plus the engine-side boundary.
 *
 * Every test injects a transport and an env: no credential is read, no network
 * call is made, and the generative router is a MockLanguageModelV3 whose call
 * count is itself an assertion. Nothing here measures latency or real routing
 * accuracy; the Jev answers are synthetic fixtures.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { MockLanguageModelV3 } from "ai/test";

import { DEFAULT_JEV_MODEL } from "../dist/decision-client.js";
import { sportsclawEngine } from "../dist/engine.js";
import { routePromptToSkills } from "../dist/router.js";
import {
  buildSkillCandidates,
  deterministicSkillMatch,
  resolveSkillRoutingSettings,
  routeSkillsWithJev,
} from "../dist/routing/skill-routing.js";
import { DEFAULT_TOKEN_BUDGETS } from "../dist/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMockModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: "NOT_JSON" }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 10 },
        outputTokens: { total: 5 },
        totalTokens: { total: 15 },
        reasoningTokens: { total: undefined },
      },
      warnings: [],
    }),
  });
}

const baseConfig = {
  routingMode: "soft_lock",
  routingMaxSkills: 2,
  routingAllowSpillover: 1,
  thinkingBudget: 0,
  tokenBudgets: DEFAULT_TOKEN_BUDGETS,
};

function choice(chosen, probabilities, confidence) {
  return { type: "choice", choice: chosen, confidence, probabilities };
}

function dispositionAnswer(chosen, confidence = 0.97) {
  return choice(chosen, { select: 0, clarify: 0, unsupported: 0, [chosen]: 1 }, confidence);
}

function candidateAnswer(chosen, confidence = 0.97) {
  return choice(chosen, { required: 0, not_required: 0, unknown: 0, [chosen]: 1 }, confidence);
}

/**
 * Answers by skill ID rather than by opaque ref: the mapping from `c0`/`c1` to
 * skills is exactly what these tests must not assume.
 */
function jevTransport(requiredSkills, overrides = {}) {
  const calls = [];
  const transport = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, init, raw: init.body });
    const refs = body.state.capabilities.map((c) => c.ref);
    const answers = { disposition: dispositionAnswer("select") };
    for (const ref of refs) {
      const index = Number(ref.slice(1));
      answers[ref] = candidateAnswer(requiredSkills.includes(index) ? "required" : "not_required");
    }
    return new Response(
      JSON.stringify({
        model: DEFAULT_JEV_MODEL,
        answers,
        usage: { input_tokens: 100, output_tokens: 20 },
        ...overrides,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  return { calls, transport };
}

function failTransport() {
  return async () => assert.fail("no request may be sent on this path");
}

/** An env whose credential getter fails the test if it is ever read. */
function trapEnv() {
  return Object.defineProperty({}, "TYPESAFE_API_KEY", {
    get() {
      assert.fail("credential must not be read on this path");
    },
  });
}

function jevRouting(extra = {}) {
  return {
    provider: "jev",
    dataPolicy: "cloud_allowed",
    env: { TYPESAFE_API_KEY: "test-key" },
    ...extra,
  };
}

async function route(overrides) {
  const model = overrides.model ?? makeMockModel();
  const result = await routePromptToSkills({
    toolSpecs: [],
    modelId: "mock-model",
    provider: "anthropic",
    ...overrides,
    model,
    config: { ...baseConfig, ...(overrides.config ?? {}) },
  });
  return { result, model };
}

// ---------------------------------------------------------------------------
// Opt-in boundary
// ---------------------------------------------------------------------------

describe("routePromptToSkills opt-in boundary", () => {
  it("still uses the generative router when routing is unset or empty", async () => {
    for (const routing of [undefined, {}, { env: {} }]) {
      const { result, model } = await route({
        prompt: "who is winning tonight",
        installedSkills: ["nba", "nfl"],
        config: { ...(routing === undefined ? {} : { routing }) },
      });
      assert.equal(model.doGenerateCalls.length, 1, "the generative router must still be called");
      assert.equal(result.meta.llmAttempted, true);
      assert.equal(result.meta.routing, undefined, "legacy routes carry no routing telemetry");
    }
  });

  it("resolves defaults without reading anything the caller did not supply", () => {
    const settings = resolveSkillRoutingSettings({ env: {} });
    assert.equal(settings.provider, "generative");
    assert.equal(settings.dataPolicy, "local_only");
    assert.equal(settings.model, DEFAULT_JEV_MODEL);
    assert.equal(settings.timeoutMs, 8000);
    assert.equal(settings.confidenceThreshold, 0.9);
    assert.equal(settings.marginThreshold, 0.15);
    assert.equal(settings.maxSelected, 3);
    assert.equal(settings.includeRecentContext, false);
    assert.deepEqual(settings.diagnostics, []);
  });

  it("opts in from the environment as well as from explicit config", () => {
    const fromEnv = resolveSkillRoutingSettings({
      env: { SPORTSCLAW_ROUTING_PROVIDER: "jev", SPORTSCLAW_ROUTING_DATA_POLICY: "cloud_allowed" },
    });
    assert.equal(fromEnv.provider, "jev");
    assert.equal(fromEnv.dataPolicy, "cloud_allowed");

    // Explicit config wins over the environment, in both directions.
    const explicit = resolveSkillRoutingSettings({
      provider: "generative",
      env: { SPORTSCLAW_ROUTING_PROVIDER: "jev" },
    });
    assert.equal(explicit.provider, "generative");
  });

  it("reports a misconfigured router as unavailable instead of quietly falling back", async () => {
    for (const [routing, code] of [
      [jevRouting({ provider: "openai" }), "invalid_provider"],
      [jevRouting({ provider: 42 }), "invalid_provider"],
      [jevRouting({ model: 42 }), "invalid_model"],
      [jevRouting({ dataPolicy: false }), "invalid_dataPolicy"],
      [jevRouting({ dataPolicy: "cloud" }), "invalid_dataPolicy"],
      [jevRouting({ model: "gpt-4" }), "invalid_model"],
      [jevRouting({ timeoutMs: 10 }), "invalid_timeoutMs"],
      [jevRouting({ confidenceThreshold: 2 }), "invalid_confidenceThreshold"],
      [jevRouting({ maxSelected: 0 }), "invalid_maxSelected"],
    ]) {
      const { result, model } = await route({
        prompt: "who is winning tonight",
        installedSkills: ["nba", "nfl"],
        config: { routing: { ...routing, transport: failTransport() } },
      });
      assert.equal(model.doGenerateCalls.length, 0, `${code} must not fall back to generation`);
      assert.equal(result.meta.routing.status, "unavailable");
      assert.equal(result.meta.routing.reasonCode, code);
      assert.deepEqual(result.decision.selectedSkills, []);
      assert.equal(result.meta.llmAttempted, false);
    }
  });
});

// ---------------------------------------------------------------------------
// Deterministic fast path — no cloud, no credential, no generation
// ---------------------------------------------------------------------------

describe("skill routing deterministic fast path", () => {
  it("routes an exact simple request with no Jev call and no generative call", async () => {
    const { calls, transport } = jevTransport([]);
    const { result, model } = await route({
      prompt: "NBA and NFL scores",
      installedSkills: ["nba", "nfl", "mlb"],
      config: { routing: jevRouting({ transport, env: trapEnv() }) },
    });
    assert.equal(calls.length, 0, "a complete rule result must not reach the provider");
    assert.equal(model.doGenerateCalls.length, 0);
    assert.deepEqual(result.decision.selectedSkills, ["nba", "nfl"]);
    assert.equal(result.meta.routing.status, "selected");
    assert.equal(result.meta.routing.source, "deterministic");
    assert.equal(result.meta.routing.reasonCode, "deterministic_selection");
    // No model answered, so no model-derived number is invented.
    assert.equal(result.meta.routing.confidence, undefined);
    assert.equal(result.meta.routing.model, undefined);
  });

  it("matches only whole simple requests, not a sport named inside a sentence", () => {
    const installed = ["nba", "nfl", "football", "f1"];
    assert.deepEqual(deterministicSkillMatch("nba scores", installed), ["nba"]);
    assert.deepEqual(deterministicSkillMatch("NFL standings tonight", installed), ["nfl"]);
    assert.deepEqual(deterministicSkillMatch("soccer schedule", installed), ["football"]);
    for (const prompt of [
      "how did the nba scores look after the trade",
      "nba scores and give me a betting angle",
      "nba",
      "scores",
      "nba scores yesterday",
      "cricket scores",
    ]) {
      assert.equal(deterministicSkillMatch(prompt, installed), undefined, prompt);
    }
  });

  it("clarifies rather than dropping a sport when a rule result exceeds the cap", async () => {
    const { result, model } = await route({
      prompt: "NBA and NFL scores",
      installedSkills: ["nba", "nfl"],
      config: { routing: jevRouting({ maxSelected: 1, transport: failTransport(), env: trapEnv() }) },
    });
    assert.equal(model.doGenerateCalls.length, 0);
    assert.equal(result.meta.routing.status, "clarify");
    assert.equal(result.meta.routing.reasonCode, "too_many_required");
    assert.deepEqual(result.decision.selectedSkills, []);
    assert.equal(result.decision.needsClarification, true);
  });
});

// ---------------------------------------------------------------------------
// Jev path — one batched call, no legacy truncation
// ---------------------------------------------------------------------------

describe("skill routing jev path", () => {
  it("asks once and keeps every selected skill instead of the legacy focused slice", async () => {
    // routingMaxSkills is 2; the decision selects 3 and none is dropped.
    const { calls, transport } = jevTransport([0, 1, 2]);
    const { result, model } = await route({
      prompt: "compare tonight across the leagues I follow",
      installedSkills: ["nba", "nfl", "mlb", "nhl"],
      config: { routing: jevRouting({ transport }) },
    });
    assert.equal(calls.length, 1, "exactly one batched decision request");
    assert.equal(model.doGenerateCalls.length, 0, "no generative router call");
    assert.deepEqual(result.decision.selectedSkills, ["nba", "nfl", "mlb"]);
    assert.equal(result.meta.routing.status, "selected");
    assert.equal(result.meta.routing.source, "jev");
    assert.equal(result.meta.routing.model, DEFAULT_JEV_MODEL);
    assert.equal(result.meta.modelUsed, null);
    assert.equal(result.meta.llmAttempted, false);
  });

  it("refuses an oversize catalog rather than truncating it", async () => {
    const installedSkills = Array.from({ length: 31 }, (_v, i) => `sport_${i}`);
    const { calls, transport } = jevTransport([0]);
    const { result, model } = await route({
      prompt: "who is winning tonight",
      installedSkills,
      config: { routing: jevRouting({ transport }) },
    });
    assert.equal(calls.length, 0);
    assert.equal(model.doGenerateCalls.length, 0);
    assert.equal(result.meta.routing.status, "unavailable");
    assert.equal(result.meta.routing.reasonCode, "catalog_too_large");
    assert.deepEqual(result.decision.selectedSkills, []);
  });

  it("clarifies when deterministic helper skills push the union past the cap", async () => {
    // "news" is inferred as a helper by the existing rules and unioned onto the
    // decision; with maxSelected 1 the union no longer fits.
    const { transport } = jevTransport([0]);
    const { result } = await route({
      prompt: "any news on the lakers roster situation",
      installedSkills: ["nba", "news"],
      config: { routing: jevRouting({ transport, maxSelected: 1 }) },
    });
    assert.equal(result.meta.routing.status, "clarify");
    assert.equal(result.meta.routing.reasonCode, "too_many_required");
    assert.deepEqual(result.decision.selectedSkills, []);
  });

  it("unions an inferred helper skill onto a decision that still fits", async () => {
    const { transport } = jevTransport([0]);
    const { result } = await route({
      prompt: "any news on the lakers roster situation",
      installedSkills: ["nba", "news"],
      config: { routing: jevRouting({ transport }) },
    });
    assert.equal(result.meta.routing.status, "selected");
    assert.deepEqual(result.decision.selectedSkills, ["nba", "news"]);
  });

  it("refuses a helper skill that is not installed", async () => {
    const { transport } = jevTransport([0]);
    const outcome = await routeSkillsWithJev(
      {
        prompt: "any news on the roster",
        installedSkills: ["nba"],
        toolSpecs: [],
        helperSkills: ["news"],
      },
      resolveSkillRoutingSettings(jevRouting({ transport }))
    );
    assert.equal(outcome.meta.routing.status, "unavailable");
    assert.equal(outcome.meta.routing.reasonCode, "invalid_helper");
    assert.deepEqual(outcome.decision.selectedSkills, []);
  });
});

// ---------------------------------------------------------------------------
// Failures — one attempt, never a weaker selection
// ---------------------------------------------------------------------------

describe("skill routing failures", () => {
  it("never reaches a credential under a local-only policy", async () => {
    const { result, model } = await route({
      prompt: "who is winning tonight",
      installedSkills: ["nba", "nfl"],
      config: {
        routing: { provider: "jev", transport: failTransport(), env: trapEnv() },
      },
    });
    assert.equal(model.doGenerateCalls.length, 0);
    assert.equal(result.meta.routing.status, "unavailable");
    assert.equal(result.meta.routing.reasonCode, "local_only");
  });

  it("reports a missing credential, a denied auth and a cancellation without falling back", async () => {
    const cases = [
      { routing: jevRouting({ transport: failTransport(), env: {} }), code: "missing_credential" },
      {
        routing: jevRouting({
          transport: async () => new Response("{}", { status: 403, headers: { "content-type": "application/json" } }),
        }),
        code: "auth_denied",
      },
    ];
    for (const { routing, code } of cases) {
      const { result, model } = await route({
        prompt: "who is winning tonight",
        installedSkills: ["nba", "nfl"],
        config: { routing },
      });
      assert.equal(model.doGenerateCalls.length, 0, `${code} must not fall back to generation`);
      assert.equal(result.meta.routing.status, "unavailable");
      assert.equal(result.meta.routing.reasonCode, code);
      assert.deepEqual(result.decision.selectedSkills, []);
      assert.equal(result.decision.needsClarification, false);
    }

    const controller = new AbortController();
    controller.abort();
    const { result, model } = await route({
      prompt: "who is winning tonight",
      installedSkills: ["nba", "nfl"],
      abortSignal: controller.signal,
      config: { routing: jevRouting({ transport: failTransport() }) },
    });
    assert.equal(model.doGenerateCalls.length, 0);
    assert.equal(result.meta.routing.status, "unavailable");
    assert.equal(result.meta.routing.reasonCode, "aborted");
  });

  it("clarifies rather than guessing when the decision is unconfident", async () => {
    const transport = async (_url, init) => {
      const body = JSON.parse(init.body);
      const answers = {};
      for (const id of Object.keys(body.questions)) {
        answers[id] =
          id === "disposition" ? dispositionAnswer("select", 0.4) : candidateAnswer("required", 0.4);
      }
      return new Response(JSON.stringify({ model: DEFAULT_JEV_MODEL, answers }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const { result } = await route({
      prompt: "what should I look at tonight",
      installedSkills: ["nba", "nfl"],
      config: { routing: jevRouting({ transport }) },
    });
    assert.equal(result.meta.routing.status, "clarify");
    assert.equal(result.meta.routing.reasonCode, "low_confidence");
    assert.equal(result.decision.needsClarification, true);
    assert.deepEqual(result.decision.selectedSkills, []);
  });
});

// ---------------------------------------------------------------------------
// What leaves the process
// ---------------------------------------------------------------------------

describe("skill routing privacy surface", () => {
  const MEMORY = "### Fan Profile (FAN_PROFILE.md)\nSECRET_FAN_MARKER: bets big on the lakers.";
  const CONTEXT = "SECRET_CONTEXT_MARKER what about tomorrow";

  it("never sends the memory block, and sends recent context only when explicitly enabled", async () => {
    const withheld = jevTransport([0]);
    await route({
      prompt: "what should I look at tonight",
      installedSkills: ["nba", "nfl"],
      memoryBlock: MEMORY,
      recentContext: CONTEXT,
      config: { routing: jevRouting({ transport: withheld.transport }) },
    });
    const sent = withheld.calls[0].raw;
    assert.ok(!sent.includes("SECRET_FAN_MARKER"), "memory must never be sent");
    assert.ok(!sent.includes("SECRET_CONTEXT_MARKER"), "recent context is opt-in");
    assert.equal(JSON.parse(sent).state.recentContext, "(none)");

    const included = jevTransport([0]);
    await route({
      prompt: "what should I look at tonight",
      installedSkills: ["nba", "nfl"],
      memoryBlock: MEMORY,
      recentContext: CONTEXT,
      config: { routing: jevRouting({ transport: included.transport, includeRecentContext: true }) },
    });
    const sentWithContext = included.calls[0].raw;
    assert.ok(sentWithContext.includes("SECRET_CONTEXT_MARKER"), "explicit opt-in must include context");
    assert.ok(!sentWithContext.includes("SECRET_FAN_MARKER"), "memory stays out even then");
  });

  it("describes skills by operation name only, without argument schemas", () => {
    const candidates = buildSkillCandidates(
      ["nba"],
      [
        { name: "nba_get_scores", description: "x", parameters: { apiKey: "string" } },
        { name: "nba_get_standings", description: "y", parameters: {} },
        { name: "nfl_get_scores", description: "z", parameters: {} },
      ]
    );
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].id, "nba");
    assert.match(candidates[0].description, /get scores/);
    assert.match(candidates[0].description, /get standings/);
    assert.ok(!candidates[0].description.includes("apiKey"));
  });

  it("keeps the routing receipt to enums and numbers — never the prompt", async () => {
    const { transport } = jevTransport([0]);
    const { result } = await route({
      prompt: "SECRET_PROMPT_MARKER who is winning tonight",
      installedSkills: ["nba", "nfl"],
      config: { routing: jevRouting({ transport }) },
    });
    const routing = result.meta.routing;
    for (const key of Object.keys(routing)) {
      assert.ok(
        ["status", "source", "reasonCode", "model", "confidence", "margin", "latencyMs"].includes(key),
        `unexpected routing telemetry field: ${key}`
      );
    }
    assert.ok(!JSON.stringify(result.meta).includes("SECRET_PROMPT_MARKER"));
    // The decision reason is a fixed enum echo, not model or user prose.
    assert.match(result.decision.reason, /^Jev routing: [a-z_]+$/);
  });
});

// ---------------------------------------------------------------------------
// Engine boundary
// ---------------------------------------------------------------------------

/**
 * `resolveActiveToolsForPrompt` is the engine method that carries a routing
 * outcome back to `run()`. It is reachable without credentials via a prototype
 * instance, so these tests are executable. The `run()` control flow itself is
 * NOT executed here (see the ordering test below for what is and is not
 * verified).
 */
function engineStub({ routing, installedSkills = ["nba", "nfl"], messages = [] }) {
  const engine = Object.create(sportsclawEngine.prototype);
  const toolSpecs = installedSkills.map((skill) => ({
    name: `${skill}_get_scores`,
    description: "scores",
    parameters: {},
  }));
  engine.registry = {
    getInstalledSkills: () => installedSkills,
    getAllToolSpecs: () => toolSpecs,
    getSkillName: (name) => installedSkills.find((skill) => name.startsWith(`${skill}_`)),
  };
  engine.messages = messages;
  engine.mainModel = makeMockModel();
  engine.mainModelId = "mock-model";
  engine.config = { ...baseConfig, provider: "anthropic", routing };
  return engine;
}

describe("engine routing boundary", () => {
  it("carries a non-selected decision back as routeMeta.routing with no tools and no model call", async () => {
    const engine = engineStub({
      routing: jevRouting({ transport: failTransport(), env: {} }),
      messages: [{ role: "user", content: "who is winning" }],
    });
    const result = await engine.resolveActiveToolsForPrompt("who is winning tonight", [
      "nba_get_scores",
      "nfl_get_scores",
      "save_memory",
    ]);
    assert.equal(result.routeMeta.routing.status, "unavailable");
    assert.equal(result.routeMeta.routing.reasonCode, "missing_credential");
    assert.equal(engine.mainModel.doGenerateCalls.length, 0);
    // Skill tools are filtered out; engine-owned tools are untouched by routing.
    assert.deepEqual(result.activeTools, ["save_memory"]);
  });

  it("carries a selected decision back with the routed skill tools active", async () => {
    const { transport } = jevTransport([0]);
    const engine = engineStub({ routing: jevRouting({ transport }) });
    const result = await engine.resolveActiveToolsForPrompt("what should I look at tonight", [
      "nba_get_scores",
      "nfl_get_scores",
      "save_memory",
    ]);
    assert.equal(result.routeMeta.routing.status, "selected");
    assert.deepEqual(result.decision.selectedSkills, ["nba"]);
    assert.deepEqual(result.activeTools, ["nba_get_scores", "save_memory"]);
  });

  it("leaves a legacy (unconfigured) route with no routing telemetry at the engine boundary", async () => {
    const engine = engineStub({ routing: { env: {} } });
    const result = await engine.resolveActiveToolsForPrompt("who is winning tonight", ["nba_get_scores"]);
    assert.equal(result.routeMeta.routing, undefined);
    assert.equal(engine.mainModel.doGenerateCalls.length, 1);
  });

  /**
   * TEST LIMIT — READ BEFORE TRUSTING THIS.
   *
   * `run()` needs memory, tool construction, analytics and a live-ish provider
   * to execute, which is far wider than this change. So the ordering of the
   * refusal against history widening and the main model call is checked
   * STATICALLY, against the compiled source. This proves the branch is placed
   * before those steps; it does NOT execute them, and it would not catch a
   * later `run()` path that re-enters routing. End-to-end refusal behaviour of
   * `run()` is unverified.
   */
  it("places the refusal return before history widening and the main model call (source order only)", () => {
    const source = readFileSync(new URL("../dist/engine.js", import.meta.url), "utf8");
    const refusal = source.indexOf("const refusal = routingRefusalMessage(routingOutcome)");
    const resolve = source.indexOf("this.resolveActiveToolsForPrompt(");
    const widening = source.indexOf("const historyToolNames = new Set()");
    assert.ok(refusal > 0 && resolve > 0 && widening > 0, "expected all three markers in dist/engine.js");
    assert.ok(resolve < refusal, "the refusal must be decided after routing resolves");
    assert.ok(refusal < widening, "the refusal must return before history widening");
    const generate = source.indexOf("generateText(", widening);
    assert.ok(generate > widening, "expected the main generateText call after history widening");
  });
});
