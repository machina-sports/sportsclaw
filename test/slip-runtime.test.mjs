/**
 * Slip runtime — bounded slip extraction on the engine's real path.
 *
 *   - `collector.observeStep(step)` fed by the installed SDK's real
 *     generateText dispatch: a dispatch failure (malformed JSON, unknown tool,
 *     missing/extra args) before or after a valid proposal withholds it; an
 *     ordinary error payload from a successfully dispatched tool does not;
 *     overlapping collectors stay isolated (slip-integration-contract.md §1).
 *     The collector stays exported and tested; the engine no longer offers it.
 *   - `agent_suggestion` leg provenance: quotedOdds null only; user sources keep
 *     their exact quoted strings.
 *   - `sportsclawEngine.run(prompt, {slip, onSlipResult})` with a scripted AI SDK
 *     model and a fake Jev fetch only: gates before model work; the answer and
 *     research loop never offers `submit_slip_change` (normal or parallel
 *     lanes); exactly one tool-free structured-output extraction after the
 *     final answer and evidence checks, before history/session/memory
 *     persistence and token accounting; exactly one correlated typed result;
 *     raw requestText (not the composed prompt/history) to the extractor and
 *     Jev; failed or clarifying outcomes never keep an unsupported saved claim;
 *     legacy callers unchanged; allowlists never broadened; no extraction after
 *     a routing refusal.
 *
 * The scripted model tells calls apart by their request: tools offered = an
 * answer-loop step; `responseFormat.type === "json"` = the extraction (its
 * reply is JSON text {status, change}, never a tool call); anything else =
 * a fact-check/router/synthesis call.
 *
 * HOME is a fresh temp dir so no real config, schemas, agents or memory load.
 * Any fetch other than the fake Jev endpoint fails the run and is counted.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  "SPORTSCLAW_AGENTS_DIR", "SPORTSCLAW_SKILLS", "sportsclaw_SKILLS",
  "SPORTSCLAW_ROUTING_PROVIDER", "SPORTSCLAW_ROUTING_DATA_POLICY",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
for (const key of ENV_KEYS) delete process.env[key];
process.env.HOME = home;
process.env.USERPROFILE = home;
// Placeholder only: the engine's model is replaced by a scripted one below.
process.env.ANTHROPIC_API_KEY = "synthetic-anthropic-placeholder";

const slip = await import("../dist/slip-output.js");
const { sportsclawEngine, sessionStore } = await import("../dist/engine.js");
const { tokensUsedToday } = await import("../dist/token-ledger.js");

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

/** Extraction replies: JSON text with their own usage, so accounting is visible. */
const EXTRACT_USAGE = {
  inputTokens: { total: 100 }, outputTokens: { total: 7 }, totalTokens: { total: 107 }, reasoningTokens: { total: undefined },
};
const extracted = (text, finish = "stop") => ({
  content: [{ type: "text", text }], finishReason: { unified: finish, raw: undefined }, usage: EXTRACT_USAGE, warnings: [],
});
const envelope = (status, value = null) => extracted(JSON.stringify({ status, change: value }));

/**
 * One scripted step per tool-bearing call. A JSON-response-format call is the
 * slip extraction and takes the next `extract` entry (a reply, or a function of
 * the call options; default none). Other tool-less calls (fact-check, router,
 * synthesis) get a clean verdict, or `synthesis` for parallel-lane synthesis.
 */
function scripted(steps, { delayMs = 0, extract = [], synthesis } = {}) {
  const chat = [];
  const extraction = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (options.responseFormat?.type === "json") {
        extraction.push(options);
        const next = extract[extraction.length - 1] ?? envelope("none");
        return typeof next === "function" ? next(options) : structuredClone(next);
      }
      if (!options.tools || options.tools.length === 0) {
        const lanes = synthesis !== undefined && JSON.stringify(options.prompt).includes("Combine the following agent responses");
        return generated([say(lanes ? synthesis : VERDICT_OK)]);
      }
      chat.push(options);
      return generated(steps[chat.length - 1] ?? [say(FINAL)]);
    },
  });
  return { model, chat, extraction, all: model.doGenerateCalls };
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

