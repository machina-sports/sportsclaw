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

// Synthetic rows in the normalized prediction-market shape: the paired outcome
// name/price is the answer, so the overview must not reduce it to "array(2)".
const RULES = "Synthetic resolution rules. ".repeat(40);
function market(i, extra = {}) {
  return {
    id: `m${i}`, question: `Synthetic Team ${i} to win?`, description: RULES, slug: `synthetic-team-${i}`,
    condition_id: `0xsynthetic${i}`,
    outcomes: [
      { name: `Synthetic Team ${i}`, price: 0.6, clob_token_id: `tok-${i}-a` },
      { name: `Synthetic Rival ${i}`, price: 0.4, clob_token_id: `tok-${i}-b` },
    ],
    status: "active", sports_market_type: "moneyline", game_start_time: "2026-10-31T23:30:00Z",
    accepting_orders: true, enable_order_book: true, volume: 1000 + i, liquidity: 250 + i,
    ...extra,
  };
}
const HEAD = [
  market(0, { outcomes: [{ name: "Synthetic Home", price: 0.55, clob_token_id: "tok-h" }, { name: "Synthetic Away", price: 0.45, clob_token_id: "tok-a" }] }),
  market(1, { outcomes: [{ name: "Synthetic Draw", price: null, clob_token_id: "tok-d" }, { name: "Synthetic Field", clob_token_id: "tok-f" }] }),
  market(2, { status: "closed", sports_market_type: "spreads", accepting_orders: false, enable_order_book: false,
    outcomes: [{ name: "Synthetic Home -3.5", price: 0.52 }, { name: "Synthetic Away +3.5", price: 0.48 }] }),
];
const detail = { status: true, data: { event: { id: "e1", title: "Synthetic night" },
  markets: [...HEAD, ...Array.from({ length: 406 }, (_, i) => market(i + 3))] } };
/** Name and price exactly as given: a missing price stays missing. */
const pairOf = (o) => (Object.hasOwn(o, "price") ? { name: o.name, price: o.price } : { name: o.name });
/** Every {name, ...} object anywhere in a value, as its literal pair. */
function pairsIn(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => pairsIn(n, out));
  else if (node && typeof node === "object") {
    if (typeof node.name === "string") out.push(pairOf(node));
    Object.values(node).forEach((n) => pairsIn(n, out));
  }
  return out;
}
const IDENTITY = ["id", "question", "slug", "condition_id", "status", "sports_market_type", "game_start_time", "accepting_orders", "enable_order_book"];

test("a market overview keeps paired outcome names and prices, identity, status, type, time and trading flags", () => {
  const text = buildResultOverview("r1", detail, JSON.stringify(detail).length);
  assert.ok(text.length < 30_000, "bounded by the output cap");
  const overview = JSON.parse(text);
  assert.equal(overview.preview.path, "data.markets");
  assert.equal(overview.preview.first_rows.length, 5);
  HEAD.forEach((source, i) => {
    const row = overview.preview.first_rows[i];
    assert.ok(Array.isArray(row.outcomes), `row ${i}: outcomes kept, not ${row.outcomes}`);
    assert.deepEqual(row.outcomes.map(pairOf), source.outcomes.map(pairOf), `row ${i}: literal pairs, null kept, missing not invented`);
    for (const key of IDENTITY) assert.deepEqual(row[key], source[key], `row ${i}: ${key}`);
  });
});

test("a market with many outcomes previews a bounded literal prefix and says how many there are", () => {
  const many = Array.from({ length: 400 }, (_, k) => ({ name: `Synthetic Futures ${k}`, price: (k + 1) / 1000, clob_token_id: `fut-${k}` }));
  const futures = { data: { markets: Array.from({ length: 12 }, (_, i) => market(i, { outcomes: many })) } };
  const text = buildResultOverview("r1", futures, JSON.stringify(futures).length);
  assert.ok(text.length < 30_000, "bounded by the output cap");
  const row = JSON.parse(text).preview.first_rows[0];
  assert.ok(Array.isArray(row.outcomes) && row.outcomes.length > 0 && row.outcomes.length < 400, "a bounded preview, not the full array");
  assert.deepEqual(row.outcomes.map(pairOf), many.slice(0, row.outcomes.length).map(pairOf));
  assert.match(JSON.stringify(row), /\b400\b/, "the total is stated, never implied complete");
});

test("an event list overview previews bounded nested markets with literal pairs, not raw arrays", () => {
  const events = { status: true, data: { count: 50, events: Array.from({ length: 50 }, (_, e) => ({
    id: `e${e}`, title: `Synthetic Event ${e}`, slug: `synthetic-event-${e}`, status: "active", start_date: "2026-10-31",
    markets: e === 0 ? [HEAD[0], ...Array.from({ length: 8 }, (_, k) => market(k + 10))] : Array.from({ length: 9 }, (_, k) => market(e * 9 + k)),
  })) } };
  const text = buildResultOverview("r1", events, JSON.stringify(events).length);
  assert.ok(text.length < 30_000, "bounded by the output cap");
  const row = JSON.parse(text).preview.first_rows[0];
  const shown = JSON.stringify(row);
  assert.ok(shown.includes(HEAD[0].question), "the first nested market is identified");
  const pairs = pairsIn(row);
  for (const pair of HEAD[0].outcomes.map(pairOf)) assert.ok(pairs.some((p) => JSON.stringify(p) === JSON.stringify(pair)), JSON.stringify(pair));
  assert.ok(shown.length < JSON.stringify(events.data.events[0]).length / 2, "a bounded preview, not the raw nested arrays");
});

