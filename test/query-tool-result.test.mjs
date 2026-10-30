// #176: an oversized JSON data-tool result is kept whole for the turn and the
// model gets an overview plus query_tool_result, instead of a blind head slice.
import assert from "node:assert/strict";
import test from "node:test";
import { MockLanguageModelV3 } from "ai/test";

import {
  REPEATED_CALL_NOTE,
  TOOL_OUTPUT_CHAR_CAP,
  draftClaimTerms,
  isTruncatedEvidence,
  sportsclawEngine,
  summarizeToolOutputForEvidence,
} from "../dist/engine.js";
import { DEFAULT_CONFIG } from "../dist/types.js";

globalThis.AI_SDK_LOG_WARNINGS = false;

const NAMES = ["Matthew Stafford", "Dak Prescott", "Jalen Hurts", "Josh Allen", "Joe Burrow", "Jared Goff"];
/** ~100k chars of week player stats; Stafford (389) leads, then 361, 350, 340, 330. */
function bigStats() {
  const top = [389, 361, 350, 340, 330];
  const players = Array.from({ length: 400 }, (_, i) => ({
    player_display_name: i < NAMES.length ? NAMES[i] : `Player ${i}`,
    position: i % 3 === 0 ? "QB" : "WR",
    week: 5,
    passing_yards: i < top.length ? top[i] : (i * 7) % 300,
    notes: "n".repeat(150),
  }));
  // Shuffle deterministically so the head of the array is not the answer.
  players.push(...players.splice(0, 5));
  return JSON.stringify({ status: true, data: { season: 2025, week: 5, players } });
}

function engineWithRegistry(respond, specs = [{ name: "nfl_get_stats" }]) {
  const dispatched = [];
  const engine = Object.create(sportsclawEngine.prototype);
  engine.config = { ...DEFAULT_CONFIG, yoloMode: true, verbose: false, thinkingBudget: 0, sampling: { temperature: 0 } };
  engine.messages = [];
  engine.registry = {
    getInstalledSkills: () => ["nfl"],
    getAllToolSpecs: () => specs.map((s) => ({ description: s.name, input_schema: { type: "object", properties: {} }, ...s })),
    getSkillName: (n) => (n.includes("_") && n !== "query_tool_result" ? n.split("_")[0] : undefined),
    dispatchToolCall: async (name, args) => {
      dispatched.push({ name, args });
      return respond(name, args);
    },
  };
  engine.mcpManager = { serverCount: 0, getToolSpecs: () => [], getMachinaLoopServer: () => undefined };
  engine.initAsync = async () => {};
  return { engine, dispatched };
}

const opts = { toolCallId: "c", messages: [] };
const turnTools = (engine) => engine.buildTools(undefined, new Map(), undefined, undefined, undefined, new Map());

test("an oversized JSON result returns an overview (marker, result id, columns) instead of a head slice", async () => {
  const content = bigStats();
  assert.ok(content.length > 90_000);
  const { engine } = engineWithRegistry(() => ({ isError: false, content }));
  const tools = turnTools(engine);
  const out = await tools.nfl_get_stats.execute({ week: 5 }, opts);
  assert.ok(out.length < TOOL_OUTPUT_CHAR_CAP, "the overview fits the cap");
  assert.ok(out.startsWith("[... output truncated"), "stable marker first");
  assert.match(out, /result_id "r1"/);
  assert.match(out, /query_tool_result/);
  const overview = JSON.parse(out.slice(out.indexOf("\n") + 1));
  assert.equal(overview.result_id, "r1");
  assert.equal(overview.total_chars, content.length);
  assert.deepEqual(overview.arrays[0], {
    path: "data.players",
    rows: 400,
    columns: ["player_display_name", "position", "week", "passing_yards", "notes"],
  });
  assert.equal(overview.preview.first_rows.length, 5);
});