const selectedOf = (value) => ({ contract: "slip-decision-v1", ok: true, decision: { status: "selected", change: value, model: JEV_MODEL } });
const failure = (reasonCode) => ({ contract: "slip-decision-v1", ok: false, reasonCode });

/** 1x1 PNG. */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const filesOf = (call) => call.prompt.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === "file");

/** The one extraction call: tool-free native structured output over a fresh data prompt. */
function assertExtractionCall(call, { requestText = REQUEST, answer } = {}) {
  assert.equal(call.responseFormat?.type, "json", "native structured output");
  assert.ok(call.responseFormat.schema, "with its schema");
  assert.equal(call.tools?.length ?? 0, 0, "no tools at extraction");
  assert.equal(call.toolChoice, undefined, "no tool choice at extraction");
  assert.equal(call.maxOutputTokens, 8192);
  assert.ok(call.prompt.every((m) => m.role === "system" || m.role === "user"), "no history, repair or continuation");
  const seen = JSON.stringify(call.prompt);
  assert.ok(seen.includes(requestText), "the exact original request");
  if (answer !== undefined) assert.ok(seen.includes(answer), "the final answer");
  for (const leak of ["PRIVATE_HISTORY_SENTINEL", "PRIVATE_SYSTEM_SENTINEL", "Noted."]) {
    assert.ok(!seen.includes(leak), `extraction must not see ${leak}`);
  }
}

const textOf = (message) => (typeof message.content === "string"
  ? message.content
  : message.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
const lastAssistantText = (messages) => textOf(messages.filter((m) => m.role === "assistant").at(-1));

/** Resolves true once `signal` aborts, false after `ms`. */
const abortedWithin = (signal, ms) => new Promise((resolve) => {
  if (signal?.aborted) return resolve(true);
  const timer = setTimeout(() => resolve(false), ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    resolve(true);
  }, { once: true });
});

/** Every file under `dir` whose bytes contain `needle`. */
function filesContaining(dir, needle) {
  const hits = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) hits.push(...filesContaining(path, needle));
    else if (entry.isFile() && readFileSync(path).includes(needle)) hits.push(path);
  }
  return hits;
}

function lastQueryEvent() {
  const lines = readFileSync(join(home, ".sportsclaw", "analytics", "queries.jsonl"), "utf-8").trim().split("\n");
  return JSON.parse(lines.at(-1));
}

const KICKOFF = "Chelsea kick off at 17:30 on Saturday at Stamford Bridge.";

