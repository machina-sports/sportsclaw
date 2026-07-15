/**
 * Momentum & Price Explainer — detector + evaluator gate tests.
 *
 * These cover the DETERMINISTIC surface of the loop (no LLM): the swing
 * detector (Phase 3) and the evaluator's hard gates + structural reject path
 * (Phase 5). The semantic LLM skeptic is exercised live by momentum-demo, not
 * here — these tests pin the rule-solvable checks that must never regress.
 *
 * node:test + assert, importing from dist/ per the project's convention.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { detectSwings } from "../dist/intelligence/momentum-explainer.js";
import {
  runHardGates,
  evaluateCard,
} from "../dist/intelligence/momentum-evaluator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const priceChange = (before, after) => ({
  path: "data.polymarket_home_price_cents",
  type: "modified",
  before,
  after,
});

const play = (over = {}) => ({
  id: over.id ?? "p1",
  sequence: "1",
  wallclock: "2026-07-01T18:07:00Z",
  text: over.text ?? "Trevor Lawrence pass complete deep right for 45 yards, TOUCHDOWN!",
  type: over.type ?? "Passing Touchdown",
  period: "2",
  gameClock: "11:30",
  homeScore: over.homeScore ?? 7,
  awayScore: over.awayScore ?? 3,
  scoring: over.scoring ?? true,
  teamId: "jax",
});

const card = (over = {}) => ({
  text: over.text ?? "Lawrence's 45-yard TD to Thomas flipped the home price up 26 points.",
  swing: over.swing ?? { path: "data.polymarket_home_price_cents", before: 42, after: 68, delta: 26 },
  causePlay: over.causePlay === undefined ? play() : over.causePlay,
  source: "mock-snapshot",
  gameLabel: "HOU @ JAX",
  gameClock: "11:30",
  timestamp: "2026-07-01T18:08:00Z",
  verdict: null,
});

const dummyEvaluator = { model: null, modelId: "test-checker", provider: "anthropic" };

// ---------------------------------------------------------------------------
// detectSwings
// ---------------------------------------------------------------------------

describe("detectSwings", () => {
  it("fires on an up-swing at/above threshold", () => {
    const swings = detectSwings([priceChange(42, 68)], 10, "up");
    assert.equal(swings.length, 1);
    assert.equal(swings[0].delta, 26);
  });

  it("ignores sub-threshold moves", () => {
    assert.equal(detectSwings([priceChange(42, 48)], 10, "up").length, 0);
  });

  it("filters down-swings in up-only mode but keeps them in both mode", () => {
    assert.equal(detectSwings([priceChange(68, 42)], 10, "up").length, 0);
    assert.equal(detectSwings([priceChange(68, 42)], 10, "both").length, 1);
  });

  it("ignores non-price paths and non-finite values", () => {
    assert.equal(detectSwings([{ path: "data.game_clock", before: "1", after: "2" }], 10, "up").length, 0);
    assert.equal(detectSwings([priceChange("x", 68)], 10, "up").length, 0);
  });

  it("fires on any path ending in home_price_cents (mock + live feeds)", () => {
    // The source-neutral suffix matches both the mock's polymarket-prefixed
    // key and the live Kalshi feed's bare home_price_cents.
    for (const path of ["data.polymarket_home_price_cents", "data.home_price_cents"]) {
      const swings = detectSwings([{ path, type: "modified", before: 42, after: 68 }], 10, "up");
      assert.equal(swings.length, 1, `expected a swing for ${path}`);
      assert.equal(swings[0].delta, 26);
      assert.equal(swings[0].path, path);
    }
  });
});

// ---------------------------------------------------------------------------
// runHardGates — deterministic, rule-solvable checks
// ---------------------------------------------------------------------------

describe("runHardGates", () => {
  it("passes when the cited play is present in the window", () => {
    const gates = runHardGates(card(), [play()]);
    assert.equal(gates.hasCause, true);
    assert.equal(gates.playInWindow, true);
    assert.equal(gates.reasons.length, 0);
  });

  it("fails when the cited play is absent from the window", () => {
    const gates = runHardGates(card(), [play({ id: "other", text: "Punt for 40 yards." })]);
    assert.equal(gates.playInWindow, false);
    assert.ok(gates.reasons.some((r) => /not present/i.test(r)));
  });

  it("fails when the card cites no cause play", () => {
    const gates = runHardGates(card({ causePlay: null }), [play()]);
    assert.equal(gates.hasCause, false);
    assert.ok(gates.reasons.some((r) => /no cause/i.test(r)));
  });
});

// ---------------------------------------------------------------------------
// evaluateCard — structural reject short-circuits WITHOUT an LLM call
// ---------------------------------------------------------------------------

describe("evaluateCard (structural reject path)", () => {
  it("rejects a card whose cause play is absent, without touching the model", async () => {
    const verdict = await evaluateCard(
      dummyEvaluator,
      card(),
      [play({ id: "other", text: "Kneel down." })],
      { path: "p", before: 42, after: 68, delta: 26 },
      1,
    );
    assert.equal(verdict.verdict, "reject");
    assert.equal(verdict.checks.playInWindow, false);
    assert.equal(verdict.checks.claimSupported, false);
    assert.equal(verdict.evaluatorModel, "test-checker");
    assert.equal(verdict.attempts, 1);
  });

  it("rejects a card with no cause play, without touching the model", async () => {
    const verdict = await evaluateCard(
      dummyEvaluator,
      card({ causePlay: null }),
      [play()],
      { path: "p", before: 42, after: 68, delta: 26 },
      2,
    );
    assert.equal(verdict.verdict, "reject");
    assert.equal(verdict.checks.hasCause, false);
    assert.equal(verdict.attempts, 2);
  });
});
