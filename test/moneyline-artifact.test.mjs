/**
 * Code-owned moneyline reports on the actual artifact path.
 *
 *   - createArtifactOutputCollector({ moneylineScope }) offers the closed data
 *     schema of moneyline-report.ts under the SAME submit_artifact name; execute
 *     and SDK observation parse and render it into the unchanged canonical
 *     artifact-v1. Raw HTML, extra narration and edge fields are invalid, not
 *     legacy compatibility; identical data is stable, different data conflicts,
 *     and an invalidated collector stays invalid. No scope: the generic HTML
 *     collector is unchanged;
 *   - sportsclawEngine.run with config.taskBrief: a resolved single-venue
 *     moneyline report brief selects the mode before primary generation; a
 *     client cannot select it; other briefs keep the generic path;
 *   - the rendered document still goes through the existing factual check
 *     (data-schema validity is not grounding): a contradicted report is
 *     withheld, private values refuse before any request, and a structured
 *     correction must return the same closed data — an HTML repair never
 *     publishes or leaks into chat.
 *
 * HOME is a fresh temp dir; any network call fails the run and is counted.
 * Every model reply is a scripted synthetic fixture.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText, stepCountIs, tool, jsonSchema } from "ai";
import { MockLanguageModelV3 } from "ai/test";

globalThis.AI_SDK_LOG_WARNINGS = false;

const home = mkdtempSync(join(tmpdir(), "sportsclaw-moneyline-"));
const ENV_KEYS = [
  "HOME", "USERPROFILE", "sportsclaw_SCHEMA_DIR", "SPORTSCLAW_SCHEMA_DIR", "SPORTSCLAW_SESSION_DIR",
  "SPORTSCLAW_MEMORY_PROVIDER", "ANTHROPIC_API_KEY", "SPORTSCLAW_AGENTS_DIR", "SPORTSCLAW_SKILLS", "sportsclaw_SKILLS",
  "SPORTSCLAW_ROUTING_PROVIDER", "SPORTSCLAW_ROUTING_DATA_POLICY", "SPORTSCLAW_ROUTING_PUBLIC_DATA_TOOLS", "SPORTSCLAW_SKILL_GUIDES_DIR",
  "SPORTSCLAW_EVIDENCE_VERIFIER", "SPORTSCLAW_EVIDENCE_DATA_POLICY", "SPORTSCLAW_EVIDENCE_PUBLIC_TOOLS",
  "SPORTSCLAW_SLIP_ENABLED", "SPORTSCLAW_SLIP_JEV_DATA_POLICY", "SPORTSCLAW_SLIP_NATIVE_ONLY", "SPORTSCLAW_WATCH_INTENT_NATIVE_CONFIG",
  "SPORTSCLAW_TASK_BRIEF_ENABLED",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
for (const key of ENV_KEYS) delete process.env[key];
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.ANTHROPIC_API_KEY = "synthetic-anthropic-placeholder";

const wire = await import("../dist/artifact-output.js");
const ml = await import("../dist/moneyline-report.js");
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
// Fixtures (artifact-output.test.mjs conventions)
// ---------------------------------------------------------------------------

const clone = (value) => structuredClone(value);
const NONCE = "nonce_0123456789abcdef";
const TURN = Object.freeze({ contract: "artifact-turn-v1", nonce: NONCE });
const HTML = "<!doctype html><html><head><title>Lakers x Celtics</title></head><body><h1>Board</h1></body></html>";
const LEGACY = Object.freeze({ title: "Lakers x Celtics", html: HTML });
const PREPARED = "I prepared the requested report as a separate document.";

const SCOPE = Object.freeze({
  venue: "polymarket", sports: ["nba"], timeScope: "tonight", language: "en", generatedAt: "2026-11-02T18:00:00.000Z",
});
const DATA = Object.freeze({
  games: [
    {
      event: "Lakers at Celtics", status: "upcoming", pick: 0,
      outcomes: [
        { name: "Celtics", price: 0.815, americanOdds: -521, record: { wins: 10, losses: 2 } },
        { name: "Lakers", price: 0.19, americanOdds: 396, record: { wins: 5, losses: 7 } },
      ],
    },
    {
      event: "Knicks at Heat", status: "upcoming",
      outcomes: [{ name: "Knicks", price: 0.655, americanOdds: -214 }, { name: "Heat", price: 0.35, americanOdds: 178 }],
    },
  ],
});
const OTHER_DATA = Object.freeze({ games: [{ ...clone(DATA.games[1]) }] });
/** Same content, different key order: must canonicalize to the same document. */
const REORDERED = Object.freeze({
  games: DATA.games.map((g) => Object.fromEntries(Object.entries(clone(g)).reverse())),
});
const expected = (data, scope = SCOPE) => ml.renderMoneylineReport(ml.parseMoneylineReport(clone(data)), clone(scope));

