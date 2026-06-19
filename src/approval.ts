/**
 * sportsclaw — Interactive Approval Gating (Phase 3)
 *
 * Agentic tools (write_file, execute_command) are high-risk operations that
 * require explicit user consent before execution. This module implements
 * the approval lifecycle:
 *
 *   1. Tool invocation → ApprovalPendingHalt thrown (halts engine loop)
 *   2. Listener renders approval prompt (Discord buttons / Telegram inline / CLI)
 *   3. User responds: allow-once, allow-always, or deny
 *   4. Engine resumes with the decision applied
 *
 * Persistent allow-always rules are stored per-user on disk so the same
 * operation class won't prompt again in future sessions.
 *
 * Backed by the unified DurableStateStore substrate.
 */

import { randomBytes } from "node:crypto";
import { DurableStateStore } from "./durability.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The action classes that can be gated by approval. */
export type AgenticAction = "write_file" | "execute_command";

/** User's decision for an approval request. */
export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

/** A pending approval request persisted to disk. */
export interface ApprovalRequest {
  /** Short unique ID for this request (e.g. "apr_a1b2c3") */
  id: string;
  /** The agentic action being requested */
  action: AgenticAction;
  /** Human-readable description of what the tool wants to do */
  description: string;
  /** The full tool arguments (for audit / resumption) */
  toolArgs: Record<string, unknown>;
  /** Platform identifier: "discord" | "telegram" | "cli" */
  platform: string;
  /** Platform-specific user ID */
  userId: string;
  /** ISO timestamp when the request was created */
  createdAt: string;
}

/** Persisted per-user allow-always rules. */
export interface ApprovalRuleset {
  /** Action classes the user has permanently allowed */
  allowedActions: AgenticAction[];
  /** ISO timestamp of last update */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Sentinel error — halts the engine loop (mirrors AskUserQuestionHalt)
// ---------------------------------------------------------------------------

/**
 * Thrown by agentic tools to halt the engine loop and request user approval.
 * The listener catches this, persists the request, and renders the approval UI.
 */
export class ApprovalPendingHalt extends Error {
  public readonly request: ApprovalRequest;

