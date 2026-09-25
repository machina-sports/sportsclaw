// #176: pure functions behind query_tool_result — shape detection, the
// overview, where/sort/limit/fields/aggregate, errors, and store eviction.
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResultOverview,
  findArrays,
  hasQueryableRows,
  queryToolResult,
  TOOL_OUTPUT_TRUNCATED_MARKER,
  ToolResultQueryError,
  ToolResultStore,
} from "../dist/tool-results.js";

const players = [
  { name: "Matthew Stafford", team: "LAR", position: "QB", passing_yards: 389, week: 5 },
  { name: "Dak Prescott", team: "DAL", position: "QB", passing_yards: "361", week: 5 },
  { name: "Saquon Barkley", team: "PHI", position: "RB", passing_yards: 0, week: 5 },
  { name: "Jalen Hurts", team: "PHI", position: "QB", passing_yards: 280, week: 5 },
  { name: "Unknown Guy", team: "PHI", position: "WR", week: 5 },
  { name: "Josh Allen", team: "BUF", position: "QB", passing_yards: 253.0, week: 5 },
];
const doc = { status: true, message: "ok", data: { season: 2025, meta: [{ a: 1 }], players } };

function storeWith(value) {
  const store = new ToolResultStore();
  const id = store.put("nfl_get_player_stats", value, JSON.stringify(value).length);
  return { store, id };
}
const q = (value, query) => {
  const { store, id } = storeWith(value);
  return JSON.parse(queryToolResult(store, { result_id: id, ...query }));
};

test("findArrays lists every array with rows and columns, largest first", () => {
  const arrays = findArrays(doc);
  assert.deepEqual(arrays.map((a) => [a.path, a.rows]), [["data.players", 6], ["data.meta", 1]]);
  assert.deepEqual(arrays[0].columns, ["name", "team", "position", "passing_yards", "week"]);
  assert.deepEqual(findArrays([1, 2, 3]), [{ path: "", rows: 3, columns: [] }]);
});

test("findArrays walks small container arrays but treats long arrays as row sets", () => {
  const nested = { seasonTypes: [{ events: Array.from({ length: 12 }, (_, i) => ({ id: i, legs: [1, 2] })) }] };
  const paths = findArrays(nested).map((a) => a.path);
  assert.deepEqual(paths, ["seasonTypes.0.events", "seasonTypes"]);
});

test("columns list one level of nested object keys as dotted names", () => {
  const rows = [{ name: "a", stats: { passing_yards: 1, tds: 0 } }, { name: "b", stats: { passing_yards: 2, ints: 1 } }];
  assert.deepEqual(findArrays(rows)[0].columns, ["name", "stats", "stats.passing_yards", "stats.tds", "stats.ints"]);
  const { store, id } = storeWith(rows);
  assert.throws(() => queryToolResult(store, { result_id: id, sort_by: "yards" }), /Columns: name, stats, stats\.passing_yards/);
});

test("hasQueryableRows is false without a non-empty array", () => {
  assert.equal(hasQueryableRows({ a: 1, b: { c: [] } }), false);
  assert.equal(hasQueryableRows(doc), true);
});

test("the overview has the id, size, arrays with columns and the first rows of the largest array", () => {
  const overview = JSON.parse(buildResultOverview("r7", doc, 123_456));
  assert.equal(overview.result_id, "r7");
  assert.equal(overview.total_chars, 123_456);
  assert.deepEqual(overview.top_level, { status: true, message: "ok", data: "object(3 keys)" });
  assert.equal(overview.arrays[0].path, "data.players");
  assert.equal(overview.arrays[0].rows, 6);
  assert.ok(overview.arrays[0].columns.includes("passing_yards"));
  assert.equal(overview.preview.path, "data.players");
  assert.equal(overview.preview.first_rows.length, 5);
  assert.equal(overview.preview.first_rows[0].name, "Matthew Stafford");
  assert.equal(buildResultOverview("r1", { a: 1 }, 10), undefined);
});

test("the overview caps wide rows and long column lists", () => {
  const wide = Array.from({ length: 3 }, (_, r) => Object.fromEntries(Array.from({ length: 300 }, (_, c) => [`c${c}`, r * c])));
  const overview = JSON.parse(buildResultOverview("r1", wide, 1));
  assert.equal(overview.arrays[0].path, "$");
  assert.equal(overview.arrays[0].columns.length, 150);
  assert.equal(overview.arrays[0].more_columns, 150);
  assert.equal(Object.keys(overview.preview.first_rows[0]).length, 26);
  assert.equal(overview.preview.first_rows[0]["…"], "275 more fields");
});