const USAGE = {
  inputTokens: { total: 10 }, outputTokens: { total: 5 }, totalTokens: { total: 15 }, reasoningTokens: { total: undefined },
};
const VERDICT_OK = JSON.stringify({ isValid: true, discrepancies: [] });
const FINAL = "Built the moneyline report.";

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

const systemText = (call) =>
  call.prompt.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
const isBriefCall = (call) => call.responseFormat?.type === "json"
  && JSON.stringify(call.responseFormat.schema ?? {}).includes("draftIntent")
  && JSON.stringify(call.responseFormat.schema ?? {}).includes("resolvedRequest");
const isRouterCall = (call) => systemText(call).startsWith("You route sports queries");
const phaseOf = (call) => {
  const system = systemText(call);
  if (system.startsWith("You are a strict sports fact-checker")) return "fact";
  if (system.startsWith("You are a task-completion reviewer")) return "scope";
  if (system.startsWith("You are an expert sports editor")) return "editor";
  return "other";
};
const promptText = (call) =>
  call.prompt.map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join("\n"))).join("\n");

const BRIEF = Object.freeze({
  status: "resolved",
  resolvedRequest: "Shareable report of tonight's NBA moneylines from the Polymarket board",
  venues: ["polymarket"], sports: ["nba"], market: "moneyline", timeScope: "tonight", output: "report", draftIntent: "none",
});
const ROUTE = JSON.stringify({ selected_skills: ["polymarket", "nba"], mode: "focused", confidence: 0.9, reason: "mock" });

/** Scripted model: brief and router answered first, then the artifact-output phases. */
function scripted(steps, { brief = BRIEF, verdict = () => VERDICT_OK } = {}) {
  const chat = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      if (isBriefCall(options)) return generated([say(typeof brief === "string" ? brief : JSON.stringify(brief))]);
      if (isRouterCall(options)) return generated([say(ROUTE)]);
      if (phaseOf(options) === "scope") return generated([say(VERDICT_OK)]);
      if (phaseOf(options) !== "other" || !options.tools || options.tools.length === 0) return generated([say(verdict(options))]);
      chat.push(options);
      return generated(steps[chat.length - 1] ?? [say(FINAL)]);
    },
  });
  return { model, chat, all: model.doGenerateCalls };
}

const offeredSchema = (options) => (options?.tools ?? []).find((t) => t.name === "submit_artifact")?.inputSchema;
const checkerCalls = (all) => all.filter((call) => !call.tools?.length && phaseOf(call) === "fact");
const editorCalls = (all) => all.filter((call) => !call.tools?.length && phaseOf(call) === "editor");

// ---------------------------------------------------------------------------
// The collector
// ---------------------------------------------------------------------------

const otherTool = () => tool({
  description: "Scores",
  inputSchema: jsonSchema({ type: "object", properties: { team: { type: "string" } }, required: ["team"] }),
  execute: async () => ({ ok: false, error: "feed unavailable" }),
});

async function drive(collector, steps) {
  const { model } = scripted(steps);
  await generateText({
    model,
    tools: { submit_artifact: collector.tool, get_scores: otherTool() },
    prompt: "build the report",
    stopWhen: stepCountIs(steps.length + 1),
    onStepFinish: (step) => collector.observeStep(step),
  });
}

const structured = () => wire.createArtifactOutputCollector({ moneylineScope: clone(SCOPE) });

