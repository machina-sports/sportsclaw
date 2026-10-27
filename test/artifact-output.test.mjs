/**
 * Artifact output — `artifact-turn-v1` on the engine's real path.
 *
 *   - the wire: exact artifact-v1 / turn / result validation (sizes, controls,
 *     surrogates, nonce binding, artifact XOR reason);
 *   - `collector.observeStep(step)` fed by the installed SDK's real
 *     generateText dispatch: a malformed or refused `submit_artifact` call
 *     invalidates it, another tool's failure does not, a second different
 *     document conflicts, reset() starts clean;
 *   - `sportsclawEngine.run(prompt, {artifact, onArtifactResult})` with a
 *     scripted AI SDK model: validation before any model work, the tool is
 *     offered only to opted-in caller-history runs, never to parallel lanes,
 *     an allowlist that omits it denies it, exactly one result bound to the
 *     nonce, the HTML never becomes evidence for the fact-check, legacy runs
 *     unchanged, and an answer whose evidence check did not pass drops the
 *     document.
 *
 * HOME is a fresh temp dir so no real config, schemas, agents or memory load.
 * Any network call fails the run and is counted.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText, stepCountIs, tool, jsonSchema } from "ai";
import { MockLanguageModelV3 } from "ai/test";

globalThis.AI_SDK_LOG_WARNINGS = false;

const home = mkdtempSync(join(tmpdir(), "sportsclaw-artifact-"));
const ENV_KEYS = [
  "HOME", "USERPROFILE", "sportsclaw_SCHEMA_DIR", "SPORTSCLAW_SCHEMA_DIR", "SPORTSCLAW_SESSION_DIR",
  "SPORTSCLAW_MEMORY_PROVIDER", "ANTHROPIC_API_KEY", "SPORTSCLAW_AGENTS_DIR", "SPORTSCLAW_SKILLS", "sportsclaw_SKILLS",
  "SPORTSCLAW_ROUTING_PROVIDER", "SPORTSCLAW_ROUTING_DATA_POLICY", "SPORTSCLAW_SKILL_GUIDES_DIR",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
for (const key of ENV_KEYS) delete process.env[key];
process.env.HOME = home;
process.env.USERPROFILE = home;
// Placeholder only: the engine's model is replaced by a scripted one below.
process.env.ANTHROPIC_API_KEY = "synthetic-anthropic-placeholder";

const wire = await import("../dist/artifact-output.js");
const { sportsclawEngine } = await import("../dist/engine.js");

let escapedFetches = 0;
let realFetch;
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    escapedFetches += 1;
    throw new Error("network is forbidden in these tests");
  };
});
after(() => {
  globalThis.fetch = realFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
  assert.equal(escapedFetches, 0, "no network");
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NONCE = "nonce_0123456789abcdef";
const TURN = Object.freeze({ contract: "artifact-turn-v1", nonce: NONCE });
const HTML = "<!doctype html><html><head><title>Flamengo x Palmeiras</title></head><body><h1>Comparação</h1></body></html>";
const ARTIFACT = Object.freeze({ contract: "artifact-v1", title: "Flamengo x Palmeiras", mimeType: "text/html", html: HTML });
const OTHER = Object.freeze({ ...ARTIFACT, html: HTML.replace("Comparação", "Outra") });
const clone = (value) => structuredClone(value);

const USAGE = {
  inputTokens: { total: 10 }, outputTokens: { total: 5 }, totalTokens: { total: 15 }, reasoningTokens: { total: undefined },
};
const VERDICT_OK = JSON.stringify({ isValid: true, discrepancies: [] });
const FINAL = "Montei o relatório comparando os dois times.";

let callSeq = 0;
const callId = () => `call_${++callSeq}`;
const artifactCall = (input) => ({
  type: "tool-call", toolCallId: callId(), toolName: "submit_artifact",
  input: typeof input === "string" ? input : JSON.stringify(input),
});
const toolCall = (toolName, input) => ({ type: "tool-call", toolCallId: callId(), toolName, input });
const say = (text) => ({ type: "text", text });

function generated(content) {
  const calls = content.some((part) => part.type === "tool-call");
  return { content, finishReason: { unified: calls ? "tool-calls" : "stop", raw: undefined }, usage: USAGE, warnings: [] };
}

/** One scripted step per tool-bearing call; tool-less calls (fact-check, router, synthesis) get a clean verdict. */
function scripted(steps, { synthesis } = {}) {
  const chat = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      if (!options.tools || options.tools.length === 0) {
        const lanes = synthesis !== undefined && JSON.stringify(options.prompt).includes("Combine the following agent responses");
        return generated([say(lanes ? synthesis : VERDICT_OK)]);
      }
      chat.push(options);
      return generated(steps[chat.length - 1] ?? [say(FINAL)]);
    },
  });
  return { model, chat, all: model.doGenerateCalls };
}

