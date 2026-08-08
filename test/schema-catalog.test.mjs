/**
 * Schema catalog categorization + `sportsclaw list` reporting — test suite
 *
 * The catalog is a mix of sports and support modules, each of which may be a
 * default (installed by `init --all`) or an optional extra. `sportsclaw list`
 * has to report those categories honestly instead of calling everything a
 * "sport schema", and the tool count has to come from the schemas on disk —
 * never from a hard-coded number.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  DEFAULT_SKILLS,
  DEFAULT_SPORT_SKILLS,
  OPTIONAL_SPORT_SKILLS,
  DEFAULT_SUPPORT_SKILLS,
  OPTIONAL_SUPPORT_SKILLS,
  categorizeSchema,
  summarizeInstalledSchemas,
} from "../dist/schema.js";

// The verified catalog, spelled out here on purpose: if src/schema.ts drifts,
// these literals are what fail.
const EXPECTED_DEFAULT_SPORTS = [
  "football",
  "nfl",
  "nba",
  "nhl",
  "mlb",
  "wnba",
  "tennis",
  "cfb",
  "cbb",
  "golf",
  "f1",
  "cricket",
  "volleyball",
  "xctf",
];
const EXPECTED_OPTIONAL_SPORTS = ["esports"];
const EXPECTED_DEFAULT_SUPPORT = [
  "kalshi",
  "polymarket",
  "news",
  "metadata",
  "betting",
  "markets",
];
const EXPECTED_OPTIONAL_SUPPORT = ["polymarket-trading"];

const ALL_KNOWN = [
  ...EXPECTED_DEFAULT_SPORTS,
  ...EXPECTED_OPTIONAL_SPORTS,
  ...EXPECTED_DEFAULT_SUPPORT,
  ...EXPECTED_OPTIONAL_SUPPORT,
];

/** Build a schema object with `n` tools so tool totals are checkable. */
function fixtureSchema(sport, toolCount) {
  return {
    sport,
    version: "1.0.0",
    tools: Array.from({ length: toolCount }, (_, i) => ({
      name: `${sport}_tool_${i}`,
      command: `cmd_${i}`,
      description: "fixture tool",
      parameters: {},
    })),
  };
}

describe("catalog constants", () => {
  it("exposes exactly the 14 default sports, in order", () => {
    assert.deepEqual([...DEFAULT_SPORT_SKILLS], EXPECTED_DEFAULT_SPORTS);
    assert.equal(DEFAULT_SPORT_SKILLS.length, 14);
  });

  it("exposes esports as the only optional sport", () => {
    assert.deepEqual([...OPTIONAL_SPORT_SKILLS], EXPECTED_OPTIONAL_SPORTS);
  });

  it("exposes exactly the 6 default support modules, in order", () => {
    assert.deepEqual([...DEFAULT_SUPPORT_SKILLS], EXPECTED_DEFAULT_SUPPORT);
    assert.equal(DEFAULT_SUPPORT_SKILLS.length, 6);
  });

  it("exposes polymarket-trading as the only optional support module", () => {
    assert.deepEqual([...OPTIONAL_SUPPORT_SKILLS], EXPECTED_OPTIONAL_SUPPORT);
  });

  it("keeps the four categories disjoint", () => {
    const seen = new Set();
    for (const name of ALL_KNOWN) {
      assert.ok(!seen.has(name), `${name} appears in more than one category`);
      seen.add(name);
    }
    assert.equal(seen.size, 22);
  });

  it("keeps DEFAULT_SKILLS backwards compatible: default sports then default support", () => {
    assert.deepEqual(
      [...DEFAULT_SKILLS],
      [...EXPECTED_DEFAULT_SPORTS, ...EXPECTED_DEFAULT_SUPPORT]
    );
    assert.equal(DEFAULT_SKILLS.length, 20);
  });
});

describe("categorizeSchema", () => {
  it("classifies every known schema", () => {
    for (const name of EXPECTED_DEFAULT_SPORTS) {
      assert.equal(categorizeSchema(name), "default-sport", name);
    }
    for (const name of EXPECTED_OPTIONAL_SPORTS) {
      assert.equal(categorizeSchema(name), "optional-sport", name);
    }
    for (const name of EXPECTED_DEFAULT_SUPPORT) {
      assert.equal(categorizeSchema(name), "default-support", name);
    }
    for (const name of EXPECTED_OPTIONAL_SUPPORT) {
      assert.equal(categorizeSchema(name), "optional-support", name);
    }
  });

  it("classifies anything else as unknown", () => {
    assert.equal(categorizeSchema("quidditch"), "unknown");
    assert.equal(categorizeSchema(""), "unknown");
  });
});

