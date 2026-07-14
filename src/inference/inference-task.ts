/**
 * sportsclaw — Inference Task Contracts
 *
 * Typed request/result envelopes for model-role calls across the
 * pod ⇄ inference-plane boundary, plus lightweight runtime validators.
 * Data-only definitions — routing behavior lives in model-role-router.ts.
 */

import type { ValidationResult } from "../schema/tv.js";
import { isModelRole, type ModelRole } from "./model-roles.js";

// ---------------------------------------------------------------------------
// InferenceRoute — how a role is reached (never named after hardware)
// ---------------------------------------------------------------------------

export const INFERENCE_ROUTES = ["openshell", "nim", "mock"] as const;

export type InferenceRoute = (typeof INFERENCE_ROUTES)[number];

// ---------------------------------------------------------------------------
// InferenceTaskEnvelope — a typed request for one model-role invocation
// ---------------------------------------------------------------------------

export const INFERENCE_TASK_SOURCES = [
  "machina-pod",
  "sportsclaw-operator",
  "benchmark",
] as const;

export type InferenceTaskSource = (typeof INFERENCE_TASK_SOURCES)[number];

export interface InferenceTaskEnvelope<TInput = unknown> {
  taskId: string;
  role: ModelRole;
  model: string;
  input: TInput;
  requestedAt: string;
  source: InferenceTaskSource;
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// InferenceTrace — timing/model/route trace for one invocation
// ---------------------------------------------------------------------------

export interface InferenceTrace {
  taskId: string;
  role: ModelRole;
  model: string;
  modelVersion?: string;
  /** Optional hardware trace (e.g. which accelerator served the call). */
  acceleratorIndex?: number;
  startedAt: string;
  endedAt: string;
  latencyMs: number;
  route: InferenceRoute;
  /** Governed statuses: only `completed` may be parsed as a usable result;
   * `timed_out` / `cancelled` / `failed` must fail closed (never a verdict). */
  status: "completed" | "failed" | "timed_out" | "cancelled";
  error?: string;
}

// ---------------------------------------------------------------------------
// InferenceResult — typed output plus its trace
// ---------------------------------------------------------------------------

export interface InferenceResult<TOutput = unknown> {
  taskId: string;
  role: ModelRole;
  output: TOutput;
  trace: InferenceTrace;
}

// ---------------------------------------------------------------------------
// Validators — lightweight runtime safety checks
// ---------------------------------------------------------------------------

export function validateInferenceTaskEnvelope(envelope: unknown): ValidationResult {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return { ok: false, error: "Envelope must be a non-null object." };
  }

  const e = envelope as Record<string, unknown>;

  if (typeof e.taskId !== "string" || e.taskId === "") {
    return { ok: false, error: "Envelope must have a non-empty taskId." };
  }

  if (!isModelRole(e.role)) {
    return { ok: false, error: "Envelope role must be one of eyes, brain, hands, voice." };
  }

  if (typeof e.model !== "string" || e.model === "") {
    return { ok: false, error: "Envelope must have a non-empty model." };
  }

  if (typeof e.requestedAt !== "string" || e.requestedAt === "") {
    return { ok: false, error: "Envelope must have a non-empty requestedAt timestamp." };
  }

  if (!(INFERENCE_TASK_SOURCES as readonly string[]).includes(e.source as string)) {
    return {
      ok: false,
      error: "Envelope source must be machina-pod, sportsclaw-operator, or benchmark.",
    };
  }

  return { ok: true };
}

export function validateInferenceTrace(trace: unknown): ValidationResult {
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) {
    return { ok: false, error: "Trace must be a non-null object." };
  }

  const t = trace as Record<string, unknown>;

  if (typeof t.taskId !== "string" || t.taskId === "") {
    return { ok: false, error: "Trace must have a non-empty taskId." };
  }

  if (!isModelRole(t.role)) {
    return { ok: false, error: "Trace role must be one of eyes, brain, hands, voice." };
  }

  if (typeof t.model !== "string" || t.model === "") {
    return { ok: false, error: "Trace must have a non-empty model." };
  }

  if (typeof t.startedAt !== "string" || t.startedAt === "") {
    return { ok: false, error: "Trace must have a non-empty startedAt timestamp." };
  }

  if (typeof t.endedAt !== "string" || t.endedAt === "") {
    return { ok: false, error: "Trace must have a non-empty endedAt timestamp." };
  }

  if (typeof t.latencyMs !== "number" || !Number.isFinite(t.latencyMs) || t.latencyMs < 0) {
    return { ok: false, error: "Trace latencyMs must be a non-negative number." };
  }

  if (!(INFERENCE_ROUTES as readonly string[]).includes(t.route as string)) {
    return { ok: false, error: "Trace route must be openshell, nim, or mock." };
  }

  if (!["completed", "failed", "timed_out", "cancelled"].includes(t.status as string)) {
    return { ok: false, error: "Trace status must be completed, failed, timed_out, or cancelled." };
  }

  return { ok: true };
}
