/**
 * sportsclaw — Sports Intelligence Schema
 *
 * Types for the domain-specific sports intelligence layer: Game/Player/Market
 * snapshots, entity resolution, freshness policies, and source provenance.
 */

import type { LiveGameEvent, MarketOdds, EventPrediction, PlayerPropTrend, CoverageInsight } from "../schema/machina.js";

/**
 * SourceProvenance represents the origin, timestamp, and metadata of a data point.
 */
export interface SourceProvenance {
  /** Identifier of the provider (e.g., "espn", "draftkings", "polymarket", "rss:espn") */
  provider: string;
  /** ISO timestamp of when the data was fetched/scraped from the source */
  fetchedAt: string;
  /** Direct source identifier or URL if available */
  sourceId?: string;
  /** Raw quality/confidence signal from the source itself (0–1) */
  sourceConfidence?: number;
}

/**
 * FreshnessPolicy determines if a specific sports intelligence data point is considered fresh or stale.
 */
export interface FreshnessPolicy {
  /** The sport discipline (e.g. "nba", "nfl", "football") */
  sport: string;
  /** The data domain (e.g., "live_scores", "odds", "news", "predictions") */
  domain: "live_scores" | "odds" | "news" | "predictions" | "roster" | "stats";
  /** Maximum age in milliseconds before the data is considered stale */
  maxAgeMs: number;
}

/**
 * Configurable thresholds for standard sports domains in milliseconds
 */
export const DEFAULT_FRESHNESS_THRESHOLDS = {
  live_scores: 10 * 1000,      // 10 seconds for live scoreboards
  odds: 30 * 1000,             // 30 seconds for real-time odds
  news: 60 * 60 * 1000,        // 1 hour for news and insights
  predictions: 10 * 60 * 1000, // 10 minutes for model predictions
  roster: 24 * 60 * 60 * 1000, // 24 hours for rosters/depth charts
  stats: 6 * 60 * 60 * 1000,   // 6 hours for season stats
} as const;

/**
 * Unified Game Intelligence Snapshot
 */
export interface GameIntelligenceSnapshot {
  /** Canonical event ID (e.g. "nba:event:20260520_lal_gsw") */
  id: string;
  /** Sport code (e.g. "nba") */
  sport: string;
  /** Human-readable event title */
  title: string;
  /** Match schedule start time in ISO */
  startTime: string;
  
  /** Current live game event from IPTC/Machina if active/scheduled */
  liveGame?: LiveGameEvent;
  
  /** Consolidated real-time market odds */
  marketOdds?: MarketOdds;
  
  /** Win probability estimate and prediction details from the models */
  prediction?: EventPrediction;
  
  /** Related player prop trends for this specific matchup */
  propTrends?: PlayerPropTrend[];
  
  /** Related coverage insights (injuries, matchup news, previews) */
  coverageInsights?: CoverageInsight[];
  
  /** Map of sources and their timestamps contributing to this snapshot */
  provenance: Record<string, SourceProvenance>;
  
  /** Overall unified confidence score (0–1) */
  confidence: number;
  
  /** Calculated freshness state */
  isFresh: boolean;
  
  /** Timestamps when this snapshot was created and updated */
  createdAt: string;
  updatedAt: string;
}

/**
 * Unified Player Intelligence Snapshot
 */
export interface PlayerIntelligenceSnapshot {
  /** Canonical player ID (e.g. "nba:player:lebron_james") */
  id: string;
  /** Sport code (e.g. "nba") */
  sport: string;
  /** Player's display name */
  name: string;
  /** Current team affiliation */
  team: string;
  
  /** Current status (e.g. "active", "injured", "out", "questionable") */
  status: string;
  /** Active injury detail if any */
  injury?: {
    detail: string;
    affectedGamesCount?: number;
    updatedAt: string;
  };
  
  /** Aggregated recent stat split or profile metrics */
  statsSummary?: {
    gamesPlayed: number;
    pointsPerGame?: number;
    reboundsPerGame?: number;
    assistsPerGame?: number;
    [metric: string]: any;
  };
  
  /** Active prop lines and their corresponding value trends */
  propTrends?: PlayerPropTrend[];
  
  /** Related coverage insights mentioning this player */
  coverageInsights?: CoverageInsight[];
  
  /** Map of sources contributing to player intelligence */
  provenance: Record<string, SourceProvenance>;
  
  /** Overall confidence in player data completeness and health status (0–1) */
  confidence: number;
  
  /** Freshness tracking */
  isFresh: boolean;
  
  createdAt: string;
  updatedAt: string;
}

/**
 * Unified Market Intelligence Snapshot - aggregates sportsbook and prediction pricing
 */
export interface MarketIntelligenceSnapshot {
  /** Unique ID, often the same as the canonical event ID */
  eventId: string;
  sport: string;
  
  /** Traditional sportsbook odds consensus */
  sportsbookOdds?: MarketOdds;
  
  /** Prediction market contracts (e.g., from Polymarket, Kalshi) */
  predictionMarkets?: {
    provider: "polymarket" | "kalshi" | "both";
    markets: Array<{
      tickerOrSlug: string;
      question: string;
      yesPrice: number;
      noPrice: number;
      volume?: number;
      updatedAt: string;
    }>;
  };
  
  /** Cross-market discrepancy or arbitrage signals */
  arbitrageSignal?: {
    hasArbitrage: boolean;
    description?: string;
    calculatedEdge: number;
    recommendedActions?: string[];
  };
  
  /** Consensus implied win probability mapped from both sides */
  consensusImpliedProbability: {
    home: number;
    away: number;
    draw?: number;
  };
  
  /** Map of sources */
  provenance: Record<string, SourceProvenance>;
  
  /** Freshness and confidence */
  confidence: number;
  isFresh: boolean;
  
  createdAt: string;
  updatedAt: string;
}
