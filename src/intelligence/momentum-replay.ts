/**
 * sportsclaw — Momentum Explainer replay runner (finished games)
 *
 * The live runner (momentum-live.ts) can only catch swings while a game is in
 * progress: once it ends, the Kalshi market settles and the price never moves
 * again. This runner replays a FINISHED game end-to-end through the exact same
 * pipeline — real Kalshi price history, real ESPN play-by-play, real generator
 * LLM, real independent evaluator — by reconstructing the tick stream from
 * 1-minute candlesticks and injecting the resulting events into
 * `MomentumExplainer.injectEvent`.
 *
 * Flow:
 *   1. resolve_game_market  — ESPN event → settled Kalshi winner market ticker
 *   2. get_price_history    — 1m candles across the game window
 *   3. candlesToSwings      — consecutive-close moves ≥ threshold (pure)
 *   4. injectEvent per swing — live play resolution (raw ESPN wallclocks),
 *      card generation, and the evaluator gate, unchanged from live mode.
 *
 * Run (after `npm run build`):
 *   node dist/intelligence/momentum-replay.js <sport> <espn_event_id>
 *   # or MOMENTUM_SPORT=mlb MOMENTUM_EVENT_ID=401872178 node dist/intelligence/momentum-replay.js
 *
 * Env overrides:
 *   MOMENTUM_THRESHOLD_CENTS    swing threshold in cents (default 10)
 *   MOMENTUM_MAX_SWINGS         cap on replayed swings (default 5)
 *   SPORTS_SKILLS_SRC           PYTHONPATH for sports_skills (default ../sports-skills/src)
 *   SPORTSCLAW_PROVIDER / SPORTSCLAW_MODEL / SPORTSCLAW_EVALUATOR_MODEL
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executePythonBridge } from "../tools.js";
import { MomentumExplainer } from "./momentum-explainer.js";
import type { LLMProvider, WatchEvent } from "../types.js";

const HERE = dirname(fileURLToPath(import.meta.url)); // dist/intelligence
const REPO_ROOT = resolve(HERE, "..", ".."); // <sportsclaw>

// ---------------------------------------------------------------------------
// Pure pieces (exported for tests)
// ---------------------------------------------------------------------------

/** One {timestamp, price} point from markets.get_price_history (price 0-1). */
export interface PricePoint {
  timestamp: number;
  price: number;
}

/** A replayable price move between consecutive candle closes, in cents. */
export interface ReplaySwing {
  /** Unix seconds of the candle that closed at `after`. */
  timestamp: number;
  before: number;
  after: number;
  delta: number;
}

/**
 * Walk consecutive candle closes and keep moves at/above the threshold, in
 * cents. Both directions are kept — a replay has no looping-timeline artifact,
 * so down-swings are real momentum events.
 */
export function candlesToSwings(
  points: PricePoint[],
  thresholdCents: number,
): ReplaySwing[] {
  const swings: ReplaySwing[] = [];
  for (let i = 1; i < points.length; i++) {
    const before = Math.round(points[i - 1].price * 1000) / 10;
    const after = Math.round(points[i].price * 1000) / 10;
    const delta = Math.round((after - before) * 10) / 10;
    if (Math.abs(delta) < thresholdCents) continue;
    swings.push({ timestamp: points[i].timestamp, before, after, delta });
  }
  return swings;
}

/** Frame data from resolve_game_market that the synthetic ticks carry. */
export interface ReplayFrame {
  sport: string;
  gameId: string;
  teams: Record<string, unknown>;
  kalshiTicker: string;
}

/**
 * Build the WatchEvent a live watcher would have emitted at this swing: the
 * snapshot mirrors get_live_tick's envelope ({status, data}), with the tick
 * timestamp set to the CANDLE's close time so the play window is resolved
 * against the historical instant, not "now".
 */
