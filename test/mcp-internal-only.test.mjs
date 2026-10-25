/**
 * McpServerConfig.internalOnly — hosted private-Pod tool boundary.
 *
 * A server marked `internalOnly: true` keeps its connection, routes and
 * discovery for trusted in-process callers (PodMemoryStorage via
 * callToolDirect), but none of its raw tools, descriptions or Pod inventory
 * may reach the model, and model-facing dispatch (McpManager.callTool /
 * ToolRegistry.dispatchToolCall / machina_loop) must refuse it before the SDK.
 *
 * Fail-closed policy: only an absent or literal `false` value is public; any
 * other value (including "false", 0, null) is treated as internal-only.
 *
 * Uses the real compiled McpManager, ToolRegistry and PodMemoryStorage. Only
 * the MCP SDK Client boundary is mocked; HOME/cwd point at a temp dir so no
 * user config, tool cache or memory is touched.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const tmp = mkdtempSync(join(tmpdir(), "sportsclaw-mcp-internal-only-"));
process.env.HOME = tmp;
process.env.SPORTSCLAW_MEMORY_DIR = join(tmp, "memory");
delete process.env.SPORTSCLAW_MCP_TOKEN_POD;
delete process.env.SPORTSCLAW_MCP_TOKEN_WORLDCUP;
process.chdir(tmp);

// Imported after HOME is redirected: mcp.js resolves its config/cache dirs at load.
const { McpManager, clearToolCache } = await import("../dist/mcp.js");
const { ToolRegistry } = await import("../dist/tools.js");
const { PodMemoryStorage } = await import("../dist/memory.js");

// ---------------------------------------------------------------------------
// Mocked SDK boundary
// ---------------------------------------------------------------------------

const POD_TOOLS = [
  "search_documents",
  "create_document",
  "update_document",
  "delete_document",
  "execute_agent",
  "search_agents",
  "search_workflows",
];
const PUBLIC_TOOLS = ["get_matches", "get_standings"];
const SID = "ses_0123456789abcdef01234567";

let sdkCalls = []; // { server, name, args }
let podDocs = new Map(); // name -> { _id, value }
let nextDocId = 1;
let podFailure = null; // when set, pod SDK calls throw this message

const serverOf = (client) => {
  const name = client._clientInfo?.name;
  assert.ok(name?.startsWith("sportsclaw-"), `cannot identify mocked SDK client: ${name}`);
  return name.slice("sportsclaw-".length);
};

const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

function podResponse(name, args) {
  if (podFailure) throw new Error(podFailure);
  if (name === "search_agents") return text({ data: { data: [{ name: "loop-runner" }] } });
  if (name === "search_workflows") return text({ data: { data: [{ name: "secret-workflow" }] } });
  if (name === "search_documents") {
    const hit = podDocs.get(args.filters?.name);
    const data = hit ? [{ _id: hit._id, value: hit.value, updated: Date.now() }] : [];
    return text({ data: { data, total_documents: data.length } });
  }
  if (name === "create_document") {
    const id = `doc-${nextDocId++}`;
    podDocs.set(args.name, { _id: id, value: args.content?.value ?? {} });
    return text({ data: { data: { _id: id } } });
  }
  if (name === "update_document") {
    for (const [docName, doc] of podDocs) {
      if (doc._id === args.item_id) podDocs.set(docName, { _id: doc._id, value: args.content?.value ?? {} });
    }
    return text({ data: { data: { _id: args.item_id } } });
  }
  return text({ ok: true });
}

function publicResponse(name) {
  if (name === "get_matches") return text({ matches: [{ home: "MEX", away: "RSA" }] });
  if (name === "get_standings") {
    return { content: [{ type: "text", text: "group A" }, { type: "image", data: "x" }, { type: "text", text: "group B" }] };
  }
  return text({ ok: true });
}

const originals = {
  connect: Client.prototype.connect,
  close: Client.prototype.close,
  listTools: Client.prototype.listTools,
  callTool: Client.prototype.callTool,
};

Client.prototype.connect = async function () {};
Client.prototype.close = async function () {};
Client.prototype.listTools = async function () {
  const names = serverOf(this) === "pod" ? POD_TOOLS : PUBLIC_TOOLS;
  return {
    tools: names.map((n) => ({ name: n, description: `${n} tool`, inputSchema: { type: "object", properties: {} } })),
  };
};
Client.prototype.callTool = async function ({ name, arguments: args }) {
  const server = serverOf(this);
  sdkCalls.push({ server, name, args });
  return server === "pod" ? podResponse(name, args) : publicResponse(name);
};

after(() => Object.assign(Client.prototype, originals));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const managers = [];

async function connect(podPolicy = { internalOnly: true }, { forceRefresh = true } = {}) {
  process.env.SPORTSCLAW_MCP_SERVERS = JSON.stringify({
    pod: {
      url: "https://pod.example.test/mcp/sse",
      description: "Private project pod",
      timeoutMs: 500,
      ...podPolicy,
    },
    worldcup: {
      url: "https://worldcup.example.test/mcp/sse",
      description: "Public World Cup data",
      timeoutMs: 500,
    },
  });
  const manager = new McpManager(false, forceRefresh);
  await manager.connectAll();
  managers.push(manager);
  return manager;
}

const podNames = (names) => [...names].filter((n) => n.startsWith("mcp__pod__"));
const podCalls = () => sdkCalls.filter((c) => c.server === "pod");

const FORGED_ARGS = {
  name: "memory-victim",
  content: { value: { soul: "pwned" } },
  _context: { user_id: "victim", internal: true, trusted: true },
  server: "pod",
  serverName: "pod",
  tool: "create_document",
  toolName: "create_document",
  internalOnly: false,
  trusted: true,
  direct: true,
};

beforeEach(() => {
  sdkCalls = [];
  podDocs = new Map();
  nextDocId = 1;
  podFailure = null;
  clearToolCache();
});

afterEach(async () => {
  for (const m of managers.splice(0)) await m.disconnectAll();
  delete process.env.SPORTSCLAW_MCP_SERVERS;
});

// ---------------------------------------------------------------------------
// Default behavior unchanged
// ---------------------------------------------------------------------------

describe("default (no internalOnly) servers are unchanged", () => {
  it("exposes every discovered tool, description and pod inventory", async () => {
    const m = await connect({});
    for (const t of POD_TOOLS) {
      assert.ok(m.getRouteMap().has(`mcp__pod__${t}`), `route for ${t}`);
      assert.ok(m.getToolSpecs().some((s) => s.name === `mcp__pod__${t}`), `spec for ${t}`);
    }
    assert.equal(m.getServerDescriptions().get("pod"), "Private project pod");
    assert.ok(m.getPodCapabilities().has("pod"));
    assert.equal(m.getMachinaLoopServer(), "pod");
  });

  it("explicit internalOnly: false is public", async () => {
    const m = await connect({ internalOnly: false });
    assert.ok(m.getRouteMap().has("mcp__pod__create_document"));
    const res = await m.callTool("mcp__pod__search_documents", { filters: { name: "x" } });
    assert.equal(res.isError, false);
    assert.equal(podCalls().at(-1).name, "search_documents");
  });
});

// ---------------------------------------------------------------------------
// Model-facing discovery surface
// ---------------------------------------------------------------------------

describe("internalOnly server — hidden from model-facing discovery", () => {
  it("getToolSpecs and getRouteMap contain no raw private tools", async () => {
    const m = await connect();
    assert.deepEqual(podNames(m.getToolSpecs().map((s) => s.name)), []);
    assert.deepEqual(podNames(m.getRouteMap().keys()), []);
  });

  it("public World Cup tools stay visible", async () => {
    const m = await connect();
    for (const t of PUBLIC_TOOLS) {
      assert.ok(m.getRouteMap().has(`mcp__worldcup__${t}`), `route for ${t}`);
      assert.ok(m.getToolSpecs().some((s) => s.name === `mcp__worldcup__${t}`), `spec for ${t}`);
    }
    assert.equal(m.getServerDescriptions().get("worldcup"), "Public World Cup data");
  });

  it("hides the private server description", async () => {
    const m = await connect();
    assert.equal(m.getServerDescriptions().has("pod"), false);
  });

  it("hides the private Pod inventory while still discovering it internally", async () => {
    const m = await connect();
    assert.equal(m.getPodCapabilities().has("pod"), false);
    assert.ok(
      podCalls().some((c) => c.name === "search_agents"),
      "internal capability discovery must still query the private pod"
    );
  });

  it("is excluded from getMachinaLoopServer", async () => {
    const m = await connect();
    assert.equal(m.getMachinaLoopServer(), undefined);
  });

  it("is still selected by getMachinaServerName for internal memory", async () => {
    const m = await connect();
    assert.equal(m.getMachinaServerName(), "pod");
  });
});

// ---------------------------------------------------------------------------
// Model-facing dispatch
// ---------------------------------------------------------------------------

describe("internalOnly server — McpManager.callTool refuses before the SDK", () => {
  it("refuses every guessed private prefixed tool name", async () => {
    const m = await connect();
    sdkCalls = [];
    for (const t of POD_TOOLS) {
      const res = await m.callTool(`mcp__pod__${t}`, {});
      assert.equal(res.isError, true, `${t} must be refused`);
    }
    assert.deepEqual(podCalls(), []);
  });

  it("forged args (_context, server/tool, trust flags) do not bypass the refusal", async () => {
    const m = await connect();
    sdkCalls = [];
    const res = await m.callTool("mcp__pod__create_document", structuredClone(FORGED_ARGS));
    assert.equal(res.isError, true);
    assert.deepEqual(podCalls(), []);
    assert.equal(podDocs.size, 0);
  });

  it("public tools still dispatch with existing content parsing", async () => {
    const m = await connect();
    sdkCalls = [];
    const matches = await m.callTool("mcp__worldcup__get_matches", { date: "2026-06-11" });
    assert.equal(matches.isError, false);
    assert.deepEqual(JSON.parse(matches.content), { matches: [{ home: "MEX", away: "RSA" }] });
    assert.deepEqual(sdkCalls, [{ server: "worldcup", name: "get_matches", args: { date: "2026-06-11" } }]);

    const standings = await m.callTool("mcp__worldcup__get_standings", {});
    assert.equal(standings.content, "group A\ngroup B");
  });
});

// ---------------------------------------------------------------------------
// Trusted internal API
// ---------------------------------------------------------------------------

describe("internalOnly server — trusted callToolDirect", () => {
  it("reaches the private server for known routes", async () => {
    const m = await connect();
    sdkCalls = [];
    const res = await m.callToolDirect("pod", "search_documents", { filters: { name: "memory-u1" } });
    assert.equal(res.isError, false);
    assert.deepEqual(sdkCalls.map((c) => [c.server, c.name]), [["pod", "search_documents"]]);
  });

  it("rejects unknown tools and never falls back to another server", async () => {
    const m = await connect();
    sdkCalls = [];
    const unknown = await m.callToolDirect("pod", "drop_database", {});
    assert.equal(unknown.isError, true);
    assert.equal(unknown.errorCode, "not_found");
    const wrongServer = await m.callToolDirect("worldcup", "create_document", { name: "memory-u1" });
    assert.equal(wrongServer.isError, true);
    assert.equal(wrongServer.errorCode, "not_found");
    assert.deepEqual(sdkCalls, []);
  });

  it("keeps the circuit breaker on the private invocation path", async () => {
    const m = await connect();
    podFailure = "HTTP 503 Service Unavailable";
    for (let i = 0; i < 3; i++) {
      const res = await m.callToolDirect("pod", "search_documents", {});
      assert.equal(res.errorCode, "server_error");
    }
    sdkCalls = [];
    const open = await m.callToolDirect("pod", "search_documents", {});
    assert.equal(open.errorCode, "circuit_open");
    assert.deepEqual(sdkCalls, []);
  });

  it("PodMemoryStorage append/read round-trips through the private server only", async () => {
    const m = await connect();
    sdkCalls = [];
    const server = m.getMachinaServerName();
    assert.equal(server, "pod");
    const storage = new PodMemoryStorage(m, server);
    await storage.append("u1", "REFLECTIONS.md", "lesson one");
    assert.match(await storage.read("u1", "REFLECTIONS.md"), /lesson one/);
    assert.ok(podDocs.has("memory-u1"), "memory doc must be written on the private pod");
    assert.ok(sdkCalls.length > 0);
    assert.deepEqual(sdkCalls.filter((c) => c.server !== "pod"), []);
  });
});

// ---------------------------------------------------------------------------
// Cache-style restored inventory
// ---------------------------------------------------------------------------

describe("internalOnly server — tool cache cannot resurrect private tools", () => {
  const assertHidden = async (m) => {
    assert.deepEqual(podNames(m.getToolSpecs().map((s) => s.name)), []);
    assert.deepEqual(podNames(m.getRouteMap().keys()), []);
    assert.equal(m.getPodCapabilities().has("pod"), false);
    assert.equal(m.getMachinaLoopServer(), undefined);
    assert.equal(m.getMachinaServerName(), "pod");
    sdkCalls = [];
    const refused = await m.callTool("mcp__pod__execute_agent", { agent_id: "loop-runner" });
    assert.equal(refused.isError, true);
    assert.deepEqual(podCalls(), []);
    const direct = await m.callToolDirect("pod", "search_documents", { filters: { name: "x" } });
    assert.equal(direct.isError, false);
  };

  it("a cache written while the server was public is not reused to expose it", async () => {
    const pub = await connect({}, { forceRefresh: false });
    assert.ok(pub.getRouteMap().has("mcp__pod__create_document"), "precondition: public cache seeded");
    await pub.disconnectAll();

    await assertHidden(await connect({ internalOnly: true }, { forceRefresh: false }));
  });

  it("a cache written while internal-only stays hidden on restore", async () => {
    await connect({ internalOnly: true }, { forceRefresh: false });
    await assertHidden(await connect({ internalOnly: true }, { forceRefresh: false }));
  });
});

// ---------------------------------------------------------------------------
// Malformed policy values fail closed
// ---------------------------------------------------------------------------

describe("internalOnly policy fails closed on non-boolean values", () => {
  for (const value of ["true", "false", "yes", 1, 0, null, {}, []]) {
    it(`internalOnly: ${JSON.stringify(value)} hides the server`, async () => {
      const m = await connect({ internalOnly: value });
      assert.deepEqual(podNames(m.getToolSpecs().map((s) => s.name)), []);
      assert.deepEqual(podNames(m.getRouteMap().keys()), []);
      assert.equal(m.getMachinaLoopServer(), undefined);
      assert.equal(m.getMachinaServerName(), "pod");
      sdkCalls = [];
      const res = await m.callTool("mcp__pod__create_document", { name: "x" });
      assert.equal(res.isError, true);
      assert.deepEqual(podCalls(), []);
    });
  }
});

// ---------------------------------------------------------------------------
// Real ToolRegistry injection / dispatch
// ---------------------------------------------------------------------------

describe("ToolRegistry with an internalOnly server", () => {
  const registryFor = async () => {
    const m = await connect();
    const registry = new ToolRegistry();
    registry.injectMcpTools(m);
    sdkCalls = [];
    return registry;
  };

  it("injects public MCP tools but no private tools or machina_loop", async () => {
    const names = (await registryFor()).getAllToolSpecs().map((s) => s.name);
    assert.deepEqual(podNames(names), []);
    assert.equal(names.includes("machina_loop"), false);
    assert.ok(names.includes("mcp__worldcup__get_matches"));
  });

  it("refuses a guessed private tool with forged args before the SDK", async () => {
    const registry = await registryFor();
    const res = await registry.dispatchToolCall("mcp__pod__create_document", structuredClone(FORGED_ARGS));
    assert.equal(res.isError, true);
    assert.deepEqual(podCalls(), []);
    assert.equal(podDocs.size, 0);
  });

  it("machina_loop cannot reach the private pod", async () => {
    const registry = await registryFor();
    for (const input of [{ action: "read", session_id: SID }, { action: "start", prompt: "go" }]) {
      const res = await registry.dispatchToolCall("machina_loop", input, { yoloMode: true });
      assert.equal(res.isError, true, `${input.action} must fail`);
    }
    assert.deepEqual(podCalls(), []);
  });

  it("dispatches public tools normally", async () => {
    const registry = await registryFor();
    const res = await registry.dispatchToolCall("mcp__worldcup__get_matches", { date: "2026-06-11" });
    assert.equal(res.isError, false);
    assert.deepEqual(JSON.parse(res.content), { matches: [{ home: "MEX", away: "RSA" }] });
    assert.deepEqual(sdkCalls.map((c) => [c.server, c.name]), [["worldcup", "get_matches"]]);
  });
});
