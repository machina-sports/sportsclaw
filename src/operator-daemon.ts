/**
 * Operator Daemon — autonomous tick loop for SportsClaw.
 *
 * Wires the four primitive surfaces into a single tick driver:
 *
 *   HeartbeatService       schedules + persists + locks + wake-gates ticks
 *   EditorialMemory        frozen-snapshot lessons surfaced into the prompt
 *   LastTickBrief          per-tick handoff (last brief in, this brief out)
 *   ToolGuardController    anti-loop circuit breaker around tool execution
 *
 * The adapter calls the Vercel AI SDK's `generateText` directly. It does NOT
 * extend or reshape `engine.ts` — chat-mode and operator-mode have genuinely
 * different shapes (no stdin, no user turn, [SILENT] sentinel, time-driven)
 * and unifying them would fight assumptions baked into the chat REPL. Future
 * cleanup can extract a shared `core/llm-pass` module if real shared logic
 * emerges.
 *
 * Lifecycle of a single tick:
 *   1. Heartbeat fires the cron timer.
 *   2. The optional wake gate runs INSIDE heartbeat — if denied, cron_skipped
 *      fires and the tick is recorded but the LLM is never invoked.
 *   3. Heartbeat marks run-start (advance-before-execute), then emits
 *      cron_fired with optional wake context.
 *   4. The daemon's onEvent handler picks up cron_fired for THIS jobId and:
 *        a. Loads the editorial-memory snapshot (frozen for the tick).
 *        b. Loads up to N recent briefs across all known jobs.
 *        c. Composes a system prompt via buildSystemPrompt.
 *        d. Resets the tool guardrail and wraps each tool's execute with it.
 *        e. Calls generateText with the prompt + wrapped tools.
 *        f. Parses output for [SILENT]; writes a brief either way.
 *        g. Marks run success or failure on the heartbeat persistence.
 *
 * One daemon = one cron job in this PR. Multi-job is a future extension.
 */

import path from "node:path";
import {
  generateText,
  stepCountIs,
  type LanguageModel,
  type ToolSet,
  type Tool,
} from "ai";

import {
  HeartbeatService,
  type CronJob,
  type HeartbeatEvent,
  type WakeGateFn,
} from "./heartbeat.js";
import { EditorialMemory } from "./editorial-memory.js";
import { LastTickBrief, newTickId } from "./last-tick-brief.js";
import { buildSystemPrompt } from "./prompts.js";
import {
  ToolGuardController,
  digestResult,
  type ToolGuardOptions,
} from "./guardrails.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TickStatus = "silent" | "published" | "failed" | "skipped";

export interface ToolCallEvent {
  jobId: string;
  tickId: string;
  toolName: string;
  /** ms from beforeCall to execute resolution */
  durationMs: number;
  /** "ok" — tool ran successfully, "error" — tool threw, "blocked" — guardrail blocked it */
  outcome: "ok" | "error" | "blocked";
  /** Reason string when outcome is "blocked" or "error". */
  reason?: string;
  timestamp: string;
}

export interface TickEvent {
  type:
    | "tick_started"
    | "tick_silent"
    | "tick_published"
    | "tick_failed"
    | "tick_skipped";
  jobId: string;
  tickId: string;
  /** Final assistant text, if any. Omitted when silent or failed. */
  text?: string;
  /** Reason string for skipped, error message for failed. */
  reason?: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Counts captured from the per-tick guardrail. */
  toolCalls?: number;
  guardrailWarnings?: number;
  guardrailBlocks?: number;
}

export interface OperatorDaemonConfig {
  /** Stable cron job id used by heartbeat persistence + brief filenames. */
  jobId: string;
  /** Human label (heartbeat logs). Defaults to jobId. */
  jobLabel?: string;
  /** Tick interval in ms. */
  intervalMs: number;
  /** User scope (heartbeat persistence keys by this). Default "operator". */
  userId?: string;

  /** AI SDK language model used for the tick LLM call. */
  model: LanguageModel;
  /** Persona / role paragraph — top of every system prompt. */
  role: string;
  /** Per-tick user prompt template. `{tickId}` and `{timestamp}` are substituted. */
  tickPrompt?: string;
  /** Tools handed to the model. Each tool's `execute` is wrapped by the guardrail. */
  tools?: ToolSet;
  /** Max output tokens for the tick. Default 2048. */
  maxOutputTokens?: number;
  /** Maximum LLM steps per tick. Default 8. Allows the model to call tools
   *  and then produce a final synthesis text within one tick. */
  maxSteps?: number;
  /** Append additional fragments to the system prompt (project-specific guides, etc.). */
  extraFragments?: string[];

