/**
 * Operator Daemon Context Chaining / Payload Handover — test suite
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  LastTickBrief,
  serializeBrief,
  parseBrief,
} from "../dist/last-tick-brief.js";
import { createOperatorDaemon } from "../dist/operator-daemon.js";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "operator-context-chaining-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function baseConfig(overrides) {
  return {
    jobId: "test-chaining-job",
    intervalMs: 1000,
    model: { id: "test-model" },
    role: "Test persona",
    rootDir: tmpDir,
    enableMemoryTools: false,
    ...overrides,
  };
}

function makeGenWithResult(result) {
  const calls = [];
  const impl = async (args) => {
    calls.push(args);
    return result;
  };
  impl.calls = calls;
  return impl;
}

// Structured output travels via a forced `submit_broadcast` tool call (the
// Privacy Router strips `response_format`); the validated object is its input.
function outputToolResult(input) {
  return { toolCalls: [{ toolName: "submit_broadcast", input }], text: "" };
}

describe("Operator Daemon — Context Chaining & Scheduled Payload Handover", () => {
  
  describe("Serialization & Parsing of Brief Payloads", () => {
    it("round-trips standard structured payloads correctly", () => {
      const originalBrief = {
        tickId: "tick_123",
        jobId: "test-job",
        timestamp: "2026-05-22T12:00:00.000Z",
        body: "Successfully planned next playout block.",
        silent: false,
        payload: {
          remainingPlayoutSec: 180,
          pendingCues: ["cue_intro_1", "cue_ad_break"],
          channelMeta: {
            activeSegment: "live_game",
            bitrate: 4500
          }
        }
      };

      const serialized = serializeBrief(originalBrief);
      assert.match(serialized, /payload: \{"remainingPlayoutSec":180/);
      
      const parsed = parseBrief(serialized);
      assert.strictEqual(parsed.tickId, originalBrief.tickId);
      assert.strictEqual(parsed.jobId, originalBrief.jobId);
      assert.strictEqual(parsed.body, originalBrief.body);
      assert.deepEqual(parsed.payload, originalBrief.payload);
    });

    it("gracefully parses briefs when payload frontmatter is absent", () => {
      const briefNoPayload = `---
tickId: tick_456
jobId: test-job
timestamp: 2026-05-22T12:05:00.000Z
silent: false
---

No payload here, just text.`;

      const parsed = parseBrief(briefNoPayload);
      assert.strictEqual(parsed.tickId, "tick_456");
      assert.strictEqual(parsed.payload, undefined);
    });
  });

  describe("LastTickBrief Payload Storage", () => {
    it("writes and reads a brief with structured payload context", async () => {
      const ltb = new LastTickBrief(tmpDir);
      const testPayload = {
        remainingPlayoutSec: 3600,
        pendingCues: ["commercial_break"]
      };

      const written = await ltb.write({
        tickId: "tick_001",
        jobId: "tv-playout",
        body: "Maintained run of show.",
        payload: testPayload
      });

      assert.deepEqual(written.payload, testPayload);

      // Verify actual file exists and contains the serialized payload
      const filePath = path.join(tmpDir, "tv-playout", "tick_001.md");
      assert.ok(fs.existsSync(filePath));
      const content = fs.readFileSync(filePath, "utf8");
      assert.match(content, /payload: \{"remainingPlayoutSec":3600/);

      // Read back via loadOne
      const loaded = await ltb.loadOne("tv-playout", "tick_001");
      assert.ok(loaded);
      assert.deepEqual(loaded.payload, testPayload);
    });

    it("includes the serialized payload JSON in contextFrom formatting", async () => {
      const ltb = new LastTickBrief(tmpDir);
      const testPayload = {
        cueId: "pre-roll",
        playoutSec: 30
      };

      await ltb.write({
        tickId: "tick_001",
        jobId: "sports-channel",
        body: "Playout is active.",
        payload: testPayload
      });

      const context = await ltb.contextFrom(["sports-channel"]);
      assert.match(context, /#### Structured Payload \/ Context Chaining:/);
      assert.match(context, /"cueId": "pre-roll"/);
      assert.match(context, /"playoutSec": 30/);
    });
  });

  describe("Operator Loop Handoff & Continuity", () => {
    const outputSchema = {
      type: "object",
      properties: {
        silent: { type: "boolean" },
        narrative: { type: "string" },
        remainingPlayoutSec: { type: "number" },
        pendingCues: { type: "array" }
      },
      required: ["silent", "narrative", "remainingPlayoutSec", "pendingCues"]
    };

    it("captures structured output in tick 1, and hands it over to tick 2 as system prompt context", async () => {
      const tick1Output = {
        silent: false,
        narrative: "Playing live feed.",
        remainingPlayoutSec: 420,
        pendingCues: ["cue_midroll_1"]
      };

      const gen1 = makeGenWithResult(outputToolResult(tick1Output));
      const daemon1 = createOperatorDaemon(
        baseConfig({
          generateTextImpl: gen1,
          outputSchema: { schema: outputSchema },
        })
      );

      // Run Tick 1
      const event1 = await daemon1.tickOnce();
      assert.strictEqual(event1.type, "tick_published");
      assert.deepEqual(event1.output, tick1Output);

      // Verify the generated brief has the correct payload
      const briefStore = new LastTickBrief(path.join(tmpDir, "briefs"));
      const briefs = await briefStore.loadRecent("test-chaining-job", 1);
      assert.strictEqual(briefs.length, 1);
      assert.deepEqual(briefs[0].payload, tick1Output);

      // Now set up Tick 2 daemon (simulates the next scheduled run picking up the handoff)
      const tick2Output = {
        silent: true,
        narrative: "Playout unchanged.",
        remainingPlayoutSec: 360,
        pendingCues: []
      };

      const gen2 = makeGenWithResult(outputToolResult(tick2Output));
      const daemon2 = createOperatorDaemon(
        baseConfig({
          generateTextImpl: gen2,
          outputSchema: { schema: outputSchema },
        })
      );

      // Run Tick 2
      await daemon2.tickOnce();

      // Ensure the system prompt for Tick 2 contained the structured payload from Tick 1
      assert.strictEqual(gen2.calls.length, 1);
      const tick2SystemPrompt = gen2.calls[0].system;
      
      assert.match(tick2SystemPrompt, /# Previous tick brief/);
      assert.match(tick2SystemPrompt, /#### Structured Payload \/ Context Chaining:/);
      assert.match(tick2SystemPrompt, /"remainingPlayoutSec": 420/);
      assert.match(tick2SystemPrompt, /"cue_midroll_1"/);
    });
  });
});
