/**
 * `sportsclaw operate` CLI — focused tests on the pure pieces and on
 * the public helpers exported for tests.
 *
 * The flag parser is fully unit-testable. The persona resolver, tail-server
 * poster, and exit-code matrix are tested with stubs — no real LLM, no
 * real HTTP server unless we explicitly stand one up here.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import http from "node:http";

import {
  buildOperatorTools,
  exitCodeFor,
  FRAGMENT_ALIASES,
  makeTailServerPoster,
  parseFlags,
  parseStructuredBroadcast,
  resolveExtraFragments,
  resolvePersona,
} from "../dist/operate.js";

// ---------------------------------------------------------------------------
// parseFlags
// ---------------------------------------------------------------------------

describe("operate parseFlags", () => {
  it("parses --job <id>", () => {
    const r = parseFlags(["--job", "tv-operator"]);
    assert.strictEqual(r.job, "tv-operator");
    assert.strictEqual(r.once, false);
    assert.strictEqual(r.dryRun, false);
  });

  it("parses --job=<id>", () => {
    const r = parseFlags(["--job=tv-operator"]);
    assert.strictEqual(r.job, "tv-operator");
  });

  it("parses --once", () => {
    const r = parseFlags(["--job", "j", "--once"]);
    assert.strictEqual(r.once, true);
  });

  it("parses --dry-run", () => {
    const r = parseFlags(["--job", "j", "--dry-run"]);
    assert.strictEqual(r.dryRun, true);
  });

  it("parses --list and --json", () => {
    const r = parseFlags(["--list", "--json"]);
    assert.strictEqual(r.list, true);
    assert.strictEqual(r.json, true);
  });

  it("parses --validate <id>", () => {
    const r = parseFlags(["--validate", "tv-operator"]);
    assert.strictEqual(r.validate, "tv-operator");
  });

  it("captures unknown flags for caller to reject", () => {
    const r = parseFlags(["--bogus", "--job", "x"]);
    assert.deepStrictEqual(r.unknown, ["--bogus"]);
  });
});

// ---------------------------------------------------------------------------
// resolveExtraFragments
// ---------------------------------------------------------------------------

describe("resolveExtraFragments", () => {
  it("returns [] for empty/undefined input", () => {
    assert.deepStrictEqual(resolveExtraFragments(undefined), []);
    assert.deepStrictEqual(resolveExtraFragments([]), []);
  });

  it("resolves 'broadcast-directive' to the matching exported fragment", () => {
    const out = resolveExtraFragments(["broadcast-directive"]);
    assert.strictEqual(out.length, 1);
    assert.match(out[0], /on-air/i);
  });

  it("resolves 'broadcast' as an alias for broadcast-directive", () => {
    const out = resolveExtraFragments(["broadcast"]);
    assert.match(out[0], /on-air/i);
  });

  it("passes through unknown names as inline text", () => {
    const out = resolveExtraFragments(["my-custom-policy", "broadcast"]);
    assert.strictEqual(out[0], "my-custom-policy");
    assert.match(out[1], /on-air/i);
  });

  it("FRAGMENT_ALIASES surface is non-empty", () => {
    assert.ok(Object.keys(FRAGMENT_ALIASES).length >= 3);
  });
});

// ---------------------------------------------------------------------------
// exitCodeFor
// ---------------------------------------------------------------------------

describe("exitCodeFor", () => {
  const base = { jobId: "x", tickId: "t", timestamp: "2026-01-01T00:00:00.000Z" };
  it("0 for published", () => {
    assert.strictEqual(exitCodeFor({ ...base, type: "tick_published" }), 0);
  });
  it("0 for silent", () => {
    assert.strictEqual(exitCodeFor({ ...base, type: "tick_silent" }), 0);
  });
  it("1 for skipped", () => {
    assert.strictEqual(exitCodeFor({ ...base, type: "tick_skipped" }), 1);
  });
  it("2 for failed", () => {
    assert.strictEqual(exitCodeFor({ ...base, type: "tick_failed" }), 2);
  });
  it("2 for any unknown variant", () => {
    assert.strictEqual(exitCodeFor({ ...base, type: "tick_started" }), 2);
  });
});

// ---------------------------------------------------------------------------
// resolvePersona — uses inline text wins; MCP fallback; error path
// ---------------------------------------------------------------------------

describe("resolvePersona", () => {
  /** Make a minimal mock McpManager surface the resolver needs. */
  function makeMockMcp(opts = {}) {
    return {
      getMachinaServerName: () => opts.serverName,
      callToolDirect: async (server, tool, args) => {
        if (opts.callToolDirect) return opts.callToolDirect(server, tool, args);
        return { isError: false, content: opts.content ?? "" };
      },
    };
  }

  it("returns personaText verbatim when set", async () => {
    const cfg = {
      jobId: "j",
      intervalMs: 60_000,
      personaText: "You are SportsClaw.",
    };
    const text = await resolvePersona(cfg, makeMockMcp());
    assert.strictEqual(text, "You are SportsClaw.");
  });

  it("throws when neither personaText nor persona is provided", async () => {
    await assert.rejects(
      resolvePersona({ jobId: "j", intervalMs: 60_000 }, makeMockMcp()),
      /neither personaText nor persona/,
    );
  });

  it("throws when persona is set but no Machina MCP server is configured", async () => {
    await assert.rejects(
      resolvePersona(
        { jobId: "j", intervalMs: 60_000, persona: "tv-host" },
        makeMockMcp({ serverName: undefined }),
      ),
      /requires an MCP server/,
    );
  });

  it("calls MCP get_prompt_by_name when persona is set + server present", async () => {
    let receivedArgs;
    const mcp = makeMockMcp({
      serverName: "machina",
      callToolDirect: async (_s, tool, args) => {
        receivedArgs = { tool, args };
        return { isError: false, content: "Resolved persona body." };
      },
    });
    const text = await resolvePersona(
      { jobId: "j", intervalMs: 60_000, persona: "tv-host" },
      mcp,
    );
    assert.strictEqual(receivedArgs.tool, "get_prompt_by_name");
    assert.deepStrictEqual(receivedArgs.args, { name: "tv-host" });
    assert.strictEqual(text, "Resolved persona body.");
  });

  it("unwraps a JSON-shaped MCP response if present", async () => {
    const mcp = makeMockMcp({
      serverName: "machina",
      callToolDirect: async () => ({
        isError: false,
        content: JSON.stringify({ content: "wrapped persona" }),
      }),
    });
    const text = await resolvePersona(
      { jobId: "j", intervalMs: 60_000, persona: "tv-host" },
      mcp,
    );
    assert.strictEqual(text, "wrapped persona");
  });

  it("surfaces MCP errors as resolver errors", async () => {
    const mcp = makeMockMcp({
      serverName: "machina",
      callToolDirect: async () => ({ isError: true, content: "prompt not found" }),
    });
    await assert.rejects(
      resolvePersona(
        { jobId: "j", intervalMs: 60_000, persona: "tv-host" },
        mcp,
      ),
      /prompt not found/,
    );
  });
});

