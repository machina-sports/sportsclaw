/**
 * Broadcast Sink — tests for the SportsClaw TV operator's domain plugin.
 *
 * These tests pin the contract the broadcast sink offers to:
 *   - the TV repo's tail-server (envelope shape, kind vocabulary)
 *   - the operator daemon (onTickEvent / onToolCall hooks fire correctly)
 *   - the operator config schema (broadcast tools register through the
 *     sink interface, not directly in operate.ts)
 *
 * The broadcast sink + this test file are scheduled to move out of
 * sportsclaw into machina-sports-tv (alongside the persona YAML, library
 * JSON, and overlay code they pair with) in a follow-up PR. The test
 * shape is portable — only the import path changes when it moves.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import http from "node:http";

import { broadcastSink } from "../dist/sinks/broadcast.js";
import { parseStructuredBroadcast } from "../dist/operate.js";
import { buildOperatorTools } from "../dist/operate.js";

// ---------------------------------------------------------------------------
// Helpers — translate the old makeTailServerPoster signature into a call
// against the sink's onTickEvent hook. Keeps the existing test bodies
// readable.
// ---------------------------------------------------------------------------

/** Build a closure that mirrors makeTailServerPoster(tailServer, jobId, mcp, modelId, intervalMs). */
function makePoster(tailServer, jobId, mcpManager, modelId, intervalMs) {
  const cfg = {
    jobId,
    intervalMs: intervalMs ?? 60_000,
    personaText: "x",
    tailServer,
  };
  const ctx = { jobId, modelId, intervalMs, mcpManager, cfg };
  return (evt) => broadcastSink.onTickEvent(evt, ctx);
}

// ---------------------------------------------------------------------------
// broadcastSink.onTickEvent — non-fatal HTTP delivery
// ---------------------------------------------------------------------------

