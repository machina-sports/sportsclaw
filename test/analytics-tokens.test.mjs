/**
 * buildQueryEvent — optional token usage fields. When the engine provides
 * usage, the event carries inputTokens/outputTokens; when absent, the
 * fields are simply omitted (no zeros, no NaN).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildQueryEvent } from "../dist/analytics.js";

const BASE = {
  userId: "user1",
  sessionId: "s1",
  promptLength: 24,
  detectedSports: ["nba"],
  toolsCalled: [{ name: "nba_scores", success: true, latencyMs: 800 }],
  totalLatencyMs: 4200,
  clarificationNeeded: false,
};

describe("buildQueryEvent token fields", () => {
  it("includes token counts when usage is provided", () => {
    const event = buildQueryEvent({
      ...BASE,
      usage: { inputTokens: 1200, outputTokens: 340 },
    });
    assert.equal(event.inputTokens, 1200);
    assert.equal(event.outputTokens, 340);
  });

  it("omits token fields when usage is absent", () => {
    const event = buildQueryEvent(BASE);
    assert.equal(event.inputTokens, undefined);
    assert.equal(event.outputTokens, undefined);
  });

  it("keeps all pre-existing fields intact", () => {
    const event = buildQueryEvent(BASE);
    assert.equal(event.sessionId, "s1");
    assert.deepEqual(event.toolsSucceeded, ["nba_scores"]);
    assert.equal(event.success, true);
  });
});
