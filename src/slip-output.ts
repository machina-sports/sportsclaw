/**
 * Typed slip output — the engine mirror of the `slip-change-v1` /
 * `slip-revision-v1` wire (slip-contract.md "Exact shapes").
 *
 * This module validates the wire only. It never generates IDs, applies a
 * change, persists anything or talks to the network: the bridge owns state,
 * apply, save and confirmation.
 *
 * `createSlipOutputCollector(context)` gives one request a `submit_slip_change`
 * output tool. A captured change is a proposal, never an accepted or saved
 * slip: the tool always answers `saved:false`. A model `confirm` is refused
 * here even though the shared wire knows the action, because confirmation is
 * deterministic bridge authority.
 *
 * Leg `source` is `user_text`/`user_image` for selections the user supplied
 * (quoted odds kept exactly as written) or `agent_suggestion` for selections
 * the assistant proposed itself. An agent suggestion has no verified price
 * evidence, so its quotedOdds must be null; none of these is a venue quote.
 *
 * `slip-turn-v1` (SlipTurnInput/SlipTurnResult) is the one envelope a caller
 * uses to opt a run into slip output: the exact original request text plus the
 * stored revision in, and one typed decision bound to that input's hash out.
 */

import { createHash } from "node:crypto";
import { tool as defineToolRaw, jsonSchema, type Tool } from "ai";
import type { SlipDecisionReasonCode, SlipDecisionResult } from "./slip-decision.js";

// Same cast workaround as operator-memory-tools.ts / engine.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const defineTool = defineToolRaw as any;

export const SLIP_CHANGE_CONTRACT = "slip-change-v1";
export const SLIP_REVISION_CONTRACT = "slip-revision-v1";
export const SLIP_OUTPUT_TOOL_NAME = "submit_slip_change";
/** Defensive review limit, NOT a venue submission limit. */
export const MAX_SLIP_LEGS = 64;
export const MAX_SLIP_WIRE_BYTES = 65_536;

const MAX_FIELD_CHARS = 160;
const MAX_QUOTED_CHARS = 80;
const MAX_UNRESOLVED = 16;

export type SlipAction = "create" | "append" | "remove" | "replace" | "confirm" | "review" | "clarify";
export type QuotedOddsFormat = "decimal" | "american" | "fractional" | "unknown";

export interface SlipLegInput {
  event: string | null;
  market: string | null;
  selection: string | null;
  period: string | null;
  line: string | null;
  quotedOdds: { value: string; format: QuotedOddsFormat } | null;
  source: "user_text" | "user_image" | "agent_suggestion";
  unresolved: string[];
}

export interface SlipLeg extends SlipLegInput {
  id: string;
}

export interface SlipChange {
  contract: typeof SLIP_CHANGE_CONTRACT;
  action: SlipAction;
  baseRevisionId: string | null;
  targetLegIds: string[];
  legs: SlipLegInput[];
  unresolved: string[];
}

export interface SlipRevision {
  contract: typeof SLIP_REVISION_CONTRACT;
  slipId: string;
  revisionId: string;
  parentRevisionId: string | null;
  status: "proposed" | "confirmed";
  legs: SlipLeg[];
  unresolved: string[];
}

// ---------------------------------------------------------------------------
// Exact wire validation: fresh copies only, nothing else from the input survives
// ---------------------------------------------------------------------------

const ACTIONS: ReadonlySet<string> = new Set(["create", "append", "remove", "replace", "confirm", "review", "clarify"]);
const FORMATS: ReadonlySet<string> = new Set(["decimal", "american", "fractional", "unknown"]);
const SOURCES: ReadonlySet<string> = new Set(["user_text", "user_image", "agent_suggestion"]);
const SLIP_ID = /^slp_[A-Za-z0-9_-]{22}$/;
const REVISION_ID = /^slr_[A-Za-z0-9_-]{22}$/;
const LEG_ID = /^sll_[A-Za-z0-9_-]{22}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** An unpaired UTF-16 surrogate: not valid Unicode, and not hashable like Python's UTF-8. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const LEG_KEYS = ["event", "market", "selection", "period", "line", "quotedOdds", "source", "unresolved"] as const;
const CHANGE_KEYS = ["contract", "action", "baseRevisionId", "targetLegIds", "legs", "unresolved"] as const;
const REVISION_KEYS = ["contract", "slipId", "revisionId", "parentRevisionId", "status", "legs", "unresolved"] as const;

