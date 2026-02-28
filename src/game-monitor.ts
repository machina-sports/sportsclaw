/**
 * sportsclaw — Game Monitor (Sprint 2 Live Games)
 *
 * Polls ESPN's public scoreboard API for live game data and broadcasts
 * state changes through the RelayManager pub/sub channel.
 *
 * ESPN endpoint pattern (public, no auth required):
 *   https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard
 *
 * Supports: NFL, NBA, MLB, NHL, WNBA, CFB, CBB, Soccer (any league code).
 */

import { relayManager } from "./relay.js";
import type {
  LiveGameEvent,
  LiveGameState,
  LiveGameEventType,
  GameStatus,
  TeamScore,
} from "./relay.js";

// ---------------------------------------------------------------------------
// ESPN API constants
// ---------------------------------------------------------------------------

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";

/** Map sportsclaw sport keys → ESPN URL segments */
const ESPN_PATHS: Record<string, { category: string; league: string }> = {
  nfl: { category: "football", league: "nfl" },
  nba: { category: "basketball", league: "nba" },
  mlb: { category: "baseball", league: "mlb" },
  nhl: { category: "hockey", league: "nhl" },
  wnba: { category: "basketball", league: "wnba" },
  cfb: { category: "football", league: "college-football" },
  cbb: { category: "basketball", league: "mens-college-basketball" },
  // Soccer uses dynamic league codes — handled via soccerLeague option
  soccer: { category: "soccer", league: "eng.1" },
  football: { category: "soccer", league: "eng.1" },
};

const POLL_INTERVAL_LIVE_MS = 30_000; // 30s when games are in progress
const POLL_INTERVAL_PREGAME_MS = 300_000; // 5min when waiting for tip-off
const FETCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// ESPN response shapes (minimal, only what we parse)
// ---------------------------------------------------------------------------

interface ESPNCompetitor {
  id: string;
  homeAway: "home" | "away";
  team: {
    id: string;
    abbreviation: string;
    displayName: string;
    logo?: string;
  };
  score: string;
  linescores?: Array<{ value: number }>;
}

interface ESPNStatus {
  type: {
    state: "pre" | "in" | "post";
    description: string;
    detail: string;
    shortDetail: string;
  };
  displayClock: string;
  period: number;
}

interface ESPNEvent {
  id: string;
  name: string;
  status: ESPNStatus;
  competitions: Array<{
    id: string;
    venue?: { fullName: string };
    competitors: ESPNCompetitor[];
  }>;
}

interface ESPNScoreboardResponse {
  events?: ESPNEvent[];
}

// ---------------------------------------------------------------------------
// Monitor configuration
// ---------------------------------------------------------------------------

export interface MonitorOptions {
  /** Specific game IDs to track. If omitted, tracks all games on the scoreboard. */
  gameIds?: string[];
  /** Override the default poll interval (ms). Defaults to auto-scaling. */
  pollIntervalMs?: number;
  /** Soccer league code for ESPN (e.g. "eng.1", "usa.1"). Default: "eng.1". */
  soccerLeague?: string;
  /** Specific date to poll (YYYYMMDD format). Default: today. */
  date?: string;
}

// ---------------------------------------------------------------------------
// GameMonitor
// ---------------------------------------------------------------------------

export class GameMonitor {
  private activePollers = new Map<string, NodeJS.Timeout>();
  private previousStates = new Map<string, LiveGameState>();

  /**
   * Start polling ESPN for a sport's scoreboard.
   * Broadcasts LiveGameEvents to the relay channel when state changes.
   */
  async startMonitoring(
    sport: string,
    options?: MonitorOptions
  ): Promise<void> {
    const key = monitorKey(sport, options?.gameIds);
    if (this.activePollers.has(key)) {
      console.log(`[GameMonitor] Already monitoring ${key}`);
      return;
    }

    await relayManager.initialize();

    const ids = options?.gameIds;
    console.log(
      `[GameMonitor] Starting ${sport} monitor` +
        (ids?.length ? ` for games: ${ids.join(", ")}` : " (all games)")
    );

    // Immediate first poll
    await this.poll(sport, options);

    const intervalMs =
      options?.pollIntervalMs ?? this.bestInterval(sport, ids);
    const interval = setInterval(
      () => this.poll(sport, options),
      intervalMs
    );
    this.activePollers.set(key, interval);
  }

