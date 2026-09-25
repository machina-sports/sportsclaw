/**
 * Large tool results (#176): keep the full parsed JSON harness-side and let
 * the model query it, instead of handing it a blind head-only slice.
 *
 * Pure and deterministic: no model calls, no network. The engine stores a
 * result here when a registry tool's output exceeds the output cap, returns
 * `buildResultOverview()` to the model, and serves `query_tool_result` with
 * `queryToolResult()`.
 */

/** Name of the tool that queries a stored result. */
export const QUERY_TOOL_RESULT_TOOL = "query_tool_result";

/**
 * Stable prefix of every notice that a tool output is only part of the data
 * (head slice, overview, or a query answer cut to fit). The evidence verifier
 * (isTruncatedEvidence) and the bench trace `truncated` flag look for it.
 */
export const TOOL_OUTPUT_TRUNCATED_MARKER = "[... output truncated";

const MAX_LISTED_ARRAYS = 20;
const MAX_LISTED_COLUMNS = 150;
const COLUMN_SAMPLE_ROWS = 50;
const PREVIEW_ROWS = 5;
const PREVIEW_FIELDS = 25;
/** Arrays at most this long are treated as containers and searched for nested arrays. */
const CONTAINER_ARRAY_MAX = 10;
const MAX_WALK_DEPTH = 8;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface StoredToolResult {
  id: string;
  toolName: string;
  value: unknown;
  chars: number;
}

/**
 * Per-turn store of oversized tool results, bounded by entry count and by
 * total size (raw output chars); the oldest entries are evicted first.
 */
export class ToolResultStore {
  private readonly entries = new Map<string, StoredToolResult>();
  private totalChars = 0;
  private nextId = 1;

  constructor(
    readonly maxEntries = 20,
    readonly maxChars = 50_000_000,
  ) {}

  /** Store a parsed result; returns its id, or undefined when it alone exceeds maxChars. */
  put(toolName: string, value: unknown, chars: number): string | undefined {
    if (chars > this.maxChars) return undefined;
    const id = `r${this.nextId++}`;
    this.entries.set(id, { id, toolName, value, chars });
    this.totalChars += chars;
    for (const [oldId, old] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.totalChars <= this.maxChars) break;
      this.entries.delete(oldId);
      this.totalChars -= old.chars;
    }
    return id;
  }

  get(id: string): StoredToolResult | undefined {
    return this.entries.get(id);
  }

  get size(): number {
    return this.entries.size;
  }
}

// ---------------------------------------------------------------------------
// Shape detection
// ---------------------------------------------------------------------------

export interface ArrayShape {
  /** Dot path from the root ("" is the root itself). */
  path: string;
  rows: number;
  /** Keys seen on the first object rows, nested ones dotted (empty for scalar arrays). */
  columns: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function joinPath(base: string, key: string | number): string {
  return base === "" ? String(key) : `${base}.${key}`;
}

/**
 * Keys seen on the first object rows. An object-valued key is followed by its
 * own keys as dotted names (one level: `stats`, `stats.passing_yards`, ...),
 * since feeds like nflverse nest the numbers the model needs.
 */
function columnsOf(rows: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const row of rows.slice(0, COLUMN_SAMPLE_ROWS)) {
    if (!isPlainObject(row)) continue;
    for (const [key, value] of Object.entries(row)) {
      seen.add(key);
      if (isPlainObject(value)) for (const sub of Object.keys(value)) seen.add(`${key}.${sub}`);
    }
  }
  return [...seen];
}

/**
 * Every array in the value: object keys are walked fully; arrays with at most
 * CONTAINER_ARRAY_MAX elements are also walked (e.g. `seasonTypes.0.events`),
 * longer ones are treated as row sets. Sorted by row count, largest first.
 */
export function findArrays(value: unknown): ArrayShape[] {
  const out: ArrayShape[] = [];
  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return;
    if (Array.isArray(node)) {
      out.push({ path, rows: node.length, columns: columnsOf(node) });
      if (node.length <= CONTAINER_ARRAY_MAX) {
        node.forEach((item, i) => walk(item, joinPath(path, i), depth + 1));
      }
    } else if (isPlainObject(node)) {
      for (const [key, child] of Object.entries(node)) walk(child, joinPath(path, key), depth + 1);
    }
  };
  walk(value, "", 0);
  // Stable sort: equal sizes keep document order.
  return out.sort((a, b) => b.rows - a.rows);
}

