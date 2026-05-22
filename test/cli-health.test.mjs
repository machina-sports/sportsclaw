import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
