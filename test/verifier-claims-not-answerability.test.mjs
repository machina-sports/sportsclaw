// Sports Agent Bench v1: the fact-checker flagged correct answers because the
// question "could not be answered" from its view (e.g. a bowler's team, known
// from the roster, was "not specified"), and the correction pass, which never
// got the partial-view rule, rewrote them to UNKNOWN.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { sportsclawEngine } from "../dist/engine.js";

function fixture(replies) {
  const model = new MockLanguageModelV3({ doGenerate: async () => ({
    content: [{ type: "text", text: replies.shift() ?? '{"isValid":true,"discrepancies":[]}' }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [],
  }) });
  const engine = Object.create(sportsclawEngine.prototype);
  engine.mainModel = model;
  engine.config = { verbose: false };
  return { engine, model };
}
const system = (call) => call.prompt.find((m) => m.role === "system").content;
const INVALID = JSON.stringify({ isValid: false, discrepancies: [{ claim: "Kumar economy 9.0", evidence: "team not specified", severity: "high" }] });

describe("fact-checker judges claims, not answerability", () => {
  it("tells the checker not to flag answering and to accept computed values", async () => {
    const { engine, model } = fixture(['{"isValid":true,"discrepancies":[]}']);
    await engine.validateResponseEvidence({ userPrompt: "q", draft: "d", toolOutputs: [{ toolName: "t", output: "{}" }] });
    assert.match(system(model.doGenerateCalls[0]), /never flag a draft for answering instead of declining/);
    assert.match(system(model.doGenerateCalls[0]), /supported when its inputs are in the data/);
  });

  it("the correction keeps unflagged values and gets the partial-view rule when the checker had it", async () => {
    const { engine, model } = fixture([INVALID, "corrected", '{"isValid":true,"discrepancies":[]}']);
    const out = await engine.validateResponseEvidence({
      userPrompt: "q", draft: "d", toolOutputs: [{ toolName: "t", output: "{}", truncated: true }],
    });
    assert.equal(out, "corrected");
    const correction = system(model.doGenerateCalls[1]);
    assert.match(correction, /Fix only the listed discrepancies/);
    assert.match(correction, /NOT a discrepancy/);
  });

  it("no partial-view rule for the correction when the checker saw everything", async () => {
    const { engine, model } = fixture([INVALID, "corrected", '{"isValid":true,"discrepancies":[]}']);
    await engine.validateResponseEvidence({ userPrompt: "q", draft: "d", toolOutputs: [{ toolName: "t", output: "{}", truncated: false }] });
    assert.doesNotMatch(system(model.doGenerateCalls[1]), /NOT a discrepancy/);
  });
});
