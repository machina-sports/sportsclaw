/**
 * game-events — pure scoreboard normalization + semantic event detection.
 * normalizeScoreboard turns a raw `scores` payload into GameState[].
 * detectGameEvents diffs two GameStates for one game into typed events.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { normalizeScoreboard, detectGameEvents } from "../dist/game-events.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(HERE, "fixtures", "scoreboard-mlb.json"), "utf-8"));

const state = (over = {}) => ({
  gameId: "g1", sport: "soccer", home: "Brazil", away: "Argentina",
  homeScore: 0, awayScore: 0, status: "in_progress", leader: "tie", ...over,
});

describe("normalizeScoreboard", () => {
  it("extracts GameState[] from a real scores payload", () => {
    const states = normalizeScoreboard("mlb", FIXTURE);
    assert.ok(states.length >= 2);
    const statuses = states.map((s) => s.status);
    assert.ok(statuses.includes("in_progress"), "live -> in_progress");
    assert.ok(statuses.includes("final"), "closed -> final");
    const g = states[0];
    assert.equal(g.sport, "mlb");
    assert.equal(typeof g.homeScore, "number");
    assert.ok(g.home.length > 0 && g.away.length > 0);
  });

  it("returns [] for malformed input", () => {
    assert.deepEqual(normalizeScoreboard("soccer", null), []);
    assert.deepEqual(normalizeScoreboard("soccer", { nope: true }), []);
    assert.deepEqual(normalizeScoreboard("soccer", [{ garbage: 1 }]), []);
  });
});

describe("detectGameEvents", () => {
  it("first sighting of an in-progress game emits game_start", () => {
    const events = detectGameEvents(undefined, state({ status: "in_progress" }));
    assert.deepEqual(events.map((e) => e.type), ["game_start"]);
  });

  it("first sighting of a scheduled game emits nothing", () => {
    assert.deepEqual(detectGameEvents(undefined, state({ status: "scheduled" })), []);
  });

  it("scheduled -> in_progress emits game_start", () => {
    const prev = state({ status: "scheduled" });
    const curr = state({ status: "in_progress" });
    assert.deepEqual(detectGameEvents(prev, curr).map((e) => e.type), ["game_start"]);
  });

  it("a score increase emits score_change", () => {
    const prev = state({ homeScore: 0, awayScore: 0, leader: "tie" });
    const curr = state({ homeScore: 1, awayScore: 0, leader: "home" });
    const types = detectGameEvents(prev, curr).map((e) => e.type);
    assert.ok(types.includes("score_change"));
  });

  it("going ahead from a tie emits lead_change", () => {
    const prev = state({ homeScore: 1, awayScore: 1, leader: "tie" });
    const curr = state({ homeScore: 2, awayScore: 1, leader: "home" });
    const types = detectGameEvents(prev, curr).map((e) => e.type);
    assert.ok(types.includes("lead_change"));
    assert.ok(types.includes("score_change"));
  });

  it("lead flipping away->home emits lead_change", () => {
    const prev = state({ homeScore: 1, awayScore: 2, leader: "away" });
    const curr = state({ homeScore: 3, awayScore: 2, leader: "home" });
    assert.ok(detectGameEvents(prev, curr).map((e) => e.type).includes("lead_change"));
  });

  it("transition to final emits final", () => {
    const prev = state({ status: "in_progress" });
    const curr = state({ status: "final" });
    assert.ok(detectGameEvents(prev, curr).map((e) => e.type).includes("final"));
  });

  it("no change emits nothing", () => {
    assert.deepEqual(detectGameEvents(state(), state()), []);
  });

  it("sets scoreSignature for dedup", () => {
    const events = detectGameEvents(state({ homeScore: 0 }), state({ homeScore: 1, leader: "home" }));
    assert.equal(events[0].scoreSignature, "1-0");
  });
});