// ---------------------------------------------------------------------------
// makeTailServerPoster — non-fatal HTTP delivery
// ---------------------------------------------------------------------------

describe("makeTailServerPoster", () => {
  let server;
  let received;
  let baseUrl;

  beforeEach(async () => {
    received = [];
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          received.push({ url: req.url, body: JSON.parse(body) });
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        } catch {
          res.writeHead(500);
          res.end("bad json");
        }
      });
    });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const baseEvent = {
    type: "tick_published",
    jobId: "tv-operator",
    tickId: "tick_001",
    text: "Argentina vs Brazil opens.",
    timestamp: "2026-01-01T00:00:00.000Z",
  };

  it("POSTs to <tailServer>/ingest with a flat tv-telemetry-event shape", async () => {
    // makeTailServerPoster signature: (tailServer, jobId, mcpManager?, modelId?, intervalMs?)
    // Pass undefined for mcpManager — archive is best-effort and skipped without one.
    const post = makeTailServerPoster(
      baseUrl,
      "tv-operator",
      undefined,
      "gemini-3.1-pro-preview",
      60000,
    );
    await post(baseEvent);
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].url, "/ingest");
    const body = received[0].body;
    assert.strictEqual(body.kind, "broadcast");
    assert.strictEqual(body.workflow_name, "sportsclaw-operate:tv-operator");
    assert.strictEqual(body.model, "gemini-3.1-pro-preview");
    assert.strictEqual(body.prompt_excerpt, "Argentina vs Brazil opens.");
    assert.strictEqual(body.ts, baseEvent.timestamp);
  });

  it("maps tick_started → kind=tick with phase+intervalMs", async () => {
    const post = makeTailServerPoster(baseUrl, "tv-operator", undefined, undefined, 90000);
    await post({ ...baseEvent, type: "tick_started" });
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].body.kind, "tick");
    assert.strictEqual(received[0].body.phase, "started");
    assert.strictEqual(received[0].body.intervalMs, 90000);
  });

  it("maps tick_failed → kind=error", async () => {
    const post = makeTailServerPoster(baseUrl, "tv-operator");
    await post({ ...baseEvent, type: "tick_failed", reason: "upstream timeout" });
    assert.strictEqual(received[0].body.kind, "error");
    assert.match(received[0].body.message, /upstream timeout/);
    assert.strictEqual(received[0].body.level, "error");
  });

  it("strips <<<DATA>>>...<<<END>>> from broadcast text before POSTing", async () => {
    const post = makeTailServerPoster(baseUrl, "tv-operator");
    await post({
      ...baseEvent,
      text: 'Big news today.\n\n<<<DATA>>>{"prediction_markets":[{"question":"Q","prob":0.5,"source":"Kalshi"}]}<<<END>>>',
    });
    // First post is the broadcast — narrative ONLY, packet stripped.
    assert.strictEqual(received[0].body.kind, "broadcast");
    assert.strictEqual(received[0].body.prompt_excerpt, "Big news today.");
    assert.doesNotMatch(received[0].body.prompt_excerpt, /<<<DATA>>>/);
  });

  it("fans out the structured packet as kind-specific events", async () => {
    const post = makeTailServerPoster(baseUrl, "tv-operator");
    const packet = JSON.stringify({
      prediction_markets: [{ question: "Will X win?", prob: 0.3, source: "Polymarket" }],
      news: [{ headline: "Breaking", source: "NYT", ts: "2026-05-11" }],
    });
    await post({
      ...baseEvent,
      text: `Narrative.\n\n<<<DATA>>>${packet}<<<END>>>`,
    });
    // Should produce 3 POSTs: broadcast, prediction_markets, news
    assert.strictEqual(received.length, 3);
    const kinds = received.map((r) => r.body.kind);
    assert.deepStrictEqual(kinds, ["broadcast", "prediction_markets", "news"]);
    const marketsBody = received.find((r) => r.body.kind === "prediction_markets").body;
    assert.strictEqual(marketsBody.items.length, 1);
    assert.strictEqual(marketsBody.items[0].question, "Will X win?");
    const newsBody = received.find((r) => r.body.kind === "news").body;
    assert.strictEqual(newsBody.items[0].headline, "Breaking");
  });

  it("omits empty arrays from the packet fan-out", async () => {
    const post = makeTailServerPoster(baseUrl, "tv-operator");
    const packet = JSON.stringify({
      prediction_markets: [{ question: "Q", prob: 0.5, source: "Kalshi" }],
      news: [], // empty — should NOT fan out
      fixtures: [], // empty — should NOT fan out
    });
    await post({
      ...baseEvent,
      text: `Hello.\n\n<<<DATA>>>${packet}<<<END>>>`,
    });
    assert.strictEqual(received.length, 2);
    const kinds = received.map((r) => r.body.kind);
    assert.deepStrictEqual(kinds, ["broadcast", "prediction_markets"]);
  });

  it("tolerates malformed JSON in the packet (does not crash)", async () => {
    const post = makeTailServerPoster(baseUrl, "tv-operator");
    await post({
      ...baseEvent,
      text: "Body.\n\n<<<DATA>>>{ not valid json <<<END>>>",
    });
    // Broadcast still posts even when packet parse fails.
    assert.ok(received.length >= 1);
    assert.strictEqual(received[0].body.kind, "broadcast");
    // The packet should still be stripped from the narrative.
    assert.doesNotMatch(received[0].body.prompt_excerpt, /<<<DATA>>>/);
  });

  it("normalises trailing slash on the server URL", async () => {
    const post = makeTailServerPoster(`${baseUrl}///`, "tv-operator");
    await post(baseEvent);
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].url, "/ingest");
  });

  it("does NOT throw when the server is unreachable (network error)", async () => {
    const post = makeTailServerPoster("http://127.0.0.1:1", "tv-operator");
    await post(baseEvent);
    // If we got here without a crash, the contract holds.
    assert.ok(true);
  });

  it("does NOT throw when the server returns 5xx", async () => {
    await new Promise((resolve) => server.close(resolve));
    server = http.createServer((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const post = makeTailServerPoster(`http://127.0.0.1:${port}`, "tv-operator");
    await post(baseEvent);
    assert.ok(true);
  });
});

