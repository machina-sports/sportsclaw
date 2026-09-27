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

  it("a flagged draft is kept as written: no correction pass", async () => {
    const { engine, model } = fixture([INVALID]);
    const out = await engine.validateResponseEvidence({
      userPrompt: "q", draft: "d", toolOutputs: [{ toolName: "t", output: "{}", truncated: true }],
    });
    assert.equal(out, "d");
    assert.equal(model.doGenerateCalls.length, 1);
  });
});
