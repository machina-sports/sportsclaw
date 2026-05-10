/**
 * Heartbeat State Store — persists per-job runtime state across daemon ticks.
 *
 * Companion to HeartbeatService. The state file holds per-cron-job metadata
 * (nextRunAt, lastRunAt, runCount, lastStatus, lastError) so a crashed and
 * restarted daemon can pick up without double-firing.
 *
 * Key insight from Hermes' scheduler.tick: write the next scheduled time to
 * disk BEFORE the work executes — that converts at-least-once into
 * at-most-once on crash. A mid-tick crash loses one fire instead of replaying
 * dozens. See `markRunStart()`.
 *
 * Storage: a single JSON file. Atomic-rename writes (write-to-temp + rename).
 * Single-writer model — the operator daemon is the only writer; cross-process
 * coordination is handled by the tick lockfile in HeartbeatService, not here.
 */

import fs from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lifecycle status for a cron job. */
export type CronJobLifecycle = "active" | "paused" | "completed" | "error";

/** Outcome of the most recent tick of a cron job. */
export type CronJobLastStatus = "succeeded" | "failed" | "running" | "skipped";

/** Persisted per-job runtime state. */
export interface CronJobState {
  /** Job id (matches HeartbeatService cronJob.id). */
  jobId: string;
  /** Lifecycle status. Defaults to "active" on first creation. */
  state: CronJobLifecycle;
  /** ISO timestamp of the next scheduled fire. */
  nextRunAt: string;
  /** ISO timestamp of the most recent fire start. */
  lastRunAt?: string;
  /** Number of times this job has actually fired (work began). Skips are NOT counted here. */
  runCount: number;
  /** Number of times this job's wake gate denied the tick. */
  skipCount: number;
  /** Status of the most recent run. */
  lastStatus?: CronJobLastStatus;
  /** Stringified error from the most recent failed run, if any. */
  lastError?: string;
  /** ISO timestamp of the most recent wake-gate skip. */
  lastSkipAt?: string;
  /** Reason given by the wake gate on the most recent skip. */
  lastSkipReason?: string;
  /** ISO timestamp when this state record was last written. */
  updatedAt: string;
}

interface StateFile {
  version: 1;
  jobs: Record<string, CronJobState>;
}

// ---------------------------------------------------------------------------
// HeartbeatStateStore
// ---------------------------------------------------------------------------

const EMPTY_FILE: StateFile = { version: 1, jobs: {} };

export class HeartbeatStateStore {
  private cache: StateFile = { ...EMPTY_FILE, jobs: {} };
  private loaded = false;

  constructor(public readonly filePath: string) {}

