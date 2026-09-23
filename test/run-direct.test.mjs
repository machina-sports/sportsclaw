// engine.runDirect() is the minimal baseline loop for the benchmark's direct
// and raw-tools arms: it must offer exactly the requested skills' registry
// tools (never built-ins), send the sampling pins, skip routing, and record a
// run trace. Runs a real engine in an isolated process against a mock model.
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

function runIsolated(skills) {
  const home = mkdtempSync(join(tmpdir(), "run-direct-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && !/^(SPORTSCLAW|MACHINA)_/.test(key)));
  env.HOME = home;
  env.SPORTSCLAW_MEMORY_BACKEND = "file";
  const code = `
    globalThis.AI_SDK_LOG_WARNINGS = false;
    const { MockLanguageModelV3 } = await import(${JSON.stringify(aiTestUrl)});
    const { tool, jsonSchema } = await import(${JSON.stringify(aiUrl)});
    const { sportsclawEngine } = await import(${JSON.stringify(engineUrl)});
    const { DEFAULT_CONFIG } = await import(${JSON.stringify(typesUrl)});
    const model = new MockLanguageModelV3({ doGenerate: async () => ({
      content: [{ type: "text", text: "FINAL: UNKNOWN" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 4, noCache: 4 }, outputTokens: { total: 2, text: 2 } },
      warnings: [],
      response: { modelId: "mock-served" },
    })});
    const engine = Object.create(sportsclawEngine.prototype);
    engine.config = { ...DEFAULT_CONFIG, thinkingBudget: 0, sampling: { temperature: 0, seed: 7 } };
    engine.messages = [];
    engine.mainModel = model;
    engine.mainModelId = "mock-model";
    const specs = ["nba_get_scores", "nfl_get_scores", "betting_devig"].map((name) =>
      ({ name, description: name, input_schema: { type: "object", properties: {} } }));
    engine.registry = { getInstalledSkills: () => ["nba", "nfl", "betting"], getAllToolSpecs: () => specs,
      getSkillName: (n) => n.split("_")[0] };
    engine.initAsync = async () => {};
    const mk = (d) => tool({ description: d, inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => "{}" });
    engine.buildTools = () => ({ nba_get_scores: mk("NBA"), nfl_get_scores: mk("NFL"), betting_devig: mk("devig"),
      write_file: mk("Write a file"), execute_command: mk("Run a shell command") });
    const answer = await engine.runDirect("Who won?", { skills: ${JSON.stringify(skills)}, systemPrompt: "caller rule" });
    console.log(JSON.stringify({
      answer,
      calls: model.doGenerateCalls.map((c) => ({
        tools: (c.tools ?? []).map((t) => t.name).sort(),
        temperature: c.temperature ?? null,
        seed: c.seed ?? null,
        system: (c.prompt.find((m) => m.role === "system") || {}).content || "",
      })),
      trace: engine.lastRunTrace,
      usage: engine.lastTokenUsage,
    }));
  `;
  try {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8", timeout: 30000 });
    return JSON.parse(output.trim().split("\n").at(-1));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("raw-tools scope offers exactly the requested skills' data tools, in one routing-free loop", () => {
  const out = runIsolated(["nba", "betting"]);
  assert.equal(out.answer, "FINAL: UNKNOWN");
  assert.equal(out.calls.length, 1, "no router or verification calls");
  assert.deepEqual(out.calls[0].tools, ["betting_devig", "nba_get_scores"]);
  assert.deepEqual([out.calls[0].temperature, out.calls[0].seed], [0, 7]);
  assert.match(out.calls[0].system, /Use the available tools/);
  assert.match(out.calls[0].system, /caller rule/);
  assert.deepEqual(out.trace.offeredTools, ["betting_devig", "nba_get_scores"]);
  assert.equal(out.trace.servedModelId, "mock-served");
  assert.match(out.trace.mainSystemPromptSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(out.usage, { inputTokens: 4, outputTokens: 2, totalTokens: 6 });
});

test("direct scope offers no tools at all, and never built-ins", () => {
  const out = runIsolated([]);
  assert.equal(out.calls.length, 1);
  assert.deepEqual(out.calls[0].tools, []);
  assert.match(out.calls[0].system, /You have no tools/);
  assert.deepEqual(out.trace.offeredTools, []);
});

test("unknown skills yield no tools rather than widening the scope", () => {
  const out = runIsolated(["cricket"]);
  assert.deepEqual(out.calls[0].tools, []);
});
