/**
 * Tool-call guardrails — anti-loop circuit breaker for autonomous tool use.
 *
 * A side-effect-free controller that hashes every tool call as
 * (tool_name, sha256(canonical_args)) and tracks three counters:
 *   1. consecutive identical-call failures   (same tool, same args, repeated fail)
 *   2. per-tool failures                     (any failure of this tool)
 *   3. idempotent same-result repeats        (read-only tool returning the same
 *                                             answer N times)
 *
 * On warn, callers append the message to the tool result so the LLM sees it
 * next iteration. On block, callers synthesise a `role=tool` result with
 * `{error, guardrail:{...}}` instead of running the tool — the model gets a
 * structured "stop retrying me" signal and changes strategy on its own.
 *
 * Adapted from Hermes' ToolCallGuardrailController. Pure data; no engine
 * dependency. The operator daemon (or engine.ts) wires it inside the tool-
 * execution wrapper around `tools` handed to `generateText` — this PR
 * defines the primitive only.
 *
 * Lifecycle: one controller per turn / per cron tick. Call `reset()` between
 * ticks. Counters survive across multiple tool calls within the same turn.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Stable identity of a (tool, args) pair. */
export interface ToolCallSignature {
  toolName: string;
  /** sha256 hex of canonical-stringified args. */
  argsHash: string;
}

/** Configurable thresholds + tool categorisation. */
export interface ToolGuardOptions {
  /** Identical (tool, args) failure count before warning. Default 3. */
  identicalFailureWarn?: number;
  /** Identical (tool, args) failure count before blocking. Default 5. */
  identicalFailureBlock?: number;
  /** Any-failures of one tool before warning. Default 5. */
  perToolFailureWarn?: number;
  /** Idempotent same-result repeats before warning. Default 3. */
  idempotentRepeatWarn?: number;
  /** Idempotent same-result repeats before blocking. Default 5. */
  idempotentRepeatBlock?: number;
  /**
   * Tool names safe to call repeatedly with the same args. Same-result
   * repeat detection only runs on tools in this set.
   */
  idempotentTools?: ReadonlySet<string>;
}

/** Decision returned by `beforeCall`. */
export interface BeforeCallDecision {
  action: "allow" | "warn" | "block";
  /** Human-readable reason; populated for warn and block. */
  message?: string;
  /**
   * On `block`, callers should return THIS instead of invoking the tool.
   * Shape mirrors what the LLM expects from a `role=tool` result.
   */
  syntheticResult?: { error: string; guardrail: GuardrailDetail };
  /** The signature this decision was computed for. */
  signature: ToolCallSignature;
}

/** Diagnostic counts at decision time. */
export interface GuardrailDetail {
  reason: string;
  toolName: string;
  consecutiveIdenticalFailures: number;
  perToolFailures: number;
  idempotentRepeats: number;
}

// ---------------------------------------------------------------------------
// Defaults — categorisation for tv-mcp tools
// ---------------------------------------------------------------------------

/**
 * Read-only / idempotent MCP tools commonly available on the machina-sports-tv
 * pod. The set is conservative — anything that *could* mutate is excluded.
 * Operators can override via `idempotentTools` in options.
 */
export const DEFAULT_IDEMPOTENT_TOOLS: ReadonlySet<string> = new Set([
  // pod-level reads
  "search_documents",
  "get_document",
  "search_workflow",
  "get_workflow_execution",
  "search_workflow_executions",
  "search_agents",
  "search_agent_executions",
  "get_agent",
  "get_agent_by_name",
  "get_agent_execution",
  "search_prompts",
  "get_prompt_by_id",
  "get_prompt_by_name",
  "connector_search",
  "connector_describe",
  "connector_endpoint",
  "connector_retrieve_id",
  "connector_retrieve_args",
  "mapping_search",
  "retrieve_mapping_id",
  "retrieve_mapping_args",
  "retrieve_workflow_id",
  "retrieve_workflow_args",
  "executor_workflow_id",
  "check_secrets",
  "health_check",
  "get_template_directories",
  "get_git_template_directories",
  "get_local_template",
]);

/**
 * State-mutating tools. Currently informational; reserved for future rules.
 * Any tool that creates / updates / deletes a document or queues a real-world
 * side effect belongs here.
 */
