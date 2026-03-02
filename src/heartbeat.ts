/**
 * sportsclaw — Heartbeat & Cron Service
 *
 * A periodic scheduler that activates the watcher tasks in taskbus.ts.
 * Enables proactive agent behavior: "check NFL injury reports every morning
 * and notify me," "alert me when Arsenal scores."
 *
 * Architecture:
 *   HeartbeatService
 *     ├── polls active WatcherTasks from taskbus on interval
 *     ├── evaluates conditions using the engine (LLM-driven)
 *     ├── fires action callbacks on match (notify user, etc.)
 *     └── manages cron-style scheduled tasks (one-time or recurring)
 *
 * The service integrates with the existing RelayManager for broadcasting
 * results to channels (Discord, Telegram) when available.
 *
 * Watcher tasks are already created by the LLM via the create_task tool.
 * This service is the missing execution layer that checks those tasks.
 */

import { generateText } from "ai";
import { listTasks, completeTask, expireOldTasks } from "./taskbus.js";
import type { WatcherTask, LLMProvider } from "./types.js";
import { buildProviderOptions } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CronJob {
  /** Unique identifier */
  id: string;
  /** Human-readable label */
  label: string;
  /** Interval in milliseconds between runs */
  intervalMs: number;
  /** The prompt to run against the engine */
  prompt: string;
  /** User who created this job */
  userId: string;
  /** Whether this job repeats or fires once */
  recurring: boolean;
  /** Status */
  status: "active" | "paused" | "completed";
  /** Last execution time (ISO) */
  lastRunAt?: string;
  /** Number of times this job has run */
  runCount: number;
  /** When this job was created */
  createdAt: string;
}

export interface HeartbeatEvent {
  type: "task_matched" | "task_expired" | "cron_fired" | "evaluation_error";
  taskId?: string;
  cronJobId?: string;
  userId?: string;
  result?: string;
  error?: string;
  timestamp: string;
}

export type HeartbeatEventHandler = (event: HeartbeatEvent) => void;

export interface HeartbeatServiceOptions {
  /** Interval in ms between heartbeat cycles (default: 30 minutes) */
  intervalMs?: number;
  /** LLM model instance for evaluating conditions */
  model?: unknown;
  /** LLM provider name */
  provider?: LLMProvider;
  /** Thinking budget for condition evaluation (default: 2048) */
  thinkingBudget?: number;
  /** Max output tokens for evaluation (default: 512) */
  maxOutputTokens?: number;
  /** Event handler for heartbeat events */
  onEvent?: HeartbeatEventHandler;
  /** Enable verbose logging (default: false) */
  verbose?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_EVAL_TOKENS = 512;
const DEFAULT_THINKING_BUDGET = 2048;

// ---------------------------------------------------------------------------
// HeartbeatService
// ---------------------------------------------------------------------------

export class HeartbeatService {
  private intervalMs: number;
  private model: unknown;
  private provider: LLMProvider;
  private thinkingBudget: number;
  private maxOutputTokens: number;
  private onEvent?: HeartbeatEventHandler;
  private verbose: boolean;

  private timer: NodeJS.Timeout | null = null;
  private cronJobs = new Map<string, CronJob>();
  private cronTimers = new Map<string, NodeJS.Timeout>();
  private isRunning = false;

  constructor(options?: HeartbeatServiceOptions) {
    this.intervalMs = options?.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.model = options?.model;
    this.provider = options?.provider ?? "anthropic";
    this.thinkingBudget = options?.thinkingBudget ?? DEFAULT_THINKING_BUDGET;
    this.maxOutputTokens = options?.maxOutputTokens ?? DEFAULT_EVAL_TOKENS;
    this.onEvent = options?.onEvent;
    this.verbose = options?.verbose ?? false;
  }

  /** Configure the LLM model (required before start) */
  setModel(model: unknown, provider: LLMProvider): void {
    this.model = model;
    this.provider = provider;
  }

  /** Register or replace the event handler */
  setEventHandler(handler: HeartbeatEventHandler): void {
    this.onEvent = handler;
  }

