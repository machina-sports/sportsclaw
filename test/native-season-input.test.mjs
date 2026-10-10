import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// dist modules resolve homedir() at load; isolate analytics/cache writes first.
const home = mkdtempSync(join(tmpdir(), "sportsclaw-native-season-"));
process.env.HOME = home;
const { sanitizeToolInput, ToolRegistry } = await import("../dist/tools.js");

after(() => rmSync(home, { recursive: true, force: true }));

// Stand-in interpreter: echoes the argv the bridge passed to "python".
function fakePython() {
  const path = join(home, "fake-python");
  writeFileSync(
    path,
    `#!${process.execPath}\nconsole.log(JSON.stringify({ argv: process.argv.slice(2) }));\n`,
    { mode: 0o755 },
  );
  return path;
}

describe("sanitizeToolInput native NFL seasons", () => {
  it("keeps numeric season and season_year for direct nfl_get_schedule", () => {
    const input = { season: 2026, season_year: 2025 };
    sanitizeToolInput("nfl_get_schedule", input);
    assert.deepEqual(input, { season: 2026, season_year: 2025 });
  });

  it("does not fabricate an ESPN id from a string bare year", () => {
    const input = { season: "2026" };
    sanitizeToolInput("nfl_get_schedule", input);
    assert.equal(input.season, "2026");
  });

  it("keeps numeric season for generic sports_query nfl args", () => {
    const input = { sport: "nfl", command: "get_schedule", args: { season: 2026 } };
    sanitizeToolInput("sports_query", input);
    assert.deepEqual(input.args, { season: 2026 });
  });

  it("normalizes legacy ESPN year slugs and preserves football season IDs", () => {
    const direct = { season_id: "espn.nfl.2025" };
    sanitizeToolInput("nfl_get_schedule", direct);
    assert.equal(direct.season_id, "2025");

    const generic = { sport: "nfl", command: "get_schedule", args: { season_id: "espn.nfl.2025" } };
    sanitizeToolInput("sports_query", generic);
    assert.equal(generic.args.season_id, "2025");

    const football = { season_id: "premier-league-2025" };
    sanitizeToolInput("football_get_season_schedule", football);
    assert.equal(football.season_id, "premier-league-2025");
  });
});

describe("native NFL season reaches the Python bridge unchanged", () => {
  const expectedArgv = ["-m", "sports_skills", "nfl", "get_schedule", "--season=2026"];

  it("direct nfl_get_schedule dispatch passes --season=2026", async () => {
    const pythonPath = fakePython();
    const registry = new ToolRegistry();
    registry.injectSchema({
      sport: "nfl",
      version: "test",
      tools: [
        {
          name: "nfl_get_schedule",
          command: "get_schedule",
          description: "NFL schedule",
          parameters: { type: "object", properties: { season: { type: "integer" } } },
        },
      ],
    });

    const result = await registry.dispatchToolCall("nfl_get_schedule", { season: 2026 }, { pythonPath });
    assert.equal(result.isError, false, result.content);
    assert.deepEqual(JSON.parse(result.content).argv, expectedArgv);
  });

  it("generic sports_query nfl dispatch passes --season=2026", async () => {
    const pythonPath = fakePython();
    const registry = new ToolRegistry();

    const result = await registry.dispatchToolCall(
      "sports_query",
      { sport: "nfl", command: "get_schedule", args: { season: 2026 } },
      { pythonPath },
    );
    assert.equal(result.isError, false, result.content);
    assert.deepEqual(JSON.parse(result.content).argv, expectedArgv);
  });
});
