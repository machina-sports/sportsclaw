import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { executeToolSafely } from "../dist/tools/executor.js";

describe("executeToolSafely", () => {
  it("returns ok with data on success and reports normalized args", async () => {
    const res = await executeToolSafely(
      "nba_get_standings",
      { season: "2026" }, // bare year → sanitizeToolInput normalizes to espn.nba.2026
      async (_n, a) => ({ content: JSON.stringify({ season: a.season }) }),
    );
    assert.equal(res.ok, true);
    assert.equal(res.normalized, true);
    assert.ok(String(res.data).includes("espn.nba.2026"));
  });

  it("classifies a failing run into a structured failure", async () => {
    const res = await executeToolSafely(
      "kalshi_get_exchange_status",
      {},
      async () => ({ content: "429 too many requests", isError: true }),
    );
    assert.equal(res.ok, false);
    assert.equal(res.failure?.category, "rate_limited");
    assert.equal(res.failure?.retryable, true);
  });

  it("does not mutate caller's original args (deep copy isolation)", async () => {
    const original = { sport: "nba", args: { season: "2026" } };
    const res = await executeToolSafely(
      "sports_query",
      original,
      async (_n, a) => ({ content: JSON.stringify(a) }),
    );
    // Verify the caller's original is NOT mutated
    assert.equal(original.args.season, "2026");
    // Verify the copy WAS normalized
    assert.equal(res.normalized, true);
    assert.ok(String(res.data).includes("espn.nba.2026"));
  });

  it("catches thrown exceptions and classifies them", async () => {
    const res = await executeToolSafely(
      "weather_get_forecast",
      { location: "NYC" },
      async () => { throw new Error("boom network fail"); },
    );
    assert.equal(res.ok, false);
    assert.ok(res.failure);
    assert.equal(typeof res.failure.category, "string");
  });
});
