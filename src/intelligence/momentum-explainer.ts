/**
 * sportsclaw — Momentum & Price Explainer (Phase 3)
 *
 * Closes the loop-engineering exercise scoped by André Antonelli: when a
 * prediction-market price jumps sharply mid-game, detect it, find the play
 * that caused it, and have an LLM write a one-sentence "Momentum Explainer"
 * card.
 *
 * Architecture (all in one process, no external broker):
 *
 *   WatchManager (real subsystem)          MomentumExplainer (this file)
 *   ┌──────────────────────────┐           ┌──────────────────────────────┐
 *   │ poll get_mock_tick (5s)  │  onEvent  │ detectSwings(>10c)           │
 *   │ structuralDiff snapshots │ ────────► │  → resolvePlays(mock|live)   │
 *   │ emit WatchEvent          │  (local   │  → generateCard (REAL LLM)   │
 *   └──────────────────────────┘  callback)│  → print card                │
 *                                           └──────────────────────────────┘
 *
 * Two deliberate seams keep Phase 4 (live data) a clean swap:
 *   1. Transport — the watcher's new in-process "callback" output sink drives
 *      this listener without Relaycast. Phase 4 can move to the hosted relay
 *      channel by flipping the watcher's `output` back to "relay".
 *   2. Data source — `resolvePlays()` reads the tick's *embedded* play-by-play
 *      in "mock" mode (the mock game_id isn't a real ESPN event) and calls the
 *      live `get_plays_near_timestamp` bridge in "live" mode. Both branches
 *      return the SAME NormalizedPlay[] shape, so the generator is untouched.
 *
 * IMPORTANT: mock shortcuts the *source*, never the reasoning. `generateCard`
 * is a real LLM call in both modes — Phase 3 actually proves the loop.
 */

import { WatchManager } from "../watch.js";
import { executePythonBridge } from "../tools.js";
import { resolveModel, resolveAuthForModel } from "../llm-providers.js";
import { resolveAnthropicAuth } from "../credentials.js";
import {
  createAnthropicOAuthProvider,
  loadClaudeCodeTokens,
} from "../anthropic-oauth.js";
import { generateText } from "ai";
import type {
  WatchEvent,
  WatchChange,
  WatcherConfig,
  LLMProvider,
} from "../types.js";
import { DEFAULT_MODELS } from "../types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type ExplainerMode = "mock" | "live";

/** Which price moves fire a card. See `MomentumExplainerOptions.direction`. */
export type SwingDirection = "up" | "both";

/**
 * Default card-generator model, per provider. Deliberately explicit (not a
 * silent inherit) so the choice is auditable: these mirror the repo's
 * PROVIDER_MODEL_PROFILES defaults (types.ts), and the anthropic default
 * `claude-opus-4-6` was verified live to return 200 over the Claude Code
 * OAuth path (2026-07-03). Override per-run via the `model` option or
 * SPORTSCLAW_MODEL.
 */
export const DEFAULT_EXPLAINER_MODELS: Record<LLMProvider, string> = DEFAULT_MODELS;

export interface MomentumExplainerOptions {
  /** LLM provider for the card generator (default: anthropic). */
  provider?: LLMProvider;
  /** Model id (default: provider default, e.g. claude-opus-4-6). */
  model?: string;
  /**
   * Minimum absolute price move (in cents) that fires a card. Prices are
   * implied win-probability in cents, so 10 cents == a 10 percentage-point
   * swing. Default: 10 (i.e. the ">10%" detector).
   */
  thresholdCents?: number;
  /** "mock" reads embedded plays; "live" calls get_plays_near_timestamp. */
  mode?: ExplainerMode;
  /**
   * Which swings fire a card:
   *   - "up"   (default): only home-price *increases* — the demo's mock
   *     timeline loops (68→42 on wrap), and that down-swing would spuriously
   *     attribute the drop to the prior tick's play. Upswings-only keeps the
   *     demo clean.
   *   - "both": also fire on down-swings. These ARE real momentum events for
   *     live data, so the path is deliberate — flip this on for Phase 4.
   */
  direction?: SwingDirection;
  /** Python interpreter for the watcher + live bridge (default: python3). */
  pythonPath?: string;
  /** Extra env for subprocesses (e.g. PYTHONPATH=<sports-skills>/src). */
  env?: Record<string, string>;
  /** Sink for finished cards. Default: pretty-print to stdout. */
  onCard?: (card: MomentumCard) => void;
  /** Verbose diagnostics (ticks seen, sub-threshold moves). Default: false. */
  verbose?: boolean;
}

/** A single field-level price move that cleared the threshold. */
export interface PriceSwing {
  path: string;
  before: number;
  after: number;
  /** after - before, in cents (== probability points). */
  delta: number;
}

