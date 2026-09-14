/**
 * sportsclaw — Built-in skill guides.
 *
 * Sport-specific behaviors that used to live in the global system prompt as
 * sub-numbered rules (12.5 Kalshi mascots, 12.6/12.7 brackets, 14/15 player
 * lookups). These now ship as in-code SkillGuide entries, surfaced only when
 * the relevant skill is in scope (saves tokens, isolates concerns).
 *
 * Resolution order (handled by the prompt composer):
 *   1. On-disk guides from SPORTSCLAW_SKILL_GUIDES_DIR (loadSkillGuides).
 *   2. These built-in guides, filtered by selected/installed skills.
 *   On-disk guides win on id collision.
 */

import type { SkillGuide } from "../types.js";

/** A built-in guide tagged with the skill names that should activate it. */
export interface BuiltInSkillGuide extends SkillGuide {
  /** Skill names that, when present in selectedSkills or installed, surface this guide. */
  triggerSkills: string[];
}

const KALSHI_MASCOTS: BuiltInSkillGuide = {
  id: "kalshi-mascots",
  name: "Kalshi market lookups",
  description: "How to query Kalshi sports markets by team mascot",
  triggerSkills: ["kalshi", "markets"],
  body:
    "When searching Kalshi markets via `search_markets`, you CAN use team " +
    "mascots (Lakers, Pelicans, Eagles) as the query as long as you also " +
    "provide the correct sport code. The tool auto-translates mascots to " +
    "city names internally.",
};

const BRACKET_BUILDING: BuiltInSkillGuide = {
  id: "bracket-building",
  name: "March Madness bracket building",
  description: "Step-by-step guide for filling out a 64-team bracket",
  triggerSkills: ["cbb"],
  body: [
    "When the user wants to fill out a March Madness bracket:",
    "",
    "1. Fetch the tournament field with `cbb_get_rankings` or `cbb_get_futures`.",
    "2. Call `bracket_create` with the 64-team field (4 regions × 16 seeds).",
    "3. Present picks REGION BY REGION: complete all 4 rounds (R64 → E8) of one region before moving to the next.",
    "4. Use `ask_user_question` for each matchup. Always include seed numbers in the option labels.",
    "5. After completing each region, show `bracket_view` for that region.",
    "6. The user can resume later — bracket state persists across sessions.",
    "7. When the user says \"show my bracket\" or \"resume bracket\", call `bracket_status` first.",
  ].join("\n"),
};

const BRACKET_SIMULATION: BuiltInSkillGuide = {
  id: "bracket-simulation",
  name: "March Madness bracket simulation",
  description: "Use Monte Carlo sim to recommend bracket picks",
  triggerSkills: ["cbb"],
  body: [
    "When the user wants AI help picking their bracket:",
    "",
    "1. Run `bracket_simulate` for Monte Carlo analysis (uses BPI + ESPN projections + sportsbook odds).",
    "2. Present the top 10 championship contenders with percentages.",
    "3. For each matchup, show the sim recommendation and confidence level.",
    "4. Offer the strategies: `most_likely`, `best_upset`, or `kalshi_optimal`.",
    "5. The user can auto-fill from a strategy or pick manually with sim guidance.",
  ].join("\n"),
};

const FOOTBALL_PLAYER_LOOKUPS: BuiltInSkillGuide = {
  id: "football-player-lookups",
  name: "Football (soccer) player lookups",
  description: "Resolve a soccer player to Transfermarkt + ESPN IDs",
  triggerSkills: ["football"],
  body: [
    "For football (soccer) player queries:",
    "",
    "1. ALWAYS call `football_search_player` first with the player's name. It returns both `tm_player_id` (Transfermarkt) and `espn_athlete_id` (ESPN) in one call.",
    "2. Use both IDs to call `football_get_player_profile` with `tm_player_id` AND `player_id` (ESPN). You get the richest profile this way: market value and transfer history from Transfermarkt, season stats from ESPN.",
    "3. For transfer data, pass `tm_player_id` to `football_get_season_transfers`.",
    "4. Save discovered IDs to the Fan Profile so future lookups skip the search step.",
  ].join("\n"),
};

