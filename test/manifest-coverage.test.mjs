/**
 * Manifest Coverage — test suite
 *
 * Tests for validateManifestCoverage utility — a higher-level check that runs
 * after validatePlaylistManifest and enforces optional coverage policies
 * (duration bounds, fallback presence, freshness recency, block counts).
 *
 * Written test-first (TDD).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  validateManifestCoverage,
} from "../dist/schema/tv.js";

import * as publicEntry from "../dist/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED_NOW_MS = Date.parse("2026-05-06T12:00:00.000Z");

function freshnessIso(offsetMs = 0) {
  return new Date(FIXED_NOW_MS - offsetMs).toISOString();
}

function validBlock(overrides = {}) {
  return {
    id: "block-1",
    title: "Segment",
    durationSec: 120,
    freshness: "FRESH",
    fallback: { blockId: "block-evergreen-1", reason: "source-down" },
    sourceRef: "feed:generic:segment",
    ...overrides,
  };
}

function liveBlock(overrides = {}) {
  return validBlock({
    id: "block-live-1",
    freshness: "LIVE",
    sourceRef: "feed:live:event-1",
    freshnessTimestamp: freshnessIso(0),
    ...overrides,
  });
}

function validManifest(overrides = {}) {
  return {
    id: "manifest-1",
    channelId: "channel-1",
    blocks: [validBlock()],
    createdAt: "2026-05-06T11:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Public export surface
// ---------------------------------------------------------------------------

describe("public exports", () => {
  it("re-exports validateManifestCoverage from the package entry point", () => {
    assert.strictEqual(
      typeof publicEntry.validateManifestCoverage,
      "function",
    );
  });
});

// ---------------------------------------------------------------------------
// Base manifest validation must pass first
// ---------------------------------------------------------------------------

describe("validateManifestCoverage — base manifest validation", () => {
  it("returns ok for a valid manifest with no options", () => {
    const result = validateManifestCoverage(validManifest());
    assert.strictEqual(result.ok, true);
  });

  it("returns ok for a valid manifest with empty options", () => {
    const result = validateManifestCoverage(validManifest(), {});
    assert.strictEqual(result.ok, true);
  });

  it("rejects when the underlying manifest is invalid (no blocks)", () => {
    const result = validateManifestCoverage(validManifest({ blocks: [] }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("block"));
  });

  it("rejects when an underlying block has non-positive duration", () => {
    const bad = validBlock({ durationSec: 0 });
    const result = validateManifestCoverage(validManifest({ blocks: [bad] }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("duration"));
  });
});

// ---------------------------------------------------------------------------
// minimumTotalDurationSec
// ---------------------------------------------------------------------------

describe("validateManifestCoverage — minimumTotalDurationSec", () => {
  it("accepts when total duration meets the minimum exactly", () => {
    const blocks = [validBlock({ id: "b1", durationSec: 60 }), validBlock({ id: "b2", durationSec: 60 })];
    const result = validateManifestCoverage(
      validManifest({ blocks }),
      { minimumTotalDurationSec: 120 },
    );
    assert.strictEqual(result.ok, true);
  });

  it("accepts when total duration exceeds the minimum", () => {
    const blocks = [validBlock({ durationSec: 300 })];
    const result = validateManifestCoverage(
      validManifest({ blocks }),
      { minimumTotalDurationSec: 120 },
    );
    assert.strictEqual(result.ok, true);
  });

  it("rejects when total duration is below the minimum", () => {
    const blocks = [validBlock({ durationSec: 60 })];
    const result = validateManifestCoverage(
      validManifest({ blocks }),
      { minimumTotalDurationSec: 120 },
    );
    assert.strictEqual(result.ok, false);
    assert.ok(/minimum|duration/i.test(result.error));
  });
});

// ---------------------------------------------------------------------------
// maximumTotalDurationSec
// ---------------------------------------------------------------------------

describe("validateManifestCoverage — maximumTotalDurationSec", () => {
  it("accepts when total duration meets the maximum exactly", () => {
    const blocks = [validBlock({ durationSec: 120 })];
    const result = validateManifestCoverage(
      validManifest({ blocks }),
      { maximumTotalDurationSec: 120 },
    );
    assert.strictEqual(result.ok, true);
  });

  it("rejects when total duration exceeds the maximum", () => {
    const blocks = [validBlock({ durationSec: 300 })];
    const result = validateManifestCoverage(
      validManifest({ blocks }),
      { maximumTotalDurationSec: 120 },
    );
    assert.strictEqual(result.ok, false);
    assert.ok(/maximum|duration/i.test(result.error));
  });
});

// ---------------------------------------------------------------------------
// requireFallbackForEveryBlock
// ---------------------------------------------------------------------------

describe("validateManifestCoverage — requireFallbackForEveryBlock", () => {
  it("accepts when every block has a fallback policy", () => {
    const blocks = [validBlock({ id: "b1" }), validBlock({ id: "b2" })];
    const result = validateManifestCoverage(
      validManifest({ blocks }),
      { requireFallbackForEveryBlock: true },
    );
    assert.strictEqual(result.ok, true);
  });

  it("rejects when fallback is missing blockId", () => {
    const bad = validBlock({ fallback: { reason: "source-down" } });
    const result = validateManifestCoverage(
      validManifest({ blocks: [bad] }),
      { requireFallbackForEveryBlock: true },
    );
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("fallback"));
  });

  it("rejects when fallback is missing reason", () => {
    const bad = validBlock({ fallback: { blockId: "evergreen-1" } });
    const result = validateManifestCoverage(
      validManifest({ blocks: [bad] }),
      { requireFallbackForEveryBlock: true },
    );
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("fallback"));
  });
});

// ---------------------------------------------------------------------------
// requireFreshnessForLiveBlocks
// ---------------------------------------------------------------------------

describe("validateManifestCoverage — requireFreshnessForLiveBlocks", () => {
  it("accepts when every LIVE/HOT_SYNC block carries sourceRef and freshnessTimestamp", () => {
    const blocks = [
      validBlock({ id: "b1" }),
      liveBlock({ id: "b2" }),
      liveBlock({ id: "b3", freshness: "HOT_SYNC", freshnessTimestamp: freshnessIso(1000) }),
    ];
    const result = validateManifestCoverage(
      validManifest({ blocks }),
      { requireFreshnessForLiveBlocks: true },
    );
    assert.strictEqual(result.ok, true);
  });

  it("does not require freshness for FRESH or EVERGREEN blocks", () => {
    const blocks = [
      validBlock({ id: "b1", freshness: "FRESH" }),
      validBlock({ id: "b2", freshness: "EVERGREEN", sourceRef: undefined }),
    ];
    const result = validateManifestCoverage(
      validManifest({ blocks }),
      { requireFreshnessForLiveBlocks: true },
    );
    assert.strictEqual(result.ok, true);
  });
});

// ---------------------------------------------------------------------------
// maxLiveAgeMs
// ---------------------------------------------------------------------------

describe("validateManifestCoverage — maxLiveAgeMs", () => {
  it("accepts when LIVE freshnessTimestamp is within the threshold", () => {
    const blocks = [liveBlock({ freshnessTimestamp: freshnessIso(5_000) })];
    const result = validateManifestCoverage(
      validManifest({ blocks }),
      { maxLiveAgeMs: 60_000, nowMs: FIXED_NOW_MS },
    );
    assert.strictEqual(result.ok, true);
  });

  it("rejects when LIVE freshnessTimestamp is older than the threshold", () => {
    const blocks = [liveBlock({ freshnessTimestamp: freshnessIso(120_000) })];
    const result = validateManifestCoverage(
      validManifest({ blocks }),
      { maxLiveAgeMs: 60_000, nowMs: FIXED_NOW_MS },
    );
    assert.strictEqual(result.ok, false);
    assert.ok(/stale|age|fresh/i.test(result.error));
  });

  it("rejects when HOT_SYNC freshnessTimestamp is older than the threshold", () => {
    const blocks = [
      liveBlock({
        freshness: "HOT_SYNC",
        freshnessTimestamp: freshnessIso(300_000),
      }),
    ];
    const result = validateManifestCoverage(
      validManifest({ blocks }),
      { maxLiveAgeMs: 60_000, nowMs: FIXED_NOW_MS },
    );
    assert.strictEqual(result.ok, false);
    assert.ok(/stale|age|fresh/i.test(result.error));
  });

  it("ignores age threshold for non-live blocks", () => {
    const blocks = [
      validBlock({
        freshness: "FRESH",
        freshnessTimestamp: freshnessIso(10_000_000),
      }),
    ];
    const result = validateManifestCoverage(
      validManifest({ blocks }),
      { maxLiveAgeMs: 60_000, nowMs: FIXED_NOW_MS },
    );
    assert.strictEqual(result.ok, true);
  });

  it("rejects when LIVE block has no freshnessTimestamp at all", () => {
    const block = liveBlock();
    delete block.freshnessTimestamp;
    // Without freshnessTimestamp the underlying validator will reject.
    const result = validateManifestCoverage(
      validManifest({ blocks: [block] }),
      { maxLiveAgeMs: 60_000, nowMs: FIXED_NOW_MS },
    );
    assert.strictEqual(result.ok, false);
  });
});

// ---------------------------------------------------------------------------
// expectedBlockCountMin
// ---------------------------------------------------------------------------

describe("validateManifestCoverage — expectedBlockCountMin", () => {
  it("accepts when block count meets the minimum exactly", () => {
    const blocks = [validBlock({ id: "b1" }), validBlock({ id: "b2" })];
    const result = validateManifestCoverage(
      validManifest({ blocks }),
      { expectedBlockCountMin: 2 },
    );
    assert.strictEqual(result.ok, true);
  });

  it("rejects when block count is below the minimum", () => {
    const blocks = [validBlock({ id: "b1" })];
    const result = validateManifestCoverage(
      validManifest({ blocks }),
      { expectedBlockCountMin: 3 },
    );
    assert.strictEqual(result.ok, false);
    assert.ok(/block|count|minimum/i.test(result.error));
  });
});

// ---------------------------------------------------------------------------
// nowMs default
// ---------------------------------------------------------------------------

describe("validateManifestCoverage — nowMs default", () => {
  it("uses Date.now() when nowMs is not provided", () => {
    const blocks = [
      liveBlock({ freshnessTimestamp: new Date(Date.now() - 5_000).toISOString() }),
    ];
    const result = validateManifestCoverage(
      validManifest({ blocks }),
      { maxLiveAgeMs: 60_000 },
    );
    assert.strictEqual(result.ok, true);
  });
});
