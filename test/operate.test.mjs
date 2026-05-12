/**
 * `sportsclaw operate` CLI — focused tests on the pure pieces and on
 * the public helpers exported for tests.
 *
 * The flag parser is fully unit-testable. The persona resolver, tail-server
 * poster, and exit-code matrix are tested with stubs — no real LLM, no
 * real HTTP server unless we explicitly stand one up here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  exitCodeFor,
  FRAGMENT_ALIASES,
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

  it("unwraps the Machina pod's nested {data:{data:{template}}} response shape", async () => {
    // get_prompt_by_name on the pod returns the prompt record nested two
    // levels deep, with the persona body in `template` (matching the YAML).
    // The previous parser missed this and returned the raw JSON envelope
    // as the persona — silently shipping garbage as the system prompt.
    const mcp = makeMockMcp({
      serverName: "machina",
      callToolDirect: async () => ({
        isError: false,
        content: JSON.stringify({
          status: "ok",
          message: "ok",
          data: {
            data: {
              name: "tv-host-persona",
              template: "You are SportsClaw, the on-air operator.",
            },
            status: "ok",
          },
        }),
      }),
    });
    const text = await resolvePersona(
      { jobId: "j", intervalMs: 60_000, persona: "tv-host-persona" },
      mcp,
    );
    assert.strictEqual(text, "You are SportsClaw, the on-air operator.");
  });

  it("prefers `template` over `content/text/prompt` when multiple are present at the nested level", async () => {
    const mcp = makeMockMcp({
      serverName: "machina",
      callToolDirect: async () => ({
        isError: false,
        content: JSON.stringify({
          data: {
            data: {
              template: "FROM template",
              content: "from content",
              text: "from text",
            },
          },
        }),
      }),
    });
    const text = await resolvePersona(
      { jobId: "j", intervalMs: 60_000, persona: "p" },
      mcp,
    );
    assert.strictEqual(text, "FROM template");
  });

  it("falls back to the raw response when the shape doesn't match anything", async () => {
    const weirdShape = JSON.stringify({ unrelated: { key: "values" } });
    const mcp = makeMockMcp({
      serverName: "machina",
      callToolDirect: async () => ({ isError: false, content: weirdShape }),
    });
    const text = await resolvePersona(
      { jobId: "j", intervalMs: 60_000, persona: "p" },
      mcp,
    );
    assert.strictEqual(text, weirdShape);
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

