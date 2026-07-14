import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { redactArgs, buildToolExecutionEvent, logToolExecution } from "../dist/analytics.js";

describe("tool_execution logging", () => {
  it("redacts credential-like keys and never leaks their values", () => {
    const out = redactArgs({ api_key: "secret", token: "abc", team: "Lakers" });
    const json = JSON.stringify(out);
    assert.ok(!json.includes("secret"));
    assert.ok(!json.includes("abc"));
    assert.ok(json.includes("Lakers"));
    assert.ok(!("api_key" in out));
  });

  it("recursively redacts credential-like keys nested in objects", () => {
    const out = redactArgs({ config: { api_key: "secret", region: "us" }, team: "Lakers" });
    assert.ok(!("api_key" in out.config));
    assert.equal(out.config.region, "us");
    assert.equal(out.team, "Lakers");
    assert.ok(!JSON.stringify(out).includes("secret"));
  });

  it("recursively redacts credential-like keys nested in arrays", () => {
    const out = redactArgs({ items: [{ token: "t1", name: "a" }] });
    assert.ok(!("token" in out.items[0]));
    assert.equal(out.items[0].name, "a");
    assert.ok(!JSON.stringify(out).includes("t1"));
  });

  it("builds an event with a hashed args field and no raw secrets", () => {
    const event = buildToolExecutionEvent({
      ok: false, toolName: "worldcup-get-market-state",
      args: { api_key: "secret", market_id: "kalshi:KX" },
      warnings: [], normalized: false, latencyMs: 122,
      failure: { category: "user_input", severity: "medium", retryable: false, userMessage: "x", developerMessage: "y" },
    }, "2026-07-07T00:00:00Z");
    const json = JSON.stringify(event);
    assert.ok(!json.includes("secret"));
    assert.equal(event.event, "tool_execution");
    assert.equal(event.failure_category, "user_input");
    assert.ok(String(event.args_hash).startsWith("sha256:"));
  });

  it("logToolExecution appends a single redacted JSON line to disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "sportsclaw-tool-exec-"));
    const logPath = join(dir, "tool_executions.jsonl");
    try {
      logToolExecution({
        ok: true,
        toolName: "nfl_scores",
        args: { api_key: "secret", team: "Lakers" },
        warnings: [],
        normalized: false,
        latencyMs: 42,
      }, logPath);

      const raw = readFileSync(logPath, "utf-8");
      const lines = raw.trim().split("\n");
      assert.equal(lines.length, 1);

      const parsed = JSON.parse(lines[0]);
      assert.equal(parsed.event, "tool_execution");
      assert.equal(parsed.tool_name, "nfl_scores");
      assert.ok(String(parsed.args_hash).startsWith("sha256:"));
      assert.ok(!raw.includes("secret"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