  /** Filesystem root for daemon surfaces. Subdirs created lazily. */
  rootDir: string;
  /** Editorial memory file path. Default `<rootDir>/editorial-memory.md`. */
  memoryFilePath?: string;
  /** Brief root dir. Default `<rootDir>/briefs`. */
  briefDir?: string;
  /** State + lock dir for heartbeat persistence. Default `<rootDir>`. */
  stateDir?: string;

  /** Optional wake gate. Forwarded to heartbeat unchanged. */
  wakeGate?: WakeGateFn;
  /** Tool guardrail thresholds + tool categorisation. */
  guardOptions?: ToolGuardOptions;
  /**
   * How many recent briefs (per job) to surface to the model. Default 1.
   */
  recentBriefLimit?: number;
  /**
   * Job ids to pull recent briefs from. Defaults to `[jobId]`. Useful when
   * multiple daemons share editorial context.
   */
  recentBriefJobIds?: string[];

  /** Telemetry hook — called for every tick lifecycle event. */
  onTickEvent?: (event: TickEvent) => void;
  /** Heartbeat event hook — surfaces cron_fired / cron_skipped / etc. */
  onHeartbeatEvent?: (event: HeartbeatEvent) => void;
  /** Per-tool-call hook — fires once per tool execution with timing + result. */
  onToolCall?: (event: ToolCallEvent) => void;

  /** Inject a HeartbeatService (tests). Default: a fresh instance. */
  heartbeat?: HeartbeatService;
  /** Inject a generateText impl (tests). Default: ai SDK's. */
  generateTextImpl?: typeof generateText;
}