/** Closed refusal for a context the trusted caller supplied incorrectly. */
export class SlipContextError extends Error {
  constructor() {
    super("invalid_slip_context");
    this.name = "SlipContextError";
  }
}

class Invalid extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Invalid();
  const own = Object.keys(value);
  if (own.length !== keys.length || !keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))) {
    throw new Invalid();
  }
  return value;
}

function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" || value.trim().length === 0 || value.length > max ||
    CONTROL.test(value) || LONE_SURROGATE.test(value)
  ) {
    throw new Invalid();
  }
  return value;
}

const nullableText = (value: unknown, max: number): string | null => (value === null ? null : text(value, max));

function list<T>(value: unknown, max: number, item: (entry: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) throw new Invalid();
  // Array.from visits holes as undefined, which every item validator refuses.
  return Array.from(value, (entry) => item(entry));
}

const unresolvedOf = (value: unknown): string[] => list(value, MAX_UNRESOLVED, (entry) => text(entry, MAX_FIELD_CHARS));

function id(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Invalid();
  return value;
}

function legInput(value: unknown, extraKeys: readonly string[] = []): SlipLegInput {
  const raw = exactKeys(value, [...LEG_KEYS, ...extraKeys]);
  const event = nullableText(raw.event, MAX_FIELD_CHARS);
  const market = nullableText(raw.market, MAX_FIELD_CHARS);
  const selection = nullableText(raw.selection, MAX_FIELD_CHARS);
  if (event === null && market === null && selection === null) throw new Invalid();
  let quotedOdds: SlipLegInput["quotedOdds"] = null;
  if (raw.quotedOdds !== null) {
    const odds = exactKeys(raw.quotedOdds, ["value", "format"]);
    if (typeof odds.format !== "string" || !FORMATS.has(odds.format)) throw new Invalid();
    quotedOdds = { value: text(odds.value, MAX_QUOTED_CHARS), format: odds.format as QuotedOddsFormat };
  }
  if (typeof raw.source !== "string" || !SOURCES.has(raw.source)) throw new Invalid();
  // An agent suggestion carries no verified price evidence.
  if (raw.source === "agent_suggestion" && quotedOdds !== null) throw new Invalid();
  return {
    event,
    market,
    selection,
    period: nullableText(raw.period, MAX_FIELD_CHARS),
    line: nullableText(raw.line, MAX_FIELD_CHARS),
    quotedOdds,
    source: raw.source as SlipLegInput["source"],
    unresolved: unresolvedOf(raw.unresolved),
  };
}

const withinWireBytes = (value: unknown): boolean =>
  Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_SLIP_WIRE_BYTES;

/** Exact shape/size validation. Returns a fresh copy, or null. Never throws. */
export function parseSlipChange(value: unknown): SlipChange | null {
  try {
    const raw = exactKeys(value, CHANGE_KEYS);
    if (raw.contract !== SLIP_CHANGE_CONTRACT) return null;
    if (typeof raw.action !== "string" || !ACTIONS.has(raw.action)) return null;
    const change: SlipChange = {
      contract: SLIP_CHANGE_CONTRACT,
      action: raw.action as SlipAction,
      baseRevisionId: raw.baseRevisionId === null ? null : id(raw.baseRevisionId, REVISION_ID),
      targetLegIds: list(raw.targetLegIds, MAX_SLIP_LEGS, (entry) => id(entry, LEG_ID)),
      legs: list(raw.legs, MAX_SLIP_LEGS, (entry) => legInput(entry)),
      unresolved: unresolvedOf(raw.unresolved),
    };
    return withinWireBytes(change) ? change : null;
  } catch {
    return null;
  }
}

