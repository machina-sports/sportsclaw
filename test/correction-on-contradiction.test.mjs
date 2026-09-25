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

describe("correction acts on contradictions when the view is partial", () => {
  it("an unsupported flag on a partial view keeps the draft, with no correction pass", async () => {
    const { engine, model } = fixture([verdict("unsupported")]);
    assert.equal(await engine.validateResponseEvidence(partial), partial.draft);
    assert.equal(model.doGenerateCalls.length, 1);
  });
  it("a contradiction on a partial view is still corrected", async () => {
    const { engine, model } = fixture([verdict("contradicted"), "Canada scored 9.\n\nFINAL: 9", '{"isValid":true,"discrepancies":[]}']);
    assert.equal(await engine.validateResponseEvidence(partial), "Canada scored 9.\n\nFINAL: 9");
    assert.equal(model.doGenerateCalls.length, 3);
  });
  it("a flag without a kind counts as a contradiction", async () => {
    const { engine, model } = fixture([verdict(undefined), "fixed", '{"isValid":true,"discrepancies":[]}']);
    await engine.validateResponseEvidence(partial);
    assert.equal(model.doGenerateCalls.length, 3);
  });
  it("with the full view, unsupported still acts (traps: values invented from memory)", async () => {
    const { engine, model } = fixture([verdict("unsupported"), "declined", '{"isValid":true,"discrepancies":[]}']);
    assert.equal(await engine.validateResponseEvidence(full), "declined");
    assert.equal(model.doGenerateCalls.length, 3);
  });
  it("after a tool failure, unsupported still acts on a partial view", async () => {
    const { engine, model } = fixture([verdict("unsupported"), "declined", '{"isValid":true,"discrepancies":[]}']);
    assert.equal(await engine.validateResponseEvidence({ ...partial, failedTools: ["nhl_get_game_summary"] }), "declined");
    assert.equal(model.doGenerateCalls.length, 3);
  });
  it("the checker is asked for the kind", async () => {
    const { engine, model } = fixture([]);
    await engine.validateResponseEvidence(partial);
    const sys = model.doGenerateCalls[0].prompt.find((m) => m.role === "system").content;
    assert.match(sys, /"kind": "contradicted" \| "unsupported"/);
  });
});
