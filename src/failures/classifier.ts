import { classifyBridgeError } from "../bridge.js";
import type { ClassifiedFailure, FailureCategory } from "./types.js";

interface Rule {
  category: FailureCategory;
  severity: "low" | "medium" | "high";
  retryable: boolean;
  match: (h: string) => boolean;
  userMessage: string;
  suggestedFix?: string;
}

// Generic, non-proprietary pattern rules. Order matters: first match wins.
const RULES: Rule[] = [
  {
    category: "rate_limited",
    severity: "low",
    retryable: true,
    match: (h) => h.includes("429") || h.includes("rate limit") || h.includes("too many requests"),
    userMessage: "The data provider rate-limited the request. Retrying shortly should work.",
    suggestedFix: "Honor retry_after if present; otherwise back off and retry.",
  },
  {
    category: "permission_config",
    severity: "high",
    retryable: false,
    match: (h) =>
      h.includes("storage.objects.create denied") ||
      (h.includes("403") && h.includes("storage")) ||
      h.includes("permission denied"),
    userMessage: "The action ran but a storage/permission check rejected it (403). Retrying won't help.",
    suggestedFix: "Grant the missing permission to the service account or use a writable target.",
  },
  {
    category: "auth_error",
    severity: "high",
    retryable: false,
    match: (h) => h.includes("401") || h.includes("unauthorized") || h.includes("invalid api key"),
    userMessage: "Authentication failed for this provider. Retrying won't help until credentials are fixed.",
    suggestedFix: "Check the provider API key / auth configuration.",
  },
  {
    category: "data_not_ready",
    severity: "low",
    retryable: true,
    match: (h) =>
      h.includes("not enough") ||
      h.includes("not ready") ||
      h.includes("no fixtures") ||
      h.includes("no data available yet"),
    userMessage: "The underlying data isn't populated yet, so the result would be unreliable.",
    suggestedFix: "Wait until the required data is available, then retry.",
  },
  {
    category: "user_input",
    severity: "medium",
    retryable: false,
    match: (h) =>
      h.includes("must be prefixed") ||
      h.includes("looks like a name, not a valid") ||
      h.includes("invalid argument") ||
      h.includes("required parameter"),
    userMessage: "The request needs a corrected or resolved input before it can run.",
    suggestedFix: "Resolve/normalize the offending argument, then retry.",
  },
];

function toHaystack(error: string | { message?: string } | undefined): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  return String(error.message ?? "");
}

/**
 * Turn a raw tool/workflow error into a structured, user-safe classification.
 * Composes the generic pattern rules above with the bridge classifier for
 * Python-subprocess-specific codes (timeout, dependency_missing, circuit_open, …).
 */
export function classifyFailure(
  error: string | { message?: string } | undefined,
  toolName?: string,
): ClassifiedFailure {
  const raw = toHaystack(error);
  const h = raw.toLowerCase();

  for (const rule of RULES) {
    if (rule.match(h)) {
      return {
        category: rule.category,
        severity: rule.severity,
        retryable: rule.retryable,
        userMessage: rule.userMessage,
        developerMessage: toolName ? `[${toolName}] ${raw}` : raw,
        suggestedFix: rule.suggestedFix,
        rawError: raw,
      };
    }
  }

  // Fall back to the bridge classifier for subprocess-specific codes.
  const { errorCode, hint } = classifyBridgeError(raw);
  const mapping: Record<string, { category: FailureCategory; retryable: boolean; severity: "low" | "medium" | "high" }> = {
    timeout: { category: "provider_error", retryable: true, severity: "medium" },
    dependency_missing: { category: "permission_config", retryable: false, severity: "high" },
    network_dns: { category: "provider_error", retryable: true, severity: "medium" },
    rate_limited: { category: "rate_limited", retryable: true, severity: "low" },
    python_version_incompatible: { category: "permission_config", retryable: false, severity: "high" },
    circuit_open: { category: "provider_error", retryable: true, severity: "medium" },
    tool_execution_failed: { category: "unknown", retryable: false, severity: "medium" },
  };
  const m = mapping[errorCode] ?? { category: "unknown" as FailureCategory, retryable: false, severity: "medium" as const };

  return {
    category: m.category,
    severity: m.severity,
    retryable: m.retryable,
    userMessage: hint,
    developerMessage: toolName ? `[${toolName}] ${raw}` : raw,
    suggestedFix: hint,
    rawError: raw,
  };
}
