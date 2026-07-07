import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redactArgs, buildToolExecutionEvent } from "../dist/analytics.js";

describe("tool_execution logging", () => {
  it("redacts credential-like keys and never leaks their values", () => {
    const out = redactArgs({ api_key: "secret", token: "abc", team: "Lakers" });
    const json = JSON.stringify(out);
    assert.ok(!json.includes("secret"));
    assert.ok(!json.includes("abc"));
    assert.ok(json.includes("Lakers"));
    assert.ok(!("api_key" in out));
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
});
