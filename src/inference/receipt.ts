/**
 * Shared, dependency-free receipt types for the unified inference boundary.
 *
 * A receipt is metadata about one call: closed enums, a bounded model
 * identifier, counts and latency. It never carries prompts, state, tool I/O,
 * raw errors, endpoints, credentials or user identifiers. Observers are
 * per-call (`ctx.onReceipt`); there is no global last-call state.
 *
 * This module imports nothing so the typed-decision path stays free of the
 * SDK, the engine, MCP and memory.
 */

/** Closed error enum. Never a provider message or an arbitrary error name. */
export const INFERENCE_ERROR_CODES = [
  "aborted",
  "timeout",
  "rate_limited",
  "auth",
  "refused",
  "invalid_request",
  "invalid_response",
  "provider_error",
  "network",
  "unknown",
] as const;

export type InferenceErrorCode = (typeof INFERENCE_ERROR_CODES)[number];

export type InferenceKind = "generate" | "stream" | "image" | "decision";
export type InferenceStatus = "completed" | "failed" | "aborted";
/** Route label only — never an endpoint. */
export type InferenceRouteLabel = "direct" | "nim" | "openshell" | "mock";

export interface InferenceReceipt {
  kind: InferenceKind;
  purpose: string;
  route: InferenceRouteLabel;
  modelId?: string;
  status: InferenceStatus;
  errorCode?: InferenceErrorCode;
  latencyMs: number;
  finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  steps?: number;
  /** Typed-decision receipt, already sanitized by the decision client. */
  decision?: unknown;
}

/** Trusted, caller-authored call context. Never model- or request-authored. */
export interface InferenceContext {
  /** Fixed purpose label, e.g. "chat", "routing", "watch_intent". */
  purpose: string;
  /** Defaults to "direct". */
  route?: InferenceRouteLabel;
  /** Per-call observer. A throwing or rejecting observer never affects the call. */
  onReceipt?: (receipt: InferenceReceipt) => void | PromiseLike<unknown>;
}

const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** A bounded model identifier, or undefined for anything URL- or secret-like. */
export function safeModelId(value: unknown): string | undefined {
  if (typeof value !== "string" || !SAFE_MODEL_ID.test(value)) return undefined;
  if (value.includes("//")) return undefined;
  if (/(^|[^a-z])(sk|key|token|secret|bearer)[-_]/i.test(value)) return undefined;
  return value;
}

const ROUTES: ReadonlySet<string> = new Set(["direct", "nim", "openshell", "mock"]);

export function routeOf(ctx: InferenceContext): InferenceRouteLabel {
  return ctx.route && ROUTES.has(ctx.route) ? ctx.route : "direct";
}

/** Fixed purpose labels; anything else is reported as "other", never echoed. */
export const INFERENCE_PURPOSES = [
  "chat", "chat_lane", "routing", "verification", "correction", "compaction", "synthesis",
  "tool_repair", "subagent", "heartbeat_condition", "setup", "operator_tick", "momentum_explain",
  "momentum_evaluate", "model_role", "image", "watch_intent", "evidence_decision",
  "capability_routing", "decision_relay", "other",
] as const;
const PURPOSES: ReadonlySet<string> = new Set(INFERENCE_PURPOSES);

/** The SDK's finish-reason enum; provider-specific text is dropped. */
const FINISH_REASONS: ReadonlySet<string> = new Set([
  "stop", "length", "content-filter", "tool-calls", "error", "other", "unknown",
]);

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Copy of a receipt with only closed-enum labels and well-formed counts. */
function sanitize(receipt: InferenceReceipt): InferenceReceipt {
  const out: InferenceReceipt = {
    ...receipt,
    purpose: PURPOSES.has(receipt.purpose) ? receipt.purpose : "other",
    latencyMs: count(receipt.latencyMs) ?? 0,
  };
  if (receipt.finishReason !== undefined && !FINISH_REASONS.has(receipt.finishReason)) delete out.finishReason;
  if (receipt.steps !== undefined && count(receipt.steps) === undefined) delete out.steps;
  if (receipt.usage) {
    const usage = {
      inputTokens: count(receipt.usage.inputTokens),
      outputTokens: count(receipt.usage.outputTokens),
      totalTokens: count(receipt.usage.totalTokens),
    };
    if (Object.values(usage).every((v) => v === undefined)) delete out.usage;
    else out.usage = usage;
  }
  return out;
}

const ignore = (): void => {};

/**
 * Deliver a sanitized receipt; observer failures — synchronous throws and
 * rejections of an async observer — are swallowed, never logged, so they
 * cannot mask or crash the call.
 */
export function emitReceipt(ctx: InferenceContext, receipt: InferenceReceipt): void {
  if (!ctx.onReceipt) return;
  try {
    const returned: unknown = ctx.onReceipt(sanitize(receipt));
    if (returned !== null && (typeof returned === "object" || typeof returned === "function")
      && typeof (returned as { then?: unknown }).then === "function") {
      // Promise.resolve adopts any thenable; a throwing `then` also lands in catch.
      Promise.resolve(returned).catch(ignore);
    }
  } catch {
    // An observer is telemetry, never control flow.
  }
}
