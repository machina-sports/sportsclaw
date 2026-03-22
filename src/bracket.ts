/**
 * sportsclaw — March Madness Bracket Builder
 *
 * Core bracket module: types, structure generation, pick cascading, CRUD,
 * and view helpers. Brackets are persisted per-user to disk and can be
 * resumed across sessions.
 *
 * Persistence: ~/.sportsclaw/brackets/<sanitizedUserId>/<bracketId>.json
 */

import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile, unlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { BracketMatch } from "./charts.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const REGIONS = ["East", "West", "South", "Midwest"] as const;
export type BracketRegionName = (typeof REGIONS)[number];

export const ROUND_NAMES = [
  "Round of 64",
  "Round of 32",
  "Sweet 16",
  "Elite 8",
  "Final Four",
  "Championship",
] as const;

/** NCAA tournament first-round seeding order per region (matchup pairings). */
const SEED_ORDER: [number, number][] = [
  [1, 16],
  [8, 9],
  [5, 12],
  [4, 13],
  [6, 11],
  [3, 14],
  [7, 10],
  [2, 15],
];

const MAX_BRACKETS_PER_USER = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BracketTeam {
  seed: number;
  name: string;
  teamId?: string;
  region: BracketRegionName;
  bpi?: number;
}

export interface BracketMatchup {
  matchId: string;
  round: number;
  roundName: string;
  region: BracketRegionName | "Final Four";
  matchIndex: number;
  topSeed: BracketTeam | null;
  bottomSeed: BracketTeam | null;
  pick: "top" | "bottom" | null;
  simTopWinPct?: number;
  simBottomWinPct?: number;
  simRecommendedPick?: "top" | "bottom";
  simConfidence?: "lock" | "strong" | "lean" | "tossup";
}

