/**
 * Last-Tick Brief — per-tick handoff between autonomous runs.
 *
 * The third surface in the SportsClaw memory triad:
 *
 *   DecisionLedger   immutable append-only LOG          ─ what happened, when, why
 *   EditorialMemory  mutable, bounded, snapshot LESSONS ─ what we have learned
 *   LastTickBrief    per-tick handoff for the next run  ─ this file
 *
 * Every cron tick produces a brief: a free-form markdown summary of what the
 * agent decided / did / saw on that run. Briefs are persisted to
 * `<rootDir>/<jobId>/<tickId>.md`. The next tick can `loadRecent(jobId)` to
 * pull the previous brief into its prompt as context — exactly how Hermes'
 * `context_from` works (see external review notes).
 *
 * The `[SILENT]` sentinel: if a tick's body trims to exactly `[SILENT]`, it is
 * recorded with `silent: true` so downstream code (telemetry emit, broadcast)
 * can suppress delivery. Subsequent ticks still see silent briefs in their
 * handoff context, so the agent knows "last tick, we voted to stay quiet."
 *
 * Concurrency: writes are atomic-rename, files are append-only by `tickId`,
 * one writer per job is the intended model. No locking.
 *
 * Bound: each tick is one file. Old briefs accumulate; a future pruner can
 * trim by retention. For now, no pruning — the daemon will run for hours,
 * not years, before we revisit.
 */

import fs from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TickBrief {
  /** Unique tick id (e.g. `tick_<unix-ms>_<rand>`). */
  tickId: string;
  /** Cron job id this tick belongs to. */
  jobId: string;
  /** ISO 8601 UTC timestamp of write. */
  timestamp: string;
  /** Free-form markdown body — the agent's final summary for this tick. */
  body: string;
  /** True if `body` trimmed equals `SILENT_SENTINEL`. */
  silent: boolean;
}

export const SILENT_SENTINEL = "[SILENT]";

export interface ContextFromOptions {
  /** How many briefs per job to pull. Default 1 (the most recent). */
  perJobLimit?: number;
  /** Hard cap on the assembled context-block length. Default 8192. */
  maxChars?: number;
  /** Drop briefs whose `silent` is true from the rendered context. Default false. */
  dropSilent?: boolean;
}

// ---------------------------------------------------------------------------
// LastTickBrief
// ---------------------------------------------------------------------------

export class LastTickBrief {
  constructor(public readonly rootDir: string) {}

