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
    toolOutputs: Array.from({ length: 66 }, (_, i) => ({ toolName: `t${i}`, output: `{"i":${i}}`, truncated: false })),
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

// ---------------------------------------------------------------------------
// Verdict kinds on a partial view. A source fact merely absent from the shown
// part ("unsupported") keeps the #172 filter; a task-scope violation (venue,
// date, market) is kind "scope" and stays actionable on a partial view. After a
// Jev "supported" verdict, the fidelity check acts only on "scope" flags, never
// on unsupported-fact flags from a truncated view.
// ---------------------------------------------------------------------------

const PARTIAL_SOURCE = [{ toolName: "nba_get_nbastats_game_log", output: '{"games":[{"opp":"Knicks","heat":118}]}\n...[truncated middle]...\n{}', truncated: true }];
const KIND_DRAFT = "Pick the Heat: DraftKings has them at -150.";
const KIND_CORRECTED = "Pick the Heat on Polymarket at 0.57.";
const KIND_CONTEXT = "user: Show me tonight's Polymarket NBA moneyline board";
const flagOf = (kind) => ({ isValid: false, discrepancies: [{ claim: "the DraftKings pick", evidence: kind === "scope" ? "the user asked for the Polymarket board" : "not in the data shown", severity: "high", kind }] });

/**
 * Factual verdicts from `verdicts` and task-review verdicts from `scopeVerdicts`, in order (then clean);
 * the editor returns KIND_CORRECTED. Each phase is counted separately.
 */
function kindModel(verdicts, scopeVerdicts = []) {
  const queue = [...verdicts];
  const scopeQueue = [...scopeVerdicts];
  const seen = { checks: [], scopes: [], edits: [], order: [] };
  const model = new MockLanguageModelV3({
    doGenerate: async ({ prompt }) => {
      const system = prompt.find((m) => m.role === "system")?.content ?? "";
      const editor = system.startsWith("You are an expert sports editor");
      const scope = system.startsWith("You are a task-completion reviewer");
      (editor ? seen.edits : scope ? seen.scopes : seen.checks).push(system);
      seen.order.push(editor ? "editor" : scope ? "scope" : "fact");
      if (scope) assert.ok(!userOf({ prompt }).includes("Raw source data"), "no raw source batch in the task review");
      const clean = { isValid: true, discrepancies: [] };
      const text = editor ? KIND_CORRECTED : JSON.stringify((scope ? scopeQueue.shift() : queue.shift()) ?? clean);
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 1, noCache: 1 }, outputTokens: { total: 1, text: 1 } },
        warnings: [],
      };
    },
  });
  return { model, seen };
}

const kindParams = (extra = {}) => ({
  userPrompt: "Which one should I pick?", draft: KIND_DRAFT, toolOutputs: PARTIAL_SOURCE,
  conversationContext: KIND_CONTEXT, taskFidelity: true, ...extra,
});

test("generative partial view: an unsupported-fact flag keeps the #172 filter (no correction, draft kept)", async () => {
  const { model, seen } = kindModel([flagOf("unsupported")]);
  const engine = engineWith(model);
  engine.config.evidenceVerifier = { provider: "generative", generativeAction: "correct" };
  const out = await engine.validateResponseEvidence(kindParams());
  assert.equal(out, KIND_DRAFT);
  assert.equal(seen.checks.length, 1);
  assert.equal(seen.edits.length, 0, "absence from a partial view is not a finding");
  assert.deepEqual(seen.order, ["fact", "scope"], "then the one focused task review");
});

test("generative partial view: a task-scope flag stays actionable, with one correction and one recheck", async () => {
  const { model, seen } = kindModel([flagOf("scope")]);
  const engine = engineWith(model);
  engine.config.evidenceVerifier = { provider: "generative", generativeAction: "correct" };
  const out = await engine.validateResponseEvidence(kindParams());
  assert.match(seen.checks[0], /"scope"/, "the checker is told to mark venue/date/market scope violations with kind \"scope\"");
  assert.equal(seen.edits.length, 1, "one correction");
  assert.equal(seen.checks.length, 2, "one check and one recheck");
  assert.deepEqual(seen.order, ["fact", "editor", "fact", "scope"], "the task review follows the factual recheck");
  assert.equal(out, KIND_CORRECTED);
});