const PLAYER_LOOKUP_GENERAL: BuiltInSkillGuide = {
  id: "player-lookup-general",
  name: "Player ID resolution",
  description: "General pattern for resolving an unknown player ID",
  triggerSkills: ["nba", "nfl", "nhl", "mlb", "wnba", "cfb", "cbb", "tennis", "golf"],
  body: [
    "When asked about a specific player:",
    "",
    "1. If you already have the player's ID (from memory or a prior call), use it directly.",
    "2. If you don't have the ID, use a discovery tool first. Rankings, leaderboards, and roster tools typically return player IDs alongside names. Call the listing tool (e.g. `get_rankings`, `get_team_roster`, `get_leaderboard`), find the player by name, extract their ID, then call the player detail tool.",
    "3. These lookups are SEQUENTIAL — don't parallelize steps that depend on IDs from prior calls.",
    "4. If no discovery path exists for a sport, say so. Don't guess IDs.",
  ].join("\n"),
};

const MACHINA_STACK: BuiltInSkillGuide = {
  id: "machina-stack",
  name: "Machina sports-game stack",
  description: "Build and operate a project-scoped sports game without widening access",
  triggerSkills: ["machina"],
  body: [
    "For a Machina-backed sports game:",
    "",
    "- Local SportsClaw agents reason and coordinate; pod agents are separate persistent resources. Never imply that a local agent was installed or scheduled in the pod.",
    "- Require live tool schema discovery before a pod call. Use the exact discovered input schema instead of remembered argument shapes.",
    "- Prefer deterministic sync workflows for data preparation and repeatable game state. Use an agent only where reasoning is actually required.",
    "- Keep one scheduler owner in Machina. Do not create a second SportsClaw watcher, cron, queue, or background daemon for the same sync.",
    "- Treat selected capabilities as an allowlist. Existing project resources are availability, not permission to use or expand them.",
    "- Keep pod access server-side, preserve provenance and freshness, and distinguish frozen samples from verified live data.",
  ].join("\n"),
};

const SELF_UPGRADE: BuiltInSkillGuide = {
  id: "self-upgrade",
  name: "Sports skills self-upgrade",
  description: "How to upgrade the sports-skills package on user request",
  triggerSkills: [], // Always available — surfaced when the user asks
  body: [
    "When the user asks to update, upgrade, or check for new versions of sports-skills:",
    "",
    "- Call `upgrade_sports_skills`. It runs pip upgrade internally and hot-reloads all schemas.",
    "- Do NOT tell the user to run pip manually. You have the tool — use it.",
    "- After upgrading, confirm the new version and the number of refreshed schemas.",
  ].join("\n"),
};

const SELF_IMPROVEMENT: BuiltInSkillGuide = {
  id: "self-improvement",
  name: "Reflection and strategy evolution",
  description: "When to use the optional self-improvement tools",
  triggerSkills: [],
  body: [
    "You have two optional self-improvement tools:",
    "",
    "- `reflect`: log a one-sentence lesson when something genuinely surprising happens (a tool failure, a data gap, a workaround you discovered). Rare events.",
    "- `evolve_strategy`: codify a behavioral pattern into your system instructions (a data quality rule, a user preference). Only when a pattern is clear and repeated.",
    "",
    "These are available, not mandatory. Most turns need neither.",
  ].join("\n"),
};

const ALL_BUILT_IN: ReadonlyArray<BuiltInSkillGuide> = [
  KALSHI_MASCOTS,
  BRACKET_BUILDING,
  BRACKET_SIMULATION,
  FOOTBALL_PLAYER_LOOKUPS,
  PLAYER_LOOKUP_GENERAL,
  MACHINA_STACK,
  SELF_UPGRADE,
  SELF_IMPROVEMENT,
];

/**
 * Return built-in skill guides whose triggers overlap the active skill set.
 * Guides with an empty `triggerSkills` array are always surfaced.
 */
export function getBuiltInSkillGuides(activeSkills: ReadonlySet<string>): SkillGuide[] {
  const out: SkillGuide[] = [];
  for (const guide of ALL_BUILT_IN) {
    if (guide.triggerSkills.length === 0) {
      out.push({ id: guide.id, name: guide.name, description: guide.description, body: guide.body });
      continue;
    }
    if (guide.triggerSkills.some((skill) => activeSkills.has(skill))) {
      out.push({ id: guide.id, name: guide.name, description: guide.description, body: guide.body });
    }
  }
  return out;
}
