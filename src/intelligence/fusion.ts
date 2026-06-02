/**
 * sportsclaw — Sports Intelligence Data Fusion
 *
 * Implements data fusion logic to combine multiple raw data sources
 * (scores, odds, prediction models, trends, news) into consolidated,
 * high-confidence, fresh intelligence snapshots.
 */

import type {
  GameIntelligenceSnapshot,
  PlayerIntelligenceSnapshot,
  MarketIntelligenceSnapshot,
  SourceProvenance,
} from "./types.js";
import { DEFAULT_FRESHNESS_THRESHOLDS } from "./types.js";
import type {
  LiveGameEvent,
  MarketOdds,
  EventPrediction,
  PlayerPropTrend,
  CoverageInsight,
} from "../schema/machina.js";
import { entityResolver } from "./entity-resolver.js";

export class DataFusionEngine {
  private static instance: DataFusionEngine;

  private constructor() {}

  public static getInstance(): DataFusionEngine {
    if (!DataFusionEngine.instance) {
      DataFusionEngine.instance = new DataFusionEngine();
    }
    return DataFusionEngine.instance;
  }

  /**
   * Fuse heterogeneous sources into a high-confidence GameIntelligenceSnapshot.
   */
  public fuseGameSnapshot(params: {
    sport: string;
    gameId: string;
    title?: string;
    startTime?: string;
    liveGame?: LiveGameEvent;
    marketOdds?: MarketOdds;
    prediction?: EventPrediction;
    propTrends?: PlayerPropTrend[];
    coverageInsights?: CoverageInsight[];
  }): GameIntelligenceSnapshot {
    const now = new Date().toISOString();
    const sport = params.sport.toLowerCase();
    
    // Resolve basic identifiers
    const canonicalId = `${sport}:event:${params.gameId}`;
    let fallbackTitle = `Matchup ${params.gameId}`;
    let fallbackStartTime = now;

    if (params.liveGame) {
      try {
        const homeCompetitor = params.liveGame["sport:competitor"][0];
        const awayCompetitor = params.liveGame["sport:competitor"][1];
        if (homeCompetitor && awayCompetitor) {
          fallbackTitle = `${homeCompetitor["sport:name"]} vs ${awayCompetitor["sport:name"]}`;
        }
        if (params.liveGame["sport:startDate"]) {
          fallbackStartTime = params.liveGame["sport:startDate"];
        }
      } catch (e) {
        // Fallback gracefully
      }
    }

    const title = params.title || fallbackTitle;
    const startTime = params.startTime || fallbackStartTime;

    // Compile provenance map
    const provenance: Record<string, SourceProvenance> = {};

    if (params.liveGame) {
      provenance["liveGame"] = {
        provider: params.liveGame["@context"]?.sport || "espn",
        fetchedAt: now,
      };
    }

    if (params.marketOdds) {
      provenance["marketOdds"] = {
        provider: params.marketOdds.source,
        fetchedAt: params.marketOdds.updatedAt,
      };
    }

    if (params.prediction) {
      provenance["prediction"] = {
        provider: params.prediction.model,
        fetchedAt: params.prediction.createdAt,
      };
    }

    // Evaluate freshness
    let isFresh = true;
    const nowMs = Date.now();

    if (params.liveGame) {
      const liveAge = nowMs - Date.now(); // since we fetched it now in this context
      if (liveAge > DEFAULT_FRESHNESS_THRESHOLDS.live_scores) {
        isFresh = false;
      }
    }

    if (params.marketOdds) {
      const oddsAge = nowMs - new Date(params.marketOdds.updatedAt).getTime();
      if (oddsAge > DEFAULT_FRESHNESS_THRESHOLDS.odds) {
        isFresh = false;
      }
    }

    // Compute unified confidence score (0–1)
    let confidenceSum = 0;
    let confidenceCount = 0;

    if (params.liveGame) {
      confidenceSum += 0.95; // live scoreboard is highly accurate
      confidenceCount++;
    }

    if (params.marketOdds) {
      confidenceSum += 0.90; // book odds are highly reliable
      confidenceCount++;
    }

    if (params.prediction) {
      confidenceSum += params.prediction.confidence;
      confidenceCount++;
    }

    if (params.coverageInsights && params.coverageInsights.length > 0) {
      const avgIntelConf = params.coverageInsights.reduce((sum, item) => sum + item.confidence, 0) / params.coverageInsights.length;
      confidenceSum += avgIntelConf;
      confidenceCount++;
    }

    const unifiedConfidence = confidenceCount > 0 ? confidenceSum / confidenceCount : 0.5;

    return {
      id: canonicalId,
      sport,
      title,
      startTime,
      liveGame: params.liveGame,
      marketOdds: params.marketOdds,
      prediction: params.prediction,
      propTrends: params.propTrends || [],
      coverageInsights: params.coverageInsights || [],
      provenance,
      confidence: Math.min(1.0, Math.max(0.0, unifiedConfidence)),
      isFresh,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Fuse raw player profile, stats, props, and news into a PlayerIntelligenceSnapshot.
   */
  public fusePlayerSnapshot(params: {
    sport: string;
    playerName: string;
    team: string;
    status?: string;
    injuryDetail?: string;
    statsSummary?: Record<string, any>;
    propTrends?: PlayerPropTrend[];
    coverageInsights?: CoverageInsight[];
    providerSources?: Record<string, string>;
  }): PlayerIntelligenceSnapshot {
    const now = new Date().toISOString();
    const sport = params.sport.toLowerCase();
    const canonicalPlayerId = `${sport}:player:${entityResolver.slugify(params.playerName)}`;
    const status = params.status || (params.injuryDetail ? "injured" : "active");

    const provenance: Record<string, SourceProvenance> = {};
    if (params.providerSources) {
      for (const [provider, extId] of Object.entries(params.providerSources)) {
        provenance[provider] = {
          provider,
          fetchedAt: now,
          sourceId: extId,
        };
      }
    } else {
      provenance["default"] = {
        provider: "sportsclaw",
        fetchedAt: now,
      };
    }

    // Determine aggregate confidence
    let confidence = 0.7; // baseline
    if (params.statsSummary) confidence += 0.1;
    if (params.propTrends && params.propTrends.length > 0) confidence += 0.1;
    if (params.coverageInsights && params.coverageInsights.length > 0) confidence += 0.05;

    let injuryObj = undefined;
    if (params.injuryDetail) {
      injuryObj = {
        detail: params.injuryDetail,
        updatedAt: now,
      };
    }

    return {
      id: canonicalPlayerId,
      sport,
      name: params.playerName,
      team: params.team,
      status,
      injury: injuryObj,
      statsSummary: params.statsSummary as any,
      propTrends: params.propTrends || [],
      coverageInsights: params.coverageInsights || [],
      provenance,
      confidence: Math.min(1.0, confidence),
      isFresh: true,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Fuse traditional sportsbook consensus and prediction markets into a MarketIntelligenceSnapshot.
   */
  public fuseMarketSnapshot(params: {
    eventId: string;
    sport: string;
    sportsbookOdds?: MarketOdds;
    predictionMarkets?: {
      provider: "polymarket" | "kalshi" | "both";
      markets: Array<{
        tickerOrSlug: string;
        question: string;
        yesPrice: number; // probability between 0 and 1
        noPrice: number;
        volume?: number;
        updatedAt: string;
      }>;
    };
  }): MarketIntelligenceSnapshot {
    const now = new Date().toISOString();
    const sport = params.sport.toLowerCase();
    const eventId = params.eventId;

    // Calculate consensus implied probability
    let homeProb = 0;
    let awayProb = 0;
    let probWeightSum = 0;

    const provenance: Record<string, SourceProvenance> = {};

    // 1. Incorporate sportsbook moneyline odds (convert American to implied)
    if (params.sportsbookOdds) {
      const { home, away } = params.sportsbookOdds.moneyline;
      const homeImplied = this.americanToImpliedProbability(home);
      const awayImplied = this.americanToImpliedProbability(away);
      
      // Normalize to sum to 1.0 (remove sportsbook vig)
      const sum = homeImplied + awayImplied;
      homeProb += (homeImplied / sum) * 1.5; // give 1.5 weight to sportsbook
      awayProb += (awayImplied / sum) * 1.5;
      probWeightSum += 1.5;

      provenance["sportsbook"] = {
        provider: params.sportsbookOdds.source,
        fetchedAt: params.sportsbookOdds.updatedAt,
      };
    }

    // 2. Incorporate prediction markets (where yesPrice is usually direct probability)
    if (params.predictionMarkets && params.predictionMarkets.markets.length > 0) {
      for (const market of params.predictionMarkets.markets) {
        // Find matching win-market (heuristic: check question keywords)
        const lowerQ = market.question.toLowerCase();
        const isWinMarket = lowerQ.includes("win") || lowerQ.includes("defeat") || lowerQ.includes("triumph");
        
        if (isWinMarket) {
          // Identify which team "Yes" corresponds to
          // If Yes represents the home team:
          const isHomeTarget = true; // simplified assumption
          
          if (isHomeTarget) {
            homeProb += market.yesPrice * 1.0;
            awayProb += (1.0 - market.yesPrice) * 1.0;
          } else {
            awayProb += market.yesPrice * 1.0;
            homeProb += (1.0 - market.yesPrice) * 1.0;
          }
          probWeightSum += 1.0;
        }

        provenance[`market:${market.tickerOrSlug}`] = {
          provider: params.predictionMarkets.provider,
          fetchedAt: market.updatedAt,
          sourceId: market.tickerOrSlug,
        };
      }
    }

    // Final normalization
    if (probWeightSum > 0) {
      homeProb = homeProb / probWeightSum;
      awayProb = awayProb / probWeightSum;
      
      const total = homeProb + awayProb;
      homeProb = homeProb / total;
      awayProb = awayProb / total;
    } else {
      homeProb = 0.5;
      awayProb = 0.5;
    }

    // Check for arbitrage opportunities (discrepancy between sportsbook and prediction markets)
    let arbitrageSignal = undefined;
    if (params.sportsbookOdds && params.predictionMarkets && params.predictionMarkets.markets.length > 0) {
      const { home: bookHome } = params.sportsbookOdds.moneyline;
      const bookHomeImplied = this.americanToImpliedProbability(bookHome);
      
      // Look at the first prediction market
      const predMarket = params.predictionMarkets.markets[0];
      const marketHomeProb = predMarket.yesPrice;

      const diff = Math.abs(bookHomeImplied - marketHomeProb);
      if (diff > 0.08) { // >8% discrepancy represents a massive edge/arbitrage opportunity
        arbitrageSignal = {
          hasArbitrage: true,
          calculatedEdge: diff,
          description: `Discrepancy of ${(diff * 100).toFixed(1)}% detected between Sportsbook (${(bookHomeImplied * 100).toFixed(0)}%) and Prediction Market (${(marketHomeProb * 100).toFixed(0)}%) for Home team win.`,
          recommendedActions: [
            bookHomeImplied < marketHomeProb 
              ? `Value found on sportsbook: Back Home team at American odds of ${bookHome}` 
              : `Value found on prediction market: Back Home team (Yes) contract on ${params.predictionMarkets.provider} at price ${predMarket.yesPrice}`
          ],
        };
      }
    }

    return {
      eventId,
      sport,
      sportsbookOdds: params.sportsbookOdds,
      predictionMarkets: params.predictionMarkets,
      arbitrageSignal,
      consensusImpliedProbability: {
        home: Number(homeProb.toFixed(4)),
        away: Number(awayProb.toFixed(4)),
      },
      provenance,
      confidence: params.sportsbookOdds ? 0.90 : 0.70,
      isFresh: true,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Convert American odds format (e.g. -110, +150) to implied probability (0 to 1).
   */
  private americanToImpliedProbability(odds: number): number {
    if (odds > 0) {
      return 100 / (odds + 100);
    } else {
      return Math.abs(odds) / (Math.abs(odds) + 100);
    }
  }
}

export const dataFusion = DataFusionEngine.getInstance();
