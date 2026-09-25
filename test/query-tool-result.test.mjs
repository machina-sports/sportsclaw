// #176: an oversized JSON data-tool result is kept whole for the turn and the
// model gets an overview plus query_tool_result, instead of a blind head slice.
import assert from "node:assert/strict";
import test from "node:test";
import { MockLanguageModelV3 } from "ai/test";

import {
  REPEATED_CALL_NOTE,
  TOOL_OUTPUT_CHAR_CAP,
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
