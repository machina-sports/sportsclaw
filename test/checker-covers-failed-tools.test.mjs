// Sports Agent Bench v1-fix: after a rejected argument (e.g. season_type 3)
// the evidence gate, which sees little of the data, turned supported answers
// into UNKNOWN. When tools succeeded, the fact-checker now covers failures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const input = { userPrompt: "q", draft: "d", toolOutputs: [{ toolName: "t", output: "{}", truncated: true }] };

describe("the fact-checker is told which tools failed", () => {
  it("names them and flags values only they could have supplied, even in a partial view", async () => {
    const { engine, model } = fixture([]);
    await engine.validateResponseEvidence({ ...input, failedTools: ["nba_get_nbastats_game_log", "nba_get_nbastats_game_log"] });
    const sys = system(model.doGenerateCalls[0]);
    assert.match(sys, /These tools failed this turn, so their data is not available: nba_get_nbastats_game_log\. /);
    assert.match(sys, /even when the view is partial/);
  });
  it("the retry prompt for an unusable verdict carries the rule too", async () => {
    const { engine, model } = fixture(["not json", '{"isValid":true,"discrepancies":[]}']);
    await engine.validateResponseEvidence({ ...input, failedTools: ["x_tool"] });
    assert.match(system(model.doGenerateCalls[1]), /failed this turn/);
  });
  it("no rule without failures", async () => {
    const { engine, model } = fixture([]);
    await engine.validateResponseEvidence(input);
    assert.doesNotMatch(system(model.doGenerateCalls[0]), /failed this turn/);
  });
});

describe("the evidence gate runs only when the checker cannot cover it (source check)", () => {
  const source = readFileSync(new URL("../dist/engine.js", import.meta.url), "utf8");
  it("skips the gate when tools succeeded and the default checker runs", () => {
    assert.match(source, /successes\.length > 0 && resolveEvidenceVerifierSettings\(this\.config\.evidenceVerifier\)\.provider !== "jev"/);
    assert.match(source, /if \(netFailures\.length > 0 && !checkerCoversFailures\)/);
  });
  it("passes the failures to the checker", () => {
    assert.match(source, /failedTools: netFailures\.map\(\(f\) => f\.toolName\),\s*callerSystemPrompt/);
  });
});
