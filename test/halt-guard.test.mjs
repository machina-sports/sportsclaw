/**
 * isHalt — type guard for engine-halting sentinel errors.
 *
 * Tool-wrapper catch blocks in engine.ts must re-throw halts so the
 * listener can render the appropriate UI (clarifying question / approval
 * prompt). Without the guard they would be converted into normal error
 * strings and the halt mechanism breaks silently.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isHalt, AskUserQuestionHalt } from "../dist/index.js";
import { ApprovalPendingHalt } from "../dist/approval.js";

describe("isHalt", () => {
  it("returns true for AskUserQuestionHalt", () => {
    // Constructor accesses .prompt for the super() message; rest of the
    // request fields don't matter for the guard.
    const e = new AskUserQuestionHalt({ prompt: "?" });
    assert.equal(isHalt(e), true);
  });

  it("returns true for ApprovalPendingHalt", () => {
    // Constructor accesses .action and .description for super(); rest unused.
    const e = new ApprovalPendingHalt({ action: "trade", description: "place order" });
    assert.equal(isHalt(e), true);
  });

  it("returns false for a plain Error", () => {
    assert.equal(isHalt(new Error("boom")), false);
  });

  it("returns false for a TypeError subclass", () => {
    assert.equal(isHalt(new TypeError("bad type")), false);
  });

  it("returns false for non-Error values", () => {
    assert.equal(isHalt("string"), false);
    assert.equal(isHalt(42), false);
    assert.equal(isHalt(null), false);
    assert.equal(isHalt(undefined), false);
    assert.equal(isHalt({ message: "looks like an error" }), false);
  });
});
