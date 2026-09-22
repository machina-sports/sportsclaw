// The tool allowlist must restrict what the model is actually offered in a
// real engine.run(), and listDataToolNames() must exclude built-in tools.
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

function runIsolated(allowlist) {
  const home = mkdtempSync(join(tmpdir(), "tool-allowlist-"));
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
      content: [{ type: "text", text: "done" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 1, noCache: 1 }, outputTokens: { total: 1, text: 1 } },
      warnings: [],
    })});
    const engine = Object.create(sportsclawEngine.prototype);
    engine.config = { ...DEFAULT_CONFIG, thinkingBudget: 0, clarifyOnLowConfidence: false, skipFanProfile: true };
    engine.messages = [];
    engine.mainModel = model;
    engine.mainModelId = "mock-model";
    const specs = [
      { name: "nba_get_scores", description: "NBA scores", input_schema: { type: "object", properties: {} } },
      { name: "nfl_get_scores", description: "NFL scores", input_schema: { type: "object", properties: {} } },
    ];
    engine.registry = { getInstalledSkills: () => ["nba", "nfl"], getAllToolSpecs: () => specs,
      getSkillName: (n) => n.split("_")[0] };
    engine.mcpManager = { serverCount: 0, setUserId() {}, getMachinaServerName: () => undefined,
      getMachinaLoopServer: () => undefined, getToolSpecs: () => [] };
    engine.agents = [];
    engine.skillGuides = [];
    engine.initAsync = async () => {};
    const mk = (d) => tool({ description: d, inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => "{}" });
    engine.buildTools = () => ({ nba_get_scores: mk("NBA scores"), nfl_get_scores: mk("NFL scores"),
      write_file: mk("Write a file"), execute_command: mk("Run a shell command") });
    const listed = { all: engine.listToolNames(), data: engine.listDataToolNames() };
    engine.setToolAllowlist(${JSON.stringify(allowlist)});
    await engine.run("NBA and NFL scores last night");
    const offeredPerCall = model.doGenerateCalls
      .map((c) => (c.tools ?? []).map((t) => t.name).sort())
      .filter((names) => names.length > 0);
    console.log(JSON.stringify({ listed, offeredPerCall, trace: engine.lastRunTrace, allowlist: engine.manifestConfig.toolAllowlist }));
  `;
  try {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8", timeout: 30000 });
    return JSON.parse(output.trim().split("\n").at(-1));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("listDataToolNames excludes built-in tools; listToolNames includes them", () => {
  const out = runIsolated(null);
  assert.deepEqual(out.listed.all, ["execute_command", "nba_get_scores", "nfl_get_scores", "write_file"]);
  assert.deepEqual(out.listed.data, ["nba_get_scores", "nfl_get_scores"]);
});

test("an allowlist restricts the tools the model is actually offered", () => {
  const out = runIsolated(["nba_get_scores"]);
  assert.ok(out.offeredPerCall.length > 0, "the main loop offered tools");
  for (const names of out.offeredPerCall) assert.deepEqual(names, ["nba_get_scores"]);
  assert.deepEqual(out.trace.offeredTools, ["nba_get_scores"]);
  assert.deepEqual(out.allowlist, ["nba_get_scores"]);
});

test("without an allowlist, built-in tools remain available (default behavior unchanged)", () => {
  const out = runIsolated(null);
  assert.equal(out.allowlist, null);
  assert.ok(out.trace.offeredTools.includes("nba_get_scores"));
});