export interface BracketSession {
  id: string;
  userId: string;
  name: string;
  year: number;
  createdAt: string;
  updatedAt: string;
  status: "in_progress" | "completed" | "expired";
  matchups: BracketMatchup[];
  champion: BracketTeam | null;
  picksCompleted: number;
  totalMatchups: number;
  seedSource: "manual" | "espn" | "rankings";
  simulation?: {
    ranAt: string;
    iterations: number;
    topContenders: Array<{
      name: string;
      seed: number;
      region: string;
      championPct: number;
    }>;
  };
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function sanitizeId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getBracketsDir(userId: string): string {
  const dir = join(homedir(), ".sportsclaw", "brackets", sanitizeId(userId));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getBracketPath(userId: string, bracketId: string): string {
  return join(getBracketsDir(userId), `${bracketId}.json`);
}

function generateSlug(): string {
  return randomBytes(4).toString("hex"); // 8 hex chars
}

// ---------------------------------------------------------------------------
// Structure generation
// ---------------------------------------------------------------------------

function makeMatchId(
  region: BracketRegionName | "ff" | "champ",
  round: number,
  matchIndex: number,
): string {
  const prefix = region === "ff" || region === "champ"
    ? region
    : region.toLowerCase();
  return `${prefix}-r${round}-m${matchIndex}`;
}

/**
 * Build 63 matchups from a 64-team field (4 regions × 16 seeds).
 * R1 uses NCAA seeding order. R2+ matchups start with null seeds.
 */
export function generateBracketStructure(
  teams: BracketTeam[],
  year: number,
): BracketMatchup[] {
  if (teams.length !== 64) {
    throw new Error(`Expected 64 teams, got ${teams.length}`);
  }

  // Validate 16 teams per region
  for (const region of REGIONS) {
    const regionTeams = teams.filter((t) => t.region === region);
    if (regionTeams.length !== 16) {
      throw new Error(
        `Region ${region} has ${regionTeams.length} teams, expected 16`,
      );
    }
  }

  const matchups: BracketMatchup[] = [];

  // Build by-region lookup: region → seed → team
  const teamMap = new Map<string, BracketTeam>();
  for (const t of teams) {
    teamMap.set(`${t.region}-${t.seed}`, t);
  }

  // --- Round 1 (Round of 64): 4 regions × 8 matchups = 32 ---
  for (const region of REGIONS) {
    for (let mi = 0; mi < SEED_ORDER.length; mi++) {
      const [topSeedNum, bottomSeedNum] = SEED_ORDER[mi]!;
      const topTeam = teamMap.get(`${region}-${topSeedNum}`) ?? null;
      const bottomTeam = teamMap.get(`${region}-${bottomSeedNum}`) ?? null;

      matchups.push({
        matchId: makeMatchId(region, 1, mi),
        round: 1,
        roundName: ROUND_NAMES[0],
        region,
        matchIndex: mi,
        topSeed: topTeam,
        bottomSeed: bottomTeam,
        pick: null,
      });
    }
  }

  // --- Rounds 2-4 (R32, Sweet 16, Elite 8) per region ---
  for (const region of REGIONS) {
    let prevMatchCount = 8;
    for (let round = 2; round <= 4; round++) {
      const matchCount = prevMatchCount / 2;
      for (let mi = 0; mi < matchCount; mi++) {
        matchups.push({
          matchId: makeMatchId(region, round, mi),
          round,
          roundName: ROUND_NAMES[round - 1],
          region,
          matchIndex: mi,
          topSeed: null,
          bottomSeed: null,
          pick: null,
        });
      }
      prevMatchCount = matchCount;
    }
  }

  // --- Round 5 (Final Four): 2 matchups ---
  // East E8 winner vs West E8 winner → ff-r5-m0
  // South E8 winner vs Midwest E8 winner → ff-r5-m1
  matchups.push({
    matchId: makeMatchId("ff", 5, 0),
    round: 5,
    roundName: ROUND_NAMES[4],
    region: "Final Four",
    matchIndex: 0,
    topSeed: null,
    bottomSeed: null,
    pick: null,
  });
  matchups.push({
    matchId: makeMatchId("ff", 5, 1),
    round: 5,
    roundName: ROUND_NAMES[4],
    region: "Final Four",
    matchIndex: 1,
    topSeed: null,
    bottomSeed: null,
    pick: null,
  });

  // --- Round 6 (Championship): 1 matchup ---
  matchups.push({
    matchId: makeMatchId("champ", 6, 0),
    round: 6,
    roundName: ROUND_NAMES[5],
    region: "Final Four",
    matchIndex: 0,
    topSeed: null,
    bottomSeed: null,
    pick: null,
  });

  return matchups;
}

// ---------------------------------------------------------------------------
// Pick cascading
// ---------------------------------------------------------------------------

/**
 * Given a matchup, find the matchId of the next-round matchup it feeds into,
 * and whether this match's winner becomes topSeed or bottomSeed.
 */
function getNextMatchTarget(
  matchup: BracketMatchup,
): { nextMatchId: string; slot: "top" | "bottom" } | null {
  const { round, matchIndex, region } = matchup;

  // Championship has no next round
  if (round === 6) return null;

  // Rounds 1-3 (within region): feed into next regional round
  if (round >= 1 && round <= 3) {
    const nextRound = round + 1;
    const nextIndex = Math.floor(matchIndex / 2);
    const slot: "top" | "bottom" = matchIndex % 2 === 0 ? "top" : "bottom";
    const regionStr = typeof region === "string" && region !== "Final Four"
      ? region
      : "East"; // should not happen for rounds 1-3
    return {
      nextMatchId: makeMatchId(regionStr as BracketRegionName, nextRound, nextIndex),
      slot,
    };
  }

  // Round 4 (Elite 8): feeds into Final Four
  if (round === 4) {
    // East/West E8 winners → ff-r5-m0, South/Midwest → ff-r5-m1
    const regionOrder: Record<string, { ffMatch: number; slot: "top" | "bottom" }> = {
      East: { ffMatch: 0, slot: "top" },
      West: { ffMatch: 0, slot: "bottom" },
      South: { ffMatch: 1, slot: "top" },
      Midwest: { ffMatch: 1, slot: "bottom" },
    };
    const target = regionOrder[region as string];
    if (!target) return null;
    return {
      nextMatchId: makeMatchId("ff", 5, target.ffMatch),
      slot: target.slot,
    };
  }

  // Round 5 (Final Four): feeds into Championship
  if (round === 5) {
    const slot: "top" | "bottom" = matchIndex === 0 ? "top" : "bottom";
    return {
      nextMatchId: makeMatchId("champ", 6, 0),
      slot,
    };
  }

  return null;
}

function getWinner(matchup: BracketMatchup): BracketTeam | null {
  if (!matchup.pick) return null;
  return matchup.pick === "top" ? matchup.topSeed : matchup.bottomSeed;
}

/**
 * Make a pick for a matchup. Propagates the winner forward and cascade-clears
 * downstream picks if changing a previous pick eliminates an already-advanced team.
 */
export function makePick(
  session: BracketSession,
  matchId: string,
  pick: "top" | "bottom",
): { session: BracketSession; cascadeCleared: string[] } {
  const matchup = session.matchups.find((m) => m.matchId === matchId);
  if (!matchup) {
    throw new Error(`Matchup "${matchId}" not found`);
  }
  if (!matchup.topSeed || !matchup.bottomSeed) {
    throw new Error(
      `Cannot pick for "${matchId}" — both seeds must be populated`,
    );
  }

  const previousWinner = getWinner(matchup);
  const cascadeCleared: string[] = [];

  // Set the pick
  matchup.pick = pick;
  const newWinner = getWinner(matchup)!;

  // Propagate winner to next round
  const target = getNextMatchTarget(matchup);
  if (target) {
    const nextMatchup = session.matchups.find(
      (m) => m.matchId === target.nextMatchId,
    );
    if (nextMatchup) {
      // If changing a pick, cascade-clear downstream if needed
      if (previousWinner && previousWinner.name !== newWinner.name) {
        cascadeClear(session, nextMatchup, previousWinner, cascadeCleared);
      }
      // Set the winner in the next round's slot
      if (target.slot === "top") {
        nextMatchup.topSeed = newWinner;
      } else {
        nextMatchup.bottomSeed = newWinner;
      }
    }
  }

  // Update session counters
  session.picksCompleted = session.matchups.filter((m) => m.pick !== null).length;
  if (session.picksCompleted === session.totalMatchups) {
    session.status = "completed";
    // The championship winner
    const champMatch = session.matchups.find((m) => m.round === 6);
    session.champion = champMatch ? getWinner(champMatch) : null;
  }

  return { session, cascadeCleared };
}

/**
 * Recursively nullify downstream slots that contained an eliminated team.
 */
function cascadeClear(
  session: BracketSession,
  matchup: BracketMatchup,
  eliminatedTeam: BracketTeam,
  cleared: string[],
): void {
  let affected = false;

  if (matchup.topSeed?.name === eliminatedTeam.name) {
    matchup.topSeed = null;
    affected = true;
  }
  if (matchup.bottomSeed?.name === eliminatedTeam.name) {
    matchup.bottomSeed = null;
    affected = true;
  }

  if (affected) {
    if (matchup.pick !== null) {
      cleared.push(matchup.matchId);
      matchup.pick = null;
    }

    // Continue cascade forward
    const target = getNextMatchTarget(matchup);
    if (target) {
      const nextMatchup = session.matchups.find(
        (m) => m.matchId === target.nextMatchId,
      );
      if (nextMatchup) {
        // The team that was picked here (if any) also needs to be cleared forward
        cascadeClear(session, nextMatchup, eliminatedTeam, cleared);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createBracket(opts: {
  userId: string;
  name?: string;
  teams: BracketTeam[];
  year?: number;
  seedSource?: "manual" | "espn" | "rankings";
}): Promise<BracketSession> {
  const { userId, teams, seedSource = "manual" } = opts;
  const year = opts.year ?? new Date().getFullYear();
  const name = opts.name ?? `Bracket ${year}`;

  // Enforce per-user limit
  const existing = await listBrackets(userId);
  if (existing.length >= MAX_BRACKETS_PER_USER) {
    throw new Error(
      `Maximum ${MAX_BRACKETS_PER_USER} brackets per user. Delete one first.`,
    );
  }

  const matchups = generateBracketStructure(teams, year);
  const now = new Date().toISOString();

  const session: BracketSession = {
    id: generateSlug(),
    userId,
    name,
    year,
    createdAt: now,
    updatedAt: now,
    status: "in_progress",
    matchups,
    champion: null,
    picksCompleted: 0,
    totalMatchups: 63,
    seedSource,
  };

  await saveBracket(session);
  return session;
}

export async function loadBracket(
  userId: string,
  bracketId: string,
): Promise<BracketSession | null> {
  const path = getBracketPath(userId, bracketId);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as BracketSession;
  } catch {
    return null;
  }
}

export async function saveBracket(session: BracketSession): Promise<void> {
  session.updatedAt = new Date().toISOString();
  const path = getBracketPath(session.userId, session.id);
  await writeFile(path, JSON.stringify(session, null, 2), "utf-8");
}

export async function listBrackets(userId: string): Promise<BracketSession[]> {
  const dir = getBracketsDir(userId);
  try {
    const files = await readdir(dir);
    const sessions: BracketSession[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(dir, file), "utf-8");
        sessions.push(JSON.parse(raw) as BracketSession);
      } catch {
        // skip corrupt files
      }
    }
    return sessions.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  } catch {
    return [];
  }
}

export async function deleteBracket(
  userId: string,
  bracketId: string,
): Promise<boolean> {
  const path = getBracketPath(userId, bracketId);
  if (!existsSync(path)) return false;
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// View helpers
// ---------------------------------------------------------------------------

export interface BracketProgress {
  picksCompleted: number;
  totalMatchups: number;
  percentage: number;
  currentRound: string;
  regionsComplete: string[];
  champion: BracketTeam | null;
}

export function getBracketProgress(session: BracketSession): BracketProgress {
  const { picksCompleted, totalMatchups, champion, matchups } = session;
  const percentage = Math.round((picksCompleted / totalMatchups) * 100);

  // Current round = lowest round with unpicked matchups that have both seeds
  let currentRound: string = ROUND_NAMES[5]; // default to Championship
  for (let r = 1; r <= 6; r++) {
    const roundMatchups = matchups.filter((m) => m.round === r);
    const hasUnpicked = roundMatchups.some(
      (m) => m.pick === null && m.topSeed !== null && m.bottomSeed !== null,
    );
    if (hasUnpicked) {
      currentRound = ROUND_NAMES[r - 1];
      break;
    }
  }

  // Check which regions are fully complete (all 4 rounds done)
  const regionsComplete: string[] = [];
  for (const region of REGIONS) {
    const regionMatchups = matchups.filter(
      (m) => m.region === region && m.round <= 4,
    );
    const allPicked = regionMatchups.every((m) => m.pick !== null);
    if (allPicked && regionMatchups.length === 15) {
      regionsComplete.push(region);
    }
  }

  return {
    picksCompleted,
    totalMatchups,
    percentage,
    currentRound,
    regionsComplete,
    champion,
  };
}

export function getNextMatchups(
  session: BracketSession,
  opts?: { region?: BracketRegionName; limit?: number },
): BracketMatchup[] {
  let candidates = session.matchups.filter(
    (m) => m.pick === null && m.topSeed !== null && m.bottomSeed !== null,
  );

  if (opts?.region) {
    candidates = candidates.filter((m) => m.region === opts.region);
  }

  // Sort by round then matchIndex
  candidates.sort((a, b) => a.round - b.round || a.matchIndex - b.matchIndex);

  if (opts?.limit) {
    candidates = candidates.slice(0, opts.limit);
  }

  return candidates;
}

/**
 * Convert BracketMatchup[] → BracketMatch[] for renderBracket() in charts.ts.
 * Can filter to a single region or show the Final Four + Championship.
 */
export function toBracketChartData(
  session: BracketSession,
  region?: BracketRegionName | "Final Four",
): BracketMatch[] {
  let filtered: BracketMatchup[];

  if (region === "Final Four") {
    filtered = session.matchups.filter((m) => m.round >= 5);
  } else if (region) {
    filtered = session.matchups.filter(
      (m) => m.region === region && m.round <= 4,
    );
  } else {
    // Full bracket — all matchups
    filtered = session.matchups;
  }

  return filtered.map((m) => {
    const team1 = m.topSeed
      ? `(${m.topSeed.seed}) ${m.topSeed.name}`
      : "TBD";
    const team2 = m.bottomSeed
      ? `(${m.bottomSeed.seed}) ${m.bottomSeed.name}`
      : "TBD";

    let winner: 1 | 2 | undefined;
    if (m.pick === "top") winner = 1;
    else if (m.pick === "bottom") winner = 2;

    // Renumber rounds per-region for chart display (region rounds are 1-4)
    let displayRound = m.round;
    if (region && region !== "Final Four") {
      displayRound = m.round; // already 1-4 within region
    } else if (region === "Final Four") {
      displayRound = m.round - 4; // 5→1, 6→2
    }

    return {
      round: displayRound,
      matchIndex: m.matchIndex,
      team1,
      team2,
      winner,
    };
  });
}

// ---------------------------------------------------------------------------
// Simulation integration
// ---------------------------------------------------------------------------

import type { SimulationResult, SimBracketStrategy } from "./bracket-sim.js";

/**
 * Annotate bracket matchups with Monte Carlo simulation data and save
 * top contenders to the session metadata. Does NOT modify picks.
 */
export function applySimulationToBracket(
  session: BracketSession,
  simResult: SimulationResult,
): void {
  const simMap = new Map(simResult.matchups.map((m) => [m.matchId, m]));

  for (const matchup of session.matchups) {
    const sim = simMap.get(matchup.matchId);
    if (sim) {
      matchup.simTopWinPct = sim.topWinPct;
      matchup.simBottomWinPct = sim.bottomWinPct;
      matchup.simRecommendedPick = sim.recommendedPick;
      matchup.simConfidence = sim.confidence;
    }
  }

  session.simulation = {
    ranAt: new Date().toISOString(),
    iterations: simResult.config.iterations,
    topContenders: simResult.topContenders.map((t) => ({
      name: t.name,
      seed: t.seed,
      region: t.region,
      championPct: t.championPct,
    })),
  };
}

/**
 * Auto-fill all bracket picks from a simulation strategy.
 * Processes round by round so that winners cascade correctly.
 */
export function autoFillBracketFromSim(
  session: BracketSession,
  strategy: SimBracketStrategy,
  simResult: SimulationResult,
): { filled: number; cascadeCleared: string[] } {
  const strategyPicks = simResult.strategies[strategy]?.picks;
  if (!strategyPicks) {
    return { filled: 0, cascadeCleared: [] };
  }

  const pickMap = new Map(strategyPicks.map((p) => [p.matchId, p.pick]));
  let filled = 0;
  const allCascadeCleared: string[] = [];

  // Process round by round (1→6) so cascading works
  for (let round = 1; round <= 6; round++) {
    const roundMatchups = session.matchups
      .filter((m) => m.round === round)
      .sort((a, b) => a.matchIndex - b.matchIndex);

    for (const matchup of roundMatchups) {
      if (!matchup.topSeed || !matchup.bottomSeed) continue;

      const pick = pickMap.get(matchup.matchId);
      if (!pick) continue;

      const { cascadeCleared } = makePick(session, matchup.matchId, pick);
      filled++;
      allCascadeCleared.push(...cascadeCleared);
    }
  }

  return { filled, cascadeCleared: allCascadeCleared };
}
