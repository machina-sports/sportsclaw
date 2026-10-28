// #172: the evidence verifier must know when it sees only part of the data the
// draft was written from, so absence from a truncated source can't overturn a
// correct answer — while visible contradictions still count.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { jsonSchema, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";

// run() records tokens and lists agents under HOME: a fresh temp dir, set before the engine loads.
const home = mkdtempSync(join(tmpdir(), "sportsclaw-partial-view-"));
const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = home;
process.env.USERPROFILE = home;
after(() => {
  for (const [key, value] of Object.entries(savedHome)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

const { isTruncatedEvidence, sportsclawEngine, summarizeToolOutputForEvidence } = await import("../dist/engine.js");
const { DEFAULT_CONFIG } = await import("../dist/types.js");

function verifier(verdicts) {
  const queue = [...verdicts];
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(queue.shift() ?? { isValid: true, discrepancies: [] }) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 1, noCache: 1 }, outputTokens: { total: 1, text: 1 } },
      warnings: [],
    }),
  });
}

function engineWith(model) {
  const engine = Object.create(sportsclawEngine.prototype);
  engine.config = { ...DEFAULT_CONFIG, thinkingBudget: 0, evidenceVerifier: {} };
  engine.mainModel = model;
  engine._evidenceReceipts = [];
  return engine;
}

const systemOf = (call) => call.prompt.find((m) => m.role === "system")?.content ?? "";
const userOf = (call) => call.prompt.filter((m) => m.role === "user").flatMap((m) => m.content).map((p) => p.text).join("\n");

test("isTruncatedEvidence recognises both truncation markers", () => {
  const long = JSON.stringify({ games: Array.from({ length: 900 }, (_, i) => ({ i, date: `2025-12-${i}` })) });
  const cut = summarizeToolOutputForEvidence(long, 24_000);
  assert.ok(cut.length < long.length);
  assert.equal(isTruncatedEvidence(cut), true, "middle dropped by the evidence summarizer");
  assert.equal(isTruncatedEvidence("rows...\n\n[... output truncated: showing 30,000 of 61,483 chars. Re-query]"), true);
  assert.equal(isTruncatedEvidence('{"games":[1,2,3]}'), false);
});

test("a truncated source is labelled and the verifier is told absence is not a discrepancy", async () => {
  const model = verifier([{ isValid: true, discrepancies: [] }]);
  const engine = engineWith(model);
  const out = await engine.validateResponseEvidence({
    userPrompt: "How many games had the Heat won through Dec 31?",
    draft: "18 wins. FINAL: 18",
    toolOutputs: [{ toolName: "nba_get_nbastats_game_log", output: "{...games...}\n...[truncated middle]...\n{...}", truncated: true }],
  });
  assert.equal(out, "18 wins. FINAL: 18");
  const call = model.doGenerateCalls[0];
  assert.match(systemOf(call), /merely not visible in that partial data is NOT a discrepancy/);
  assert.match(userOf(call), /TRUNCATED: part of this output is omitted/);
});

test("a complete view keeps the original strict prompt (no partial-view rule)", async () => {
  const model = verifier([{ isValid: true, discrepancies: [] }]);
  await engineWith(model).validateResponseEvidence({
    userPrompt: "Final score?",
    draft: "Heat 118-112. FINAL: 118-112",
    toolOutputs: [{ toolName: "nba_get_scoreboard", output: '{"home":118,"away":112}', truncated: false }],
  });
  const call = model.doGenerateCalls[0];
  assert.doesNotMatch(systemOf(call), /NOT a discrepancy/);
  assert.doesNotMatch(userOf(call), /TRUNCATED/);
});

test("more sources than the verifier shows also counts as a partial view", async () => {
  const model = verifier([{ isValid: true, discrepancies: [] }]);
  await engineWith(model).validateResponseEvidence({
    userPrompt: "q",
    draft: "a",
    toolOutputs: Array.from({ length: 12 }, (_, i) => ({ toolName: `t${i}`, output: `{"i":${i}}`, truncated: false })),
  });
  const call = model.doGenerateCalls[0];
  assert.match(userOf(call), /2 further source\(s\) were fetched but are not shown/);
  assert.match(systemOf(call), /NOT a discrepancy/);
});

