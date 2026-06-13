/**
 * subscribe_team_alerts / unsubscribe_team_alerts — tool logic tested at the
 * store boundary the tool helpers write through.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GameSubscriptionStore } from "../dist/game-subscriptions.js";
import { applyAlertSubscription, removeAlertSubscription } from "../dist/game-alerts.js";

let dir, store;

describe("alert subscription tool helpers", () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sc-alerttools-")); store = new GameSubscriptionStore(dir); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("applyAlertSubscription persists a subscription", async () => {
    const res = await applyAlertSubscription(store, {
      userId: "u1", platform: "telegram", chatId: "555", sport: "mlb", team: "Athletics",
      now: "2026-06-12T00:00:00.000Z",
    });
    assert.match(res, /Athletics/);
    const list = await store.listForUser("u1", "telegram");
    assert.equal(list.length, 1);
    assert.equal(list[0].sport, "mlb");
  });

  it("rejects a missing sport or team", async () => {
    const res = await applyAlertSubscription(store, {
      userId: "u1", platform: "telegram", chatId: "555", sport: "", team: "Athletics",
      now: "2026-06-12T00:00:00.000Z",
    });
    assert.match(res, /Error/i);
    assert.equal((await store.listForUser("u1", "telegram")).length, 0);
  });

  it("rejects when no delivery target (chatId) is available", async () => {
    const res = await applyAlertSubscription(store, {
      userId: "u1", platform: "telegram", chatId: "", sport: "mlb", team: "Athletics",
      now: "2026-06-12T00:00:00.000Z",
    });
    assert.match(res, /Error/i);
  });

  it("removeAlertSubscription deletes it", async () => {
    await applyAlertSubscription(store, {
      userId: "u1", platform: "telegram", chatId: "555", sport: "mlb", team: "Athletics",
      now: "2026-06-12T00:00:00.000Z",
    });
    const res = await removeAlertSubscription(store, {
      userId: "u1", platform: "telegram", sport: "mlb", team: "Athletics",
    });
    assert.match(res, /removed|unsubscribed/i);
    assert.equal((await store.listForUser("u1", "telegram")).length, 0);
  });
});
