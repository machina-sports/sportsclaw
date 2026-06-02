import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { EXAMPLES, TOOL_USE } from "../dist/prompts/sections.js";

describe("prompt source attribution", () => {
  it("does not instruct the model to append a source footer", () => {
    assert.ok(!/End your answer with .*Source:/i.test(TOOL_USE));
    assert.ok(!/\*Source:/i.test(TOOL_USE));
  });

  it("examples do not teach source footers", () => {
    assert.ok(!/\*Source:/i.test(EXAMPLES));
  });
});