/** Play shape handed to the generator — identical across mock + live sources. */
export interface NormalizedPlay {
  id: string;
  sequence: string;
  wallclock: string;
  text: string;
  type: string;
  period: string;
  gameClock: string;
  homeScore: number | string;
  awayScore: number | string;
  scoring: boolean;
  teamId: string;
}

export interface MomentumCard {
  /** The one-sentence explainer (the deliverable). */
  text: string;
  swing: PriceSwing;
  causePlay: NormalizedPlay | null;
  /** Where the play came from — proves the mock/live seam. */
  source: "mock-snapshot" | "espn-live";
  gameLabel: string;
  gameClock: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Detector — >10% swing on polymarket_home_price_cents
// ---------------------------------------------------------------------------

const PRICE_PATH_SUFFIX = "polymarket_home_price_cents";

/**
 * Scan a WatchEvent's structural changes for home-price moves at/above the
 * threshold. `endsWith` (not `===`) so it matches the bridge-wrapped path
 * `data.polymarket_home_price_cents` regardless of envelope nesting.
 *
 * `direction` gates the sign: "up" (default) keeps only increases; "both"
 * also emits down-swings (deliberate — real for live data, off for the mock
 * demo whose looping timeline would emit a spurious wrap-around card).
 */
export function detectSwings(
  changes: WatchChange[],
  thresholdCents: number,
  direction: SwingDirection = "up",
): PriceSwing[] {
  const swings: PriceSwing[] = [];
  for (const c of changes) {
    if (!c.path.endsWith(PRICE_PATH_SUFFIX)) continue;
    const before = Number(c.before);
    const after = Number(c.after);
    if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
    const delta = after - before;
    if (Math.abs(delta) < thresholdCents) continue;
    // Upswings-only unless explicitly opted into down-swings.
    if (direction === "up" && delta < 0) continue;
    swings.push({ path: c.path, before, after, delta });
  }
  return swings;
}

// ---------------------------------------------------------------------------
// Play normalization — one shape from two source shapes
// ---------------------------------------------------------------------------

/**
 * Normalize a play into NormalizedPlay, defensively handling BOTH shapes:
 *   - Raw ESPN summary play (mock embedded): `type.text`, `period.displayValue`,
 *     `clock.displayValue`, `homeScore`, `scoringPlay`, `team.id`.
 *   - Flat `_extract_play` play (live get_plays_near_timestamp): `type`,
 *     `period`, `game_clock`, `home_score`, `scoring_play`, `team_id`.
 */
function normalizePlay(p: Record<string, unknown>): NormalizedPlay {
  const asObj = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const type = asObj(p.type);
  const period = asObj(p.period);
  const clock = asObj(p.clock);
  const team = asObj(p.team);
  const str = (v: unknown, fallback = ""): string =>
    v === undefined || v === null ? fallback : String(v);

  return {
    id: str(p.id),
    sequence: str(p.sequence ?? p.sequenceNumber),
    wallclock: str(p.wallclock),
    text: str(p.text),
    // Raw shape puts the label under type.text; flat shape has type as a string.
    type: str(typeof p.type === "string" ? p.type : type.text),
    period: str(typeof p.period === "string" ? p.period : period.displayValue),
    gameClock: str(p.game_clock ?? clock.displayValue),
    homeScore: (p.home_score ?? p.homeScore ?? "") as number | string,
    awayScore: (p.away_score ?? p.awayScore ?? "") as number | string,
    scoring: Boolean(p.scoring_play ?? p.scoringPlay ?? false),
    teamId: str(p.team_id ?? team.id),
  };
}

/**
 * Pick the play most likely responsible for the move: the last scoring play
 * if any (a TD/FG/INT is what moves a market), else the most recent play.
 */
function pickCause(plays: NormalizedPlay[]): NormalizedPlay | null {
  if (plays.length === 0) return null;
  for (let i = plays.length - 1; i >= 0; i--) {
    if (plays[i].scoring) return plays[i];
  }
  return plays[plays.length - 1];
}

// ---------------------------------------------------------------------------
// Data source — mock (embedded) vs live (bridge). Same return shape.
// ---------------------------------------------------------------------------

interface ResolvedPlays {
  plays: NormalizedPlay[];
  causePlay: NormalizedPlay | null;
  source: "mock-snapshot" | "espn-live";
}

/** The `data` block inside a bridge snapshot (`{status,data,message}`). */
function snapshotData(event: WatchEvent): Record<string, unknown> {
  const snap = event.snapshot;
  const data = snap && typeof snap === "object"
    ? (snap as Record<string, unknown>).data
    : undefined;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

async function resolvePlays(
  event: WatchEvent,
  mode: ExplainerMode,
  bridge: { pythonPath: string; env?: Record<string, string> },
): Promise<ResolvedPlays> {
  const data = snapshotData(event);

  if (mode === "mock") {
    // Source shortcut: the tick already carries the in-window plays. No ESPN
    // call — the mock game_id isn't a real event.
    const raw = Array.isArray(data.play_by_play) ? data.play_by_play : [];
    const plays = raw.map((p) => normalizePlay(p as Record<string, unknown>));
    return { plays, causePlay: pickCause(plays), source: "mock-snapshot" };
  }

  // ---- Phase 4 live swap (same shape out) --------------------------------
  const result = await executePythonBridge(
    "markets",
    "get_plays_near_timestamp",
    {
      sport: data.sport,
      game_id: data.game_id,
      timestamp: data.timestamp,
      window_seconds: 120,
    },
    { pythonPath: bridge.pythonPath, env: bridge.env },
  );
  const inner = result.success && result.data && typeof result.data === "object"
    ? ((result.data as Record<string, unknown>).data as Record<string, unknown> | undefined)
    : undefined;
  const rawLive = inner && Array.isArray(inner.plays) ? inner.plays : [];
  const plays = rawLive.map((p) => normalizePlay(p as Record<string, unknown>));
  return { plays, causePlay: pickCause(plays), source: "espn-live" };
}

// ---------------------------------------------------------------------------
// Generator — REAL LLM call, both modes
// ---------------------------------------------------------------------------

/**
 * Resolve a language model for the card generator. Auth precedence for
 * anthropic (highest first):
 *   1. ANTHROPIC_API_KEY / keychain API key  (resolveAnthropicAuth → api_key)
 *   2. Claude Code OAuth tokens (config-opted-in, via resolveAnthropicAuth)
 *   3. Ambient Claude Code OAuth tokens (keychain/file), so the demo runs
 *      self-contained without a separate `sportsclaw login`.
 *
 * If NONE of those are present we throw loudly here (at construction) rather
 * than returning a model that fails cryptically on the first call — the
 * generator must not silently assume auth it doesn't have. The OAuth provider
 * auto-injects the required Claude Code system prefix.
 */
function resolveExplainerModel(provider: LLMProvider, modelId: string) {
  if (provider === "anthropic") {
    const auth = resolveAnthropicAuth();
    if (auth?.kind === "api_key") {
      return resolveModel("anthropic", modelId);
    }
    if (auth?.kind === "oauth_claude_code") {
      return createAnthropicOAuthProvider({
        tokens: auth.tokens,
        source: auth.tokenSource,
      })(modelId);
    }
    const loaded = loadClaudeCodeTokens();
    if (loaded) {
      return createAnthropicOAuthProvider({
        tokens: loaded.tokens,
        source: loaded.source,
      })(modelId);
    }
    throw new Error(
      "Momentum Explainer: no Anthropic credentials found — the card generator " +
        "cannot run. Provide ONE of:\n" +
        "  • ANTHROPIC_API_KEY in the environment, or\n" +
        "  • an API key saved via `sportsclaw login`, or\n" +
        "  • Claude Code OAuth (sign in to Claude Code so its keychain/`.credentials.json` tokens exist).\n" +
        'Alternatively pass provider "openai"/"google" with that provider\'s key set.',
    );
  }
  // Non-anthropic: the AI SDK reads the provider's own env key; resolveModel
  // throws for an unknown provider. (A missing key surfaces at first call.)
  return resolveModel(provider, modelId, undefined, resolveAuthForModel());
}

function teamAbbrs(data: Record<string, unknown>): { home: string; away: string } {
  const teams = data.teams && typeof data.teams === "object"
    ? (data.teams as Record<string, unknown>)
    : {};
  const side = (v: unknown, fallback: string): string => {
    const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    return String(o.abbrev ?? o.name ?? fallback);
  };
  return { home: side(teams.home, "HOME"), away: side(teams.away, "AWAY") };
}

async function generateCard(
  model: unknown,
  event: WatchEvent,
  swing: PriceSwing,
  resolved: ResolvedPlays,
): Promise<MomentumCard> {
  const data = snapshotData(event);
  const { home, away } = teamAbbrs(data);
  const gameClock = String(data.game_clock ?? "");
  const play = resolved.causePlay;
  const dir = swing.delta > 0 ? "up" : "down";
  const pts = Math.abs(swing.delta);

  const system = [
    "You are a live sports betting-market analyst writing a 'Momentum Explainer' card.",
    "Write exactly ONE sentence (max 30 words) explaining why the home team's",
    "win-probability price just moved, attributing it to the given play.",
    "No preamble, no quotes, no markdown — output only the sentence.",
  ].join("\n");

  const prompt = [
    `Matchup: ${away} @ ${home} (${gameClock}).`,
    `Home (${home}) win-probability price moved ${swing.before}c → ${swing.after}c ` +
      `(${dir} ${pts} points).`,
    play
      ? `Most likely cause play: "${play.text}" [${play.type}], ` +
        `score now home ${play.homeScore}–${play.awayScore} away.`
      : "No play detail available — explain the move generically.",
    "Write the one-sentence Momentum Explainer now.",
  ].join("\n");

  const result = await generateText({
    model: model as Parameters<typeof generateText>[0]["model"],
    system,
    prompt,
    maxOutputTokens: 120,
  });

  return {
    text: result.text.trim(),
    swing,
    causePlay: play,
    source: resolved.source,
    gameLabel: `${away} @ ${home}`,
    gameClock,
    timestamp: event.timestamp,
  };
}

// ---------------------------------------------------------------------------
// Pretty printer (default card sink)
// ---------------------------------------------------------------------------

export function printCard(card: MomentumCard): void {
  const arrow = card.swing.delta > 0 ? "▲" : "▼";
  const pts = Math.abs(card.swing.delta);
  const lines = [
    "",
    "┏━━ 📈 MOMENTUM EXPLAINER ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `┃ ${card.gameLabel}  ·  ${card.gameClock}`,
    `┃ Home win-prob ${arrow} ${card.swing.before}c → ${card.swing.after}c  (${arrow}${pts} pts)`,
    card.causePlay ? `┃ Play: ${card.causePlay.text}` : "┃ Play: (none)",
    `┃ Source: ${card.source}`,
    "┃",
    `┃ 💬 ${card.text}`,
    "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
  ];
  console.log(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// MomentumExplainer — orchestrates the real WatchManager + the loop
// ---------------------------------------------------------------------------

export class MomentumExplainer {
  private readonly manager = new WatchManager();
  private readonly model: unknown;
  private readonly provider: LLMProvider;
  private readonly modelId: string;
  private readonly thresholdCents: number;
  private readonly mode: ExplainerMode;
  private readonly direction: SwingDirection;
  private readonly pythonPath: string;
  private readonly env?: Record<string, string>;
  private readonly onCard: (card: MomentumCard) => void;
  private readonly verbose: boolean;
  private cardCount = 0;

  constructor(opts: MomentumExplainerOptions = {}) {
    this.provider = opts.provider ?? "anthropic";
    this.modelId = opts.model ?? DEFAULT_EXPLAINER_MODELS[this.provider];
    this.thresholdCents = opts.thresholdCents ?? 10;
    this.mode = opts.mode ?? "mock";
    this.direction = opts.direction ?? "up";
    this.pythonPath = opts.pythonPath ?? "python3";
    this.env = opts.env;
    this.onCard = opts.onCard ?? printCard;
    this.verbose = opts.verbose ?? false;
    this.model = resolveExplainerModel(this.provider, this.modelId);
  }

  /** Cards emitted so far (useful for time-boxed demo runs). */
  get cardsEmitted(): number {
    return this.cardCount;
  }

  /**
   * Start listening. Takes a watcher config for the price feed; the output
   * sink is forced to the in-process callback regardless of what's passed.
   */
  start(watcher: Omit<WatcherConfig, "output" | "onEvent">): string {
    console.log(
      `[momentum] listening — provider=${this.provider} model=${this.modelId} ` +
        `mode=${this.mode} threshold=${this.thresholdCents}c direction=${this.direction}`,
    );
    return this.manager.addWatcher(
      {
        ...watcher,
        output: "callback",
        onEvent: (event) => this.handleEvent(event),
      },
      { pythonPath: this.pythonPath, env: this.env },
    );
  }

  /** Stop all watchers. */
  async stop(): Promise<void> {
    await this.manager.stopAll();
  }

  private async handleEvent(event: WatchEvent): Promise<void> {
    const swings = detectSwings(event.changes, this.thresholdCents, this.direction);

    if (this.verbose && swings.length === 0) {
      const priceChange = event.changes.find((c) =>
        c.path.endsWith(PRICE_PATH_SUFFIX),
      );
      let note = event.changesSummary;
      if (priceChange) {
        const before = Number(priceChange.before);
        const after = Number(priceChange.after);
        const delta = after - before;
        const reason =
          Math.abs(delta) < this.thresholdCents
            ? "sub-threshold"
            : `down-swing filtered (direction=${this.direction})`;
        note = `price ${priceChange.before}→${priceChange.after} (${reason})`;
      }
      console.log(`[momentum] tick — ${note}`);
    }

    for (const swing of swings) {
      try {
        const resolved = await resolvePlays(event, this.mode, {
          pythonPath: this.pythonPath,
          env: this.env,
        });
        const card = await generateCard(this.model, event, swing, resolved);
        this.cardCount++;
        this.onCard(card);
      } catch (err) {
        console.error(
          "[momentum] failed to generate card:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}
