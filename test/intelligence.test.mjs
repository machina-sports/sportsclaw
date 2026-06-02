/**
 * Sports Intelligence Layer — test suite
 *
 * Tests for the EntityResolver, DataFusionEngine, and unified snapshots.
 * Modeled on the project's native node:test + assert style.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { entityResolver } from "../dist/intelligence/entity-resolver.js";
import { dataFusion } from "../dist/intelligence/fusion.js";

// ---------------------------------------------------------------------------
// EntityResolver Tests
// ---------------------------------------------------------------------------

describe("EntityResolver", () => {
  it("resolves exact registered team names and abbreviations", () => {
    assert.strictEqual(entityResolver.resolveTeam("nba", "Lakers"), "nba:team:lal");
    assert.strictEqual(entityResolver.resolveTeam("nba", "LAL"), "nba:team:lal");
    assert.strictEqual(entityResolver.resolveTeam("nfl", "49ers"), "nfl:team:sf");
    assert.strictEqual(entityResolver.resolveTeam("football", "Real Madrid"), "football:team:rma");
  });

  it("handles fuzzy matching of team names and abbreviations with high accuracy", () => {
    // "Golden State" should resolve to GSW
    assert.strictEqual(entityResolver.resolveTeam("nba", "Golden State"), "nba:team:gsw");
    // "Madrid" should resolve to Real Madrid
    assert.strictEqual(entityResolver.resolveTeam("football", "Madrid"), "football:team:rma");
  });

  it("dynamically registers and resolves new sports teams", () => {
    entityResolver.register("f1", "team", {
      canonicalId: "f1:team:ferrari",
      aliases: ["scuderia ferrari", "ferrari f1", "marlboro ferrari"],
      providerIds: { fastf1: "ferrari", espn: "f1:ferrari" },
    });

    assert.strictEqual(entityResolver.resolveTeam("f1", "scuderia ferrari"), "f1:team:ferrari");
    assert.strictEqual(entityResolver.mapToProviderId("f1", "team", "f1:team:ferrari", "fastf1"), "ferrari");
  });

  it("resolves players with fuzzy name matches", () => {
    entityResolver.register("nba", "player", {
      canonicalId: "nba:player:lebron_james",
      aliases: ["lebron james", "king james", "lebron"],
    });

    assert.strictEqual(entityResolver.resolvePlayer("nba", "LeBron"), "nba:player:lebron_james");
    assert.strictEqual(entityResolver.resolvePlayer("nba", "King James"), "nba:player:lebron_james");
    assert.strictEqual(entityResolver.resolvePlayer("nba", "Lebron J."), "nba:player:lebron_james");
  });
});

// ---------------------------------------------------------------------------
// DataFusionEngine Tests
// ---------------------------------------------------------------------------

describe("DataFusionEngine", () => {
  describe("fuseGameSnapshot", () => {
    it("creates a complete GameIntelligenceSnapshot with correct metrics", () => {
      const liveGame = {
        "@id": "urn:iptc:sport:event:20260520_lal_gsw",
        "@type": "sport:SportEvent",
        "@context": {
          "@vocab": "http://iptc.org/std/nar/2006-10-01/",
          sport: "http://cv.iptc.org/newscodes/sport/",
          spstat: "http://cv.iptc.org/newscodes/spstattype/",
          machina: "https://machina.sports/ns/",
        },
        "sport:name": "Lakers vs Warriors",
      };

      const marketOdds = {
        "@type": "machina:MarketOdds",
        gameId: "20260520_lal_gsw",
        sport: "nba",
        moneyline: { home: -110, away: -110 },
        source: "draftkings",
        updatedAt: new Date().toISOString(),
      };

      const prediction = {
        "@type": "machina:EventPrediction",
        gameId: "20260520_lal_gsw",
        sport: "nba",
        model: "machina-alpha-v1",
        winProbability: { home: 0.55, away: 0.45, updatedAt: new Date().toISOString() },
        confidence: 0.85,
        createdAt: new Date().toISOString(),
      };

      const snapshot = dataFusion.fuseGameSnapshot({
        sport: "nba",
        gameId: "20260520_lal_gsw",
        title: "Lakers at Warriors",
        liveGame,
        marketOdds,
        prediction,
      });

      assert.strictEqual(snapshot.id, "nba:event:20260520_lal_gsw");
      assert.strictEqual(snapshot.title, "Lakers at Warriors");
      assert.strictEqual(snapshot.isFresh, true);
      assert.ok(snapshot.confidence > 0.8);
      assert.ok(snapshot.provenance.liveGame);
      assert.ok(snapshot.provenance.marketOdds);
      assert.ok(snapshot.provenance.prediction);
    });

    it("handles partial data inputs gracefully with solid defaults", () => {
      const snapshot = dataFusion.fuseGameSnapshot({
        sport: "nfl",
        gameId: "superbowl_2027",
      });

      assert.strictEqual(snapshot.id, "nfl:event:superbowl_2027");
      assert.strictEqual(snapshot.title, "Matchup superbowl_2027");
      assert.strictEqual(snapshot.confidence, 0.5); // baseline default confidence
      assert.deepStrictEqual(snapshot.propTrends, []);
      assert.deepStrictEqual(snapshot.coverageInsights, []);
    });
  });

  describe("fusePlayerSnapshot", () => {
    it("creates a valid PlayerIntelligenceSnapshot", () => {
      const snapshot = dataFusion.fusePlayerSnapshot({
        sport: "nba",
        playerName: "LeBron James",
        team: "Lakers",
        injuryDetail: "Ankle soreness (Day-to-day)",
        statsSummary: { gamesPlayed: 65, pointsPerGame: 25.4 },
      });

      assert.strictEqual(snapshot.id, "nba:player:lebron_james");
      assert.strictEqual(snapshot.team, "Lakers");
      assert.strictEqual(snapshot.status, "injured");
      assert.strictEqual(snapshot.injury?.detail, "Ankle soreness (Day-to-day)");
      assert.strictEqual(snapshot.statsSummary?.pointsPerGame, 25.4);
    });
  });

  describe("fuseMarketSnapshot", () => {
    it("correctly converts American odds and computes consensus implied probability", () => {
      const marketOdds = {
        "@type": "machina:MarketOdds",
        gameId: "test_game",
        sport: "nba",
        moneyline: { home: -150, away: +130 },
        source: "fanduel",
        updatedAt: new Date().toISOString(),
      };

      const snapshot = dataFusion.fuseMarketSnapshot({
        eventId: "test_game",
        sport: "nba",
        sportsbookOdds: marketOdds,
      });

      // home -150 corresponds to 60% implied probability
      // away +130 corresponds to 43.48% implied probability
      // Normalized: 60 / 103.48 = 57.98%, 43.48 / 103.48 = 42.02%
      assert.strictEqual(snapshot.consensusImpliedProbability.home, 0.5798);
      assert.strictEqual(snapshot.consensusImpliedProbability.away, 0.4202);
    });

    it("triggers arbitrage/discrepancy alert on massive price mismatch", () => {
      const sportsbookOdds = {
        "@type": "machina:MarketOdds",
        gameId: "arbitrage_game",
        sport: "nfl",
        moneyline: { home: -200, away: +170 }, // home book implied is 66.7%
        source: "draftkings",
        updatedAt: new Date().toISOString(),
      };

      const predictionMarkets = {
        provider: "polymarket",
        markets: [
          {
            tickerOrSlug: "home-win-contract",
            question: "Will the Home team win?",
            yesPrice: 0.52, // massive mismatch (66.7% vs 52%)
            noPrice: 0.48,
            updatedAt: new Date().toISOString(),
          },
        ],
      };

      const snapshot = dataFusion.fuseMarketSnapshot({
        eventId: "arbitrage_game",
        sport: "nfl",
        sportsbookOdds,
        predictionMarkets,
      });

      assert.strictEqual(snapshot.arbitrageSignal?.hasArbitrage, true);
      assert.ok(snapshot.arbitrageSignal.calculatedEdge > 0.1);
      assert.ok(snapshot.arbitrageSignal.description.includes("Discrepancy"));
    });
  });
});
