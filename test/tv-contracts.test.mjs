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
  MATCH_MOMENT_TYPES,

  // Validators
  validatePlaylistBlock,
  validatePlaylistManifest,
  validateLiveContentMeta,
  validateMatchMoment,
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

// ---------------------------------------------------------------------------
// MatchMoment
// ---------------------------------------------------------------------------

/** Minimal valid Cosmos-originated MatchMoment */
function validMatchMoment(overrides = {}) {
  return {
    id: "moment-1",
    fixtureId: "fixture-bra-arg-2026",
    clipUrl: "https://example.com/clips/moment-1.mp4",
    sampledFps: 4,
    momentType: "goal_chance",
    visualRead:
      "Left winger beats the fullback and drives a low cross through the six-yard box.",
    tacticalMeaning: "Brazil is creating repeatable overloads on the left side.",
    broadcastAngle: "Brazil pressure is now structural, not random.",
    confidence: 0.84,
    createdAt: "2026-06-01T00:00:00.000Z",
    source: "cosmos3",
    ...overrides,
  };
}

describe("MATCH_MOMENT_TYPES", () => {
  it("exports the expected moment types", () => {
    assert.deepStrictEqual(
      [...MATCH_MOMENT_TYPES].sort(),
      [
        "goal",
        "goal_chance",
        "foul",
        "card",
        "save",
        "substitution",
        "tactical_shift",
        "crowd_reaction",
        "momentum_swing",
        "controversy",
      ].sort(),
    );
  });
});

describe("validateMatchMoment", () => {
  it("accepts a valid Cosmos-originated moment", () => {
    const result = validateMatchMoment(validMatchMoment());
    assert.strictEqual(result.ok, true, result.ok ? "" : result.error);
  });

  it("accepts a moment with keyframeUrls instead of clipUrl", () => {
    const moment = validMatchMoment({
      keyframeUrls: ["https://example.com/kf/1.jpg"],
    });
    delete moment.clipUrl;
    const result = validateMatchMoment(moment);
    assert.strictEqual(result.ok, true);
  });

  it("accepts a manual moment without clip or keyframes", () => {
    const moment = validMatchMoment({ source: "manual" });
    delete moment.clipUrl;
    const result = validateMatchMoment(moment);
    assert.strictEqual(result.ok, true);
  });

  it("accepts a moment carrying an InferenceTrace", () => {
    const result = validateMatchMoment(
      validMatchMoment({
        trace: {
          taskId: "task-1",
          role: "eyes",
          model: "nvidia/cosmos3-nano-reasoner",
          startedAt: "2026-06-01T00:00:00.000Z",
          endedAt: "2026-06-01T00:00:01.000Z",
          latencyMs: 1000,
          route: "nim",
          status: "completed",
        },
      }),
    );
    assert.strictEqual(result.ok, true);
  });

  it("rejects a non-object", () => {
    assert.strictEqual(validateMatchMoment(null).ok, false);
  });

  it("rejects a missing id", () => {
    const result = validateMatchMoment(validMatchMoment({ id: "" }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("id"));
  });

  it("rejects a missing fixtureId", () => {
    const moment = validMatchMoment();
    delete moment.fixtureId;
    const result = validateMatchMoment(moment);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("fixtureId"));
  });

  it("rejects confidence below 0", () => {
    const result = validateMatchMoment(validMatchMoment({ confidence: -0.1 }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("confidence"));
  });

  it("rejects confidence above 1", () => {
    const result = validateMatchMoment(validMatchMoment({ confidence: 1.5 }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("confidence"));
  });

  it("rejects a non-positive sampledFps", () => {
    const result = validateMatchMoment(validMatchMoment({ sampledFps: 0 }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("sampledFps"));
  });

  it("rejects an unknown momentType", () => {
    const result = validateMatchMoment(validMatchMoment({ momentType: "nutmeg" }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("momentType"));
  });

  it("rejects a cosmos3 moment missing both clipUrl and keyframeUrls", () => {
    const moment = validMatchMoment({ source: "cosmos3" });
    delete moment.clipUrl;
    const result = validateMatchMoment(moment);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("clipUrl") || result.error.includes("keyframeUrls"));
  });

  it("rejects a cosmos3 moment with an empty keyframeUrls array and no clipUrl", () => {
    const moment = validMatchMoment({ source: "cosmos3", keyframeUrls: [] });
    delete moment.clipUrl;
    const result = validateMatchMoment(moment);
    assert.strictEqual(result.ok, false);
  });

  it("rejects an unknown source", () => {
    const result = validateMatchMoment(validMatchMoment({ source: "vhs-tape" }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("source"));
  });

  it("rejects a missing createdAt", () => {
    const result = validateMatchMoment(validMatchMoment({ createdAt: "" }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("createdAt"));
  });
});