test("default path is the largest array; sort is numeric-aware and descending by default", () => {
  const out = q(doc, { sort_by: "passing_yards", limit: 3, fields: ["name", "passing_yards"] });
  assert.equal(out.path, "data.players");
  assert.equal(out.total_rows, 6);
  assert.deepEqual(out.rows, [
    { name: "Matthew Stafford", passing_yards: 389 },
    { name: "Dak Prescott", passing_yards: "361" },
    { name: "Jalen Hurts", passing_yards: 280 },
  ]);
});

test("missing values sort last in either direction", () => {
  const asc = q(doc, { sort_by: "passing_yards", descending: false, fields: ["name"] });
  assert.equal(asc.rows[0].name, "Saquon Barkley");
  assert.equal(asc.rows.at(-1).name, "Unknown Guy");
  const desc = q(doc, { sort_by: "passing_yards", fields: ["name"] });
  assert.equal(desc.rows.at(-1).name, "Unknown Guy");
});

test("where supports every op, case-insensitive text and numeric strings", () => {
  const names = (where) => q(doc, { where, fields: ["name"] }).rows.map((r) => r.name);
  assert.deepEqual(names([{ field: "position", op: "eq", value: "qb" }]), ["Matthew Stafford", "Dak Prescott", "Jalen Hurts", "Josh Allen"]);
  assert.deepEqual(names([{ field: "passing_yards", op: "gt", value: 300 }]), ["Matthew Stafford", "Dak Prescott"]);
  assert.deepEqual(names([{ field: "passing_yards", op: "gte", value: "361" }]), ["Matthew Stafford", "Dak Prescott"]);
  assert.deepEqual(names([{ field: "passing_yards", op: "lt", value: 253 }]), ["Saquon Barkley"]);
  assert.deepEqual(names([{ field: "passing_yards", op: "lte", value: 253 }]), ["Saquon Barkley", "Josh Allen"]);
  assert.deepEqual(names([{ field: "team", op: "ne", value: "PHI" }]), ["Matthew Stafford", "Dak Prescott", "Josh Allen"]);
  assert.deepEqual(names([{ field: "name", op: "contains", value: "allen" }]), ["Josh Allen"]);
  assert.deepEqual(names([{ field: "team", op: "in", value: ["LAR", "buf"] }]), ["Matthew Stafford", "Josh Allen"]);
  assert.deepEqual(
    names([{ field: "team", op: "eq", value: "PHI" }, { field: "position", op: "eq", value: "QB" }]),
    ["Jalen Hurts"],
  );
  assert.equal(q(doc, { where: [{ field: "passing_yards", op: "gt", value: 0 }] }).matched_rows, 4, "missing never matches gt");
});

test("dotted fields read nested values; explicit paths and array indexes resolve", () => {
  const nested = { groups: [{ rows: [{ p: { n: "a", y: 3 } }, { p: { n: "b", y: 9 } }] }] };
  const out = q(nested, { path: "groups.0.rows", sort_by: "p.y", fields: ["p.n"] });
  assert.deepEqual(out.rows, [{ "p.n": "b" }, { "p.n": "a" }]);
  assert.equal(q(doc, { path: "$.data.meta" }).total_rows, 1);
});

test("limit defaults to 20, is clamped to 1..200", () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ i }));
  assert.equal(q(many, {}).returned_rows, 20);
  assert.equal(q(many, { limit: 1000 }).returned_rows, 200);
  assert.equal(q(many, { limit: 0 }).returned_rows, 1);
  assert.equal(q(many, { limit: "5" }).returned_rows, 5);
});