const offeredNames = (options) => (options.tools ?? []).map((t) => t.name);

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

describe("artifact-v1 wire", () => {
  it("accepts exact documents and returns fresh copies", () => {
    const parsed = wire.parseArtifactOutput(clone(ARTIFACT));
    assert.deepEqual(parsed, ARTIFACT);
    const tabbed = { ...ARTIFACT, html: "<html>\r\n\t<body>ok</body>\n</html>" };
    assert.deepEqual(wire.parseArtifactOutput(clone(tabbed)), tabbed);
    assert.ok(wire.parseArtifactOutput({ ...ARTIFACT, title: "é".repeat(120) }));
  });

  it("refuses anything outside the contract", () => {
    const max = wire.MAX_ARTIFACT_HTML_BYTES;
    const cases = {
      "wrong mime": { ...ARTIFACT, mimeType: "text/plain" },
      "wrong contract": { ...ARTIFACT, contract: "artifact-v2" },
      "extra url": { ...ARTIFACT, url: "https://reports.example/abc" },
      "extra owner": { ...ARTIFACT, ownerId: "acct_1" },
      "missing html": { contract: "artifact-v1", title: "x", mimeType: "text/html" },
      "blank html": { ...ARTIFACT, html: " \n" },
      "html over the byte limit": { ...ARTIFACT, html: `<p>${"x".repeat(max)}</p>` },
      "html over the byte limit only in UTF-8": { ...ARTIFACT, html: "😀".repeat(Math.floor(max / 4) + 1) },
      "NUL in html": { ...ARTIFACT, html: "<p>a\u0000b</p>" },
      "lone surrogate": { ...ARTIFACT, html: "<p>\ud800</p>" },
      "title over 120 UTF-16 units": { ...ARTIFACT, title: "😀".repeat(61) },
      "title with a newline": { ...ARTIFACT, title: "a\nb" },
      "not an object": "<html></html>",
      "array": [ARTIFACT],
    };
    for (const [label, value] of Object.entries(cases)) {
      assert.equal(wire.parseArtifactOutput(value), null, label);
    }
  });

  it("binds results to the exact nonce; an artifact never carries a reason", () => {
    const result = (artifact, reasonCode = null, nonce = NONCE) => ({ contract: "artifact-turn-v1", nonce, artifact, reasonCode });
    assert.deepEqual(wire.parseArtifactTurnResult(result(clone(ARTIFACT)), TURN).artifact, ARTIFACT);
    assert.equal(wire.parseArtifactTurnResult(result(null), TURN).reasonCode, null);
    assert.equal(wire.parseArtifactTurnResult(result(null, "denied"), TURN).reasonCode, "denied");
    assert.equal(wire.parseArtifactTurnResult(result(clone(ARTIFACT), null, "nonce_other0123456789"), TURN), null);
    assert.equal(wire.parseArtifactTurnResult(result(clone(ARTIFACT), "invalid_artifact"), TURN), null);
    assert.equal(wire.parseArtifactTurnResult(result(null, "published"), TURN), null);
    assert.equal(wire.parseArtifactTurnInput({ ...TURN, nonce: "short" }), null);
    assert.equal(wire.parseArtifactTurnInput({ ...TURN, ownerId: "acct_1" }), null);
  });
});

// ---------------------------------------------------------------------------
// collector.observeStep through the SDK's real dispatch
// ---------------------------------------------------------------------------