describe("moneyline collector mode", () => {
  it("offers the closed data schema under the same tool name; no html or title", () => {
    const schema = structured().tool.inputSchema.jsonSchema;
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties), ["games"]);
    assert.deepEqual(schema.required, ["games"]);
    const text = JSON.stringify(schema);
    for (const key of ["html", "title", "rationale", "fairProbability", "edge", "confidence", "tactics", "notes"]) {
      assert.ok(!text.includes(`"${key}"`), key);
    }
    assert.equal(wire.ARTIFACT_OUTPUT_TOOL_NAME, "submit_artifact");
  });

  it("without a scope the generic HTML collector is unchanged and refuses data", async () => {
    for (const collector of [wire.createArtifactOutputCollector(), wire.createArtifactOutputCollector({})]) {
      assert.deepEqual([...collector.tool.inputSchema.jsonSchema.required].sort(), ["html", "title"]);
      const out = await collector.tool.execute(clone(DATA), { toolCallId: "t", messages: [] });
      assert.deepEqual(out, { accepted: false, published: false, reasonCode: "invalid_artifact" });
    }
    const generic = wire.createArtifactOutputCollector();
    await drive(generic, [[artifactCall(LEGACY)]]);
    assert.equal(generic.finish()?.html, HTML);
  });

  it("renders SDK-dispatched data into the canonical artifact-v1, accepted by the unchanged wire", async () => {
    const collector = structured();
    await drive(collector, [[artifactCall(DATA)]]);
    assert.equal(collector.problem(), null);
    const artifact = collector.finish();
    assert.deepEqual(artifact, expected(DATA));
    assert.deepEqual(wire.parseArtifactOutput(clone(artifact)), artifact);
    assert.equal(wire.parseArtifactOutput(clone(DATA)), null, "the wire still refuses the data shape");
    const result = { contract: "artifact-turn-v1", nonce: NONCE, artifact: clone(artifact), reasonCode: null };
    assert.deepEqual(wire.parseArtifactTurnResult(result, TURN).artifact, artifact, "nonce-bound result");
  });

  it("raw HTML, extra narration, edge fields and invalid values are refused, and the refusal is sticky", async () => {
    const refused = {
      "legacy title/html": clone(LEGACY),
      "data plus html": { ...clone(DATA), html: HTML },
      "data plus title": { ...clone(DATA), title: "Edge report" },
      "rationale": { ...clone(DATA), rationale: "Celtics dominate the interior" },
      "game edge": { games: [{ ...clone(DATA.games[0]), edge: 0.04 }] },
      "outcome fairProbability": { games: [{ ...clone(DATA.games[1]), outcomes: [{ ...DATA.games[1].outcomes[0], fairProbability: 0.839 }, DATA.games[1].outcomes[1]] }] },
      "finished pick": { games: [{ ...clone(DATA.games[0]), status: "finished" }] },
      "coerced price": { games: [{ ...clone(DATA.games[1]), outcomes: [{ ...DATA.games[1].outcomes[0], price: "0.655" }, DATA.games[1].outcomes[1]] }] },
    };
    for (const [label, input] of Object.entries(refused)) {
      const collector = structured();
      await drive(collector, [[artifactCall(DATA)], [artifactCall(input)]]);
      assert.equal(collector.finish(), undefined, label);
      assert.equal(collector.problem(), "invalid_artifact", label);
      const again = await collector.tool.execute(clone(DATA), { toolCallId: "t", messages: [] });
      assert.deepEqual(again, { accepted: false, published: false, reasonCode: "collector_invalid" }, `${label}: sticky`);
    }
  });

  it("a truncated call the SDK refuses invalidates the turn", async () => {
    const collector = structured();
    await drive(collector, [[artifactCall('{"games":[{"event":"Lakers at')]]);
    assert.equal(collector.problem(), "invalid_artifact");
    assert.equal(collector.finish(), undefined);
  });

  it("identical data (any key order) is stable; different data conflicts and stays invalid", async () => {
    const collector = structured();
    await drive(collector, [[artifactCall(DATA)], [artifactCall(REORDERED)]]);
    assert.deepEqual(collector.finish(), expected(DATA));
    await drive(collector, [[artifactCall(OTHER_DATA)]]);
    assert.equal(collector.problem(), "conflicting_artifact");
    assert.equal(collector.finish(), undefined);
    const again = await collector.tool.execute(clone(DATA), { toolCallId: "t", messages: [] });
    assert.equal(again.reasonCode, "collector_invalid");
  });
});

// ---------------------------------------------------------------------------
// The engine: task-brief mode selection and verification
// ---------------------------------------------------------------------------

