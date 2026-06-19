import type { sportsclawConfig } from "../types.js";
import { executePythonBridge, type ToolCallInput, type ToolCallResult } from "../bridge.js";
import { DataFusionEngine, entityResolver } from "../intelligence/index.js";
import type { BuiltinTool } from "./builtin-tool.js";

export const sportsIntelligenceSnapshotTool: BuiltinTool = {
  spec: {
    name: "sports_intelligence_snapshot",
    description: [
      "Generate a consolidated sports intelligence snapshot combining scores, odds, prediction models,",
      "news, and player props. Implements multi-source data fusion and canonical entity resolution.",
      "",
      "Supported targets: game, player, market.",
      "Requires a sport discipline and search query/ID."
    ].join("\n"),
    input_schema: {
      type: "object" as const,
      properties: {
        sport: {
          type: "string",
          description: "The sport discipline (e.g. nfl, nba, mlb, soccer, tennis, f1).",
        },
        target: {
          type: "string",
          enum: ["game", "player", "market"],
          description: "The snapshot target: game, player, or market.",
        },
        query: {
          type: "string",
          description: "The entity query, ID, or name (e.g. 'nba:event:20260520_lal_gsw' or player name 'LeBron James' or team name).",
        },
      },
      required: ["sport", "target", "query"],
    },
  },

  async execute(
    input: ToolCallInput,
    config?: Partial<sportsclawConfig>
  ): Promise<ToolCallResult> {
    const { sport, target, query } = input;
    if (!sport || !target || !query) {
      return {
        content: JSON.stringify({ error: "Missing required parameters: sport, target, and query" }),
        isError: true,
      };
    }

    const fusionEngine = DataFusionEngine.getInstance();

    if (target === "game") {
      let liveGame: any = undefined;
      let gameId = String(query);

      // Try to get scores/matchups to locate this game/event
      const bridgeRes = await executePythonBridge(sport, "scores", {}, config, sport).catch(() => null);
      if (bridgeRes && bridgeRes.success && Array.isArray(bridgeRes.data)) {
        for (const game of bridgeRes.data) {
          try {
            const home = game["sport:competitor"]?.[0]?.["sport:name"] || "";
            const away = game["sport:competitor"]?.[1]?.["sport:name"] || "";
            
            const resolvedQueryId = entityResolver.resolveTeam(sport, String(query));
            const resolvedHomeId = entityResolver.resolveTeam(sport, home);
            const resolvedAwayId = entityResolver.resolveTeam(sport, away);

            const matchesHome = resolvedHomeId === resolvedQueryId || home.toLowerCase().includes(String(query).toLowerCase());
            const matchesAway = resolvedAwayId === resolvedQueryId || away.toLowerCase().includes(String(query).toLowerCase());
            if (matchesHome || matchesAway || String(game["@id"] || "").includes(String(query))) {
              liveGame = game;
              gameId = game["@id"] || game["id"] || gameId;
              break;
            }
          } catch {
            // ignore
          }
        }
      } else if (bridgeRes && bridgeRes.success && bridgeRes.data && typeof bridgeRes.data === "object") {
        liveGame = bridgeRes.data;
        gameId = liveGame["@id"] || liveGame["id"] || gameId;
      }

      // Try fetching odds for the event
      let marketOdds: any = undefined;
      const oddsRes = await executePythonBridge(sport, "odds", { event_id: gameId }, config, sport).catch(() => null);
      if (oddsRes && oddsRes.success) {
        marketOdds = oddsRes.data;
      }

      // Try fetching predictions
      let prediction: any = undefined;
      const predRes = await executePythonBridge(sport, "predictions", { event_id: gameId }, config, sport).catch(() => null);
      if (predRes && predRes.success) {
        prediction = predRes.data;
      }

      const snapshot = fusionEngine.fuseGameSnapshot({
        sport,
        gameId,
        liveGame,
        marketOdds,
        prediction,
      });

      return {
        content: JSON.stringify(snapshot, null, 2),
        isError: false,
      };
    } else if (target === "player") {
      const canonicalPlayerId = entityResolver.resolvePlayer(sport, String(query));

      const playerStatsRes = await executePythonBridge(sport, "player_stats", { player_id: canonicalPlayerId || String(query) }, config, sport).catch(() => null);
      const playerProfileRes = await executePythonBridge(sport, "player_profile", { player_id: canonicalPlayerId || String(query) }, config, sport).catch(() => null);

      let statsSummary: any = undefined;
      let team = "Unknown Team";
      let status = "active";
      let injuryDetail = undefined;

      if (playerStatsRes && playerStatsRes.success) {
        statsSummary = playerStatsRes.data;
      }
      if (playerProfileRes && playerProfileRes.success) {
        const profile: any = playerProfileRes.data;
        if (profile) {
          team = profile.team || team;
          status = profile.status || status;
          injuryDetail = profile.injuryDetail || injuryDetail;
        }
      }

      const snapshot = fusionEngine.fusePlayerSnapshot({
        sport,
        playerName: String(query),
        team,
        status,
        injuryDetail,
        statsSummary,
      });

      return {
        content: JSON.stringify(snapshot, null, 2),
        isError: false,
      };
    } else { // market
      let sportsbookOdds: any = undefined;
      const oddsRes = await executePythonBridge(sport, "odds", { event_id: String(query) }, config).catch(() => null);
      if (oddsRes && oddsRes.success) {
        sportsbookOdds = oddsRes.data;
      }

      const snapshot = fusionEngine.fuseMarketSnapshot({
        eventId: String(query),
        sport,
        sportsbookOdds,
      });

      return {
        content: JSON.stringify(snapshot, null, 2),
        isError: false,
      };
    }
  }
};
