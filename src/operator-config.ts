/**
 * Operator Job Config — schema + loader for `~/.sportsclaw/operator/<jobId>.json`.
 *
 * One file per autonomous job. Read by `sportsclaw operate --job <jobId>`
 * and by the supervised form (`sportsclaw start operator <jobId>`).
 *
 * Required: jobId, intervalMs.
 * Persona: exactly one of `persona` (MCP-resolved by name) or `personaText`.
 *
 * No I/O outside `loadOperatorJobConfig` / `listOperatorJobs`. All other
 * helpers are pure validators so they're easy to test.
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

import type { LLMProvider, OpenShellConfig } from "./types.js";
import {
  validateModelRoleRouterConfig,
  type ModelRoleRouterConfig,
} from "./inference/model-role-router.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OperatorJobConfig {
  /** Unique job id. Must match the filename basename. */
  jobId: string;
  /** Human-readable label, shown in logs + supervisor. Defaults to jobId. */
  label?: string;
  /** Tick interval in ms. Must be > 0. */
  intervalMs: number;
  /**
   * Scheduling strategy for the foreground operator.
   *
   * - `fixed` (default): heartbeat starts a tick every `intervalMs`; the
   *   inference watchdog must remain shorter than the interval.
   * - `sink-polled`: the resolved sink polls for work every `intervalMs` and
   *   each accepted tick is awaited to completion before polling again. This
   *   is intended for interactive queues where pickup must be fast while an
   *   individual inference may take longer than the poll cadence.
   *
   * `sink-polled` requires the sink to implement `pollForWork`; the launcher
   * validates that runtime contract before starting the loop.
   */
  scheduleMode?: "fixed" | "sink-polled";
  /** EITHER an MCP-resolvable prompt name (resolved at runtime via get_prompt_by_name)... */
  persona?: string;
  /** ...OR inline persona text. One of these two is required. */
  personaText?: string;
  /** AI SDK model id. Defaults to sportsclaw config. */
  model?: string;
  /** Provider override. Defaults to sportsclaw config. */
  provider?: LLMProvider;
  /** Persistence + brief root. Defaults to ~/.sportsclaw/operator/<jobId>/. */
  rootDir?: string;
  /**
   * Domain-specific endpoint URL — sinks read this from `ctx.cfg.tailServer`
   * to know where to POST telemetry events. The bundled sportsclaw daemon
   * doesn't interpret this field directly; the resolved sink does.
   */
  tailServer?: string;
  /**
   * Domain plugin that hooks into the daemon's events. One of:
   *   - "noop"             → no-op sink (TickEvents stream to stdout)
   *   - "./path/to/sink"   → filesystem path (resolved against cwd)
   *   - "/abs/path/sink"   → absolute filesystem path
   *   - "@scope/package"   → npm package name (dynamic import)
   * Omit for the noop sink default.
   */
  sink?: string;
  /**
   * Extra system-prompt fragments. Each string is resolved against
   * prompts.ts exports first (e.g. "broadcast-directive" →
   * BROADCAST_DIRECTIVE_FRAGMENT) and used as inline text otherwise.
   */
  extraFragments?: string[];
  /**
   * Max output tokens per tick. Overrides the daemon default (which doubles
   * for structured-output jobs). Verbose-reasoning models (e.g. gpt-oss) can
   * exhaust a low budget on reasoning before emitting structured content.
   */
  maxOutputTokens?: number;
  /**
   * Wall-clock budget for a single inference call, in ms. Overrides the daemon
   * default (240s, or whatever the daemon sets). Raise for jobs whose ticks make
   * many slow tool calls (e.g. multi-workflow + market-data lookups) and would
   * otherwise hit the watchdog. Pair with an `intervalMs` larger than this so
   * ticks don't overlap.
   */
  inferenceTimeoutMs?: number;
  /** Stream the forced output tool's args (structured mode) — opt-in. */
  streamOutput?: boolean;
  /**
   * Max LLM steps (tool-call rounds) per tick. Overrides the daemon default.
   */
  maxSteps?: number;
  /**
   * Per-tick prompt template ({tickId} / {timestamp} substituted). Overrides
   * the daemon's domain-neutral default. Lets a job own its tick instruction
   * instead of inheriting a generic one.
   */
  tickPrompt?: string;
  /**
   * Sport-skill schemas to load for this job. When set, the launcher applies
   * the list as `SPORTSCLAW_SKILLS` for this process before `loadAllSchemas()`
   * is invoked — only the named skills' tools become available to the LLM.
   *
   * Why: the default behaviour loads every installed schema (~14 sports +
   * markets + metadata + betting → ~300 tool surfaces in a typical install).
   * For a focused job (e.g. a World Cup channel that only needs football +
   * news + prediction markets) this is wasteful in two ways: every tool
   * description goes into the system prompt, and the combination of the
   * full toolset with structured output (`OperatorSinkPlugin.getOutputSchema`)
   * trips a Gemini `responseSchema` complexity limit. Setting a tight
   * `skills` list fixes both.
   *
   * Strings should match schema filenames in `~/.sportsclaw/schemas/`
   * (without the `.json` suffix), e.g.
   * `["football","kalshi","polymarket","news","markets","metadata","betting"]`.
   *
   * Omit to keep the legacy "load everything" behaviour. Set `[]` to expose
   * no sports schemas while retaining MCP, sink, and daemon-owned tools.
   */
  skills?: string[];
  /** Tool guardrail overrides — passed through to ToolGuardController. */
  guardOptions?: Record<string, unknown>;
  /**
   * Free-form sink role flag. sportsclaw doesn't interpret it; the resolved
   * sink reads it via `ctx.cfg.sinkRole` to branch behaviour (e.g. the tv
   * broadcast sink switches between "broadcast" anchor mode and
   * "video-producer" cadence mode). Keep it short and slugged.
   *
   * Named `sinkRole` (not `role`) to avoid collision with
   * `OperatorDaemonConfig.role`, which holds the persona/system-prompt text.
   */
  sinkRole?: string;
  /**
   * Register the daemon-owned memory writeback tools (add_lesson,
   * replace_lesson, remove_lesson). The LLM can call these to evolve its
   * own cross-tick memory. Writes appear in the NEXT tick's system prompt
   * — the current tick sees a frozen snapshot. Default: true.
   */
  enableMemoryTools?: boolean;
  /**
   * Enable heartbeat state persistence + the cross-process per-job tick lock.
   * The lock exists to coordinate MULTIPLE daemon replicas of the same job so
   * they don't double-fire a tick. A single-replica operator (the common case,
   * e.g. one daemon in a sandbox) does not need it, and the lockfile lives on
   * whatever `stateDir` resolves to — on a restricted/overlay filesystem a
   * lock that fails to release cleanly stalls every subsequent tick (fires
   * once, then silently ELOCKED-skips). Set `false` to run the heartbeat fully
   * in-memory (overlapping ticks are still guarded by an in-process flag).
   * Default: true (unchanged behaviour for existing single/multi-replica jobs).
   */
  persistence?: boolean;
  /**
   * Opt in to routing LLM calls through NVIDIA OpenShell's Privacy Router.
   * Absent block = default direct LLM calls; nothing changes. When present
   * and enabled, the launcher constructs the AI SDK provider with a
   * `baseURL` pointing at `inference.local` (or the configured `baseUrl`).
   * See `openshell/README.md` for the deployment runbook.
   */
  openshell?: OpenShellConfig;
  /**
   * Model-role inference routing — maps `eyes/brain/hands/voice` roles to
   * OpenShell/NIM/mock routes. Consumed by `invokeModelRole` in
   * `inference/model-role-router.ts`. Hardware (locality/accelerator) is
   * runtime metadata only — callers request roles, never GPUs. Never put
   * credentials or endpoint tokens here.
   */
  inference?: ModelRoleRouterConfig;
  /**
   * Broadcast-safety validation gate. When `enabled` is true and the daemon
   * is in structured-output mode, the validated payload is passed through
   * `validateManifestCoverage(structuredOutput, options)`.
   *
   * On validation failure:
   *   - If `fallbackManifest` is configured, the daemon emits it in place
   *     of the model's output. The tick is `tick_published` with
   *     `safetyValidation.fallbackTriggered = true` and the original on
   *     `safetyValidation.originalOutput`.
   *   - If `fallbackManifest` is NOT configured, the tick escalates to
   *     `tick_failed`. The daemon refuses to invent broadcast content —
   *     supplying the fallback shape is the sink's responsibility, not the
   *     daemon's. The original output is still preserved on
   *     `safetyValidation.originalOutput` for trace.
   *
   * The gate only fires when both `outputSchema` and `broadcastSafety` are
   * set — sinks that don't model a broadcast manifest can ignore this.
   */
  broadcastSafety?: {
    enabled: boolean;
    options?: {
      minimumTotalDurationSec?: number;
      maximumTotalDurationSec?: number;
      requireFallbackForEveryBlock?: boolean;
      requireFreshnessForLiveBlocks?: boolean;
      maxLiveAgeMs?: number;
      nowMs?: number;
      expectedBlockCountMin?: number;
    };
    fallbackManifest?: unknown;
  };

  /**
   * operator-sync — route each PUBLISHED decision through the durable Machina
   * harness loop for independent verification. The loop's own generator/evaluator
   * (Cap 8 / 8.2) is a SECOND safety lens on top of `broadcastSafety`. Async and
   * durable: the verdict is read on the NEXT tick and injected as a directive.
   * Requires a connected Machina pod running the `loop-runner` agent. Off unless
   * `enabled`.
   */
  operatorSync?: {
    enabled: boolean;
    /** Reasoning persona the loop uses (default: "loop-reasoning"). */
    persona?: string;
  };
}