test("aggregate count/sum/mean/min/max, with and without group_by", () => {
  assert.deepEqual(q(doc, { aggregate: { op: "count" } }).aggregate, { op: "count", value: 6, n: 6 });
  assert.deepEqual(q(doc, { aggregate: { op: "sum", field: "passing_yards" } }).aggregate,
    { op: "sum", field: "passing_yards", value: 1283, n: 5 });
  assert.equal(q(doc, { aggregate: { op: "mean", field: "passing_yards" } }).aggregate.value, 1283 / 5);
  assert.equal(q(doc, { aggregate: { op: "min", field: "passing_yards" } }).aggregate.value, 0);
  assert.equal(q(doc, { aggregate: { op: "max", field: "passing_yards" } }).aggregate.value, 389);
  const qbs = q(doc, { where: [{ field: "position", op: "eq", value: "QB" }], aggregate: { op: "count" } });
  assert.equal(qbs.aggregate.value, 4);

  const byTeam = q(doc, { aggregate: { op: "sum", field: "passing_yards", group_by: "team" } });
  assert.equal(byTeam.total_groups, 4);
  assert.deepEqual(byTeam.groups.map((g) => [g.team, g.value]), [["LAR", 389], ["DAL", 361], ["PHI", 280], ["BUF", 253]]);
  const asc = q(doc, { aggregate: { op: "count", group_by: "team" }, descending: false, limit: 1 });
  assert.equal(asc.groups.length, 1);
  assert.equal(asc.groups[0].value, 1);
});

test("a large max/min does not overflow the stack", () => {
  const big = Array.from({ length: 300_000 }, (_, i) => ({ v: i }));
  assert.equal(q(big, { aggregate: { op: "max", field: "v" } }).aggregate.value, 299_999);
});

test("errors name the problem and list valid paths/columns", () => {
  const { store, id } = storeWith(doc);
  const err = (query, re) => assert.throws(() => queryToolResult(store, { result_id: id, ...query }), (e) => {
    assert.ok(e instanceof ToolResultQueryError);
    assert.match(e.message, re);
    return true;
  });
  err({ path: "data.nope" }, /not found\. Valid array paths: data\.players \(6 rows\), data\.meta \(1 rows\)/);
  assert.deepEqual(JSON.parse(queryToolResult(store, { result_id: id, path: "data.meta.0" })).value, doc.data.meta[0],
    "a path to an object returns the object");
  err({ sort_by: "yards" }, /sort_by "yards" is not a column.*passing_yards/);
  err({ where: [{ field: "yds", op: "gt", value: 1 }] }, /where field "yds"/);
  err({ where: [{ field: "team", op: "like", value: 1 }] }, /op must be one of: eq, ne/);
  err({ where: [{ field: "team", op: "in", value: "LAR" }] }, /must be an array for op "in"/);
  err({ fields: ["name", "bogus"] }, /field "bogus"/);
  err({ aggregate: { op: "median", field: "passing_yards" } }, /aggregate\.op must be one of/);
  err({ aggregate: { op: "sum" } }, /aggregate\.field is required/);
  err({ aggregate: { op: "count", group_by: "nope" } }, /group_by "nope"/);
  err({ limit: "lots" }, /limit must be a number/);
  assert.throws(() => queryToolResult(store, {}), /result_id is required/);
  assert.throws(() => queryToolResult(store, { result_id: "r99" }), /Unknown result_id "r99".*only within the current turn/);
});

test("an oversized query answer keeps fewer rows and carries the truncation marker", () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ i, blob: "x".repeat(500) }));
  const { store, id } = storeWith(rows);
  const text = queryToolResult(store, { result_id: id, limit: 200 }, 30_000);
  assert.ok(text.length <= 30_000);
  assert.ok(text.includes(TOOL_OUTPUT_TRUNCATED_MARKER));
  const json = JSON.parse(text.slice(0, text.indexOf("\n\n")));
  assert.equal(json.returned_rows, json.rows.length);
  assert.ok(json.rows.length > 0 && json.rows.length < 200);
});

test("the store evicts oldest entries by count and by total size, and rejects one oversized value", () => {
  const byCount = new ToolResultStore(2, 1_000);
  const a = byCount.put("t", 1, 10);
  const b = byCount.put("t", 2, 10);
  const c = byCount.put("t", 3, 10);
  assert.deepEqual([a, b, c], ["r1", "r2", "r3"]);
  assert.equal(byCount.get("r1"), undefined);
  assert.equal(byCount.get("r3").value, 3);
  assert.equal(byCount.size, 2);

  const bySize = new ToolResultStore(20, 100);
  bySize.put("t", "a", 60);
  bySize.put("t", "b", 60);
  assert.equal(bySize.get("r1"), undefined);
  assert.equal(bySize.get("r2").value, "b");
  assert.equal(bySize.put("t", "huge", 101), undefined);
  assert.equal(bySize.get("r2").value, "b", "a rejected value evicts nothing");
});