  constructor(request: ApprovalRequest) {
    super(`[ApprovalPending] ${request.action}: ${request.description}`);
    this.name = "ApprovalPendingHalt";
    this.request = request;
  }
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/** Generate a short, unique approval request ID. */
export function generateApprovalId(): string {
  return `apr_${randomBytes(4).toString("hex")}`;
}

// ---------------------------------------------------------------------------
// Pending request persistence
// ---------------------------------------------------------------------------

/**
 * Save a pending approval request to disk so the listener can render it
 * and the engine can resume after the user responds.
 */
export async function saveApprovalRequest(request: ApprovalRequest): Promise<void> {
  const store = DurableStateStore.getInstance();
  const subPath = `${request.platform}-${request.userId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  await store.save<ApprovalRequest>("approvals", request.id, request, { subPath });
}

/**
 * Load a pending approval request by ID, or null if it doesn't exist.
 */
export async function loadApprovalRequest(
  platform: string,
  userId: string,
  requestId: string
): Promise<ApprovalRequest | null> {
  const store = DurableStateStore.getInstance();
  const subPath = `${platform}-${userId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  return store.load<ApprovalRequest>("approvals", requestId, { subPath });
}

/**
 * Remove a pending approval request after it has been resolved.
 */
export async function clearApprovalRequest(
  platform: string,
  userId: string,
  requestId: string
): Promise<void> {
  const store = DurableStateStore.getInstance();
  const subPath = `${platform}-${userId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  await store.delete("approvals", requestId, { subPath });
}

// ---------------------------------------------------------------------------
// Allow-always ruleset persistence
// ---------------------------------------------------------------------------

/**
 * Load the user's persisted allow-always ruleset.
 */
export async function loadRuleset(
  platform: string,
  userId: string
): Promise<ApprovalRuleset> {
  const store = DurableStateStore.getInstance();
  const subPath = `${platform}-${userId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const rules = await store.load<ApprovalRuleset>("approvals", "ruleset", { subPath });
  if (rules) return rules;
  return { allowedActions: [], updatedAt: new Date().toISOString() };
}

/**
 * Add an action to the user's allow-always ruleset.
 */
export async function addAllowAlwaysRule(
  platform: string,
  userId: string,
  action: AgenticAction
): Promise<void> {
  const ruleset = await loadRuleset(platform, userId);
  if (!ruleset.allowedActions.includes(action)) {
    ruleset.allowedActions.push(action);
  }
  ruleset.updatedAt = new Date().toISOString();
  const store = DurableStateStore.getInstance();
  const subPath = `${platform}-${userId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  await store.save<ApprovalRuleset>("approvals", "ruleset", ruleset, { subPath });
}

/**
 * Check whether a given action is pre-approved via allow-always for this user.
 */
export async function isActionPreApproved(
  platform: string,
  userId: string,
  action: AgenticAction
): Promise<boolean> {
  const ruleset = await loadRuleset(platform, userId);
  return ruleset.allowedActions.includes(action);
}

// ---------------------------------------------------------------------------
// Decision application
// ---------------------------------------------------------------------------

/**
 * Process an approval decision. Returns true if the action should proceed.
 *
 * - allow-once: clears the request, returns true
 * - allow-always: clears the request, persists the rule, returns true
 * - deny: clears the request, returns false
 */
export async function resolveApproval(
  platform: string,
  userId: string,
  requestId: string,
  decision: ApprovalDecision
): Promise<boolean> {
  const request = await loadApprovalRequest(platform, userId, requestId);
  if (!request) {
    console.error(`[sportsclaw] Approval request ${requestId} not found`);
    return false;
  }

  await clearApprovalRequest(platform, userId, requestId);

  switch (decision) {
    case "allow-once":
      return true;
    case "allow-always":
      await addAllowAlwaysRule(platform, userId, request.action);
      return true;
    case "deny":
      return false;
  }
}

// ---------------------------------------------------------------------------
// /approve chat command parser
// ---------------------------------------------------------------------------

/**
 * Parse a `/approve` command from chat input.
 * Supports:
 *   /approve <request_id>
 *   /approve <request_id> always
 *   /approve <request_id> deny
 *
 * Returns null if the input is not an /approve command.
 */
export function parseApproveCommand(
  input: string
): { requestId: string; decision: ApprovalDecision } | null {
  const trimmed = input.trim();
  const match = trimmed.match(/^\/approve\s+(apr_[a-f0-9]+)(?:\s+(always|deny))?$/i);
  if (!match) return null;

  const requestId = match[1];
  const modifier = match[2]?.toLowerCase();

  let decision: ApprovalDecision = "allow-once";
  if (modifier === "always") decision = "allow-always";
  else if (modifier === "deny") decision = "deny";

  return { requestId, decision };
}

// ---------------------------------------------------------------------------
// Approval prompt builder (for listeners to render)
// ---------------------------------------------------------------------------

/** Build a human-readable approval prompt string for display. */
export function buildApprovalPrompt(request: ApprovalRequest): string {
  const actionLabel = request.action === "write_file" ? "Write File" : "Execute Command";
  return (
    `**Approval Required: ${actionLabel}**\n\n` +
    `${request.description}\n\n` +
    `Request ID: \`${request.id}\`\n\n` +
    `Respond with:\n` +
    `- **Allow Once** — permit this specific action\n` +
    `- **Allow Always** — permit all future \`${request.action}\` actions\n` +
    `- **Deny** — reject this action\n\n` +
    `Or type: \`/approve ${request.id}\` | \`/approve ${request.id} always\` | \`/approve ${request.id} deny\``
  );
}
