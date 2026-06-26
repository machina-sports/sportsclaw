/**
 * Builtin Tools Modular Structure — Test Suite
 *
 * Verifies that:
 *  1. BUILTIN_TOOLS array correctly registers and exposes sports_query, sports_intelligence_snapshot, and machina_loop.
 *  2. Each tool conforms to the BuiltinTool interface and carries a valid ToolSpec.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BUILTIN_TOOLS } from "../dist/tools/index.js";

describe("Builtin Tools Modular Registry", () => {
  it("should have correct builtin tools registered", () => {
    assert.strictEqual(BUILTIN_TOOLS.length, 3, "Should have exactly three builtin tools registered");

    const names = BUILTIN_TOOLS.map(t => t.spec.name);
    assert.ok(names.includes("sports_query"), "Should register sports_query");
    assert.ok(names.includes("sports_intelligence_snapshot"), "Should register sports_intelligence_snapshot");
    assert.ok(names.includes("machina_loop"), "Should register machina_loop");
  });

  it("should carry valid specifications and executable handlers", () => {
    for (const tool of BUILTIN_TOOLS) {
      assert.ok(tool.spec, "Tool must carry a specification object");
      assert.ok(tool.spec.name, "Tool spec must have a name");
      assert.ok(typeof tool.spec.description === "string" && tool.spec.description.length > 0, "Tool spec must have a description");
      assert.ok(tool.spec.input_schema || tool.spec.parameters, "Tool spec must have an input schema");
      assert.ok(typeof tool.execute === "function", "Tool must carry an execute function");
    }
  });
});