test("query_tool_result returns the right top-5 rows of the stored result", async () => {
  const { engine } = engineWithRegistry(() => ({ isError: false, content: bigStats() }));
  const tools = turnTools(engine);
  await tools.nfl_get_stats.execute({ week: 5 }, opts);
  const out = JSON.parse(await tools.query_tool_result.execute({
    result_id: "r1",
    sort_by: "passing_yards",
    limit: 5,
    fields: ["player_display_name", "passing_yards"],
  }, opts));
  assert.equal(out.total_rows, 400);
  assert.deepEqual(out.rows, [
    { player_display_name: "Matthew Stafford", passing_yards: 389 },
    { player_display_name: "Dak Prescott", passing_yards: 361 },
    { player_display_name: "Jalen Hurts", passing_yards: 350 },
    { player_display_name: "Josh Allen", passing_yards: 340 },
    { player_display_name: "Joe Burrow", passing_yards: 330 },
  ]);
  await assert.rejects(tools.query_tool_result.execute({ result_id: "r2" }, opts), /only within the current turn/);
});

test("stored results are per turn: a new buildTools() does not see the previous turn's ids", async () => {
  const { engine } = engineWithRegistry(() => ({ isError: false, content: bigStats() }));
  await turnTools(engine).nfl_get_stats.execute({}, opts);
  await assert.rejects(turnTools(engine).query_tool_result.execute({ result_id: "r1" }, opts), /Unknown result_id/);
});

test("a repeated oversized call is served the same overview, and its id still resolves", async () => {
  const { engine, dispatched } = engineWithRegistry(() => ({ isError: false, content: bigStats() }));
  const tools = turnTools(engine);
  const first = await tools.nfl_get_stats.execute({ week: 5 }, opts);
  const again = await tools.nfl_get_stats.execute({ week: 5 }, opts);
  assert.equal(again, REPEATED_CALL_NOTE + first);
  assert.equal(dispatched.length, 1);
  const out = JSON.parse(await tools.query_tool_result.execute({ result_id: "r1", aggregate: { op: "count" } }, opts));
  assert.equal(out.aggregate.value, 400);
});

test("small outputs keep their content byte-for-byte; ones with rows get a queryable result_id footer", async () => {
  const small = '{"data": {"players": [ {"a": 1} ]},\n "x": "é"}';
  const { engine } = engineWithRegistry(() => ({ isError: false, content: small }));
  const tools = turnTools(engine);
  const out = await tools.nfl_get_stats.execute({}, opts);
  assert.ok(out.startsWith(small + "\n[result_id \"r1\": query_tool_result can filter"), out);
  const q = JSON.parse(await tools.query_tool_result.execute({ result_id: "r1", aggregate: { op: "sum", field: "a" } }, opts));
  assert.equal(q.aggregate.value, 1);
  for (const noRows of ['{"x": 1}', "plain text"]) {
    const { engine: e } = engineWithRegistry(() => ({ isError: false, content: noRows }));
    assert.equal(await turnTools(e).nfl_get_stats.execute({}, opts), noRows);
  }
});

