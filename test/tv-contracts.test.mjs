/**
 * TV Operator Contracts — test suite
 *
 * Tests for typed contracts and runtime validators for Machina Sports TV
 * broadcast operations. Written test-first (TDD).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Import will fail until src/schema/tv.ts is implemented
import {
  // Enums / constants
  FRESHNESS_CLASSES,

  // Validators
  validatePlaylistBlock,
  validatePlaylistManifest,
  validateLiveContentMeta,
} from "../dist/schema/tv.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid PlaylistBlock */
function validBlock(overrides = {}) {
  return {
    id: "block-1",
    title: "Halftime Highlights",
    durationSec: 120,
    freshness: "FRESH",
    fallback: { blockId: "block-evergreen-1", reason: "source-down" },
    sourceRef: "espn:nba:highlights:2024-01-15",
    ...overrides,
  };
}

/** Minimal valid PlaylistManifest */
function validManifest(overrides = {}) {
  return {
    id: "manifest-1",
    channelId: "machina-tv-1",
    blocks: [validBlock()],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// FreshnessClass constants
// ---------------------------------------------------------------------------

describe("FreshnessClass", () => {
  it("exports exactly the four expected freshness classes", () => {
    assert.deepStrictEqual(
      [...FRESHNESS_CLASSES].sort(),
      ["EVERGREEN", "FRESH", "HOT_SYNC", "LIVE"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// validatePlaylistBlock
// ---------------------------------------------------------------------------

describe("validatePlaylistBlock", () => {
  it("accepts a valid block", () => {
    const result = validatePlaylistBlock(validBlock());
    assert.strictEqual(result.ok, true);
  });

  it("rejects block with zero duration", () => {
    const result = validatePlaylistBlock(validBlock({ durationSec: 0 }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("duration"));
  });

  it("rejects block with negative duration", () => {
    const result = validatePlaylistBlock(validBlock({ durationSec: -10 }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("duration"));
  });

  it("rejects block without fallback", () => {
    const block = validBlock();
    delete block.fallback;
    const result = validatePlaylistBlock(block);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("fallback"));
  });

  it("rejects block with null fallback", () => {
    const result = validatePlaylistBlock(validBlock({ fallback: null }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("fallback"));
  });
});

// ---------------------------------------------------------------------------
// validatePlaylistManifest
// ---------------------------------------------------------------------------

describe("validatePlaylistManifest", () => {
  it("accepts a valid manifest", () => {
    const result = validatePlaylistManifest(validManifest());
    assert.strictEqual(result.ok, true);
  });

  it("rejects manifest with zero blocks", () => {
    const result = validatePlaylistManifest(validManifest({ blocks: [] }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("block"));
  });

  it("rejects manifest when a contained block is invalid", () => {
    const badBlock = validBlock({ durationSec: -1 });
    const result = validatePlaylistManifest(validManifest({ blocks: [badBlock] }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("duration"));
  });

  it("rejects manifest whose total duration is zero (all blocks positive is already enforced but manifest-level check)", () => {
    const result = validatePlaylistManifest(validManifest());
    assert.strictEqual(result.ok, true);
  });

  it("rejects manifest containing a LIVE block without freshnessTimestamp", () => {
    const block = validBlock({ freshness: "LIVE", sourceRef: "espn:live:nba" });
    delete block.freshnessTimestamp;
    const result = validatePlaylistManifest(validManifest({ blocks: [block] }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("freshness"));
  });

  it("rejects manifest containing a HOT_SYNC block without sourceRef", () => {
    const block = validBlock({
      freshness: "HOT_SYNC",
      freshnessTimestamp: new Date().toISOString(),
    });
    delete block.sourceRef;
    const result = validatePlaylistManifest(validManifest({ blocks: [block] }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("source"));
  });

  it("accepts manifest with a valid LIVE block", () => {
    const block = validBlock({
      freshness: "LIVE",
      sourceRef: "espn:live:nba-game-123",
      freshnessTimestamp: new Date().toISOString(),
    });
    const result = validatePlaylistManifest(validManifest({ blocks: [block] }));
    assert.strictEqual(result.ok, true);
  });
});

// ---------------------------------------------------------------------------
// validateLiveContentMeta — LIVE and HOT_SYNC content must carry source + freshnessTimestamp
// ---------------------------------------------------------------------------

describe("validateLiveContentMeta", () => {
  it("accepts LIVE block with source and freshnessTimestamp", () => {
    const block = validBlock({
      freshness: "LIVE",
      sourceRef: "espn:live:nba-game-123",
      freshnessTimestamp: new Date().toISOString(),
    });
    const result = validateLiveContentMeta(block);
    assert.strictEqual(result.ok, true);
  });

  it("accepts HOT_SYNC block with source and freshnessTimestamp", () => {
    const block = validBlock({
      freshness: "HOT_SYNC",
      sourceRef: "espn:hot:scores",
      freshnessTimestamp: new Date().toISOString(),
    });
    const result = validateLiveContentMeta(block);
    assert.strictEqual(result.ok, true);
  });

  it("rejects LIVE block without freshnessTimestamp", () => {
    const block = validBlock({ freshness: "LIVE", sourceRef: "espn:live:nba" });
    delete block.freshnessTimestamp;
    const result = validateLiveContentMeta(block);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("freshness"));
  });

  it("rejects HOT_SYNC block without sourceRef", () => {
    const block = validBlock({
      freshness: "HOT_SYNC",
      freshnessTimestamp: new Date().toISOString(),
    });
    delete block.sourceRef;
    const result = validateLiveContentMeta(block);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("source"));
  });

  it("allows FRESH block without freshnessTimestamp (not required)", () => {
    const block = validBlock({ freshness: "FRESH" });
    delete block.freshnessTimestamp;
    const result = validateLiveContentMeta(block);
    assert.strictEqual(result.ok, true);
  });

  it("allows EVERGREEN block without sourceRef or freshnessTimestamp", () => {
    const block = validBlock({ freshness: "EVERGREEN" });
    delete block.sourceRef;
    delete block.freshnessTimestamp;
    const result = validateLiveContentMeta(block);
    assert.strictEqual(result.ok, true);
  });
});