/** Whether the value has a non-empty array that query_tool_result can query. */
export function hasQueryableRows(value: unknown): boolean {
  return findArrays(value).some((a) => a.rows > 0);
}

function describeValue(v: unknown): unknown {
  if (Array.isArray(v)) return `array(${v.length})`;
  if (isPlainObject(v)) return `object(${Object.keys(v).length} keys)`;
  if (typeof v === "string" && v.length > 100) return `${v.slice(0, 100)}…`;
  return v;
}

function previewRow(row: unknown): unknown {
  if (!isPlainObject(row)) return describeValue(row);
  const entries = Object.entries(row);
  const shown = Object.fromEntries(entries.slice(0, PREVIEW_FIELDS).map(([k, v]) => [k, describeValue(v)]));
  if (entries.length > PREVIEW_FIELDS) shown["…"] = `${entries.length - PREVIEW_FIELDS} more fields`;
  return shown;
}

/** Display form of a path ("" is the root). */
function showPath(path: string): string {
  return path === "" ? "$" : path;
}

/**
 * Compact overview of a stored result for the model: size, top-level fields,
 * every array (path, rows, columns; capped) and the first rows of the largest
 * array. Returns undefined when the value has no non-empty array to query.
 */
export function buildResultOverview(resultId: string, value: unknown, totalChars: number): string | undefined {
  const arrays = findArrays(value).filter((a) => a.rows > 0);
  if (arrays.length === 0) return undefined;
  const largest = arrays[0];
  const largestRows = resolvePath(value, largest.path) as unknown[];
  const overview = {
    result_id: resultId,
    total_chars: totalChars,
    ...(isPlainObject(value)
      ? { top_level: Object.fromEntries(Object.entries(value).slice(0, MAX_LISTED_COLUMNS).map(([k, v]) => [k, describeValue(v)])) }
      : {}),
    arrays: arrays.slice(0, MAX_LISTED_ARRAYS).map((a) => ({
      path: showPath(a.path),
      rows: a.rows,
      ...(a.columns.length > 0 ? { columns: a.columns.slice(0, MAX_LISTED_COLUMNS) } : {}),
      ...(a.columns.length > MAX_LISTED_COLUMNS ? { more_columns: a.columns.length - MAX_LISTED_COLUMNS } : {}),
    })),
    ...(arrays.length > MAX_LISTED_ARRAYS ? { more_arrays: arrays.length - MAX_LISTED_ARRAYS } : {}),
    preview: {
      path: showPath(largest.path),
      first_rows: largestRows.slice(0, PREVIEW_ROWS).map(previewRow),
    },
  };
  return JSON.stringify(overview);
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export type WhereOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "contains" | "in";
const WHERE_OPS: readonly WhereOp[] = ["eq", "ne", "gt", "gte", "lt", "lte", "contains", "in"];
export type AggregateOp = "count" | "sum" | "mean" | "min" | "max";
const AGGREGATE_OPS: readonly AggregateOp[] = ["count", "sum", "mean", "min", "max"];

export interface ToolResultQuery {
  result_id?: unknown;
  result_ids?: unknown;
  path?: unknown;
  where?: unknown;
  sort_by?: unknown;
  descending?: unknown;
  limit?: unknown;
  fields?: unknown;
  aggregate?: unknown;
}

/** A query the model got wrong; its message is meant for the model. */
export class ToolResultQueryError extends Error {}

function fail(message: string): never {
  throw new ToolResultQueryError(message);
}

function resolvePath(value: unknown, path: string): unknown {
  if (path === "" || path === "$") return value;
  let node = value;
  for (const segment of path.replace(/^\$\./, "").split(".")) {
    if (Array.isArray(node) && /^\d+$/.test(segment)) node = node[Number(segment)];
    else if (isPlainObject(node) && Object.hasOwn(node, segment)) node = node[segment];
    else return undefined;
  }
  return node;
}

/**
 * Values read through a nested list (`competitors.team.abbreviation` on an
 * event with two competitors): a condition matches when any of them does.
 */
class FanOut {
  constructor(readonly values: unknown[]) {}
}

function resolveAcross(node: unknown, segments: string[]): unknown {
  let nodes: unknown[] = [node];
  let fanned = false;
  for (const segment of segments) {
    const next: unknown[] = [];
    for (const n of nodes) {
      if (Array.isArray(n)) {
        if (/^\d+$/.test(segment)) {
          if (n[Number(segment)] !== undefined) next.push(n[Number(segment)]);
        } else {
          fanned = true;
          for (const item of n) if (isPlainObject(item) && Object.hasOwn(item, segment)) next.push(item[segment]);
        }
      } else if (isPlainObject(n) && Object.hasOwn(n, segment)) {
        next.push(n[segment]);
      }
    }
    nodes = next;
  }
  if (!fanned) return nodes[0];
  return nodes.length > 0 ? new FanOut(nodes) : undefined;
}

/**
 * Field of a row; a dotted field reads nested objects (e.g. "stats.yards") and
 * reads through nested lists (a FanOut of every value). Scalar rows expose `value`.
 */
function fieldOf(row: unknown, field: string): unknown {
  if (!isPlainObject(row)) return field === "value" ? row : undefined;
  if (Object.hasOwn(row, field)) return row[field];
  return resolveAcross(row, field.split("."));
}

/** The values a field holds: every one of a FanOut, else the single value. */
function valuesOf(v: unknown): unknown[] {
  return v instanceof FanOut ? v.values : [v];
}

/** JSON form of a field value (a FanOut becomes its list of values). */
function plain(v: unknown): unknown {
  return v instanceof FanOut ? v.values : v;
}

function isMissing(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

/** Numeric view of a value: numbers, and strings that are plain numbers. */
function asNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(v)) return Number(v);
  return undefined;
}