test("oversized non-JSON, or JSON without rows, keeps the head-slice behaviour", async () => {
  for (const content of ["x".repeat(TOOL_OUTPUT_CHAR_CAP + 10), JSON.stringify({ blob: "y".repeat(TOOL_OUTPUT_CHAR_CAP) })]) {
    const { engine } = engineWithRegistry(() => ({ isError: false, content }));
    const out = await turnTools(engine).nfl_get_stats.execute({}, opts);
    assert.equal(out.slice(0, TOOL_OUTPUT_CHAR_CAP), content.slice(0, TOOL_OUTPUT_CHAR_CAP));
    assert.match(out, /\[\.\.\. output truncated: showing 30,000 of .* Re-query with more specific filters/);
  }
});

test("the evidence verifier still flags the overview as partial evidence", async () => {
  const { engine } = engineWithRegistry(() => ({ isError: false, content: bigStats() }));
  const out = await turnTools(engine).nfl_get_stats.execute({}, opts);
  assert.equal(isTruncatedEvidence(out), true);
  assert.equal(isTruncatedEvidence(summarizeToolOutputForEvidence(out)), true);
});

test("query_tool_result is a data tool whenever a registry tool exists, and absent otherwise", () => {
  const { engine } = engineWithRegistry(() => ({ isError: false, content: "{}" }), [{ name: "nfl_get_stats" }, { name: "nba_get_scores" }]);
  assert.ok("query_tool_result" in turnTools(engine));
  assert.deepEqual(engine.listDataToolNames(), ["nba_get_scores", "nfl_get_stats", "query_tool_result"]);
  assert.deepEqual(engine.dataToolNamesForSkills(["nfl"]), ["nfl_get_stats", "query_tool_result"]);
  assert.deepEqual(engine.dataToolNamesForSkills(["mlb"]), [], "no data tools, no query tool");

  const { engine: empty } = engineWithRegistry(() => ({ isError: false, content: "{}" }), []);
  assert.equal("query_tool_result" in turnTools(empty), false);
  assert.deepEqual(empty.listDataToolNames(), []);
});

// Synthetic rows in the normalized prediction-market shape. The overview is the
// only view the narrator, the checker and synthesis get of an oversized result.
const RULES = "Synthetic resolution rules. ".repeat(40);
const market = (i, extra = {}) => ({
  id: `m${i}`, question: `Synthetic Team ${i} to win?`, description: RULES, slug: `synthetic-team-${i}`, condition_id: `0xsynthetic${i}`,
  outcomes: [{ name: `Synthetic Team ${i}`, price: 0.6, clob_token_id: `tok-${i}-a` }, { name: `Synthetic Rival ${i}`, price: 0.4, clob_token_id: `tok-${i}-b` }],
  status: "active", sports_market_type: "moneyline", game_start_time: "2026-10-31T23:30:00Z",
  accepting_orders: true, enable_order_book: true, volume: 1000 + i, liquidity: 250 + i, ...extra,
});
const HOME_AWAY = market(0, { question: "Synthetic Home vs Synthetic Away: winner?",
  outcomes: [{ name: "Synthetic Home", price: 0.55, clob_token_id: "tok-h" }, { name: "Synthetic Away", price: 0.45, clob_token_id: "tok-a" }] });
const DRAW_FIELD = market(1, { outcomes: [{ name: "Synthetic Draw", price: null, clob_token_id: "tok-d" }, { name: "Synthetic Field", clob_token_id: "tok-f" }] });
const marketDetail = () => JSON.stringify({ status: true, data: { event: { id: "e1", title: "Synthetic night" },
  markets: [HOME_AWAY, DRAW_FIELD, ...Array.from({ length: 407 }, (_, i) => market(i + 2))] } });
const eventList = () => JSON.stringify({ status: true, data: { count: 50, events: Array.from({ length: 50 }, (_, e) => ({
  id: `e${e}`, title: `Synthetic Event ${e}`, slug: `synthetic-event-${e}`, status: "active", start_date: "2026-10-31",
  markets: e === 0 ? [HOME_AWAY, ...Array.from({ length: 8 }, (_, k) => market(k + 10))] : Array.from({ length: 9 }, (_, k) => market(e * 9 + k)),
})) } });
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The literal pair as compact JSON: `"name":"Synthetic Home","price":0.55`. */
const pair = (name, price) => new RegExp(`"name":${esc(JSON.stringify(name))},"price":${esc(JSON.stringify(price))}`);
const MARKET_TOOL = [{ name: "polymarket_get_market" }];
const DRAFT = "Polymarket: Synthetic Home 0.55, Synthetic Away 0.45.";

/** The narrator's tool output and the checker's and synthesis's views of it, through the real paths. */
async function marketViews(content, engineSetup = () => {}) {
  const { engine } = engineWithRegistry(() => ({ isError: false, content }), MARKET_TOOL);
  engineSetup(engine);
  const tools = turnTools(engine);
  const narrator = await tools.polymarket_get_market.execute({}, opts);
  const steps = [{ toolResults: [{ toolCallId: "c1", toolName: "polymarket_get_market", output: narrator }] }];
  // 8_000 is the engine's VERIFICATION_EVIDENCE_CHARS; synthesis uses the default budget.
  const [checker] = engine.collectToolOutputSnippets(steps, new Set(["c1"]), 8_000, draftClaimTerms(DRAFT), new Map(), true);
  const [synthesis] = engine.collectToolOutputSnippets(steps, new Set(["c1"]));
  return { engine, tools, narrator, views: { narrator, checker: checker.output, synthesis: synthesis.output } };
}

test("an oversized market detail overview carries the same literal outcome pairs to the narrator, checker and synthesis", async () => {
  const { tools, narrator, views } = await marketViews(marketDetail());
  assert.ok(narrator.length < TOOL_OUTPUT_CHAR_CAP);
  assert.equal(isTruncatedEvidence(narrator), true, "still a partial view, never complete coverage");
  for (const [label, text] of Object.entries(views)) {
    assert.match(text, pair("Synthetic Home", 0.55), label);
    assert.match(text, pair("Synthetic Away", 0.45), label);
    assert.doesNotMatch(text, /"outcomes":"array\(2\)"/, label);
  }
  for (const label of ["narrator", "checker"]) {
    assert.match(views[label], pair("Synthetic Draw", null), `${label}: null stays null`);
    assert.match(views[label], /"name":"Synthetic Field"/, label);
    assert.doesNotMatch(views[label], /"name":"Synthetic Field","price"/, `${label}: a missing price is not invented`);
  }
  // The stored original is unchanged and still read losslessly.
  const read = JSON.parse(await tools.query_tool_result.execute({ result_id: "r1", path: "data.markets",
    where: [{ field: "id", op: "eq", value: "m1" }], fields: ["outcomes"] }, opts));
  assert.deepEqual(read.rows, [{ outcomes: DRAW_FIELD.outcomes }]);
});

test("an oversized event list overview carries a bounded nested market preview to every view", async () => {
  const content = eventList();
  const { narrator, views } = await marketViews(content);
  assert.ok(narrator.length < TOOL_OUTPUT_CHAR_CAP);
  assert.equal(isTruncatedEvidence(narrator), true);
  assert.ok(!narrator.includes("Synthetic Event 49"), "rows beyond the preview are not shown");
  for (const [label, text] of Object.entries(views)) {
    assert.ok(text.includes(HOME_AWAY.question), `${label}: the nested market is identified`);
    assert.match(text, pair("Synthetic Home", 0.55), label);
    assert.match(text, pair("Synthetic Away", 0.45), label);
  }
});

test("public-data mode gets the same market preview and still refuses an unauthorized reader", async () => {
  const { tools, views } = await marketViews(marketDetail(), (engine) => {
    engine.config.routing = { provider: "jev", dataPolicy: "cloud_allowed", publicDataTools: ["polymarket_get_market"], env: {} };
  });
  assert.match(views.narrator, pair("Synthetic Home", 0.55));
  await assert.rejects(tools.query_tool_result.execute({ result_id: "r1" }, opts), /not available for this call/);
});

test("runDirect (bench baseline arms) offers query_tool_result with the skills' tools and it answers from the stored result", async () => {
  const { engine } = engineWithRegistry(() => ({ isError: false, content: bigStats() }), [{ name: "nfl_get_stats" }, { name: "nba_get_scores" }]);
  const toolResults = [];
  let step = 0;
  const reply = (content) => ({
    content,
    finishReason: { unified: content[0].type === "tool-call" ? "tool-calls" : "stop", raw: "stop" },
    usage: { inputTokens: { total: 1, noCache: 1 }, outputTokens: { total: 1, text: 1 } },
    warnings: [],
  });
  const model = new MockLanguageModelV3({
    doGenerate: async ({ prompt, tools }) => {
      for (const m of prompt) if (m.role === "tool") for (const p of m.content) toolResults.push(p);
      step += 1;
      if (step === 1) {
        assert.deepEqual(tools.map((t) => t.name).sort(), ["nfl_get_stats", "query_tool_result"]);
        return reply([{ type: "tool-call", toolCallId: "t1", toolName: "nfl_get_stats", input: "{}" }]);
      }
      if (step === 2) {
        return reply([{ type: "tool-call", toolCallId: "t2", toolName: "query_tool_result",
          input: JSON.stringify({ result_id: "r1", sort_by: "passing_yards", limit: 1, fields: ["player_display_name", "passing_yards"] }) }]);
      }
      return reply([{ type: "text", text: "FINAL: Matthew Stafford" }]);
    },
  });
  engine.mainModel = model;
  engine.mainModelId = "mock";
  const answer = await engine.runDirect("Most passing yards in week 5?", { skills: ["nfl"] });
  assert.equal(answer, "FINAL: Matthew Stafford");
  assert.deepEqual(engine.lastRunTrace.offeredTools, ["nfl_get_stats", "query_tool_result"]);
  const queried = toolResults.find((p) => p.toolCallId === "t2");
  assert.ok(queried, "the query result reached the model");
  assert.match(JSON.stringify(queried.output), /Matthew Stafford.*389/);
});