const scoresTool = () => tool({
  description: "Scores",
  inputSchema: jsonSchema({ type: "object", properties: { team: { type: "string" } }, required: ["team"] }),
  execute: async () => ({ ok: false, error: "scores feed unavailable" }),
});

async function drive(collector, steps) {
  const { model } = scripted(steps);
  await generateText({
    model,
    tools: { submit_artifact: collector.tool, get_scores: scoresTool() },
    prompt: "build the report",
    stopWhen: stepCountIs(steps.length + 1),
    onStepFinish: (step) => collector.observeStep(step),
  });
}

describe("artifact collector", () => {
  it("captures one valid document and answers published:false without a link", async () => {
    const collector = wire.createArtifactOutputCollector();
    const out = await collector.tool.execute(clone(ARTIFACT), { toolCallId: "t", messages: [] });
    assert.deepEqual(out, { accepted: true, published: false });
    assert.equal(JSON.stringify(out).includes("http"), false);
    assert.deepEqual(collector.finish(), ARTIFACT);
  });

  it("an identical resubmission is fine; a different one conflicts and nothing survives", async () => {
    const collector = wire.createArtifactOutputCollector();
    await drive(collector, [[artifactCall(ARTIFACT)], [artifactCall(ARTIFACT)]]);
    assert.deepEqual(collector.finish(), ARTIFACT);
    await drive(collector, [[artifactCall(OTHER)]]);
    assert.equal(collector.finish(), undefined);
    assert.equal(collector.problem(), "conflicting_artifact");
  });

  it("a truncated or schema-invalid submit_artifact call invalidates the turn", async () => {
    for (const bad of ['{"contract":"artifact-v1","title":"x","mimeType":"text/html","html":"<p>trunc', { ...ARTIFACT, mimeType: "text/plain" }]) {
      const collector = wire.createArtifactOutputCollector();
      await drive(collector, [[artifactCall(ARTIFACT)], [artifactCall(bad)]]);
      assert.equal(collector.finish(), undefined);
      assert.equal(collector.problem(), "invalid_artifact");
    }
  });

  it("another tool's failure does not count against the document", async () => {
    const collector = wire.createArtifactOutputCollector();
    await drive(collector, [[toolCall("get_scores", JSON.stringify({ team: "Flamengo" }))], [artifactCall(ARTIFACT)]]);
    assert.deepEqual(collector.finish(), ARTIFACT);
  });

  it("reset() forgets a failed attempt", async () => {
    const collector = wire.createArtifactOutputCollector();
    await drive(collector, [[artifactCall("{not json")]]);
    assert.equal(collector.problem(), "invalid_artifact");
    collector.reset();
    await drive(collector, [[artifactCall(OTHER)]]);
    assert.deepEqual(collector.finish(), OTHER);
  });
});

// ---------------------------------------------------------------------------
// sportsclawEngine.run with artifact
// ---------------------------------------------------------------------------

const HISTORY = [
  { role: "user", content: "Oi" },
  { role: "assistant", content: "Olá!" },
];
const REQUEST = "Monte um relatório comparando Flamengo e Palmeiras nos últimos 5 jogos";

function newEngine(model, config = {}) {
  const engine = new sportsclawEngine({ provider: "anthropic", model: "fake-answer-model", thinkingBudget: 0, maxTurns: 6, ...config });
  engine.mainModel = model;
  return engine;
}

async function runArtifact(engine, extra = {}) {
  const results = [];
  const text = await engine.run(REQUEST, {
    historyMode: "caller",
    history: clone(HISTORY),
    artifact: clone(TURN),
    onArtifactResult: (r) => results.push(clone(r)),
    ...extra,
  });
  return { text, results };
}