export function swingToWatchEvent(
  swing: ReplaySwing,
  frame: ReplayFrame,
): WatchEvent {
  const iso = new Date(swing.timestamp * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const clockLabel = `replay @ ${iso.slice(11, 16)}Z`;
  return {
    watcherId: "momentum-replay",
    timestamp: iso,
    sport: "markets",
    command: "get_live_tick",
    changes: [
      {
        path: "data.home_price_cents",
        before: swing.before,
        after: swing.after,
        type: "modified",
      },
    ],
    changesSummary: `home price ${swing.before}c → ${swing.after}c (replay)`,
    snapshot: {
      status: true,
      data: {
        sport: frame.sport,
        game_id: frame.gameId,
        teams: frame.teams,
        timestamp: iso,
        game_clock: clockLabel,
        home_price_cents: swing.after,
        price_source: "kalshi",
        kalshi_ticker: frame.kalshiTicker,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** The macOS cert fix (same as momentum-live): certifi bundle for urllib. */
function certifiPath(pythonPath: string): string | undefined {
  try {
    return execSync(`${pythonPath} -c "import certifi; print(certifi.where())"`, {
      encoding: "utf8",
    }).trim();
  } catch {
    return undefined;
  }
}

/** Unwrap a bridge result's inner sports-skills payload, or throw. */
function bridgeData(
  result: { success: boolean; data?: unknown; error?: string },
  what: string,
): Record<string, unknown> {
  const envelope =
    result.success && result.data && typeof result.data === "object"
      ? (result.data as Record<string, unknown>)
      : null;
  if (!envelope || envelope.status !== true) {
    const msg =
      (envelope && String(envelope.message ?? "")) || result.error || "unknown error";
    throw new Error(`${what} failed: ${msg}`);
  }
  const data = envelope.data;
  if (!data || typeof data !== "object") {
    throw new Error(`${what} returned no data`);
  }
  return data as Record<string, unknown>;
}

async function main(): Promise<void> {
  const sport = (process.env.MOMENTUM_SPORT ?? process.argv[2] ?? "").toLowerCase();
  const eventId = process.env.MOMENTUM_EVENT_ID ?? process.argv[3] ?? "";

  if (!sport || !eventId) {
    console.error(
      "[momentum-replay] usage: node dist/intelligence/momentum-replay.js <sport> <espn_event_id>\n" +
        "  (or set MOMENTUM_SPORT / MOMENTUM_EVENT_ID)",
    );
    process.exit(1);
  }

  const sportsSkillsSrc =
    process.env.SPORTS_SKILLS_SRC ?? resolve(REPO_ROOT, "..", "sports-skills", "src");
  if (!existsSync(sportsSkillsSrc)) {
    console.error(`[momentum-replay] sports-skills src not found: ${sportsSkillsSrc}`);
    process.exit(1);
  }

  const pythonPath = process.env.PYTHON_PATH ?? "python3";
  const thresholdCents = envInt("MOMENTUM_THRESHOLD_CENTS", 10);
  const maxSwings = envInt("MOMENTUM_MAX_SWINGS", 5);
  const provider = (process.env.SPORTSCLAW_PROVIDER as LLMProvider) ?? "anthropic";

  const sslCertFile = certifiPath(pythonPath);
  const env: Record<string, string> = { PYTHONPATH: sportsSkillsSrc };
  if (sslCertFile) env.SSL_CERT_FILE = sslCertFile;
  const bridge = { pythonPath, env };

  console.log(
    `[momentum-replay] game=${sport}:${eventId} threshold=${thresholdCents}c ` +
      `maxSwings=${maxSwings}\n[momentum-replay] SSL_CERT_FILE=${sslCertFile ?? "(unset)"}`,
  );

  // 1. ESPN event → Kalshi winner market (settled markets included).
  const market = bridgeData(
    await executePythonBridge(
      "markets",
      "resolve_game_market",
      { sport, event_id: eventId, status: "any" },
      bridge,
    ),
    "resolve_game_market",
  );
  const kalshiTicker = String(market.kalshi_ticker ?? "");
  const espnStart = String(market.espn_start ?? "");
  console.log(
    `[momentum-replay] market=${kalshiTicker} (${String(market.market_status)}) ` +
      `start=${espnStart} state=${String(market.game_state)}`,
  );

  // 2. 1-minute candles across the game window (start-10min → start+6h).
  const startSec = Math.floor(Date.parse(espnStart) / 1000) - 600;
  const endSec = Math.min(
    Math.floor(Date.now() / 1000),
    startSec + 600 + 6 * 3600,
  );
  const history = bridgeData(
    await executePythonBridge(
      "markets",
      "get_price_history",
      {
        venue: "kalshi",
        ticker: kalshiTicker,
        interval: "1m",
        start_time: startSec,
        end_time: endSec,
      },
      bridge,
    ),
    "get_price_history",
  );
  const points = (Array.isArray(history.points) ? history.points : []) as PricePoint[];
  console.log(`[momentum-replay] ${points.length} price points`);

  // 3. Swings ≥ threshold, capped so a volatile game can't burn the LLM budget.
  const swings = candlesToSwings(points, thresholdCents).slice(0, maxSwings);
  if (swings.length === 0) {
    console.log("[momentum-replay] no swings at/above threshold — nothing to replay.");
    return;
  }
  console.log(
    `[momentum-replay] replaying ${swings.length} swing(s): ` +
      swings.map((s) => `${s.before}→${s.after}c`).join(", "),
  );

  // 4. Same pipeline as live mode; events are injected instead of polled.
  const explainer = new MomentumExplainer({
    provider,
    model: process.env.SPORTSCLAW_MODEL,
    thresholdCents,
    mode: "live",
    direction: "both",
    pythonPath,
    env,
    verbose: true,
    evaluate: process.env.MOMENTUM_EVALUATE !== "0",
    evaluatorModel: process.env.SPORTSCLAW_EVALUATOR_MODEL,
    maxAttempts: envInt("MOMENTUM_MAX_ATTEMPTS", 2),
  });

  const frame: ReplayFrame = {
    sport,
    gameId: eventId,
    teams: (market.teams as Record<string, unknown>) ?? {},
    kalshiTicker,
  };
  for (const swing of swings) {
    await explainer.injectEvent(swingToWatchEvent(swing, frame));
  }

  console.log(
    `[momentum-replay] done — ${explainer.cardsEmitted} card(s) passed, ` +
      `${explainer.cardsRejected} held for review.`,
  );
}

const isDirectRun =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirectRun) {
  main().catch((err) => {
    console.error("[momentum-replay] fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
