/**
 * GameAlertService — given a GameEvent, resolve subscribers, dedup, and route
 * routine events to templated delivery / headline events to the engine, with a
 * budget-exhausted fallback to templated. Driven with fakes (no real I/O).
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GameSubscriptionStore } from "../dist/game-subscriptions.js";
import { GameAlertService } from "../dist/game-alerts.js";

const evt = (over = {}) => ({
  type: "score_change", gameId: "g1", sport: "soccer",
  state: { gameId: "g1", sport: "soccer", home: "Brazil", away: "Argentina",
           homeScore: 1, awayScore: 0, status: "in_progress", leader: "home" },
  scoreSignature: "1-0", timestamp: "2026-06-12T00:00:00.000Z", ...over,
});

let dir, store, sent, engineCalls;

function makeService(opts = {}) {
  sent = []; engineCalls = 0;
  return new GameAlertService({
    store,
    deliver: async (target, text) => { sent.push({ target, text }); return true; },
    runEngine: async () => { engineCalls++; return "ENGINE: late drama in São Paulo"; },
    ...opts,
  });
}

describe("GameAlertService", () => {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "sc-alertsvc-"));
    store = new GameSubscriptionStore(dir);
    await store.add({ userId: "u1", platform: "telegram", chatId: "555",
      sport: "soccer", team: "Brazil", createdAt: "2026-06-12T00:00:00.000Z" });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("delivers a routine event to subscribers via template (no engine call)", async () => {
    const svc = makeService();
    await svc.handleEvent(evt());
    assert.equal(sent.length, 1);
    assert.equal(sent[0].target.chatId, "555");
    assert.match(sent[0].text, /Brazil/);
    assert.equal(engineCalls, 0, "routine events do not call the engine");
  });

  it("does not deliver to non-subscribers", async () => {
    const svc = makeService();
    await svc.handleEvent(evt({ state: { gameId: "g9", sport: "soccer", home: "France", away: "Spain",
      homeScore: 1, awayScore: 0, status: "in_progress", leader: "home" }, gameId: "g9" }));
    assert.equal(sent.length, 0);
  });

  it("dedups identical events", async () => {
    const svc = makeService();
    await svc.handleEvent(evt());
    await svc.handleEvent(evt());
    assert.equal(sent.length, 1, "second identical event suppressed");
  });

  it("routes headline events (final) through the engine", async () => {
    const svc = makeService();
    await svc.handleEvent(evt({ type: "final", scoreSignature: "2-1" }));
    assert.equal(engineCalls, 1);
    assert.match(sent[0].text, /ENGINE:/);
  });

  it("falls back to template when the engine throws (budget exhausted)", async () => {
    const svc = makeService({
      runEngine: async () => { throw new Error("Daily token budget exhausted"); },
    });
    await svc.handleEvent(evt({ type: "final", scoreSignature: "2-1" }));
    assert.equal(sent.length, 1, "still delivered");
    assert.doesNotMatch(sent[0].text, /ENGINE:/);
    assert.match(sent[0].text, /Brazil/);
  });

  it("isolates delivery failures (one bad target does not stop others)", async () => {
    await store.add({ userId: "u2", platform: "telegram", chatId: "777",
      sport: "soccer", team: "Brazil", createdAt: "2026-06-12T00:00:00.000Z" });
    let calls = 0;
    const svc = makeService({
      deliver: async (target, text) => {
        calls++;
        if (target.chatId === "555") throw new Error("telegram 400");
        sent.push({ target, text });
        return true;
      },
    });
    await svc.handleEvent(evt());
    assert.equal(calls, 2, "attempted both");
    assert.equal(sent.length, 1, "the healthy target still received it");
  });
});
