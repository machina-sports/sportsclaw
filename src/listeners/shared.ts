/**
 * sportsclaw — Shared listener helpers.
 *
 * Both Discord and Telegram listeners need the same boilerplate:
 *   - parse ALLOWED_USERS env var
 *   - parse positive ints from env
 *   - keep an ephemeral button-context store with a hard cap
 *   - build engine config from SPORTSCLAW_* env vars
 *
 * Centralizing here keeps the two listeners thin and prevents the helpers
 * from drifting (which is exactly how the buttons-don't-show-up bug crept in).
 */

import type { DetectedSport } from "../buttons.js";
import type { LLMProvider, sportsclawConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Env parsing
// ---------------------------------------------------------------------------

/** Parse `ALLOWED_USERS` env var into a Set of user IDs. Returns null if unset/empty. */
export function getAllowedUsers(envName = "ALLOWED_USERS"): Set<string> | null {
  const raw = process.env[envName];
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null;
}

/** Parse a positive integer from a string, or return the fallback. */
export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

/**
 * Canonical "anything → string" coercion for listener catch blocks.
 *
 * Both listeners caught errors with subtly different inline patterns —
 *   • `e instanceof Error ? e.message : String(e)`  (canonical, most sites)
 *   • `e instanceof Error ? e.message : e`           (drops the String wrap)
 *   • `e.message` / `e.stack ?? e.message`           (assumes typed Error)
 *
 * The middle form returns the original (possibly non-string) value when
 * `e` isn't an Error, which then gets template-literal-stringified
 * unpredictably depending on the provider.
 *
 * Use this helper instead. Always returns a string.
 */
export function formatListenerError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Button context store — bounded LRU keyed by random short ID.
// ---------------------------------------------------------------------------

export interface ButtonContext {
  prompt: string;
  userId: string;
  sport: DetectedSport;
}

export class ButtonContextStore {
  private readonly contexts = new Map<string, ButtonContext>();
  private readonly maxSize: number;

  constructor(maxSize = 200) {
    this.maxSize = maxSize;
  }

  /** Store a context and return a short opaque key for callback_data / customId. */
  store(prompt: string, userId: string, sport: DetectedSport): string {
    const key = Math.random().toString(36).slice(2, 9);
    this.contexts.set(key, { prompt, userId, sport });
    if (this.contexts.size > this.maxSize) {
      // FIFO eviction is fine — these are short-lived UI button contexts.
      const oldest = this.contexts.keys().next().value;
      if (oldest) this.contexts.delete(oldest);
    }
    return key;
  }

  get(key: string): ButtonContext | undefined {
    return this.contexts.get(key);
  }

  /** For tests / diagnostics. */
  get size(): number {
    return this.contexts.size;
  }
}

// ---------------------------------------------------------------------------
// Engine config — common across listeners.
// ---------------------------------------------------------------------------

/**
 * Build the engine config that listener processes use.
 *
 * Reads SPORTSCLAW_* env vars (with legacy lowercase fallbacks), normalizes
 * routing config, and returns a Partial<sportsclawConfig> ready to spread
 * into `new sportsclawEngine(...)`.
 */
export function buildListenerEngineConfig(): Partial<sportsclawConfig> {
  const provider = (
    process.env.SPORTSCLAW_PROVIDER ||
    process.env.sportsclaw_PROVIDER ||
    "anthropic"
  ) as LLMProvider;

  const model = process.env.SPORTSCLAW_MODEL || process.env.sportsclaw_MODEL;
  const pythonPath = process.env.PYTHON_PATH;

  return {
    provider,
    ...(model ? { model } : {}),
    ...(pythonPath ? { pythonPath } : {}),
    routingMode: "soft_lock" as const,
    routingMaxSkills: parsePositiveInt(process.env.SPORTSCLAW_ROUTING_MAX_SKILLS, 2),
    routingAllowSpillover: parsePositiveInt(
      process.env.SPORTSCLAW_ROUTING_ALLOW_SPILLOVER,
      1
    ),
  };
}
