import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EntityResolver } from "../dist/intelligence/entity-resolver.js";
import { EntityStore } from "../dist/cache/entity-store.js";

describe("EntityResolver persistence", () => {
  it("remembers an entity to the store and maps its provider id", async () => {
    const path = join(tmpdir(), `er-${process.pid}.json`);
    const store = new EntityStore(path);
    const r = EntityResolver.getInstance();
    await r.hydrate(store);
    await r.remember({
      id: "nba:team:lakers", entityType: "team", sport: "nba", league: "NBA",
      canonicalName: "Los Angeles Lakers", aliases: ["Lakers"],
      providerIds: { espn: "13" }, metadata: {}, confidence: 1,
      firstSeenAt: new Date().toISOString(), lastVerifiedAt: new Date().toISOString(), mentionCount: 1,
    });
    // Fresh store instance sees the persisted row.
    const store2 = new EntityStore(path);
    await store2.load();
    assert.equal(store2.get("Lakers", "team", "nba")?.providerIds.espn, "13");
  });

  it("hydrates persisted team entities into the in-memory registry", async () => {
    const path = join(tmpdir(), `er-hydrate-${process.pid}.json`);
    const seedStore = new EntityStore(path);
    await seedStore.upsert({
      id: "nba:team:celtics", entityType: "team", sport: "nba", league: "NBA",
      canonicalName: "Boston Celtics", aliases: ["Celtics"],
      providerIds: { espn: "2" }, metadata: {}, confidence: 1,
      firstSeenAt: new Date().toISOString(), lastVerifiedAt: new Date().toISOString(), mentionCount: 1,
    });

    const store = new EntityStore(path);
    const r = EntityResolver.getInstance();
    await r.hydrate(store);

    assert.equal(r.mapToProviderId("nba", "team", "nba:team:celtics", "espn"), "2");
    assert.equal(r.resolveTeam("nba", "Celtics"), "nba:team:celtics");
  });
});
