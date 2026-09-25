// Sports Agent Bench v1.1 (gemini-3.5-flash): the fact-check call capped output
// at 2000 tokens with no thinking bound; thinking used the budget and the JSON
// verdict ended mid-text (finishReason "length"), so 30 of 487 answers shipped
// unchecked. The thinking share is now bounded and the verdict keeps its own room.
import assert from "node:assert/strict";
import test from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { sportsclawEngine } from "../dist/engine.js";

function engine(config) {
  const model = new MockLanguageModelV3({ doGenerate: async () => ({
    content: [{ type: "text", text: '{"isValid":true,"discrepancies":[]}' }],
    finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [],
  }) });
  const e = Object.create(sportsclawEngine.prototype);
  e.mainModel = model;
  e.config = { verbose: false, ...config };
  return { e, model };
}
const input = { userPrompt: "q", draft: "d", toolOutputs: [{ toolName: "t", output: "{}" }] };

test("the fact-check call bounds thinking and keeps room for the verdict", async () => {
  const { e, model } = engine({ provider: "google", thinkingBudget: 8192 });
  await e.validateResponseEvidence(input);
  const call = model.doGenerateCalls[0];
  assert.equal(call.maxOutputTokens, 4000 + 2048);
  assert.equal(call.providerOptions.google.thinkingConfig.thinkingBudget, 2048);
});

test("a smaller configured thinking budget is kept; none configured sends none", async () => {
  let { e, model } = engine({ provider: "google", thinkingBudget: 512 });
  await e.validateResponseEvidence(input);
  assert.equal(model.doGenerateCalls[0].maxOutputTokens, 4512);
  assert.equal(model.doGenerateCalls[0].providerOptions.google.thinkingConfig.thinkingBudget, 512);
  ({ e, model } = engine({ provider: "google", thinkingBudget: 0 }));
  await e.validateResponseEvidence(input);
  assert.equal(model.doGenerateCalls[0].maxOutputTokens, 4000);
  assert.equal(model.doGenerateCalls[0].providerOptions?.google, undefined);
});
