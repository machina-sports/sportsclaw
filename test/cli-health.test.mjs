import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpManager } from "../dist/mcp.js";

describe("McpManager getHealthDetails", () => {
  it("returns details about configured MCP servers", () => {
    const manager = new McpManager(false, false);
    const details = manager.getHealthDetails();
    assert(Array.isArray(details));
    for (const item of details) {
      assert.strictEqual(typeof item.name, "string");
      assert.strictEqual(typeof item.connected, "boolean");
      assert.strictEqual(typeof item.url, "string");
      assert.strictEqual(typeof item.failures, "number");
      assert.strictEqual(typeof item.toolsDiscovered, "number");
    }
  });
});

describe("sportsclaw health schema catalog", () => {
  it("keeps schemasInstalled and adds installed sport/support totals plus catalog", () => {
    const home = mkdtempSync(join(tmpdir(), "sportsclaw-health-"));
    const schemaDir = join(home, ".sportsclaw", "schemas");
    mkdirSync(schemaDir, { recursive: true });
    const fixture = (sport) => ({ sport, tools: [] });
    for (const sport of ["nba", "nfl", "kalshi"]) {
      writeFileSync(join(schemaDir, `${sport}.json`), JSON.stringify(fixture(sport)));
    }
    try {
      let output;
      try {
        output = execFileSync(process.execPath, ["dist/index.js", "health", "--json"], {
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: home,
            SPORTSCLAW_PROVIDER: "openai",
            OPENAI_API_KEY: "health-test-key",
            SPORTSCLAW_SKILLS: "nba",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        output = err.stdout;
      }
      const payload = JSON.parse(output);
      assert.equal(payload.schemasInstalled, 3);
      assert.equal(payload.sportsInstalled, 2);
      assert.equal(payload.supportModulesInstalled, 1);
      assert.deepEqual(payload.schemaCatalog.defaultSports, ["nba", "nfl"]);
      assert.deepEqual(payload.schemaCatalog.defaultSupport, ["kalshi"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
