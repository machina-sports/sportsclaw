/**
 * sportsclaw — March Madness Monte Carlo Bracket Simulation
 *
 * Fetches BPI ratings, ESPN tournament projections, and sportsbook futures
 * via the Python bridge, then runs a configurable number of Monte Carlo
 * iterations entirely in-memory using a ported logistic win-probability
 * formula. Produces per-matchup recommendations and bracket strategies.
 */

import { executePythonBridge } from "./tools.js";
import type { BracketRegionName, BracketSession, BracketMatchup } from "./bracket.js";
import type { sportsclawConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SimTeam {
  seed: number;
  name: string;
  teamId: string;
  region: BracketRegionName;
  bpi: number;
  tournamentAdvPct?: Record<string, number>;
  futuresImpliedProb?: number;
}

export interface SimConfig {
  iterations: number;
  seed?: number;
  weights: { bpi: number; espnAdv: number; futures: number };
}

export interface SimMatchupResult {
  matchId: string;
  topTeam: string;
  bottomTeam: string;
  topWinPct: number;
  bottomWinPct: number;
  recommendedPick: "top" | "bottom";
  confidence: "lock" | "strong" | "lean" | "tossup";
}

export interface SimTeamAdvancement {
  name: string;
  seed: number;
  region: BracketRegionName;
  advancementPct: Record<string, number>;
  championPct: number;
}

export type SimBracketStrategy = "most_likely" | "best_upset" | "kalshi_optimal";

export interface SimulationResult {
  config: SimConfig;
  matchups: SimMatchupResult[];
  teamAdvancements: SimTeamAdvancement[];
  topContenders: SimTeamAdvancement[];
  strategies: Record<
    SimBracketStrategy,
    { picks: Array<{ matchId: string; pick: "top" | "bottom"; confidence: string }> }
  >;
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_SIM_CONFIG: SimConfig = {
  iterations: 10_000,
  weights: { bpi: 0.6, espnAdv: 0.25, futures: 0.15 },
};

// ---------------------------------------------------------------------------
// Core math
// ---------------------------------------------------------------------------

/**
 * Logistic win probability — ported from sports-skills `matchup_probability`.
 * P(A wins) = 1 / (1 + 10^(-(bpiA - bpiB) / 10))
 */
export function bpiWinProb(bpiA: number, bpiB: number): number {
  return 1 / (1 + Math.pow(10, -(bpiA - bpiB) / 10));
}

/**
 * Mulberry32 PRNG for deterministic simulations.
 * Returns a function that produces numbers in [0, 1).
 */
function createRng(seed?: number): () => number {
  let s = seed ?? (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Seed-based BPI fallback
// ---------------------------------------------------------------------------

/**
 * When real BPI data is unavailable, estimate BPI from tournament seed.
 * Seed 1 ≈ 95, seed 16 ≈ 65, linearly interpolated.
 */
function seedToBpi(seed: number): number {
  return 95 - ((seed - 1) / 15) * 30;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

interface PowerIndexEntry {
  team_name?: string;
  team_id?: string;
  bpi?: number;
  [key: string]: unknown;
}

interface ProjectionEntry {
  team_name?: string;
  team_id?: string;
  r32?: number;
  s16?: number;
  e8?: number;
  f4?: number;
  championship?: number;
  [key: string]: unknown;
}

interface FuturesEntry {
  team_name?: string;
  team_id?: string;
  odds?: number;
  implied_probability?: number;
  [key: string]: unknown;
}

/**
 * Fetch tournament field data from sports-skills Python bridge.
 * Makes up to 3 parallel calls: BPI, projections, futures.
 * Gracefully degrades when some sources are unavailable.
 */
export async function fetchTournamentField(
  config?: Partial<sportsclawConfig>,
): Promise<{ teams: SimTeam[]; sources: string[]; weights: SimConfig["weights"] }> {
  const sources: string[] = [];
  let powerIndex: PowerIndexEntry[] = [];
  let projections: ProjectionEntry[] = [];
  let futures: FuturesEntry[] = [];

  // Fire all three calls in parallel
  const [bpiResult, projResult, futuresResult] = await Promise.allSettled([
    executePythonBridge("cbb", "get_power_index", {}, config),
    executePythonBridge("cbb", "get_tournament_projections", {}, config),
    executePythonBridge("cbb", "get_futures", {}, config),
  ]);

  if (bpiResult.status === "fulfilled" && bpiResult.value.success && bpiResult.value.data) {
    const raw = bpiResult.value.data;
    powerIndex = Array.isArray(raw) ? raw as PowerIndexEntry[] : [];
    if (powerIndex.length > 0) sources.push("bpi");
  }

  if (projResult.status === "fulfilled" && projResult.value.success && projResult.value.data) {
    const raw = projResult.value.data;
    projections = Array.isArray(raw) ? raw as ProjectionEntry[] : [];
    if (projections.length > 0) sources.push("projections");
  }

  if (
    futuresResult.status === "fulfilled" &&
    futuresResult.value.success &&
    futuresResult.value.data
  ) {
    const raw = futuresResult.value.data;
    futures = Array.isArray(raw) ? raw as FuturesEntry[] : [];
    if (futures.length > 0) sources.push("futures");
  }

  // Build a lookup by normalized team name
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  const projMap = new Map<string, ProjectionEntry>();
  for (const p of projections) {
    if (p.team_name) projMap.set(normalize(p.team_name), p);
  }

  const futuresMap = new Map<string, FuturesEntry>();
  for (const f of futures) {
    if (f.team_name) futuresMap.set(normalize(f.team_name), f);
  }

  // Determine weights based on available data
  let weights: SimConfig["weights"];
  if (sources.includes("bpi") && sources.includes("projections") && sources.includes("futures")) {
    weights = { bpi: 0.6, espnAdv: 0.25, futures: 0.15 };
  } else if (sources.includes("bpi") && sources.includes("projections")) {
    weights = { bpi: 0.7, espnAdv: 0.3, futures: 0 };
  } else if (sources.includes("bpi")) {
    weights = { bpi: 1.0, espnAdv: 0, futures: 0 };
  } else {
    // Seed-based fallback — no real data
    weights = { bpi: 1.0, espnAdv: 0, futures: 0 };
  }

  const teams: SimTeam[] = [];

  if (powerIndex.length > 0) {
    // Build teams from BPI data — these may not have region/seed yet
    // (will be matched to bracket teams later)
    for (const entry of powerIndex) {
      if (!entry.team_name) continue;
      const key = normalize(entry.team_name);
      const proj = projMap.get(key);
      const fut = futuresMap.get(key);

      teams.push({
        seed: 0, // will be populated when matching to bracket
        name: entry.team_name,
        teamId: entry.team_id ?? "",
        region: "East" as BracketRegionName, // placeholder
        bpi: entry.bpi ?? 0,
        tournamentAdvPct: proj
          ? { r32: proj.r32 ?? 0, s16: proj.s16 ?? 0, e8: proj.e8 ?? 0, f4: proj.f4 ?? 0, championship: proj.championship ?? 0 }
          : undefined,
        futuresImpliedProb: fut?.implied_probability ?? undefined,
      });
    }
  }

  return { teams, sources, weights };
}

// ---------------------------------------------------------------------------
// Win probability blending
// ---------------------------------------------------------------------------

/**
 * Compute blended win probability for teamA vs teamB.
 * Combines BPI logistic, ESPN advancement differential, and futures odds.
 */
function blendedWinProb(
  teamA: SimTeam,
  teamB: SimTeam,
  roundName: string,
  weights: SimConfig["weights"],
): number {
  // BPI component — always available (seed fallback guarantees it)
  const pBpi = bpiWinProb(teamA.bpi, teamB.bpi);

  // ESPN advancement component
  let pAdv = 0.5;
  if (teamA.tournamentAdvPct && teamB.tournamentAdvPct) {
    const key = roundKeyFromName(roundName);
    const advA = teamA.tournamentAdvPct[key] ?? 0;
    const advB = teamB.tournamentAdvPct[key] ?? 0;
    const total = advA + advB;
    pAdv = total > 0 ? advA / total : 0.5;
  }

  // Futures component
  let pFut = 0.5;
  if (teamA.futuresImpliedProb != null && teamB.futuresImpliedProb != null) {
    const total = teamA.futuresImpliedProb + teamB.futuresImpliedProb;
    pFut = total > 0 ? teamA.futuresImpliedProb / total : 0.5;
  }

  // Weighted blend
  const totalWeight = weights.bpi + weights.espnAdv + weights.futures;
  if (totalWeight === 0) return pBpi;

  const blended =
    (weights.bpi * pBpi + weights.espnAdv * pAdv + weights.futures * pFut) / totalWeight;

  // Clamp to [0.02, 0.98] — no game is truly impossible
  return Math.max(0.02, Math.min(0.98, blended));
}

/**
 * Map round display name to projection key.
 */
function roundKeyFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes("64") || lower.includes("r32") || lower.includes("round of 32")) return "r32";
  if (lower.includes("sweet") || lower.includes("s16")) return "s16";
  if (lower.includes("elite") || lower.includes("e8")) return "e8";
  if (lower.includes("final four") || lower.includes("f4")) return "f4";
  if (lower.includes("champ")) return "championship";
  return "r32";
}

// ---------------------------------------------------------------------------
// Monte Carlo simulation
// ---------------------------------------------------------------------------

const ROUND_DISPLAY_NAMES = [
  "Round of 64",
  "Round of 32",
  "Sweet 16",
  "Elite 8",
  "Final Four",
  "Championship",
];

/**
 * Match SimTeam data to bracket teams by name (fuzzy) and populate BPI/projections.
 */
function enrichBracketTeams(
  session: BracketSession,
  fieldData: SimTeam[],
): Map<string, SimTeam> {
  const teamMap = new Map<string, SimTeam>();
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  // Build lookup from fetched data
  const dataByName = new Map<string, SimTeam>();
  for (const t of fieldData) {
    dataByName.set(normalize(t.name), t);
  }

  // Extract unique teams from round 1 matchups
  const bracketTeams = new Set<string>();
  for (const m of session.matchups) {
    if (m.round === 1) {
      if (m.topSeed) bracketTeams.add(m.topSeed.name);
      if (m.bottomSeed) bracketTeams.add(m.bottomSeed.name);
    }
  }

  for (const m of session.matchups) {
    if (m.round !== 1) continue;

    for (const team of [m.topSeed, m.bottomSeed]) {
      if (!team || teamMap.has(team.name)) continue;

      const key = normalize(team.name);
      const match = dataByName.get(key);

      if (match) {
        teamMap.set(team.name, {
          ...match,
          seed: team.seed,
          region: team.region,
          name: team.name,
          teamId: team.teamId ?? match.teamId,
        });
      } else {
        // Seed-based fallback
        teamMap.set(team.name, {
          seed: team.seed,
          name: team.name,
          teamId: team.teamId ?? "",
          region: team.region,
          bpi: seedToBpi(team.seed),
        });
      }
    }
  }

  return teamMap;
}

/**
 * Run Monte Carlo bracket simulation.
 *
 * For each iteration, simulate all 63 games using weighted coin flips
 * based on blended win probability. Track how often each team reaches
 * each round.
 */
export function simulateBracket(
  session: BracketSession,
  teamData: Map<string, SimTeam>,
  config: SimConfig,
): SimulationResult {
  const rng = createRng(config.seed);
  const { iterations, weights } = config;

  // Advancement counters: team name → round index → count
  const advCounts = new Map<string, number[]>();
  for (const [name] of teamData) {
    advCounts.set(name, new Array(7).fill(0)); // indices 0-6 for rounds 1-6 + champion
  }

  // Matchup win counters: matchId → [topWins, bottomWins]
  const matchWins = new Map<string, [number, number]>();
  for (const m of session.matchups) {
    matchWins.set(m.matchId, [0, 0]);
  }

  // Pre-build the bracket structure for simulation
  // Round 1 matchups are fixed; later rounds depend on winners
  const round1 = session.matchups.filter((m) => m.round === 1);

  for (let iter = 0; iter < iterations; iter++) {
    // Track winners per matchId for this iteration
    const winners = new Map<string, SimTeam>();

    // Simulate round 1
    for (const m of round1) {
      if (!m.topSeed || !m.bottomSeed) continue;

      const teamA = teamData.get(m.topSeed.name);
      const teamB = teamData.get(m.bottomSeed.name);
      if (!teamA || !teamB) continue;

      const pA = blendedWinProb(teamA, teamB, "Round of 64", weights);
      const winner = rng() < pA ? teamA : teamB;
      winners.set(m.matchId, winner);

      const counts = matchWins.get(m.matchId)!;
      if (winner === teamA) counts[0]++;
      else counts[1]++;

      // Mark both teams as reaching round 1
      advCounts.get(teamA.name)![0]++;
      advCounts.get(teamB.name)![0]++;
    }

    // Simulate rounds 2-6
    for (let round = 2; round <= 6; round++) {
      const roundMatchups = session.matchups.filter((m) => m.round === round);
      const roundName = ROUND_DISPLAY_NAMES[round - 1] ?? `Round ${round}`;

      for (const m of roundMatchups) {
        // Find feeder matchups
        const feeders = getFeederMatchIds(m, session.matchups);
        if (!feeders) continue;

        const teamA = winners.get(feeders.topFeederId);
        const teamB = winners.get(feeders.bottomFeederId);
        if (!teamA || !teamB) continue;

        // Record advancement to this round
        advCounts.get(teamA.name)![round - 1]++;
        advCounts.get(teamB.name)![round - 1]++;

        const pA = blendedWinProb(teamA, teamB, roundName, weights);
        const winner = rng() < pA ? teamA : teamB;
        winners.set(m.matchId, winner);

        const counts = matchWins.get(m.matchId)!;
        if (winner === teamA) counts[0]++;
        else counts[1]++;
      }
    }

    // Champion
    const champMatch = session.matchups.find((m) => m.round === 6);
    if (champMatch) {
      const champ = winners.get(champMatch.matchId);
      if (champ) {
        advCounts.get(champ.name)![6]++;
      }
    }
  }

  // Build matchup results
  const matchupResults: SimMatchupResult[] = [];
  for (const m of session.matchups) {
    const counts = matchWins.get(m.matchId);
    if (!counts) continue;

    const [topWins, bottomWins] = counts;
    const total = topWins + bottomWins;
    if (total === 0) continue;

    const topPct = topWins / total;
    const bottomPct = bottomWins / total;
    const recommended: "top" | "bottom" = topPct >= bottomPct ? "top" : "bottom";
    const maxPct = Math.max(topPct, bottomPct);

    let confidence: "lock" | "strong" | "lean" | "tossup";
    if (maxPct >= 0.85) confidence = "lock";
    else if (maxPct >= 0.70) confidence = "strong";
    else if (maxPct >= 0.55) confidence = "lean";
    else confidence = "tossup";

    const topName = m.topSeed?.name ?? findTeamFromSim(m, "top", session, teamData);
    const bottomName = m.bottomSeed?.name ?? findTeamFromSim(m, "bottom", session, teamData);

    matchupResults.push({
      matchId: m.matchId,
      topTeam: topName,
      bottomTeam: bottomName,
      topWinPct: Math.round(topPct * 1000) / 10,
      bottomWinPct: Math.round(bottomPct * 1000) / 10,
      recommendedPick: recommended,
      confidence,
    });
  }

  // Build team advancement results
  const teamAdvancements: SimTeamAdvancement[] = [];
  for (const [name, counts] of advCounts) {
    const team = teamData.get(name);
    if (!team) continue;

    const pct: Record<string, number> = {};
    for (let r = 0; r < ROUND_DISPLAY_NAMES.length; r++) {
      pct[ROUND_DISPLAY_NAMES[r]] = Math.round((counts[r] / iterations) * 1000) / 10;
    }

    teamAdvancements.push({
      name,
      seed: team.seed,
      region: team.region,
      advancementPct: pct,
      championPct: Math.round((counts[6] / iterations) * 1000) / 10,
    });
  }

  // Top contenders by championship %
  const topContenders = [...teamAdvancements]
    .sort((a, b) => b.championPct - a.championPct)
    .slice(0, 10);

  // Build strategies
  const strategies = buildStrategies(matchupResults, teamAdvancements);

  return {
    config,
    matchups: matchupResults,
    teamAdvancements,
    topContenders,
    strategies,
  };
}

// ---------------------------------------------------------------------------
// Bracket structure helpers for simulation
// ---------------------------------------------------------------------------

/**
 * For a given matchup in round 2+, find the matchIds of the two feeder matchups
 * whose winners become top and bottom seeds.
 */
function getFeederMatchIds(
  matchup: BracketMatchup,
  allMatchups: BracketMatchup[],
): { topFeederId: string; bottomFeederId: string } | null {
  const { round, matchIndex, region } = matchup;

  if (round === 1) return null;

  if (round >= 2 && round <= 4) {
    // Within-region: feeders are from previous round
    const prevRound = round - 1;
    const topIdx = matchIndex * 2;
    const bottomIdx = matchIndex * 2 + 1;
    const regionStr = typeof region === "string" && region !== "Final Four" ? region : "East";
    const prefix = regionStr.toLowerCase();
    return {
      topFeederId: `${prefix}-r${prevRound}-m${topIdx}`,
      bottomFeederId: `${prefix}-r${prevRound}-m${bottomIdx}`,
    };
  }

  if (round === 5) {
    // Final Four: feeders are Elite 8 winners
    // ff-r5-m0 ← East E8 + West E8, ff-r5-m1 ← South E8 + Midwest E8
    if (matchIndex === 0) {
      return {
        topFeederId: "east-r4-m0",
        bottomFeederId: "west-r4-m0",
      };
    } else {
      return {
        topFeederId: "south-r4-m0",
        bottomFeederId: "midwest-r4-m0",
      };
    }
  }

  if (round === 6) {
    // Championship: feeders are Final Four
    return {
      topFeederId: "ff-r5-m0",
      bottomFeederId: "ff-r5-m1",
    };
  }

  return null;
}

/**
 * For later rounds without fixed seeds, try to identify the team name
 * from the bracket structure. Returns a placeholder if unknown.
 */
function findTeamFromSim(
  _matchup: BracketMatchup,
  _slot: "top" | "bottom",
  _session: BracketSession,
  _teamData: Map<string, SimTeam>,
): string {
  return "TBD";
}

// ---------------------------------------------------------------------------
// Kalshi scoring — each round is worth 320 total points
// ---------------------------------------------------------------------------

const KALSHI_SCORING: Record<number, number> = {
  1: 10, 2: 20, 3: 40, 4: 80, 5: 160, 6: 320,
};

/**
 * Map a round number (1-6) from a matchId like "east-r1-m0".
 */
function roundFromMatchId(matchId: string): number {
  const m = matchId.match(/-r(\d+)-/);
  return m ? parseInt(m[1], 10) : 1;
}

// ---------------------------------------------------------------------------
// Strategy generation
// ---------------------------------------------------------------------------

function buildStrategies(
  matchups: SimMatchupResult[],
  teamAdvancements: SimTeamAdvancement[],
): SimulationResult["strategies"] {
  // Most Likely: always pick the higher-probability team
  const mostLikelyPicks = matchups.map((m) => ({
    matchId: m.matchId,
    pick: m.recommendedPick,
    confidence: m.confidence,
  }));

  // Best Upset: in early rounds (r1, r2), pick upsets where confidence
  // is "lean" or "tossup"; chalk in later rounds
  const bestUpsetPicks = matchups.map((m) => {
    const isEarlyRound = m.matchId.includes("-r1-") || m.matchId.includes("-r2-");
    const isUpsetCandidate =
      isEarlyRound && (m.confidence === "lean" || m.confidence === "tossup");

    if (isUpsetCandidate) {
      // Flip the pick — take the underdog
      const pick: "top" | "bottom" = m.recommendedPick === "top" ? "bottom" : "top";
      return { matchId: m.matchId, pick, confidence: "upset" };
    }

    return {
      matchId: m.matchId,
      pick: m.recommendedPick,
      confidence: m.confidence,
    };
  });

  // Kalshi Optimal: pick the team with higher expected Kalshi points
  // (sum of P(reach round R) × KALSHI_SCORING[R] across all rounds)
  const advByName = new Map<string, SimTeamAdvancement>();
  for (const adv of teamAdvancements) {
    advByName.set(adv.name, adv);
  }

  const kalshiExpectedPoints = (teamName: string): number => {
    const adv = advByName.get(teamName);
    if (!adv) return 0;
    let total = 0;
    for (let r = 1; r <= 6; r++) {
      const roundName = ROUND_DISPLAY_NAMES[r - 1];
      const pct = adv.advancementPct[roundName] ?? 0;
      total += (pct / 100) * KALSHI_SCORING[r];
    }
    return total;
  };

  const kalshiOptimalPicks = matchups.map((m) => {
    const topEV = kalshiExpectedPoints(m.topTeam);
    const bottomEV = kalshiExpectedPoints(m.bottomTeam);
    const pick: "top" | "bottom" = topEV >= bottomEV ? "top" : "bottom";

    const maxPct = Math.max(m.topWinPct, m.bottomWinPct);
    let confidence: string;
    if (maxPct >= 85) confidence = "lock";
    else if (maxPct >= 70) confidence = "strong";
    else if (maxPct >= 55) confidence = "lean";
    else confidence = "tossup";

    // If kalshi pick differs from most_likely, mark as "value" confidence
    if (pick !== m.recommendedPick) confidence = "value";

    return { matchId: m.matchId, pick, confidence };
  });

  return {
    most_likely: { picks: mostLikelyPicks },
    best_upset: { picks: bestUpsetPicks },
    kalshi_optimal: { picks: kalshiOptimalPicks },
  };
}
