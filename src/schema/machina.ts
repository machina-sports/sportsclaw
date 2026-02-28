/**
 * sportsclaw — Machina Alpha Schema (Proprietary Extensions)
 *
 * Proprietary `machina:` namespace types for AI-powered sports intelligence.
 * Extends the pure IPTC Sport Schema with trading signals, market odds,
 * coverage insights, player prop trends, and event predictions.
 *
 * Channel payload types for the segregated relay pub/sub architecture:
 *
 *   Channel        Cadence   Payload
 *   ─────────────  ────────  ──────────────────────────────────
 *   live-games     fast      LiveGameEnvelope (enriched IPTC events)
 *   odds           fast      MarketOdds (real-time market pricing)
 *   predictions    medium    PredictionPayload (model outputs)
 *   intel          slow      CoverageInsight (editorial analysis)
 *
 * @see ./iptc.ts for the base IPTC Sport Schema
 */

import type {
  IPTCContext,
  IPTCSportEvent,
  IPTCEventType,
  IPTCEventStatus,
} from "./iptc.js";
import { IPTC_CONTEXT } from "./iptc.js";

// ---------------------------------------------------------------------------
// Machina JSON-LD context — extends IPTC with proprietary namespace
// ---------------------------------------------------------------------------

export const MACHINA_NS = "https://machina.sports/ns/" as const;

export interface MachinaContext extends IPTCContext {
  machina: typeof MACHINA_NS;
}

export const MACHINA_CONTEXT: MachinaContext = {
  ...IPTC_CONTEXT,
  machina: MACHINA_NS,
};

// ---------------------------------------------------------------------------
// Core Machina signal types
// ---------------------------------------------------------------------------

/** Win probability estimates from a Machina model */
export interface MachinaWinProbability {
  /** Home team win probability (0–1) */
  home: number;
  /** Away team win probability (0–1) */
  away: number;
  /** Draw probability (0–1), relevant for soccer */
  draw?: number;
  /** Model identifier that produced the estimate */
  model?: string;
  /** ISO timestamp of the estimate */
  updatedAt: string;
}

/** Edge vs. market consensus pricing */
export interface MachinaMarketEdge {
  /** Positive = home team is undervalued by the market */
  homeEdge: number;
  /** Positive = away team is undervalued by the market */
  awayEdge: number;
  /** Confidence in the edge estimate (0–1) */
  confidence: number;
  /** Data source or model that produced the edge */
  source?: string;
}

/** Actionable signal emitted by a Machina agent */
export interface MachinaAgentSignal {
  type: "BUY" | "SELL" | "HOLD" | "ALERT";
  /** What the signal targets (e.g. "home_ml", "over_215.5") */
  target: string;
  /** Signal strength (0–1) */
  strength: number;
  /** Human-readable reasoning */
  reasoning?: string;
  /** ISO timestamp after which the signal expires */
  expiresAt?: string;
}

// ---------------------------------------------------------------------------
// live-games channel — fast cadence
// IPTCSportEvent enriched with light win probability
// ---------------------------------------------------------------------------

/**
 * An IPTC sport event augmented with the Machina context and lightweight
 * win probability enrichment. This is the data type carried on the
 * fast-cadence `live-games` channel.
 */
export interface LiveGameEvent extends IPTCSportEvent {
  "@context": MachinaContext;
  /** Live win probability (lightweight enrichment from Machina models) */
  "machina:winProbability"?: MachinaWinProbability;
  /** End-to-end pipeline latency in milliseconds */
  "machina:latencyMs"?: number;
}

/**
 * Transport envelope for the `live-games` relay channel.
 * Wraps a LiveGameEvent with event type, delta, and timestamp metadata.
 */