test("after a Jev pass on a partial view, an unsupported-fact fidelity flag is not promoted into an override", async () => {
  const { model, seen } = kindModel([], [flagOf("unsupported")]);
  const engine = engineWith(model);
  const jev = jevRecorder();
  engine.config.evidenceVerifier = jev.config(["nba_get_nbastats_game_log"]);
  const out = await engine.validateResponseEvidence(kindParams());
  assert.equal(jev.bodies.length, 1, "Jev judged the facts");
  assert.equal(seen.checks.length, 0, "no duplicate primary factual check after Jev");
  assert.equal(seen.scopes.length, 1, "the one primary task review");
  assert.equal(seen.edits.length, 0, "no correction from a truncated-view fact flag");
  assert.equal(out, KIND_DRAFT, "the Jev-supported answer stands");
  assert.ok(!JSON.stringify(jev.bodies).includes("Polymarket NBA moneyline board"), "the context never reaches Jev");
});

test("after a Jev pass on a partial view, a scope fidelity flag gets the one correction and the bounded recheck", async () => {
  const { model, seen } = kindModel([], [flagOf("scope")]);
  const engine = engineWith(model);
  const jev = jevRecorder();
  engine.config.evidenceVerifier = jev.config(["nba_get_nbastats_game_log"]);
  const out = await engine.validateResponseEvidence(kindParams());
  assert.equal(seen.edits.length, 1, "one correction");
  assert.equal(jev.bodies.length, 2, "one Jev check and one recheck");
  assert.equal(seen.checks.length, 0, "no duplicate primary factual check after Jev");
  assert.deepEqual(seen.order, ["scope", "editor", "scope"], "one task review and one task recheck");
  assert.equal(out, KIND_CORRECTED);
  assert.ok(!JSON.stringify(jev.bodies).includes("Polymarket NBA moneyline board"), "the context never reaches Jev");
});

// ---------------------------------------------------------------------------
// Source projection. The checker no longer sees only the first 10 sources: a
// later successful source the draft relies on, or the newest refresh, must
// reach it. The total stays within the prior theoretical ceiling (10 sources
// × the per-source budget) and at most 64 sources are shown; anything cut or
// omitted stays marked. Jev admission still judges every original source.
// ---------------------------------------------------------------------------

/** 10 × VERIFICATION_EVIDENCE_CHARS: the old ceiling outside public-data mode. */
const SOURCE_CHAR_CEILING = 10 * 8_000;
const MAX_SHOWN_SOURCES = 64;
const CUT = "\n...[truncated middle]...\n";

/** The checker's shown sources (header + body) and its omitted-source note. */
function shownSources(text) {
  let section = text.split("Raw source data (Source of Truth):\n\n")[1].split("\n\nDraft response to check:")[0];
  const note = section.match(/\n\n\[(\d+) further source\(s\) were fetched but are not shown here\]$/) ??
    section.match(/^\[(\d+) further source\(s\) were fetched but are not shown here\]$/);
  if (note) section = section.slice(0, note.index);
  const headers = [...section.matchAll(/^\[Internal source \d+ — [^\n]*\]$/gm)];
  const sources = headers.map((h, i) => ({
    header: h[0],
    body: section.slice(h.index + h[0].length + 1, i + 1 < headers.length ? headers[i + 1].index - 2 : undefined),
  }));
  return { sources, omitted: note ? Number(note[1]) : 0 };
}

/**
 * Each shown body is its input verbatim, or slices of it joined by the cut
 * marker and labelled TRUNCATED: no added text, no rewritten numbers.
 */
function assertFaithfulProjection(sources, inputs) {
  for (const { header, body } of sources) {
    const input = inputs.find((item) => body.startsWith(item.output.slice(0, 12)));
    assert.ok(input, `shown source maps to an input: ${body.slice(0, 40)}`);
    if (body === input.output) {
      if (input.truncated) assert.match(header, /TRUNCATED/);
      continue;
    }
    assert.match(header, /TRUNCATED/, "a source cut by the projection is marked");
    for (const piece of body.split(CUT)) assert.ok(input.output.includes(piece), "only slices of the source itself");
  }
}

const bodyChars = (sources) => sources.reduce((n, s) => n + s.body.length, 0);
const frozen = (items) => Object.freeze(items.map((item) => Object.freeze({ ...item })));