const HISTORY = [
  { role: "user", content: "Show me the Polymarket NBA board for tonight" },
  { role: "assistant", content: "Polymarket NBA tonight: Celtics 0.815, Knicks 0.655." },
];
const REQUEST = "Now turn that into a shareable report with the moneylines";
const SOURCE = JSON.stringify({
  venue: "polymarket",
  markets: [
    { event: "Lakers at Celtics", prices: { Celtics: 0.815, Lakers: 0.19 }, bookmaker: { Celtics: -521, Lakers: 396 } },
    { event: "Knicks at Heat", prices: { Knicks: 0.655, Heat: 0.35 }, bookmaker: { Knicks: -214, Heat: 178 } },
  ],
  records: { Celtics: "10-2", Lakers: "5-7" },
});
const SOURCE_TOOL = "polymarket_get_markets";
const marketsCall = () => toolCall(SOURCE_TOOL, "{}");

function jevRecorder(choose = () => "supported") {
  const bodies = [];
  let credentialReads = 0;
  const env = Object.defineProperty({}, "TYPESAFE_API_KEY", { get() { credentialReads++; return "synthetic-key"; } });
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
  return { bodies, reads: () => credentialReads, config: { provider: "jev", dataPolicy: "cloud_allowed", publicToolNames: [SOURCE_TOOL], transport, env } };
}

/** The real engine with task briefs on, two installed skills and one public market read returning SOURCE. */
function briefEngine(model, { taskBrief = true, checker = { provider: "generative" } } = {}) {
  const engine = new sportsclawEngine({
    provider: "anthropic", model: "fake-answer-model", thinkingBudget: 0, maxTurns: 6, taskBrief, evidenceVerifier: checker,
  });
  engine.mainModel = model;
  for (const sport of ["polymarket", "nba"]) {
    engine.registry.injectSchema({
      sport,
      tools: [{ name: `${sport}_get_${sport === "nba" ? "scores" : "markets"}`, command: "get", description: "Data", parameters: { type: "object", properties: {} } }],
    });
  }
  const offered = engine.buildTools.bind(engine);
  engine.buildTools = (...args) => ({
    ...offered(...args),
    [SOURCE_TOOL]: tool({ description: "Polymarket markets", inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => SOURCE }),
  });
  return engine;
}

async function runReport(engine, extra = {}) {
  const results = [];
  const text = await engine.run(REQUEST, {
    historyMode: "caller", history: clone(HISTORY), artifact: clone(TURN), onArtifactResult: (r) => results.push(clone(r)), ...extra,
  });
  return { text, results };
}

const WITHHELD = Object.freeze({ contract: "artifact-turn-v1", nonce: NONCE, artifact: null, reasonCode: "evidence_unverified" });
const isData = (schema) => Boolean(schema?.properties?.games) && !schema?.properties?.html;