  /** Load state from disk, or start fresh if missing. */
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      this.cache = normalize(parsed);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = { ...EMPTY_FILE, jobs: {} };
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      } else {
        throw err;
      }
    }
    this.loaded = true;
  }

  /** Get a snapshot of all persisted jobs. */
  list(): CronJobState[] {
    return Object.values(this.cache.jobs).map((s) => ({ ...s }));
  }

  /** Look up a single job by id. */
  get(jobId: string): CronJobState | null {
    const entry = this.cache.jobs[jobId];
    return entry ? { ...entry } : null;
  }

  /**
   * Record that a job's next fire is scheduled — call this BEFORE doing the
   * work. This is the at-most-once guarantee on crash. Increments runCount,
   * sets lastRunAt to now, lastStatus to "running", and writes nextRunAt.
   * Preserves skipCount and the prior skip-tracking fields.
   */
  async markRunStart(
    jobId: string,
    opts: { intervalMs: number; lifecycle?: CronJobLifecycle },
  ): Promise<CronJobState> {
    return this.mutate(jobId, (existing) => {
      const now = new Date();
      const nowIso = now.toISOString();
      return {
        jobId,
        state: opts.lifecycle ?? existing?.state ?? "active",
        nextRunAt: new Date(now.getTime() + opts.intervalMs).toISOString(),
        lastRunAt: nowIso,
        runCount: (existing?.runCount ?? 0) + 1,
        skipCount: existing?.skipCount ?? 0,
        lastStatus: "running",
        lastError: undefined,
        lastSkipAt: existing?.lastSkipAt,
        lastSkipReason: existing?.lastSkipReason,
        updatedAt: nowIso,
      };
    });
  }

  /**
   * Record that a job's wake gate denied the tick. Increments skipCount,
   * sets lastStatus to "skipped", records the reason and timestamp.
   * Does NOT bump runCount, does NOT advance nextRunAt — the next interval
   * fires the next attempt. Creates a fresh record if the job has none yet
   * (rare: a brand-new job whose first tick is gated off).
   */
  async markRunSkipped(
    jobId: string,
    opts: { intervalMs: number; reason: string; lifecycle?: CronJobLifecycle },
  ): Promise<CronJobState> {
    return this.mutate(jobId, (existing) => {
      const now = new Date();
      const nowIso = now.toISOString();
      return {
        jobId,
        state: opts.lifecycle ?? existing?.state ?? "active",
        nextRunAt:
          existing?.nextRunAt ??
          new Date(now.getTime() + opts.intervalMs).toISOString(),
        lastRunAt: existing?.lastRunAt,
        runCount: existing?.runCount ?? 0,
        skipCount: (existing?.skipCount ?? 0) + 1,
        lastStatus: "skipped",
        lastError: existing?.lastError,
        lastSkipAt: nowIso,
        lastSkipReason: opts.reason,
        updatedAt: nowIso,
      };
    });
  }

  /** Mark a job's most recent run as succeeded. Call AFTER the work finishes ok. */
  async markRunSuccess(jobId: string): Promise<CronJobState | null> {
    return this.mutateExisting(jobId, (existing) => ({
      ...existing,
      lastStatus: "succeeded",
      lastError: undefined,
      updatedAt: new Date().toISOString(),
    }));
  }

  /**
   * Mark a job's most recent run as failed. Records the error message but
   * does NOT silently disable a recurring job — a job whose `compute_next_run`
   * fails should be moved to lifecycle="error" by the caller via `setLifecycle`.
   */
  async markRunFailed(jobId: string, error: unknown): Promise<CronJobState | null> {
    const message = error instanceof Error ? error.message : String(error);
    return this.mutateExisting(jobId, (existing) => ({
      ...existing,
      lastStatus: "failed",
      lastError: message,
      updatedAt: new Date().toISOString(),
    }));
  }

  /** Move a job to a different lifecycle (active / paused / completed / error). */
  async setLifecycle(jobId: string, lifecycle: CronJobLifecycle): Promise<CronJobState | null> {
    return this.mutateExisting(jobId, (existing) => ({
      ...existing,
      state: lifecycle,
      updatedAt: new Date().toISOString(),
    }));
  }

  /** Remove a job's persisted state entirely. */
  async forget(jobId: string): Promise<boolean> {
    if (!this.loaded) await this.load();
    if (!(jobId in this.cache.jobs)) return false;
    const next: StateFile = {
      version: 1,
      jobs: { ...this.cache.jobs },
    };
    delete next.jobs[jobId];
    await this.persist(next);
    this.cache = next;
    return true;
  }

  /** Drop all persisted state. Useful for tests; never in production. */
  async clear(): Promise<void> {
    if (!this.loaded) await this.load();
    const next: StateFile = { ...EMPTY_FILE, jobs: {} };
    await this.persist(next);
    this.cache = next;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private async mutate(
    jobId: string,
    mutator: (existing: CronJobState | undefined) => CronJobState,
  ): Promise<CronJobState> {
    if (!this.loaded) await this.load();
    const next: StateFile = {
      version: 1,
      jobs: { ...this.cache.jobs },
    };
    const newState = mutator(next.jobs[jobId]);
    next.jobs[jobId] = newState;
    await this.persist(next);
    this.cache = next;
    return { ...newState };
  }

  private async mutateExisting(
    jobId: string,
    mutator: (existing: CronJobState) => CronJobState,
  ): Promise<CronJobState | null> {
    if (!this.loaded) await this.load();
    const existing = this.cache.jobs[jobId];
    if (!existing) return null;
    const next: StateFile = {
      version: 1,
      jobs: { ...this.cache.jobs },
    };
    const newState = mutator(existing);
    next.jobs[jobId] = newState;
    await this.persist(next);
    this.cache = next;
    return { ...newState };
  }

  private async persist(state: StateFile): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(
      dir,
      `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`,
    );
    await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
    await fs.rename(tmp, this.filePath);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function normalize(parsed: unknown): StateFile {
  if (!parsed || typeof parsed !== "object") return { ...EMPTY_FILE, jobs: {} };
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) return { ...EMPTY_FILE, jobs: {} };
  const rawJobs = (obj.jobs ?? {}) as Record<string, unknown>;
  const jobs: Record<string, CronJobState> = {};
  for (const [id, raw] of Object.entries(rawJobs)) {
    const j = raw as Record<string, unknown>;
    if (!j || typeof j !== "object") continue;
    if (typeof j.jobId !== "string" || typeof j.nextRunAt !== "string") continue;
    jobs[id] = {
      jobId: j.jobId,
      state: (j.state as CronJobLifecycle) ?? "active",
      nextRunAt: j.nextRunAt,
      lastRunAt: typeof j.lastRunAt === "string" ? j.lastRunAt : undefined,
      runCount: typeof j.runCount === "number" ? j.runCount : 0,
      skipCount: typeof j.skipCount === "number" ? j.skipCount : 0,
      lastStatus: (j.lastStatus as CronJobLastStatus | undefined) ?? undefined,
      lastError: typeof j.lastError === "string" ? j.lastError : undefined,
      lastSkipAt: typeof j.lastSkipAt === "string" ? j.lastSkipAt : undefined,
      lastSkipReason: typeof j.lastSkipReason === "string" ? j.lastSkipReason : undefined,
      updatedAt: typeof j.updatedAt === "string" ? j.updatedAt : new Date(0).toISOString(),
    };
  }
  return { version: 1, jobs };
}