function asText(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** Numeric when both sides are numeric, otherwise case-insensitive text. */
function compareValues(a: unknown, b: unknown): number {
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== undefined && nb !== undefined) return na - nb;
  if (na !== undefined) return -1; // numbers before text
  if (nb !== undefined) return 1;
  return asText(a).toLowerCase().localeCompare(asText(b).toLowerCase());
}

function matches(actual: unknown, op: WhereOp, expected: unknown): boolean {
  // Through a nested list: "ne" holds when no value equals, every other op when any value matches.
  if (actual instanceof FanOut) {
    return op === "ne"
      ? actual.values.every((v) => matches(v, "ne", expected))
      : actual.values.some((v) => matches(v, op, expected));
  }
  if (op === "ne") return isMissing(actual) || compareValues(actual, expected) !== 0;
  if (isMissing(actual)) return false;
  switch (op) {
    case "eq":
      return compareValues(actual, expected) === 0;
    case "gt":
      return compareValues(actual, expected) > 0;
    case "gte":
      return compareValues(actual, expected) >= 0;
    case "lt":
      return compareValues(actual, expected) < 0;
    case "lte":
      return compareValues(actual, expected) <= 0;
    case "contains":
      return asText(actual).toLowerCase().includes(asText(expected).toLowerCase());
    case "in":
      return (expected as unknown[]).some((e) => compareValues(actual, e) === 0);
  }
}

interface Condition {
  field: string;
  op: WhereOp;
  value: unknown;
}

function parseWhere(where: unknown): Condition[] {
  if (where === undefined || where === null) return [];
  const list = Array.isArray(where) ? where : [where];
  return list.map((raw, i) => {
    if (!isPlainObject(raw)) fail(`where[${i}] must be an object {field, op, value}.`);
    const { field, op = "eq", value } = raw;
    if (typeof field !== "string" || field === "") fail(`where[${i}].field must be a column name.`);
    if (typeof op !== "string" || !WHERE_OPS.includes(op as WhereOp)) {
      fail(`where[${i}].op must be one of: ${WHERE_OPS.join(", ")}.`);
    }
    if (op === "in" && !Array.isArray(value)) fail(`where[${i}].value must be an array for op "in".`);
    return { field, op: op as WhereOp, value };
  });
}

function validPathsHint(value: unknown): string {
  const paths = findArrays(value).slice(0, MAX_LISTED_ARRAYS).map((a) => `${showPath(a.path)} (${a.rows} rows)`);
  return paths.length > 0 ? `Valid array paths: ${paths.join(", ")}.` : "This result has no arrays.";
}

function checkField(rows: readonly unknown[], columns: readonly string[], field: string, param: string): void {
  if (rows.some((row) => fieldOf(row, field) !== undefined)) return;
  const shown = columns.slice(0, MAX_LISTED_COLUMNS).join(", ");
  const more = columns.length > MAX_LISTED_COLUMNS ? ` (+${columns.length - MAX_LISTED_COLUMNS} more)` : "";
  fail(`${param} "${field}" is not a column of any row. Columns: ${shown || "(rows are not objects; use \"value\")"}${more}.`);
}