export const DEFAULT_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "create_document",
  "update_document",
  "delete_document",
  "bulk_delete_documents",
  "create_workflow",
  "update_workflow_id",
  "delete_workflow",
  "execute_workflow",
  "executor_workflow_name",
  "schedule_workflow_id",
  "schedule_workflow_name",
  "create_agent",
  "update_agent",
  "delete_agent",
  "execute_agent",
  "create_prompt",
  "update_prompt",
  "delete_prompt",
  "execute_prompt",
  "create_connector",
  "connector_update",
  "delete_connector",
  "connector_executor",
  "create_mapping",
  "update_mapping",
  "delete_mapping",
  "create_secrets",
  "import_templates",
  "import_templates_from_git",
]);

const DEFAULTS: Required<ToolGuardOptions> = {
  identicalFailureWarn: 3,
  identicalFailureBlock: 5,
  perToolFailureWarn: 5,
  idempotentRepeatWarn: 3,
  idempotentRepeatBlock: 5,
  idempotentTools: DEFAULT_IDEMPOTENT_TOOLS,
};

// ---------------------------------------------------------------------------
// ToolGuardController
// ---------------------------------------------------------------------------

export class ToolGuardController {
  private opts: Required<ToolGuardOptions>;
  /** sigKey -> consecutive failures since last success */
  private consecutiveIdenticalFailures = new Map<string, number>();
  /** toolName -> total failures this turn */
  private perToolFailures = new Map<string, number>();
  /** sigKey -> resultDigest -> count (idempotent tools only) */
  private perSigResults = new Map<string, Map<string, number>>();

  constructor(options: ToolGuardOptions = {}) {
    this.opts = {
      ...DEFAULTS,
      ...options,
      idempotentTools: options.idempotentTools ?? DEFAULTS.idempotentTools,
    };
  }

  /** Compute the canonical signature for a (tool, args) pair. */
  signature(toolName: string, args: unknown): ToolCallSignature {
    return { toolName, argsHash: hashCanonical(args) };
  }

  /**
   * Decide whether to allow / warn-and-allow / block this call. Pure read of
   * internal state — does NOT update counters. Counters update on
   * `afterCall()` once the tool actually ran (or was synthesised).
   */
  beforeCall(toolName: string, args: unknown): BeforeCallDecision {
    const signature = this.signature(toolName, args);
    const sigKey = sigKeyOf(signature);

    const consecutiveIdenticalFailuresN =
      this.consecutiveIdenticalFailures.get(sigKey) ?? 0;
    const perToolFailures = this.perToolFailures.get(toolName) ?? 0;
    const idempotentRepeats = this.maxIdempotentRepeat(sigKey);

    const detail: GuardrailDetail = {
      reason: "",
      toolName,
      consecutiveIdenticalFailures: consecutiveIdenticalFailuresN,
      perToolFailures,
      idempotentRepeats,
    };

    // BLOCK: same (tool, args) has failed too many times in a row
    if (consecutiveIdenticalFailuresN >= this.opts.identicalFailureBlock) {
      detail.reason = `Same (${toolName}, args) failed ${consecutiveIdenticalFailuresN} times in a row. Stop retrying — change the args, change the tool, or change strategy.`;
      return {
        action: "block",
        message: detail.reason,
        syntheticResult: { error: detail.reason, guardrail: { ...detail } },
        signature,
      };
    }

    // BLOCK: idempotent tool returning the same result over and over
    if (idempotentRepeats >= this.opts.idempotentRepeatBlock) {
      detail.reason = `Idempotent tool '${toolName}' returned the same result ${idempotentRepeats} times. The answer is not changing — stop polling.`;
      return {
        action: "block",
        message: detail.reason,
        syntheticResult: { error: detail.reason, guardrail: { ...detail } },
        signature,
      };
    }

    // WARN: same (tool, args) failures crossed warn threshold
    if (consecutiveIdenticalFailuresN >= this.opts.identicalFailureWarn) {
      detail.reason = `Tool loop warning: same (${toolName}, args) has failed ${consecutiveIdenticalFailuresN} times. Try a different approach.`;
      return { action: "warn", message: detail.reason, signature };
    }

    // WARN: per-tool failures crossed warn threshold (regardless of args)
    if (perToolFailures >= this.opts.perToolFailureWarn) {
      detail.reason = `Tool loop warning: tool '${toolName}' has failed ${perToolFailures} times this turn. Consider falling back.`;
      return { action: "warn", message: detail.reason, signature };
    }

    // WARN: idempotent same-result repeats crossed warn threshold
    if (idempotentRepeats >= this.opts.idempotentRepeatWarn) {
      detail.reason = `Tool loop warning: idempotent '${toolName}' returned the same result ${idempotentRepeats} times — the answer is not changing.`;
      return { action: "warn", message: detail.reason, signature };
    }

    return { action: "allow", signature };
  }