describe("engine.run with artifact", () => {
  it("validates before any model work", async () => {
    const { model, all } = scripted([]);
    const engine = newEngine(model);
    await assert.rejects(engine.run(REQUEST, { historyMode: "caller", history: clone(HISTORY), artifact: clone(TURN) }), /onArtifactResult/);
    await assert.rejects(runArtifact(engine, { artifact: { ...TURN, nonce: "x" } }), /invalid artifact turn input/);
    await assert.rejects(
      engine.run(REQUEST, { artifact: clone(TURN), onArtifactResult: () => {} }),
      /historyMode caller/,
      "engine-owned history would keep the HTML",
    );
    assert.equal(all.length, 0, "no model call");
  });

  it("offers submit_artifact and returns exactly one result bound to the nonce", async () => {
    const { model, chat } = scripted([[artifactCall(ARTIFACT)], [say(FINAL)]]);
    const { text, results } = await runArtifact(newEngine(model));
    assert.ok(offeredNames(chat[0]).includes("submit_artifact"));
    assert.ok(JSON.stringify(chat[0].prompt).includes("Visual report output"), "generic prompt section");
    assert.equal(text, FINAL);
    assert.equal(text.includes("<html"), false, "the HTML rides beside the text");
    assert.deepEqual(results, [{ contract: "artifact-turn-v1", nonce: NONCE, artifact: ARTIFACT, reasonCode: null }]);
  });

  it("a text-only answer reports no artifact and no reason", async () => {
    const { model } = scripted([[say("Flamengo venceu por 2 a 1.")]]);
    const { results } = await runArtifact(newEngine(model));
    assert.deepEqual(results, [{ contract: "artifact-turn-v1", nonce: NONCE, artifact: null, reasonCode: null }]);
  });

  it("an invalid or conflicting submission yields no document and its reason", async () => {
    for (const [steps, reasonCode] of [
      [[[artifactCall({ ...ARTIFACT, html: "" })], [say(FINAL)]], "invalid_artifact"],
      [[[artifactCall(ARTIFACT)], [artifactCall(OTHER)], [say(FINAL)]], "conflicting_artifact"],
    ]) {
      const { model } = scripted(steps);
      const { results } = await runArtifact(newEngine(model));
      assert.deepEqual(results, [{ contract: "artifact-turn-v1", nonce: NONCE, artifact: null, reasonCode }]);
    }
  });

  it("the document is never evidence for the answer's fact-check", async () => {
    const { model, all } = scripted([[artifactCall(ARTIFACT)], [say(FINAL)]]);
    await runArtifact(newEngine(model));
    // With no data tool in the turn, the document alone must not trigger a fact-check against itself.
    const checks = all.filter((call) => !call.tools || call.tools.length === 0);
    assert.equal(checks.length, 0, "submit_artifact is not a data source");
  });

  it("an allowlist without submit_artifact denies it instead of widening", async () => {
    const { model, chat } = scripted([[say(FINAL)]]);
    const { results } = await runArtifact(newEngine(model, { toolAllowlist: ["get_scores"] }));
    assert.equal(offeredNames(chat[0] ?? {}).includes("submit_artifact"), false);
    assert.deepEqual(results, [{ contract: "artifact-turn-v1", nonce: NONCE, artifact: null, reasonCode: "denied" }]);
  });

  it("legacy runs never see the tool or the prompt section", async () => {
    const { model, chat } = scripted([[say(FINAL)]]);
    const text = await newEngine(model).run(REQUEST, { historyMode: "caller", history: clone(HISTORY) });
    assert.equal(text, FINAL);
    assert.equal(offeredNames(chat[0]).includes("submit_artifact"), false);
    assert.equal(JSON.stringify(chat[0].prompt).includes("Visual report output"), false);
  });

  it("drops the document when the answer's evidence check did not pass", () => {
    const engine = newEngine(scripted([]).model);
    for (const outcome of ["corrected", "flagged", "withheld"]) {
      const collector = wire.createArtifactOutputCollector();
      collector.tool.execute(clone(ARTIFACT), { toolCallId: "t", messages: [] });
      const run = { input: clone(TURN), collector, denied: false, result: null };
      engine._lastRunTrace = { verification: { outcome } };
      engine.finalizeArtifact(run);
      assert.deepEqual(run.result, { contract: "artifact-turn-v1", nonce: NONCE, artifact: null, reasonCode: "evidence_unverified" }, outcome);
    }
    for (const outcome of ["kept", "unverified", undefined]) {
      const collector = wire.createArtifactOutputCollector();
      collector.tool.execute(clone(ARTIFACT), { toolCallId: "t", messages: [] });
      const run = { input: clone(TURN), collector, denied: false, result: null };
      engine._lastRunTrace = outcome ? { verification: { outcome } } : {};
      engine.finalizeArtifact(run);
      assert.deepEqual(run.result.artifact, ARTIFACT, String(outcome));
    }
  });
});