function project(row: unknown, fields: readonly string[] | undefined): unknown {
  if (!fields) return row;
  return Object.fromEntries(fields.map((f) => [f, plain(fieldOf(row, f)) ?? null]));
}

/** Sort key order: present values by comparator (desc/asc), missing values always last. */
function sortRows<T>(rows: T[], key: (row: T) => unknown, descending: boolean): T[] {
  return rows
    .map((row, i) => ({ row, i, k: key(row) }))
    .sort((a, b) => {
      const ma = isMissing(a.k);
      const mb = isMissing(b.k);
      if (ma || mb) return ma === mb ? a.i - b.i : ma ? 1 : -1;
      const c = compareValues(a.k, b.k);
      return c === 0 ? a.i - b.i : descending ? -c : c;
    })
    .map((x) => x.row);
}

function aggregateValues(op: AggregateOp, rows: readonly unknown[], field: string | undefined): { value: number | null; n: number } {
  if (op === "count") return { value: rows.length, n: rows.length };
  const nums = rows
    .flatMap((row) => valuesOf(fieldOf(row, field!)).map(asNumber))
    .filter((n): n is number => n !== undefined);
  if (nums.length === 0) return { value: null, n: 0 };
  const sum = nums.reduce((a, b) => a + b, 0);
  const value =
    op === "sum" ? sum
    : op === "mean" ? sum / nums.length
    : nums.reduce((a, b) => (op === "min" ? Math.min(a, b) : Math.max(a, b)));
  return { value, n: nums.length };
}

/**
 * Run a query against a stored result. Returns a JSON string. Throws
 * ToolResultQueryError with a model-readable message on a bad query.
 */
