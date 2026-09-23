// #175: an identical successful tool call in the same turn is served from the
// turn cache instead of re-running the subprocess, with a note telling the
// model it already has this result.
import assert from "node:assert/strict";
import test from "node:test";

import { REPEATED_CALL_NOTE, TOOL_OUTPUT_CHAR_CAP, sportsclawEngine } from "../dist/engine.js";
import { DEFAULT_CONFIG } from "../dist/types.js";

function engineWithRegistry(respond) {
  const dispatched = [];
  const engine = Object.create(sportsclawEngine.prototype);
  engine.config = { ...DEFAULT_CONFIG, yoloMode: true, verbose: false };
  engine.registry = {
    getAllToolSpecs: () => [{ name: "nfl_get_stats", description: "stats", input_schema: { type: "object", properties: {} } }],
    getSkillName: () => "nfl",
    dispatchToolCall: async (name, args) => {
      dispatched.push(args);
      return respond(args);
    },
  };
  engine.mcpManager = { serverCount: 0, getToolSpecs: () => [], getMachinaLoopServer: () => undefined };
  return { engine, dispatched };
}

const opts = { toolCallId: "c", messages: [] };

test("identical successful calls in one turn run once; the repeat is served with a note", async () => {
  const { engine, dispatched } = engineWithRegistry(() => ({ isError: false, content: '{"rows":[1,2,3]}' }));
  const tools = engine.buildTools(undefined, new Map(), undefined, undefined, undefined, new Map());
  const first = await tools.nfl_get_stats.execute({ week: 5, season: 2025 }, opts);
  const again = await tools.nfl_get_stats.execute({ season: 2025, week: 5 }, opts); // same args, different key order
  const other = await tools.nfl_get_stats.execute({ week: 6, season: 2025 }, opts);
  assert.equal(first, '{"rows":[1,2,3]}');
  assert.equal(again, REPEATED_CALL_NOTE + '{"rows":[1,2,3]}');
  assert.equal(other, '{"rows":[1,2,3]}');
  assert.equal(dispatched.length, 2, "the repeat never reached the registry");
});

test("the cache is per turn: a new turn map dispatches again", async () => {
  const { engine, dispatched } = engineWithRegistry(() => ({ isError: false, content: "{}" }));
  await engine.buildTools(undefined, new Map(), undefined, undefined, undefined, new Map()).nfl_get_stats.execute({ a: 1 }, opts);
  await engine.buildTools(undefined, new Map(), undefined, undefined, undefined, new Map()).nfl_get_stats.execute({ a: 1 }, opts);
  assert.equal(dispatched.length, 2);
});

test("a capped result is cached as the model saw it (capped, with the truncation note)", async () => {
  const big = "x".repeat(TOOL_OUTPUT_CHAR_CAP + 50);
  const { engine } = engineWithRegistry(() => ({ isError: false, content: big }));
  const tools = engine.buildTools(undefined, new Map(), undefined, undefined, undefined, new Map());
  const first = await tools.nfl_get_stats.execute({}, opts);
  const again = await tools.nfl_get_stats.execute({}, opts);
  assert.match(first, /output truncated/);
  assert.equal(again, REPEATED_CALL_NOTE + first);
});

test("failures are not cached as successes; the existing repeated-failure skip still applies", async () => {
  const { engine, dispatched } = engineWithRegistry(() => ({ isError: true, content: '{"error":"bad week"}' }));
  const tools = engine.buildTools(undefined, new Map(), undefined, undefined, undefined, new Map());
  await assert.rejects(tools.nfl_get_stats.execute({ week: 99 }, opts), /bad week/);
  await assert.rejects(tools.nfl_get_stats.execute({ week: 99 }, opts), /Skipped repeated failing call/);
  assert.equal(dispatched.length, 1);
});

test("without a turn cache (other callers), behaviour is unchanged", async () => {
  const { engine, dispatched } = engineWithRegistry(() => ({ isError: false, content: "{}" }));
  const tools = engine.buildTools(undefined, new Map());
  await tools.nfl_get_stats.execute({ a: 1 }, opts);
  await tools.nfl_get_stats.execute({ a: 1 }, opts);
  assert.equal(dispatched.length, 2);
});