  /**
   * Persist a brief and return the parsed record. Creates the per-job dir
   * lazily. The body is trimmed; `silent` is computed from the trimmed body.
   */
  async write(input: { tickId: string; jobId: string; body: string }): Promise<TickBrief> {
    if (!input.tickId) throw new Error("LastTickBrief: tickId is required.");
    if (!input.jobId) throw new Error("LastTickBrief: jobId is required.");
    const trimmed = (input.body ?? "").trim();
    const silent = trimmed === SILENT_SENTINEL;
    const brief: TickBrief = {
      tickId: input.tickId,
      jobId: input.jobId,
      timestamp: new Date().toISOString(),
      body: trimmed,
      silent,
    };
    const filePath = this.pathFor(brief.jobId, brief.tickId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = filePath + `.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, serializeBrief(brief), "utf8");
    await fs.rename(tmp, filePath);
    return brief;
  }

  /**
   * Load up to `limit` most-recent briefs for `jobId`, newest first.
   * Returns [] when the per-job dir does not exist yet.
   */
  async loadRecent(jobId: string, limit: number = 1): Promise<TickBrief[]> {
    if (limit <= 0) return [];
    const dir = path.join(this.rootDir, sanitizeId(jobId));
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const mds = files.filter((f) => f.endsWith(".md"));
    // tickId is intended to be sortable (e.g. tick_<unix-ms>_<rand>);
    // descending sort gives newest-first.
    mds.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    const picked = mds.slice(0, limit);
    const briefs: TickBrief[] = [];
    for (const fname of picked) {
      const text = await fs.readFile(path.join(dir, fname), "utf8");
      try {
        briefs.push(parseBrief(text));
      } catch {
        // skip unparsable file
      }
    }
    return briefs;
  }

  /**
   * Load a single brief by tickId for a known job.
   */
  async loadOne(jobId: string, tickId: string): Promise<TickBrief | null> {
    try {
      const text = await fs.readFile(this.pathFor(jobId, tickId), "utf8");
      return parseBrief(text);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /**
   * Build a prompt-ready context block: concatenates the most-recent briefs
   * across the requested job ids. Truncated to `maxChars`. Output shape is
   * Hermes-compatible — clearly labelled per-job sections.
   */
  async contextFrom(
    jobIds: string[],
    options: ContextFromOptions = {},
  ): Promise<string> {
    const perJobLimit = options.perJobLimit ?? 1;
    const maxChars = options.maxChars ?? 8192;
    const dropSilent = options.dropSilent ?? false;

    const sections: string[] = [];
    for (const jobId of jobIds) {
      const briefs = await this.loadRecent(jobId, perJobLimit);
      const filtered = dropSilent ? briefs.filter((b) => !b.silent) : briefs;
      if (filtered.length === 0) continue;
      sections.push(renderJobSection(jobId, filtered));
    }
    const joined = sections.join("\n\n");
    if (joined.length <= maxChars) return joined;
    // truncate from the bottom — most recent first within a job, so the head
    // is highest-signal.
    return joined.slice(0, maxChars).replace(/\s+\S*$/, "") + "\n…[truncated]";
  }

  /** True iff the body trims to exactly `[SILENT]`. */
  static isSilent(body: string): boolean {
    return (body ?? "").trim() === SILENT_SENTINEL;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private pathFor(jobId: string, tickId: string): string {
    return path.join(this.rootDir, sanitizeId(jobId), `${sanitizeId(tickId)}.md`);
  }
}

// ---------------------------------------------------------------------------
// serialization
// ---------------------------------------------------------------------------

const FRONTMATTER_DELIM = "---";

export function serializeBrief(brief: TickBrief): string {
  const fm = [
    FRONTMATTER_DELIM,
    `tickId: ${brief.tickId}`,
    `jobId: ${brief.jobId}`,
    `timestamp: ${brief.timestamp}`,
    `silent: ${brief.silent ? "true" : "false"}`,
    FRONTMATTER_DELIM,
  ].join("\n");
  return `${fm}\n\n${brief.body}\n`;
}

export function parseBrief(text: string): TickBrief {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== FRONTMATTER_DELIM) {
    throw new Error("LastTickBrief: missing frontmatter delimiter.");
  }
  let i = 1;
  const fm: Record<string, string> = {};
  while (i < lines.length && lines[i].trim() !== FRONTMATTER_DELIM) {
    const line = lines[i];
    const idx = line.indexOf(":");
    if (idx > 0) {
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      fm[k] = v;
    }
    i++;
  }
  if (i >= lines.length) throw new Error("LastTickBrief: unterminated frontmatter.");
  const body = lines.slice(i + 1).join("\n").trim();
  if (!fm.tickId || !fm.jobId || !fm.timestamp) {
    throw new Error("LastTickBrief: required frontmatter field missing (tickId / jobId / timestamp).");
  }
  return {
    tickId: fm.tickId,
    jobId: fm.jobId,
    timestamp: fm.timestamp,
    body,
    silent: fm.silent === "true" || body === SILENT_SENTINEL,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sanitizeId(id: string): string {
  // permit only safe filename chars; replace others with `_` to avoid path-traversal
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

function renderJobSection(jobId: string, briefs: TickBrief[]): string {
  const header = `## Recent brief from job '${jobId}'`;
  const items = briefs.map((b) => {
    const tag = b.silent ? " (silent)" : "";
    return `### tick ${b.tickId} · ${b.timestamp}${tag}\n\n${b.body}`;
  });
  return [header, ...items].join("\n\n");
}

/** Generate a sortable tickId — intended to be unique across processes. */
export function newTickId(): string {
  const ts = Date.now().toString().padStart(13, "0");
  const rand = Math.random().toString(36).slice(2, 8);
  return `tick_${ts}_${rand}`;
}
