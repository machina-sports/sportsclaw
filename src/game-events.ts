/**
 * sportsclaw — Semantic Game Event Detection (pure)
 *
 * normalizeScoreboard: raw sports-skills `scores` payload → GameState[].
 * detectGameEvents: diff two GameStates for one game → typed GameEvent[].
 *
 * Pure and deterministic except for the timestamp, which is passed in so
 * callers (and tests) control it. No I/O.
 */

import type { GameState, GameEvent, GameEventType } from "./types.js";

function toNumber(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function toStatus(raw: unknown): GameState["status"] {
  const s = String(raw ?? "").toLowerCase();
  if (s === "live" || s.includes("progress")) return "in_progress";
  if (s === "closed" || s.includes("final") || s.includes("complete") || s === "ft") return "final";
  if (s === "not_started" || s.includes("schedul") || s.includes("pre") || s.includes("upcoming")) return "scheduled";
  return "other";
}

function leaderOf(homeScore: number, awayScore: number): GameState["leader"] {
  if (homeScore > awayScore) return "home";
  if (awayScore > homeScore) return "away";
  return "tie";
}

/** Extract GameState[] from a raw `scores` payload. Tolerant: skips bad games, never throws. */
export function normalizeScoreboard(sport: string, snapshot: unknown): GameState[] {
  const root = snapshot as Record<string, unknown> | unknown[] | null;
  const events: unknown[] = Array.isArray(root)
    ? root
    : Array.isArray((root as Record<string, unknown>)?.["events"])
      ? ((root as Record<string, unknown>)["events"] as unknown[])
      : Array.isArray(((root as Record<string, unknown>)?.["data"] as Record<string, unknown>)?.["events"])
        ? (((root as Record<string, unknown>)["data"] as Record<string, unknown>)["events"] as unknown[])
        : [];
  const out: GameState[] = [];
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const comps = Array.isArray(e["competitors"]) ? (e["competitors"] as Record<string, unknown>[]) : [];
    const homeC = comps.find((c) => c?.["home_away"] === "home");
    const awayC = comps.find((c) => c?.["home_away"] === "away");
    if (!homeC || !awayC) continue;
    const homeTeam = homeC["team"] as Record<string, unknown> | undefined;
    const awayTeam = awayC["team"] as Record<string, unknown> | undefined;
    const home = String(homeTeam?.["name"] ?? homeC["name"] ?? "").trim();
    const away = String(awayTeam?.["name"] ?? awayC["name"] ?? "").trim();
    if (!home || !away) continue;
    const gameId = String(e["id"] ?? e["@id"] ?? `${sport}:${home}-${away}`);
    const homeScore = toNumber(homeC["score"]);
    const awayScore = toNumber(awayC["score"]);
    const status = toStatus(e["status"]);
    out.push({ gameId, sport, home, away, homeScore, awayScore, status, leader: leaderOf(homeScore, awayScore) });
  }
  return out;
}

/** Diff two states for one game into typed events. */
export function detectGameEvents(
  prev: GameState | undefined,
  curr: GameState,
  now: string = new Date().toISOString()
): GameEvent[] {
  const types: GameEventType[] = [];

  if (!prev) {
    if (curr.status === "in_progress") types.push("game_start");
    if (curr.status === "final") types.push("final");
  } else {
    if (prev.status !== "in_progress" && curr.status === "in_progress") types.push("game_start");
    if (curr.homeScore > prev.homeScore || curr.awayScore > prev.awayScore) types.push("score_change");
    if (curr.leader !== prev.leader && curr.leader !== "tie") types.push("lead_change");
    if (prev.status !== "final" && curr.status === "final") types.push("final");
  }

  const scoreSignature = `${curr.homeScore}-${curr.awayScore}`;
  return types.map((type) => ({
    type, gameId: curr.gameId, sport: curr.sport, state: curr, scoreSignature, timestamp: now,
  }));
}