  /**
   * Record the outcome of a tool call. `ok=true` resets the consecutive-
   * failure counter for this (tool, args) signature. For idempotent tools,
   * pass `resultDigest` to enable same-result repeat detection.
   */
  afterCall(
    toolName: string,
    args: unknown,
    ok: boolean,
    resultDigest?: string,
  ): void {
    const sig = this.signature(toolName, args);
    const sigKey = sigKeyOf(sig);

    if (!ok) {
      this.consecutiveIdenticalFailures.set(
        sigKey,
        (this.consecutiveIdenticalFailures.get(sigKey) ?? 0) + 1,
      );
      this.perToolFailures.set(
        toolName,
        (this.perToolFailures.get(toolName) ?? 0) + 1,
      );
      return;
    }

    // success: reset the consecutive-failure streak for this signature.
    this.consecutiveIdenticalFailures.set(sigKey, 0);

    // for idempotent tools, track the result digest so we can detect
    // "same answer over and over" loops.
    if (this.opts.idempotentTools.has(toolName) && resultDigest) {
      let map = this.perSigResults.get(sigKey);
      if (!map) {
        map = new Map();
        this.perSigResults.set(sigKey, map);
      }
      map.set(resultDigest, (map.get(resultDigest) ?? 0) + 1);
    }
  }

  /** Reset all counters. Call between turns / cron ticks. */
  reset(): void {
    this.consecutiveIdenticalFailures.clear();
    this.perToolFailures.clear();
    this.perSigResults.clear();
  }

  /** Read-only snapshot of internal counters for telemetry / tests. */
  snapshot(): {
    consecutiveIdenticalFailures: ReadonlyMap<string, number>;
    perToolFailures: ReadonlyMap<string, number>;
    idempotentResultRepeats: ReadonlyMap<string, ReadonlyMap<string, number>>;
  } {
    return {
      consecutiveIdenticalFailures: new Map(this.consecutiveIdenticalFailures),
      perToolFailures: new Map(this.perToolFailures),
      idempotentResultRepeats: new Map(
        Array.from(this.perSigResults.entries()).map(
          ([k, v]) => [k, new Map(v)] as const,
        ),
      ),
    };
  }

  /** Whether a tool is treated as idempotent under the current options. */
  isIdempotent(toolName: string): boolean {
    return this.opts.idempotentTools.has(toolName);
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private maxIdempotentRepeat(sigKey: string): number {
    const map = this.perSigResults.get(sigKey);
    if (!map || map.size === 0) return 0;
    let max = 0;
    for (const v of map.values()) if (v > max) max = v;
    return max;
  }
}

// ---------------------------------------------------------------------------
// Helpers — exported because callers often need them at the call site
// ---------------------------------------------------------------------------

/**
 * Stable hex digest of arbitrary JSON-serialisable input. Object keys are
 * sorted recursively so {a:1,b:2} and {b:2,a:1} hash identically. `undefined`
 * inputs (e.g. a no-arg tool call) hash as if `null` was passed — without
 * this, createHash().update() would throw on the undefined return from
 * JSON.stringify(undefined).
 */
export function hashCanonical(value: unknown): string {
  const canonical = canonicalize(value);
  return createHash("sha256").update(canonical ?? "null").digest("hex");
}

/** Convenience wrapper for the result-digest pattern. */
export function digestResult(result: unknown): string {
  return hashCanonical(result);
}

function canonicalize(value: unknown): string | undefined {
  return JSON.stringify(value, function (_key, v) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      const obj = v as Record<string, unknown>;
      for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
      return sorted;
    }
    return v;
  });
}

function sigKeyOf(sig: ToolCallSignature): string {
  return `${sig.toolName}:${sig.argsHash}`;
}
