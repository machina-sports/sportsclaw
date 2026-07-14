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
  requireSinkPollForWork,
  resolveExtraFragments,
  resolvePersona,
  runSinkPolledLoop,
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

// ---------------------------------------------------------------------------
// sink-polled scheduling — interactive pickup without overlapping inference
// ---------------------------------------------------------------------------

describe("sink-polled scheduling", () => {
  it("awaits each accepted tick before polling for another", async () => {
    const abort = new AbortController();
    let pollCalls = 0;
    let ticks = 0;
    let activeTicks = 0;
    let maxActiveTicks = 0;
    let releaseFirst;
    let markFirstStarted;
    const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
    const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });

    const loop = runSinkPolledLoop({
      intervalMs: 5_000,
      signal: abort.signal,
      wait: async () => {},
      pollForWork: () => {
        pollCalls += 1;
        return true;
      },
      tickOnce: async () => {
        ticks += 1;
        activeTicks += 1;
        maxActiveTicks = Math.max(maxActiveTicks, activeTicks);
        if (ticks === 1) {
          markFirstStarted();
          await firstBlocked;
        }
        activeTicks -= 1;
        if (ticks === 2) abort.abort();
      },
    });

    await firstStarted;
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(pollCalls, 1, "must not poll while the first tick is in flight");
    releaseFirst();
    await loop;

    assert.strictEqual(ticks, 2);
    assert.strictEqual(maxActiveTicks, 1);
  });

  it("does not invoke the model tick while the sink reports idle", async () => {
    const abort = new AbortController();
    let polls = 0;
    let ticks = 0;
    await runSinkPolledLoop({
      intervalMs: 5_000,
      signal: abort.signal,
      wait: async () => {},
      pollForWork: () => {
        polls += 1;
        if (polls === 3) abort.abort();
        return false;
      },
      tickOnce: async () => { ticks += 1; },
    });
    assert.strictEqual(polls, 3);
    assert.strictEqual(ticks, 0);
  });

  it("records poll/tick errors and keeps servicing the queue", async () => {
    const abort = new AbortController();
    const errors = [];
    let polls = 0;
    let ticks = 0;
    await runSinkPolledLoop({
      intervalMs: 5_000,
      signal: abort.signal,
      wait: async () => {},
      onError: (phase, error) => errors.push([phase, error.message]),
      pollForWork: () => {
        polls += 1;
        if (polls === 1) throw new Error("tail unavailable");
        if (polls === 2) return true;
        abort.abort();
        return false;
      },
      tickOnce: async () => {
        ticks += 1;
        throw new Error("inference failed");
      },
    });
    assert.strictEqual(ticks, 1);
    assert.deepStrictEqual(errors, [
      ["poll", "tail unavailable"],
      ["tick", "inference failed"],
    ]);
  });

  it("fails startup when a sink-polled job has no pollForWork hook", () => {
    const cfg = {
      jobId: "vault-ask",
      intervalMs: 5_000,
      scheduleMode: "sink-polled",
      personaText: "vault",
      sink: "/sandbox/vault-sink.mjs",
    };
    const ctx = { jobId: cfg.jobId, intervalMs: cfg.intervalMs, cfg };
    assert.throws(
      () => requireSinkPollForWork(cfg, { name: "vault-sink" }, ctx),
      /does not implement pollForWork/,
    );
  });

  it("binds the sink polling hook to the resolved job context", async () => {
    const cfg = {
      jobId: "vault-ask",
      intervalMs: 5_000,
      scheduleMode: "sink-polled",
      personaText: "vault",
      sink: "/sandbox/vault-sink.mjs",
    };
    const ctx = { jobId: cfg.jobId, intervalMs: cfg.intervalMs, cfg };
    let received;
    const poll = requireSinkPollForWork(
      cfg,
      { name: "vault-sink", pollForWork: (value) => { received = value; return true; } },
      ctx,
    );
    assert.strictEqual(await poll(), true);
    assert.strictEqual(received, ctx);
  });
});
