/**
 * Slip runtime — the request-scoped output tool on the engine's real path.
 *
 *   - `collector.observeStep(step)` fed by the installed SDK's real
 *     generateText dispatch: a dispatch failure (malformed JSON, unknown tool,
 *     missing/extra args) before or after a valid proposal withholds it; an
 *     ordinary error payload from a successfully dispatched tool does not;
 *     overlapping collectors stay isolated (slip-integration-contract.md §1).
 *   - `agent_suggestion` leg provenance: quotedOdds null only; user sources keep
 *     their exact quoted strings.
 *   - `sportsclawEngine.run(prompt, {slip, onSlipResult})` with a scripted AI SDK
 *     model and a fake Jev fetch only (§3): gates before model work, the output
 *     tool offered on the normal generate path, exactly one correlated typed
 *     result, raw requestText (not the composed prompt/history) to Jev, legacy
 *     callers unchanged, allowlists never broadened.
 *
 * HOME is a fresh temp dir so no real config, schemas, agents or memory load.
 * Any fetch other than the fake Jev endpoint fails the run and is counted.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { generateText, stepCountIs, tool, jsonSchema } from "ai";
import { MockLanguageModelV3 } from "ai/test";

globalThis.AI_SDK_LOG_WARNINGS = false;

const home = mkdtempSync(join(tmpdir(), "sportsclaw-slip-runtime-"));
const ENV_KEYS = [
  "HOME", "USERPROFILE", "sportsclaw_SCHEMA_DIR", "SPORTSCLAW_SCHEMA_DIR", "SPORTSCLAW_SESSION_DIR",
  "SPORTSCLAW_SLIP_ENABLED", "SPORTSCLAW_SLIP_JEV_DATA_POLICY", "SPORTSCLAW_SLIP_NATIVE_ONLY",
  "SPORTSCLAW_WATCH_INTENT_NATIVE_CONFIG", "SPORTSCLAW_MEMORY_PROVIDER", "TYPESAFE_API_KEY", "ANTHROPIC_API_KEY",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
for (const key of ENV_KEYS) delete process.env[key];
process.env.HOME = home;
process.env.USERPROFILE = home;
// Placeholder only: the engine's model is replaced by a scripted one below.
process.env.ANTHROPIC_API_KEY = "synthetic-anthropic-placeholder";

const slip = await import("../dist/slip-output.js");
const { sportsclawEngine } = await import("../dist/engine.js");

// ---------------------------------------------------------------------------
// Network: only the fake Jev endpoint answers
// ---------------------------------------------------------------------------

const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-1.14.0";
const JEV_KEY = "synthetic-typesafe-test-credential";
const ACTIONS = ["create", "append", "remove", "replace", "review", "none", "clarify"];

let escapedFetches = 0;
let realFetch;
/** Per-test Jev answer: (question, wire) => option name. Unset means Jev must not be called. */
let jevAnswer;
const jevCalls = [];

function choice(question, option) {
  const keys = Object.keys(question.criteria);
  assert.ok(keys.includes(option), `offered options must include ${option}`);
  const probabilities = Object.fromEntries(keys.map((k) => [k, k === option ? 0.9 : 0.1 / (keys.length - 1)]));
  return { type: "choice", choice: option, confidence: 0.95, probabilities };
}