/** Exact revision validation. Returns a fresh copy, or null. Never throws. */
export function parseSlipRevision(value: unknown): SlipRevision | null {
  try {
    const raw = exactKeys(value, REVISION_KEYS);
    if (raw.contract !== SLIP_REVISION_CONTRACT) return null;
    if (raw.status !== "proposed" && raw.status !== "confirmed") return null;
    const ids = new Set<string>();
    const legs = list(raw.legs, MAX_SLIP_LEGS, (entry): SlipLeg => {
      const legId = id((entry as Record<string, unknown> | null)?.id, LEG_ID);
      if (ids.has(legId)) throw new Invalid();
      ids.add(legId);
      return { ...legInput(entry, ["id"]), id: legId };
    });
    if (legs.length === 0) return null;
    const revision: SlipRevision = {
      contract: SLIP_REVISION_CONTRACT,
      slipId: id(raw.slipId, SLIP_ID),
      revisionId: id(raw.revisionId, REVISION_ID),
      parentRevisionId: raw.parentRevisionId === null ? null : id(raw.parentRevisionId, REVISION_ID),
      status: raw.status as SlipRevision["status"],
      legs,
      unresolved: unresolvedOf(raw.unresolved),
    };
    return withinWireBytes(revision) ? revision : null;
  } catch {
    return null;
  }
}

export function validateSlipRevision(value: unknown): value is SlipRevision {
  return parseSlipRevision(value) !== null;
}

// ---------------------------------------------------------------------------
// Proposal semantics against the request's exact context
// ---------------------------------------------------------------------------

export type SlipProposalProblem = "confirm_forbidden" | "context_mismatch" | "invalid_change";

/**
 * Action arity, base and target membership of an already-parsed change against
 * the request context. Null when the change is a valid proposal.
 */
export function slipProposalProblem(change: SlipChange, context: SlipRevision | null): SlipProposalProblem | null {
  const { action, baseRevisionId, targetLegIds, legs } = change;
  if (action === "confirm") return "confirm_forbidden";
  if (action === "create") {
    return baseRevisionId === null && targetLegIds.length === 0 && legs.length > 0 ? null : "invalid_change";
  }
  if (action === "clarify") {
    if (targetLegIds.length > 0 || legs.length > 0) return "invalid_change";
    return baseRevisionId === (context?.revisionId ?? null) ? null : "context_mismatch";
  }
  if (!context || baseRevisionId !== context.revisionId) return "context_mismatch";
  const known = new Set(context.legs.map((leg) => leg.id));
  if (new Set(targetLegIds).size !== targetLegIds.length) return "invalid_change";
  if (targetLegIds.some((target) => !known.has(target))) return "context_mismatch";
  switch (action) {
    case "append":
      return targetLegIds.length === 0 && legs.length > 0 && context.legs.length + legs.length <= MAX_SLIP_LEGS
        ? null
        : "invalid_change";
    case "remove":
      return targetLegIds.length > 0 && targetLegIds.length < context.legs.length && legs.length === 0
        ? null
        : "invalid_change";
    case "replace":
      return targetLegIds.length === 1 && legs.length === 1 ? null : "invalid_change";
    default: // review
      return legs.length === 0 ? null : "invalid_change";
  }
}

// ---------------------------------------------------------------------------
// Request-scoped output tool
// ---------------------------------------------------------------------------

export type SlipToolReasonCode = SlipProposalProblem | "conflicting_proposal" | "collector_invalid";

export interface SlipToolResult {
  accepted: boolean;
  saved: false;
  reasonCode?: SlipToolReasonCode;
}

export interface SlipOutputCollector {
  tool: Tool;
  /**
   * Feed every finished SDK step. A tool call the SDK refused to dispatch
   * (malformed JSON, unknown tool, invalid input) invalidates the collector,
   * even though execute never ran.
   */
  observeStep(step: unknown): void;
  /** The single captured proposal, or undefined (unused, invalid or conflicting). */
  finish(): SlipChange | undefined;
  /** True once any malformed or conflicting candidate was submitted. */
  invalid(): boolean;
}

const nullableString = { type: ["string", "null"], minLength: 1, maxLength: MAX_FIELD_CHARS };

const LEG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [...LEG_KEYS],
  properties: {
    event: nullableString,
    market: nullableString,
    selection: nullableString,
    period: nullableString,
    line: { ...nullableString, description: "Exactly as the user wrote it, e.g. -3.5." },
    quotedOdds: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["value", "format"],
          properties: {
            value: { type: "string", minLength: 1, maxLength: MAX_QUOTED_CHARS, description: "Exactly as quoted by the user." },
            format: { type: "string", enum: [...FORMATS] },
          },
        },
      ],
    },
    source: {
      type: "string",
      enum: [...SOURCES],
      description:
        "user_text/user_image: the user supplied this selection (copy their quoted odds exactly). " +
        "agent_suggestion: you proposed it yourself; quotedOdds must be null.",
    },
    unresolved: { type: "array", maxItems: MAX_UNRESOLVED, items: { type: "string", minLength: 1, maxLength: MAX_FIELD_CHARS } },
  },
};

const CHANGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [...CHANGE_KEYS],
  properties: {
    // Typed singleton enum, not an untyped const: a native structured-output
    // provider (Google) ignored the const and produced off-contract literals.
    contract: { type: "string", enum: [SLIP_CHANGE_CONTRACT] },
    action: {
      type: "string",
      enum: ["create", "append", "remove", "replace", "review", "clarify"],
      description:
        "create: baseRevisionId=null, targetLegIds=[], legs=the new legs (at least 1); " +
        "append: baseRevisionId=current revision ID, targetLegIds=[], legs=only the new legs to add; " +
        "remove: baseRevisionId=current revision ID, targetLegIds=IDs to remove (at least 1, not all), legs=[]; " +
        "replace: baseRevisionId=current revision ID, targetLegIds=exactly 1 leg ID, legs=exactly 1 replacement leg; " +
        "review: baseRevisionId=current revision ID, targetLegIds=selected leg IDs or [] for the whole slip, legs=[]; " +
        "clarify: baseRevisionId=current revision ID or null if there is no slip, targetLegIds=[], legs=[], " +
        "and describe the uncertainty in unresolved.",
    },
    baseRevisionId: { type: ["string", "null"], description: "The current slip revision ID from context, or null for a new slip." },
    targetLegIds: {
      type: "array",
      maxItems: MAX_SLIP_LEGS,
      items: { type: "string" },
      description:
        "IDs from context of the existing legs the action affects, never the legs to keep: " +
        "remove = the IDs to remove; replace = exactly 1 ID to replace; review = the IDs to review, " +
        "or [] for the whole slip; create/append/clarify = [].",
    },
    legs: {
      type: "array",
      maxItems: MAX_SLIP_LEGS,
      items: LEG_SCHEMA,
      description:
        "Only new or replacement legs, not the slip after the edit: never copy unchanged or remaining legs here. " +
        "create/append = the new legs in the order shown; replace = exactly 1 replacement leg; remove/review/clarify = [].",
    },
    unresolved: { type: "array", maxItems: MAX_UNRESOLVED, items: { type: "string", minLength: 1, maxLength: MAX_FIELD_CHARS } },
  },
};

// ---------------------------------------------------------------------------
// Bounded extraction envelope: one structured-output reply per turn
// ---------------------------------------------------------------------------

export type SlipExtractionEnvelope =
  | { status: "none"; change: null }
  | { status: "proposal"; change: SlipChange };

/** Native structured-output schema for the one extraction call. */
export const SLIP_EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "change"],
  properties: {
    status: { type: "string", enum: ["none", "proposal"] },
    change: { anyOf: [{ type: "null" }, CHANGE_SCHEMA] },
  },
};

/**
 * Exact envelope validation against the request's context. `none` carries no
 * change; a proposal must be a valid change that fits the context (never a
 * confirm). Returns a fresh copy, or null. Never throws, never repairs.
 */
export function parseSlipExtractionEnvelope(value: unknown, context: SlipRevision | null): SlipExtractionEnvelope | null {
  try {
    const raw = exactKeys(value, ["status", "change"]);
    const base = context === null ? null : parseSlipRevision(context);
    if (context !== null && base === null) return null;
    if (raw.status === "none") return raw.change === null ? { status: "none", change: null } : null;
    if (raw.status !== "proposal") return null;
    const change = parseSlipChange(raw.change);
    if (!change || slipProposalProblem(change, base)) return null;
    return { status: "proposal", change };
  } catch {
    return null;
  }
}

const TOOL_DESCRIPTION =
  "Submit ONE structured bet-slip change proposal for the user's request: create a new slip, append legs, " +
  "remove/replace/review existing legs, or clarify. Mark selections the user supplied as user_text or " +
  "user_image and selections you suggest yourself as agent_suggestion with quotedOdds null; keep unreadable " +
  "or missing details null and list them in unresolved. Do not invent IDs or prices. " +
  "Each action is a delta against the current slip: legs holds only new or replacement legs, never the remaining slip. " +
  "Reason and inspect first, then submit one final, complete proposal; never submit intermediate or incremental drafts. " +
  "For an image, count its distinct visible rows and use each visible row once, without invented duplicates. " +
  "A rejected proposal cannot be repaired by submitting again in the same turn, and a conflicting or different " +
  "second proposal invalidates the whole turn. If unsure, use clarify rather than guessing selections or prices. " +
  "This is a proposal only: nothing is saved or confirmed by calling it, so never tell the user the slip " +
  "was saved or confirmed.";

