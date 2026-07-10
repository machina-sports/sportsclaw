import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyFailure } from "../dist/failures/classifier.js";

// Behavioral contract used by ToolRegistry.execute's failure branch:
// a raw provider error is turned into a clean, actionable user message.
describe("tool failure classification contract", () => {
  it("produces an actionable message for a rate limit", () => {
    const f = classifyFailure("429 too many requests", "nba_get_scoreboard");
    assert.equal(f.category, "rate_limited");
    assert.ok(/retry/i.test(f.userMessage));
    assert.ok(f.developerMessage.includes("nba_get_scoreboard"));
  });
});