export function queryToolResult(store: ToolResultStore, query: ToolResultQuery, maxChars = 30_000): string {
  // One result (result_id) or the same path across several (result_ids): a season
  // built from one box score per game is then summed in one query, not by hand.
  const many = Array.isArray(query.result_ids) && query.result_ids.length > 0;
  const ids = many
    ? (query.result_ids as unknown[]).map((v) => (typeof v === "string" ? v.trim() : ""))
    : [typeof query.result_id === "string" ? query.result_id.trim() : ""];
  if (ids.some((id) => !id)) fail("result_id is required (e.g. \"r1\", from the tool output), or result_ids: [\"r1\", \"r2\"].");
  const storedAll = ids.map((id) => {
    const stored = store.get(id);
    if (!stored) {
      fail(
        `Unknown result_id "${id}". Stored results live only within the current turn ` +
          "(and the oldest are evicted); call the data tool again to get a new result_id.",
      );
    }
    return stored;
  });
  const id = ids.join(",");

  if (query.path !== undefined && query.path !== null && query.path !== "" && typeof query.path !== "string") {
    fail("path must be a dot path string, e.g. \"data.players\".");
  }
  const explicit = typeof query.path === "string" && query.path !== "" ? (query.path === "$" ? "" : query.path.replace(/^\$\./, "")) : undefined;
  const rows: unknown[] = [];
  let path = explicit ?? "";
  for (const stored of storedAll) {
    const arrays = findArrays(stored.value).filter((a) => a.rows > 0);
    let own = explicit;
    if (own === undefined) {
      if (arrays.length === 0) fail(`Result "${stored.id}" has no non-empty arrays to query.`);
      own = arrays[0].path;
    }
    path = own;
    const target = resolvePath(stored.value, own);
    if (!Array.isArray(target)) {
      if (target !== undefined && !many && explicit !== undefined) {
        // An object (a box score's game_info, a summary header): return it as is.
        const text = JSON.stringify({ result_id: stored.id, path: showPath(own), value: target });
        return text.length <= maxChars
          ? text
          : `${text.slice(0, maxChars)}\n\n${TOOL_OUTPUT_TRUNCATED_MARKER}: showing ${maxChars.toLocaleString()} of ${text.length.toLocaleString()} chars. Query a narrower path.]`;
      }
      fail(`path "${showPath(own)}" in result "${stored.id}" is ${target === undefined ? "not found" : "not an array"}. ${validPathsHint(stored.value)}`);
    }
    for (const row of target) rows.push(many && isPlainObject(row) ? { _result_id: stored.id, ...row } : row);
  }
  const columns = columnsOf(rows);

  const conditions = parseWhere(query.where);
  for (const c of conditions) checkField(rows, columns, c.field, "where field");

  let fields: string[] | undefined;
  if (query.fields !== undefined && query.fields !== null) {
    if (!Array.isArray(query.fields) || query.fields.some((f) => typeof f !== "string")) {
      fail("fields must be an array of column names.");
    }
    fields = query.fields as string[];
    for (const f of fields) checkField(rows, columns, f, "field");
  }

  const sortBy = query.sort_by;
  if (sortBy !== undefined && sortBy !== null && typeof sortBy !== "string") fail("sort_by must be a column name.");
  const descending = query.descending === undefined || query.descending === null ? true : query.descending !== false;
  const rawLimit = query.limit === undefined || query.limit === null ? DEFAULT_LIMIT : asNumber(query.limit);
  if (rawLimit === undefined) fail("limit must be a number.");
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(rawLimit)));

  const matched = rows.filter((row) => conditions.every((c) => matches(fieldOf(row, c.field), c.op, c.value)));
  const base = { result_id: id, path: showPath(path), total_rows: rows.length, matched_rows: matched.length };

  if (query.aggregate !== undefined && query.aggregate !== null) {
    if (!isPlainObject(query.aggregate)) fail("aggregate must be an object {op, field?, group_by?}.");
    const { op, field, group_by: groupBy } = query.aggregate;
    if (typeof op !== "string" || !AGGREGATE_OPS.includes(op as AggregateOp)) {
      fail(`aggregate.op must be one of: ${AGGREGATE_OPS.join(", ")}.`);
    }
    if (op !== "count") {
      if (typeof field !== "string" || field === "") fail(`aggregate.field is required for op "${op}".`);
      checkField(rows, columns, field, "aggregate field");
    }
    const aggField = typeof field === "string" && field !== "" ? field : undefined;
    const aggOp = op as AggregateOp;
    const aggregate = { op: aggOp, ...(aggField ? { field: aggField } : {}) };
    if (groupBy === undefined || groupBy === null) {
      return capOutput({ ...base, aggregate: { ...aggregate, ...aggregateValues(aggOp, matched, aggField) } }, "groups", maxChars);
    }
    if (typeof groupBy !== "string" || groupBy === "") fail("aggregate.group_by must be a column name.");
    checkField(rows, columns, groupBy, "aggregate group_by");
    const groups = new Map<string, { key: unknown; rows: unknown[] }>();
    for (const row of matched) {
      const key = plain(fieldOf(row, groupBy)) ?? null;
      const k = JSON.stringify(key);
      const g = groups.get(k) ?? { key, rows: [] };
      g.rows.push(row);
      groups.set(k, g);
    }
    const summarized = [...groups.values()].map((g) => ({ [groupBy]: g.key, ...aggregateValues(aggOp, g.rows, aggField) }));
    const sorted = sortRows(summarized, (g) => g.value, descending);
    return capOutput(
      { ...base, aggregate: { ...aggregate, group_by: groupBy }, total_groups: sorted.length, groups: sorted.slice(0, limit) },
      "groups",
      maxChars,
    );
  }

  if (typeof sortBy === "string" && sortBy !== "") checkField(rows, columns, sortBy, "sort_by");
  const ordered = typeof sortBy === "string" && sortBy !== ""
    ? sortRows(matched, (row) => valuesOf(fieldOf(row, sortBy))[0], descending)
    : matched;
  const selected = ordered.slice(0, limit).map((row) => project(row, fields));
  return capOutput({ ...base, returned_rows: selected.length, rows: selected }, "rows", maxChars);
}

/** Serialize; if over the cap, drop trailing rows/groups and say so with the truncation marker. */
function capOutput(result: Record<string, unknown>, listKey: "rows" | "groups", maxChars: number): string {
  let text = JSON.stringify(result);
  const list = result[listKey];
  if (text.length <= maxChars || !Array.isArray(list)) return text;
  let keep = list.length;
  while (keep > 0) {
    keep = Math.floor(keep / 2);
    const trimmed = { ...result, [listKey]: list.slice(0, keep) };
    if (listKey === "rows") trimmed.returned_rows = keep;
    text = JSON.stringify(trimmed);
    if (text.length <= maxChars - 300) break;
  }
  return (
    `${text}\n\n${TOOL_OUTPUT_TRUNCATED_MARKER}: kept ${keep} of ${list.length} ${listKey} to fit ${maxChars.toLocaleString()} chars. ` +
    "Pass fields (fewer columns) or a smaller limit.]"
  );
}
