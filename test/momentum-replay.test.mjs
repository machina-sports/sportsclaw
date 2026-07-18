/**
 * Momentum replay runner — pure-surface tests (no LLM, no network).
 *
 * Covers candle→swing extraction and the synthetic WatchEvent construction
 * that lets a finished game replay through the live pipeline. The bridge and
 * LLM legs are exercised by running momentum-replay against a real finished
 * game, not here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  candlesToSwings,
  swingToWatchEvent,
} from "../dist/intelligence/momentum-replay.js";
import { detectSwings } from "../dist/intelligence/momentum-explainer.js";

const pt = (timestamp, price) => ({ timestamp, price });

describe("candlesToSwings", () => {
  it("keeps consecutive moves at/above the threshold, in cents", () => {
    const points = [
      pt(100, 0.55),
      pt(160, 0.71), // +16c
      pt(220, 0.7), // -1c (dropped)
      pt(280, 0.62), // -8c (dropped at 10c threshold)
      pt(340, 0.72), // +10c
    ];
    const swings = candlesToSwings(points, 10);
    assert.equal(swings.length, 2);
    assert.deepEqual(swings[0], { timestamp: 160, before: 55, after: 71, delta: 16 });
    assert.deepEqual(swings[1], { timestamp: 340, before: 62, after: 72, delta: 10 });
  });

  it("keeps down-swings — a replay has no looping-timeline artifact", () => {
    const swings = candlesToSwings([pt(1, 0.8), pt(2, 0.6)], 10);
    assert.equal(swings.length, 1);
    assert.equal(swings[0].delta, -20);
  });

  it("returns nothing for flat or empty series", () => {
    assert.deepEqual(candlesToSwings([], 10), []);
    assert.deepEqual(candlesToSwings([pt(1, 0.5)], 10), []);
    assert.deepEqual(candlesToSwings([pt(1, 0.5), pt(2, 0.5)], 10), []);
  });
});

describe("swingToWatchEvent", () => {
  const frame = {
    sport: "mlb",
    gameId: "401872178",
    teams: {
      home: { abbrev: "BOS", name: "Boston Red Sox" },
      away: { abbrev: "TB", name: "Tampa Bay Rays" },
    },
    kalshiTicker: "KXMLBGAME-26JUL171335TBBOSG1-BOS",
  };

  it("carries the candle's historical timestamp into the tick snapshot", () => {
    // 2026-07-17T18:03:00Z
    const event = swingToWatchEvent(
      { timestamp: 1784311380, before: 62, after: 72, delta: 10 },
      frame,
    );
    assert.equal(event.timestamp, "2026-07-17T18:03:00Z");
    const data = event.snapshot.data;
    assert.equal(data.timestamp, "2026-07-17T18:03:00Z");
    assert.equal(data.game_id, "401872178");
    assert.equal(data.home_price_cents, 72);
    assert.equal(data.price_source, "kalshi");
  });

  it("emits a change the live-path swing detector fires on", () => {
    const event = swingToWatchEvent(
      { timestamp: 1784311380, before: 62, after: 72, delta: 10 },
      frame,
    );
    const swings = detectSwings(event.changes, 10, "both");
    assert.equal(swings.length, 1);
    assert.equal(swings[0].before, 62);
    assert.equal(swings[0].after, 72);
    assert.equal(swings[0].delta, 10);
  });

  it("labels the game clock as a replay, not a live reading", () => {
    const event = swingToWatchEvent(
      { timestamp: 1784311380, before: 62, after: 72, delta: 10 },
      frame,
    );
    assert.match(event.snapshot.data.game_clock, /^replay @ \d{2}:\d{2}Z$/);
  });

  it("carries any sport string through unchanged — no MLB-specific coupling", () => {
    for (const sport of ["nba", "nhl", "wnba", "cfb", "cbb"]) {
      const event = swingToWatchEvent(
        { timestamp: 1784311380, before: 62, after: 72, delta: 10 },
        { ...frame, sport },
      );
      assert.equal(event.snapshot.data.sport, sport);
    }
  });
});