test("ordinary arrays, including name/price lists outside market outcomes, keep the generic description", () => {
  // Keep the parent rows as the largest array, which the existing overview selects.
  const rows = Array.from({ length: 3 }, () => ({ name: "a", legs: [{ name: "x", price: 1 }], tags: ["t", "u"] }));
  const row = JSON.parse(buildResultOverview("r1", rows, 1)).preview.first_rows[0];
  assert.deepEqual(row, { name: "a", legs: "array(1)", tags: "array(2)" });
});

test("the stored market result stays lossless for query_tool_result", () => {
  const out = q(detail, { path: "data.markets", where: [{ field: "id", op: "eq", value: "m1" }], fields: ["id", "outcomes"] });
  assert.deepEqual(out.rows, [{ id: "m1", outcomes: HEAD[1].outcomes }]);
  assert.equal(out.total_rows, 409);
});

// Synthetic event list in the SDK shape: the reported scope sits beside the rows.
// Four games start on Nov 1 UTC but Oct 31 in Los Angeles; two are past the preview.
const LATE = "2026-11-01T02:30:00Z";
function scopedEvents(scope) {
  const events = Array.from({ length: 7 }, (_, e) => {
    const start = e >= 3 ? LATE : "2026-10-31T23:00:00Z";
    return { id: `ev${e}`, title: `Synthetic Away ${e} at Synthetic Home ${e}`, start_time: start, markets: [
      market(e * 2, { question: `Synthetic Home ${e} vs Synthetic Away ${e}: winner?`, game_start_time: start,
        outcomes: [{ name: `Synthetic Home ${e}`, price: 0.55 }, { name: `Synthetic Away ${e}`, price: 0.45 }] }),
      market(e * 2 + 1, { game_start_time: start }),
    ] };
  });
  return { status: true, data: { events, ...scope } };
}
const SDK_SCOPE = { count: 7, sport: "nba", date: "2026-10-31", timezone: "America/Los_Angeles", offset: 0, scanned: 30,
  next_offset: 30, truncated: true, unknown_start: [], unknown_market_state: [{ id: "m-unknown" }], complete: false };

test("a market overview states its reported scope early and never supports an absence claim", () => {
  const value = scopedEvents(SDK_SCOPE);
  const before = structuredClone(value);
  const overview = JSON.parse(buildResultOverview("r1", value, JSON.stringify(value).length));
  assert.deepEqual(overview.market_coverage, {
    shown_rows: 5, total_rows: 7, absence_claims_supported: false,
    source_scope: { count: 7, sport: "nba", date: "2026-10-31", timezone: "America/Los_Angeles", offset: 0, scanned: 30,
      next_offset: 30, truncated: true, complete: false, unknown_start_count: 0, unknown_market_state_count: 1 },
  });
  const keys = Object.keys(overview);
  assert.ok(keys.indexOf("market_coverage") < keys.indexOf("preview"), "before the preview, so a head cut keeps it");
  assert.ok(JSON.stringify(overview.market_coverage).length < 600, "small and bounded");
  assert.deepEqual(overview.preview.first_rows.map((r) => r.id), ["ev0", "ev1", "ev2", "ev3", "ev4"]);
  assert.ok(pairsIn(overview.preview.first_rows[0]).some((p) => p.name === "Synthetic Home 0" && p.price === 0.55), "pairs kept");
  assert.deepEqual(value, before, "the stored original is unchanged");
  const late = q(value, { path: "data.events", where: [{ field: "start_time", op: "eq", value: LATE }], fields: ["id"] });
  assert.deepEqual(late.rows.map((r) => r.id), ["ev3", "ev4", "ev5", "ev6"], "the full reader still sees every row");
});

test("market coverage never invents completeness or totals, keeps false, zero and null, and bounds values", () => {
  const scope = JSON.parse(buildResultOverview("r1",
    scopedEvents({ limit: null, has_more: false, offset: 0, sport: { id: "nba" }, timezone: "z".repeat(300) }), 1)).market_coverage;
  assert.equal(scope.absence_claims_supported, false);
  assert.equal(scope.total_rows, 7);
  assert.deepEqual(Object.keys(scope.source_scope).sort(), ["has_more", "limit", "offset", "timezone"], "scalars only, none invented");
  assert.equal(scope.source_scope.limit, null);
  assert.equal(scope.source_scope.has_more, false);
  assert.equal(scope.source_scope.offset, 0);
  assert.ok(scope.source_scope.timezone.startsWith("zzz") && scope.source_scope.timezone.length <= 101, "the preview's string bound");

  const plain = JSON.parse(buildResultOverview("r1", detail, 1)).market_coverage;
  assert.deepEqual([plain.shown_rows, plain.total_rows, plain.absence_claims_supported], [5, 409, false]);
  assert.deepEqual(plain.source_scope ?? {}, {}, "nothing reported, nothing claimed");
});

test("ordinary overviews, even with date and completeness fields, are unchanged", () => {
  const games = { data: { date: "2026-10-31", timezone: "America/Los_Angeles", complete: false, games: players } };
  for (const value of [doc, games]) {
    const overview = JSON.parse(buildResultOverview("r1", value, 1));
    assert.deepEqual(Object.keys(overview), ["result_id", "total_chars", "top_level", "arrays", "preview"]);
  }
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
