/**
 * sportsclaw — Game Monitor (Sprint 2 Live Games)
 *
 * Polls scoreboard providers for live game data and broadcasts IPTC-schema
 * events through the RelayManager pub/sub channel.
 *
 * Provider-agnostic: accepts any ScoreboardProvider implementation.
 * Ships with ESPNProvider as the default (maps shallow ESPN data to IPTC,
 * leaving deeper stats and machina: extensions empty for downstream enrichment).
 */

import { relayManager } from "./relay.js";
import {
  toIPTCStatus,
  fromIPTCStatus,
  toIPTCDiscipline,
  iptcGameId,
  iptcHome,
  iptcAway,
  MACHINA_CONTEXT,
} from "./relay.js";
import type {
  IPTCSportEvent,
  IPTCEventType,
  IPTCEventStatus,
  IPTCCompetitor,
  LegacyGameStatus,
  LiveGameEvent,
  LiveGameEnvelope,
} from "./relay.js";

// ---------------------------------------------------------------------------
// ScoreboardProvider interface
// ---------------------------------------------------------------------------

export interface ScoreboardProviderOptions {
  /** Specific game IDs to track. If omitted, tracks all games on the scoreboard. */
  gameIds?: string[];
  /** Soccer league code (e.g. "eng.1", "usa.1"). Provider-specific. */
  soccerLeague?: string;
  /** Specific date to poll (YYYYMMDD format). Default: today. */
  date?: string;
}

/**
 * Contract for any live-game data source.
 * Implementations fetch current game states as LiveGameEvent objects
 * (IPTC events with Machina context for the live-games channel).
 */
export interface ScoreboardProvider {
  /** Unique identifier for this provider (e.g. "espn", "sportradar"). */
  readonly name: string;
  /** Sports this provider supports (e.g. ["nba","nfl","mlb"]). */
  readonly supportedSports: string[];
  /** Fetch current game states for a sport. Returns LiveGameEvent[]. */
  fetchGames(
    sport: string,
    options?: ScoreboardProviderOptions
  ): Promise<LiveGameEvent[]>;
}

// ---------------------------------------------------------------------------
// Monitor configuration
// ---------------------------------------------------------------------------

export interface MonitorOptions extends ScoreboardProviderOptions {
  /** Override the default poll interval (ms). Defaults to auto-scaling. */
  pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// ESPN provider types (internal)
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
// ESPNProvider — maps shallow ESPN data to IPTC sport schema
// ---------------------------------------------------------------------------

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";
const FETCH_TIMEOUT_MS = 15_000;

/** Map sportsclaw sport keys to ESPN URL segments */
const ESPN_PATHS: Record<string, { category: string; league: string }> = {
  nfl: { category: "football", league: "nfl" },
  nba: { category: "basketball", league: "nba" },
  mlb: { category: "baseball", league: "mlb" },
  nhl: { category: "hockey", league: "nhl" },
  wnba: { category: "basketball", league: "wnba" },
  cfb: { category: "football", league: "college-football" },
  cbb: { category: "basketball", league: "mens-college-basketball" },
  soccer: { category: "soccer", league: "eng.1" },
  football: { category: "soccer", league: "eng.1" },
};

export class ESPNProvider implements ScoreboardProvider {
  readonly name = "espn";
  readonly supportedSports = Object.keys(ESPN_PATHS);

  async fetchGames(
    sport: string,
    options?: ScoreboardProviderOptions
  ): Promise<LiveGameEvent[]> {
    const events = await this.fetchScoreboard(sport, options);
    const states: LiveGameEvent[] = [];
    for (const event of events) {
      const state = this.parseEvent(event, sport);
      if (state) states.push(state);
    }
    return states;
  }

  // -----------------------------------------------------------------------
  // ESPN API fetch
  // -----------------------------------------------------------------------

