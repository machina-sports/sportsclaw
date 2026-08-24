/**
 * highlights/providers — regression tests for review findings on #146.
 *
 * 1. The classifier must not promote non-goals ("Goal disallowed", "Goal
 *    kick") to type "goal" / importance 100.
 * 2. Per-period clocks must lift correctly in stoppage time, where the
 *    inference heuristic silently misreads them as already-absolute.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyActionType,
  normalizeProviderPayload,
  toElapsedSec,
} from "../dist/highlights/providers.js";

test("disallowed goals are never classified as goals", () => {
  for (const text of [
    "Goal disallowed by VAR - offside in the build-up",
    "VAR Review: Goal disallowed",
    "Goal ruled out for offside",
    "Gol anulado pelo VAR",
    "Goal chalked off",
  ]) {
    assert.notEqual(classifyActionType("", text), "goal", `must not be a goal: ${text}`);
  }
});

test("goal kicks are never classified as goals", () => {
  assert.notEqual(classifyActionType("Goal Kick", "Goal kick"), "goal");
  assert.notEqual(classifyActionType("", "Goal kick taken by the goalkeeper"), "goal");
});

test("real goals still classify as goals", () => {
  assert.equal(classifyActionType("Goal", "Goal! 1-0"), "goal");
  assert.equal(classifyActionType("", "Gol de Silva"), "goal");
});

test("per-period clocks lift correctly through second-half stoppage time", () => {
  // Per-period P2 clock: 45:00 means 90:00 elapsed, not 45:00.
  assert.equal(toElapsedSec(45 * 60, 2, 45, "per-period"), 90 * 60);
  assert.equal(toElapsedSec(47 * 60, 2, 45, "per-period"), 92 * 60);
  assert.equal(toElapsedSec(30 * 60, 2, 45, "per-period"), 75 * 60);
});

test("absolute clocks are never lifted", () => {
  assert.equal(toElapsedSec(46 * 60 + 30, 2, 45, "absolute"), 46 * 60 + 30);
  assert.equal(toElapsedSec(10 * 60, 2, 45, "absolute"), 10 * 60);
});

test("clockMode flows through normalizeProviderPayload", () => {
  const payload = {
    events: [
      { id: "e1", type: "goal", description: "Goal - late winner", match_time: "46:10", period: 2 },
    ],
  };
  const perPeriod = normalizeProviderPayload(payload, { clockMode: "per-period" });
  assert.equal(perPeriod[0].clock.elapsedSec, 91 * 60 + 10);

  const absolute = normalizeProviderPayload(payload, { clockMode: "absolute" });
  assert.equal(absolute[0].clock.elapsedSec, 46 * 60 + 10);
});
