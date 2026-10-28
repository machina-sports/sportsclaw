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
import { CapabilityRouter } from "../dist/routing/capability-router.js";
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

/**
 * A choice answer over exactly the labels the question offered, so a fixture
 * never assumes the router's option set. `probabilities` names the non-zero
 * weights; every other offered label gets 0.
 */
function answerFor(question, chosen, confidence = 0.97, probabilities = { [chosen]: 1 }) {
  const labels = Object.keys(question.criteria);
  return choice(chosen, Object.fromEntries(labels.map((label) => [label, probabilities[label] ?? 0])), confidence);
}

/**
 * Answers by skill ID rather than by opaque ref: the mapping from `c0`/`c1` to
 * skills is exactly what these tests must not assume. `plan` scripts the
 * disposition and, optionally, one answer for every capability.
 */
function jevTransport(requiredSkills, plan = {}) {
  const { disposition = "select", confidence = 0.97, probabilities, capability } = plan;
  const calls = [];
  const transport = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, init, raw: init.body });
    const answers = {};
    for (const [id, question] of Object.entries(body.questions)) {
      answers[id] =
        id === "disposition"
          ? answerFor(question, disposition, confidence, probabilities)
          : answerFor(
              question,
              capability ?? (requiredSkills.includes(Number(id.slice(1))) ? "required" : "not_required")
            );
    }
    return new Response(
      JSON.stringify({ model: body.model, answers, usage: { input_tokens: 100, output_tokens: 20 } }),
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
      // The mock returns no JSON, so the generative router is retried once.
      assert.equal(model.doGenerateCalls.length, 2, "the generative router must still be called");
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

  it("pins the decision model from SPORTSCLAW_ROUTING_MODEL, explicit config first, malformed refused", async () => {
    assert.equal(resolveSkillRoutingSettings({ env: {} }).model, DEFAULT_JEV_MODEL, "default unchanged");

    const fromEnv = resolveSkillRoutingSettings({ env: { SPORTSCLAW_ROUTING_MODEL: "jev-1.14.0" } });
    assert.equal(fromEnv.model, "jev-1.14.0");
    assert.deepEqual(fromEnv.diagnostics, []);

    for (const envModel of ["jev-1.14.0", "gpt-4"]) {
      const explicit = resolveSkillRoutingSettings({
        model: "jev-1.13.0",
        env: { SPORTSCLAW_ROUTING_MODEL: envModel },
      });
      assert.equal(explicit.model, "jev-1.13.0", "explicit config wins over the environment");
      assert.deepEqual(explicit.diagnostics, []);
    }

    // The pinned model is the one actually requested and reported.
    const { calls, transport } = jevTransport([0]);
    const pinned = await route({
      prompt: "what should I look at tonight",
      installedSkills: ["nba", "nfl"],
      config: {
        routing: jevRouting({ transport, env: { TYPESAFE_API_KEY: "test-key", SPORTSCLAW_ROUTING_MODEL: "jev-1.14.0" } }),
      },
    });
    assert.equal(calls[0].body.model, "jev-1.14.0");
    assert.equal(pinned.result.meta.routing.model, "jev-1.14.0");

    const { result, model } = await route({
      prompt: "what should I look at tonight",
      installedSkills: ["nba", "nfl"],
      config: {
        routing: jevRouting({
          transport: failTransport(),
          env: { TYPESAFE_API_KEY: "test-key", SPORTSCLAW_ROUTING_MODEL: "gpt-4" },
        }),
      },
    });
    assert.equal(model.doGenerateCalls.length, 0);
    assert.equal(result.meta.routing.status, "unavailable");
    assert.equal(result.meta.routing.reasonCode, "invalid_model");
    assert.deepEqual(result.decision.selectedSkills, []);
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

  // Advisory shortlist (explicit user decision): the wrapper passes Jev's
  // suggestions through and never adds inferred helper skills.
  it("adds no inferred helper skill, even when it would fit or exceed the cap", async () => {
    for (const maxSelected of [1, 3]) {
      const { transport } = jevTransport([0]);
      const { result } = await route({
        prompt: "any news on the lakers roster situation",
        installedSkills: ["nba", "news"],
        config: { routing: jevRouting({ transport, maxSelected }) },
      });
      assert.equal(result.meta.routing.status, "selected", String(maxSelected));
      assert.equal(result.meta.routing.reasonCode, "advisory_selection");
      assert.deepEqual(result.decision.selectedSkills, ["nba"], String(maxSelected));
    }
  });

  it("ignores a helper skill, installed or not, instead of adding or refusing on it", async () => {
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
    assert.equal(outcome.meta.routing.status, "selected");
    assert.deepEqual(outcome.decision.selectedSkills, ["nba"]);
  });

  it("passes a low-confidence suggestion through as a bounded shortlist, keeping its uncertainty", async () => {
    const { calls, transport } = jevTransport([0], { confidence: 0.67, probabilities: { select: 0.67, clarify: 0.33 } });
    const { result, model } = await route({
      prompt: "how did the lakers do",
      installedSkills: ["nba", "nfl", "news"],
      config: { routing: jevRouting({ transport }) },
    });
    assert.equal(calls.length, 1, "one decision request");
    assert.equal(model.doGenerateCalls.length, 0, "no generative router call");
    assert.equal(result.meta.routing.status, "selected");
    assert.equal(result.meta.routing.reasonCode, "advisory_selection");
    assert.deepEqual(result.decision.selectedSkills, ["nba"], "only the suggestion, not the catalog");
    assert.equal(result.decision.needsClarification, false);
    assert.ok(result.meta.routing.confidence < 0.9, `uncertainty kept, got ${result.meta.routing.confidence}`);
    assert.ok(result.decision.confidence < 1, "never promoted to certainty");
  });
});

// ---------------------------------------------------------------------------
// Failures — one attempt, never a weaker selection
// ---------------------------------------------------------------------------

describe("skill routing explicit no_tools", () => {
  const CANDIDATES = [
    { id: "nba", description: 'Sports data skill "nba". Available operations: get scores.' },
    { id: "nfl", description: 'Sports data skill "nfl". Available operations: get scores.' },
  ];

  it("returns a confident no_tools from the generic router as its own outcome, never as an empty selection", async () => {
    const { calls, transport } = jevTransport([], { disposition: "no_tools" });
    const router = new CapabilityRouter({
      provider: "jev",
      dataPolicy: "cloud_allowed",
      env: { TYPESAFE_API_KEY: "test-key" },
      transport,
    });
    const outcome = await router.route({ prompt: "Hi, thanks!", candidates: CANDIDATES });
    assert.equal(calls.length, 1);
    assert.ok("no_tools" in calls[0].body.questions.disposition.criteria, "the disposition must offer no_tools");
    assert.equal(outcome.status, "no_tools");
    assert.equal(outcome.reasonCode, "model_no_tools");
    assert.equal(outcome.source, "jev");
    assert.equal(outcome.selectedIds, undefined);
    assert.equal(outcome.confidence, 0.97);
    assert.deepEqual(Object.keys(outcome).sort(), ["confidence", "margin", "model", "reasonCode", "receipt", "source", "status"]);
  });

  it("carries a confident no_tools through the wrapper with no skills and no helper union", async () => {
    // "news" is an inferred helper for this prompt; no_tools must not union it.
    const { calls, transport } = jevTransport([], { disposition: "no_tools" });
    const { result, model } = await route({
      prompt: "thanks, the latest news recap was great",
      installedSkills: ["nba", "news"],
      config: { routing: jevRouting({ transport }) },
    });
    assert.equal(calls.length, 1);
    assert.equal(model.doGenerateCalls.length, 0, "no generative router call");
    assert.equal(result.meta.routing.status, "no_tools");
    assert.equal(result.meta.routing.source, "jev");
    assert.equal(result.meta.routing.reasonCode, "advisory_no_tools");
    assert.equal(result.meta.routing.model, DEFAULT_JEV_MODEL);
    assert.deepEqual(result.decision.selectedSkills, []);
    assert.equal(result.decision.needsClarification, false);
    assert.equal(result.meta.llmAttempted, false);
  });

  // Advisory shortlist (explicit user decision): an unconfident, thin or
  // inconsistent answer, or a semantic clarify/unsupported, suggests no input.
  // The engine then answers with external executors disabled; it is not a refusal.
  it("suggests no input for an unconfident, thin or abstaining answer", async () => {
    // 0.89 is the public probe's "Hi, thanks!" confidence; the 0.9 default stays.
    for (const [label, plan] of [
      ["low_confidence", { disposition: "no_tools", confidence: 0.89 }],
      ["low_margin", { disposition: "no_tools", probabilities: { no_tools: 0.52, select: 0.48 } }],
      ["unknown", { disposition: "no_tools", capability: "unknown" }],
      ["select-with-nothing", { disposition: "select" }],
      ["clarify", { disposition: "clarify" }],
      ["unsupported", { disposition: "unsupported" }],
    ]) {
      const { calls, transport } = jevTransport([], plan);
      const { result, model } = await route({
        prompt: "Hi, thanks!",
        installedSkills: ["nba", "nfl"],
        config: { routing: jevRouting({ transport }) },
      });
      assert.equal(calls.length, 1, label);
      assert.equal(model.doGenerateCalls.length, 0, label);
      assert.equal(result.meta.routing.status, "no_tools", label);
      assert.equal(result.meta.routing.reasonCode, "advisory_no_tools", label);
      assert.equal(result.decision.needsClarification, false, label);
      assert.deepEqual(result.decision.selectedSkills, [], label);
    }
  });

  it("does not reinterpret an empty catalog or a failure as no_tools", async () => {

    const router = (transport) =>
      new CapabilityRouter({ provider: "jev", dataPolicy: "cloud_allowed", env: { TYPESAFE_API_KEY: "test-key" }, transport });
    const empty = await router(failTransport()).route({ prompt: "Hi, thanks!", candidates: [] });
    assert.equal(empty.status, "unsupported");
    assert.equal(empty.reasonCode, "empty_catalog");
    const failed = await router(
      async () => new Response("{}", { status: 500, headers: { "content-type": "application/json" } })
    ).route({ prompt: "Hi, thanks!", candidates: CANDIDATES });
    assert.equal(failed.status, "unavailable");
    assert.equal(failed.reasonCode, "upstream_error");
  });
});

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

  it("keeps an unconfident decision as advisory suggestions with its uncertainty, within the cap", async () => {
    const transport = async (_url, init) => {
      const body = JSON.parse(init.body);
      const answers = {};
      for (const [id, question] of Object.entries(body.questions)) {
        answers[id] = answerFor(question, id === "disposition" ? "select" : "required", 0.4);
      }
      return new Response(JSON.stringify({ model: DEFAULT_JEV_MODEL, answers }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const { result } = await route({
      prompt: "what should I look at tonight",
      installedSkills: ["nba", "nfl", "mlb"],
      config: { routing: jevRouting({ transport, maxSelected: 2 }) },
    });
    assert.equal(result.meta.routing.status, "selected");
    assert.equal(result.meta.routing.reasonCode, "advisory_selection");
    assert.equal(result.meta.routing.confidence, 0.4, "the uncertainty is reported, not replaced");
    assert.equal(result.decision.needsClarification, false);
    // All tie on required probability: catalog order, capped at maxSelected.
    assert.deepEqual(result.decision.selectedSkills, ["nba", "nfl"]);
  });
});

// ---------------------------------------------------------------------------
// Routing scope — skill routing judges external inputs, not the whole request
// ---------------------------------------------------------------------------

describe("skill routing scope", () => {
  it("opts the generic router into external_inputs without altering the prompt, history or call count", async () => {
    const prompt = "Explain what a rebound is and tidy the wording of my own draft";
    const context = "earlier: my draft says we outrebounded them";
    const wrapped = jevTransport([], { disposition: "no_tools" });
    const { result, model } = await route({
      prompt,
      installedSkills: ["nba", "nfl"],
      recentContext: context,
      config: { routing: jevRouting({ transport: wrapped.transport, includeRecentContext: true }) },
    });
    assert.equal(wrapped.calls.length, 1, "one decision request, no additional provider call");
    assert.equal(model.doGenerateCalls.length, 0, "no generative router call");
    assert.equal(result.meta.routing.status, "no_tools");
    const sent = wrapped.calls[0].body;
    assert.equal(sent.state.request, prompt, "the untrusted request is sent verbatim");
    assert.equal(sent.state.recentContext, context, "and so is the opted-in history");

    // The same request through the generic router, under each scope.
    const direct = async (extra) => {
      const { calls, transport } = jevTransport([], { disposition: "no_tools" });
      await new CapabilityRouter({
        provider: "jev",
        dataPolicy: "cloud_allowed",
        env: { TYPESAFE_API_KEY: "test-key" },
        transport,
        ...extra,
      }).route({ prompt, candidates: buildSkillCandidates(["nba", "nfl"], []), recentContext: context });
      return calls[0].body;
    };
    const external = await direct({ scope: "external_inputs" });
    const generic = await direct({});
    assert.deepEqual(sent.questions, external.questions, "the wrapper asks the external_inputs questions");
    assert.notDeepEqual(sent.questions, generic.questions, "not the whole-request ones");
    assert.deepEqual(sent.state, external.state, "the scope policy lives in the questions, never in the state");
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
    assert.equal(engine.mainModel.doGenerateCalls.length, 2, "one route attempt plus one retry of its unparseable answer");
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
    const generate = source.indexOf("generate(", widening);
    assert.ok(generate > widening, "expected the unified main generation call after history widening");
  });
});
