import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sanitizeToolInput } from "../dist/tools.js";

// sports-skills season params for US sports take a plain year ("2025" or
// "2025-26"). ESPN, NBA stats, MLB Stats and nflverse all reject the
// "espn.<sport>.<year>" form (HTTP 400/404, "expected an integer"), which the
// sanitizer used to produce. Verified live against sports-skills 7769c21.
describe("sanitizeToolInput — season normalization", () => {
  it("leaves bare years alone for US sports", () => {
    for (const [tool, input] of [
      ["mlb_get_standings", { season: "2026" }],
      ["nfl_get_nflverse_player_stats", { season: 2025, week: 5 }],
      ["nba_get_nbastats_game_log", { season: "2025-26", team: "MIA" }],
      ["nba_get_team_stats", { team_id: "14", season_year: "2025" }],
      ["nfl_get_team_schedule", { season: "2025-2026" }],
    ]) {
      const before = JSON.stringify(input);
      sanitizeToolInput(tool, input);
      assert.equal(JSON.stringify(input), before, tool);
    }
  });

  it("reduces an ESPN-style slug back to the plain year", () => {
    const a = { season: "espn.mlb.2026" };
    sanitizeToolInput("mlb_get_standings", a);
    assert.equal(a.season, "2026");
    const b = { season: "espn.nba.2025-26" };
    sanitizeToolInput("nba_get_nbastats_game_log", b);
    assert.equal(b.season, "2025-26");
  });

  it("does not strip a slug that belongs to another sport", () => {
    const input = { season: "espn.nfl.2025" };
    sanitizeToolInput("mlb_get_standings", input);
    assert.equal(input.season, "espn.nfl.2025");
  });

  it("maps a bare year in football season_id to the Premier League slug, and only season_id", () => {
    const a = { season_id: "2026" };
    sanitizeToolInput("football_get_season_standings", a);
    assert.equal(a.season_id, "premier-league-2026");
    const b = { team_id: "359", season_year: "2024" };
    sanitizeToolInput("football_get_team_schedule", b);
    assert.equal(b.season_year, "2024");
    const c = { season_id: "la-liga-2024" };
    sanitizeToolInput("football_get_season_standings", c);
    assert.equal(c.season_id, "la-liga-2024");
  });

  it("applies to sports_query nested args", () => {
    const input = { sport: "mlb", command: "get_standings", args: { season: "espn.mlb.2026" } };
    sanitizeToolInput("sports_query", input);
    assert.equal(input.args.season, "2026");
    const plain = { sport: "mlb", command: "get_standings", args: { season: "2026" } };
    sanitizeToolInput("sports_query", plain);
    assert.equal(plain.args.season, "2026");
  });

  it("does not affect non-year strings", () => {
    const input = { season: "summer" };
    sanitizeToolInput("mlb_get_standings", input);
    assert.equal(input.season, "summer");
  });
});