export interface OperatorDaemon {
  /** Underlying heartbeat — exposed for inspection / advanced wiring. */
  readonly heartbeat: HeartbeatService;
  /** The scheduled cron job (after start()). */
  readonly cronJob: CronJob | null;
  /** Start scheduling. Idempotent. */
  start(): void;
  /** Stop scheduling and clear timers. */
  stop(): void;
  /**
   * Run a single tick body synchronously, bypassing heartbeat scheduling.
   * Intended for tests and `sportsclaw operate --once` style commands.
   * Heartbeat persistence is still touched (markRunStart / Success / Failed)
   * if persistence is configured.
   */
  tickOnce(): Promise<TickEvent>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_TICK_PROMPT = [
  "Tick {tickId} at {timestamp}.",
  "",
  "Decide the next on-air action for this job. Inspect the editorial memory",
  "and previous tick brief above; call tools to fetch live data; produce a",
  "short broadcast/telemetry summary OR return [SILENT] if nothing new is",
  "worth surfacing.",
].join("\n");

const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
const DEFAULT_MAX_STEPS = 16;
const DEFAULT_RECENT_BRIEF_LIMIT = 1;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOperatorDaemon(
  cfg: OperatorDaemonConfig,
): OperatorDaemon {
  if (!cfg.jobId) throw new Error("OperatorDaemon: jobId is required.");
  if (!cfg.intervalMs || cfg.intervalMs <= 0) {
    throw new Error("OperatorDaemon: intervalMs must be > 0.");
  }
  if (!cfg.rootDir) throw new Error("OperatorDaemon: rootDir is required.");

  // Capture the operator-supplied jobId as a stable local. Used as the cron
  // id (via scheduleCron({id})), the brief jobId, and the persistence key —
  // all three must agree across the daemon's lifetime, so we never read
  // `cfg.jobId` after this point.
  const jobId = cfg.jobId;
  const intervalMs = cfg.intervalMs;
  const userId = cfg.userId ?? "operator";
  const memoryFilePath =
    cfg.memoryFilePath ?? path.join(cfg.rootDir, "editorial-memory.md");
  const briefDir = cfg.briefDir ?? path.join(cfg.rootDir, "briefs");
  const stateDir = cfg.stateDir ?? cfg.rootDir;
  const recentBriefLimit = cfg.recentBriefLimit ?? DEFAULT_RECENT_BRIEF_LIMIT;
  const recentBriefJobIds = cfg.recentBriefJobIds ?? [jobId];
  const tickPromptTemplate = cfg.tickPrompt ?? DEFAULT_TICK_PROMPT;
  const generateImpl = cfg.generateTextImpl ?? generateText;

  const heartbeat = cfg.heartbeat ?? new HeartbeatService();
  if (!heartbeat.hasPersistence) {
    heartbeat.configurePersistence({ stateDir });
  }

  const memory = new EditorialMemory(memoryFilePath);
  const briefStore = new LastTickBrief(briefDir);

  let cronJob: CronJob | null = null;
  let started = false;

  // ---- core tick body ---------------------------------------------------

  async function runTick(tickId: string): Promise<TickEvent> {
    const timestamp = new Date().toISOString();
    cfg.onTickEvent?.({
      type: "tick_started",
      jobId,
      tickId,
      timestamp,
    });

    // 1. Frozen memory snapshot for this tick.
    await memory.load();
    const memorySnapshot = memory.snapshot();

    // 2. Recent brief context across the configured job set.
    const recentTickBrief = await briefStore.contextFrom(recentBriefJobIds, {
      perJobLimit: recentBriefLimit,
    });

    // 3. System prompt composition.
    const system = buildSystemPrompt({
      role: cfg.role,
      isCron: true,
      toolDiscipline: true,
      silentSentinel: true,
      editorialMemorySnapshot: memorySnapshot,
      recentTickBrief,
      extras: cfg.extraFragments,
    });

    // 4. Wrap tools with the guardrail.
    const guard = new ToolGuardController(cfg.guardOptions);
    const counts = { calls: 0, warnings: 0, blocks: 0 };
    const toolCallSink = (event: ToolCallEvent): void => {
      try { cfg.onToolCall?.(event); } catch { /* swallow */ }
    };
    const wrappedTools = wrapTools(
      cfg.tools, guard, counts,
      { jobId: cfg.jobId, tickId, onToolCall: toolCallSink },
    );

    const tickPrompt = tickPromptTemplate
      .replace("{tickId}", tickId)
      .replace("{timestamp}", timestamp);

    // 5. LLM pass.
    let text = "";
    let failureReason: string | undefined;
    try {
      const result = await generateImpl({
        model: cfg.model,
        system,
        prompt: tickPrompt,
        ...(wrappedTools ? { tools: wrappedTools } : {}),
        maxOutputTokens: cfg.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        // Allow the model multiple steps so it can call tools and THEN
        // produce a final synthesis text. Without stopWhen, generateText
        // takes a single step and ends with empty text whenever the
        // model chose to call tools first.
        stopWhen: stepCountIs(cfg.maxSteps ?? DEFAULT_MAX_STEPS),
      });
      text = (result.text ?? "").trim();
    } catch (err) {
      failureReason = err instanceof Error ? err.message : String(err);
    }

    // 6. Persist a brief either way (failures get a body too — handoff).
    const briefBody = failureReason
      ? `**tick failed**: ${failureReason}`
      : text || "[SILENT]";
    try {
      await briefStore.write({
        tickId,
        jobId,
        body: briefBody,
      });
    } catch (err) {
      // brief-write failure is logged but does not promote a successful
      // tick to failed — the LLM result is the source of truth.
      console.error(
        `[operator-daemon] brief write failed for tick ${tickId}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }

    // 7. Heartbeat status + telemetry.
    if (failureReason) {
      await heartbeat.markJobFailed(jobId, failureReason).catch(() => {});
      const event: TickEvent = {
        type: "tick_failed",
        jobId,
        tickId,
        reason: failureReason,
        timestamp,
        toolCalls: counts.calls,
        guardrailWarnings: counts.warnings,
        guardrailBlocks: counts.blocks,
      };
      cfg.onTickEvent?.(event);
      return event;
    }

    await heartbeat.markJobSucceeded(jobId).catch(() => {});

    const silent = LastTickBrief.isSilent(text);
    const event: TickEvent = {
      type: silent ? "tick_silent" : "tick_published",
      jobId,
      tickId,
      text: silent ? undefined : text,
      timestamp,
      toolCalls: counts.calls,
      guardrailWarnings: counts.warnings,
      guardrailBlocks: counts.blocks,
    };
    cfg.onTickEvent?.(event);
    return event;
  }

  // ---- heartbeat event routing -----------------------------------------

  const onEvent = (event: HeartbeatEvent): void => {
    cfg.onHeartbeatEvent?.(event);
    if (event.cronJobId !== jobId) return;

    if (event.type === "cron_skipped") {
      const tickId = newTickId();
      const skip: TickEvent = {
        type: "tick_skipped",
        jobId,
        tickId,
        reason: event.result ?? "wake gate denied",
        timestamp: event.timestamp,
      };
      cfg.onTickEvent?.(skip);
      return;
    }

    if (event.type === "cron_fired") {
      const tickId = newTickId();
      runTick(tickId).catch((err) => {
        console.error(
          `[operator-daemon] tick crashed for ${jobId}: ${
            err instanceof Error ? err.message : err
          }`,
        );
      });
    }
  };

  heartbeat.setEventHandler(onEvent);

  // ---- public surface --------------------------------------------------

  return {
    get heartbeat() {
      return heartbeat;
    },
    get cronJob() {
      return cronJob;
    },
    start(): void {
      if (started) return;
      // Order matters: heartbeat.start() must run BEFORE scheduleCron,
      // because scheduleCron only starts the per-cron timer when the
      // heartbeat is already running. Reversing the order leaves the cron
      // job registered but never firing.
      heartbeat.start();
      // Pin the cron id to the operator-supplied jobId so the brief
      // directory, persisted record, and per-job lockfile all use the same
      // key — and so two daemon replicas can coordinate via the per-job
      // lock added in #37.
      cronJob = heartbeat.scheduleCron({
        id: jobId,
        label: cfg.jobLabel ?? jobId,
        prompt: cfg.role, // not used by the cron timer; kept for traceability
        userId,
        intervalMs,
        recurring: true,
        wakeGate: cfg.wakeGate,
      });
      started = true;
    },
    stop(): void {
      heartbeat.stop();
      started = false;
    },
    async tickOnce(): Promise<TickEvent> {
      // Manual / test seam: the cron timer normally calls markRunStart
      // inside execute(); when we bypass the timer we must prime the
      // persisted record ourselves, otherwise markJobSucceeded / Failed
      // would silently no-op (markRunSuccess only updates an existing
      // record). No-op when persistence is off.
      if (heartbeat.hasPersistence) {
        await heartbeat.markJobStart(jobId, { intervalMs }).catch(() => {});
      }
      return runTick(newTickId());
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TickCounts {
  calls: number;
  warnings: number;
  blocks: number;
}

/**
 * Wrap each tool's `execute` so the guardrail decides whether to allow,
 * warn, or block. Returns undefined (so generateText omits the tools field)
 * when no tools were provided.
 */
interface ToolCallCtx {
  jobId: string;
  tickId: string;
  onToolCall: (event: ToolCallEvent) => void;
}

function wrapTools(
  tools: ToolSet | undefined,
  guard: ToolGuardController,
  counts: TickCounts,
  toolCallCtx: ToolCallCtx,
): ToolSet | undefined {
  if (!tools) return undefined;
  const wrapped: ToolSet = {};
  for (const [name, def] of Object.entries(tools)) {
    wrapped[name] = wrapOneTool(name, def, guard, counts, toolCallCtx);
  }
  return wrapped;
}

function wrapOneTool(
  name: string,
  def: Tool,
  guard: ToolGuardController,
  counts: TickCounts,
  toolCallCtx: ToolCallCtx,
): Tool {
  const original = (def as { execute?: Tool["execute"] }).execute;
  if (!original) return def; // declarative-only tools (no runtime execute) — pass through

  const emit = (outcome: "ok" | "error" | "blocked", startedAt: number, reason?: string): void => {
    toolCallCtx.onToolCall({
      jobId: toolCallCtx.jobId,
      tickId: toolCallCtx.tickId,
      toolName: name,
      durationMs: Date.now() - startedAt,
      outcome,
      reason,
      timestamp: new Date().toISOString(),
    });
  };

  const wrappedExecute: NonNullable<Tool["execute"]> = async (args, ctx) => {
    const startedAt = Date.now();
    const decision = guard.beforeCall(name, args);
    if (decision.action === "block") {
      counts.blocks++;
      emit("blocked", startedAt, decision.message);
      return decision.syntheticResult as unknown;
    }
    if (decision.action === "warn") counts.warnings++;
    counts.calls++;
    let result: unknown;
    try {
      result = await original(args, ctx);
    } catch (err) {
      guard.afterCall(name, args, false);
      emit("error", startedAt, err instanceof Error ? err.message : String(err));
      throw err;
    }
    // Compute the digest defensively: a successful tool returning a
    // non-serialisable result (circular ref, BigInt, etc.) would otherwise
    // throw inside digestResult, get caught by the outer try, and be
    // miscounted as a failure. Pass undefined to skip same-result tracking.
    let digest: string | undefined;
    try {
      digest = digestResult(result);
    } catch {
      digest = undefined;
    }
    guard.afterCall(name, args, true, digest);
    emit("ok", startedAt);
    return result;
  };

  return { ...def, execute: wrappedExecute } as Tool;
}