test("a successful source after the tenth that the draft relies on reaches the checker", async () => {
  const model = verifier([{ isValid: true, discrepancies: [] }]);
  const standings = '{"src":38,"standings":[{"team":"Celtics","wins":41,"losses":12}]}';
  const toolOutputs = frozen([
    ...Array.from({ length: 38 }, (_, i) => ({ toolName: `polymarket_search_markets`, output: `{"src":${i},"market":"m${i}","price":0.5}`, truncated: false })),
    { toolName: "nba_get_standings", output: standings, truncated: false },
  ]);
  const before = structuredClone(toolOutputs);
  await engineWith(model).validateResponseEvidence({ userPrompt: "Celtics record?", draft: "The Celtics are 41-12.", toolOutputs });
  const user = userOf(model.doGenerateCalls[0]);
  const { sources, omitted } = shownSources(user);
  assert.ok(sources.some((s) => s.body === standings), "the late standings reach the checker verbatim");
  assert.equal(sources.length, 39, "every small source fits the bound");
  assert.equal(omitted, 0);
  assert.doesNotMatch(systemOf(model.doGenerateCalls[0]), /NOT a discrepancy/, "a complete view keeps the strict prompt");
  assert.deepEqual(toolOutputs, before, "inputs are not mutated");
});

test("the newest refresh source is not starved by earlier large raw responses", async () => {
  const model = verifier([{ isValid: true, discrepancies: [] }]);
  const big = (k) => summarizeToolOutputForEvidence(
    JSON.stringify({ src: k, rows: Array.from({ length: 900 }, (_, i) => ({ i, team: `T${i}`, pts: 100 + (i % 30) })) }), 8_000);
  const newest = '{"src":12,"market":"Celtics ML","price":0.62}';
  const toolOutputs = frozen([
    ...Array.from({ length: 12 }, (_, k) => ({ toolName: "nba_get_nbastats_game_log", output: big(k), truncated: true })),
    { toolName: "polymarket_get_market", output: newest, truncated: false },
  ]);
  const before = structuredClone(toolOutputs);
  await engineWith(model).validateResponseEvidence({ userPrompt: "Celtics price now?", draft: "Celtics ML is 0.62.", toolOutputs });
  const call = model.doGenerateCalls[0];
  const { sources, omitted } = shownSources(userOf(call));
  assert.ok(sources.some((s) => s.body === newest), "the newest source is shown whole");
  assert.ok(bodyChars(sources) <= SOURCE_CHAR_CEILING, `source chars ${bodyChars(sources)} within the prior ceiling`);
  assert.ok(sources.length <= MAX_SHOWN_SOURCES);
  assert.equal(sources.length + omitted, toolOutputs.length, "the omitted count is exact");
  assertFaithfulProjection(sources, toolOutputs);
  assert.match(systemOf(call), /NOT a discrepancy/, "the view is still partial");
  assert.deepEqual(toolOutputs, before, "inputs are not mutated");
});

test("many small sources: at most 64 shown, the most recent kept, numbers and omission exact", async () => {
  const model = verifier([{ isValid: true, discrepancies: [] }]);
  const latest = '{"src":79,"event_id":9007199254740993,"price":0.41}';
  const toolOutputs = frozen([
    ...Array.from({ length: 79 }, (_, i) => ({ toolName: "polymarket_search_markets", output: `{"src":${i},"pad":"${"x".repeat(400)}"}`, truncated: false })),
    { toolName: "polymarket_get_market", output: latest, truncated: false },
  ]);
  await engineWith(model).validateResponseEvidence({ userPrompt: "q", draft: "Price 0.41.", toolOutputs });
  const call = model.doGenerateCalls[0];
  const { sources, omitted } = shownSources(userOf(call));
  assert.equal(sources.length, MAX_SHOWN_SOURCES, "every source fits the char ceiling, so the count bound applies");
  assert.equal(omitted, toolOutputs.length - MAX_SHOWN_SOURCES);
  assert.ok(sources.some((s) => s.body === latest), "the latest source is shown, its unsafe integer untouched");
  assertFaithfulProjection(sources, toolOutputs);
  assert.match(systemOf(call), /NOT a discrepancy/);
});