  private async fetchScoreboard(
    sport: string,
    options?: ScoreboardProviderOptions
  ): Promise<ESPNEvent[]> {
    const mapping = ESPN_PATHS[sport];
    if (!mapping) {
      console.error(`[ESPNProvider] Unknown sport: ${sport}`);
      return [];
    }

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

  // -----------------------------------------------------------------------
  // ESPN -> IPTCSportEvent mapper
  // -----------------------------------------------------------------------

  private parseEvent(event: ESPNEvent, sport: string): LiveGameEvent | null {
    const comp = event.competitions?.[0];
    if (!comp) return null;

    const homeComp = comp.competitors.find((c) => c.homeAway === "home");
    const awayComp = comp.competitors.find((c) => c.homeAway === "away");
    if (!homeComp || !awayComp) return null;

    const legacyStatus = this.mapStatus(event.status);
    const iptcStatus = toIPTCStatus(legacyStatus);

    const home: IPTCCompetitor = {
      "@id": `urn:iptc:sport:competitor:${homeComp.team.id}`,
      "@type": "sport:Competitor",
      "sport:name": homeComp.team.displayName,
      "sport:code": homeComp.team.abbreviation,
      "sport:alignment": "home",
      "sport:logo": homeComp.team.logo,
      "spstat:score": parseInt(homeComp.score, 10) || 0,
      "spstat:periodScore": homeComp.linescores?.map((ls) => ls.value),
    };

    const away: IPTCCompetitor = {
      "@id": `urn:iptc:sport:competitor:${awayComp.team.id}`,
      "@type": "sport:Competitor",
      "sport:name": awayComp.team.displayName,
      "sport:code": awayComp.team.abbreviation,
      "sport:alignment": "away",
      "sport:logo": awayComp.team.logo,
      "spstat:score": parseInt(awayComp.score, 10) || 0,
      "spstat:periodScore": awayComp.linescores?.map((ls) => ls.value),
    };

    return {
      "@context": MACHINA_CONTEXT,
      "@id": `urn:iptc:sport:event:${event.id}`,
      "@type": "sport:SportEvent",
      "sport:discipline": toIPTCDiscipline(sport),
      "sport:eventStatus": iptcStatus,
      "sport:statusDetail":
        event.status.type.shortDetail || event.status.type.detail,
      "sport:clock": event.status.displayClock || undefined,
      "sport:competitor": [home, away],
      "sport:venue": comp.venue
        ? {
            "@id": `urn:iptc:sport:venue:${comp.id}`,
            "@type": "sport:Venue",
            "sport:name": comp.venue.fullName,
          }
        : undefined,
      "sport:lastUpdated": new Date().toISOString(),
      // machina: extensions left empty — ESPN provides no AI signals.
      // Downstream agents or enrichment pipelines fill these in.
    };
  }

  /**
   * Map ESPN status to a legacy status label, then IPTC conversion happens upstream.
   */
  private mapStatus(status: ESPNStatus): LegacyGameStatus {
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
}

// ---------------------------------------------------------------------------
// GameMonitor — provider-agnostic polling orchestrator
// ---------------------------------------------------------------------------

const POLL_INTERVAL_LIVE_MS = 30_000; // 30s when games are in progress
const POLL_INTERVAL_PREGAME_MS = 300_000; // 5min when waiting for tip-off

export class GameMonitor {
  private activePollers = new Map<string, NodeJS.Timeout>();
  private previousStates = new Map<string, LiveGameEvent>();
  private providers: ScoreboardProvider[];

  constructor(providers?: ScoreboardProvider[]) {
    this.providers = providers?.length ? providers : [new ESPNProvider()];
  }

  /**
   * Start polling providers for a sport's scoreboard.
   * Broadcasts IPTCSportEventEnvelopes to the relay channel when state changes.
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
        (ids?.length ? ` for games: ${ids.join(", ")}` : " (all games)") +
        ` — providers: ${this.providers.map((p) => p.name).join(", ")}`
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

  /** The providers this monitor is using. */
  getProviders(): ScoreboardProvider[] {
    return [...this.providers];
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  private async poll(sport: string, options?: MonitorOptions): Promise<void> {
    try {
      const allStates = await this.fetchFromProviders(sport, options);

      for (const state of allStates) {
        const gameId = iptcGameId(state);

        // Filter by game IDs if specified
        if (
          options?.gameIds?.length &&
          !options.gameIds.includes(gameId)
        ) {
          continue;
        }

        const previous = this.previousStates.get(gameId);
        const eventType = detectChange(previous, state);

        if (eventType) {
          const home = iptcHome(state);
          const away = iptcAway(state);

          const envelope: LiveGameEnvelope = {
            event: eventType,
            data: state,
            delta: computeDelta(previous, state),
            timestamp: new Date().toISOString(),
          };

          await relayManager.publish("live-games", envelope);

          console.log(
            `[GameMonitor] ${eventType}: ` +
              `${away["sport:code"]} ${away["spstat:score"] ?? 0} @ ` +
              `${home["sport:code"]} ${home["spstat:score"] ?? 0} ` +
              `(${state["sport:statusDetail"]})`
          );
        }

        this.previousStates.set(gameId, state);

        // Auto-stop tracking games that have ended
        if (fromIPTCStatus(state["sport:eventStatus"]) === "final") {
          setTimeout(() => this.previousStates.delete(gameId), 120_000);
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
   * Fetch games from all providers that support the given sport.
   * Deduplicates by gameId (first provider wins).
   */
  private async fetchFromProviders(
    sport: string,
    options?: ScoreboardProviderOptions
  ): Promise<LiveGameEvent[]> {
    const eligible = this.providers.filter((p) =>
      p.supportedSports.includes(sport)
    );

    if (!eligible.length) {
      console.error(
        `[GameMonitor] No provider supports sport: ${sport}. ` +
          `Available: ${this.providers.map((p) => `${p.name} (${p.supportedSports.join(",")})`).join("; ")}`
      );
      return [];
    }

    const results = await Promise.allSettled(
      eligible.map((p) => p.fetchGames(sport, options))
    );

    const seen = new Set<string>();
    const merged: LiveGameEvent[] = [];

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "fulfilled") {
        for (const state of result.value) {
          const gameId = iptcGameId(state);
          if (!seen.has(gameId)) {
            seen.add(gameId);
            merged.push(state);
          }
        }
      } else {
        console.error(
          `[GameMonitor] Provider ${eligible[i].name} failed for ${sport}:`,
          result.reason instanceof Error ? result.reason.message : result.reason
        );
      }
    }

    return merged;
  }

  /**
   * Choose a poll interval based on whether any tracked games are live.
   */
  private bestInterval(sport: string, gameIds?: string[]): number {
    for (const [id, state] of this.previousStates) {
      if (gameIds?.length && !gameIds.includes(id)) continue;
      const sportCode = state["sport:discipline"]["sport:code"];
      const status = fromIPTCStatus(state["sport:eventStatus"]);
      if (sportCode === sport && status === "in_progress") {
        return POLL_INTERVAL_LIVE_MS;
      }
    }
    return POLL_INTERVAL_PREGAME_MS;
  }
}

// ---------------------------------------------------------------------------
// State diffing — operates on IPTCSportEvent
// ---------------------------------------------------------------------------

/**
 * Compare previous and current IPTC state to determine which event type to emit.
 * Returns null if nothing meaningful changed (no event needed).
 */
function detectChange(
  previous: LiveGameEvent | undefined,
  current: LiveGameEvent
): IPTCEventType | null {
  const curStatus = fromIPTCStatus(current["sport:eventStatus"]);

  if (!previous) {
    if (curStatus === "in_progress" || curStatus === "halftime") {
      return "GAME_START";
    }
    if (curStatus === "final") {
      return "GAME_END";
    }
    return "GAME_UPDATE";
  }

  const prevStatus = fromIPTCStatus(previous["sport:eventStatus"]);

  if (
    prevStatus === "scheduled" &&
    (curStatus === "in_progress" || curStatus === "halftime")
  ) {
    return "GAME_START";
  }

  if (prevStatus !== "final" && curStatus === "final") {
    return "GAME_END";
  }

  if (prevStatus !== curStatus) {
    return "STATUS_CHANGE";
  }

  const prevHome = iptcHome(previous);
  const curHome = iptcHome(current);
  const prevAway = iptcAway(previous);
  const curAway = iptcAway(current);

  if (
    (prevHome["spstat:score"] ?? 0) !== (curHome["spstat:score"] ?? 0) ||
    (prevAway["spstat:score"] ?? 0) !== (curAway["spstat:score"] ?? 0)
  ) {
    return "SCORE_CHANGE";
  }

  if (
    curStatus === "in_progress" &&
    previous["sport:statusDetail"] !== current["sport:statusDetail"]
  ) {
    return "GAME_UPDATE";
  }

  return null;
}

/**
 * Compute the delta between previous and current IPTC state.
 */
function computeDelta(
  previous: LiveGameEvent | undefined,
  current: LiveGameEvent
): LiveGameEnvelope["delta"] {
  if (!previous) return undefined;

  const prevHome = iptcHome(previous);
  const curHome = iptcHome(current);
  const prevAway = iptcAway(previous);
  const curAway = iptcAway(current);

  const homeScoreDelta =
    (curHome["spstat:score"] ?? 0) - (prevHome["spstat:score"] ?? 0);
  const awayScoreDelta =
    (curAway["spstat:score"] ?? 0) - (prevAway["spstat:score"] ?? 0);
  const prevStatusURN = previous["sport:eventStatus"];
  const curStatusURN = current["sport:eventStatus"];
  const statusChanged = prevStatusURN !== curStatusURN;

  if (!homeScoreDelta && !awayScoreDelta && !statusChanged) return undefined;

  return {
    ...(homeScoreDelta !== 0 && { homeScoreDelta }),
    ...(awayScoreDelta !== 0 && { awayScoreDelta }),
    ...(statusChanged && { previousStatus: prevStatusURN }),
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
// Default singleton (ESPN-backed)
// ---------------------------------------------------------------------------

export const gameMonitor = new GameMonitor();
