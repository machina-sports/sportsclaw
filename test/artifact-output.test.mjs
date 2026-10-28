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
 *     nonce, legacy runs unchanged;
 *   - evidence: the complete HTML is judged beside the prose in the one Jev
 *     check (as the candidate, never as a source), private/binary/oversized
 *     candidates refuse before any key or request, and only a document that
 *     check actually covered and passed is published;
 *   - the same holds for the configured generative checker; a document built
 *     only from user-supplied data (no tool output, no failed source) goes to
 *     that primary checker even when Jev is configured, after the same
 *     refusals and with no Jev key read or request (the request is input, not
 *     fetched evidence); plain chat runs no check;
 *   - an artifact attempt replaces the secondary slip extraction, and empty
 *     prose with a valid artifact gets neutral text and no recovery generation.
 *
 * HOME is a fresh temp dir so no real config, schemas, agents or memory load.
 * Any network call fails the run and is counted.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  "SPORTSCLAW_EVIDENCE_VERIFIER", "SPORTSCLAW_EVIDENCE_DATA_POLICY", "SPORTSCLAW_EVIDENCE_PUBLIC_TOOLS",
  "SPORTSCLAW_SLIP_ENABLED", "SPORTSCLAW_SLIP_JEV_DATA_POLICY", "SPORTSCLAW_SLIP_NATIVE_ONLY", "SPORTSCLAW_WATCH_INTENT_NATIVE_CONFIG",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
for (const key of ENV_KEYS) delete process.env[key];
process.env.HOME = home;
process.env.USERPROFILE = home;
// Placeholder only: the engine's model is replaced by a scripted one below.
process.env.ANTHROPIC_API_KEY = "synthetic-anthropic-placeholder";

const wire = await import("../dist/artifact-output.js");
const { sportsclawEngine } = await import("../dist/engine.js");
const { hashSlipTurnInput } = await import("../dist/slip-output.js");

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

/**
 * One scripted step per tool-bearing call; tool-less calls (fact-check, router, synthesis) get a clean
 * verdict, or `verdict(options)` when given.
 */
