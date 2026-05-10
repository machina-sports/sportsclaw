/**
 * Operator Daemon — test suite
 *
 * Tests the integration adapter that wires HeartbeatService + EditorialMemory
 * + LastTickBrief + ToolGuardController + an AI-SDK generateText pass.
 *
 * Strategy: inject a mock generateText impl + a fresh HeartbeatService per
 * test, so no network and no real model. Use tickOnce() to drive the body
 * directly — start()/stop() with timers is exercised separately.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  createOperatorDaemon,
} from "../dist/operator-daemon.js";
import { HeartbeatService } from "../dist/heartbeat.js";
import { LastTickBrief } from "../dist/last-tick-brief.js";

import * as publicEntry from "../dist/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "operator-daemon-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Build a generateText stub that returns a fixed text and records inputs. */
function makeGen(text) {
  const calls = [];
  const impl = async (args) => {
    calls.push(args);
    return { text };
  };
  impl.calls = calls;
  return impl;
}

/** Build a fake AI-SDK Tool with a controllable execute. */
function makeTool(execute) {
  return {
    description: "test tool",
    inputSchema: { jsonSchema: { type: "object" } },
    execute,
  };
}

function freshHeartbeat() {
  return new HeartbeatService();
}

function baseConfig(overrides = {}) {
  return {
    jobId: "tv-operator-test",
    intervalMs: 60_000,
    rootDir: tmpDir,
    role: "You are SportsClaw, a 24/7 broadcast editor.",
    model: { name: "mock-model" }, // never actually used by the stub
    heartbeat: freshHeartbeat(),
    generateTextImpl: makeGen("Tonight: Argentina vs Brazil opens."),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// tickOnce — published path
// ---------------------------------------------------------------------------

describe("tickOnce — published path", () => {
  it("returns a tick_published event with the model text", async () => {
    const daemon = createOperatorDaemon(baseConfig());
    const event = await daemon.tickOnce();

    assert.strictEqual(event.type, "tick_published");
    assert.strictEqual(event.text, "Tonight: Argentina vs Brazil opens.");
    assert.strictEqual(event.jobId, "tv-operator-test");
    assert.match(event.tickId, /^tick_/);
  });

  it("writes the brief to disk under <briefDir>/<jobId>/<tickId>.md", async () => {
    const daemon = createOperatorDaemon(baseConfig());
    const event = await daemon.tickOnce();

    const briefPath = path.join(
      tmpDir,
      "briefs",
      "tv-operator-test",
      `${event.tickId}.md`,
    );
    assert.ok(fs.existsSync(briefPath), `expected brief at ${briefPath}`);
    const text = fs.readFileSync(briefPath, "utf8");
    assert.match(text, /Tonight: Argentina vs Brazil opens\./);
  });

  it("composes the system prompt with cron + tool-discipline + sentinel + memory", async () => {
    const gen = makeGen("hello world");
    fs.writeFileSync(
      path.join(tmpDir, "editorial-memory.md"),
      "lesson: prefer fallback over hallucination",
      "utf8",
    );
    const daemon = createOperatorDaemon(
      baseConfig({ generateTextImpl: gen }),
    );
    await daemon.tickOnce();

    assert.strictEqual(gen.calls.length, 1);
    const sys = gen.calls[0].system;
    assert.match(sys, /Autonomous mode/);
    assert.match(sys, /Tool use discipline/);
    assert.match(sys, /\[SILENT\] sentinel/);
    assert.match(sys, /prefer fallback over hallucination/);
  });

  it("substitutes {tickId} and {timestamp} in the tick prompt", async () => {
    const gen = makeGen("ok");
    const daemon = createOperatorDaemon(
      baseConfig({
        generateTextImpl: gen,
        tickPrompt: "Run {tickId} at {timestamp}.",
      }),
    );
    const event = await daemon.tickOnce();
    const userPrompt = gen.calls[0].prompt;
    assert.match(userPrompt, new RegExp(`Run ${event.tickId} at `));
    assert.match(userPrompt, /at \d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// tickOnce — silent path
// ---------------------------------------------------------------------------

describe("tickOnce — silent path", () => {
  it("recognises [SILENT] as a tick_silent event with no text", async () => {
    const daemon = createOperatorDaemon(
      baseConfig({ generateTextImpl: makeGen("[SILENT]") }),
    );
    const event = await daemon.tickOnce();
    assert.strictEqual(event.type, "tick_silent");
    assert.strictEqual(event.text, undefined);
  });

  it("writes a silent brief that downstream loadRecent reports as silent", async () => {
    const daemon = createOperatorDaemon(
      baseConfig({ generateTextImpl: makeGen("[SILENT]") }),
    );
    await daemon.tickOnce();
    const briefs = await new LastTickBrief(
      path.join(tmpDir, "briefs"),
    ).loadRecent("tv-operator-test", 1);
    assert.strictEqual(briefs.length, 1);
    assert.strictEqual(briefs[0].silent, true);
  });
});

// ---------------------------------------------------------------------------
// tickOnce — failed path
// ---------------------------------------------------------------------------

describe("tickOnce — failed path", () => {
  it("returns tick_failed when generateText throws", async () => {
    const daemon = createOperatorDaemon(
      baseConfig({
        generateTextImpl: async () => {
          throw new Error("upstream timeout");
        },
      }),
    );
    const event = await daemon.tickOnce();
    assert.strictEqual(event.type, "tick_failed");
    assert.match(event.reason, /upstream timeout/);
  });

  it("still writes a brief that records the failure", async () => {
    const daemon = createOperatorDaemon(
      baseConfig({
        generateTextImpl: async () => {
          throw new Error("upstream timeout");
        },
      }),
    );
    const event = await daemon.tickOnce();
    const briefPath = path.join(
      tmpDir,
      "briefs",
      "tv-operator-test",
      `${event.tickId}.md`,
    );
    const text = fs.readFileSync(briefPath, "utf8");
    assert.match(text, /tick failed/);
    assert.match(text, /upstream timeout/);
  });
});

// ---------------------------------------------------------------------------
// Tool guardrail wrapping
// ---------------------------------------------------------------------------

describe("tool guardrail wrapping", () => {
  it("wraps each tool's execute and counts tool calls", async () => {
    const calls = [];
    const tools = {
      search_documents: makeTool(async (args) => {
        calls.push(args);
        return { documents: [] };
      }),
    };

    const events = [];
    // The mock generateText now invokes the tool from inside the stub.
    const generateTextImpl = async ({ tools: passedTools }) => {
      // Drive the wrapped execute directly to mimic an AI-SDK pass.
      await passedTools.search_documents.execute(
        { name: "tv-news" },
        { toolCallId: "1", messages: [] },
      );
      await passedTools.search_documents.execute(
        { name: "tv-news" },
        { toolCallId: "2", messages: [] },
      );
      return { text: "two reads done" };
    };

    const daemon = createOperatorDaemon(
      baseConfig({ tools, generateTextImpl }),
    );
    const event = await daemon.tickOnce();

    assert.strictEqual(calls.length, 2, "underlying tool invoked twice");
    assert.strictEqual(event.toolCalls, 2);
    assert.strictEqual(event.guardrailBlocks, 0);
  });

  it("blocks repeated identical failures and reports it on the event", async () => {
    const tools = {
      execute_workflow: makeTool(async () => {
        throw new Error("workflow not found");
      }),
    };

    const generateTextImpl = async ({ tools: passedTools }) => {
      // Drive the same failing call 6 times — guardrail blocks 5+.
      for (let i = 0; i < 6; i++) {
        try {
          await passedTools.execute_workflow.execute(
            { workflow: "ingest" },
            { toolCallId: String(i), messages: [] },
          );
        } catch {
          // expected — first 5 throw, 6th returns synthetic block result
        }
      }
      return { text: "tried ingest" };
    };

    const daemon = createOperatorDaemon(
      baseConfig({ tools, generateTextImpl }),
    );
    const event = await daemon.tickOnce();
    assert.ok(
      event.guardrailBlocks >= 1,
      `expected at least one block, got ${event.guardrailBlocks}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Heartbeat persistence integration
// ---------------------------------------------------------------------------

describe("heartbeat persistence integration", () => {
  it("configurePersistence is auto-applied with rootDir as stateDir", async () => {
    const daemon = createOperatorDaemon(baseConfig());
    assert.strictEqual(daemon.heartbeat.hasPersistence, true);
  });

  it("does not double-configure persistence if heartbeat already has it", async () => {
    const hb = freshHeartbeat();
    hb.configurePersistence({ stateDir: tmpDir });
    const daemon = createOperatorDaemon(baseConfig({ heartbeat: hb }));
    assert.strictEqual(daemon.heartbeat.hasPersistence, true);
    // tickOnce runs without throwing about double-config.
    const event = await daemon.tickOnce();
    assert.strictEqual(event.type, "tick_published");
  });
});

// ---------------------------------------------------------------------------
// Telemetry hook
// ---------------------------------------------------------------------------

describe("onTickEvent telemetry hook", () => {
  it("fires tick_started followed by tick_published", async () => {
    const events = [];
    const daemon = createOperatorDaemon(
      baseConfig({ onTickEvent: (e) => events.push(e.type) }),
    );
    await daemon.tickOnce();
    assert.deepStrictEqual(events, ["tick_started", "tick_published"]);
  });

  it("fires tick_started followed by tick_failed on error", async () => {
    const events = [];
    const daemon = createOperatorDaemon(
      baseConfig({
        onTickEvent: (e) => events.push(e.type),
        generateTextImpl: async () => {
          throw new Error("nope");
        },
      }),
    );
    await daemon.tickOnce();
    assert.deepStrictEqual(events, ["tick_started", "tick_failed"]);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("config validation", () => {
  it("throws when jobId is missing", () => {
    assert.throws(
      () => createOperatorDaemon({ ...baseConfig(), jobId: "" }),
      /jobId is required/,
    );
  });

  it("throws when intervalMs is non-positive", () => {
    assert.throws(
      () => createOperatorDaemon({ ...baseConfig(), intervalMs: 0 }),
      /intervalMs must be > 0/,
    );
  });

  it("throws when rootDir is missing", () => {
    assert.throws(
      () => createOperatorDaemon({ ...baseConfig(), rootDir: "" }),
      /rootDir is required/,
    );
  });
});

// ---------------------------------------------------------------------------
// Public entry re-exports
// ---------------------------------------------------------------------------

describe("public entry re-exports", () => {
  it("re-exports createOperatorDaemon from index.js", () => {
    assert.strictEqual(typeof publicEntry.createOperatorDaemon, "function");
  });
});
