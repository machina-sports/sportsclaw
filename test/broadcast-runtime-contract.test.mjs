import assert from "node:assert/strict";
import { test } from "node:test";
import { McpManager } from "../dist/mcp.js";
import { MemoryManager } from "../dist/memory.js";
import { buildOneShotRunOptions } from "../dist/index.js";
import { sportsclawEngine } from "../dist/engine.js";
import { MockLanguageModelV3 } from "ai/test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("capability discovery accepts actual singular workflow name and legacy plural", async () => {
  for (const name of ["search_workflow", "search_workflows"]) {
    const manager = new McpManager();
    manager.routeMap.set(`mcp__pod__${name}`, {});
    const calls = [];
    manager.callTool = async (tool) => {
      calls.push(tool);
      return { content: JSON.stringify([{ name: "generate-poll-bank" }]), isError: false };
    };
    await manager.discoverCapabilities("pod");
    assert.deepEqual(calls, [`mcp__pod__${name}`]);
    assert.equal(manager.podCaps.get("pod").workflows[0].name, "generate-poll-bank");
  }
});

test("caller transcript mode preserves durable context without loading daily conversation log", async () => {
  const reads = [];
  const storage = { async read(user, file) {
    reads.push(file);
    return file === "CONTEXT.md" ? "Editorial style: precise" : "";
  } };
  const memory = new MemoryManager("thread", storage);
  const block = await memory.buildMemoryBlock({ includeConversationLog: false });
  assert.match(block, /Editorial style: precise/);
  assert.ok(reads.every(file => !/^\d{4}-/.test(file)));
  const options = buildOneShotRunOptions({ userId: "thread", agentIds: [], delegated: false, historyMode: "caller" });
  assert.equal(options.historyMode, "caller");
  assert.equal(options.userId, "thread");
});

test("reused engine in caller mode neither replays nor saves conversation turns", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "sc-caller-history-"));
  const agents = join(root, "agents");
  const schemas = join(root, "schemas");
  mkdirSync(agents); mkdirSync(schemas);
  writeFileSync(join(agents, "desk.md"), "---\nname: Desk\nskills: []\nactive: true\n---\nAnswer directly.\n");
  const overrides = { SPORTSCLAW_AGENTS_DIR: agents, sportsclaw_SCHEMA_DIR: schemas, SPORTSCLAW_MEMORY_PROVIDER: "file" };
  const old = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const read = t.mock.method(MemoryManager.prototype, "readThread", async () => [{ role: "user", content: "private old turn" }]);
  const append = t.mock.method(MemoryManager.prototype, "appendToThread", async () => {});
  const log = t.mock.method(MemoryManager.prototype, "appendExchange", async () => {});
  t.mock.method(MemoryManager.prototype, "buildMemoryBlock", async () => "Editorial context");
  t.mock.method(MemoryManager.prototype, "readStrategy", async () => "");
  t.mock.method(MemoryManager.prototype, "recallContext", async () => "");
  try {
    const engine = new sportsclawEngine({ clarifyOnLowConfidence: false, thinkingBudget: 0 });
    engine.initAsync = async () => {};
    const model = new MockLanguageModelV3({ doGenerate: async () => ({
      content: [{ type: "text", text: "answer" }], finishReason: { unified: "stop" },
      usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [],
    }) });
    engine.mainModel = model;
    const options = { userId: "caller-test", agentIds: ["desk"], historyMode: "caller" };
    assert.equal(await engine.run("Discuss the first storyline", options), "answer");
    assert.equal(await engine.run("Discuss the second storyline", options), "answer");
    assert.equal(read.mock.callCount(), 0);
    assert.equal(append.mock.callCount(), 0);
    assert.equal(log.mock.callCount(), 0);
    const prompt = JSON.stringify(model.doGenerateCalls.at(-1).prompt);
    assert.ok(!prompt.includes("first storyline"));
    assert.ok(!prompt.includes("private old turn"));
    assert.ok(prompt.includes("Editorial context"));
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
