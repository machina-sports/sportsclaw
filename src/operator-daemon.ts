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
  jsonSchema,
  hasToolCall,
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
import { buildMemoryTools } from "./operator-memory-tools.js";
import {
  ToolGuardController,
  digestResult,
  type ToolGuardOptions,
} from "./guardrails.js";
import type { InferenceRoute } from "./types.js";
import { validateManifestCoverage, type ManifestCoverageOptions, type DecisionRecord, type AgentRunRecord, type IncidentRecord } from "./schema/tv.js";
import type { McpManager } from "./mcp.js";
import { FileAgentRunLedger, PodOperatorRunsLedger } from "./operator-runs.js";
import { FileIncidentLedger, PodIncidentLedger } from "./incident-log.js";

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
  /**
   * Structured output validated against `cfg.outputSchema`. Populated only
   * when the daemon ran in structured-output mode (i.e. cfg.outputSchema
   * was provided) and the model emitted a valid object. When this is set,
   * `text` is populated with the schema's `narrative` field (if any) for
   * backwards compatibility with text-consuming sinks. Sinks aware of
   * structured output should prefer `output` over re-parsing `text` —
   * the SDK already validated the shape and there's no envelope-leak risk.
   */
  output?: unknown;
  /** Reason string for skipped, error message for failed. */
  reason?: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Counts captured from the per-tick guardrail. */
  toolCalls?: number;
  guardrailWarnings?: number;
  guardrailBlocks?: number;
  /**
   * Inference routing snapshot. Set when the launcher knows where the
   * tick's LLM calls go (always populated in production; absent in some
   * lightweight tests). Sinks unaware of this field can ignore it.
   */
  inferenceRoute?: InferenceRoute;
  /**
   * Optional safety validation summary. Populated when broadcast safety
   * checks are configured and executed on the tick's output.
   */
  safetyValidation?: {
    passed: boolean;
    error?: string;
    fallbackTriggered: boolean;
    originalOutput?: unknown;
  };
  /**
   * Outcome of the per-tick ledger sync (local JSONL + optional Pod MCP).
   * Populated whenever the daemon's audit ledger code ran for this tick.
   * Lets downstream observers detect Pod-sync drift (the local trail wrote
   * fine but the Pod copy never landed) instead of relying on stderr scrapes.
   *
   *   localRun     — `ok` | `failed` | `skipped` (no writer configured)
   *   podRun       — `ok` | `failed` | `skipped` (no MCP server)
   *   localIncident, podIncident — present only when an incident was raised
   *
   * Errors are surfaced as short strings; full traces still go to stderr.
   */
  ledgerSync?: {
    localRun: "ok" | "failed" | "skipped";
    localRunError?: string;
    podRun: "ok" | "failed" | "skipped";
    podRunError?: string;
    localIncident?: "ok" | "failed";
    localIncidentError?: string;
    podIncident?: "ok" | "failed" | "skipped";
    podIncidentError?: string;
  };
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
  /** Optional broadcast safety validation options. */
  broadcastSafety?: {
    enabled: boolean;
    options?: ManifestCoverageOptions;
    fallbackManifest?: unknown;
  };
  /** Per-tick user prompt template. `{tickId}` and `{timestamp}` are substituted. */
  tickPrompt?: string;
  /** Tools handed to the model. Each tool's `execute` is wrapped by the guardrail. */
  tools?: ToolSet;
  /** Max output tokens for the tick. Default 2048. */
  maxOutputTokens?: number;
  /** Maximum LLM steps per tick. Default 8. Allows the model to call tools
   *  and then produce a final synthesis text within one tick. */
  maxSteps?: number;
  /**
   * Wall-clock budget for a single inference call, in ms. When exceeded the
   * daemon aborts the generateText call and fails the tick, so the next tick
   * can start on schedule. Defaults to 60_000 (60s). Set explicitly to a
   * smaller value during testing, or larger for slow inference targets.
   *
   * Why this exists: GPT-OSS-class models can stall in their reasoning
   * channel for minutes, producing no usable output. Without a watchdog,
   * a single stall blocks the 90s tick schedule indefinitely and the
   * channel goes dark.
   */
  inferenceTimeoutMs?: number;
  /**
   * Register the daemon-owned memory writeback tools (add_lesson,
   * replace_lesson, remove_lesson) bound to this job's EditorialMemory.
   * Writes hit disk immediately but the in-prompt memory snapshot for the
   * current tick is frozen — new lessons appear next tick. Default: true.
   */
  enableMemoryTools?: boolean;
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

  /**
   * Pre-tick context composer. Called once per tick BEFORE generateText.
   * Returned string is prepended to the tick prompt — the place to inject
   * deterministic, daemon-side directives the LLM cannot ignore (e.g. a
   * scored rotation pool computed from external data). Errors are caught
   * and logged; the tick proceeds without the directive.
   */
  onComposeTickContext?: (args: {
    jobId: string;
    tickId: string;
    timestamp: string;
  }) => Promise<string | null | undefined> | string | null | undefined;

  /**
   * Optional structured output spec. When provided, the daemon configures
   * the LLM call with Vercel AI SDK's `experimental_output: Output.object()`
   * — the model is forced to emit a JSON object validated against `schema`.
   *
   * The shape is the same one returned by `OperatorSinkPlugin.getOutputSchema`:
   *   { schema: <JSON Schema object>, name?: string, description?: string }
   *
   * Two consequences when set:
   *   1. The `silentSentinel: true` system-prompt fragment is suppressed —
   *      the model expresses "skip" via the schema's `silent` field
   *      (sinks that want silent capability should include it in their schema).
   *   2. The emitted `TickEvent.output` carries the parsed object; `text`
   *      gets the object's `narrative` field if present (for backwards
   *      compat with sinks that still read text).
   *
   * Omit to keep the legacy free-text path (with `[SILENT]` sentinel parsing).
   */
  outputSchema?: {
    schema: unknown;
    name?: string;
    description?: string;
  };

  /** Inject a HeartbeatService (tests). Default: a fresh instance. */
  heartbeat?: HeartbeatService;
  /** Inject a generateText impl (tests). Default: ai SDK's. */
  generateTextImpl?: typeof generateText;
  /** MCP manager handle (for ledger syncing to the Pod) */
  mcpManager?: McpManager;
  /**
   * Inference routing snapshot. The launcher passes this so every emitted
   * TickEvent carries the routing decision (direct vs. openshell, base URL,
   * provider, model). Omit to leave the field off TickEvents.
   */
  inferenceRoute?: InferenceRoute;
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

