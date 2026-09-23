// #174: a run's token usage must include every model pass (router, main loop,
// synthesis, verification, ...), not just the main loop, and the per-pass
// breakdown is reported in the run trace.
import assert from "node:assert/strict";
import test from "node:test";

import { MockLanguageModelV3 } from "ai/test";
import { jsonSchema, tool } from "ai";

import { sportsclawEngine } from "../dist/engine.js";
import { DEFAULT_CONFIG } from "../dist/types.js";

function engineWithMock() {
  let n = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async ({ prompt }) => {
      n++;
      const sys = prompt.find((m) => m.role === "system")?.content ?? "";
      const verdict = /fact-checker|JSON verdict/.test(sys);
      const router = /route sports queries/i.test(sys);
      const mainCall = !verdict && !router && !/synthesizer/.test(sys);
      const toolStep = mainCall && !prompt.some((m) => m.role === "tool");
      const content = toolStep
        ? [{ type: "tool-call", toolCallId: "t1", toolName: "nba_get_scoreboard", input: JSON.stringify({ date: "2026-01-01" }) }]
        : [{ type: "text", text: verdict ? '{"isValid":true,"discrepancies":[]}'
          : router ? '{"selected_skills":["nba"],"mode":"focused","confidence":0.9,"reason":"x"}'
          : "The Miami Heat beat the Detroit Pistons 118-112 on January 1, 2026, at home in Miami. FINAL: 118-112" }];
      return {
        content,
        finishReason: { unified: toolStep ? "tool-calls" : "stop", raw: "stop" },
        usage: { inputTokens: { total: 10, noCache: 10 }, outputTokens: { total: 1, text: 1 } },
        warnings: [],
      };
    },
  });
  const engine = Object.create(sportsclawEngine.prototype);
  engine.config = { ...DEFAULT_CONFIG, thinkingBudget: 0, clarifyOnLowConfidence: false, skipFanProfile: true };
  engine.messages = []; engine.mainModel = model; engine.mainModelId = "mock";
  const specs = [{ name: "nba_get_scoreboard", description: "NBA scores", input_schema: { type: "object", properties: { date: { type: "string" } } } }];
  engine.registry = { getInstalledSkills: () => ["nba"], getAllToolSpecs: () => specs, getSkillName: (x) => x.split("_")[0] };
  engine.mcpManager = { serverCount: 0, setUserId() {}, getMachinaServerName: () => undefined, getMachinaLoopServer: () => undefined, getToolSpecs: () => [] };
  engine.agents = []; engine.skillGuides = []; engine.initAsync = async () => {};
  engine.buildTools = () => ({ nba_get_scoreboard: tool({ description: "NBA scores", inputSchema: jsonSchema({ type: "object", properties: { date: { type: "string" } } }),
    execute: async () => JSON.stringify({ events: [{ home: "Heat", home_score: 118, away: "Pistons", away_score: 112 }] }) }) });
  return { engine, model };
}

test("run() usage sums every model pass and the trace breaks it down", async () => {
  const { engine, model } = engineWithMock();
  await engine.run("What was the final score of the Miami Heat game on 2026-01-01?");
  const calls = model.doGenerateCalls.length;
  const usage = engine.lastTokenUsage;
  assert.equal(usage.totalTokens, 11 * calls, "every model call is counted");
  const passes = engine.lastRunTrace.passTokens;
  assert.ok(passes.router > 0 && passes.main > 0 && passes.verification > 0, JSON.stringify(passes));
  assert.equal(Object.values(passes).reduce((a, b) => a + b, 0), usage.totalTokens);
  assert.ok(usage.totalTokens > passes.main, "the main loop alone understates the run");
});

test("usage resets between runs (each run counts only its own calls)", async () => {
  const { engine, model } = engineWithMock();
  await engine.run("Heat score on 2026-01-01?");
  const before = model.doGenerateCalls.length;
  await engine.run("Heat score on 2026-01-01?");
  const secondCalls = model.doGenerateCalls.length - before;
  assert.equal(engine.lastTokenUsage.totalTokens, 11 * secondCalls);
});