// ---------------------------------------------------------------------------
// parseStructuredBroadcast — packet extraction
// ---------------------------------------------------------------------------

describe("parseStructuredBroadcast", () => {
  it("returns the full text and null data when no packet present", () => {
    const r = parseStructuredBroadcast("Just a broadcast paragraph.");
    assert.strictEqual(r.narrative, "Just a broadcast paragraph.");
    assert.strictEqual(r.data, null);
  });

  it("extracts a well-formed packet and strips it from the narrative", () => {
    const r = parseStructuredBroadcast(
      'Hello world.\n\n<<<DATA>>>{"prediction_markets":[{"question":"Q","prob":0.5}]}<<<END>>>',
    );
    assert.strictEqual(r.narrative, "Hello world.");
    assert.ok(r.data);
    assert.strictEqual(r.data.prediction_markets.length, 1);
    assert.strictEqual(r.data.prediction_markets[0].question, "Q");
  });

  it("trims surrounding whitespace inside the delimiters", () => {
    const r = parseStructuredBroadcast(
      'Text.\n\n<<<DATA>>>\n  {"news":[{"headline":"H"}]}  \n<<<END>>>',
    );
    assert.ok(r.data);
    assert.strictEqual(r.data.news[0].headline, "H");
  });

  it("reports a parseError when the JSON is malformed", () => {
    const r = parseStructuredBroadcast(
      "Text.\n\n<<<DATA>>>{ not valid json <<<END>>>",
    );
    assert.strictEqual(r.data, null);
    assert.ok(r.parseError);
    // The narrative is still recovered without the packet.
    assert.strictEqual(r.narrative, "Text.");
  });

  it("handles multiple newlines + multi-line JSON inside the packet", () => {
    const r = parseStructuredBroadcast(
      "Para 1.\n\nPara 2.\n\n<<<DATA>>>\n{\n  \"news\": [\n    {\"headline\":\"H1\"},\n    {\"headline\":\"H2\"}\n  ]\n}\n<<<END>>>",
    );
    assert.ok(r.data);
    assert.strictEqual(r.data.news.length, 2);
    assert.strictEqual(r.narrative, "Para 1.\n\nPara 2.");
  });

  it("defensively strips an open <<<DATA>>> with no matching <<<END>>>", () => {
    // When the LLM truncates mid-packet (token limit, malformed output),
    // strip everything from <<<DATA>>> onward so raw JSON doesn't bleed
    // into the broadcast card. Data is lost for this tick (would have been
    // malformed JSON anyway); narrative stays clean.
    const r = parseStructuredBroadcast("Text. <<<DATA>>> not closed");
    assert.strictEqual(r.data, null);
    assert.ok(
      !r.narrative.includes("<<<DATA>>>"),
      "narrative must not contain the open marker",
    );
    assert.ok(
      !r.narrative.includes("not closed"),
      "narrative must not contain anything after the open marker",
    );
    assert.match(r.narrative, /^Text\.\s*$/);
    assert.match(r.parseError ?? "", /truncated|never closed/i);
  });

  it("strips an open packet that contains a half-written JSON object", () => {
    const r = parseStructuredBroadcast(
      'World Cup recap.\n\n<<<DATA>>>{"prediction_markets":[{"question":"Will',
    );
    assert.strictEqual(r.data, null);
    assert.ok(!r.narrative.includes("<<<DATA>>>"));
    assert.ok(!r.narrative.includes("prediction_markets"));
    assert.strictEqual(r.narrative, "World Cup recap.");
    assert.ok(r.parseError);
  });
});

