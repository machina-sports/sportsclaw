/**
 * Operator Health Snapshot — test suite
 *
 * Tests for buildHealthSnapshot and validateHealthSnapshot utilities.
 * Written test-first (TDD).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildHealthSnapshot,
  validateHealthSnapshot,
} from "../dist/schema/tv.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validInput(overrides = {}) {
  return {
    timestamp: "2026-05-06T12:00:00.000Z",
    channelId: "channel-1",
    activeBlocks: 3,
    staleSources: 0,
    errors: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildHealthSnapshot — status derivation
// ---------------------------------------------------------------------------

describe("buildHealthSnapshot", () => {
  it("returns healthy when errors=0 and staleSources=0", () => {
    const snap = buildHealthSnapshot(validInput());
    assert.strictEqual(snap.status, "healthy");
    assert.strictEqual(snap.channelId, "channel-1");
    assert.strictEqual(snap.activeBlocks, 3);
    assert.strictEqual(snap.staleSources, 0);
    assert.deepStrictEqual(snap.errors, []);
    assert.strictEqual(snap.timestamp, "2026-05-06T12:00:00.000Z");
  });

  it("returns degraded when staleSources > 0", () => {
    const snap = buildHealthSnapshot(validInput({ staleSources: 2 }));
    assert.strictEqual(snap.status, "degraded");
  });

  it("returns degraded when non-critical errors exist", () => {
    const snap = buildHealthSnapshot(
      validInput({ errors: ["timeout fetching scores"] }),
    );
    assert.strictEqual(snap.status, "degraded");
  });

  it("returns down when activeBlocks = 0", () => {
    const snap = buildHealthSnapshot(validInput({ activeBlocks: 0 }));
    assert.strictEqual(snap.status, "down");
  });

  it("returns down when errors contain a critical keyword", () => {
    const snap = buildHealthSnapshot(
      validInput({ errors: ["CRITICAL: pipeline failure"] }),
    );
    assert.strictEqual(snap.status, "down");
  });

  it("returns down when errors contain a down keyword", () => {
    const snap = buildHealthSnapshot(
      validInput({ errors: ["source is DOWN"] }),
    );
    assert.strictEqual(snap.status, "down");
  });

  it("down takes precedence over degraded signals", () => {
    const snap = buildHealthSnapshot(
      validInput({ staleSources: 1, activeBlocks: 0 }),
    );
    assert.strictEqual(snap.status, "down");
  });

  it("passes through all input fields", () => {
    const snap = buildHealthSnapshot(validInput({
      timestamp: "2026-01-01T00:00:00Z",
      channelId: "ch-42",
      activeBlocks: 7,
      staleSources: 1,
      errors: ["stale cache"],
    }));
    assert.strictEqual(snap.timestamp, "2026-01-01T00:00:00Z");
    assert.strictEqual(snap.channelId, "ch-42");
    assert.strictEqual(snap.activeBlocks, 7);
    assert.strictEqual(snap.staleSources, 1);
    assert.deepStrictEqual(snap.errors, ["stale cache"]);
  });
});

// ---------------------------------------------------------------------------
// validateHealthSnapshot
// ---------------------------------------------------------------------------

describe("validateHealthSnapshot", () => {
  it("accepts a valid snapshot", () => {
    const snap = buildHealthSnapshot(validInput());
    const result = validateHealthSnapshot(snap);
    assert.strictEqual(result.ok, true);
  });

  it("rejects missing timestamp", () => {
    const snap = buildHealthSnapshot(validInput());
    delete snap.timestamp;
    const result = validateHealthSnapshot(snap);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("timestamp"));
  });

  it("rejects empty string timestamp", () => {
    const snap = { ...buildHealthSnapshot(validInput()), timestamp: "" };
    const result = validateHealthSnapshot(snap);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("timestamp"));
  });

  it("rejects missing channelId", () => {
    const snap = buildHealthSnapshot(validInput());
    delete snap.channelId;
    const result = validateHealthSnapshot(snap);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("channelid"));
  });

  it("rejects empty string channelId", () => {
    const snap = { ...buildHealthSnapshot(validInput()), channelId: "" };
    const result = validateHealthSnapshot(snap);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("channelid"));
  });

  it("rejects invalid status", () => {
    const snap = { ...buildHealthSnapshot(validInput()), status: "unknown" };
    const result = validateHealthSnapshot(snap);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("status"));
  });

  it("rejects negative activeBlocks", () => {
    const snap = { ...buildHealthSnapshot(validInput()), activeBlocks: -1 };
    const result = validateHealthSnapshot(snap);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("activeblocks"));
  });

  it("rejects negative staleSources", () => {
    const snap = { ...buildHealthSnapshot(validInput()), staleSources: -1 };
    const result = validateHealthSnapshot(snap);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("stalesources"));
  });

  it("rejects errors that is not an array", () => {
    const snap = { ...buildHealthSnapshot(validInput()), errors: "not-array" };
    const result = validateHealthSnapshot(snap);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("errors"));
  });

  it("rejects null input", () => {
    const result = validateHealthSnapshot(null);
    assert.strictEqual(result.ok, false);
  });

  it("rejects undefined input", () => {
    const result = validateHealthSnapshot(undefined);
    assert.strictEqual(result.ok, false);
  });

  it("accepts activeBlocks = 0 as valid (validator only checks non-negative)", () => {
    const snap = { ...buildHealthSnapshot(validInput({ activeBlocks: 0 })) };
    const result = validateHealthSnapshot(snap);
    assert.strictEqual(result.ok, true);
  });
});
