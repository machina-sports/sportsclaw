// Sports Agent Bench v1: correct short answers were thrown away. A reply
// under 90 characters counted as low-signal, so the engine swapped it for an
// earlier step's narration or re-synthesised it; and a failed
// query_tool_result sent the draft through an evidence gate that could not
// see the data.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { sportsclawEngine } from "../dist/engine.js";

function fixture(replies) {
  const model = new MockLanguageModelV3({ doGenerate: async () => ({
    content: [{ type: "text", text: replies.shift() ?? "ok" }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [],
  }) });
  const engine = Object.create(sportsclawEngine.prototype);
  engine.mainModel = model;
  engine.config = { verbose: false };
  return { engine, model };
}

describe("short answers that state a fact are not low-signal", () => {
  const { engine } = fixture([]);
  it("keeps numbers and names", () => {
    for (const text of [
      "The Tempo won 7 home games.\n\nFINAL: 7",
      "FINAL: Nottingham Forest",
      "Louisville gained the most AP poll points.",
      "Canada won 5-1.",
    ]) assert.equal(engine.isLowSignalResponse(text), false, text);
  });
  it("still flags filler", () => {
    for (const text of ["", "Done!", "Got it, thanks.", "Want me to drill into that?", "I updated your fan profile, André!"]) {
      assert.equal(engine.isLowSignalResponse(text), true, text);
    }
  });
});

describe("evidence gate", () => {
  it("sees the successful outputs and is told to keep supported claims", async () => {
    const { engine, model } = fixture(["cleaned"]);
    await engine.applyEvidenceGate({
      userPrompt: "What is the venue capacity?", draft: "132,000.", failedTools: ["cricket_get_news"],
      succeededTools: ["cricket_get_game_summary"], maxOutputTokens: 200,
      toolOutputs: [{ toolName: "cricket_get_game_summary", output: '{"venue":{"capacity":132000}}' }],
    });
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
    assert.match(prompt, /capacity\\":132000/);
    assert.match(prompt, /support stays unchanged/);
    assert.doesNotMatch(prompt, /cricket_get_game_summary output/, "tool names stay out of the evidence labels");
  });
  it("still runs without outputs", async () => {
    const { engine, model } = fixture(["cleaned"]);
    assert.equal(await engine.applyEvidenceGate({
      userPrompt: "q", draft: "d", failedTools: ["a"], succeededTools: [], maxOutputTokens: 200,
    }), "cleaned");
    assert.doesNotMatch(JSON.stringify(model.doGenerateCalls[0].prompt), /Successful tool outputs/);
  });
  it("is not triggered by a failed query_tool_result (source check)", () => {
    const source = readFileSync(new URL("../dist/engine.js", import.meta.url), "utf8");
    assert.match(source, /!succeededToolNames\.has\(f\.toolName\) && f\.toolName !== QUERY_TOOL_RESULT_TOOL/);
  });
});
