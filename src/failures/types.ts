/** Structured failure categories for tool/workflow errors. */
export type FailureCategory =
  | "user_input"
  | "data_not_ready"
  | "provider_error"
  | "rate_limited"
  | "permission_config"
  | "auth_error"
  | "tool_contract"
  | "agent_planning"
  | "unknown";

export interface ClassifiedFailure {
  category: FailureCategory;
  severity: "low" | "medium" | "high";
  retryable: boolean;
  /** Clean, human-facing explanation: what failed, why, whether retry helps, what to do next. */
  userMessage: string;
  /** Technical detail for logs/developers. */
  developerMessage: string;
  suggestedFix?: string;
  rawError?: string;
}