describe("engine task-brief moneyline mode", () => {
  it("does not treat native American-odds venues as fraction-priced report mode", async () => {
    for (const venue of ["novig", "prophetx"]) {
      const { model, chat } = scripted([[artifactCall(LEGACY)], [say(FINAL)]], { brief: { ...BRIEF, venues: [venue] } });
      await runReport(briefEngine(model));
      assert.ok(offeredSchema(chat[0])?.properties?.html, venue);
    }
  });

  it("an opted-in first-turn generic report still uses the generic HTML contract", async () => {
    const { model, chat } = scripted([[artifactCall(LEGACY)], [say(FINAL)]], { brief: { ...BRIEF, market: "unspecified", venues: [] } });
    await runReport(briefEngine(model), { history: [] });
    assert.ok(offeredSchema(chat[0])?.properties?.html);
    assert.equal(isData(offeredSchema(chat[0])), false);
  });
  it("a first-turn explicit moneyline report cannot bypass the code-owned format", async () => {
    const { model, chat, all } = scripted([[marketsCall()], [artifactCall(DATA)], [say(FINAL)]]);
    const engine = briefEngine(model);
    const results = [];
    const text = await engine.run("Create a Polymarket NBA moneyline report with team records", {
      historyMode: "caller", history: [], artifact: clone(TURN), onArtifactResult: (r) => results.push(clone(r)),
    });
    assert.ok(all.some(isBriefCall));
    assert.ok(isData(offeredSchema(chat[0])));
    assert.equal(text, PREPARED);
    assert.equal(results[0].reasonCode, null);
  });
  it("a resolved single-venue moneyline report brief selects the data schema before primary generation", async () => {
    const { model, chat, all } = scripted([[marketsCall()], [artifactCall(DATA)], [say(FINAL)]]);
    const engine = briefEngine(model);
    const { results } = await runReport(engine);
    const briefAt = all.findIndex(isBriefCall);
    assert.ok(briefAt >= 0 && briefAt < all.indexOf(chat[0]), "brief resolved before the first main call");
    assert.ok(isData(offeredSchema(chat[0])), "data schema on the first main call");
    assert.doesNotMatch(JSON.stringify(chat[0].prompt), /build one self-contained HTML document/, "no HTML authoring instruction");
    const [result] = results;
    assert.equal(results.length, 1);
    assert.equal(result.reasonCode, null);
    assert.deepEqual(wire.parseArtifactTurnResult(clone(result), TURN), result, "canonical, nonce-bound");
    assert.match(result.artifact.title, /Moneyline report/);
    assert.match(result.artifact.title, /Polymarket/);
    assert.ok(result.artifact.html.includes("81.5c") && result.artifact.html.includes("80.6%"));
    const checks = checkerCalls(all);
    assert.equal(checks.length, 1, "the rendered document is still fact-checked");
    assert.ok(promptText(checks[0]).includes(result.artifact.html), "the check judged this exact document");
  });

  it("raw HTML in moneyline mode is invalid, never legacy compatibility", async () => {
    for (const input of [LEGACY, { ...clone(DATA), rationale: "Celtics control the paint" }]) {
      const { model } = scripted([[marketsCall()], [artifactCall(input)], [say(FINAL)]]);
      const { results } = await runReport(briefEngine(model));
      assert.deepEqual(results, [{ contract: "artifact-turn-v1", nonce: NONCE, artifact: null, reasonCode: "invalid_artifact" }]);
    }
  });

  it("identical resubmission in one run is stable; a different one conflicts", async () => {
    const same = scripted([[marketsCall()], [artifactCall(DATA)], [artifactCall(REORDERED)], [say(FINAL)]]);
    assert.equal((await runReport(briefEngine(same.model))).results[0].reasonCode, null);
    const diff = scripted([[marketsCall()], [artifactCall(DATA)], [artifactCall(OTHER_DATA)], [say(FINAL)]]);
    assert.deepEqual((await runReport(briefEngine(diff.model))).results,
      [{ contract: "artifact-turn-v1", nonce: NONCE, artifact: null, reasonCode: "conflicting_artifact" }]);
  });

  it("an accepted structured report gets neutral prepared-output text, not model edge prose", async () => {
    const { model } = scripted([[marketsCall()], [artifactCall(DATA)], [say("Celtics are a +EV edge at 81.5c.")]]);
    const { text, results } = await runReport(briefEngine(model));
    assert.equal(results[0].reasonCode, null);
    assert.equal(text, PREPARED);
  });

  for (const [label, options] of [
    ["task briefs off", { engine: { taskBrief: false } }],
    ["a spread brief", { brief: { ...BRIEF, market: "spread" } }],
    ["a two-venue brief", { brief: { ...BRIEF, venues: ["polymarket", "kalshi"] } }],
    ["a chat brief", { brief: { ...BRIEF, output: "chat" } }],
    ["an uncertain brief", { brief: { ...BRIEF, status: "uncertain" } }],
    ["an unparseable brief", { brief: "not json" }],
  ]) {
    it(`keeps the generic HTML path with ${label}`, async () => {
      const { model, chat } = scripted([[marketsCall()], [artifactCall(LEGACY)], [say(FINAL)]], { brief: options.brief ?? BRIEF });
      const { results } = await runReport(briefEngine(model, options.engine));
      assert.deepEqual([...offeredSchema(chat[0]).required].sort(), ["html", "title"]);
      assert.equal(results[0].artifact?.html, HTML);
    });
  }

  it("a client cannot select the mode", async () => {
    const { model } = scripted([]);
    const engine = briefEngine(model, { taskBrief: false });
    await assert.rejects(runReport(engine, { artifact: { ...TURN, moneylineScope: clone(SCOPE) } }), /invalid artifact turn input/);
    const { model: m, chat } = scripted([[artifactCall(LEGACY)], [say(FINAL)]]);
    await runReport(briefEngine(m, { taskBrief: false }), { moneylineScope: clone(SCOPE) });
    assert.ok(!isData(offeredSchema(chat[0])), "a run option does not switch the schema");
  });
});