// ---------------------------------------------------------------------------
// CLI plumbing and TypeScript/Python parity with the relay mirror
// ---------------------------------------------------------------------------

const cli = await import("../dist/index.js");
const { spawnSync } = await import("node:child_process");
const { fileURLToPath } = await import("node:url");
const relayDir = join(fileURLToPath(new URL("..", import.meta.url)), "docker", "relay");

describe("artifact CLI plumbing", () => {
  it("reads the artifact input from --history-stdin only, and refuses an invalid one", () => {
    const read = (payload) => cli.takeOneShotHistory(["--history-stdin"], "caller", () => JSON.stringify(payload));
    assert.deepEqual(read({ history: HISTORY, artifact: clone(TURN) }).artifact, TURN);
    assert.equal(Object.hasOwn(read({ history: HISTORY }), "artifact"), false);
    assert.throws(() => read({ history: HISTORY, artifact: { ...TURN, nonce: "x" } }), /artifact-turn-v1/);
    assert.throws(() => read({ history: HISTORY, html: "<p>" }), /history array/);
  });

  it("forwards the artifact input and observer only when supplied", () => {
    const base = { userId: "u1", systemPrompt: undefined, agentIds: [], delegated: false };
    const legacy = cli.buildOneShotRunOptions(base);
    assert.equal(Object.hasOwn(legacy, "artifact"), false);
    assert.equal(Object.hasOwn(legacy, "onArtifactResult"), false);
    const onArtifactResult = () => {};
    const options = cli.buildOneShotRunOptions({ ...base, historyMode: "caller", artifact: clone(TURN), onArtifactResult });
    assert.deepEqual(options.artifact, TURN);
    assert.equal(options.onArtifactResult, onArtifactResult);
  });

  it("carries the typed result on the result line, never inside the text", () => {
    const typed = { contract: "artifact-turn-v1", nonce: NONCE, artifact: clone(ARTIFACT), reasonCode: null };
    assert.deepEqual(cli.oneShotResultEvent("Final"), { type: "result", text: "Final" });
    const event = cli.oneShotResultEvent("Montei o relatório.", undefined, typed);
    assert.deepEqual(event, { type: "result", text: "Montei o relatório.", artifact: typed });
    assert.equal(event.text.includes("<html"), false);
  });
});

describe("TypeScript/Python artifact wire parity", () => {
  it("both sides accept and refuse exactly the same documents", () => {
    const max = wire.MAX_ARTIFACT_HTML_BYTES;
    const cases = [
      clone(ARTIFACT),
      { ...ARTIFACT, title: "é".repeat(120) },
      { ...ARTIFACT, title: "😀".repeat(60) },
      { ...ARTIFACT, title: "😀".repeat(61) },
      { ...ARTIFACT, html: "x".repeat(max) },
      { ...ARTIFACT, html: "x".repeat(max + 1) },
      { ...ARTIFACT, html: "é".repeat(max / 2) },
      { ...ARTIFACT, html: "é".repeat(max / 2 + 1) },
      { ...ARTIFACT, html: "<p>\u0085</p>" },
      { ...ARTIFACT, html: "<p>\t\r\n</p>" },
      { ...ARTIFACT, mimeType: "text/plain" },
      { ...ARTIFACT, url: "https://x" },
    ];
    const run = spawnSync(process.env.PYTHON_PATH || "python3", ["-c",
      "import json, sys; sys.path.insert(0, sys.argv[1]); import artifact_contract as a; " +
      "print(json.dumps([a.parse_artifact(c) is not None for c in json.loads(sys.stdin.read())]))", relayDir], {
      input: JSON.stringify(cases), encoding: "utf-8", timeout: 60_000,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout.trim()), cases.map((c) => wire.parseArtifactOutput(c) !== null));
  });
});
