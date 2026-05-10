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
  exitCodeFor,
  FRAGMENT_ALIASES,
  makeTailServerPoster,
  parseFlags,
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

  const event = {
    type: "tick_published",
    jobId: "tv-operator",
    tickId: "tick_001",
    text: "Argentina vs Brazil opens.",
    timestamp: "2026-01-01T00:00:00.000Z",
  };

  it("POSTs to <tailServer>/ingest with structured envelope", async () => {
    const post = makeTailServerPoster(baseUrl, "tv-operator");
    post(event);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].url, "/ingest");
    assert.strictEqual(received[0].body.kind, "tv-telemetry-event");
    assert.strictEqual(received[0].body.source, "sportsclaw-operate");
    assert.strictEqual(received[0].body.jobId, "tv-operator");
    assert.deepStrictEqual(received[0].body.event, event);
  });

  it("normalises trailing slash on the server URL", async () => {
    const post = makeTailServerPoster(`${baseUrl}///`, "tv-operator");
    post(event);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].url, "/ingest");
  });

  it("does NOT throw when the server is unreachable (network error)", async () => {
    const post = makeTailServerPoster("http://127.0.0.1:1", "tv-operator");
    // Should not throw synchronously...
    post(event);
    // ...nor should it surface as an unhandled rejection (the poster
    // catches and logs to stderr). Give it a tick for the fetch to fail.
    await new Promise((r) => setTimeout(r, 50));
    // If we got here without a crash, the contract holds.
    assert.ok(true);
  });

  it("does NOT throw when the server returns 5xx", async () => {
    // Replace the handler to return 503
    await new Promise((resolve) => server.close(resolve));
    server = http.createServer((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const post = makeTailServerPoster(`http://127.0.0.1:${port}`, "tv-operator");
    post(event);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(true);
  });
});