/**
 * One collector per request. `context` must be a valid revision or null;
 * anything else throws `SlipContextError` before any model work.
 */
export function createSlipOutputCollector(context: SlipRevision | null): SlipOutputCollector {
  const base = context === null ? null : parseSlipRevision(context);
  if (context !== null && base === null) throw new SlipContextError();

  let captured: SlipChange | undefined;
  let captureKey: string | undefined;
  let invalidated = false;

  const invalidate = (): void => {
    invalidated = true;
    captured = undefined;
    captureKey = undefined;
  };

  const refuse = (reasonCode: SlipToolReasonCode): SlipToolResult => {
    invalidate();
    return { accepted: false, saved: false, reasonCode };
  };

  const submit = (input: unknown): SlipToolResult => {
    if (invalidated) return { accepted: false, saved: false, reasonCode: "collector_invalid" };
    const change = parseSlipChange(input);
    if (!change) return refuse("invalid_change");
    const problem = slipProposalProblem(change, base);
    if (problem) return refuse(problem);
    // parseSlipChange builds keys in a fixed order, so equal JSON is equal content.
    const key = JSON.stringify(change);
    if (captureKey !== undefined && captureKey !== key) return refuse("conflicting_proposal");
    captured = change;
    captureKey = key;
    return { accepted: true, saved: false };
  };

  const tool: Tool = defineTool({
    description: TOOL_DESCRIPTION,
    inputSchema: jsonSchema(CHANGE_SCHEMA as Parameters<typeof jsonSchema>[0]),
    execute: async (input: unknown) => submit(input),
  });

  return {
    tool,
    finish: () => (captured && !invalidated ? structuredClone(captured) : undefined),
    invalid: () => invalidated,
    observeStep: (step: unknown) => {
      if (dispatchFailed(step)) invalidate();
    },
  };
}

/** SDK errors raised before a tool's execute runs. */
const DISPATCH_ERRORS: ReadonlySet<string> = new Set(["AI_NoSuchToolError", "AI_InvalidToolInputError", "AI_ToolCallRepairError"]);

/**
 * Whether a finished SDK step contains a tool call the SDK refused to dispatch,
 * or a failed submit_slip_change. An error payload a dispatched tool returned
 * is an ordinary tool result and does not count.
 */
function dispatchFailed(step: unknown): boolean {
  const { toolCalls, content } = (step ?? {}) as { toolCalls?: unknown; content?: unknown };
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const parts = Array.isArray(content) ? content : [];
  if (calls.some((call) => (call as { invalid?: unknown } | null)?.invalid === true)) return true;
  return parts.some((part) => {
    const p = (part ?? {}) as { type?: unknown; toolName?: unknown; invalid?: unknown; error?: unknown };
    if (p.type === "tool-call") return p.invalid === true;
    if (p.type !== "tool-error") return false;
    const name = (p.error as { name?: unknown } | null)?.name;
    return p.toolName === SLIP_OUTPUT_TOOL_NAME || (typeof name === "string" && DISPATCH_ERRORS.has(name));
  });
}

// ---------------------------------------------------------------------------
// slip-turn-v1: the opt-in request/result envelope
// ---------------------------------------------------------------------------

export const SLIP_TURN_CONTRACT = "slip-turn-v1";
export const MAX_SLIP_REQUEST_CHARS = 4_000;
const TURN_KEYS = ["contract", "requestText", "context"] as const;
const RESULT_KEYS = ["contract", "inputHash", "decision"] as const;
// Mirrors SLIP_DECISION_CONTRACT / SLIP_DECISION_MODEL in slip-decision.ts (no runtime import cycle).
const DECISION_CONTRACT = "slip-decision-v1";
const DECISION_MODEL = "jev-1.14.0";
const DECISION_REASONS: ReadonlySet<string> = new Set([
  "disabled", "invalid_request", "invalid_response", "inference_unavailable", "timeout", "aborted",
]);

export interface SlipTurnInput {
  contract: typeof SLIP_TURN_CONTRACT;
  /** The exact original user message; never the composed prompt, profile or history. */
  requestText: string;
  context: SlipRevision | null;
}

