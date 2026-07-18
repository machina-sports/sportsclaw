export interface SmokeTestCase {
  sport: string;
  name: string;
  toolName: string;
  args: Record<string, unknown>;
  live?: boolean;
  required?: boolean;
}

// Tool names verified against sports-skills v0.28.0 (`<module>_<command>`).
export const SMOKE_TESTS: SmokeTestCase[] = [
  { sport: "nba", name: "scoreboard", toolName: "nba_get_scoreboard", args: {} },
  { sport: "nba", name: "standings", toolName: "nba_get_standings", args: {} },
  { sport: "nfl", name: "scoreboard", toolName: "nfl_get_scoreboard", args: {} },
  { sport: "mlb", name: "scoreboard", toolName: "mlb_get_scoreboard", args: {} },
  { sport: "football", name: "competitions", toolName: "football_get_competitions", args: {} },
  { sport: "metadata", name: "team search", toolName: "metadata_search_teams", args: { query: "Lakers" } },
  { sport: "kalshi", name: "exchange status", toolName: "kalshi_get_exchange_status", args: {} },
  { sport: "polymarket", name: "sports config", toolName: "polymarket_get_sports_config", args: {} },
];