test("visible contradictions on a truncated source are still flagged (the draft is kept)", async () => {
  // The verdict flags a contradiction the checker can see; the draft stands and the flag goes to the trace.
  const model = new MockLanguageModelV3({
    doGenerate: async ({ prompt }) => {
      const system = prompt.find((m) => m.role === "system")?.content ?? "";
      const verdictCall = /JSON verdict|fact-checker/.test(system);
      const calls = model.doGenerateCalls.length;
      const text = verdictCall
        ? JSON.stringify(calls === 1
          ? { isValid: false, discrepancies: [{ claim: "Heat scored 120", evidence: "data shows 118", severity: "high" }] }
          : { isValid: true, discrepancies: [] })
        : "Heat 118-112. FINAL: 118-112";
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 1, noCache: 1 }, outputTokens: { total: 1, text: 1 } },
        warnings: [],
      };
    },
  });
  const out = await engineWith(model).validateResponseEvidence({
    userPrompt: "Final score?",
    draft: "Heat 120-112. FINAL: 120-112",
    toolOutputs: [{ toolName: "nba_get_scoreboard", output: '{"home":118}\n...[truncated middle]...\n{}', truncated: true }],
  });
  assert.equal(out, "Heat 120-112. FINAL: 120-112", "the draft is not rewritten");
  assert.equal(model.doGenerateCalls.length, 1, "no correction pass");
});

// ---------------------------------------------------------------------------
// The opt-in Jev verifier gets the same public partial-view and failed-source
// context, and is the one checker for failure-only turns.
// ---------------------------------------------------------------------------

/** Jev transport recorder answering every question with `choose(id, body)`; credential reads are counted. */
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
      const choice = choose(id, body);
      const labels = Object.keys(question.criteria);
      answers[id] = { type: "choice", choice, confidence: 1, probabilities: Object.fromEntries(labels.map((l) => [l, l === choice ? 1 : 0])) };
    }
    return new Response(JSON.stringify({ model: body.model, answers }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return {
    bodies,
    reads: () => credentialReads,
    config: (publicToolNames) => ({ provider: "jev", dataPolicy: "cloud_allowed", publicToolNames, transport, env }),
  };
}

test("Jev judges a partial view with the partial-view rule and the failed sources", async () => {
  const model = verifier([]);
  const engine = engineWith(model);
  const jev = jevRecorder();
  engine.config.evidenceVerifier = jev.config(["nba_get_nbastats_game_log", "nba_get_scoreboard"]);
  const out = await engine.validateResponseEvidence({
    userPrompt: "How many games had the Heat won through Dec 31?",
    draft: "18 wins. FINAL: 18",
    toolOutputs: [{ toolName: "nba_get_nbastats_game_log", output: "{...games...}\n...[truncated middle]...\n{...}", truncated: true }],
    failedTools: ["nba_get_scoreboard"],
  });
  assert.equal(out, "18 wins. FINAL: 18");
  assert.equal(jev.bodies.length, 1);
  assert.equal(model.doGenerateCalls.length, 0, "no generative checker beside Jev");
  const { state } = jev.bodies[0];
  assert.match(state, /TRUNCATED: part of this output is omitted/);
  assert.match(state, /merely not visible in that partial data is NOT a discrepancy/);
  assert.match(state, /nba_get_scoreboard/);
});

test("a failure-only turn still reaches the one Jev check", async () => {
  const model = verifier([]);
  const engine = engineWith(model);
  const jev = jevRecorder();
  engine.config.evidenceVerifier = jev.config(["nba_get_scoreboard"]);
  const draft = "Heat 118-112 over the Knicks. FINAL: 118-112";
  const out = await engine.validateResponseEvidence({ userPrompt: "Final score?", draft, toolOutputs: [], failedTools: ["nba_get_scoreboard"] });
  assert.equal(out, draft);
  assert.equal(jev.bodies.length, 1);
  assert.equal(model.doGenerateCalls.length, 0);
  assert.match(jev.bodies[0].state, /nba_get_scoreboard/);
});

// Real run(); MCP init, tool construction and the main system prompt are fixtures.
const PROMPT = "Final score of the Heat game last night?";
const DRAFT = "Heat 118-112 over the Knicks. FINAL: 118-112";
const CALLER = {
  historyMode: "caller",
  history: [
    { role: "user", content: "HISTORY_MARKER who did the Heat play?" },
    { role: "assistant", content: "HISTORY_MARKER the Knicks." },
  ],
  systemPrompt: "CALLER_POLICY_MARKER answer briefly. PROFILE_MARKER favourite team: Heat.",
};

function runHarness({ steps, publicToolNames }) {
  const jev = jevRecorder();
  let chat = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const content = options.tools?.length
        ? steps[chat++] ?? [{ type: "text", text: "UNSCRIPTED" }]
        : [{ type: "text", text: JSON.stringify({ isValid: true, discrepancies: [] }) }];
      return {
        content,
        finishReason: { unified: content.some((p) => p.type === "tool-call") ? "tool-calls" : "stop", raw: undefined },
        usage: { inputTokens: { total: 1, noCache: 1 }, outputTokens: { total: 1, text: 1 } },
        warnings: [],
      };
    },
  });
  const engine = Object.create(sportsclawEngine.prototype);
  engine.config = { ...DEFAULT_CONFIG, thinkingBudget: 0, maxTurns: 4, evidenceVerifier: jev.config(publicToolNames) };
  engine.messages = [];
  engine.mainModel = model;
  engine.mainModelId = "synthetic-main-model";
  engine.registry = { getInstalledSkills: () => [], getAllToolSpecs: () => [], getSkillName: () => undefined };
  engine.mcpManager = { serverCount: 0, setUserId() {} };
  engine.initAsync = async () => {};
  engine.buildSystemPrompt = () => "SYNTHETIC_MAIN_SYSTEM";
  engine.buildTools = () => ({
    nba_get_scoreboard: tool({
      description: "NBA scoreboard",
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      execute: async () => {
        throw new Error("SYNTHETIC_FEED_DOWN");
      },
    }),
  });
  const checkerCalls = () => model.doGenerateCalls.filter((call) => !call.tools?.length).length;
  return { engine, jev, checkerCalls };
}