export interface ValidationIssue {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  /** Populated only when valid. */
  config?: OperatorJobConfig;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Directory holding all operator job configs. */
export function operatorConfigDir(): string {
  return path.join(homedir(), ".sportsclaw", "operator");
}

/** Path to the JSON file for a given jobId. */
export function operatorConfigPath(jobId: string): string {
  return path.join(operatorConfigDir(), `${jobId}.json`);
}

/** Default rootDir for a job — used by HeartbeatService persistence + briefs. */
export function defaultRootDir(jobId: string): string {
  return path.join(operatorConfigDir(), jobId);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_PROVIDERS: ReadonlySet<LLMProvider> = new Set<LLMProvider>([
  "anthropic",
  "openai",
  "google",
  "azure-foundry",
]);

const JOB_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Validate a parsed JSON object against the OperatorJobConfig schema.
 * Returns line-precise field errors via `issues`. `valid: true` guarantees
 * `config` is populated and safe to cast.
 */
export function validateOperatorJobConfig(
  input: unknown,
  opts: { sourcePath?: string } = {},
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const push = (field: string, message: string) => issues.push({ field, message });

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    push("", "expected a JSON object at the top level");
    return { valid: false, issues };
  }
  const raw = input as Record<string, unknown>;

  // jobId
  if (typeof raw.jobId !== "string" || !raw.jobId) {
    push("jobId", "missing required string");
  } else if (!JOB_ID_PATTERN.test(raw.jobId)) {
    push(
      "jobId",
      `must match ${JOB_ID_PATTERN.source} (got ${JSON.stringify(raw.jobId)})`,
    );
  } else if (opts.sourcePath) {
    const expected = path.basename(opts.sourcePath, ".json");
    if (raw.jobId !== expected) {
      push(
        "jobId",
        `jobId "${raw.jobId}" must match filename basename "${expected}"`,
      );
    }
  }

  // intervalMs
  if (typeof raw.intervalMs !== "number" || !Number.isFinite(raw.intervalMs)) {
    push("intervalMs", "missing required number");
  } else if (raw.intervalMs <= 0) {
    push("intervalMs", `must be > 0 (got ${raw.intervalMs})`);
  }

  // persona / personaText — exactly one required
  const hasPersona = typeof raw.persona === "string" && raw.persona.length > 0;
  const hasPersonaText =
    typeof raw.personaText === "string" && raw.personaText.length > 0;
  if (!hasPersona && !hasPersonaText) {
    push("persona|personaText", "exactly one of 'persona' or 'personaText' is required");
  } else if (hasPersona && hasPersonaText) {
    push(
      "persona|personaText",
      "exactly one of 'persona' or 'personaText' may be set, not both",
    );
  }
  if (raw.persona !== undefined && typeof raw.persona !== "string") {
    push("persona", "must be a string (MCP prompt name)");
  }
  if (raw.personaText !== undefined && typeof raw.personaText !== "string") {
    push("personaText", "must be a string");
  }

  // label
  if (raw.label !== undefined && typeof raw.label !== "string") {
    push("label", "must be a string");
  }

  // model
  if (raw.model !== undefined && typeof raw.model !== "string") {
    push("model", "must be a string");
  }

  // provider
  if (raw.provider !== undefined) {
    if (typeof raw.provider !== "string" || !VALID_PROVIDERS.has(raw.provider as LLMProvider)) {
      push(
        "provider",
        `must be one of ${[...VALID_PROVIDERS].join(", ")} (got ${JSON.stringify(raw.provider)})`,
      );
    }
  }

  // rootDir
  if (raw.rootDir !== undefined && typeof raw.rootDir !== "string") {
    push("rootDir", "must be a string");
  }

  // tailServer
  if (raw.tailServer !== undefined) {
    if (typeof raw.tailServer !== "string") {
      push("tailServer", "must be a string URL");
    } else {
      try {
        const url = new URL(raw.tailServer);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          push("tailServer", "must be http(s)");
        }
      } catch {
        push("tailServer", `not a valid URL: ${JSON.stringify(raw.tailServer)}`);
      }
    }
  }