// Bumped 2048 → 4096 after observing repeated NoOutputGeneratedError stalls on
// GPT-OSS-120B's structured-output path. The model's reasoning channel and
// the final JSON share the same completion budget; structured mode doubles
// this to 8192, giving reasoning enough headroom to commit a final answer
// before running out.
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
// Trimmed 16 → 10 after seeing ticks spend 7-8 tool calls + still time out.
// Capping steps forces the model to commit to a synthesis sooner; the
// remaining headroom is healthy.
const DEFAULT_MAX_STEPS = 10;
const DEFAULT_INFERENCE_TIMEOUT_MS = 60_000;
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
      inferenceRoute: cfg.inferenceRoute,
    });

    // 1. Frozen memory snapshot for this tick.
    await memory.load();
    const memorySnapshot = memory.snapshot();

    // 2. Recent brief context across the configured job set.
    const recentTickBrief = await briefStore.contextFrom(recentBriefJobIds, {
      perJobLimit: recentBriefLimit,
    });

    // 3. System prompt composition. When structured output is in play, the
    // `[SILENT]` sentinel mechanism is replaced by a `silent` field on the
    // schema — suppress the prompt fragment so the model doesn't get two
    // conflicting instructions for the same "skip this tick" intent.
    const useStructuredOutput = !!cfg.outputSchema;
    const OUTPUT_TOOL_NAME = "submit_broadcast";
    const baseSystem = buildSystemPrompt({
      role: cfg.role,
      isCron: true,
      toolDiscipline: true,
      silentSentinel: !useStructuredOutput,
      editorialMemorySnapshot: memorySnapshot,
      recentTickBrief,
      extras: cfg.extraFragments,
    });
    // Structured output travels via a forced tool call (the OpenShell Privacy
    // Router forwards `tools` but strips `response_format`/json-schema, so the
    // SDK's experimental_output yields empty objects through the router).
    const system = useStructuredOutput
      ? `${baseSystem}\n\n## Final output (MANDATORY — this overrides ALL earlier output instructions)\nYou MUST deliver your output by calling the \`${OUTPUT_TOOL_NAME}\` tool. NEVER write the literal text \`[SILENT]\`, narrative prose, JSON, or a code block in your message — any such message text is discarded and the tick is lost. Call \`${OUTPUT_TOOL_NAME}\` exactly once as your final action. Strongly prefer broadcasting: set silent=false with a full narrative whenever you have ANY World Cup buildup, fixture, market, or storyline to cover (you almost always do). Only set silent=true if every data source this tick was empty or errored. Any earlier instruction to emit \`[SILENT]\` as text is OBSOLETE — express silence by calling the tool with silent=true, never as text.`
      : baseSystem;

    // 4. Wrap tools with the guardrail.
    const guard = new ToolGuardController(cfg.guardOptions);
    const counts = { calls: 0, warnings: 0, blocks: 0 };
    const toolCallSink = (event: ToolCallEvent): void => {
      try { cfg.onToolCall?.(event); } catch { /* swallow */ }
    };
    // Daemon-owned tools: memory writeback (add/replace/remove_lesson)
    // tied to THIS tick's live EditorialMemory instance. Writes hit disk
    // immediately but the in-prompt snapshot above is frozen — new lessons
    // appear in the next tick's prompt. Opt out via cfg.enableMemoryTools=false.
    const daemonOwnedTools: ToolSet =
      cfg.enableMemoryTools === false ? {} : buildMemoryTools(memory);
    const mergedTools: ToolSet = { ...(cfg.tools ?? {}), ...daemonOwnedTools };
    const wrappedTools = wrapTools(
      mergedTools, guard, counts,
      { jobId: cfg.jobId, tickId, onToolCall: toolCallSink },
    );

    // 4b. Optional pre-tick context — sink-supplied deterministic directive
    // injected ahead of the tick prompt. Used to feed the LLM constraints
    // computed from external data (rotation pool, live-match cue, etc.) that
    // we don't want depending on the LLM's discretion to call a tool for.
    let preTickDirective = "";
    if (cfg.onComposeTickContext) {
      try {
        const directive = await cfg.onComposeTickContext({ jobId, tickId, timestamp });
        if (typeof directive === "string" && directive.trim().length > 0) {
          preTickDirective = directive.trim() + "\n\n";
        }
      } catch (err) {
        console.error(
          `[operator-daemon] onComposeTickContext threw (tick ${tickId}): ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    const tickPrompt = preTickDirective + tickPromptTemplate
      .replace("{tickId}", tickId)
      .replace("{timestamp}", timestamp);

    // 5. LLM pass. Two flavours:
    //   - Free-text mode (legacy): result.text holds the raw model output;
    //     `[SILENT]` is matched downstream.
    //   - Structured mode: `experimental_output: Output.object({schema})`
    //     constrains + validates the model's final answer; result.experimental_output
    //     holds the parsed object. text is set to the object's narrative (when
    //     present) for backwards-compat with text-consuming sinks.
    let text = "";
    let structuredOutput: unknown;
    let failureReason: string | undefined;
    // Output tool: a declarative (execute-less) tool whose inputSchema is the
    // broadcast schema. Added *after* the guard wrap so it bypasses the
    // guardrail (it's our own sink, not a model-discovered tool), and
    // `hasToolCall` stops generation once the model submits it.
    const outputToolTools: ToolSet | undefined = useStructuredOutput
      ? {
          ...(wrappedTools ?? {}),
          [OUTPUT_TOOL_NAME]: {
            description:
              cfg.outputSchema!.description ??
              "Submit the final broadcast for this tick. Call exactly once, as your last action, with all required fields. Set silent=true to skip airing.",
            inputSchema: jsonSchema(cfg.outputSchema!.schema as object),
          } as Tool,
        }
      : wrappedTools;
    // Wall-clock watchdog. If the model stalls (e.g. GPT-OSS reasoning loop
    // burns through the output budget without committing to a final response)
    // the AbortController fires after inferenceTimeoutMs and the generateText
    // call rejects. The existing catch block below records it as a tick
    // failure; the daemon schedules the next tick normally.
    const inferenceTimeoutMs =
      cfg.inferenceTimeoutMs ?? DEFAULT_INFERENCE_TIMEOUT_MS;
    const abortController = new AbortController();
    const watchdog = setTimeout(() => {
      abortController.abort(
        new Error(
          `inference watchdog timeout after ${inferenceTimeoutMs}ms`,
        ),
      );
    }, inferenceTimeoutMs);

    try {
      const result = await generateImpl({
        model: cfg.model,
        system,
        prompt: tickPrompt,
        ...(outputToolTools ? { tools: outputToolTools } : {}),
        abortSignal: abortController.signal,
        // Structured-output mode emits the full schema payload (narrative +
        // arrays) plus tool-call reasoning in one budget. 2048 is fine for
        // free-text ticks; tight for structured ones. Bump the default when
        // `cfg.outputSchema` is set so the model has headroom to finish.
        maxOutputTokens:
          cfg.maxOutputTokens ??
          (useStructuredOutput
            ? DEFAULT_MAX_OUTPUT_TOKENS * 2
            : DEFAULT_MAX_OUTPUT_TOKENS),
        // Allow the model multiple steps so it can call tools and THEN
        // produce a final synthesis text. Without stopWhen, generateText
        // takes a single step and ends with empty text whenever the
        // model chose to call tools first.
        stopWhen: useStructuredOutput
          ? [
              stepCountIs(cfg.maxSteps ?? DEFAULT_MAX_STEPS),
              hasToolCall(OUTPUT_TOOL_NAME),
            ]
          : stepCountIs(cfg.maxSteps ?? DEFAULT_MAX_STEPS),
      });
      if (useStructuredOutput) {
        // Structured output arrives as the input of the forced
        // `submit_broadcast` tool call (the Privacy Router strips
        // `response_format`, so `experimental_output` would come back empty).
        // If the model never called the tool, treat the tick as silent rather
        // than failing it.
        const toolCalls = (result.toolCalls ?? []) as Array<{
          toolName: string;
          input?: unknown;
        }>;
        const outCall = [...toolCalls]
          .reverse()
          .find((c) => c.toolName === OUTPUT_TOOL_NAME);
        structuredOutput = outCall ? outCall.input : undefined;
        const narrative =
          structuredOutput &&
          typeof structuredOutput === "object" &&
          typeof (structuredOutput as { narrative?: unknown }).narrative ===
            "string"
            ? ((structuredOutput as { narrative: string }).narrative).trim()
            : "";
        // text is the synthesised narrative (for back-compat) when the
        // object has one; otherwise empty.
        text = narrative;
      } else {
        text = (result.text ?? "").trim();
      }
    } catch (err) {
      // AI_APICallError shapes its message as "Unknown" when the upstream
      // returns a non-JSON body the SDK can't parse into a structured error
      // (e.g. plain-text "404 page not found"). Pull statusCode + a body
      // excerpt so the failureReason is actionable instead of opaque.
      //
      // For NoObjectGeneratedError / NoOutputGeneratedError (structured-output
      // path) the SDK carries the raw model output and finish reason on the
      // error object itself — invaluable diagnostic data that the previous
      // catch block was silently discarding. Extract them so structured-
      // output failures surface what the model actually emitted, why the SDK
      // refused it, and how the token budget was spent.
      if (err instanceof Error) {
        const apiErr = err as Error & {
          statusCode?: number;
          url?: string;
          responseBody?: string;
          // SDK NoObjectGenerated / NoOutputGenerated shape:
          text?: string;
          usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
          finishReason?: string;
          cause?: unknown;
        };
        const parts: string[] = [err.message || err.name];
        if (apiErr.statusCode !== undefined) parts.push(`status=${apiErr.statusCode}`);
        if (apiErr.url) parts.push(`url=${apiErr.url}`);
        if (apiErr.responseBody) {
          const body = String(apiErr.responseBody).trim().slice(0, 200);
          if (body) parts.push(`body=${JSON.stringify(body)}`);
        }
        if (apiErr.finishReason) parts.push(`finish=${apiErr.finishReason}`);
        if (apiErr.usage) {
          const u = apiErr.usage;
          const tokens: string[] = [];
          if (u.inputTokens !== undefined) tokens.push(`in=${u.inputTokens}`);
          if (u.outputTokens !== undefined) tokens.push(`out=${u.outputTokens}`);
          if (u.totalTokens !== undefined) tokens.push(`total=${u.totalTokens}`);
          if (tokens.length) parts.push(`usage(${tokens.join(",")})`);
        }
        if (apiErr.text !== undefined) {
          // Truncate aggressively for the inline reason. The full payload is
          // also logged to stderr immediately below so it survives even if
          // the brief truncation drops something interesting.
          const t = String(apiErr.text).trim().replace(/\s+/g, " ");
          parts.push(`text=${JSON.stringify(t.slice(0, 400))}`);
        }
        if (apiErr.cause) {
          const causeStr =
            apiErr.cause instanceof Error
              ? `${apiErr.cause.name}: ${apiErr.cause.message}`
              : String(apiErr.cause);
          parts.push(`cause=${JSON.stringify(causeStr.slice(0, 200))}`);
        }
        failureReason = parts.join(" ");

        // Unconditional one-line stderr breadcrumb for any inference failure.
        // Previous version only printed when text/cause was non-empty, which
        // missed NoOutputGeneratedError entirely (no text, no cause on that
        // class) and left /sandbox/operator.log silent on 2.5-minute stalls.
        // This line guarantees at least one record per failed tick so we can
        // distinguish failure modes without re-running.
        console.error(
          `[operator-daemon] inference failure · class=${err.name} · ${failureReason}`,
        );

        // Always dump the full raw model output to stderr when we have it —
        // this is the only place the operator's response on a failed tick
        // survives. The truncated `text` in failureReason above is a hint;
        // this is the source-of-truth for diagnosis.
        if (apiErr.text !== undefined) {
          console.error(
            `[operator-daemon] structured-output failure raw text (${String(apiErr.text).length} chars):\n${apiErr.text}`,
          );
        }
        if (apiErr.cause) {
          console.error(
            `[operator-daemon] structured-output failure cause:`,
            apiErr.cause,
          );
        }
      } else {
        failureReason = String(err);
      }
    } finally {
      // Always release the watchdog so the timer doesn't keep the event loop
      // alive past the tick. Safe to call even if the timer already fired.
      clearTimeout(watchdog);
    }

    // Broadcast Safety Validation Gate.
    // The fallback must be supplied by the caller — the daemon refuses to
    // invent broadcast content. Without a configured `fallbackManifest`,
    // a failed safety check turns into a `tick_failed` event so the sink
    // can apply its own emergency-slate logic rather than viewers seeing
    // a daemon-shaped fake.
    let safetyValidation: TickEvent["safetyValidation"] = undefined;
    if (!failureReason && cfg.broadcastSafety?.enabled && useStructuredOutput && structuredOutput) {
      const validationOpts = cfg.broadcastSafety.options ?? {};
      const nowMs = Date.parse(timestamp);
      const validationResult = validateManifestCoverage(structuredOutput, {
        nowMs,
        ...validationOpts,
      });

      if (!validationResult.ok) {
        const originalOutput = structuredOutput;
        const fallbackManifest = cfg.broadcastSafety.fallbackManifest;

        if (fallbackManifest === undefined) {
          // No fallback supplied → escalate to tick_failed. The original
          // output is preserved on safetyValidation so the sink can still
          // observe what the model produced.
          failureReason =
            `Broadcast safety check failed and no fallbackManifest configured: ${validationResult.error}`;
          safetyValidation = {
            passed: false,
            error: validationResult.error,
            fallbackTriggered: false,
            originalOutput,
          };
        } else {
          structuredOutput = fallbackManifest;
          text = `Emergency fallback active: output failed broadcast safety checks. Error: ${validationResult.error}`;
          safetyValidation = {
            passed: false,
            error: validationResult.error,
            fallbackTriggered: true,
            originalOutput,
          };
        }
      } else {
        safetyValidation = {
          passed: true,
          fallbackTriggered: false,
        };
      }
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
        ...(structuredOutput !== undefined ? { payload: structuredOutput } : {}),
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

    const recordLedger = async (
      errorReason?: string,
      isSilent: boolean = false,
    ): Promise<NonNullable<TickEvent["ledgerSync"]>> => {
      const endedAt = new Date().toISOString();
      const decisions: DecisionRecord[] = [];

      if (errorReason) {
        decisions.push({
          id: `decision-${tickId}-fail`,
          timestamp: endedAt,
          action: "fail",
          reason: errorReason,
          agentId: jobId,
        });
      } else if (safetyValidation && safetyValidation.fallbackTriggered) {
        decisions.push({
          id: `decision-${tickId}-fallback`,
          timestamp: endedAt,
          action: "fallback",
          reason: safetyValidation.error || "Broadcast safety check failed",
          agentId: jobId,
          meta: { error: safetyValidation.error },
        });
      } else if (isSilent) {
        decisions.push({
          id: `decision-${tickId}-silent`,
          timestamp: endedAt,
          action: "silence",
          reason: "Model chose to remain silent (no worth-surfacing updates)",
          agentId: jobId,
        });
      } else {
        decisions.push({
          id: `decision-${tickId}-publish`,
          timestamp: endedAt,
          action: "publish",
          reason: text || "Published broadcast block",
          agentId: jobId,
        });
      }

      const runRecord: AgentRunRecord = {
        id: tickId,
        agentId: jobId,
        startedAt: timestamp,
        endedAt,
        decisions,
        status: errorReason ? "failed" : "completed",
      };

      const sync: NonNullable<TickEvent["ledgerSync"]> = {
        localRun: "skipped",
        podRun: "skipped",
      };
      const errMsg = (err: unknown): string =>
        err instanceof Error ? err.message : String(err);

      // 1. Write local run ledger
      try {
        const localRunLedger = new FileAgentRunLedger(path.join(cfg.rootDir, "operator-runs.jsonl"));
        await localRunLedger.append(runRecord);
        sync.localRun = "ok";
      } catch (err) {
        sync.localRun = "failed";
        sync.localRunError = errMsg(err);
        console.error(`[operator-daemon] Failed to write local agent run ledger: ${err}`);
      }

      // 2. Write local incident ledger if safety validation triggered fallback or failure
      if (errorReason || (safetyValidation && safetyValidation.fallbackTriggered)) {
        const incident: IncidentRecord = {
          id: `incident-${tickId}`,
          timestamp,
          level: errorReason ? "critical" : "error",
          message: errorReason ? `Tick crashed: ${errorReason}` : `Broadcast safety gate triggered fallback: ${safetyValidation?.error || "unknown validation error"}`,
          component: errorReason ? "operator-daemon" : "safety-gate",
          resolvedAt: timestamp,
          resolution: errorReason ? "System logged crash." : "Emergency playout fallback manifest loaded.",
          meta: { error: errorReason || safetyValidation?.error, jobId },
        };

        try {
          const localIncidentLedger = new FileIncidentLedger(path.join(cfg.rootDir, "incidents.jsonl"));
          await localIncidentLedger.append(incident);
          sync.localIncident = "ok";
        } catch (err) {
          sync.localIncident = "failed";
          sync.localIncidentError = errMsg(err);
          console.error(`[operator-daemon] Failed to write local incident ledger: ${err}`);
        }

        // Write MCP Incident Ledger if available
        sync.podIncident = "skipped";
        if (cfg.mcpManager) {
          const serverName = cfg.mcpManager.getMachinaServerName();
          if (serverName) {
            try {
              const podIncidentLedger = new PodIncidentLedger(cfg.mcpManager, serverName);
              await podIncidentLedger.append(incident);
              sync.podIncident = "ok";
            } catch (err) {
              sync.podIncident = "failed";
              sync.podIncidentError = errMsg(err);
              console.error(`[operator-daemon] Failed to sync incident to Pod: ${err}`);
            }
          }
        }
      }

      // 3. Write MCP run ledger if available
      if (cfg.mcpManager) {
        const serverName = cfg.mcpManager.getMachinaServerName();
        if (serverName) {
          try {
            const podRunLedger = new PodOperatorRunsLedger(cfg.mcpManager, serverName);
            await podRunLedger.append(runRecord);
            sync.podRun = "ok";
          } catch (err) {
            sync.podRun = "failed";
            sync.podRunError = errMsg(err);
            console.error(`[operator-daemon] Failed to sync agent run ledger to Pod: ${err}`);
          }
        }
      }
      return sync;
    };

    // 7. Heartbeat status + telemetry.
    // Event emission goes BEFORE recordLedger so sinks (Discord, Telegram,
    // broadcast surfaces) react at the speed of local I/O rather than the
    // speed of the Pod MCP round-trip. The ledger sync result is mutated
    // onto the same event object after the await — sinks that observed the
    // event synchronously won't see `ledgerSync`, but callers that await
    // `tickOnce()` (tests, batch consumers) read the final populated form.
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
        inferenceRoute: cfg.inferenceRoute,
        // When the failure comes from the safety gate (no fallback configured),
        // safetyValidation carries the original output and validator error.
        ...(safetyValidation !== undefined ? { safetyValidation } : {}),
      };
      cfg.onTickEvent?.(event);
      const ledgerSync = await recordLedger(failureReason).catch(() => undefined);
      if (ledgerSync) event.ledgerSync = ledgerSync;
      return event;
    }

    await heartbeat.markJobSucceeded(jobId).catch(() => {});

    // Silent decision:
    //   - structured-output mode: trust the schema's `silent` field. If the
    //     object never came back (SDK couldn't produce a valid match), also
    //     treat as silent rather than crashing. Do NOT also gate on
    //     `text.length === 0` — a schema-validated payload with silent=false
    //     but an empty narrative is *malformed*, not silent; the sink decides
    //     whether to suppress the overlay card (it has malformedBroadcast
    //     checks that emit nothing to viewers but still keep the trace).
    //   - free-text mode: keep the [SILENT] sentinel match on text.
    let silent: boolean;
    if (useStructuredOutput) {
      const obj = structuredOutput as { silent?: unknown } | undefined;
      silent = !obj || obj.silent === true;
    } else {
      silent = LastTickBrief.isSilent(text);
    }
    const event: TickEvent = {
      type: silent ? "tick_silent" : "tick_published",
      jobId,
      tickId,
      text: silent ? undefined : text,
      // Carry structured output even on silent ticks so downstream tools can
      // observe what the model chose to skip (debugging / metrics).
      ...(structuredOutput !== undefined ? { output: structuredOutput } : {}),
      timestamp,
      toolCalls: counts.calls,
      guardrailWarnings: counts.warnings,
      guardrailBlocks: counts.blocks,
      inferenceRoute: cfg.inferenceRoute,
      ...(safetyValidation !== undefined ? { safetyValidation } : {}),
    };
    cfg.onTickEvent?.(event);
    const ledgerSync = await recordLedger(undefined, silent).catch(() => undefined);
    if (ledgerSync) event.ledgerSync = ledgerSync;
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
        inferenceRoute: cfg.inferenceRoute,
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
