import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { sportsclawEngine, summarizeToolOutputForEvidence } from "../dist/engine.js";

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
const input = { userPrompt: "Research up to three distinct leads", draft: "Low scores prove tactical containment.",
  toolOutputs: [{ toolName: "mcp__pod__search_documents", output: "Two recorded games finished 0-0." }],
  callerSystemPrompt: "Keep coverage gaps explicit. Do not generate or publish content. Use Portuguese." };

describe("research verification preserves caller policy", () => {
  it("preserves cited reporting in the middle of a bounded document batch", () => {
    const { engine } = fixture([]);
    const raw = JSON.stringify({ metadata: { context: "a".repeat(7000) },
      news: { headline: "Example defender available for the derby", source_url: "https://example.test/team-news", published_at: "2026-09-08T20:13:00Z" },
      inventory: "z".repeat(7000) });
    assert.doesNotMatch(summarizeToolOutputForEvidence(raw), /Example defender/);
    const snippets = engine.collectToolOutputSnippets([{ toolResults: [{ toolCallId: "news-1", toolName: "mcp__pod__search_documents", output: raw }] }], new Set(["news-1"]), 24000);
    assert.match(snippets[0].output, /Example defender/);
    assert.match(snippets[0].output, /https:\/\/example.test\/team-news/);
    assert.match(snippets[0].output, /2026-09-08T20:13:00Z/);
    assert.ok(snippets[0].output.length <= 24000);
  });
  it("bounds the larger verification context and excludes unsuccessful outputs", () => {
    const { engine } = fixture([]);
    const raw = "start-" + "x".repeat(30_000) + "-end";
    for (const maxChars of [24_000, 100_000]) {
      const output = summarizeToolOutputForEvidence(raw, maxChars);
      assert.equal(output.length, 24_000);
      assert.ok(output.startsWith("start-") && output.endsWith("-end"));
      assert.match(output, /truncated middle/);
    }
    assert.equal(summarizeToolOutputForEvidence(raw, NaN).length, 4_000);
    assert.deepEqual(engine.collectToolOutputSnippets([{ toolResults: [
      { toolCallId: "failed-news", toolName: "news", output: raw },
    ] }], new Set(), 24_000), []);
  });
  it("keeps the internal JSON verdict contract after caller-facing prose instructions", async () => {
    const { engine, model } = fixture(['{"isValid":true,"discrepancies":[]}']);
    await engine.validateResponseEvidence({ ...input, callerSystemPrompt: "Answer in Portuguese prose. End after the useful brief." });
    const system = model.doGenerateCalls[0].prompt.find((entry) => entry.role === "system").content;
    assert.ok(system.lastIndexOf("Return only the JSON verdict") > system.indexOf("End after the useful brief."));
    assert.match(system, /Missing optional coverage does not invalidate/);
    assert.match(system, /Headline-only evidence supports only its explicit claim/);
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
    assert.match(prompt, /cite genuine publishers and URLs/);
    assert.doesNotMatch(prompt, /never cite, name, or reference this source/);
  });
  for (const reply of ["not JSON", "{}", '{"isValid":"true","discrepancies":[]}', '{"isValid":false,"discrepancies":[]}', '{"isValid":true,"discrepancies":[{"claim":"x","evidence":"y","severity":"high"}]}']) {
    it(`does not return unverified claims for ${reply}`, async () => {
      const { engine } = fixture([reply]);
      assert.notEqual(await engine.validateResponseEvidence(input), input.draft);
    });
  }
  it("checks qualitative premises and preserves caller constraints in the verification pass", async () => {
    const { engine, model } = fixture(['{"isValid":true,"discrepancies":[]}']);
    await engine.validateResponseEvidence(input);
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
    assert.match(prompt, /Keep coverage gaps explicit/);
    assert.match(prompt, /causal|tactical/i);
    assert.match(prompt, /distinct|repetiti/i);
  });
  it("rechecks a correction and refuses it if still unsupported", async () => {
    const invalid = JSON.stringify({ isValid: false, discrepancies: [{ claim: "tactics", evidence: "scores only", severity: "high" }] });
    const { engine, model } = fixture([invalid, input.draft, invalid]);
    assert.notEqual(await engine.validateResponseEvidence(input), input.draft);
    assert.equal(model.doGenerateCalls.length, 3);
    for (const call of model.doGenerateCalls) assert.match(JSON.stringify(call.prompt), /Keep coverage gaps explicit/);
  });
  it("failure cleanup retains missing coverage rather than hiding it", async () => {
    const { engine, model } = fixture(["News is unavailable."]);
    await engine.applyEvidenceGate({ ...input, failedTools: ["news"], succeededTools: ["event"], maxOutputTokens: 200 });
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
    assert.match(prompt, /Keep coverage gaps explicit/);
    assert.doesNotMatch(prompt, /skip missing sections silently/);
    assert.match(prompt, /beside affected claims/);
  });
  it("retains a valid supported answer", async () => {
    const { engine } = fixture(['{"isValid":true,"discrepancies":[]}']);
    const supported = { ...input, draft: "Two recorded games finished 0-0." };
    assert.equal(await engine.validateResponseEvidence(supported), supported.draft);
  });
  it("returns a correction only after a valid second check", async () => {
    const invalid = JSON.stringify({ isValid: false, discrepancies: [{ claim: "tactics", evidence: "scores only", severity: "high" }] });
    const { engine, model } = fixture([invalid, "Two recorded games finished 0-0.", '{"isValid":true,"discrepancies":[]}']);
    assert.equal(await engine.validateResponseEvidence(input), "Two recorded games finished 0-0.");
    assert.equal(model.doGenerateCalls.length, 3);
  });
  it("never makes an action receipt up when validation is unavailable", async () => {
    const { engine } = fixture(["invalid"]);
    assert.doesNotMatch(await engine.validateResponseEvidence(input), /executed|saved|created|published/i);
  });
  it("does not begin verification after the caller deadline", async () => {
    const { engine, model } = fixture([]);
    const signal = AbortSignal.abort();
    assert.notEqual(await engine.validateResponseEvidence({ ...input, abortSignal: signal }), input.draft);
    assert.equal(model.doGenerateCalls.length, 0);
  });
});
