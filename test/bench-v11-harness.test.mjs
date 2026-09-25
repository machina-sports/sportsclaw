// Sports Agent Bench v1.1 (gemini-3.8-flash): SportsClaw's misses were mostly
// hand-counting over many small results (10 vs 9, 21 vs 20); both arms hit
// "competitors.team.name is not a column" and "path is not an array"; a bare
// loop ended 18 cases at the turn limit with no answer; and 4 misses went
// through a correction nobody could inspect afterwards.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { MockLanguageModelV3 } from "ai/test";

import { queryToolResult, ToolResultStore } from "../dist/tool-results.js";
import { sportsclawEngine, wrapUpStep } from "../dist/engine.js";
import { buildRunManifest } from "../dist/run-manifest.js";

const box = (team, yards, players) => ({ team, stats: { rushing_yards: yards }, players });
const store = () => {
  const s = new ToolResultStore(100);
  const a = s.put("cfb_get_game_summary", { data: { players: [{ name: "K. Black", yds: 120 }, { name: "R. Hammond", yds: 40 }] } }, 10);
  const b = s.put("cfb_get_game_summary", { data: { players: [{ name: "K. Black", yds: 121 }, { name: "R. Hammond", yds: 162 }] } }, 10);
  return { s, a, b };
};

test("result_ids combines the same path across results; rows carry _result_id", () => {
  const { s, a, b } = store();
  const out = JSON.parse(queryToolResult(s, { result_ids: [a, b], path: "data.players", aggregate: { op: "sum", field: "yds", group_by: "name" } }));
  assert.deepEqual(out.groups.map((g) => [g.name, g.value]), [["K. Black", 241], ["R. Hammond", 202]]);
  const rows = JSON.parse(queryToolResult(s, { result_ids: [a, b], path: "data.players", fields: ["_result_id", "yds"], sort_by: "yds" })).rows;
  assert.deepEqual(rows[0], { _result_id: b, yds: 162 });
  assert.throws(() => queryToolResult(s, { result_ids: [a, "r99"] }), /Unknown result_id "r99"/);
});

test("dotted fields read through nested lists: any element matches, sums and group keys use every value", () => {
  const s = new ToolResultStore();
  const events = [
    { id: 1, competitors: [{ team: { abbreviation: "BUF" }, score: "31" }, { team: { abbreviation: "MIA" }, score: "10" }] },
    { id: 2, competitors: [{ team: { abbreviation: "NYJ" }, score: "20" }, { team: { abbreviation: "NE" }, score: "17" }] },
  ];
  const id = s.put("nfl_get_scoreboard", { events }, 10);
  const q = (query) => JSON.parse(queryToolResult(s, { result_id: id, ...query }));
  assert.deepEqual(q({ where: [{ field: "competitors.team.abbreviation", op: "eq", value: "MIA" }], fields: ["id"] }).rows, [{ id: 1 }]);
  assert.deepEqual(q({ where: [{ field: "competitors.team.abbreviation", op: "ne", value: "MIA" }], fields: ["id"] }).rows, [{ id: 2 }]);
  assert.equal(q({ aggregate: { op: "sum", field: "competitors.score" } }).aggregate.value, 78);
  assert.deepEqual(q({ fields: ["competitors.team.abbreviation"], limit: 1 }).rows[0], { "competitors.team.abbreviation": ["BUF", "MIA"] });
});

test("a path to an object returns the object (e.g. a summary's game_info)", () => {
  const s = new ToolResultStore();
  const id = s.put("cricket_get_game_summary", { data: { game_info: { venue: { fullName: "Narendra Modi Stadium", capacity: 132000 } }, notes: [{ t: 1 }] } }, 10);
  assert.equal(JSON.parse(queryToolResult(s, { result_id: id, path: "data.game_info.venue" })).value.capacity, 132000);
  assert.throws(() => queryToolResult(s, { result_id: id, path: "data.nope" }), /not found/);
});

test("wrapUpStep: a note two steps before the limit, tools off on the last step, nothing before", () => {
  assert.equal(wrapUpStep(0, 25, "S"), undefined);
  assert.equal(wrapUpStep(22, 25, "S"), undefined);
  const near = wrapUpStep(23, 25, "S");
  assert.match(near.system, /^S\n\n## Turn limit\n\nYou have one tool step left/);
  assert.equal(near.toolChoice, undefined);
  const last = wrapUpStep(24, 25, "S");
  assert.equal(last.toolChoice, "none");
  assert.match(last.system, /last step and tools are off: answer now/);
  assert.equal(wrapUpStep(2, 3, "S"), undefined, "tiny budgets are left alone");
});

test("the main loop passes prepareStep with wrapUpStep (source check)", () => {
  const source = readFileSync(new URL("../dist/engine.js", import.meta.url), "utf8");
  assert.match(source, /prepareStep: \(\{ stepNumber \}\) => wrapUpStep\(stepNumber, this\.config\.maxTurns, mainSystem\)/);
});

function verifier(replies) {
  const model = new MockLanguageModelV3({ doGenerate: async () => ({
    content: [{ type: "text", text: replies.shift() ?? '{"isValid":true,"discrepancies":[]}' }],
    finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [],
  }) });
  const engine = Object.create(sportsclawEngine.prototype);
  engine.mainModel = model;
  engine.config = { verbose: false };
  engine._lastRunTrace = { offeredTools: [], toolSurfaceSha256: "x", providerWarnings: [], parallelAgents: false };
  return engine;
}
const input = { userPrompt: "q", draft: "Canada scored 10.\n\nFINAL: 10", toolOutputs: [{ toolName: "t", output: "{}", truncated: false }] };
const bad = JSON.stringify({ isValid: false, discrepancies: [{ claim: "10", evidence: "9", severity: "high", kind: "contradicted" }] });

test("the run trace records what the fact-check did, with the draft before a correction", async () => {
  let e = verifier([]);
  await e.verifyWithTrace(input);
  assert.deepEqual(e._lastRunTrace.verification, { outcome: "kept" });

  e = verifier([bad, "Canada scored 9.\n\nFINAL: 9", '{"isValid":true,"discrepancies":[]}']);
  assert.match(await e.verifyWithTrace(input), /FINAL: 9/);
  assert.deepEqual(e._lastRunTrace.verification, { outcome: "corrected", draftBeforeCorrection: input.draft });

  e = verifier([bad, "still 10", bad]);
  await e.verifyWithTrace(input);
  assert.equal(e._lastRunTrace.verification.outcome, "withheld");
  assert.equal(e._lastRunTrace.verification.draftBeforeCorrection, input.draft);

  e = verifier(["nope", "nope"]);
  await e.verifyWithTrace(input);
  assert.deepEqual(e._lastRunTrace.verification, { outcome: "unverified" });
});

test("the manifest reports verification in run and keeps it out of config_sha256", () => {
  const base = { sportsclawVersion: "t", sportsSkillsVersion: null, provider: "google", model: "m", sampling: {}, maxOutputTokens: 1, maxTurns: 1, thinkingBudget: 0, replayMode: "off", toolAllowlist: null, endpointHost: null };
  const trace = { offeredTools: [], toolSurfaceSha256: "x", providerWarnings: [], parallelAgents: false };
  const withV = buildRunManifest({ ...base, trace: { ...trace, verification: { outcome: "corrected", draftBeforeCorrection: "d" } } });
  assert.deepEqual(withV.run.verification, { outcome: "corrected", draft_before_correction: "d" });
  assert.equal(buildRunManifest({ ...base, trace }).run.verification, null);
  assert.equal(withV.config_sha256, buildRunManifest({ ...base, trace }).config_sha256);
});