before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url) !== JEV_ENDPOINT || !jevAnswer) {
      escapedFetches += 1;
      throw new Error("network is forbidden in these tests");
    }
    const wire = JSON.parse(init.body);
    jevCalls.push({ init, wire });
    const answers = {};
    for (const [id, question] of Object.entries(wire.questions)) answers[id] = choice(question, jevAnswer(question, wire));
    return new Response(JSON.stringify({ model: JEV_MODEL, answers, usage: { input_tokens: 9, output_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
});

after(() => {
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
  assert.equal(escapedFetches, 0, "only the fake Jev endpoint may be reached");
});

const GATES = {
  SPORTSCLAW_SLIP_ENABLED: "true",
  SPORTSCLAW_SLIP_JEV_DATA_POLICY: "cloud_allowed",
  TYPESAFE_API_KEY: JEV_KEY,
};

/** Run `fn` with exactly these slip env vars set (server environment). */
async function withEnv(patch, fn) {
  const keys = [...new Set([...Object.keys(GATES), "SPORTSCLAW_SLIP_NATIVE_ONLY", ...Object.keys(patch)])];
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, patch);
  jevCalls.length = 0;
  try {
    return await fn();
  } finally {
    jevAnswer = undefined;
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sid = (prefix, tag) => `${prefix}_${(tag + "0".repeat(22)).slice(0, 22)}`;
const clone = (value) => structuredClone(value);

const REV_ID = sid("slr", "SENTINELrev");
const LEG_IDS = [sid("sll", "SENTINELlegA"), sid("sll", "SENTINELlegB")];

const LEG_A = {
  event: "Chelsea vs Arsenal", market: "Match result", selection: "Chelsea", period: null, line: null,
  quotedOdds: { value: "2.10", format: "decimal" }, source: "user_text", unresolved: [],
};
const LEG_B = {
  event: "Flamengo vs Palmeiras", market: "Total goals", selection: "Over", period: null, line: "2.5",
  quotedOdds: { value: "11/10", format: "fractional" }, source: "user_image", unresolved: [],
};
const SUGGESTED = {
  event: "Lakers vs Celtics", market: "Spread", selection: "Lakers", period: null, line: "-3.5",
  quotedOdds: null, source: "agent_suggestion", unresolved: [],
};

const CONTEXT = Object.freeze({
  contract: "slip-revision-v1",
  slipId: sid("slp", "SENTINELslip"),
  revisionId: REV_ID,
  parentRevisionId: null,
  status: "proposed",
  legs: [LEG_A, LEG_B].map((leg, i) => ({ ...clone(leg), id: LEG_IDS[i] })),
  unresolved: [],
});

const change = (action, { base = null, targets = [], legs = [] } = {}) => ({
  contract: "slip-change-v1", action, baseRevisionId: base, targetLegIds: targets, legs: legs.map(clone), unresolved: [],
});
const CREATE = change("create", { legs: [LEG_A, LEG_B] });

const turn = (requestText, context = null) => ({ contract: "slip-turn-v1", requestText, context: context && clone(context) });

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const hashOf = (value) => createHash("sha256").update(canonical(value), "utf8").digest("hex");

// ---------------------------------------------------------------------------
// Scripted AI SDK model
// ---------------------------------------------------------------------------

const USAGE = {
  inputTokens: { total: 10 }, outputTokens: { total: 5 }, totalTokens: { total: 15 }, reasoningTokens: { total: undefined },
};
const VERDICT_OK = JSON.stringify({ isValid: true, discrepancies: [] });
const FINAL = "Drafted 2 legs: Chelsea to beat Arsenal and Flamengo v Palmeiras over 2.5. Draft only, no bet placed.";

let callSeq = 0;
const callId = () => `call_${++callSeq}`;
const slipCall = (input) => ({
  type: "tool-call", toolCallId: callId(), toolName: "submit_slip_change",
  input: typeof input === "string" ? input : JSON.stringify(input),
});
const toolCall = (toolName, input) => ({ type: "tool-call", toolCallId: callId(), toolName, input });
const say = (text) => ({ type: "text", text });

function generated(content) {
  const calls = content.some((part) => part.type === "tool-call");
  return { content, finishReason: { unified: calls ? "tool-calls" : "stop", raw: undefined }, usage: USAGE, warnings: [] };
}

/**
 * One scripted step per tool-bearing call; tool-less calls (fact-check,
 * synthesis) get a clean verdict and are not counted as chat steps.
 */
function scripted(steps, { delayMs = 0 } = {}) {
  const chat = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (!options.tools || options.tools.length === 0) return generated([say(VERDICT_OK)]);
      chat.push(options);
      return generated(steps[chat.length - 1] ?? [say(FINAL)]);
    },
  });
  return { model, chat, all: model.doGenerateCalls };
}

const offeredNames = (options) => (options.tools ?? []).map((t) => t.name);

// ---------------------------------------------------------------------------
// collector.observeStep through the SDK's real dispatch
// ---------------------------------------------------------------------------

/** An unrelated tool that is dispatched successfully and returns an error payload. */
const scoresTool = () => tool({
  description: "Scores",
  inputSchema: jsonSchema({ type: "object", properties: { team: { type: "string" } }, required: ["team"] }),
  execute: async () => ({ ok: false, error: "scores feed unavailable" }),
});