describe("structured reports still need real source verification", () => {
  const MARKER = "81.5c";
  const flag = JSON.stringify({ isValid: false, discrepancies: [{ claim: MARKER, evidence: "source price differs", severity: "high", kind: "contradicted" }] });

  it("a schema-valid report contradicted by the source is withheld", async () => {
    const { model, all } = scripted([[marketsCall()], [artifactCall(DATA)], [say(FINAL)]], {
      verdict: (o) => (promptText(o).includes(MARKER) ? flag : VERDICT_OK),
    });
    const { results } = await runReport(briefEngine(model, { checker: { provider: "generative", generativeAction: "retain" } }));
    assert.ok(promptText(checkerCalls(all)[0]).includes(MARKER), "the check saw the rendered price");
    assert.deepEqual(results, [WITHHELD]);
  });

  it("a private value in a label refuses before any credential read or request", async () => {
    const jev = jevRecorder();
    const leaking = { games: [{ ...clone(DATA.games[1]), event: `Knicks at Heat ${NONCE}` }] };
    const { model } = scripted([[marketsCall()], [artifactCall(leaking)], [say(FINAL)]]);
    const engine = briefEngine(model, { checker: jev.config });
    const { results } = await runReport(engine);
    assert.equal(jev.bodies.length, 0);
    assert.equal(jev.reads(), 0);
    assert.deepEqual(results, [WITHHELD]);
    assert.equal(engine.evidenceReceipts[0]?.reasonCode, "private_content");
  });

  describe("structured correction", () => {
    const CORRECTED = { games: [{ ...clone(DATA.games[0]), outcomes: [{ ...DATA.games[0].outcomes[0], price: 0.8 }, DATA.games[0].outcomes[1]] }] };
    const FIXED_HTML = "<!doctype html><html><head><title>Fixed</title></head><body><p>Celtics 80.0c, strong edge.</p></body></html>";
    const correcting = { provider: "generative", generativeAction: "correct" };
    /** First check flags MARKER; the editor answers `editor`; any recheck passes. */
    const judge = (editor) => (o) => {
      if (phaseOf(o) === "editor") return editor;
      return promptText(o).includes(MARKER) ? flag : VERDICT_OK;
    };

    it("returns the same closed data, re-rendered by code and bound by the one recheck", async () => {
      const { model, all } = scripted([[marketsCall()], [artifactCall(DATA)], [say(FINAL)]], { verdict: judge(JSON.stringify(CORRECTED)) });
      const { text, results } = await runReport(briefEngine(model, { checker: correcting }));
      assert.equal(editorCalls(all).length, 1, "one correction");
      assert.doesNotMatch(promptText(editorCalls(all)[0]), /\b(complete|full)\b[^\n]*\bHTML\b[^\n]*\bdocument\b/i, "no HTML repair directive");
      const checks = checkerCalls(all);
      assert.equal(checks.length, 2, "one recheck");
      const [result] = results;
      assert.equal(result.reasonCode, null);
      assert.ok(result.artifact.html.includes("80.0c") && !result.artifact.html.includes(MARKER), "the corrected data, rendered by code");
      assert.match(result.artifact.title, /Moneyline report/);
      assert.ok(promptText(checks[1]).includes(result.artifact.html), "the recheck bound this exact new document");
      assert.equal(text, PREPARED);
    });

    for (const [label, editor] of [
      ["a complete HTML document", FIXED_HTML],
      ["a fenced HTML document", "```html\n" + FIXED_HTML + "\n```"],
      ["markdown prose", "## Report\n\nCeltics 80.0c, strong edge."],
      ["data with extra narration", JSON.stringify({ ...CORRECTED, rationale: "Celtics dominate the interior" })],
      ["data with html", JSON.stringify({ ...CORRECTED, html: FIXED_HTML })],
      ["malformed data", '{"games":[{"event":"Lakers at'],
      ["an empty correction", ""],
    ]) {
      it(`never publishes or leaks ${label}`, async () => {
        const { model, all } = scripted([[marketsCall()], [artifactCall(DATA)], [say(FINAL)]], { verdict: judge(editor) });
        const { text, results } = await runReport(briefEngine(model, { checker: correcting }));
        assert.equal(editorCalls(all).length, 1, "still one correction");
        assert.ok(checkerCalls(all).length <= 2, "at most one recheck");
        assert.deepEqual(results, [WITHHELD]);
        assert.doesNotMatch(text, /<!doctype|<html\b|<body\b|"games"\s*:/i, "no raw HTML or data in chat");
        assert.ok(!text.includes("strong edge") && !text.includes("interior"));
      });
    }
  });
});
