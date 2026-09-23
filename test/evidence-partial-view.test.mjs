// #172: the evidence verifier must know when it sees only part of the data the
// draft was written from, so absence from a truncated source can't overturn a
// correct answer — while visible contradictions still count.
import assert from "node:assert/strict";
import test from "node:test";

import { MockLanguageModelV3 } from "ai/test";

import { isTruncatedEvidence, sportsclawEngine, summarizeToolOutputForEvidence } from "../dist/engine.js";
import { DEFAULT_CONFIG } from "../dist/types.js";

function verifier(verdicts) {
  const queue = [...verdicts];
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(queue.shift() ?? { isValid: true, discrepancies: [] }) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 1, noCache: 1 }, outputTokens: { total: 1, text: 1 } },
      warnings: [],
    }),
  });
}

function engineWith(model) {
  const engine = Object.create(sportsclawEngine.prototype);
  engine.config = { ...DEFAULT_CONFIG, thinkingBudget: 0, evidenceVerifier: {} };
  engine.mainModel = model;
  engine._evidenceReceipts = [];
  return engine;
}

const systemOf = (call) => call.prompt.find((m) => m.role === "system")?.content ?? "";
const userOf = (call) => call.prompt.filter((m) => m.role === "user").flatMap((m) => m.content).map((p) => p.text).join("\n");

test("isTruncatedEvidence recognises both truncation markers", () => {
  const long = JSON.stringify({ games: Array.from({ length: 900 }, (_, i) => ({ i, date: `2025-12-${i}` })) });
  const cut = summarizeToolOutputForEvidence(long, 24_000);
  assert.ok(cut.length < long.length);
  assert.equal(isTruncatedEvidence(cut), true, "middle dropped by the evidence summarizer");
  assert.equal(isTruncatedEvidence("rows...\n\n[... output truncated: showing 30,000 of 61,483 chars. Re-query]"), true);
  assert.equal(isTruncatedEvidence('{"games":[1,2,3]}'), false);
});

test("a truncated source is labelled and the verifier is told absence is not a discrepancy", async () => {
  const model = verifier([{ isValid: true, discrepancies: [] }]);
  const engine = engineWith(model);
  const out = await engine.validateResponseEvidence({
    userPrompt: "How many games had the Heat won through Dec 31?",
    draft: "18 wins. FINAL: 18",
    toolOutputs: [{ toolName: "nba_get_nbastats_game_log", output: "{...games...}\n...[truncated middle]...\n{...}", truncated: true }],
  });
  assert.equal(out, "18 wins. FINAL: 18");
  const call = model.doGenerateCalls[0];
  assert.match(systemOf(call), /merely not visible in that partial data is NOT a discrepancy/);
  assert.match(userOf(call), /TRUNCATED: part of this output is omitted/);
});

test("a complete view keeps the original strict prompt (no partial-view rule)", async () => {
  const model = verifier([{ isValid: true, discrepancies: [] }]);
  await engineWith(model).validateResponseEvidence({
    userPrompt: "Final score?",
    draft: "Heat 118-112. FINAL: 118-112",
    toolOutputs: [{ toolName: "nba_get_scoreboard", output: '{"home":118,"away":112}', truncated: false }],
  });
  const call = model.doGenerateCalls[0];
  assert.doesNotMatch(systemOf(call), /NOT a discrepancy/);
  assert.doesNotMatch(userOf(call), /TRUNCATED/);
});

test("more sources than the verifier shows also counts as a partial view", async () => {
  const model = verifier([{ isValid: true, discrepancies: [] }]);
  await engineWith(model).validateResponseEvidence({
    userPrompt: "q",
    draft: "a",
    toolOutputs: Array.from({ length: 12 }, (_, i) => ({ toolName: `t${i}`, output: `{"i":${i}}`, truncated: false })),
  });
  const call = model.doGenerateCalls[0];
  assert.match(userOf(call), /2 further source\(s\) were fetched but are not shown/);
  assert.match(systemOf(call), /NOT a discrepancy/);
});

test("visible contradictions on a truncated source still trigger correction", async () => {
  // First verdict flags a contradiction; correction runs; recheck passes.
  const model = new MockLanguageModelV3({
    doGenerate: async ({ prompt }) => {
      const system = prompt.find((m) => m.role === "system")?.content ?? "";
      const verdictCall = /JSON verdict|fact-checker/.test(system);
      const calls = model.doGenerateCalls.length;
      const text = verdictCall
        ? JSON.stringify(calls === 1
          ? { isValid: false, discrepancies: [{ claim: "Heat scored 120", evidence: "data shows 118", severity: "high" }] }
          : { isValid: true, discrepancies: [] })
        : "Heat 118-112. FINAL: 118-112";
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 1, noCache: 1 }, outputTokens: { total: 1, text: 1 } },
        warnings: [],
      };
    },
  });
  const out = await engineWith(model).validateResponseEvidence({
    userPrompt: "Final score?",
    draft: "Heat 120-112. FINAL: 120-112",
    toolOutputs: [{ toolName: "nba_get_scoreboard", output: '{"home":118}\n...[truncated middle]...\n{}', truncated: true }],
  });
  assert.equal(out, "Heat 118-112. FINAL: 118-112", "the contradicted draft was corrected, not waved through");
  assert.ok(model.doGenerateCalls.length >= 3, "verify → correct → recheck");
});