async function drive(collector, steps, extraTools = {}, opts) {
  const { model } = scripted(steps, opts);
  const result = await generateText({
    model,
    prompt: "Make me a slip: Chelsea to win at 2.10 and Flamengo over 2.5 at 11/10",
    tools: { submit_slip_change: collector.tool, ...extraTools },
    stopWhen: stepCountIs(6),
    onStepFinish: (step) => collector.observeStep(step),
  });
  return result;
}

describe("collector.observeStep with real SDK dispatch", () => {
  it("keeps a clean valid proposal clean", async () => {
    const collector = slip.createSlipOutputCollector(null);
    await drive(collector, [[slipCall(CREATE)], [say(FINAL)]]);
    assert.deepEqual(collector.finish(), CREATE);
    assert.equal(collector.invalid(), false);
  });

  it("is an ordinary no-artifact turn when nothing is proposed and nothing fails", async () => {
    const collector = slip.createSlipOutputCollector(null);
    await drive(collector, [[say("Chelsea kick off at 17:30 on Saturday.")]]);
    assert.equal(collector.finish(), undefined);
    assert.equal(collector.invalid(), false);
  });

  const after = {
    "malformed JSON arguments": slipCall("{not json"),
    "an unknown tool": toolCall("submit_slip_changes", JSON.stringify(CREATE)),
    "missing arguments": slipCall("{}"),
    "an extra argument": slipCall({ ...CREATE, saved: true }),
  };
  for (const [label, bad] of Object.entries(after)) {
    it(`withholds a valid proposal followed by ${label}`, async () => {
      const collector = slip.createSlipOutputCollector(null);
      await drive(collector, [[slipCall(CREATE)], [bad], [say(FINAL)]]);
      assert.equal(collector.finish(), undefined, label);
      assert.equal(collector.invalid(), true, label);
    });
  }

  it("a prior dispatch failure keeps a later valid proposal from being clean", async () => {
    const collector = slip.createSlipOutputCollector(null);
    await drive(collector, [[slipCall("{not json")], [slipCall(CREATE)], [say(FINAL)]]);
    assert.equal(collector.finish(), undefined);
    assert.equal(collector.invalid(), true);
  });

  it("a prior unknown-tool dispatch keeps a later valid proposal from being clean", async () => {
    const collector = slip.createSlipOutputCollector(null);
    await drive(collector, [[toolCall("place_bet", "{}")], [slipCall(CREATE)], [say(FINAL)]]);
    assert.equal(collector.finish(), undefined);
    assert.equal(collector.invalid(), true);
  });

  it("an error payload from a successfully dispatched tool is not a dispatch failure", async () => {
    const collector = slip.createSlipOutputCollector(null);
    const result = await drive(
      collector,
      [[toolCall("scores", JSON.stringify({ team: "Chelsea" }))], [slipCall(CREATE)], [say(FINAL)]],
      { scores: scoresTool() },
    );
    const scores = result.steps.flatMap((s) => s.toolResults).find((r) => r.toolName === "scores");
    assert.deepEqual(scores.output, { ok: false, error: "scores feed unavailable" }, "fixture: dispatched and returned");
    assert.deepEqual(collector.finish(), CREATE);
    assert.equal(collector.invalid(), false);
  });

  it("keeps overlapping collectors isolated", async () => {
    const clean = slip.createSlipOutputCollector(null);
    const broken = slip.createSlipOutputCollector(null);
    await Promise.all([
      drive(clean, [[slipCall(CREATE)], [say(FINAL)]], {}, { delayMs: 5 }),
      drive(broken, [[slipCall(CREATE)], [slipCall("{not json")], [say(FINAL)]], {}, { delayMs: 1 }),
    ]);
    assert.deepEqual(clean.finish(), CREATE);
    assert.equal(clean.invalid(), false);
    assert.equal(broken.finish(), undefined);
    assert.equal(broken.invalid(), true);
  });
});

// ---------------------------------------------------------------------------
// agent_suggestion provenance
// ---------------------------------------------------------------------------

