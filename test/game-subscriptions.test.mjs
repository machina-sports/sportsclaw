/**
 * GameSubscriptionStore — disk-backed team alert subscriptions.
 * Round-trips across instances (restart-safe), resolves subscribers by team,
 * lists distinct active sports, atomic writes, sanitized filenames.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GameSubscriptionStore } from "../dist/game-subscriptions.js";

const sub = (over = {}) => ({
  userId: "u1", platform: "telegram", chatId: "555",
  sport: "soccer", team: "Brazil", createdAt: "2026-06-12T00:00:00.000Z", ...over,
});

let dir;

describe("GameSubscriptionStore", () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sc-subs-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("round-trips a subscription across instances", async () => {
    const a = new GameSubscriptionStore(dir);
    await a.add(sub());
    const b = new GameSubscriptionStore(dir);
    const list = await b.listForUser("u1", "telegram");
    assert.equal(list.length, 1);
    assert.equal(list[0].team, "Brazil");
  });

  it("findSubscribers matches by sport+team (case-insensitive)", async () => {
    const store = new GameSubscriptionStore(dir);
    await store.add(sub({ userId: "u1", chatId: "1" }));
    await store.add(sub({ userId: "u2", chatId: "2", team: "brazil" }));
    await store.add(sub({ userId: "u3", chatId: "3", team: "France" }));
    const subs = await store.findSubscribers("soccer", "BRAZIL");
    assert.deepEqual(subs.map((s) => s.userId).sort(), ["u1", "u2"]);
  });

  it("activeSports lists distinct sports", async () => {
    const store = new GameSubscriptionStore(dir);
    await store.add(sub({ sport: "soccer" }));
    await store.add(sub({ userId: "u2", chatId: "2", sport: "nba", team: "Lakers" }));
    await store.add(sub({ userId: "u3", chatId: "3", sport: "soccer", team: "France" }));
    assert.deepEqual((await store.activeSports()).sort(), ["nba", "soccer"]);
  });

  it("remove deletes a single subscription", async () => {
    const store = new GameSubscriptionStore(dir);
    await store.add(sub({ team: "Brazil" }));
    await store.add(sub({ team: "France" }));
    assert.equal(await store.remove("u1", "telegram", "soccer", "Brazil"), true);
    const list = await store.listForUser("u1", "telegram");
    assert.deepEqual(list.map((s) => s.team), ["France"]);
  });

  it("add is idempotent on (user, platform, sport, team)", async () => {
    const store = new GameSubscriptionStore(dir);
    await store.add(sub());
    await store.add(sub({ chatId: "999" }));
    const list = await store.listForUser("u1", "telegram");
    assert.equal(list.length, 1);
    assert.equal(list[0].chatId, "999", "re-add updates chatId");
  });

  it("leaves no temp files behind", async () => {
    const store = new GameSubscriptionStore(dir);
    await store.add(sub());
    for (const f of readdirSync(dir)) assert.ok(!f.endsWith(".tmp"), `temp leaked: ${f}`);
  });

  it("sanitizes hostile userIds into safe filenames", async () => {
    const store = new GameSubscriptionStore(dir);
    await store.add(sub({ userId: "../../etc/passwd" }));
    for (const f of readdirSync(dir)) {
      assert.ok(!f.includes("..") && !f.includes("/"), `unsafe: ${f}`);
    }
  });
});