  // sink
  if (raw.sink !== undefined && (typeof raw.sink !== "string" || !raw.sink.trim())) {
    push("sink", "must be a non-empty string (e.g. \"noop\", \"broadcast\", or a package/path)");
  }

  // maxOutputTokens
  if (raw.maxOutputTokens !== undefined) {
    if (
      typeof raw.maxOutputTokens !== "number" ||
      !Number.isFinite(raw.maxOutputTokens) ||
      raw.maxOutputTokens <= 0
    ) {
      push(
        "maxOutputTokens",
        `must be a positive number (got ${JSON.stringify(raw.maxOutputTokens)})`,
      );
    }
  }

  // streamOutput
  if (raw.streamOutput !== undefined && typeof raw.streamOutput !== "boolean") {
    push("streamOutput", `must be a boolean (got ${JSON.stringify(raw.streamOutput)})`);
  }

  // inferenceTimeoutMs / maxSteps
  for (const field of ["inferenceTimeoutMs", "maxSteps"] as const) {
    if (raw[field] !== undefined) {
      const v = raw[field];
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        push(field, `must be a positive integer (got ${JSON.stringify(v)})`);
      }
    }
  }

  // scheduleMode
  const scheduleMode = raw.scheduleMode ?? "fixed";
  if (scheduleMode !== "fixed" && scheduleMode !== "sink-polled") {
    push(
      "scheduleMode",
      `must be one of fixed, sink-polled (got ${JSON.stringify(raw.scheduleMode)})`,
    );
  }
  if (scheduleMode === "sink-polled" && !raw.sink) {
    push("scheduleMode", "sink-polled mode requires a configured sink");
  }

  // Fixed cadence keeps the conservative timeout<interval invariant (a longer
  // watchdog would just skip every other fire under tick single-flight — a
  // config smell worth rejecting). Sink-polled mode is serialized by the
  // foreground loop, so its inference budget may legitimately exceed the
  // (idle) poll cadence.
  if (raw.inferenceTimeoutMs !== undefined && raw.intervalMs !== undefined) {
    const timeout = raw.inferenceTimeoutMs;
    const interval = raw.intervalMs;
    if (
      scheduleMode === "fixed" &&
      typeof timeout === "number" &&
      typeof interval === "number" &&
      timeout >= interval
    ) {
      push(
        "inferenceTimeoutMs",
        `must be strictly less than intervalMs (${interval}ms) to prevent overlapping execution`
      );
    }
  }

  // extraFragments
  if (raw.extraFragments !== undefined) {
    if (!Array.isArray(raw.extraFragments)) {
      push("extraFragments", "must be an array of strings");
    } else {
      for (let i = 0; i < raw.extraFragments.length; i++) {
        if (typeof raw.extraFragments[i] !== "string") {
          push(`extraFragments[${i}]`, "must be a string");
        }
      }
    }
  }

  // skills — sport-skill filter applied as SPORTSCLAW_SKILLS by the launcher
  if (raw.skills !== undefined) {
    if (!Array.isArray(raw.skills)) {
      push("skills", "must be an array of strings");
    } else {
      for (let i = 0; i < raw.skills.length; i++) {
        if (typeof raw.skills[i] !== "string") {
          push(`skills[${i}]`, "must be a string");
        }
      }
    }
  }

  // guardOptions
  if (
    raw.guardOptions !== undefined &&
    (typeof raw.guardOptions !== "object" || raw.guardOptions === null || Array.isArray(raw.guardOptions))
  ) {
    push("guardOptions", "must be an object");
  }

  // enableMemoryTools
  if (raw.enableMemoryTools !== undefined && typeof raw.enableMemoryTools !== "boolean") {
    push("enableMemoryTools", "must be a boolean");
  }

  // persistence
  if (raw.persistence !== undefined && typeof raw.persistence !== "boolean") {
    push("persistence", "must be a boolean");
  }

  // openshell — optional opt-in routing block
  let parsedOpenShell: OpenShellConfig | undefined;
  if (raw.openshell !== undefined) {
    if (typeof raw.openshell !== "object" || raw.openshell === null || Array.isArray(raw.openshell)) {
      push("openshell", "must be an object");
    } else {
      const os = raw.openshell as Record<string, unknown>;
      if (os.enabled !== undefined && typeof os.enabled !== "boolean") {
        push("openshell.enabled", "must be a boolean");
      }
      if (os.baseUrl !== undefined) {
        if (typeof os.baseUrl !== "string") {
          push("openshell.baseUrl", "must be a string URL");
        } else {
          try {
            const url = new URL(os.baseUrl);
            if (url.protocol !== "http:" && url.protocol !== "https:") {
              push("openshell.baseUrl", "must be http(s)");
            }
          } catch {
            push("openshell.baseUrl", `not a valid URL: ${JSON.stringify(os.baseUrl)}`);
          }
        }
      }
      // D1 — Gemini cannot route through the Privacy Router (Google's API
      // shape is neither OpenAI-compatible nor Anthropic-compatible). Fail
      // fast at config-load time rather than at the first generateText.
      const openShellEnabled = os.enabled !== false; // default true when block present
      if (openShellEnabled && raw.provider === "google") {
        push(
          "openshell",
          "provider \"google\" is not supported under openshell — the Privacy Router doesn't speak Google's protocol. Drop the openshell block or pick provider \"anthropic\" / \"openai\".",
        );
      }
      // azure-foundry targets Azure endpoints directly, not the Privacy
      // Router's inference.local — the two are mutually exclusive.
      if (openShellEnabled && raw.provider === "azure-foundry") {
        push(
          "openshell",
          "provider \"azure-foundry\" is not supported under openshell — it targets Azure endpoints, not the Privacy Router. Drop the openshell block or pick provider \"anthropic\" / \"openai\".",
        );
      }
      parsedOpenShell = {
        enabled: os.enabled as boolean | undefined,
        baseUrl: os.baseUrl as string | undefined,
      };
    }
  }

  // inference — model-role router config, validated by its own module
  if (raw.inference !== undefined) {
    const inferenceCheck = validateModelRoleRouterConfig(raw.inference);
    if (!inferenceCheck.ok) {
      push("inference", inferenceCheck.error);
    }
  }

  // broadcastSafety
  if (raw.broadcastSafety !== undefined) {
    if (typeof raw.broadcastSafety !== "object" || raw.broadcastSafety === null || Array.isArray(raw.broadcastSafety)) {
      push("broadcastSafety", "must be an object");
    } else {
      const bs = raw.broadcastSafety as Record<string, unknown>;
      if (bs.enabled !== undefined && typeof bs.enabled !== "boolean") {
        push("broadcastSafety.enabled", "must be a boolean");
      }
      if (bs.options !== undefined) {
        if (typeof bs.options !== "object" || bs.options === null || Array.isArray(bs.options)) {
          push("broadcastSafety.options", "must be an object");
        } else {
          const opts = bs.options as Record<string, unknown>;
          if (opts.minimumTotalDurationSec !== undefined && typeof opts.minimumTotalDurationSec !== "number") {
            push("broadcastSafety.options.minimumTotalDurationSec", "must be a number");
          }
          if (opts.maximumTotalDurationSec !== undefined && typeof opts.maximumTotalDurationSec !== "number") {
            push("broadcastSafety.options.maximumTotalDurationSec", "must be a number");
          }
          if (opts.requireFallbackForEveryBlock !== undefined && typeof opts.requireFallbackForEveryBlock !== "boolean") {
            push("broadcastSafety.options.requireFallbackForEveryBlock", "must be a boolean");
          }
          if (opts.requireFreshnessForLiveBlocks !== undefined && typeof opts.requireFreshnessForLiveBlocks !== "boolean") {
            push("broadcastSafety.options.requireFreshnessForLiveBlocks", "must be a boolean");
          }
          if (opts.maxLiveAgeMs !== undefined && typeof opts.maxLiveAgeMs !== "number") {
            push("broadcastSafety.options.maxLiveAgeMs", "must be a number");
          }
          if (opts.expectedBlockCountMin !== undefined && typeof opts.expectedBlockCountMin !== "number") {
            push("broadcastSafety.options.expectedBlockCountMin", "must be a number");
          }
        }
      }
    }
  }

  // operatorSync
  if (raw.operatorSync !== undefined) {
    if (typeof raw.operatorSync !== "object" || raw.operatorSync === null || Array.isArray(raw.operatorSync)) {
      push("operatorSync", "must be an object");
    } else {
      const os = raw.operatorSync as Record<string, unknown>;
      if (os.enabled !== undefined && typeof os.enabled !== "boolean") {
        push("operatorSync.enabled", "must be a boolean");
      }
      if (os.persona !== undefined && typeof os.persona !== "string") {
        push("operatorSync.persona", "must be a string");
      }
    }
  }

  if (raw.tickPrompt !== undefined && typeof raw.tickPrompt !== "string") {
    push("tickPrompt", "must be a string");
  }

  if (issues.length > 0) {
    return { valid: false, issues };
  }

  return {
    valid: true,
    issues: [],
    config: {
      jobId: raw.jobId as string,
      label: raw.label as string | undefined,
      intervalMs: raw.intervalMs as number,
      scheduleMode: scheduleMode as OperatorJobConfig["scheduleMode"],
      tickPrompt: raw.tickPrompt as string | undefined,
      persona: raw.persona as string | undefined,
      personaText: raw.personaText as string | undefined,
      model: raw.model as string | undefined,
      provider: raw.provider as LLMProvider | undefined,
      rootDir: raw.rootDir as string | undefined,
      tailServer: raw.tailServer as string | undefined,
      sink: raw.sink as string | undefined,
      extraFragments: raw.extraFragments as string[] | undefined,
      maxOutputTokens: raw.maxOutputTokens as number | undefined,
      inferenceTimeoutMs: raw.inferenceTimeoutMs as number | undefined,
      maxSteps: raw.maxSteps as number | undefined,
      skills: raw.skills as string[] | undefined,
      guardOptions: raw.guardOptions as Record<string, unknown> | undefined,
      sinkRole: raw.sinkRole as string | undefined,
      enableMemoryTools: raw.enableMemoryTools as boolean | undefined,
      persistence: raw.persistence as boolean | undefined,
      streamOutput: raw.streamOutput as boolean | undefined,
      openshell: parsedOpenShell,
      inference: raw.inference as ModelRoleRouterConfig | undefined,
      broadcastSafety: raw.broadcastSafety as OperatorJobConfig["broadcastSafety"],
      operatorSync: raw.operatorSync as OperatorJobConfig["operatorSync"],
    },
  };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/** Load + validate a job config by id. Throws with line-precise errors on failure. */