describe("agent_suggestion provenance", () => {
  it("accepts agent-suggested legs only with null quotedOdds", () => {
    const value = change("create", { legs: [LEG_A, SUGGESTED] });
    assert.deepEqual(slip.parseSlipChange(value), value);
    const priced = { ...clone(SUGGESTED), quotedOdds: { value: "1.91", format: "decimal" } };
    assert.equal(slip.parseSlipChange(change("create", { legs: [priced] })), null, "no unverified price evidence");
  });

  it("applies the same rule to stored revisions", () => {
    const withSuggestion = { ...clone(CONTEXT), legs: [...clone(CONTEXT).legs, { ...clone(SUGGESTED), id: sid("sll", "SENTINELlegS") }] };
    assert.equal(slip.validateSlipRevision(withSuggestion), true);
    withSuggestion.legs[2].quotedOdds = { value: "-110", format: "american" };
    assert.equal(slip.validateSlipRevision(withSuggestion), false);
  });

  it("preserves user-quoted values exactly and captures a mixed proposal", async () => {
    const value = change("create", { legs: [LEG_A, LEG_B, SUGGESTED] });
    const parsed = slip.parseSlipChange(value);
    assert.notEqual(parsed, null, "mixed proposal must parse before inspecting its legs");
    assert.equal(parsed.legs[0].quotedOdds.value, "2.10");
    assert.equal(parsed.legs[1].quotedOdds.value, "11/10");
    assert.equal(parsed.legs[2].source, "agent_suggestion");
    const collector = slip.createSlipOutputCollector(null);
    const answer = await collector.tool.execute(clone(value), { toolCallId: "c", messages: [] });
    assert.equal(answer.saved, false);
    assert.deepEqual(collector.finish(), value);
  });
});

// ---------------------------------------------------------------------------
// sportsclawEngine.run with slip
// ---------------------------------------------------------------------------

const PRIVATE_HISTORY = "PRIVATE_HISTORY_SENTINEL my bankroll is 500";
const PRIVATE_SYSTEM = "PRIVATE_SYSTEM_SENTINEL caller profile: Chelsea fan in Lisbon";
const HISTORY = [
  { role: "user", content: PRIVATE_HISTORY },
  { role: "assistant", content: "Noted." },
];
const REQUEST = "Make me a slip: Chelsea to beat Arsenal at 2.10 and Flamengo over 2.5 at 11/10";

function newEngine(model, config = {}) {
  const engine = new sportsclawEngine({ provider: "anthropic", model: "fake-answer-model", thinkingBudget: 0, maxTurns: 6, ...config });
  engine.mainModel = model;
  return engine;
}

/** Run with slip; returns text, results observed, and the order of events. */
async function runSlip(engine, slipInput, extra = {}) {
  const results = [];
  const text = await engine.run(slipInput?.requestText ?? REQUEST, {
    historyMode: "caller",
    history: clone(HISTORY),
    systemPrompt: PRIVATE_SYSTEM,
    slip: slipInput,
    onSlipResult: (r) => results.push(clone(r)),
    ...extra,
  });
  return { text, results };
}

function assertJevPrivacy(requestText) {
  assert.ok(jevCalls.length >= 1);
  for (const { wire, init } of jevCalls) {
    assert.equal(wire.state.request, requestText, "Jev sees the exact original request text");
    for (const leak of ["PRIVATE_HISTORY_SENTINEL", "PRIVATE_SYSTEM_SENTINEL", "SENTINEL", "Noted."]) {
      assert.ok(!init.body.includes(leak), `Jev must not see ${leak}`);
    }
  }
}

