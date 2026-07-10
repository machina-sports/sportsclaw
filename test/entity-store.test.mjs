import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

import { EntityStore, entityIsStale } from "../dist/cache/entity-store.js";

function nowISO() { return new Date().toISOString(); }
function daysAgoISO(d) { return new Date(Date.now() - d * 86400000).toISOString(); }

describe("EntityStore", () => {
  it("upserts and gets an entity by alias", async () => {
    const store = new EntityStore(join(tmpdir(), `ec-${process.pid}-${Math.floor(process.hrtime()[1])}.json`));
    await store.load();
    await store.upsert({
      id: "nba:team:lakers", entityType: "team", sport: "nba", league: "NBA",
      canonicalName: "Los Angeles Lakers", aliases: ["Lakers", "LA Lakers"],
      providerIds: { espn: "13" }, metadata: {}, confidence: 1.0,
      firstSeenAt: nowISO(), lastVerifiedAt: nowISO(), mentionCount: 1,
    });
    const found = store.get("Lakers", "team", "nba");
    assert.equal(found?.providerIds.espn, "13");
  });

  it("treats a 2-day-old market entity as stale (1-day TTL)", () => {
    const market = {
      id: "kalshi:KX", entityType: "market", sport: null, league: null,
      canonicalName: "KX", aliases: [], providerIds: {}, metadata: {},
      confidence: 1.0, firstSeenAt: daysAgoISO(2), lastVerifiedAt: daysAgoISO(2), mentionCount: 1,
    };
    assert.equal(entityIsStale(market), true);
  });

  it("preserves firstSeenAt and bumps mentionCount on repeated upsert", async () => {
    const store = new EntityStore(join(tmpdir(), `ec-${process.pid}-${Math.floor(process.hrtime()[1])}-b.json`));
    await store.load();
    const firstSeen = daysAgoISO(5);
    await store.upsert({
      id: "nba:team:celtics", entityType: "team", sport: "nba", league: "NBA",
      canonicalName: "Boston Celtics", aliases: ["Celtics"],
      providerIds: { espn: "2" }, metadata: {}, confidence: 1.0,
      firstSeenAt: firstSeen, lastVerifiedAt: firstSeen, mentionCount: 1,
    });
    await store.upsert({
      id: "nba:team:celtics", entityType: "team", sport: "nba", league: "NBA",
      canonicalName: "Boston Celtics", aliases: ["Celtics"],
      providerIds: { espn: "2", nba: "1610612738" }, metadata: {}, confidence: 1.0,
      firstSeenAt: nowISO(), lastVerifiedAt: nowISO(), mentionCount: 1,
    });
    const found = store.get("Celtics", "team", "nba");
    assert.equal(found?.mentionCount, 2);
    assert.equal(found?.firstSeenAt, firstSeen);
    assert.equal(found?.providerIds.nba, "1610612738");
  });

  it("survives a malformed cache row and still loads/gets a valid entity", async () => {
    const filePath = join(tmpdir(), `ec-${process.pid}-${Math.floor(process.hrtime()[1])}-c.json`);
    const rows = [
      {
        id: "nba:team:x", entityType: "team", sport: "nba", league: "NBA",
        canonicalName: "X", aliases: undefined, providerIds: {}, metadata: {},
        confidence: 1.0, firstSeenAt: nowISO(), lastVerifiedAt: nowISO(), mentionCount: 1,
      },
      "totally bogus row",
    ];
    await writeFile(filePath, JSON.stringify(rows), "utf8");
    const store = new EntityStore(filePath);
    await store.load();
    const found = store.get("X", "team", "nba");
    assert.equal(found?.canonicalName, "X");
  });

  it("treats a 2-day-old team entity as fresh (180-day TTL)", () => {
    const team = {
      id: "nba:team:lakers", entityType: "team", sport: "nba", league: "NBA",
      canonicalName: "Los Angeles Lakers", aliases: [], providerIds: {}, metadata: {},
      confidence: 1.0, firstSeenAt: daysAgoISO(2), lastVerifiedAt: daysAgoISO(2), mentionCount: 1,
    };
    assert.equal(entityIsStale(team), false);
  });
});
