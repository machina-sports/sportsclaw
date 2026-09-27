// Sports Agent Bench v1-fix2: with a partial view, checkers still flagged
// "not in the data shown" and the correction turned right answers into
// UNKNOWN. Only contradictions act then, unless a tool failed.
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
const verdict = (kind) => JSON.stringify({ isValid: false, discrepancies: [{ claim: "Canada scored 10", evidence: "not shown", severity: "high", ...(kind ? { kind } : {}) }] });
const partial = { userPrompt: "q", draft: "Canada scored 10.\n\nFINAL: 10", toolOutputs: [{ toolName: "t", output: "{}", truncated: true }] };
const full = { ...partial, toolOutputs: [{ toolName: "t", output: "{}", truncated: false }] };

function traced(engine) {
  engine._lastRunTrace = { offeredTools: [], toolSurfaceSha256: "x", providerWarnings: [], parallelAgents: false };
  return engine;
}

describe("what the checker flags, by view (the draft is never rewritten)", () => {
  it("an unsupported flag on a partial view is dropped: kept", async () => {
    const { engine, model } = fixture([verdict("unsupported")]);
    assert.equal(await traced(engine).verifyWithTrace(partial), partial.draft);
    assert.equal(engine._lastRunTrace.verification.outcome, "kept");
    assert.equal(model.doGenerateCalls.length, 1);
  });
  it("a contradiction on a partial view is flagged; the draft stands and no correction runs", async () => {
    const { engine, model } = fixture([verdict("contradicted")]);
    assert.equal(await traced(engine).verifyWithTrace(partial), partial.draft);
    assert.deepEqual(engine._lastRunTrace.verification, { outcome: "flagged", flaggedClaims: ["Canada scored 10"] });
    assert.equal(model.doGenerateCalls.length, 1);
  });
  it("a flag without a kind counts as a contradiction", async () => {
    const { engine } = fixture([verdict(undefined)]);
    await traced(engine).verifyWithTrace(partial);
    assert.equal(engine._lastRunTrace.verification.outcome, "flagged");
  });
  it("with the full view, unsupported is flagged (traps: values invented from memory)", async () => {
    const { engine } = fixture([verdict("unsupported")]);
    assert.equal(await traced(engine).verifyWithTrace(full), full.draft);
    assert.equal(engine._lastRunTrace.verification.outcome, "flagged");
  });
  it("after a tool failure, unsupported is flagged on a partial view", async () => {
    const { engine } = fixture([verdict("unsupported")]);
    await traced(engine).verifyWithTrace({ ...partial, failedTools: ["nhl_get_game_summary"] });
    assert.equal(engine._lastRunTrace.verification.outcome, "flagged");
  });
  it("the checker is asked for the kind", async () => {
    const { engine, model } = fixture([]);
    await engine.validateResponseEvidence(partial);
    const sys = model.doGenerateCalls[0].prompt.find((m) => m.role === "system").content;
    assert.match(sys, /"kind": "contradicted" \| "unsupported"/);
  });
});
