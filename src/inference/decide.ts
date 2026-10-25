/**
 * Typed-decision entrypoint of the unified inference boundary.
 *
 * Every runtime Jev decision crosses here. The low-level `JevDecisionClient`
 * stays the transport adapter (consent, egress policy, pinned-model response
 * validation); this wrapper adds only a per-call sanitized receipt. The client
 * result object is returned unchanged.
 *
 * Import graph: the decision client's types and `receipt.ts` only — no SDK,
 * engine, MCP, memory or provider modules — so the decision relay stays light.
 */

import type {
  DecisionCallOptions,
  DecisionReasonCode,
  DecisionRequest,
  DecisionResult,
  JevDecisionClient,
} from "../decision-client.js";
import { emitReceipt, type InferenceContext, type InferenceErrorCode } from "./receipt.js";

function errorCodeOf(reason: DecisionReasonCode): InferenceErrorCode {
  switch (reason) {
    case "aborted":
      return "aborted";
    case "timeout":
      return "timeout";
    case "rate_limited":
      return "rate_limited";
    case "auth_denied":
    case "missing_credential":
      return "auth";
    case "local_only":
    case "redirect_refused":
      return "refused";
    case "invalid_request":
    case "invalid_state":
    case "invalid_questions":
    case "request_too_large":
      return "invalid_request";
    case "network_error":
      return "network";
    case "upstream_error":
      return "provider_error";
    default:
      return "invalid_response";
  }
}

export async function decide(
  ctx: InferenceContext,
  client: Pick<JevDecisionClient, "decide">,
  request: DecisionRequest,
  options?: DecisionCallOptions,
): Promise<DecisionResult> {
  const startedAt = Date.now();
  let result: DecisionResult;
  try {
    result = await client.decide(request, options);
  } catch (err) {
    // The client documents that it never throws; keep the caller's contract.
    emitReceipt(ctx, {
      kind: "decision",
      purpose: ctx.purpose,
      route: "direct",
      status: options?.abortSignal?.aborted ? "aborted" : "failed",
      errorCode: options?.abortSignal?.aborted ? "aborted" : "unknown",
      latencyMs: Date.now() - startedAt,
    });
    throw err;
  }
  emitReceipt(ctx, {
    kind: "decision",
    purpose: ctx.purpose,
    route: "direct",
    status: result.ok ? "completed" : result.reasonCode === "aborted" ? "aborted" : "failed",
    ...(result.ok ? {} : { errorCode: errorCodeOf(result.reasonCode) }),
    latencyMs: Date.now() - startedAt,
    decision: result.receipt,
  });
  return result;
}