export interface SlipTurnResult {
  contract: typeof SLIP_TURN_CONTRACT;
  /** hashSlipTurnInput of the exact input this result answers. */
  inputHash: string;
  /** Null: the turn proposed no slip change. */
  decision: SlipDecisionResult | null;
}

/** Exact input validation. Returns a fresh copy, or null. Never throws, never truncates. */
export function parseSlipTurnInput(value: unknown): SlipTurnInput | null {
  try {
    const raw = exactKeys(value, TURN_KEYS);
    if (raw.contract !== SLIP_TURN_CONTRACT) return null;
    const { requestText } = raw;
    if (
      typeof requestText !== "string" || requestText.trim().length === 0 ||
      requestText.length > MAX_SLIP_REQUEST_CHARS || LONE_SURROGATE.test(requestText)
    ) {
      return null;
    }
    const context = raw.context === null ? null : parseSlipRevision(raw.context);
    if (raw.context !== null && context === null) return null;
    const input: SlipTurnInput = { contract: SLIP_TURN_CONTRACT, requestText, context };
    return withinWireBytes(input) ? input : null;
  } catch {
    return null;
  }
}

/**
 * Canonical JSON: object keys sorted recursively, arrays and strings kept,
 * non-ASCII unescaped. Equals Python json.dumps(sort_keys=True,
 * separators=(",", ":"), ensure_ascii=False). Refuses values it cannot mirror.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    if (LONE_SURROGATE.test(value)) throw new Invalid();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${Array.from(value, (entry) => {
      if (entry === undefined) throw new Invalid();
      return canonicalJson(entry);
    }).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${canonicalJson(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  // No floats, undefined, functions or exotic objects in this contract.
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  throw new Invalid();
}

/** SHA-256 hex of the canonical input. Throws on a value outside the contract. */
export function hashSlipTurnInput(input: SlipTurnInput): string {
  let canonical: string;
  try {
    canonical = canonicalJson(input);
  } catch {
    throw new Error("invalid_slip_turn_input");
  }
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function decisionOf(value: unknown, context: SlipRevision | null): SlipDecisionResult {
  if (!isPlainObject(value) || value.contract !== DECISION_CONTRACT) throw new Invalid();
  if (value.ok === false) {
    const raw = exactKeys(value, ["contract", "ok", "reasonCode"]);
    if (typeof raw.reasonCode !== "string" || !DECISION_REASONS.has(raw.reasonCode)) throw new Invalid();
    return { contract: DECISION_CONTRACT, ok: false, reasonCode: raw.reasonCode as SlipDecisionReasonCode };
  }
  if (value.ok !== true) throw new Invalid();
  const inner = exactKeys(value, ["contract", "ok", "decision"]).decision;
  if (isPlainObject(inner) && inner.status === "selected") {
    const raw = exactKeys(inner, ["status", "change", "model"]);
    if (raw.model !== DECISION_MODEL) throw new Invalid();
    const change = parseSlipChange(raw.change);
    // Jev never selects confirm or clarify; the change must fit the supplied context.
    if (!change || change.action === "clarify" || slipProposalProblem(change, context)) throw new Invalid();
    return { contract: DECISION_CONTRACT, ok: true, decision: { status: "selected", change, model: DECISION_MODEL } };
  }
  const raw = exactKeys(inner, ["status", "model"]);
  if ((raw.status !== "none" && raw.status !== "clarify") || raw.model !== DECISION_MODEL) throw new Invalid();
  return { contract: DECISION_CONTRACT, ok: true, decision: { status: raw.status as "none" | "clarify", model: DECISION_MODEL } };
}

/**
 * Exact result validation against the exact input it must answer. Returns a
 * fresh copy, or null. Never throws.
 */
export function parseSlipTurnResult(value: unknown, input: SlipTurnInput): SlipTurnResult | null {
  try {
    const turn = parseSlipTurnInput(input);
    if (!turn) return null;
    const raw = exactKeys(value, RESULT_KEYS);
    if (raw.contract !== SLIP_TURN_CONTRACT) return null;
    const inputHash = hashSlipTurnInput(turn);
    if (raw.inputHash !== inputHash) return null;
    const decision = raw.decision === null ? null : decisionOf(raw.decision, turn.context);
    return { contract: SLIP_TURN_CONTRACT, inputHash, decision };
  } catch {
    return null;
  }
}