test("Jev gets the late source and still refuses a disallowed late source", async () => {
  const standings = '{"src":13,"standings":[{"team":"Celtics","wins":41}]}';
  const outputs = [
    ...Array.from({ length: 13 }, (_, i) => ({ toolName: "polymarket_search_markets", output: `{"src":${i},"price":0.5}`, truncated: false })),
    { toolName: "nba_get_standings", output: standings, truncated: false },
  ];
  const ok = engineWith(verifier([]));
  const jev = jevRecorder();
  ok.config.evidenceVerifier = jev.config(["polymarket_search_markets", "nba_get_standings"]);
  await ok.validateResponseEvidence({ userPrompt: "Celtics wins?", draft: "41 wins.", toolOutputs: frozen(outputs) });
  assert.equal(jev.bodies.length, 1);
  assert.ok(jev.bodies[0].state.includes(standings), "the late source reaches Jev");

  const model = verifier([]);
  const refused = engineWith(model);
  const strictJev = jevRecorder();
  refused.config.evidenceVerifier = strictJev.config(["polymarket_search_markets"]);
  await refused.validateResponseEvidence({ userPrompt: "Celtics wins?", draft: "41 wins.", toolOutputs: frozen(outputs) });
  assert.equal(strictJev.bodies.length, 0, "an unapproved source beyond the shown set still refuses the check");
  assert.equal(strictJev.reads(), 0);
  assert.equal(model.doGenerateCalls.length, 0, "no generative fallback");
  assert.equal(refused.evidenceReceipts[0]?.reasonCode, "unapproved_evidence");
});

test("failed calls stay out of the evidence upstream", () => {
  const engine = engineWith(verifier([]));
  const steps = [{ toolResults: [
    { toolCallId: "ok", toolName: "nba_get_standings", output: '{"wins":41}' },
    { toolCallId: "bad", toolName: "polymarket_get_market", output: '{"error":"down"}' },
  ] }];
  const out = engine.collectToolOutputSnippets(steps, new Set(["ok"]), 8_000);
  assert.deepEqual(out.map((o) => o.toolName), ["nba_get_standings"]);
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
  /** Tool-less calls in order: which phase (by system prompt) and how many Jev judgments preceded each. */
  const phases = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      if (!options.tools?.length) {
        const system = options.prompt.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
        const kind = system.startsWith("You are an evidence gate") ? "gate"
          : system.startsWith("You are a strict sports fact-checker") ? "checker"
          : system.startsWith("You are a task-completion reviewer") ? "scope"
          : system.startsWith("You are an expert sports editor") ? "correction" : "other";
        phases.push({ kind, jevBefore: jev.bodies.length, prompt: JSON.stringify(options.prompt) });
      }
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
  return { engine, jev, checkerCalls, phases };
}

const failedFeedTurn = [
  [{ type: "tool-call", toolCallId: "call_1", toolName: "nba_get_scoreboard", input: "{}" }],
  [{ type: "text", text: DRAFT }],
];

test("run(): a failure-only factual turn gets one Jev check, no generative gate, and only the approved projection", async () => {
  const { engine, jev, checkerCalls, phases } = runHarness({ steps: failedFeedTurn, publicToolNames: ["nba_get_scoreboard"] });
  const answer = await engine.run(PROMPT, CALLER);
  assert.equal(jev.bodies.length, 1, "the one Jev check covers the failed source");
  assert.equal(phases.filter((p) => p.kind === "gate").length, 0, "no generative applyEvidenceGate before it");
  // A caller-history follow-up gets the one focused task review, only after Jev supported the facts:
  // no duplicate primary factual check.
  assert.deepEqual(phases.map((p) => [p.kind, p.jevBefore]), [["scope", 1]], "exactly one primary task review, after the Jev judgment");
  assert.equal(checkerCalls(), 1, "no other tool-less call: no gate, factual check, correction or retry");
  assert.ok(!phases[0].prompt.includes("Raw source data"), "the task review carries no raw source batch");
  assert.ok(phases[0].prompt.includes("HISTORY_MARKER who did the Heat play?"), "the primary gate sees the owned user context");
  assert.ok(!phases[0].prompt.includes("HISTORY_MARKER the Knicks."), "a prior assistant answer is not checker evidence");
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
