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
});
