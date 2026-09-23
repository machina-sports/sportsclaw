// Sampling pins must reach every model call of a real engine.run(), and the
// run trace must describe what was observed. Runs in an isolated process with
// a throwaway HOME; the model is a mock, routing and the main loop are real.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const engineUrl = new URL("../dist/engine.js", import.meta.url).href;
const typesUrl = new URL("../dist/types.js", import.meta.url).href;
const aiTestUrl = import.meta.resolve("ai/test");
const aiUrl = import.meta.resolve("ai");

function runIsolated(sampling) {
  const home = mkdtempSync(join(tmpdir(), "sampling-pins-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && !/^(SPORTSCLAW|MACHINA)_/.test(key)));
  env.HOME = home;
  env.SPORTSCLAW_MEMORY_BACKEND = "file";
  env.AI_SDK_LOG_WARNINGS = "false";
  const code = `
    globalThis.AI_SDK_LOG_WARNINGS = false;
    const { MockLanguageModelV3 } = await import(${JSON.stringify(aiTestUrl)});
    const { tool, jsonSchema } = await import(${JSON.stringify(aiUrl)});
    const { sportsclawEngine } = await import(${JSON.stringify(engineUrl)});
    const { DEFAULT_CONFIG } = await import(${JSON.stringify(typesUrl)});
    const model = new MockLanguageModelV3({ doGenerate: async () => ({
      content: [{ type: "text", text: "Final answer with data." }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 10, noCache: 10 }, outputTokens: { total: 5, text: 5 } },
      warnings: [{ type: "unsupported", feature: "seed" }],
      response: { modelId: "mock-served-model" },
    })});
    const engine = Object.create(sportsclawEngine.prototype);
    engine.config = { ...DEFAULT_CONFIG, thinkingBudget: 0, clarifyOnLowConfidence: false,
      skipFanProfile: true, sampling: ${JSON.stringify(sampling)} };
    engine.messages = [];
    engine.mainModel = model;
    engine.mainModelId = "mock-model";
    const specs = [{ name: "nba_get_scores", description: "NBA scores", input_schema: { type: "object", properties: {} } }];
    engine.registry = { getInstalledSkills: () => ["nba"], getAllToolSpecs: () => specs,
      getSkillName: (n) => n.split("_")[0] };
    engine.mcpManager = { serverCount: 0, setUserId() {}, getMachinaServerName: () => undefined,
      getMachinaLoopServer: () => undefined, getToolSpecs: () => [] };
    engine.agents = [];
    engine.skillGuides = [];
    engine.initAsync = async () => {};
    engine.buildTools = () => ({ nba_get_scores: tool({ description: "NBA scores",
      inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => "{}" }) });
    const answer = await engine.run("NBA scores last night");
    console.log(JSON.stringify({
      answer,
      calls: model.doGenerateCalls.map((c) => ({ temperature: c.temperature ?? null, seed: c.seed ?? null })),
      trace: engine.lastRunTrace,
      manifestConfig: engine.manifestConfig,
    }));
  `;
  try {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", code],
      { env, encoding: "utf8", timeout: 30000 });
    return JSON.parse(output.trim().split("\n").at(-1));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("pins reach every model call in a real run and the trace is recorded", () => {
  const out = runIsolated({ temperature: 0, seed: 7 });
  assert.equal(out.answer, "Final answer with data.");
  assert.ok(out.calls.length >= 2, "expected the skill router and the main loop to call the model");
  for (const call of out.calls) assert.deepEqual(call, { temperature: 0, seed: 7 });

  assert.equal(out.trace.servedModelId, "mock-served-model");
  assert.match(out.trace.mainSystemPromptSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(out.trace.offeredTools, ["nba_get_scores"]);
  assert.match(out.trace.toolSurfaceSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(out.trace.providerWarnings, ["unsupported seed"]);
  assert.equal(out.trace.parallelAgents, false);
  assert.deepEqual(out.manifestConfig.sampling, { temperature: 0, seed: 7 });
});

test("without pins no sampling settings are sent, so provider defaults are unchanged", () => {
  const out = runIsolated({});
  assert.ok(out.calls.length >= 2);
  for (const call of out.calls) assert.deepEqual(call, { temperature: null, seed: null });
});

test("the constructor rejects invalid pins before resolving any model", async () => {
  const { sportsclawEngine } = await import(engineUrl);
  assert.throws(() => new sportsclawEngine({ sampling: { temperature: 5 } }), /temperature must be a number between 0 and 2/);
  assert.throws(() => new sportsclawEngine({ sampling: { seed: -1 } }), /seed must be an integer/);
});
