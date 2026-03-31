/**
 * sportsclaw — Universal Watcher (Realtime Data Polling)
 *
 * Generic endpoint poller with two-tier change detection (SHA-256 hash +
 * structural JSON diff). Replaces the old GameMonitor with a universal
 * primitive that can watch ANY sports-skills endpoint.
 *
 * Output modes:
 *   - relay: publish WatchEvent to a typed relay channel
 *   - stdout: NDJSON line per change event
 *   - file: JSONL append to a file path
 *
 * Usage:
 *   const manager = new WatchManager();
 *   manager.addWatcher({ sport: "nba", command: "get_scoreboard", intervalSeconds: 30, output: "stdout" });
 *   // Ctrl+C → manager.stopAll()
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { executePythonBridge } from "./tools.js";
import { relayManager } from "./relay.js";
import type { SportsClawChannelName } from "./relay.js";
import type {
  WatcherConfig,
  WatchEvent,
  WatchChange,
  sportsclawConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_INTERVAL_SECONDS = 5;
const MAX_BACKOFF_MULTIPLIER = 32; // 2^5

// ---------------------------------------------------------------------------
// Deterministic watcher ID
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic 12-char hex ID from a watcher config.
 * Same config always produces the same ID.
 */
export function computeWatcherId(config: WatcherConfig): string {
  const sortedArgs = config.args
    ? JSON.stringify(config.args, Object.keys(config.args).sort())
    : "";
  const canonical = `${config.sport}:${config.command}:${sortedArgs}`;
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Tier 1 — Fast hash check
// ---------------------------------------------------------------------------

function hashSnapshot(data: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(data))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Tier 2 — Structural JSON diff
// ---------------------------------------------------------------------------

/**
 * Recursively diff two JSON-serializable values.
 * Returns an array of field-level changes with dot-notation paths.
 */
export function structuralDiff(
  before: unknown,
  after: unknown,
  prefix = "",
): WatchChange[] {
  if (before === after) return [];

  // Both null/undefined
  if (before == null && after == null) return [];

  // One side is null/undefined
  if (before == null) {
    return [{ path: prefix || "(root)", before, after, type: "added" }];
  }
  if (after == null) {
    return [{ path: prefix || "(root)", before, after, type: "removed" }];
  }

  // Primitives
  if (typeof before !== "object" || typeof after !== "object") {
    return [{ path: prefix || "(root)", before, after, type: "modified" }];
  }

  // Arrays — compare by index
  if (Array.isArray(before) && Array.isArray(after)) {
    const changes: WatchChange[] = [];
    const maxLen = Math.max(before.length, after.length);
    for (let i = 0; i < maxLen; i++) {
      const p = prefix ? `${prefix}[${i}]` : `[${i}]`;
      if (i >= before.length) {
        changes.push({ path: p, before: undefined, after: after[i], type: "added" });
      } else if (i >= after.length) {
        changes.push({ path: p, before: before[i], after: undefined, type: "removed" });
      } else {
        changes.push(...structuralDiff(before[i], after[i], p));
      }
    }
    return changes;
  }

  // One is array, other is object
  if (Array.isArray(before) !== Array.isArray(after)) {
    return [{ path: prefix || "(root)", before, after, type: "modified" }];
  }

  // Objects — compare by keys
  const beforeObj = before as Record<string, unknown>;
  const afterObj = after as Record<string, unknown>;
  const allKeys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);
  const changes: WatchChange[] = [];

  for (const key of allKeys) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (!(key in beforeObj)) {
      changes.push({ path: p, before: undefined, after: afterObj[key], type: "added" });
    } else if (!(key in afterObj)) {
      changes.push({ path: p, before: beforeObj[key], after: undefined, type: "removed" });
    } else {
      changes.push(...structuralDiff(beforeObj[key], afterObj[key], p));
    }
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Change summary
// ---------------------------------------------------------------------------

function summarizeChanges(changes: WatchChange[]): string {
  const counts = { added: 0, removed: 0, modified: 0 };
  for (const c of changes) counts[c.type]++;

  const parts: string[] = [];
  if (counts.modified) parts.push(`${counts.modified} modified`);
  if (counts.added) parts.push(`${counts.added} added`);
  if (counts.removed) parts.push(`${counts.removed} removed`);
  return parts.join(", ") || "no changes";
}

// ---------------------------------------------------------------------------
// Interruptible sleep
// ---------------------------------------------------------------------------

function interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Watcher — single endpoint poller
// ---------------------------------------------------------------------------

export class Watcher {
  readonly id: string;
  readonly config: WatcherConfig;

  private engineConfig?: Partial<sportsclawConfig>;
  private previousHash: string | null = null;
  private previousSnapshot: unknown = null;
  private consecutiveErrors = 0;
  private running = false;
  private abortController = new AbortController();

  constructor(config: WatcherConfig, engineConfig?: Partial<sportsclawConfig>) {
    this.config = {
      ...config,
      intervalSeconds: Math.max(config.intervalSeconds, MIN_INTERVAL_SECONDS),
    };
    this.engineConfig = engineConfig;
    this.id = computeWatcherId(this.config);
  }

  /** Start the polling loop. Resolves when stopped. */
  async start(): Promise<void> {
    this.running = true;
    this.abortController = new AbortController();

    console.log(
      `[Watch] Starting watcher ${this.id}: ` +
      `${this.config.sport} ${this.config.command} ` +
      `every ${this.config.intervalSeconds}s → ${this.config.output}`
    );

    while (this.running) {
      await this.poll();
      if (!this.running) break;

      const sleepMs = this.currentSleepMs();
      await interruptibleSleep(sleepMs, this.abortController.signal);
    }

    console.log(`[Watch] Watcher ${this.id} stopped.`);
  }

  /** Stop the polling loop gracefully. */
  stop(): void {
    this.running = false;
    this.abortController.abort();
  }

  /** Whether this watcher is currently running. */
  get isRunning(): boolean {
    return this.running;
  }

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  private async poll(): Promise<void> {
    try {
      const result = await executePythonBridge(
        this.config.sport,
        this.config.command,
        this.config.args,
        this.engineConfig,
      );

      if (!result.success) {
        this.handleError(result.error ?? "Unknown bridge error");
        return;
      }

      const snapshot = result.data;
      const currentHash = hashSnapshot(snapshot);

      // Tier 1: fast hash check
      if (this.previousHash === currentHash) {
        this.consecutiveErrors = 0;
        return; // No change
      }

      // Tier 2: structural diff (only if we have a previous snapshot)
      const changes = this.previousSnapshot != null
        ? structuralDiff(this.previousSnapshot, snapshot)
        : [];

      const event: WatchEvent = {
        watcherId: this.id,
        timestamp: new Date().toISOString(),
        sport: this.config.sport,
        command: this.config.command,
        args: this.config.args,
        changes,
        changesSummary: this.previousSnapshot != null
          ? summarizeChanges(changes)
          : "initial snapshot",
        snapshot,
      };

      this.previousHash = currentHash;
      this.previousSnapshot = snapshot;
      this.consecutiveErrors = 0;

      await this.emit(event);
    } catch (err) {
      this.handleError(err instanceof Error ? err.message : String(err));
    }
  }

  // -------------------------------------------------------------------------
  // Output routing
  // -------------------------------------------------------------------------

  private async emit(event: WatchEvent): Promise<void> {
    const { output } = this.config;

    try {
      switch (output) {
        case "relay": {
          const channel = (this.config.channel ?? "watch") as SportsClawChannelName;
          await relayManager.publish(channel, event as never);
          break;
        }

        case "stdout":
          process.stdout.write(JSON.stringify(event) + "\n");
          break;

        case "file": {
          const filePath = this.resolveFilePath();
          const dir = dirname(filePath);
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          await appendFile(filePath, JSON.stringify(event) + "\n", "utf-8");
          break;
        }
      }
    } catch (err) {
      console.error(
        `[Watch] ${this.id} emit error (${output}):`,
        err instanceof Error ? err.message : err,
      );
    }

    console.log(
      `[Watch] ${this.id}: ${event.changesSummary} ` +
      `(${this.config.sport} ${this.config.command})`
    );
  }

  // -------------------------------------------------------------------------
  // Error handling / backoff
  // -------------------------------------------------------------------------

  private handleError(message: string): void {
    this.consecutiveErrors++;
    console.error(
      `[Watch] ${this.id} error (attempt ${this.consecutiveErrors}): ${message}`
    );
  }

  private currentSleepMs(): number {
    if (this.consecutiveErrors === 0) {
      return this.config.intervalSeconds * 1000;
    }
    const multiplier = Math.min(
      Math.pow(2, this.consecutiveErrors),
      MAX_BACKOFF_MULTIPLIER,
    );
    return this.config.intervalSeconds * 1000 * multiplier;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private resolveFilePath(): string {
    const raw = this.config.filePath ?? join(
      homedir(), ".sportsclaw", "watch-logs", `${this.id}.jsonl`
    );
    return raw.replace(/^~/, homedir());
  }
}

// ---------------------------------------------------------------------------
// WatchManager — multi-watcher orchestrator
// ---------------------------------------------------------------------------

export class WatchManager {
  private watchers = new Map<string, Watcher>();
  private pollPromises = new Map<string, Promise<void>>();

  /**
   * Add and start a watcher. Returns the watcher ID.
   * If a watcher with the same config is already running, returns its ID without duplicating.
   */
  addWatcher(config: WatcherConfig, engineConfig?: Partial<sportsclawConfig>): string {
    const watcher = new Watcher(config, engineConfig);

    if (this.watchers.has(watcher.id)) {
      console.log(`[Watch] Watcher ${watcher.id} already running — skipping.`);
      return watcher.id;
    }

    this.watchers.set(watcher.id, watcher);

    const promise = watcher.start().catch((err) => {
      console.error(
        `[Watch] Fatal error in watcher ${watcher.id}:`,
        err instanceof Error ? err.message : err,
      );
    });
    this.pollPromises.set(watcher.id, promise);

    return watcher.id;
  }

  /** Stop and remove a specific watcher. */
  removeWatcher(watcherId: string): boolean {
    const watcher = this.watchers.get(watcherId);
    if (!watcher) return false;

    watcher.stop();
    this.watchers.delete(watcherId);
    this.pollPromises.delete(watcherId);
    return true;
  }

  /** Stop all watchers gracefully. */
  async stopAll(): Promise<void> {
    for (const watcher of this.watchers.values()) {
      watcher.stop();
    }
    await Promise.all(this.pollPromises.values());
    this.watchers.clear();
    this.pollPromises.clear();
  }

  /** List active watchers. */
  getActiveWatchers(): Array<{ id: string; config: WatcherConfig }> {
    return Array.from(this.watchers.values()).map((w) => ({
      id: w.id,
      config: w.config,
    }));
  }

  /** Number of active watchers. */
  get size(): number {
    return this.watchers.size;
  }

  // -------------------------------------------------------------------------
  // Config file loading
  // -------------------------------------------------------------------------

  /**
   * Load watchers from a JSON config file and start them all.
   * Expected format: { "watchers": [WatcherConfig, ...] }
   */
  static async fromConfigFile(
    path: string,
    engineConfig?: Partial<sportsclawConfig>,
  ): Promise<WatchManager> {
    const resolved = path.replace(/^~/, homedir());
    const raw = await readFile(resolved, "utf-8");
    const parsed = JSON.parse(raw) as { watchers: WatcherConfig[] };

    if (!Array.isArray(parsed.watchers)) {
      throw new Error(`Invalid config: expected { "watchers": [...] } in ${path}`);
    }

    const manager = new WatchManager();
    for (const config of parsed.watchers) {
      manager.addWatcher(config, engineConfig);
    }
    return manager;
  }

  /**
   * Load from the default config location: ~/.sportsclaw/watchers.json
   */
  static async fromDefaultConfig(
    engineConfig?: Partial<sportsclawConfig>,
  ): Promise<WatchManager> {
    const defaultPath = join(homedir(), ".sportsclaw", "watchers.json");
    return WatchManager.fromConfigFile(defaultPath, engineConfig);
  }
}