describe("engine.run slip mode", () => {
  it("is off for legacy callers: same string answer, no output tool, no observer", async () => {
    await withEnv(GATES, async () => {
      const m = scripted([[say(FINAL)]]);
      const engine = newEngine(m.model);
      const text = await engine.run(REQUEST, { historyMode: "caller", history: clone(HISTORY) });
      assert.equal(typeof text, "string");
      assert.match(text, /Chelsea/);
      for (const call of m.all) assert.ok(!offeredNames(call).includes("submit_slip_change"));
      assert.ok(!engine.lastRunTrace.offeredTools.includes("submit_slip_change"));
      assert.ok(!engine.listToolNames().includes("submit_slip_change"), "never a global tool");
      assert.equal(jevCalls.length, 0);
    });
  });

  it("emits one correlated selected result for a natural create on the normal path", async () => {
    await withEnv(GATES, async () => {
      jevAnswer = () => "create";
      const m = scripted([[slipCall(CREATE)], [say(FINAL)]]);
      const engine = newEngine(m.model);
      const input = turn(REQUEST);
      const { text, results } = await runSlip(engine, input);

      assert.equal(typeof text, "string");
      assert.match(text, /no bet placed/);
      assert.equal(results.length, 1, "exactly one typed result");
      assert.deepEqual(results[0], {
        contract: "slip-turn-v1",
        inputHash: hashOf(input),
        decision: { contract: "slip-decision-v1", ok: true, decision: { status: "selected", change: CREATE, model: JEV_MODEL } },
      });
      assert.deepEqual(slip.parseSlipTurnResult(results[0], input), results[0]);

      assert.ok(offeredNames(m.chat[0]).includes("submit_slip_change"), "offered on the generate/tool path");
      assert.ok(engine.lastRunTrace.offeredTools.includes("submit_slip_change"));
      const seen = JSON.stringify(m.chat[0].prompt);
      assert.ok(seen.includes("PRIVATE_HISTORY_SENTINEL") && seen.includes("PRIVATE_SYSTEM_SENTINEL"),
        "fixture: the composed model prompt carries history and caller context");
      assertJevPrivacy(REQUEST);
    });
  });

  it("an ordinary question yields a null decision and no Jev call", async () => {
    await withEnv(GATES, async () => {
      const m = scripted([[say("Chelsea kick off at 17:30 on Saturday at Stamford Bridge.")]]);
      const input = turn("What time do Chelsea play Saturday?", CONTEXT);
      const { text, results } = await runSlip(newEngine(m.model), input);
      assert.match(text, /17:30/);
      assert.deepEqual(results, [{ contract: "slip-turn-v1", inputHash: hashOf(input), decision: null }]);
      assert.equal(jevCalls.length, 0);
    });
  });

  it("validates a targeted proposal against the supplied context", async () => {
    await withEnv(GATES, async () => {
      jevAnswer = (q) => (Object.hasOwn(q.criteria, "remove") && Object.hasOwn(q.criteria, "create") ? "remove" : "leg_2");
      const remove = change("remove", { base: REV_ID, targets: [LEG_IDS[1]] });
      const m = scripted([[slipCall(remove)], [say("Removed the Flamengo over 2.5 leg from your draft. No bet placed.")]]);
      const input = turn("Drop the Flamengo leg", CONTEXT);
      const { results } = await runSlip(newEngine(m.model), input);
      assert.equal(results.length, 1);
      assert.deepEqual(results[0].decision, { contract: "slip-decision-v1", ok: true, decision: { status: "selected", change: remove, model: JEV_MODEL } });
      assertJevPrivacy("Drop the Flamengo leg");
    });
  });

  it("a dispatch failure in the run closes as invalid_response without Jev", async () => {
    await withEnv(GATES, async () => {
      jevAnswer = () => "create";
      const m = scripted([[slipCall(CREATE)], [slipCall("{not json")], [say(FINAL)]]);
      const input = turn(REQUEST);
      const { text, results } = await runSlip(newEngine(m.model), input);
      assert.equal(typeof text, "string");
      assert.deepEqual(results, [{
        contract: "slip-turn-v1", inputHash: hashOf(input),
        decision: { contract: "slip-decision-v1", ok: false, reasonCode: "invalid_response" },
      }]);
      assert.equal(jevCalls.length, 0, "no generative fallback and no decision for a tainted proposal");
    });
  });

  it("never carries a proposal into the next run on the same engine", async () => {
    await withEnv(GATES, async () => {
      jevAnswer = () => "create";
      const m = scripted([[slipCall(CREATE)], [say(FINAL)], [say("Arsenal are 4th in the table with 61 points.")]]);
      const engine = newEngine(m.model);
      const first = await runSlip(engine, turn(REQUEST));
      const second = turn("Where are Arsenal in the table?");
      const next = await runSlip(engine, second);
      assert.equal(first.results.length, 1, "the first run must emit its correlated result");
      assert.equal(first.results[0].decision.ok, true);
      assert.deepEqual(next.results, [{ contract: "slip-turn-v1", inputHash: hashOf(second), decision: null }]);
    });
  });

  it("keeps overlapping engine runs isolated", async () => {
    await withEnv(GATES, async () => {
      jevAnswer = () => "create";
      const a = scripted([[slipCall(CREATE)], [say(FINAL)]], { delayMs: 5 });
      const b = scripted([[say("Palmeiras play Sunday at 16:00 at Allianz Parque.")]], { delayMs: 1 });
      const inA = turn(REQUEST);
      const inB = turn("When do Palmeiras play?");
      const [ra, rb] = await Promise.all([runSlip(newEngine(a.model), inA), runSlip(newEngine(b.model), inB)]);
      assert.equal(ra.results.length, 1);
      assert.equal(ra.results[0].inputHash, hashOf(inA));
      assert.equal(ra.results[0].decision.decision.status, "selected");
      assert.deepEqual(rb.results, [{ contract: "slip-turn-v1", inputHash: hashOf(inB), decision: null }]);
    });
  });

  it("honors an explicit tool allowlist: the denied tool is never offered and nothing is selected", async () => {
    await withEnv(GATES, async () => {
      jevAnswer = () => "create";
      const m = scripted([[slipCall(CREATE)], [say(FINAL)]]);
      const engine = newEngine(m.model, { toolAllowlist: ["get_agent_config"] });
      let results = [];
      try {
        ({ results } = await runSlip(engine, turn(REQUEST)));
      } catch {
        // A closed refusal before generation is also acceptable.
      }
      for (const call of m.chat) assert.ok(!offeredNames(call).includes("submit_slip_change"), "denied tool not resurrected");
      assert.ok(results.length <= 1);
      for (const r of results) assert.notEqual(r.decision?.ok === true && r.decision.decision.status, "selected");
      assert.equal(jevCalls.length, 0);
    });
  });

  it("a throwing observer is a closed error, not ignored output", async () => {
    await withEnv(GATES, async () => {
      const m = scripted([[say("Chelsea kick off at 17:30 on Saturday.")]]);
      await assert.rejects(newEngine(m.model).run("When do Chelsea play?", {
        historyMode: "caller",
        slip: turn("When do Chelsea play?"),
        onSlipResult: () => {
          throw new Error("observer failed");
        },
      }));
    });
  });

  const refusedBeforeModel = {
    "slip flag unset": [{ ...GATES, SPORTSCLAW_SLIP_ENABLED: undefined }, turn(REQUEST)],
    "data policy local_only": [{ ...GATES, SPORTSCLAW_SLIP_JEV_DATA_POLICY: "local_only" }, turn(REQUEST)],
    "slip native-only": [{ ...GATES, SPORTSCLAW_SLIP_NATIVE_ONLY: "true" }, turn(REQUEST)],
    "watch native-only route": [{ ...GATES, SPORTSCLAW_WATCH_INTENT_NATIVE_CONFIG: "{\"route\":\"nim\"}" }, turn(REQUEST)],
    "invalid input": [GATES, { ...turn(REQUEST), ownerId: "acct_5150" }],
    "blank request text": [GATES, turn("   ")],
    "invalid context": [GATES, turn("Drop the Flamengo leg", { ...clone(CONTEXT), ownerId: "acct_5150" })],
  };
  for (const [label, [env, input]] of Object.entries(refusedBeforeModel)) {
    it(`${label}: refused before any model or Jev work`, async () => {
      const defined = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined));
      await withEnv(defined, async () => {
        jevAnswer = () => "create";
        const m = scripted([[slipCall(CREATE)], [say(FINAL)]]);
        const results = [];
        await assert.rejects(newEngine(m.model).run(REQUEST, {
          historyMode: "caller", slip: input, onSlipResult: (r) => results.push(r),
        }));
        assert.equal(m.all.length, 0, "no model call");
        assert.equal(jevCalls.length, 0, "no Jev call");
        assert.equal(results.length, 0);
      });
    });
  }

  it("requires a result observer for explicit slip mode", async () => {
    await withEnv(GATES, async () => {
      const m = scripted([[say(FINAL)]]);
      await assert.rejects(newEngine(m.model).run(REQUEST, { historyMode: "caller", slip: turn(REQUEST) }));
      assert.equal(m.all.length, 0);
    });
  });
});