  /** Stop monitoring a specific sport (and optionally specific games). */
  stopMonitoring(sport: string, gameIds?: string[]): void {
    const key = monitorKey(sport, gameIds);
    const interval = this.activePollers.get(key);
    if (interval) {
      clearInterval(interval);
      this.activePollers.delete(key);
      console.log(`[GameMonitor] Stopped monitor: ${key}`);
    }
  }

  /** Stop all active monitors. */
  stopAll(): void {
    for (const [key, interval] of this.activePollers) {
      clearInterval(interval);
      console.log(`[GameMonitor] Stopped monitor: ${key}`);
    }
    this.activePollers.clear();
    this.previousStates.clear();
  }

  /** List currently active monitor keys. */
  getActiveMonitors(): string[] {
    return Array.from(this.activePollers.keys());
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  private async poll(sport: string, options?: MonitorOptions): Promise<void> {
    try {
      const events = await fetchScoreboard(sport, options);

      for (const espnEvent of events) {
        // Filter by game IDs if specified
        if (
          options?.gameIds?.length &&
          !options.gameIds.includes(espnEvent.id)
        ) {
          continue;
        }

        const state = parseEvent(espnEvent, sport);
        if (!state) continue;

        const previous = this.previousStates.get(state.gameId);
        const eventType = detectChange(previous, state);

        if (eventType) {
          const gameEvent: LiveGameEvent = {
            event: eventType,
            data: state,
            delta: computeDelta(previous, state),
            timestamp: new Date().toISOString(),
          };

          await relayManager.broadcastEvent(gameEvent);

          console.log(
            `[GameMonitor] ${eventType}: ` +
              `${state.away.abbreviation} ${state.away.score} @ ` +
              `${state.home.abbreviation} ${state.home.score} ` +
              `(${state.statusDetail})`
          );
        }

        this.previousStates.set(state.gameId, state);

        // Auto-stop tracking games that have ended
        if (state.status === "final") {
          // Remove from previous states after a grace period
          setTimeout(() => this.previousStates.delete(state.gameId), 120_000);
        }
      }
    } catch (err) {
      console.error(
        `[GameMonitor] Poll error for ${sport}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Choose a poll interval based on whether any tracked games are live.
   */
  private bestInterval(sport: string, gameIds?: string[]): number {
    for (const [id, state] of this.previousStates) {
      if (gameIds?.length && !gameIds.includes(id)) continue;
      if (state.sport === sport && state.status === "in_progress") {
        return POLL_INTERVAL_LIVE_MS;
      }
    }
    return POLL_INTERVAL_PREGAME_MS;
  }
}

// ---------------------------------------------------------------------------
// ESPN API fetch
// ---------------------------------------------------------------------------

async function fetchScoreboard(
  sport: string,
  options?: MonitorOptions
): Promise<ESPNEvent[]> {
  const mapping = ESPN_PATHS[sport];
  if (!mapping) {
    console.error(`[GameMonitor] Unknown sport: ${sport}`);
    return [];
  }

  // Soccer league override
  const league =
    (sport === "soccer" || sport === "football") && options?.soccerLeague
      ? options.soccerLeague
      : mapping.league;

  let url = `${ESPN_BASE}/${mapping.category}/${league}/scoreboard`;
  if (options?.date) {
    url += `?dates=${options.date}`;
  }

  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(`ESPN API ${res.status}: ${res.statusText}`);
  }

  const data = (await res.json()) as ESPNScoreboardResponse;
  return data.events ?? [];
}

// ---------------------------------------------------------------------------
// ESPN → LiveGameState parser
// ---------------------------------------------------------------------------

function parseEvent(event: ESPNEvent, sport: string): LiveGameState | null {
  const comp = event.competitions?.[0];
  if (!comp) return null;

  const homeComp = comp.competitors.find((c) => c.homeAway === "home");
  const awayComp = comp.competitors.find((c) => c.homeAway === "away");
  if (!homeComp || !awayComp) return null;

  const status = mapStatus(event.status);

  const home: TeamScore = {
    id: homeComp.team.id,
    name: homeComp.team.displayName,
    abbreviation: homeComp.team.abbreviation,
    score: parseInt(homeComp.score, 10) || 0,
    logo: homeComp.team.logo,
    periodScores: homeComp.linescores?.map((ls) => ls.value),
  };

  const away: TeamScore = {
    id: awayComp.team.id,
    name: awayComp.team.displayName,
    abbreviation: awayComp.team.abbreviation,
    score: parseInt(awayComp.score, 10) || 0,
    logo: awayComp.team.logo,
    periodScores: awayComp.linescores?.map((ls) => ls.value),
  };

  return {
    gameId: event.id,
    sport,
    status,
    statusDetail: event.status.type.shortDetail || event.status.type.detail,
    home,
    away,
    clock: event.status.displayClock || "",
    venue: comp.venue?.fullName,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Map ESPN status to our GameStatus union.
 * ESPN uses "pre" / "in" / "post" as the main state categories.
 * Halftime, delayed, postponed are detected from the description.
 */
function mapStatus(status: ESPNStatus): GameStatus {
  const desc = status.type.description.toLowerCase();
  const detail = status.type.detail.toLowerCase();

  if (desc.includes("postponed")) return "postponed";
  if (desc.includes("delayed") || desc.includes("delay")) return "delayed";
  if (desc.includes("halftime") || detail.includes("halftime")) {
    return "halftime";
  }

  switch (status.type.state) {
    case "pre":
      return "scheduled";
    case "in":
      return "in_progress";
    case "post":
      return "final";
    default:
      return "scheduled";
  }
}

// ---------------------------------------------------------------------------
// State diffing
// ---------------------------------------------------------------------------

/**
 * Compare previous and current state to determine which event type to emit.
 * Returns null if nothing meaningful changed (no event needed).
 */
function detectChange(
  previous: LiveGameState | undefined,
  current: LiveGameState
): LiveGameEventType | null {
  // First time seeing this game — emit based on its current status
  if (!previous) {
    if (current.status === "in_progress" || current.status === "halftime") {
      return "GAME_START";
    }
    if (current.status === "final") {
      return "GAME_END";
    }
    // Scheduled game — emit an update so subscribers get the initial state
    return "GAME_UPDATE";
  }

  // Game just started
  if (
    previous.status === "scheduled" &&
    (current.status === "in_progress" || current.status === "halftime")
  ) {
    return "GAME_START";
  }

  // Game just ended
  if (previous.status !== "final" && current.status === "final") {
    return "GAME_END";
  }

  // Status changed (e.g. in_progress → halftime, halftime → in_progress)
  if (previous.status !== current.status) {
    return "STATUS_CHANGE";
  }

  // Score changed
  if (
    previous.home.score !== current.home.score ||
    previous.away.score !== current.away.score
  ) {
    return "SCORE_CHANGE";
  }

  // Clock changed (game is live, clock ticked)
  if (
    current.status === "in_progress" &&
    previous.statusDetail !== current.statusDetail
  ) {
    return "GAME_UPDATE";
  }

  // Nothing meaningful changed
  return null;
}

/**
 * Compute the delta between previous and current state.
 */
function computeDelta(
  previous: LiveGameState | undefined,
  current: LiveGameState
): LiveGameEvent["delta"] {
  if (!previous) return undefined;

  const homeScoreDelta = current.home.score - previous.home.score;
  const awayScoreDelta = current.away.score - previous.away.score;
  const statusChanged = previous.status !== current.status;

  if (!homeScoreDelta && !awayScoreDelta && !statusChanged) return undefined;

  return {
    ...(homeScoreDelta !== 0 && { homeScoreDelta }),
    ...(awayScoreDelta !== 0 && { awayScoreDelta }),
    ...(statusChanged && { previousStatus: previous.status }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function monitorKey(sport: string, gameIds?: string[]): string {
  return gameIds?.length
    ? `${sport}:${[...gameIds].sort().join(",")}`
    : sport;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const gameMonitor = new GameMonitor();