function scripted(steps, { synthesis, verdict = () => VERDICT_OK } = {}) {
  const chat = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      if (!options.tools || options.tools.length === 0) {
        const lanes = synthesis !== undefined && JSON.stringify(options.prompt).includes("Combine the following agent responses");
        return generated([say(lanes ? synthesis : verdict(options))]);
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

async function runArtifact(engine, extra = {}, prompt = REQUEST) {
  const results = [];
  const text = await engine.run(prompt, {
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
    // The configured (default generative) checker judged this exact document and passed it.
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

  it("a verification label alone never publishes a document it did not check", () => {
    const engine = newEngine(scripted([]).model);
    for (const outcome of ["corrected", "flagged", "withheld", "kept", "unverified", undefined]) {
      const collector = wire.createArtifactOutputCollector();
      collector.tool.execute(clone(ARTIFACT), { toolCallId: "t", messages: [] });
      const run = { input: clone(TURN), collector, denied: false, result: null };
      engine._lastRunTrace = outcome ? { verification: { outcome } } : {};
      engine.finalizeArtifact(run);
      assert.deepEqual(run.result, { contract: "artifact-turn-v1", nonce: NONCE, artifact: null, reasonCode: "evidence_unverified" }, String(outcome));
    }
  });
});

// ---------------------------------------------------------------------------
// The document in the one evidence judgment (opt-in Jev, approved public tool)
// ---------------------------------------------------------------------------

const SOURCE = JSON.stringify({ match: "Flamengo x Palmeiras", score: "2-1", winner: "Flamengo" });
const PROSE = "Flamengo venceu o Palmeiras por 2 a 1; o relatório traz a comparação.";
const scoresCall = () => toolCall("get_scores", JSON.stringify({ team: "Flamengo" }));
const ACCEPTED = Object.freeze({ contract: "artifact-turn-v1", nonce: NONCE, artifact: ARTIFACT, reasonCode: null });
const WITHHELD = Object.freeze({ contract: "artifact-turn-v1", nonce: NONCE, artifact: null, reasonCode: "evidence_unverified" });

/** Jev transport answering every question with `choose(body)`; credential reads are counted. */
function jevRecorder(choose = () => "supported") {
  const bodies = [];
  let credentialReads = 0;
  const env = Object.defineProperty({}, "TYPESAFE_API_KEY", {
    get() {
      credentialReads++;
      return "synthetic-key";
    },
  });
  const transport = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const answers = {};
    for (const [id, question] of Object.entries(body.questions)) {
      const choice = choose(body);
      const labels = Object.keys(question.criteria);
      answers[id] = { type: "choice", choice, confidence: 1, probabilities: Object.fromEntries(labels.map((l) => [l, l === choice ? 1 : 0])) };
    }
    return new Response(JSON.stringify({ model: body.model, answers }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return {
    bodies,
    reads: () => credentialReads,
    config: { provider: "jev", dataPolicy: "cloud_allowed", publicToolNames: ["get_scores"], transport, env },
  };
}

/** The real engine plus one public data tool returning SOURCE. */
function evidenceEngine(model, jev, config = {}) {
  const engine = newEngine(model, { evidenceVerifier: jev.config, ...config });
  const offered = engine.buildTools.bind(engine);
  engine.buildTools = (...args) => ({
    ...offered(...args),
    get_scores: tool({
      description: "Scores",
      inputSchema: jsonSchema({ type: "object", properties: { team: { type: "string" } }, required: ["team"] }),
      execute: async () => SOURCE,
    }),
  });
  return engine;
}

/** The generative checker selected while the Jev recorder stays wired, so any Jev traffic would be counted. */
const generative = (jev, extra = {}) => ({ evidenceVerifier: { ...jev.config, provider: "generative", ...extra } });
/** The two configured checkers, as evidenceEngine overrides. */
const CHECKERS = [["generative", (jev) => generative(jev)], ["jev", () => ({})]];

const promptText = (call) =>
  call.prompt.map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join("\n"))).join("\n");
/** Tool-less generative fact-check calls (first verdict and its retry). */
const checkerCalls = (all) => all.filter((call) => !call.tools?.length && promptText(call).includes("isValid"));
const editorCalls = (all) => all.filter((call) => !call.tools?.length && promptText(call).includes("expert sports editor"));
const CORRECTED = "Flamengo venceu o Palmeiras por 2 a 1.";
/** A generative checker that flags only when it actually sees `marker`; the editor returns corrected prose. */
const judge = (marker) => (options) => {
  const text = promptText(options);
  if (text.includes("expert sports editor")) return CORRECTED;
  if (!text.includes(marker)) return VERDICT_OK;
  return JSON.stringify({ isValid: false, discrepancies: [{ claim: marker, evidence: "not in the data", severity: "high", kind: "contradicted" }] });
};

const SLIP_CONTEXT = Object.freeze({
  contract: "slip-revision-v1",
  slipId: "slp_SYNTHETICslip000000000",
  revisionId: "slr_SYNTHETICrev0000000000",
  parentRevisionId: null,
  status: "proposed",
  legs: [{
    id: "sll_SYNTHETICleg0000000000", event: "Flamengo x Palmeiras", market: "moneyline", selection: "Flamengo",
    period: null, line: null, quotedOdds: null, source: "user_text", unresolved: [],
  }],
  unresolved: [],
});

/** Slip mode is server-gated; open the gates only around one run. */
async function withSlipGates(fn) {
  process.env.SPORTSCLAW_SLIP_ENABLED = "true";
  process.env.SPORTSCLAW_SLIP_JEV_DATA_POLICY = "cloud_allowed";
  try {
    return await fn();
  } finally {
    delete process.env.SPORTSCLAW_SLIP_ENABLED;
    delete process.env.SPORTSCLAW_SLIP_JEV_DATA_POLICY;
  }
}

async function runSlipArtifact(engine, context = null, extra = {}) {
  const slip = { contract: "slip-turn-v1", requestText: REQUEST, context: context && clone(context) };
  const slipResults = [];
  const out = await withSlipGates(() => runArtifact(engine, { slip, onSlipResult: (r) => slipResults.push(clone(r)), ...extra }));
  return { ...out, slip, slipResults };
}

describe("the document in the evidence judgment", () => {
  it("judges the complete HTML beside the prose in one check and publishes what it checked", async () => {
    const jev = jevRecorder();
    const { model } = scripted([[scoresCall()], [artifactCall(ARTIFACT)], [say(PROSE)]]);
    const { text, results } = await runArtifact(evidenceEngine(model, jev));
    assert.equal(jev.bodies.length, 1, "one evidence judgment");
    const { state } = jev.bodies[0];
    assert.ok(state.includes(HTML), "the complete document");
    assert.ok(state.includes(PROSE), "beside the prose");
    assert.equal((state.match(/\[Internal source \d+/g) ?? []).length, 1, "the document is the candidate, never a source");
    assert.equal(text, PROSE);
    assert.deepEqual(results, [ACCEPTED]);
  });

  it("correct prose cannot carry contradictory HTML, and a prose-only correction does not certify it", async () => {
    const contradicting = { ...ARTIFACT, html: HTML.replace("Comparação", "Palmeiras venceu por 3 a 0") };
    // A checker that objects only when it actually sees the contradicting document.
    const jev = jevRecorder((body) => (body.state.includes("Palmeiras venceu por 3 a 0") ? "contradicted" : "supported"));
    const { model } = scripted([[scoresCall()], [artifactCall(contradicting)], [say(PROSE)]]);
    const { results } = await runArtifact(evidenceEngine(model, jev));
    assert.ok(jev.bodies[0]?.state.includes(contradicting.html), "the first judgment saw the document");
    assert.deepEqual(results, [WITHHELD]);
  });

  const SIGNED = "https://reports.example.test/r/SYNTHETIC_REPORT?X-Amz-Signature=SYNTHETICSIG&X-Amz-Expires=300";
  const withBody = (extra) => HTML.replace("</h1>", `</h1>${extra}`);
  const refusals = [
    ["an inline data-URI image", withBody('<img alt="chart" src="data:image/png;base64,iVBORw0KGgoSYNTHETICIMAGE=">'), "unsupported_content"],
    ["the caller's private turn nonce", withBody(`<p>ref ${NONCE}</p>`), "private_content"],
    ["a signed report link", withBody(`<a href="${SIGNED}">relatório</a>`), "private_content"],
    ["the actual report bearer-link format", withBody(`<a href="https://reports.example.test/rpt_${"A".repeat(22)}?t=1893456000.${"B".repeat(32)}">report</a>`), "private_content"],
    ["an encoded report bearer-link path", withBody(`<a href="https://reports.example.test/%72pt%5F${"A".repeat(22)}?t=1893456000.${"B".repeat(32)}">report</a>`), "private_content"],
    ["a case-variant report reference", withBody(`<p>RPT_${"A".repeat(22)}</p>`), "private_content"],
    ["a malformed reserved report reference", withBody("<p>rpt_SHORT</p>"), "private_content"],
    ["a case-variant slip reference", withBody(`<p>${SLIP_CONTEXT.revisionId.toUpperCase()}</p>`), "private_content", SLIP_CONTEXT],
    ["a known private slip revision ID", withBody(`<p>${SLIP_CONTEXT.revisionId}</p>`), "private_content", SLIP_CONTEXT],
    ["an oversized complete candidate", `<!doctype html><html><body>${"<p>Flamengo 2 x 1 Palmeiras.</p>".repeat(1_500)}</body></html>`, "request_too_large"],
  ];

  for (const [label, html, reasonCode, slipContext] of refusals) {
    it(`refuses ${label} before any credential read or request, and publishes nothing`, async () => {
      const doc = { ...ARTIFACT, html };
      assert.ok(wire.parseArtifactOutput(doc), "a valid artifact-v1 document");
      const jev = jevRecorder();
      const { model } = scripted([[scoresCall()], [artifactCall(doc)], [say(PROSE)]]);
      const engine = evidenceEngine(model, jev);
      const { results } = slipContext ? await runSlipArtifact(engine, slipContext) : await runArtifact(engine);
      assert.equal(jev.bodies.length, 0, "no request");
      assert.equal(jev.reads(), 0, "no credential read");
      assert.deepEqual(results, [WITHHELD]);
      assert.equal(engine.evidenceReceipts[0]?.reasonCode, reasonCode);
    });
  }
});

describe("the document with the configured generative checker", () => {
  it("judges the complete HTML beside the prose with no Jev traffic, and publishes only what it passed", async () => {
    const jev = jevRecorder();
    const { model, all } = scripted([[scoresCall()], [artifactCall(ARTIFACT)], [say(PROSE)]]);
    const { text, results } = await runArtifact(evidenceEngine(model, jev, generative(jev)));
    assert.equal(jev.bodies.length, 0, "no Jev request");
    assert.equal(jev.reads(), 0, "no Jev credential read");
    const checks = checkerCalls(all);
    assert.equal(checks.length, 1, "one check");
    const judged = promptText(checks[0]);
    assert.ok(judged.includes(HTML), "the complete document");
    assert.ok(judged.includes(PROSE), "beside the prose");
    assert.equal((judged.match(/\[Internal source \d+/g) ?? []).length, 1, "the document is the candidate, never a source");
    assert.equal(text, PROSE);
    assert.deepEqual(results, [ACCEPTED]);
  });

  it("a contradiction, or a prose-only correction, cannot publish the old HTML", async () => {
    const marker = "Palmeiras venceu por 3 a 0";
    const contradicting = { ...ARTIFACT, html: HTML.replace("Comparação", marker) };
    for (const generativeAction of ["retain", "correct"]) {
      const jev = jevRecorder();
      const { model, all } = scripted([[scoresCall()], [artifactCall(contradicting)], [say(PROSE)]], { verdict: judge(marker) });
      const { results } = await runArtifact(evidenceEngine(model, jev, generative(jev, { generativeAction })));
      const [first] = checkerCalls(all);
      assert.ok(first && promptText(first).includes(contradicting.html), `${generativeAction}: the first check saw the document`);
      assert.equal(editorCalls(all).length, generativeAction === "correct" ? 1 : 0, `${generativeAction}: correction pass`);
      assert.equal(jev.bodies.length, 0, generativeAction);
      assert.deepEqual(results, [WITHHELD], generativeAction);
    }
  });
});

describe("an artifact built from user-supplied data", () => {
  const SUPPLIED = "Monte um relatório com os números sintéticos que eu forneço: Time Azul 12 pontos, Time Verde 9 pontos.";
  const SUMMARY = "Montei a tabela com os números que você forneceu.";
  const suppliedDoc = (extra = "") => ({
    ...ARTIFACT,
    title: "Relatório sintético",
    html: `<!doctype html><html><body><table><tr><td>Time Azul</td><td>12</td></tr><tr><td>Time Verde</td><td>9</td></tr></table>${extra}</body></html>`,
  });
  it("reaches the primary checker with no tool output, as approved input rather than fetched evidence, even with Jev configured", async () => {
    for (const [mode, config] of CHECKERS) {
      const doc = suppliedDoc();
      const jev = jevRecorder();
      const { model, all } = scripted([[artifactCall(doc)], [say(SUMMARY)]]);
      const engine = evidenceEngine(model, jev, config(jev));
      const { results } = await runArtifact(engine, {}, SUPPLIED);
      const judged = checkerCalls(all).map(promptText);
      assert.equal(judged.length, 1, `${mode}: one primary check`);
      assert.equal(jev.bodies.length, 0, `${mode}: no Jev request`);
      assert.equal(jev.reads(), 0, `${mode}: no Jev credential read`);
      assert.ok(judged[0].includes(doc.html), `${mode}: the complete document`);
      assert.ok(judged[0].includes("Time Azul 12 pontos"), `${mode}: the user's own numbers`);
      assert.doesNotMatch(judged[0], /\[Internal source \d+/, `${mode}: the request is not presented as fetched evidence`);
      assert.deepEqual(results, [{ ...ACCEPTED, artifact: doc }], mode);
      if (mode === "jev") {
        // The receipt names the check that actually ran, never a Jev verification.
        assert.deepEqual(engine.evidenceReceipts.map((r) => [r.provider, r.reasonCode]), [["generative", "source_free"]], mode);
      }
    }
  });

  it("an unsupported fact beyond the supplied numbers is still refused", async () => {
    const marker = "campeão de 2019";
    for (const [mode, config] of CHECKERS) {
      const doc = suppliedDoc(`<p>Time Azul foi ${marker}.</p>`);
      const jev = jevRecorder((body) => (body.state.includes(marker) ? "contradicted" : "supported"));
      const { model, all } = scripted([[artifactCall(doc)], [say(SUMMARY)]], { verdict: judge(marker) });
      const { results } = await runArtifact(evidenceEngine(model, jev, config(jev)), {}, SUPPLIED);
      assert.ok(checkerCalls(all)[0] && promptText(checkerCalls(all)[0]).includes(marker), `${mode}: the primary check saw the unsupported fact`);
      assert.equal(jev.bodies.length, 0, `${mode}: no Jev request`);
      assert.deepEqual(results, [WITHHELD], mode);
    }
  });

  it("a question is not a supplied premise: the primary checker refuses a report stating it as fact, with no Jev traffic", async () => {
    const QUESTION = "O Time Azul fez 12 pontos? Monte um relatório com a tabela.";
    const marker = "<td>12</td>";
    for (const provider of ["generative", "jev"]) {
      for (const generativeAction of ["retain", "correct"]) {
        const label = `${provider}/${generativeAction}`;
        const doc = suppliedDoc();
        // Jev would answer "supported" if it were asked.
        const jev = jevRecorder();
        const { model, all } = scripted([[artifactCall(doc)], [say(SUMMARY)]], { verdict: judge(marker) });
        const engine = evidenceEngine(model, jev, { evidenceVerifier: { ...jev.config, provider, generativeAction } });
        const { results } = await runArtifact(engine, {}, QUESTION);
        const [first] = checkerCalls(all);
        assert.ok(first && promptText(first).includes(doc.html), `${label}: the primary check saw the document`);
        assert.match(promptText(first), /question that merely mentions a value does not establish it/, `${label}: the no-source rule`);
        assert.equal(editorCalls(all).length, generativeAction === "correct" ? 1 : 0, `${label}: correction limits unchanged`);
        assert.equal(jev.bodies.length, 0, `${label}: no Jev request, recheck included`);
        assert.equal(jev.reads(), 0, `${label}: no Jev credential read`);
        assert.deepEqual(results, [WITHHELD], label);
      }
    }
  });

  const sourceFreeRefusals = [
    ["withheld cloud consent", suppliedDoc(), { dataPolicy: "local_only" }, "local_only"],
    ["an invalid public-tool setting", suppliedDoc(), { publicToolNames: "get_scores" }],
    ["the caller's private turn nonce", suppliedDoc(`<p>ref ${NONCE}</p>`), {}, "private_content"],
    ["a report bearer-link reference", suppliedDoc(`<p>RPT_${"A".repeat(22)}</p>`), {}, "private_content"],
    ["an inline data-URI image", suppliedDoc('<img alt="chart" src="data:image/png;base64,iVBORw0KGgoSYNTHETICIMAGE=">'), {}, "unsupported_content"],
    ["an oversized complete candidate", suppliedDoc("<p>Time Azul 12 pontos, Time Verde 9 pontos.</p>".repeat(1_000)), {}, "request_too_large"],
  ];

  for (const [label, doc, extra, reasonCode] of sourceFreeRefusals) {
    it(`with Jev configured, refuses ${label} before any check: no primary-checker fallback, no credential read or request`, async () => {
      assert.ok(wire.parseArtifactOutput(doc), "a valid artifact-v1 document");
      const jev = jevRecorder();
      const { model, all } = scripted([[artifactCall(doc)], [say(SUMMARY)]]);
      const engine = evidenceEngine(model, jev, { evidenceVerifier: { ...jev.config, ...extra } });
      const { results } = await runArtifact(engine, {}, SUPPLIED);
      assert.equal(checkerCalls(all).length, 0, "no primary check");
      assert.equal(jev.bodies.length, 0, "no request");
      assert.equal(jev.reads(), 0, "no credential read");
      assert.deepEqual(results, [WITHHELD]);
      if (reasonCode) assert.equal(engine.evidenceReceipts[0]?.reasonCode, reasonCode);
    });
  }

  it("plain chat without a document makes no checker call", async () => {
    for (const [mode, config] of CHECKERS) {
      const jev = jevRecorder();
      const opted = scripted([[say(SUMMARY)]]);
      const { results } = await runArtifact(evidenceEngine(opted.model, jev, config(jev)), {}, SUPPLIED);
      assert.deepEqual(results, [{ contract: "artifact-turn-v1", nonce: NONCE, artifact: null, reasonCode: null }], mode);
      const legacy = scripted([[say(SUMMARY)]]);
      await evidenceEngine(legacy.model, jev, config(jev)).run(SUPPLIED, { historyMode: "caller", history: clone(HISTORY) });
      assert.equal(checkerCalls(opted.all).length + checkerCalls(legacy.all).length, 0, `${mode}: no generative check`);
      assert.equal(jev.bodies.length, 0, `${mode}: no Jev check`);
    }
  });
});

describe("a no-input advisory turn with a public skill guide", () => {
  it("reads the guide and returns a checked report, without treating the guide as evidence", async () => {
    const GUIDE_MARKER = "SYNTHETIC_GUIDE_STYLE_MARKER";
    const guides = mkdtempSync(join(tmpdir(), "sportsclaw-guides-"));
    mkdirSync(join(guides, "report-style"));
    writeFileSync(
      join(guides, "report-style", "SKILL.md"),
      `---\nname: report-style\ndescription: House style for visual reports.\n---\nUse one two-column table. ${GUIDE_MARKER}\n`,
    );
    process.env.SPORTSCLAW_SKILL_GUIDES_DIR = guides;
    try {
      // Advisory routing: a semantic "unsupported" with no input suggested.
      const routed = [];
      const routing = {
        provider: "jev", dataPolicy: "cloud_allowed", env: { TYPESAFE_API_KEY: "synthetic-key" },
        transport: async (_url, init) => {
          const body = JSON.parse(init.body);
          routed.push(body);
          const answers = {};
          for (const [id, question] of Object.entries(body.questions)) {
            const choice = id === "disposition" ? "unsupported" : "not_required";
            const labels = Object.keys(question.criteria);
            answers[id] = { type: "choice", choice, confidence: 0.97, probabilities: Object.fromEntries(labels.map((l) => [l, l === choice ? 1 : 0])) };
          }
          return new Response(JSON.stringify({ model: body.model, answers }), { status: 200, headers: { "content-type": "application/json" } });
        },
      };
      const prompt = "Monte um relatório visual com os números que eu forneço: Time Azul 12 pontos, Time Verde 9 pontos.";
      const doc = {
        ...ARTIFACT,
        title: "Relatório sintético",
        html: "<!doctype html><html><body><table><tr><td>Time Azul</td><td>12</td></tr><tr><td>Time Verde</td><td>9</td></tr></table></body></html>",
      };
      const jev = jevRecorder();
      const { model, chat, all } = scripted([
        [toolCall("skill_read_reference", JSON.stringify({ skill: "report-style", path: "SKILL.md" }))],
        [artifactCall(doc)],
        [say("Montei a tabela com os números que você forneceu.")],
      ]);
      const engine = evidenceEngine(model, jev, { routing });
      // One installed sports skill, so the turn is actually routed.
      engine.registry.injectSchema({
        sport: "nba",
        tools: [{ name: "nba_get_scores", command: "get_scores", description: "Scores", parameters: { type: "object", properties: {} } }],
      });
      const { results } = await runArtifact(engine, {}, prompt);

      assert.equal(routed.length, 1, "one advisory routing request");
      assert.ok(chat.length >= 2 && JSON.stringify(chat[1].prompt).includes(GUIDE_MARKER), "the public guide was read");
      // No fetched source: the primary checker, not Jev, judges the report.
      assert.equal(jev.bodies.length, 0, "no Jev request");
      const checks = checkerCalls(all);
      assert.equal(checks.length, 1, "the report was checked once");
      const state = promptText(checks[0]);
      assert.ok(state.includes(doc.html), "the complete document");
      assert.doesNotMatch(state, /\[Internal source \d+/, "the guide is not a source");
      assert.equal(state.includes(GUIDE_MARKER), false, "guide text is instruction, not evidence");
      assert.deepEqual(results, [{ ...ACCEPTED, artifact: doc }]);
    } finally {
      delete process.env.SPORTSCLAW_SKILL_GUIDES_DIR;
      rmSync(guides, { recursive: true, force: true });
    }
  });
});

describe("artifact turns and empty-response recovery", () => {
  it("empty prose with a valid artifact returns neutral prepared-output text, not the no-response sentinel", async () => {
    for (const [mode, config] of CHECKERS) {
      const jev = jevRecorder();
      // A recovery, if it ran, would submit a different document and conflict.
      const { model, chat, all } = scripted([[scoresCall()], [artifactCall(ARTIFACT)], [say("")], [artifactCall(OTHER)], [say(PROSE)]]);
      const { text, results } = await runArtifact(evidenceEngine(model, jev, config(jev)));
      assert.equal(chat.length, 3, `${mode}: no recovery call`);
      assert.equal(all.filter((call) => !call.tools?.length && promptText(call).includes("answer synthesizer")).length, 0, `${mode}: no re-synthesis`);
      assert.ok(text.trim().length > 0, `${mode}: some text`);
      assert.doesNotMatch(text, /\[sportsclaw\]|no response generated/i, mode);
      assert.doesNotMatch(text, /<html|https?:\/\/|publicad|salv|published|saved/i, `${mode}: no HTML, link or publication claim`);
      assert.deepEqual(results, [ACCEPTED], mode);
    }
  });

  it("empty prose with a valid artifact is complete: no recovery generation", async () => {
    const jev = jevRecorder();
    // A recovery, if it ran, would submit a different document and conflict.
    const { model, chat } = scripted([[scoresCall()], [artifactCall(ARTIFACT)], [say("")], [artifactCall(OTHER)], [say(PROSE)]]);
    const { results } = await runArtifact(evidenceEngine(model, jev));
    assert.equal(chat.length, 3, "no recovery call");
    assert.deepEqual(results, [ACCEPTED]);
  });

  it("a discarded recovery contributes no document", async () => {
    const jev = jevRecorder();
    // Attempt 1 gathers data but says nothing; the recovery submits a document but also ends empty, so it is discarded.
    const { model, chat } = scripted([[scoresCall()], [say("")], [artifactCall(ARTIFACT)], [say("")]]);
    const { results } = await runArtifact(evidenceEngine(model, jev));
    assert.equal(chat.length, 4, "the recovery still runs for a turn with no text and no artifact");
    assert.deepEqual(results, [{ contract: "artifact-turn-v1", nonce: NONCE, artifact: null, reasonCode: null }]);
  });
});

describe("artifact output and the secondary slip extraction", () => {
  const extractions = (all) =>
    all.filter((call) => !call.tools?.length && JSON.stringify(call.prompt).includes("slip-change proposal")).length;

  for (const [label, doc, reasonCode] of [
    ["an accepted submission", ARTIFACT, null],
    ["a refused submission", { ...ARTIFACT, html: "" }, "invalid_artifact"],
  ]) {
    it(`${label} replaces the extraction with a valid null slip acknowledgement`, async () => {
      const { model, all } = scripted([[artifactCall(doc)], [say(PROSE)]]);
      const { results, slip, slipResults } = await runSlipArtifact(newEngine(model));
      assert.equal(extractions(all), 0, "no secondary slip extraction");
      assert.deepEqual(slipResults, [{ contract: "slip-turn-v1", inputHash: hashSlipTurnInput(slip), decision: null }]);
      assert.equal(results[0].reasonCode, reasonCode);
    });
  }

  it("merely offering or denying the artifact capability keeps the existing extraction", async () => {
    const offered = scripted([[say(PROSE)]]);
    await runSlipArtifact(newEngine(offered.model));
    assert.equal(extractions(offered.all), 1, "offered but unused");

    const denied = scripted([[say(PROSE)]]);
    const { results } = await runSlipArtifact(newEngine(denied.model, { toolAllowlist: ["get_scores", "submit_slip_change"] }));
    assert.equal(results[0].reasonCode, "denied");
    assert.equal(extractions(denied.all), 1, "denied");
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