  /** Start the heartbeat polling loop */
  start(): void {
    if (this.timer) {
      if (this.verbose) console.error("[heartbeat] Already running");
      return;
    }

    if (this.verbose) {
      console.error(
        `[heartbeat] Starting (interval: ${this.intervalMs}ms, ` +
          `${this.cronJobs.size} cron job(s))`
      );
    }

    this.isRunning = true;

    // Run first heartbeat immediately
    this.tick().catch((err) => {
      console.error(
        `[heartbeat] Tick error: ${err instanceof Error ? err.message : err}`
      );
    });

    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error(
          `[heartbeat] Tick error: ${err instanceof Error ? err.message : err}`
        );
      });
    }, this.intervalMs);
  }

  /** Stop the heartbeat polling loop */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Stop all cron timers
    for (const [id, timer] of this.cronTimers) {
      clearInterval(timer);
      this.cronTimers.delete(id);
    }
    this.isRunning = false;
    if (this.verbose) console.error("[heartbeat] Stopped");
  }

  /** Whether the service is currently running */
  get running(): boolean {
    return this.isRunning;
  }

  // -------------------------------------------------------------------------
  // Cron job management
  // -------------------------------------------------------------------------

  /**
   * Schedule a cron job. One-time jobs fire once and auto-complete.
   * Recurring jobs fire on interval until paused or removed.
   */
  scheduleCron(params: {
    label: string;
    prompt: string;
    userId: string;
    intervalMs: number;
    recurring?: boolean;
  }): CronJob {
    const id = `cron_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const job: CronJob = {
      id,
      label: params.label,
      intervalMs: params.intervalMs,
      prompt: params.prompt,
      userId: params.userId,
      recurring: params.recurring ?? true,
      status: "active",
      runCount: 0,
      createdAt: new Date().toISOString(),
    };

    this.cronJobs.set(id, job);

    // Start the cron timer if the service is running
    if (this.isRunning) {
      this.startCronTimer(job);
    }

    if (this.verbose) {
      console.error(
        `[heartbeat] Scheduled cron: "${job.label}" (${job.intervalMs}ms, ` +
          `${job.recurring ? "recurring" : "one-shot"})`
      );
    }

    return job;
  }

  /** Pause a cron job */
  pauseCron(jobId: string): boolean {
    const job = this.cronJobs.get(jobId);
    if (!job || job.status !== "active") return false;
    job.status = "paused";
    const timer = this.cronTimers.get(jobId);
    if (timer) {
      clearInterval(timer);
      this.cronTimers.delete(jobId);
    }
    return true;
  }

  /** Resume a paused cron job */
  resumeCron(jobId: string): boolean {
    const job = this.cronJobs.get(jobId);
    if (!job || job.status !== "paused") return false;
    job.status = "active";
    if (this.isRunning) this.startCronTimer(job);
    return true;
  }

  /** Remove a cron job entirely */
  removeCron(jobId: string): boolean {
    const timer = this.cronTimers.get(jobId);
    if (timer) {
      clearInterval(timer);
      this.cronTimers.delete(jobId);
    }
    return this.cronJobs.delete(jobId);
  }

  /** List all cron jobs */
  listCronJobs(): CronJob[] {
    return Array.from(this.cronJobs.values());
  }

  /** Get service status */
  getStatus(): {
    running: boolean;
    intervalMs: number;
    activeCronJobs: number;
    totalCronRuns: number;
  } {
    const jobs = Array.from(this.cronJobs.values());
    return {
      running: this.isRunning,
      intervalMs: this.intervalMs,
      activeCronJobs: jobs.filter((j) => j.status === "active").length,
      totalCronRuns: jobs.reduce((sum, j) => sum + j.runCount, 0),
    };
  }

  // -------------------------------------------------------------------------
  // Core heartbeat tick
  // -------------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (this.verbose) {
      console.error(`[heartbeat] Tick at ${new Date().toISOString()}`);
    }

    // 1. Expire old tasks (24h default)
    const expired = await expireOldTasks();
    if (expired > 0 && this.verbose) {
      console.error(`[heartbeat] Expired ${expired} old task(s)`);
    }

    // 2. Evaluate active watcher tasks
    const activeTasks = await listTasks({ status: "active" });
    if (activeTasks.length > 0) {
      await this.evaluateTasks(activeTasks);
    }
  }

  private async evaluateTasks(tasks: WatcherTask[]): Promise<void> {
    if (!this.model) {
      if (this.verbose) {
        console.error("[heartbeat] No model configured — skipping evaluation");
      }
      return;
    }

    for (const task of tasks) {
      try {
        const matched = await this.evaluateCondition(task);
        if (matched) {
          await completeTask(task.id);
          this.emitEvent({
            type: "task_matched",
            taskId: task.id,
            userId: task.userId,
            result: `Condition met: ${task.condition}`,
            timestamp: new Date().toISOString(),
          });
          if (this.verbose) {
            console.error(
              `[heartbeat] Task ${task.id} matched: "${task.condition}"`
            );
          }
        }
      } catch (err) {
        this.emitEvent({
          type: "evaluation_error",
          taskId: task.id,
          userId: task.userId,
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        });
        if (this.verbose) {
          console.error(
            `[heartbeat] Evaluation error for ${task.id}: ` +
              (err instanceof Error ? err.message : err)
          );
        }
      }
    }
  }

  /**
   * Evaluate whether a watcher task's condition is currently met.
   * Uses the LLM to interpret the condition against the task's context.
   *
   * Returns true if the condition is met, false otherwise.
   */
  private async evaluateCondition(task: WatcherTask): Promise<boolean> {
    const providerOpts = buildProviderOptions(this.provider, this.thinkingBudget);

    const result = await generateText({
      model: this.model as Parameters<typeof generateText>[0]["model"],
      system: [
        "You are a condition evaluator for a sports monitoring system.",
        "Given a condition and context, determine if the condition can be",
        "evaluated as TRUE based on the available information.",
        "",
        "Respond with EXACTLY one of:",
        '  {"matched": true, "reason": "brief explanation"}',
        '  {"matched": false, "reason": "brief explanation"}',
        "",
        "If you cannot determine the answer from the context alone,",
        "respond with matched: false.",
      ].join("\n"),
      prompt: [
        `Condition: ${task.condition}`,
        `Action: ${task.action}`,
        `Context: ${JSON.stringify(task.context)}`,
        `Created: ${task.createdAt}`,
        `Current time: ${new Date().toISOString()}`,
      ].join("\n"),
      maxOutputTokens: this.maxOutputTokens,
      ...(providerOpts ? { providerOptions: providerOpts } : {}),
    });

    const text = result.text?.trim() ?? "";
    try {
      const parsed = JSON.parse(text) as { matched?: boolean };
      return parsed.matched === true;
    } catch {
      // If the LLM didn't return valid JSON, look for "true" in response
      return /\bmatched.*true\b/i.test(text);
    }
  }

  // -------------------------------------------------------------------------
  // Cron timer management
  // -------------------------------------------------------------------------

  private startCronTimer(job: CronJob): void {
    const execute = async () => {
      if (job.status !== "active") return;

      job.lastRunAt = new Date().toISOString();
      job.runCount++;

      this.emitEvent({
        type: "cron_fired",
        cronJobId: job.id,
        userId: job.userId,
        result: `Cron "${job.label}" fired (run #${job.runCount})`,
        timestamp: new Date().toISOString(),
      });

      if (this.verbose) {
        console.error(
          `[heartbeat] Cron fired: "${job.label}" (run #${job.runCount})`
        );
      }

      // One-shot jobs auto-complete
      if (!job.recurring) {
        job.status = "completed";
        const timer = this.cronTimers.get(job.id);
        if (timer) {
          clearInterval(timer);
          this.cronTimers.delete(job.id);
        }
      }
    };

    // Execute immediately on first schedule, then on interval
    execute().catch((err) => {
      console.error(
        `[heartbeat] Cron error "${job.label}": ` +
          (err instanceof Error ? err.message : err)
      );
    });

    if (job.recurring) {
      const timer = setInterval(() => {
        execute().catch((err) => {
          console.error(
            `[heartbeat] Cron error "${job.label}": ` +
              (err instanceof Error ? err.message : err)
          );
        });
      }, job.intervalMs);
      this.cronTimers.set(job.id, timer);
    }
  }

  private emitEvent(event: HeartbeatEvent): void {
    try {
      this.onEvent?.(event);
    } catch (err) {
      console.error(
        `[heartbeat] Event handler error: ${err instanceof Error ? err.message : err}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Default singleton
// ---------------------------------------------------------------------------

export const heartbeatService = new HeartbeatService();