describe("summarizeInstalledSchemas", () => {
  it("reports 15 sports, 7 support modules, 22 schemas and the summed tool count for a full install", () => {
    // Distinct per-schema counts so a wrong sum cannot pass by accident.
    const schemas = ALL_KNOWN.map((name, i) => fixtureSchema(name, i + 1));
    const expectedTools = schemas.reduce((sum, s) => sum + s.tools.length, 0);

    const summary = summarizeInstalledSchemas(schemas);

    assert.deepEqual(summary.defaultSports, EXPECTED_DEFAULT_SPORTS);
    assert.deepEqual(summary.optionalSports, EXPECTED_OPTIONAL_SPORTS);
    assert.deepEqual(summary.defaultSupport, EXPECTED_DEFAULT_SUPPORT);
    assert.deepEqual(summary.optionalSupport, EXPECTED_OPTIONAL_SUPPORT);
    assert.deepEqual(summary.unknown, []);
    assert.equal(summary.totalSports, 15);
    assert.equal(summary.totalSupport, 7);
    assert.equal(summary.totalSchemas, 22);
    assert.equal(summary.totalTools, expectedTools);
  });

  it("preserves unrecognized schemas as unknown without counting them as sports", () => {
    const summary = summarizeInstalledSchemas([
      fixtureSchema("nba", 3),
      fixtureSchema("quidditch", 2),
    ]);

    assert.deepEqual(summary.defaultSports, ["nba"]);
    assert.deepEqual(summary.unknown, ["quidditch"]);
    assert.equal(summary.totalSports, 1);
    assert.equal(summary.totalSupport, 0);
    assert.equal(summary.totalSchemas, 2);
    assert.equal(summary.totalTools, 5);
  });

  it("returns empty categories and zero totals for an empty install", () => {
    const summary = summarizeInstalledSchemas([]);
    assert.deepEqual(summary.defaultSports, []);
    assert.deepEqual(summary.optionalSports, []);
    assert.deepEqual(summary.defaultSupport, []);
    assert.deepEqual(summary.optionalSupport, []);
    assert.deepEqual(summary.unknown, []);
    assert.equal(summary.totalSports, 0);
    assert.equal(summary.totalSupport, 0);
    assert.equal(summary.totalSchemas, 0);
    assert.equal(summary.totalTools, 0);
  });

  it("tolerates a schema with no tools array", () => {
    const summary = summarizeInstalledSchemas([{ sport: "nba" }]);
    assert.equal(summary.totalSchemas, 1);
    assert.equal(summary.totalTools, 0);
  });
});

// ---------------------------------------------------------------------------
// CLI: `sportsclaw list` / `sportsclaw list --json`
// ---------------------------------------------------------------------------

describe("sportsclaw list (CLI)", () => {
  let schemaDir;
  let emptyDir;

  const INSTALLED = [
    ["nba", 4],
    ["nfl", 3],
    ["esports", 2],
    ["kalshi", 5],
    ["polymarket-trading", 1],
    ["quidditch", 6],
  ];
  const EXPECTED_TOOLS = INSTALLED.reduce((sum, [, n]) => sum + n, 0);

  function runList(args, dir) {
    const env = { ...process.env, sportsclaw_SCHEMA_DIR: dir };
    delete env.SPORTSCLAW_SKILLS;
    delete env.sportsclaw_SKILLS;
    return execFileSync("node", ["dist/index.js", "list", ...args], {
      encoding: "utf-8",
      env,
    });
  }

  before(() => {
    const root = mkdtempSync(join(tmpdir(), "sportsclaw-catalog-"));
    schemaDir = join(root, "schemas");
    emptyDir = join(root, "empty");
    mkdirSync(schemaDir, { recursive: true });
    mkdirSync(emptyDir, { recursive: true });
    for (const [name, count] of INSTALLED) {
      writeFileSync(
        join(schemaDir, `${name}.json`),
        JSON.stringify(fixtureSchema(name, count)),
        "utf-8"
      );
    }
  });

  after(() => {
    rmSync(join(schemaDir, ".."), { recursive: true, force: true });
  });

  it("emits parseable JSON with exact categories and totals", () => {
    const parsed = JSON.parse(runList(["--json"], schemaDir));

    assert.deepEqual(parsed.defaultSports, ["nba", "nfl"]);
    assert.deepEqual(parsed.optionalSports, ["esports"]);
    assert.deepEqual(parsed.defaultSupport, ["kalshi"]);
    assert.deepEqual(parsed.optionalSupport, ["polymarket-trading"]);
    assert.deepEqual(parsed.unknown, ["quidditch"]);
    assert.equal(parsed.totals.sports, 3);
    assert.equal(parsed.totals.support, 2);
    assert.equal(parsed.totals.schemas, 6);
    assert.equal(parsed.totals.tools, EXPECTED_TOOLS);
    assert.equal(parsed.schemaDir, schemaDir);
  });

  it("emits an empty-but-valid JSON shape when nothing is installed", () => {
    const parsed = JSON.parse(runList(["--json"], emptyDir));

    assert.deepEqual(parsed.defaultSports, []);
    assert.deepEqual(parsed.optionalSports, []);
    assert.deepEqual(parsed.defaultSupport, []);
    assert.deepEqual(parsed.optionalSupport, []);
    assert.deepEqual(parsed.unknown, []);
    assert.equal(parsed.totals.schemas, 0);
    assert.equal(parsed.totals.tools, 0);
  });

  it("separates sports from support modules in human output", () => {
    const out = runList([], schemaDir);

    assert.match(out, /Sports/);
    assert.match(out, /Support/);
    assert.match(out, /Optional/);
    assert.match(out, /Unknown/);
    assert.match(out, /quidditch/);
    assert.match(out, /polymarket-trading/);
    assert.ok(
      out.includes("6") && out.includes(String(EXPECTED_TOOLS)),
      `expected schema and tool totals in:\n${out}`
    );
  });

  it("says schemas/modules — not sports only — when nothing is installed", () => {
    const out = runList([], emptyDir);
    assert.match(out, /schemas|modules/i);
    assert.doesNotMatch(out, /^No sport schemas installed\.$/m);
  });
});