export function loadOperatorJobConfig(jobId: string): { config: OperatorJobConfig; path: string } {
  if (!jobId || !JOB_ID_PATTERN.test(jobId)) {
    throw new Error(
      `Invalid jobId ${JSON.stringify(jobId)} — must match ${JOB_ID_PATTERN.source}`,
    );
  }
  const filePath = operatorConfigPath(jobId);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Operator job config not found: ${filePath}`);
  }
  let parsed: unknown;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to read ${filePath}: ${err instanceof Error ? err.message : err}`,
    );
  }
  const result = validateOperatorJobConfig(parsed, { sourcePath: filePath });
  if (!result.valid || !result.config) {
    const lines = result.issues.map((i) => `  - ${i.field || "<root>"}: ${i.message}`);
    throw new Error(
      `Operator job config invalid: ${filePath}\n${lines.join("\n")}`,
    );
  }
  return { config: result.config, path: filePath };
}

/** List all job config files in `~/.sportsclaw/operator/`. */
export function listOperatorJobs(): Array<{ jobId: string; path: string }> {
  const dir = operatorConfigDir();
  if (!fs.existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const jobId = f.slice(0, -".json".length);
      return { jobId, path: path.join(dir, f) };
    })
    // Operator-controlled filenames may not match JOB_ID_PATTERN — quietly hide
    // those rather than fail listing.
    .filter(({ jobId }) => JOB_ID_PATTERN.test(jobId))
    .sort((a, b) => (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0));
}