export interface LiveGameEnvelope {
  event: IPTCEventType;
  data: LiveGameEvent;
  /** What changed from the previous state (for presenters to highlight) */
  delta?: {
    homeScoreDelta?: number;
    awayScoreDelta?: number;
    previousStatus?: IPTCEventStatus;
  };
  /** ISO timestamp of emission */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// odds channel — fast cadence
// Market odds matching Sportingbot structure
// ---------------------------------------------------------------------------

/** A single odds line (spread or total) */
export interface OddsLine {
  /** The line value (e.g. -3.5 for spread, 215.5 for total) */
  line: number;
  /** American odds (e.g. -110, +150) */
  odds: number;
}

/**
 * Real-time market odds for a game. Matches the Sportingbot structure
 * for interoperability with the Machina Sports odds pipeline.
 */
export interface MarketOdds {
  "@type": "machina:MarketOdds";
  /** IPTC game identifier (last segment of urn:iptc:sport:event:*) */
  gameId: string;
  /** Sport code (e.g. "nba", "nfl") */
  sport: string;
  /** Moneyline odds (American format) */
  moneyline: {
    home: number;
    away: number;
    draw?: number;
  };
  /** Point spread */
  spread?: {
    home: OddsLine;
    away: OddsLine;
  };
  /** Game total (over/under) */
  total?: {
    over: OddsLine;
    under: OddsLine;
  };
  /** Data source identifier (e.g. "draftkings", "fanduel") */
  source: string;
  /** Sportsbook name */
  book?: string;
  /** ISO timestamp of the odds snapshot */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// predictions channel — medium cadence
// ---------------------------------------------------------------------------

/**
 * Full event prediction from a Machina model — includes win probability,
 * predicted score, market edge analysis, and optional agent signals.
 */
export interface EventPrediction {
  "@type": "machina:EventPrediction";
  /** IPTC game identifier */
  gameId: string;
  /** Sport code */
  sport: string;
  /** Model that produced the prediction */
  model: string;
  /** Win probability breakdown */
  winProbability: MachinaWinProbability;
  /** Predicted final score */
  predictedScore?: {
    home: number;
    away: number;
  };
  /** Edge vs. market consensus */
  edge?: MachinaMarketEdge;
  /** Derived trading signal */
  signal?: MachinaAgentSignal;
  /** Overall prediction confidence (0–1) */
  confidence: number;
  /** Human-readable reasoning */
  reasoning?: string;
  /** ISO timestamp of prediction creation */
  createdAt: string;
}

/**
 * Player prop trend analysis — tracks a specific prop market
 * against historical hit rates and identifies value edges.
 */
export interface PlayerPropTrend {
  "@type": "machina:PlayerPropTrend";
  /** IPTC game identifier */
  gameId: string;
  /** Sport code */
  sport: string;
  /** Player identifier */
  playerId: string;
  /** Player display name */
  playerName: string;
  /** Prop type (e.g. "points", "rebounds", "passing_yards") */
  prop: string;
  /** Current prop line */
  line: number;
  /** Trend direction based on historical data */
  trend: "over" | "under" | "push";
  /** Historical hit rate (0–1) */
  hitRate: number;
  /** Number of games in the sample */
  sampleSize: number;
  /** Edge vs. implied probability (positive = value bet) */
  edge?: number;
  /** ISO timestamp */
  updatedAt: string;
}

/** Discriminated union for the predictions channel */
export type PredictionPayload = EventPrediction | PlayerPropTrend;

// ---------------------------------------------------------------------------
// intel channel — slow cadence
// ---------------------------------------------------------------------------

/**
 * Coverage insight — editorial-quality analysis from Machina agents.
 * Slow cadence, high-value content for downstream consumption
 * by presenters, newsletters, or advisory dashboards.
 */
export interface CoverageInsight {
  "@type": "machina:CoverageInsight";
  /** IPTC game identifier */
  gameId: string;
  /** Sport code */
  sport: string;
  /** Short headline */
  headline: string;
  /** Full analysis body (markdown supported) */
  body: string;
  /** Analysis confidence (0–1) */
  confidence: number;
  /** Topic tags for filtering (e.g. ["injury", "matchup", "trend"]) */
  tags: string[];
  /** Source agent or model identifier */
  source: string;
  /** ISO timestamp of creation */
  createdAt: string;
}