const failedFeedTurn = [
  [{ type: "tool-call", toolCallId: "call_1", toolName: "nba_get_scoreboard", input: "{}" }],
  [{ type: "text", text: DRAFT }],
];

test("run(): a failure-only factual turn gets one Jev check, no generative gate, and only the approved projection", async () => {
  const { engine, jev, checkerCalls } = runHarness({ steps: failedFeedTurn, publicToolNames: ["nba_get_scoreboard"] });
  const answer = await engine.run(PROMPT, CALLER);
  assert.equal(jev.bodies.length, 1, "the one Jev check covers the failed source");
  assert.equal(checkerCalls(), 0, "no generative applyEvidenceGate before it");
  assert.equal(answer, DRAFT);
  const { state } = jev.bodies[0];
  assert.match(state, /nba_get_scoreboard/);
  assert.ok(state.includes(DRAFT));
  assert.ok(state.includes(PROMPT));
  for (const marker of ["CALLER_POLICY_MARKER", "PROFILE_MARKER", "HISTORY_MARKER"]) {
    assert.doesNotMatch(JSON.stringify(jev.bodies), new RegExp(marker));
  }
});

test("run(): an unapproved failed source never reaches Jev or its credential, and the refusal is recorded", async () => {
  const { engine, jev } = runHarness({ steps: failedFeedTurn, publicToolNames: [] });
  await engine.run(PROMPT, CALLER);
  assert.equal(jev.bodies.length, 0);
  assert.equal(jev.reads(), 0);
  assert.equal(engine.evidenceReceipts[0]?.reasonCode, "unapproved_evidence");
});

test("run(): plain chat with no tool evidence and no artifact adds no checker call", async () => {
  const { engine, jev, checkerCalls } = runHarness({
    steps: [[{ type: "text", text: "Good evening! Ready when you are." }]],
    publicToolNames: ["nba_get_scoreboard"],
  });
  assert.equal(await engine.run("Good evening", CALLER), "Good evening! Ready when you are.");
  assert.equal(jev.bodies.length, 0);
  assert.equal(jev.reads(), 0);
  assert.equal(checkerCalls(), 0);
  assert.deepEqual(engine.evidenceReceipts, []);
});