describe("broadcastSink.onTickEvent", () => {
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
    const post = makePoster(baseUrl, "tv-operator", undefined, "gemini-3.1-pro-preview", 60000);
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
    const post = makePoster(baseUrl, "tv-operator", undefined, undefined, 90000);
    await post({ ...baseEvent, type: "tick_started" });
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].body.kind, "tick");
    assert.strictEqual(received[0].body.phase, "started");
    assert.strictEqual(received[0].body.intervalMs, 90000);
  });

  it("maps tick_failed → kind=error", async () => {
    const post = makePoster(baseUrl, "tv-operator");
    await post({ ...baseEvent, type: "tick_failed", reason: "upstream timeout" });
    assert.strictEqual(received[0].body.kind, "error");
    assert.match(received[0].body.message, /upstream timeout/);
    assert.strictEqual(received[0].body.level, "error");
  });

  it("strips <<<DATA>>>...<<<END>>> from broadcast text before POSTing", async () => {
    const post = makePoster(baseUrl, "tv-operator");
    await post({
      ...baseEvent,
      text: 'Big news today.\n\n<<<DATA>>>{"prediction_markets":[{"question":"Q","prob":0.5,"source":"Kalshi"}]}<<<END>>>',
    });
    assert.strictEqual(received[0].body.kind, "broadcast");
    assert.strictEqual(received[0].body.prompt_excerpt, "Big news today.");
    assert.doesNotMatch(received[0].body.prompt_excerpt, /<<<DATA>>>/);
  });

  it("fans out the structured packet as kind-specific events", async () => {
    const post = makePoster(baseUrl, "tv-operator");
    const packet = JSON.stringify({
      prediction_markets: [{ question: "Will X win?", prob: 0.3, source: "Polymarket" }],
      news: [{ headline: "Breaking", source: "NYT", ts: "2026-05-11" }],
    });
    await post({
      ...baseEvent,
      text: `Narrative.\n\n<<<DATA>>>${packet}<<<END>>>`,
    });
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
    const post = makePoster(baseUrl, "tv-operator");
    const packet = JSON.stringify({
      prediction_markets: [{ question: "Q", prob: 0.5, source: "Kalshi" }],
      news: [],
      fixtures: [],
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
    const post = makePoster(baseUrl, "tv-operator");
    await post({
      ...baseEvent,
      text: "Body.\n\n<<<DATA>>>{ not valid json <<<END>>>",
    });
    assert.ok(received.length >= 1);
    assert.strictEqual(received[0].body.kind, "broadcast");
    assert.doesNotMatch(received[0].body.prompt_excerpt, /<<<DATA>>>/);
  });

  it("normalises trailing slash on the server URL", async () => {
    const post = makePoster(`${baseUrl}///`, "tv-operator");
    await post(baseEvent);
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].url, "/ingest");
  });

  it("does NOT throw when the server is unreachable (network error)", async () => {
    const post = makePoster("http://127.0.0.1:1", "tv-operator");
    await post(baseEvent);
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
    const post = makePoster(`http://127.0.0.1:${port}`, "tv-operator");
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
    const r = parseStructuredBroadcast("Text. <<<DATA>>> not closed");
    assert.strictEqual(r.data, null);
    assert.ok(!r.narrative.includes("<<<DATA>>>"));
    assert.ok(!r.narrative.includes("not closed"));
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
// buildOperatorTools — broadcast sink registers the TV-flavored tools
// (generate_image, recall_recent_content, recall_library)
// ---------------------------------------------------------------------------

describe("buildOperatorTools with broadcast sink", () => {
  // Job configs include a `sink` so resolveSink picks broadcast. Tools that
  // come from the sink (recall_*, generate_image) are absent without it.
  const broadcastCfg = {
    jobId: "test-broadcast-job",
    intervalMs: 60_000,
    personaText: "x",
    provider: "google",
    sink: "broadcast",
  };

  it("registers generate_image when the broadcast sink is active", async () => {
    const t = await buildOperatorTools(broadcastCfg, false, broadcastSink);
    try {
      assert.ok(t.toolNames.includes("generate_image"));
      assert.ok(t.toolSet["generate_image"]);
    } finally {
      await t.mcpManager.disconnectAll().catch(() => {});
    }
  });

  it("does NOT register generate_image when no sink is supplied", async () => {
    const t = await buildOperatorTools(
      { ...broadcastCfg, sink: undefined, tailServer: undefined },
      false,
      undefined,
    );
    try {
      assert.ok(
        !t.toolNames.includes("generate_image"),
        "without a sink, generate_image must NOT be in the daemon toolset",
      );
    } finally {
      await t.mcpManager.disconnectAll().catch(() => {});
    }
  });

  it("generate_image execute returns an Anthropic-unsupported message when provider=anthropic", async () => {
    const t = await buildOperatorTools(
      { ...broadcastCfg, provider: "anthropic" },
      false,
      broadcastSink,
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

  it("generate_image carries broadcaster-oriented description (not chat-mode default)", async () => {
    const t = await buildOperatorTools(broadcastCfg, false, broadcastSink);
    try {
      const tool = t.toolSet["generate_image"];
      assert.ok(tool);
      const desc = String(tool.description ?? "");
      assert.match(desc, /broadcast/i);
      assert.match(desc, /on-air overlay/i);
      assert.doesNotMatch(desc, /sent to the user in their channel/i);
    } finally {
      await t.mcpManager.disconnectAll().catch(() => {});
    }
  });

  it("registers recall_recent_content + recall_library", async () => {
    const t = await buildOperatorTools(broadcastCfg, false, broadcastSink);
    try {
      assert.ok(t.toolNames.includes("recall_recent_content"));
      assert.ok(t.toolNames.includes("recall_library"));
      assert.ok(t.toolSet["recall_recent_content"]);
      assert.ok(t.toolSet["recall_library"]);
    } finally {
      await t.mcpManager.disconnectAll().catch(() => {});
    }
  });

  it("recall_recent_content returns {error:'category required'} when category is missing", async () => {
    const t = await buildOperatorTools(broadcastCfg, false, broadcastSink);
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

  it("recall_library description mentions tv-content-library + distinguishes from archive recall", async () => {
    const t = await buildOperatorTools(broadcastCfg, false, broadcastSink);
    try {
      const tool = t.toolSet["recall_library"];
      assert.ok(tool);
      const desc = String(tool.description ?? "");
      assert.match(desc, /tv-content-library/i);
      assert.match(desc, /persistent|evergreen|canonical/i);
      assert.match(desc, /recall_recent_content/i);
    } finally {
      await t.mcpManager.disconnectAll().catch(() => {});
    }
  });
});
