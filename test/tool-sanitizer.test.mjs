import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeToolInput } from "../dist/tools.js";

describe("sanitizeToolInput — bare year sanitization", () => {
  it("sanitizes bare year for MLB standings", () => {
    const input = { season: "2026" };
    sanitizeToolInput("mlb_get_standings", input);
    assert.equal(input.season, "espn.mlb.2026");
  });

  it("sanitizes bare year with hyphen for NFL team schedule", () => {
    const input = { season: "2025-2026" };
    sanitizeToolInput("nfl_get_team_schedule", input);
    assert.equal(input.season, "espn.nfl.2025-2026");
  });

  it("sanitizes bare year for football/soccer standings", () => {
    const input = { season_id: "2026" };
    sanitizeToolInput("football_get_season_standings", input);
    assert.equal(input.season_id, "premier-league-2026");
  });

  it("sanitizes bare year in sports_query nested args for MLB", () => {
    const input = {
      sport: "mlb",
      command: "get_standings",
      args: { season: "2026" }
    };
    sanitizeToolInput("sports_query", input);
    assert.equal(input.args.season, "espn.mlb.2026");
  });

  it("does not affect already fully qualified slugs", () => {
    const input = { season: "espn.mlb.2026" };
    sanitizeToolInput("mlb_get_standings", input);
    assert.equal(input.season, "espn.mlb.2026");
  });

  it("does not affect human names or non-year strings", () => {
    const input = { season: "summer" };
    sanitizeToolInput("mlb_get_standings", input);
    assert.equal(input.season, "summer");
  });
});