describe("engine.run slip mode", () => {
  for (const kind of ["failed", "clarify", "denied"]) {
    it(`clears earlier completion claims when the final answer is already safe (${kind})`, async () => {
      await withEnv(GATES, async () => {
        const safe = kind === "clarify"
          ? "Please clarify which draft or selection you want me to work with."
          : "I could not prepare a reliable draft proposal. Please check the selections or clarify the request.";
        const claim = `EARLIER_CLAIM_${kind}: the wager is live at the book.`;
        jevAnswer = kind === "clarify" ? () => "clarify" : undefined;
        const m = scripted([[say(claim), slipCall(CREATE)], [say(safe)]], {
          extract: [kind === "clarify" ? envelope("proposal", CREATE) : extracted("not JSON")],
        });
        const engine = newEngine(m.model, kind === "denied" ? {toolAllowlist:["get_agent_config"]} : {});
        const results = [], sessionId = `already-safe-${kind}`;
        const text = await engine.run(REQUEST, {userId:`already-safe-user-${kind}`,sessionId,slip:turn(REQUEST),onSlipResult:r=>results.push(r)});
        assert.equal(m.chat.length, 2, "the earlier claim and already-safe final both ran");
        assert.equal(text, safe);
        assert.equal(results.length, 1);
        assert.ok(!JSON.stringify(engine.history).includes(claim));
        assert.ok(!JSON.stringify(sessionStore.get(sessionId)).includes(claim));
        assert.equal(lastAssistantText(engine.history), safe);
      });
    });
  }
  for (const claim of ["Bilhete registrado e aposta efetuada.", "The wager is now live at the book."]) {
    it(`discards the whole unaccepted answer rather than guessing claim words: ${claim}`, async () => {
      await withEnv(GATES, async () => {
        const m = scripted([[say(claim)]], { extract: [extracted("not JSON")] });
        const engine = newEngine(m.model);
        const { text, results } = await runSlip(engine, turn(REQUEST));
        assert.deepEqual(results[0].decision, failure("invalid_response"));
        assert.ok(!text.includes(claim), "an invalid proposal cannot retain the model's success claim");
        assert.equal(lastAssistantText(engine.history), text);
        assert.ok(!JSON.stringify(engine.history).includes(claim));
      });
    });
  }

  it("is off for legacy callers: same string answer, no extraction, no observer", async () => {
    await withEnv(GATES, async () => {
      const m = scripted([[say(FINAL)]]);
      const engine = newEngine(m.model);
      const text = await engine.run(REQUEST, { historyMode: "caller", history: clone(HISTORY) });
      assert.equal(text, FINAL);
      assert.equal(m.extraction.length, 0, "no extraction without slip mode");
      for (const call of m.all) assert.ok(!offeredNames(call).includes("submit_slip_change"));
      assert.ok(!engine.lastRunTrace.offeredTools.includes("submit_slip_change"));
      assert.ok(!engine.listToolNames().includes("submit_slip_change"), "never a global tool");
      assert.equal(jevCalls.length, 0);
    });
  });

  it("extracts once after the final answer and decides that one proposal; the old tool is never offered", async () => {
    await withEnv(GATES, async () => {
      jevAnswer = () => "create";
      const m = scripted([[say(FINAL)]], { extract: [envelope("proposal", CREATE)] });
      const engine = newEngine(m.model, { sampling: { temperature: 0.3, seed: 11 } });
      const input = turn(REQUEST);
      const { text, results } = await runSlip(engine, input, { images: [{ data: PNG_B64, mimeType: "image/png" }] });

      assert.equal(text, FINAL, "the ordinary answer is returned");
      assert.deepEqual(results, [{ contract: "slip-turn-v1", inputHash: hashOf(input), decision: selectedOf(CREATE) }]);
      assert.deepEqual(slip.parseSlipTurnResult(results[0], input), results[0]);

      assert.equal(m.extraction.length, 1, "exactly one extraction");
      const [call] = m.extraction;
      assert.equal(m.all.indexOf(call), m.all.length - 1, "after the final answer");
      assertExtractionCall(call, { answer: FINAL });
      assert.equal(filesOf(call).length, 1, "the current request image");
      assert.equal(call.temperature, 0.3, "the resolved primary sampling");
      assert.equal(call.seed, 11);
      assert.equal(m.chat[0].providerOptions, undefined, "ordinary answer options are unchanged");
      assert.deepEqual(call.providerOptions, { anthropic: { structuredOutputMode: "outputFormat", thinking: { type: "disabled" } } }, "extraction-only native output and total-token guard");

      for (const c of m.all) assert.ok(!offeredNames(c).includes("submit_slip_change"), "never offered to the answer model");
      assert.ok(!engine.lastRunTrace.offeredTools.includes("submit_slip_change"));
      const seen = JSON.stringify(m.chat[0].prompt);
      assert.ok(!seen.includes("submit_slip_change"), "no instructions for a tool that is not offered");
      assert.ok(seen.includes("PRIVATE_HISTORY_SENTINEL") && seen.includes("PRIVATE_SYSTEM_SENTINEL"),
        "fixture: the answer model still sees history and caller context");
      assertJevPrivacy(REQUEST);
    });
  });

  it("an ordinary question extracts none: answer kept, null decision, no Jev call", async () => {
    await withEnv(GATES, async () => {
      const m = scripted([[say(KICKOFF)]], { extract: [envelope("none")] });
      const input = turn("What time do Chelsea play Saturday?", CONTEXT);
      const { text, results } = await runSlip(newEngine(m.model), input);
      assert.equal(text, KICKOFF);
      assert.deepEqual(results, [{ contract: "slip-turn-v1", inputHash: hashOf(input), decision: null }]);
      assert.equal(m.extraction.length, 1);
      assertExtractionCall(m.extraction[0], { requestText: input.requestText, answer: KICKOFF });
      assert.equal(jevCalls.length, 0);
    });
  });

  it("a stray submit_slip_change call from the answer model is never dispatched as a proposal", async () => {
    await withEnv(GATES, async () => {
      jevAnswer = () => "create";
      const m = scripted([[slipCall(CREATE)], [say(FINAL)]], { extract: [envelope("none")] });
      const input = turn(REQUEST);
      const { results } = await runSlip(newEngine(m.model), input);
      assert.deepEqual(results, [{ contract: "slip-turn-v1", inputHash: hashOf(input), decision: null }]);
      assert.equal(m.extraction.length, 1);
      assert.equal(jevCalls.length, 0);
    });
  });

  it("decides a targeted proposal extracted against the validated current revision", async () => {
    await withEnv(GATES, async () => {
      jevAnswer = (q) => (Object.hasOwn(q.criteria, "remove") && Object.hasOwn(q.criteria, "create") ? "remove" : "leg_2");
      const remove = change("remove", { base: REV_ID, targets: [LEG_IDS[1]] });
      const answer = "Removed the Flamengo over 2.5 leg from your draft. No bet placed.";
      const m = scripted([[say(answer)]], { extract: [envelope("proposal", remove)] });
      const input = turn("Drop the Flamengo leg", CONTEXT);
      const { results } = await runSlip(newEngine(m.model), input);
      assert.deepEqual(results, [{ contract: "slip-turn-v1", inputHash: hashOf(input), decision: selectedOf(remove) }]);
      assertExtractionCall(m.extraction[0], { requestText: input.requestText, answer });
      const seen = JSON.stringify(m.extraction[0].prompt);
      assert.ok(seen.includes(REV_ID) && seen.includes(LEG_IDS[1]), "the extractor sees the current revision it must target");
      assertJevPrivacy("Drop the Flamengo leg");
    });
  });

  const UNSAFE = "Your slip CLAIM_SENTINEL is saved, confirmed and the bet is placed.";
  const unsafeOutcomes = {
    "malformed extraction": [null, extracted("{not json"), undefined, failure("invalid_response")],
    "extraction with an extra root key": [null, extracted(JSON.stringify({ status: "none", change: null, saved: true })), undefined, failure("invalid_response")],
    "model-authored confirm": [CONTEXT, envelope("proposal", change("confirm", { base: REV_ID })), undefined, failure("invalid_response")],
    "none carrying a change": [null, envelope("none", CREATE), undefined, failure("invalid_response")],
    "truncated extraction": [null, extracted('{"status":"proposal","change":', "length"), undefined, failure("invalid_response")],
    "Jev clarify": [null, envelope("proposal", CREATE), () => "clarify",
      { contract: "slip-decision-v1", ok: true, decision: { status: "clarify", model: JEV_MODEL } }],
  };
  for (const [label, [context, output, jev, decision]] of Object.entries(unsafeOutcomes)) {
    it(`${label}: no unsupported saved claim is returned or kept in history`, async () => {
      await withEnv(GATES, async () => {
        jevAnswer = jev;
        const m = scripted([[say(UNSAFE)]], { extract: [output] });
        const engine = newEngine(m.model);
        const input = turn(REQUEST, context);
        const { text, results } = await runSlip(engine, input);
        assert.deepEqual(results, [{ contract: "slip-turn-v1", inputHash: hashOf(input), decision }]);
        assert.equal(m.extraction.length, 1, "never repaired or retried");
        if (!jev) assert.equal(jevCalls.length, 0, "an invalid extraction is never decided");
        assert.equal(typeof text, "string");
        assert.ok(text.trim().length > 0);
        assert.ok(!text.includes("CLAIM_SENTINEL"), "the unsupported claim is not returned");
        assert.equal(lastAssistantText(engine.history), text, "history keeps exactly the returned text");
        assert.ok(!JSON.stringify(engine.history).includes("CLAIM_SENTINEL"));
      });
    });
  }

  it("persists the same safe text to session and memory as it returns", async () => {
    await withEnv(GATES, async () => {
      const sentinel = "CLAIM_SENTINEL_PERSIST";
      const m = scripted([[say(`Your slip ${sentinel} is saved, confirmed and the bet is placed.`)]], { extract: [extracted("{not json")] });
      const input = turn(REQUEST);
      const results = [];
      const text = await newEngine(m.model).run(REQUEST, {
        userId: "slip-persist-user", sessionId: "slip-persist-session", slip: input, onSlipResult: (r) => results.push(clone(r)),
      });
      assert.deepEqual(results.map((r) => r.decision), [failure("invalid_response")]);
      assert.ok(!text.includes(sentinel));
      const session = sessionStore.get("slip-persist-session");
      assert.equal(lastAssistantText(session), text, "session keeps exactly the returned text");
      assert.ok(!JSON.stringify(session).includes(sentinel));
      assert.deepEqual(filesContaining(home, sentinel), [], "nothing on disk keeps the unsupported claim");
    });
  });

  it("adds extraction usage once to run, pass, daily and analytics totals; sequential runs stay isolated", async () => {
    await withEnv(GATES, async () => {
      jevAnswer = () => "create";
      const m = scripted(
        [[say(FINAL)], [say("Arsenal are 4th in the table with 61 points.")], [say(KICKOFF)]],
        { extract: [envelope("proposal", CREATE), envelope("none"), extracted("{not json")] },
      );
      const engine = newEngine(m.model);
      const runs = [
        [turn(REQUEST), (d) => assert.deepEqual(d, selectedOf(CREATE))],
        [turn("Where are Arsenal in the table?"), (d) => assert.equal(d, null)],
        [turn("When do Chelsea play?"), (d) => assert.deepEqual(d, failure("invalid_response"))],
      ];
      for (const [input, check] of runs) {
        const ledgerBefore = tokensUsedToday();
        const { results } = await runSlip(engine, input, { userId: "slip-usage-user" });
        assert.equal(results.length, 1);
        check(results[0].decision);
        assert.deepEqual(engine.lastTokenUsage, { inputTokens: 110, outputTokens: 12, totalTokens: 122 },
          "main + exactly one extraction; nothing carried over, nothing lost on a parse failure");
        assert.equal(Object.values(engine.lastPassUsage).reduce((sum, u) => sum + u.totalTokens, 0), 122);
        assert.equal(tokensUsedToday() - ledgerBefore, 122, "daily ledger");
        const event = lastQueryEvent();
        assert.equal(event.inputTokens, 110, "analytics");
        assert.equal(event.outputTokens, 12, "analytics");
      }
      assert.equal(m.extraction.length, 3);
    });
  });

  it("keeps overlapping engine runs isolated", async () => {
    await withEnv(GATES, async () => {
      jevAnswer = () => "create";
      const a = scripted([[say(FINAL)]], { delayMs: 5, extract: [envelope("proposal", CREATE)] });
      const b = scripted([[say("Palmeiras play Sunday at 16:00 at Allianz Parque.")]], { delayMs: 1, extract: [envelope("none")] });
      const inA = turn(REQUEST);
      const inB = turn("When do Palmeiras play?");
      const [ra, rb] = await Promise.all([runSlip(newEngine(a.model), inA), runSlip(newEngine(b.model), inB)]);
      assert.deepEqual(ra.results, [{ contract: "slip-turn-v1", inputHash: hashOf(inA), decision: selectedOf(CREATE) }]);
      assert.deepEqual(rb.results, [{ contract: "slip-turn-v1", inputHash: hashOf(inB), decision: null }]);
      assert.equal(a.extraction.length, 1);
      assert.equal(b.extraction.length, 1);
    });
  });

  it("does not persist model completion claims when the slip capability is denied", async () => {
    await withEnv(GATES, async () => {
      const claim = "The wager CLAIM_DENIED is now live at the book.";
      const m = scripted([[say(claim)]]);
      const engine = newEngine(m.model, { toolAllowlist: ["get_agent_config"] });
      const { text, results } = await runSlip(engine, turn(REQUEST));
      assert.equal(m.extraction.length, 0);
      assert.deepEqual(results[0].decision, failure("disabled"));
      assert.ok(!text.includes("CLAIM_DENIED"));
      assert.equal(lastAssistantText(engine.history), text);
      assert.ok(!JSON.stringify(engine.history).includes("CLAIM_DENIED"));
    });
  });

  it("an explicit allowlist without the slip capability denies it: no extraction, nothing widened", async () => {
    await withEnv(GATES, async () => {
      jevAnswer = () => "create";
      const m = scripted([[say(FINAL)]], { extract: [envelope("proposal", CREATE)] });
      const engine = newEngine(m.model, { toolAllowlist: ["get_agent_config"] });
      let results = [];
      try {
        ({ results } = await runSlip(engine, turn(REQUEST)));
      } catch {
        // A closed refusal before generation is also acceptable.
      }
      assert.equal(m.extraction.length, 0, "a denied capability is never extracted");
      for (const call of m.all) {
        assert.deepEqual(offeredNames(call).filter((name) => name !== "get_agent_config"), [], "allowlist not widened");
      }
      assert.ok(results.length <= 1);
      for (const r of results) assert.deepEqual(r.decision, failure("disabled"));
      assert.equal(jevCalls.length, 0);
    });
  });

  it("an allowlist naming the slip capability permits extraction without offering a tool", async () => {
    await withEnv(GATES, async () => {
      jevAnswer = () => "create";
      const m = scripted([[say(FINAL)]], { extract: [envelope("proposal", CREATE)] });
      const engine = newEngine(m.model, { toolAllowlist: ["get_agent_config", "submit_slip_change"] });
      const input = turn(REQUEST);
      const { results } = await runSlip(engine, input);
      assert.deepEqual(results, [{ contract: "slip-turn-v1", inputHash: hashOf(input), decision: selectedOf(CREATE) }]);
      assert.equal(m.extraction.length, 1);
      for (const call of m.chat) assert.deepEqual(offeredNames(call), ["get_agent_config"]);
    });
  });

  it("propagates a caller abort into the extraction call; an aborted extraction is never decided", async () => {
    await withEnv(GATES, async () => {
      jevAnswer = () => "create";
      const controller = new AbortController();
      let propagated = false;
      const m = scripted([[say(FINAL)]], {
        extract: [async (options) => {
          controller.abort();
          propagated = await abortedWithin(options.abortSignal, 2_000);
          if (propagated) throw options.abortSignal.reason ?? new Error("aborted");
          return envelope("proposal", CREATE);
        }],
      });
      const results = [];
      let rejected = false;
      try {
        await newEngine(m.model).run(REQUEST, {
          historyMode: "caller", slip: turn(REQUEST), onSlipResult: (r) => results.push(clone(r)), abortSignal: controller.signal,
        });
      } catch {
        rejected = true;
      }
      assert.equal(m.extraction.length, 1);
      assert.equal(propagated, true, "the caller abort reaches the extraction call");
      assert.equal(jevCalls.length, 0);
      if (!rejected) assert.deepEqual(results.map((r) => r.decision), [failure("aborted")]);
      for (const r of results) assert.notEqual(r.decision?.ok, true);
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
        const m = scripted([[say(FINAL)]], { extract: [envelope("proposal", CREATE)] });
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

// ---------------------------------------------------------------------------
// Parallel lanes and routing refusal (installed football schema fixture)
// ---------------------------------------------------------------------------

const FOOTBALL_SCHEMA = {
  sport: "football", version: "0.0.0-test",
  tools: [{ name: "football_get_scores", command: "get_scores", description: "Football scores (fixture; never called).", parameters: { type: "object", properties: {} } }],
};
const PL_REQUEST = "Premier League slip: Chelsea to beat Arsenal at 2.10 and Flamengo over 2.5 at 11/10";

/** Install the football schema (and lane agents) in HOME for `fn` only; engines must be built inside. */
async function withFootball(agents, fn) {
  const schemaDir = join(home, ".sportsclaw", "schemas");
  const agentsDir = join(home, ".sportsclaw", "agents");
  mkdirSync(schemaDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  const written = [join(schemaDir, "football.json")];
  writeFileSync(written[0], JSON.stringify(FOOTBALL_SCHEMA));
  for (const [id, name] of Object.entries(agents)) {
    const path = join(agentsDir, `${id}.md`);
    writeFileSync(path, `---\nname: ${name}\nskills: [football]\n---\n\nAnswer football questions briefly.\n`);
    written.push(path);
  }
  try {
    return await fn();
  } finally {
    for (const path of written) rmSync(path, { force: true });
  }
}

const LANES = { "lane-a": "Lane A", "lane-b": "Lane B" };

describe("engine.run slip mode: parallel lanes and routing refusal", () => {
  it("parallel lanes: one extraction after synthesis, no lane offered the old tool", async () => {
    await withEnv(GATES, () => withFootball(LANES, async () => {
      jevAnswer = () => "create";
      const synthesis = "Drafted 2 legs from both desks: Chelsea to beat Arsenal and Flamengo v Palmeiras over 2.5. Draft only, no bet placed.";
      const m = scripted([], { synthesis, extract: [envelope("proposal", CREATE)] });
      const engine = newEngine(m.model, { parallelAgents: true });
      const input = turn(PL_REQUEST);
      const { text, results } = await runSlip(engine, input);

      assert.equal(m.chat.length, 2, "fixture: two parallel lanes ran");
      assert.equal(engine.lastRunTrace.parallelAgents, true);
      assert.equal(text, synthesis);
      assert.deepEqual(results, [{ contract: "slip-turn-v1", inputHash: hashOf(input), decision: selectedOf(CREATE) }]);
      assert.equal(m.extraction.length, 1, "one extraction per turn, not per lane");
      assert.equal(m.all.indexOf(m.extraction[0]), m.all.length - 1, "after synthesis");
      assertExtractionCall(m.extraction[0], { requestText: PL_REQUEST, answer: synthesis });
      for (const call of m.all) assert.ok(!offeredNames(call).includes("submit_slip_change"), "never offered to a lane");
      assertJevPrivacy(PL_REQUEST);
    }));
  });

  it("parallel lanes: a failed extraction never keeps an unsupported saved claim", async () => {
    await withEnv(GATES, () => withFootball(LANES, async () => {
      const synthesis = "Your slip CLAIM_SENTINEL_PARALLEL is saved, confirmed and the bet is placed.";
      const m = scripted([], { synthesis, extract: [extracted("{not json")] });
      const engine = newEngine(m.model, { parallelAgents: true });
      const input = turn(PL_REQUEST);
      const { text, results } = await runSlip(engine, input);

      assert.equal(m.chat.length, 2, "fixture: two parallel lanes ran");
      assert.deepEqual(results, [{ contract: "slip-turn-v1", inputHash: hashOf(input), decision: failure("invalid_response") }]);
      assert.equal(m.extraction.length, 1);
      assert.equal(jevCalls.length, 0);
      assert.ok(text.trim().length > 0);
      assert.ok(!text.includes("CLAIM_SENTINEL_PARALLEL"));
      assert.equal(lastAssistantText(engine.history), text, "history keeps exactly the returned text");
      assert.ok(!JSON.stringify(engine.history).includes("CLAIM_SENTINEL_PARALLEL"));
    }));
  });

  it("a routing refusal is final: no answer model and no extraction", async () => {
    // jevAnswer stays unset: any Jev routing egress would count as an escaped fetch.
    await withEnv(GATES, () => withFootball({}, async () => {
      const m = scripted([[say(FINAL)]], { extract: [envelope("proposal", CREATE)] });
      const engine = newEngine(m.model, { routing: { provider: "jev" } });
      const input = turn(PL_REQUEST);
      const { text, results } = await runSlip(engine, input);

      assert.equal(m.chat.length, 0, "fixture: routing refused before the answer model");
      assert.equal(m.extraction.length, 0, "no extraction after a routing refusal");
      assert.equal(typeof text, "string");
      assert.equal(results.length, 1);
      assert.equal(results[0].inputHash, hashOf(input));
      assert.notEqual(results[0].decision?.ok === true && results[0].decision.decision.status, "selected");
      assert.equal(jevCalls.length, 0);
    }));
  });
});
