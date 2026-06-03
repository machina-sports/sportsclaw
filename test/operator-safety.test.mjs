/**
 * Operator Daemon Broadcast Safety — test suite
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { createOperatorDaemon } from "../dist/operator-daemon.js";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "operator-safety-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function baseConfig(overrides) {
  return {
    jobId: "test-safety-job",
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

// Structured output now travels via a forced `submit_broadcast` tool call
// (the Privacy Router strips `response_format`). Build the generateText result
// shape the daemon reads: the validated object as the tool call's `input`.
function outputToolResult(input) {
  return { toolCalls: [{ toolName: "submit_broadcast", input }], text: "" };
}

describe("Operator Daemon — Broadcast Safety & Fallback Gates", () => {
  const playlistSchema = {
    type: "object",
    properties: {
      id: { type: "string" },
      channelId: { type: "string" },
      blocks: { type: "array" },
      createdAt: { type: "string" },
    },
    required: ["id", "channelId", "blocks", "createdAt"],
  };

  it("passes validation when a correct manifest is emitted", async () => {
    const validManifest = {
      id: "manifest-1",
      channelId: "test-safety-job",
      blocks: [
        {
          id: "block-1",
          title: "Introduction",
          durationSec: 120,
          freshness: "FRESH",
          fallback: { blockId: "slate", reason: "Source down" },
        },
      ],
      createdAt: new Date().toISOString(),
    };

    const gen = makeGenWithResult(outputToolResult(validManifest));
    const daemon = createOperatorDaemon(
      baseConfig({
        generateTextImpl: gen,
        outputSchema: { schema: playlistSchema },
        broadcastSafety: {
          enabled: true,
          options: {
            minimumTotalDurationSec: 60,
          },
        },
      }),
    );

    const event = await daemon.tickOnce();
    assert.strictEqual(event.type, "tick_published");
    assert.deepEqual(event.output, validManifest);
    assert.ok(event.safetyValidation);
    assert.strictEqual(event.safetyValidation.passed, true);
    assert.strictEqual(event.safetyValidation.fallbackTriggered, false);
  });

  it("escalates to tick_failed when validation fails and no fallbackManifest is configured", async () => {
    // Per the new contract, the daemon refuses to invent broadcast content.
    // Without a sink-supplied fallback, a failed safety check is a hard
    // failure — the sink decides what viewers see, not the daemon.
    const invalidManifest = {
      id: "manifest-bad",
      channelId: "test-safety-job",
      blocks: [
        {
          id: "block-1",
          title: "Introduction",
          durationSec: 120,
          freshness: "FRESH",
          // missing fallback
        },
      ],
      createdAt: new Date().toISOString(),
    };

    const gen = makeGenWithResult(outputToolResult(invalidManifest));
    const daemon = createOperatorDaemon(
      baseConfig({
        generateTextImpl: gen,
        outputSchema: { schema: playlistSchema },
        broadcastSafety: {
          enabled: true,
        },
      }),
    );

    const event = await daemon.tickOnce();
    assert.strictEqual(event.type, "tick_failed");
    assert.match(event.reason, /Broadcast safety check failed and no fallbackManifest configured/);
    assert.ok(event.safetyValidation);
    assert.strictEqual(event.safetyValidation.passed, false);
    assert.strictEqual(event.safetyValidation.fallbackTriggered, false);
    assert.deepEqual(event.safetyValidation.originalOutput, invalidManifest);
  });

  it("respects custom fallbackManifest when fallback gate is triggered", async () => {
    const invalidManifest = {
      id: "manifest-bad",
      channelId: "test-safety-job",
      blocks: [], // Empty manifest fails basic validations
      createdAt: new Date().toISOString(),
    };

    const customFallback = {
      id: "custom-fallback-id",
      channelId: "test-safety-job",
      blocks: [
        {
          id: "custom-block",
          title: "Custom Fallback Block",
          durationSec: 600,
          freshness: "EVERGREEN",
          fallback: { blockId: "custom-evergreen", reason: "custom fallback" },
        },
      ],
      createdAt: new Date().toISOString(),
    };

    const gen = makeGenWithResult(outputToolResult(invalidManifest));
    const daemon = createOperatorDaemon(
      baseConfig({
        generateTextImpl: gen,
        outputSchema: { schema: playlistSchema },
        broadcastSafety: {
          enabled: true,
          fallbackManifest: customFallback,
        },
      }),
    );

    const event = await daemon.tickOnce();
    assert.strictEqual(event.type, "tick_published");
    assert.ok(event.safetyValidation);
    assert.strictEqual(event.safetyValidation.passed, false);
    assert.strictEqual(event.safetyValidation.fallbackTriggered, true);
    assert.deepEqual(event.output, customFallback);
  });

  it("checks freshness and triggers fallback gate for stale LIVE blocks (with configured fallback)", async () => {
    const staleTimestamp = new Date(Date.now() - 30000).toISOString(); // 30s ago
    const staleManifest = {
      id: "manifest-stale",
      channelId: "test-safety-job",
      blocks: [
        {
          id: "live-block-1",
          title: "Live Game Coverage",
          durationSec: 300,
          freshness: "LIVE",
          sourceRef: "feed-1",
          freshnessTimestamp: staleTimestamp,
          fallback: { blockId: "backup-slate", reason: "Live lost" },
        },
      ],
      createdAt: new Date().toISOString(),
    };

    const sinkFallback = {
      id: "sink-emergency",
      channelId: "test-safety-job",
      blocks: [
        {
          id: "sink-evergreen",
          title: "Sink-supplied evergreen",
          durationSec: 300,
          freshness: "EVERGREEN",
          fallback: { blockId: "evergreen", reason: "sink fallback" },
        },
      ],
      createdAt: new Date().toISOString(),
    };

    const gen = makeGenWithResult(outputToolResult(staleManifest));
    const daemon = createOperatorDaemon(
      baseConfig({
        generateTextImpl: gen,
        outputSchema: { schema: playlistSchema },
        broadcastSafety: {
          enabled: true,
          options: {
            requireFreshnessForLiveBlocks: true,
            maxLiveAgeMs: 10000, // 10s maximum age
          },
          fallbackManifest: sinkFallback,
        },
      }),
    );

    const event = await daemon.tickOnce();
    assert.strictEqual(event.type, "tick_published");
    assert.ok(event.safetyValidation);
    assert.strictEqual(event.safetyValidation.passed, false);
    assert.strictEqual(event.safetyValidation.fallbackTriggered, true);
    assert.match(event.safetyValidation.error, /freshness is stale/);
    assert.deepEqual(event.output, sinkFallback);
  });
});
