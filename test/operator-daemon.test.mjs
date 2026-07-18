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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
// persistence opt-out (single-replica mode)
// ---------------------------------------------------------------------------

describe("persistence opt-out", () => {
  it("default configures heartbeat persistence (+ per-job lock)", () => {
    const daemon = createOperatorDaemon(baseConfig());
    assert.strictEqual(daemon.heartbeat.hasPersistence, true);
  });

  it("persistence:false runs the heartbeat in-memory (no lock path)", () => {
    const daemon = createOperatorDaemon(baseConfig({ persistence: false }));
    assert.strictEqual(daemon.heartbeat.hasPersistence, false);
  });

  it("persistence:false still ticks (no lock to stall on)", async () => {
    const daemon = createOperatorDaemon(baseConfig({ persistence: false }));
    const first = await daemon.tickOnce();
    const second = await daemon.tickOnce();
    assert.strictEqual(first.type, "tick_published");
    assert.strictEqual(second.type, "tick_published");
  });
});

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

  it("omits inferenceRoute when the launcher doesn't pass one", async () => {
    const events = [];
    const daemon = createOperatorDaemon(
      baseConfig({ onTickEvent: (e) => events.push(e) }),
    );
    await daemon.tickOnce();
    for (const e of events) {
      assert.strictEqual(e.inferenceRoute, undefined, `event ${e.type}`);
    }
  });

  it("propagates inferenceRoute to every TickEvent the daemon emits", async () => {
    const route = {
      via: "openshell",
      baseUrl: "https://inference.local",
      provider: "anthropic",
      model: "claude-opus-4-6",
    };
    const events = [];
    const daemon = createOperatorDaemon(
      baseConfig({
        inferenceRoute: route,
        onTickEvent: (e) => events.push(e),
      }),
    );
    await daemon.tickOnce();
    // We expect at least tick_started + tick_published, each carrying the route.
    const types = events.map((e) => e.type);
    assert.ok(types.includes("tick_started"));
    assert.ok(types.includes("tick_published"));
    for (const e of events) {
      assert.deepStrictEqual(e.inferenceRoute, route, `event ${e.type}`);
    }
  });

  it("propagates inferenceRoute even on tick_failed", async () => {
    const route = {
      via: "direct",
      provider: "anthropic",
      model: "claude-opus-4-6",
    };
    const failing = async () => {
      throw new Error("boom");
    };
    const events = [];
    const daemon = createOperatorDaemon(
      baseConfig({
        generateTextImpl: failing,
        inferenceRoute: route,
        onTickEvent: (e) => events.push(e),
      }),
    );
    const event = await daemon.tickOnce();
    assert.strictEqual(event.type, "tick_failed");
    assert.deepStrictEqual(event.inferenceRoute, route);
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

  it("does not miscount a non-serialisable success as a failure", async () => {
    // A tool returning a circular-ref result would crash JSON.stringify
    // inside digestResult; without the try/catch around digestResult the
    // outer catch would mark this as a failure. With the fix the success
    // is recorded and no digest is tracked.
    const tools = {
      search_documents: makeTool(async () => {
        const a = { hello: "world" };
        // create a circular reference (un-stringifiable)
        a.self = a;
        return a;
      }),
    };
    const generateTextImpl = async ({ tools: passedTools }) => {
      // Invoke the wrapped tool 4 times. Each succeeds. Without the fix,
      // each would be (mis)counted as a failure and the 4th would trip
      // the warn threshold via per-tool failure tracking.
      for (let i = 0; i < 4; i++) {
        await passedTools.search_documents.execute(
          { i },
          { toolCallId: String(i), messages: [] },
        );
      }
      return { text: "ok" };
    };
    const daemon = createOperatorDaemon(
      baseConfig({ tools, generateTextImpl }),
    );
    const event = await daemon.tickOnce();
    assert.strictEqual(event.type, "tick_published");
    assert.strictEqual(event.toolCalls, 4);
    // No warnings, no blocks — these are successful calls.
    assert.strictEqual(event.guardrailWarnings, 0);
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

  it("tickOnce primes markRunStart so markJobSucceeded actually persists", async () => {
    const daemon = createOperatorDaemon(baseConfig());
    const event = await daemon.tickOnce();
    assert.strictEqual(event.type, "tick_published");
    // Before this fix, the persisted record was a silent no-op because no
    // markRunStart had run first. Now tickOnce primes markJobStart and
    // markJobSucceeded lands on the same record.
    const persisted = await daemon.heartbeat.getPersistedJob("tv-operator-test");
    assert.ok(persisted, "tickOnce must create a persisted record");
    assert.strictEqual(persisted.runCount, 1);
    assert.strictEqual(persisted.lastStatus, "succeeded");
  });

  it("tickOnce on a failing tick persists lastStatus=failed with the error", async () => {
    const daemon = createOperatorDaemon(
      baseConfig({
        generateTextImpl: async () => {
          throw new Error("upstream gone");
        },
      }),
    );
    const event = await daemon.tickOnce();
    assert.strictEqual(event.type, "tick_failed");
    const persisted = await daemon.heartbeat.getPersistedJob("tv-operator-test");
    assert.ok(persisted);
    assert.strictEqual(persisted.lastStatus, "failed");
    assert.match(persisted.lastError, /upstream gone/);
  });

  it("does not mutate cfg.jobId after start() — briefs stay under the operator-supplied id", async () => {
    // Use a fresh heartbeat that we DON'T pre-start, then drive a tick via
    // tickOnce — and verify the brief landed at the operator-supplied jobId
    // (not under an auto-generated cron_xxx_yyy id, which was the bug).
    const cfgIn = baseConfig({ jobId: "stable-operator-id" });
    const daemon = createOperatorDaemon(cfgIn);
    daemon.start();
    // start() previously did `cfg.jobId = cronJob.id` — assert it didn't:
    assert.strictEqual(cfgIn.jobId, "stable-operator-id");
    // cronJob exposed via the daemon must use the same id
    assert.strictEqual(daemon.cronJob.id, "stable-operator-id");
    daemon.stop();
    // Drive a tick after start() to confirm brief routing is stable
    const event = await daemon.tickOnce();
    const briefPath = path.join(
      tmpDir,
      "briefs",
      "stable-operator-id",
      `${event.tickId}.md`,
    );
    assert.ok(fs.existsSync(briefPath), `expected brief at ${briefPath}`);
  });
});

// ---------------------------------------------------------------------------
// Timer-driven path — drives runTick via the heartbeat scheduler instead of
// tickOnce(), so the cron timer's wake-gate + markRunStart + cron_fired
// emission are all exercised end-to-end.
// ---------------------------------------------------------------------------

describe("timer-driven tick path", () => {
  it("start() → cron timer fires → runTick writes brief under operator-supplied jobId", async () => {
    const tickEvents = [];
    const daemon = createOperatorDaemon(
      baseConfig({
        jobId: "stable-operator-id",
        intervalMs: 60_000, // long; rely on the immediate first-fire
        onTickEvent: (e) => tickEvents.push(e),
        generateTextImpl: makeGen("first tick body"),
      }),
    );
    daemon.start();
    // Wait for the heartbeat's immediate first-fire to flow through
    // cron_fired → onEvent → runTick → brief write.
    await wait(150);
    daemon.stop();

    // tick_started + tick_published landed via the event handler
    const types = tickEvents.map((e) => e.type);
    assert.ok(types.includes("tick_started"), `missing tick_started, got ${types.join(",")}`);
    assert.ok(types.includes("tick_published"), `missing tick_published, got ${types.join(",")}`);

    // Brief is on disk under the operator-supplied jobId
    const briefRoot = path.join(tmpDir, "briefs", "stable-operator-id");
    assert.ok(fs.existsSync(briefRoot), `expected brief dir at ${briefRoot}`);
    const briefs = fs.readdirSync(briefRoot).filter((f) => f.endsWith(".md"));
    assert.strictEqual(briefs.length, 1);
    const text = fs.readFileSync(path.join(briefRoot, briefs[0]), "utf8");
    assert.match(text, /first tick body/);

    // Heartbeat persistence reflects the timer-driven fire (markRunStart
    // ran inside execute(), then markJobSucceeded ran from runTick).
    const persisted = await daemon.heartbeat.getPersistedJob("stable-operator-id");
    assert.ok(persisted, "timer-driven tick must persist heartbeat state");
    assert.strictEqual(persisted.runCount, 1);
    assert.strictEqual(persisted.lastStatus, "succeeded");
  });

  it("wake-gate denial → cron_skipped → tick_skipped, no brief written", async () => {
    const tickEvents = [];
    const daemon = createOperatorDaemon(
      baseConfig({
        jobId: "gated-job",
        intervalMs: 60_000,
        onTickEvent: (e) => tickEvents.push(e.type),
        wakeGate: () => ({ wake: false, reason: "fixtures fresh" }),
      }),
    );
    daemon.start();
    await wait(150);
    daemon.stop();

    assert.ok(
      tickEvents.includes("tick_skipped"),
      `expected tick_skipped, got ${tickEvents.join(",")}`,
    );
    assert.ok(
      !tickEvents.includes("tick_started"),
      "tick_started should not fire when the wake gate denies",
    );
    // No brief should have been written
    const briefRoot = path.join(tmpDir, "briefs", "gated-job");
    assert.ok(!fs.existsSync(briefRoot), "no brief should be written on a skipped tick");
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
// onToolCall telemetry hook — per-tool execution observability
// ---------------------------------------------------------------------------

describe("onToolCall telemetry hook", () => {
  it("fires once per tool execution with timing + outcome", async () => {
    const calls = [];
    const tools = {
      search_documents: makeTool(async () => ({ documents: [] })),
    };
    const generateTextImpl = async ({ tools: passedTools }) => {
      await passedTools.search_documents.execute(
        { name: "tv-news" },
        { toolCallId: "1", messages: [] },
      );
      return { text: "done" };
    };
    const daemon = createOperatorDaemon(
      baseConfig({
        tools,
        generateTextImpl,
        onToolCall: (e) => calls.push(e),
      }),
    );
    await daemon.tickOnce();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].toolName, "search_documents");
    assert.strictEqual(calls[0].outcome, "ok");
    assert.strictEqual(typeof calls[0].durationMs, "number");
    assert.ok(calls[0].tickId.startsWith("tick_"));
    assert.strictEqual(calls[0].jobId, "tv-operator-test");
  });

  it("records outcome=error when the underlying tool throws", async () => {
    const calls = [];
    const tools = {
      execute_workflow: makeTool(async () => {
        throw new Error("workflow not found");
      }),
    };
    const generateTextImpl = async ({ tools: passedTools }) => {
      try {
        await passedTools.execute_workflow.execute(
          { workflow: "ingest" },
          { toolCallId: "1", messages: [] },
        );
      } catch {
        // expected
      }
      return { text: "tried" };
    };
    const daemon = createOperatorDaemon(
      baseConfig({
        tools,
        generateTextImpl,
        onToolCall: (e) => calls.push(e),
      }),
    );
    await daemon.tickOnce();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].outcome, "error");
    assert.match(calls[0].reason, /workflow not found/);
  });

  it("records outcome=blocked when the guardrail blocks a tool", async () => {
    const calls = [];
    const tools = {
      execute_workflow: makeTool(async () => {
        throw new Error("workflow not found");
      }),
    };
    const generateTextImpl = async ({ tools: passedTools }) => {
      // Drive the same failing call 6 times — guardrail blocks at 5+.
      for (let i = 0; i < 6; i++) {
        try {
          await passedTools.execute_workflow.execute(
            { workflow: "ingest" },
            { toolCallId: String(i), messages: [] },
          );
        } catch {
          // expected
        }
      }
      return { text: "tried" };
    };
    const daemon = createOperatorDaemon(
      baseConfig({
        tools,
        generateTextImpl,
        onToolCall: (e) => calls.push(e),
      }),
    );
    await daemon.tickOnce();
    const outcomes = calls.map((c) => c.outcome);
    // 5 error outcomes + at least one block.
    assert.ok(
      outcomes.includes("blocked"),
      "expected at least one outcome=blocked, got " + JSON.stringify(outcomes),
    );
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
// Editorial-memory writeback tools — daemon-level wiring
// ---------------------------------------------------------------------------

describe("editorial-memory tools (daemon wiring)", () => {
  // The daemon adds add_lesson / replace_lesson / remove_lesson into the
  // tick's toolset by default. Disable via enableMemoryTools: false.
  // The model stub here captures the tools it receives so we can pin
  // their presence/absence without driving a real LLM.

  function makeGenCapturingTools() {
    let captured = null;
    const impl = async ({ tools }) => {
      captured = tools ?? {};
      return { text: "ok" };
    };
    impl.captured = () => captured;
    return impl;
  }

  it("registers add/replace/remove_lesson by default", async () => {
    const gen = makeGenCapturingTools();
    const daemon = createOperatorDaemon(
      baseConfig({ generateTextImpl: gen }),
    );
    await daemon.tickOnce();
    const tools = gen.captured() ?? {};
    assert.ok(tools["add_lesson"], "add_lesson must be registered by default");
    assert.ok(tools["replace_lesson"], "replace_lesson must be registered by default");
    assert.ok(tools["remove_lesson"], "remove_lesson must be registered by default");
  });

  it("does NOT register memory tools when enableMemoryTools is false", async () => {
    const gen = makeGenCapturingTools();
    const daemon = createOperatorDaemon(
      baseConfig({ generateTextImpl: gen, enableMemoryTools: false }),
    );
    await daemon.tickOnce();
    const tools = gen.captured() ?? {};
    assert.strictEqual(tools["add_lesson"], undefined);
    assert.strictEqual(tools["replace_lesson"], undefined);
    assert.strictEqual(tools["remove_lesson"], undefined);
  });

  it("preserves caller-supplied tools alongside memory tools", async () => {
    const callerTool = makeTool(async () => "from caller");
    const gen = makeGenCapturingTools();
    const daemon = createOperatorDaemon(
      baseConfig({
        generateTextImpl: gen,
        tools: { caller_thing: callerTool },
      }),
    );
    await daemon.tickOnce();
    const tools = gen.captured() ?? {};
    assert.ok(tools["caller_thing"]);
    assert.ok(tools["add_lesson"]);
  });

  it("memory writes from a tick land on disk (visible to a fresh load)", async () => {
    // Drive the model stub to invoke add_lesson against the daemon's
    // memory, then verify the file picks it up after the tick.
    const memoryFilePath = path.join(tmpDir, "editorial-memory.md");
    const generateTextImpl = async ({ tools: passed }) => {
      await passed.add_lesson.execute(
        { body: "Test lesson from a mocked tick." },
        { toolCallId: "t1", messages: [] },
      );
      return { text: "ok" };
    };
    const daemon = createOperatorDaemon(
      baseConfig({ generateTextImpl }),
    );
    await daemon.tickOnce();
    const text = fs.readFileSync(memoryFilePath, "utf8");
    assert.match(text, /Test lesson from a mocked tick/);
  });
});

// ---------------------------------------------------------------------------
// Structured output — cfg.outputSchema path
// ---------------------------------------------------------------------------

describe("tickOnce — structured output", () => {
  const minimalSchema = {
    type: "object",
    properties: {
      silent: { type: "boolean" },
      narrative: { type: "string" },
    },
    required: ["silent"],
    additionalProperties: false,
  };

  /**
   * generateText stub that records its args and returns a fixed result.
   * `result` is what the daemon will see — for structured mode the validated
   * object arrives as the input of the forced `submit_broadcast` tool call
   * (see outputToolResult), since the Privacy Router strips `response_format`.
   */
  function makeGenWithResult(result) {
    const calls = [];
    const impl = async (args) => {
      calls.push(args);
      return result;
    };
    impl.calls = calls;
    return impl;
  }

  /** Build the generateText result shape the daemon reads in structured mode. */
  function outputToolResult(input) {
    return { toolCalls: [{ toolName: "submit_broadcast", input }], text: "" };
  }

  it("injects the submit_broadcast output tool when outputSchema is set", async () => {
    const gen = makeGenWithResult(
      outputToolResult({ silent: false, narrative: "Tip-off in 5." }),
    );
    const daemon = createOperatorDaemon(
      baseConfig({
        generateTextImpl: gen,
        outputSchema: { schema: minimalSchema, name: "Broadcast" },
      }),
    );
    await daemon.tickOnce();
    assert.strictEqual(gen.calls.length, 1);
    // Structured output travels via a forced tool call, not experimental_output
    // (the Privacy Router strips response_format).
    assert.strictEqual(gen.calls[0].experimental_output, undefined);
    assert.ok(
      gen.calls[0].tools?.submit_broadcast,
      "expected submit_broadcast tool in generateText args",
    );
    assert.ok(
      gen.calls[0].tools.submit_broadcast.inputSchema,
      "output tool carries the schema as its inputSchema",
    );
    // execute-less: it's a declarative sink, the daemon reads its input.
    assert.strictEqual(
      gen.calls[0].tools.submit_broadcast.execute,
      undefined,
    );
  });

  it("does NOT inject the output tool when outputSchema is unset (legacy path)", async () => {
    const gen = makeGenWithResult({ text: "free-text tick" });
    const daemon = createOperatorDaemon(
      baseConfig({ generateTextImpl: gen }),
    );
    await daemon.tickOnce();
    assert.strictEqual(gen.calls.length, 1);
    assert.strictEqual(gen.calls[0].experimental_output, undefined);
    assert.strictEqual(gen.calls[0].tools?.submit_broadcast, undefined);
  });

  it("suppresses the [SILENT] sentinel fragment in the system prompt", async () => {
    const gen = makeGenWithResult(
      outputToolResult({ silent: false, narrative: "x" }),
    );
    const daemon = createOperatorDaemon(
      baseConfig({
        generateTextImpl: gen,
        outputSchema: { schema: minimalSchema },
      }),
    );
    await daemon.tickOnce();
    const sys = gen.calls[0].system;
    assert.doesNotMatch(
      sys,
      /\[SILENT\] sentinel/,
      "schema's silent field replaces the sentinel; both = conflicting instructions",
    );
  });

  it("keeps the [SILENT] sentinel fragment when outputSchema is unset", async () => {
    const gen = makeGenWithResult({ text: "free-text" });
    const daemon = createOperatorDaemon(
      baseConfig({ generateTextImpl: gen }),
    );
    await daemon.tickOnce();
    assert.match(gen.calls[0].system, /\[SILENT\] sentinel/);
  });

  it("raises maxOutputTokens default (4096 → 16384) when outputSchema is set", async () => {
    const gen = makeGenWithResult(
      outputToolResult({ silent: false, narrative: "x" }),
    );
    const daemon = createOperatorDaemon(
      baseConfig({
        generateTextImpl: gen,
        outputSchema: { schema: minimalSchema },
      }),
    );
    await daemon.tickOnce();
    assert.strictEqual(gen.calls[0].maxOutputTokens, 16384);
  });

  it("respects explicit cfg.maxOutputTokens override even with outputSchema", async () => {
    const gen = makeGenWithResult(
      outputToolResult({ silent: false, narrative: "x" }),
    );
    const daemon = createOperatorDaemon(
      baseConfig({
        generateTextImpl: gen,
        outputSchema: { schema: minimalSchema },
        maxOutputTokens: 1024,
      }),
    );
    await daemon.tickOnce();
    assert.strictEqual(gen.calls[0].maxOutputTokens, 1024);
  });

  it("populates TickEvent.output with the validated object and text with .narrative", async () => {
    const obj = { silent: false, narrative: "Lakers up 102-99 with 2:14 left." };
    const gen = makeGenWithResult(outputToolResult(obj));
    const daemon = createOperatorDaemon(
      baseConfig({
        generateTextImpl: gen,
        outputSchema: { schema: minimalSchema },
      }),
    );
    const event = await daemon.tickOnce();
    assert.strictEqual(event.type, "tick_published");
    assert.deepStrictEqual(event.output, obj);
    assert.strictEqual(event.text, obj.narrative);
  });

  it("treats output.silent=true as tick_silent but still carries output for observability", async () => {
    const obj = { silent: true, narrative: "" };
    const gen = makeGenWithResult(outputToolResult(obj));
    const events = [];
    const daemon = createOperatorDaemon(
      baseConfig({
        generateTextImpl: gen,
        outputSchema: { schema: minimalSchema },
        onTickEvent: (e) => events.push(e),
      }),
    );
    const event = await daemon.tickOnce();
    assert.strictEqual(event.type, "tick_silent");
    assert.strictEqual(event.text, undefined);
    assert.deepStrictEqual(event.output, obj);
  });

  it("treats silent=false with empty narrative as tick_published (sink decides what to do)", async () => {
    // The PR comment explicitly says: a schema-validated payload with
    // silent=false but an empty narrative is *malformed*, not silent — the
    // sink is responsible for suppressing/handling it.
    const obj = { silent: false, narrative: "" };
    const gen = makeGenWithResult(outputToolResult(obj));
    const daemon = createOperatorDaemon(
      baseConfig({
        generateTextImpl: gen,
        outputSchema: { schema: minimalSchema },
      }),
    );
    const event = await daemon.tickOnce();
    assert.strictEqual(event.type, "tick_published");
    assert.strictEqual(event.text, "");
    assert.deepStrictEqual(event.output, obj);
  });

  it("treats a missing output tool call as tick_failed (not a silent success)", async () => {
    // Domain-neutral operator (PR2): a structured tick that never called the
    // output tool is a failure to surface, not a silent no-op.
    const gen = makeGenWithResult({ text: "ignored in structured mode", toolCalls: [] });
    const daemon = createOperatorDaemon(
      baseConfig({
        generateTextImpl: gen,
        outputSchema: { schema: minimalSchema },
      }),
    );
    const event = await daemon.tickOnce();
    assert.strictEqual(event.type, "tick_failed");
    assert.match(event.reason ?? "", /did not call the submit_broadcast output tool/);
  });

  it("forwards outputSchema.description onto the submit_broadcast tool", async () => {
    const gen = makeGenWithResult(
      outputToolResult({ silent: false, narrative: "ok" }),
    );
    const daemon = createOperatorDaemon(
      baseConfig({
        generateTextImpl: gen,
        outputSchema: {
          schema: minimalSchema,
          name: "Broadcast",
          description: "TV broadcast tick payload",
        },
      }),
    );
    const event = await daemon.tickOnce();
    assert.strictEqual(event.type, "tick_published");
    assert.strictEqual(
      gen.calls[0].tools.submit_broadcast.description,
      "TV broadcast tick payload",
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