// ---------------------------------------------------------------------------
// buildOperatorTools — generate_image registration
// ---------------------------------------------------------------------------

describe("buildOperatorTools generate_image", () => {
  // These tests instantiate a fresh ToolRegistry + McpManager, which may
  // attempt MCP connection if SPORTSCLAW_MCP_SERVERS / ~/.sportsclaw/mcp.json
  // is configured. Connect is non-fatal; we just need the toolset to come
  // back with generate_image in it.

  const baseCfg = {
    jobId: "test-image-job",
    intervalMs: 60_000,
    personaText: "test persona",
    provider: "google",
  };

  it("registers generate_image in the toolset (named in toolNames + present in toolSet)", async () => {
    const t = await buildOperatorTools(baseCfg, false);
    try {
      assert.ok(
        t.toolNames.includes("generate_image"),
        `toolNames did not include generate_image: ${t.toolNames.slice(0, 8).join(", ")}…`,
      );
      assert.ok(
        t.toolSet["generate_image"],
        "toolSet has no generate_image entry",
      );
    } finally {
      await t.mcpManager.disconnectAll().catch(() => {});
    }
  });

  it("generate_image execute returns an Anthropic-unsupported message when provider=anthropic", async () => {
    const t = await buildOperatorTools(
      { ...baseCfg, provider: "anthropic" },
      false,
    );
    try {
      const tool = t.toolSet["generate_image"];
      assert.ok(tool);
      const result = await tool.execute({ prompt: "irrelevant" }, {
        toolCallId: "t1",
        messages: [],
      });
      assert.match(String(result), /Anthropic does not support image generation/i);
    } finally {
      await t.mcpManager.disconnectAll().catch(() => {});
    }
  });

  it("registers a broadcaster-oriented description on the daemon tool (not the chat-mode default)", async () => {
    // The chat-mode default description says "sent to the user in their
    // channel," which empirically caused Gemini to skip the tool in
    // operator ticks. The daemon must override with broadcaster wording.
    const t = await buildOperatorTools(baseCfg, false);
    try {
      const tool = t.toolSet["generate_image"];
      assert.ok(tool);
      const desc = String(tool.description ?? "");
      assert.match(desc, /broadcast/i, "daemon description must invoke broadcast wording");
      assert.match(desc, /on-air overlay/i, "daemon description must reference the on-air overlay");
      assert.doesNotMatch(
        desc,
        /sent to the user in their channel/i,
        "daemon must NOT use the chat-mode default description",
      );
    } finally {
      await t.mcpManager.disconnectAll().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// buildOperatorTools — recall_recent_content tool (tv-content-archive)
// ---------------------------------------------------------------------------

describe("buildOperatorTools recall_recent_content", () => {
  const baseCfg = {
    jobId: "test-recall-job",
    intervalMs: 60_000,
    personaText: "x",
    provider: "google",
  };

  it("registers recall_recent_content in the toolset", async () => {
    const t = await buildOperatorTools(baseCfg, false);
    try {
      assert.ok(
        t.toolNames.includes("recall_recent_content"),
        `toolNames did not include recall_recent_content: ${t.toolNames.slice(0, 8).join(", ")}…`,
      );
      assert.ok(t.toolSet["recall_recent_content"]);
    } finally {
      await t.mcpManager.disconnectAll().catch(() => {});
    }
  });

  it("recall_recent_content returns {error:'category required'} when category is missing", async () => {
    const t = await buildOperatorTools(baseCfg, false);
    try {
      const tool = t.toolSet["recall_recent_content"];
      assert.ok(tool);
      const result = await tool.execute({}, { toolCallId: "t1", messages: [] });
      const parsed = JSON.parse(String(result));
      assert.match(String(parsed.error), /category required/i);
    } finally {
      await t.mcpManager.disconnectAll().catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// buildOperatorTools — recall_library tool (tv-content-library)
// ---------------------------------------------------------------------------

describe("buildOperatorTools recall_library", () => {
  const baseCfg = {
    jobId: "test-recall-library-job",
    intervalMs: 60_000,
    personaText: "x",
    provider: "google",
  };

  it("registers recall_library in the toolset", async () => {
    const t = await buildOperatorTools(baseCfg, false);
    try {
      assert.ok(
        t.toolNames.includes("recall_library"),
        `toolNames did not include recall_library: ${t.toolNames.slice(0, 8).join(", ")}…`,
      );
      assert.ok(t.toolSet["recall_library"]);
    } finally {
      await t.mcpManager.disconnectAll().catch(() => {});
    }
  });

  it("recall_library description mentions tv-content-library + canonical/library framing", async () => {
    // The description must distinguish this tool from recall_recent_content
    // so the LLM picks the right tool. Pin the key wording.
    const t = await buildOperatorTools(baseCfg, false);
    try {
      const tool = t.toolSet["recall_library"];
      assert.ok(tool);
      const desc = String(tool.description ?? "");
      assert.match(desc, /tv-content-library/i);
      assert.match(desc, /persistent|evergreen|canonical/i);
      // Ensures the LLM knows when NOT to pick this tool
      assert.match(desc, /recall_recent_content/i);
    } finally {
      await t.mcpManager.disconnectAll().catch(() => {});
    }
  });
});
