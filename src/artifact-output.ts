/**
 * Typed artifact output — one self-contained HTML document per turn, carried
 * beside the answer text, never inside it.
 *
 * This module validates the wire only. It never generates IDs, stores,
 * publishes, sanitizes for display or talks to the network: the caller owns
 * ownership, persistence, sanitization, hosting and links. An artifact the
 * engine returns is generated content, not a published page.
 *
 * `artifact-turn-v1` (ArtifactTurnInput/ArtifactTurnResult) is the envelope a
 * caller uses to opt one run into artifact output: a caller nonce in, and one
 * typed result bound to that nonce out. Without it the engine offers no
 * artifact tool and behaves exactly as before.
 *
 * `createArtifactOutputCollector()` gives one request a `submit_artifact`
 * output tool. The tool always answers `published:false` and no URL: only the
 * caller can say whether and where the document was stored.
 */

import { tool as defineToolRaw, jsonSchema, type Tool } from "ai";

// Same cast workaround as slip-output.ts / operator-memory-tools.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const defineTool = defineToolRaw as any;

export const ARTIFACT_CONTRACT = "artifact-v1";
export const ARTIFACT_TURN_CONTRACT = "artifact-turn-v1";
export const ARTIFACT_OUTPUT_TOOL_NAME = "submit_artifact";
export const ARTIFACT_MIME_TYPE = "text/html";
export const MAX_ARTIFACT_TITLE_CHARS = 120;
/** UTF-8 bytes of the HTML document. A caller may enforce a smaller limit. */
export const MAX_ARTIFACT_HTML_BYTES = 262_144;

export interface ArtifactOutput {
  contract: typeof ARTIFACT_CONTRACT;
  title: string;
  mimeType: typeof ARTIFACT_MIME_TYPE;
  html: string;
}

export interface ArtifactTurnInput {
  contract: typeof ARTIFACT_TURN_CONTRACT;
  /** Opaque caller nonce; echoed by the one result that answers this run. */
  nonce: string;
}

/**
 * Why a run that tried to produce an artifact returns none:
 * - denied: an explicit tool allowlist omits `submit_artifact`;
 * - invalid_artifact: a malformed, oversized or undispatchable submission;
 * - conflicting_artifact: two different submissions in one run;
 * - evidence_unverified: no passing evidence check judged this exact document (absent,
 *   unverified, refused, contradicted, or only the prose was corrected).
 */
export type ArtifactReasonCode = "denied" | "invalid_artifact" | "conflicting_artifact" | "evidence_unverified";

export interface ArtifactTurnResult {
  contract: typeof ARTIFACT_TURN_CONTRACT;
  nonce: string;
  /** The single accepted document, or null. */
  artifact: ArtifactOutput | null;
  /** Null when no artifact was attempted or one was accepted. */
  reasonCode: ArtifactReasonCode | null;
}

// ---------------------------------------------------------------------------
// Exact wire validation: fresh copies only, nothing else from the input survives
// ---------------------------------------------------------------------------

const ARTIFACT_KEYS = ["contract", "title", "mimeType", "html"] as const;
const TURN_KEYS = ["contract", "nonce"] as const;
const RESULT_KEYS = ["contract", "nonce", "artifact", "reasonCode"] as const;
const REASON_CODES: ReadonlySet<string> = new Set(["denied", "invalid_artifact", "conflicting_artifact", "evidence_unverified"]);
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
// eslint-disable-next-line no-control-regex
const TITLE_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** C0/C1 controls except tab, line feed and carriage return, which HTML source uses. */
// eslint-disable-next-line no-control-regex
const HTML_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
/** An unpaired UTF-16 surrogate: not valid Unicode, and not encodable as UTF-8. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  const own = Object.keys(value);
  if (own.length !== keys.length || !keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))) return null;
  return value;
}

/** Exact shape/size validation. Returns a fresh copy, or null. Never throws. */
export function parseArtifactOutput(value: unknown): ArtifactOutput | null {
  const raw = exactKeys(value, ARTIFACT_KEYS);
  if (!raw || raw.contract !== ARTIFACT_CONTRACT || raw.mimeType !== ARTIFACT_MIME_TYPE) return null;
  const { title, html } = raw;
  if (
    typeof title !== "string" || title.trim().length === 0 || title.length > MAX_ARTIFACT_TITLE_CHARS ||
    TITLE_CONTROL.test(title) || LONE_SURROGATE.test(title)
  ) {
    return null;
  }
  if (
    typeof html !== "string" || html.trim().length === 0 || HTML_CONTROL.test(html) || LONE_SURROGATE.test(html) ||
    Buffer.byteLength(html, "utf8") > MAX_ARTIFACT_HTML_BYTES
  ) {
    return null;
  }
  return { contract: ARTIFACT_CONTRACT, title, mimeType: ARTIFACT_MIME_TYPE, html };
}

/** Exact input validation. Returns a fresh copy, or null. Never throws. */
export function parseArtifactTurnInput(value: unknown): ArtifactTurnInput | null {
  const raw = exactKeys(value, TURN_KEYS);
  if (!raw || raw.contract !== ARTIFACT_TURN_CONTRACT) return null;
  if (typeof raw.nonce !== "string" || !NONCE.test(raw.nonce)) return null;
  return { contract: ARTIFACT_TURN_CONTRACT, nonce: raw.nonce };
}

/**
 * Exact result validation against the exact input it must answer. An artifact
 * and a reason code never coexist. Returns a fresh copy, or null. Never throws.
 */
export function parseArtifactTurnResult(value: unknown, input: ArtifactTurnInput): ArtifactTurnResult | null {
  const turn = parseArtifactTurnInput(input);
  const raw = exactKeys(value, RESULT_KEYS);
  if (!turn || !raw || raw.contract !== ARTIFACT_TURN_CONTRACT || raw.nonce !== turn.nonce) return null;
  const reasonCode = raw.reasonCode;
  if (reasonCode !== null && (typeof reasonCode !== "string" || !REASON_CODES.has(reasonCode))) return null;
  if (raw.artifact === null) {
    return { contract: ARTIFACT_TURN_CONTRACT, nonce: turn.nonce, artifact: null, reasonCode: reasonCode as ArtifactReasonCode | null };
  }
  const artifact = parseArtifactOutput(raw.artifact);
  if (!artifact || reasonCode !== null) return null;
  return { contract: ARTIFACT_TURN_CONTRACT, nonce: turn.nonce, artifact, reasonCode: null };
}

// ---------------------------------------------------------------------------
// Request-scoped output tool
// ---------------------------------------------------------------------------

export interface ArtifactToolResult {
  accepted: boolean;
  published: false;
  reasonCode?: "invalid_artifact" | "conflicting_artifact" | "collector_invalid";
}

export interface ArtifactOutputCollector {
  tool: Tool;
  /**
   * Feed every finished SDK step. A `submit_artifact` call the SDK refused to
   * dispatch (malformed JSON, invalid input, a truncated argument) invalidates
   * the collector, even though execute never ran.
   */
  observeStep(step: unknown): void;
  /** Forget everything captured so far (a retried model call starts clean). */
  reset(): void;
  /** Remember the current state; calling the returned function restores it (a discarded attempt leaves nothing). */
  checkpoint(): () => void;
  /** The single captured document, or undefined (unused, invalid or conflicting). */
  finish(): ArtifactOutput | undefined;
  /** The reason the collector was invalidated, or null. */
  problem(): "invalid_artifact" | "conflicting_artifact" | null;
}

const ARTIFACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [...ARTIFACT_KEYS],
  properties: {
    // Typed singleton enums, not untyped consts (see slip-output.ts CHANGE_SCHEMA).
    contract: { type: "string", enum: [ARTIFACT_CONTRACT] },
    title: { type: "string", minLength: 1, maxLength: MAX_ARTIFACT_TITLE_CHARS, description: "Short human title of the document." },
    mimeType: { type: "string", enum: [ARTIFACT_MIME_TYPE] },
    html: {
      type: "string",
      minLength: 1,
      description:
        `One complete, self-contained HTML document (inline CSS, inline SVG), at most ${MAX_ARTIFACT_HTML_BYTES} UTF-8 bytes. ` +
        "No scripts, external resources, forms or embeds.",
    },
  },
};

const TOOL_DESCRIPTION =
  "Submit ONE complete, self-contained HTML document (a visual report: analysis, charts, tables) for this turn. " +
  "Use it only when a page clearly serves the user better than a chat reply. Build the whole document first and " +
  "submit it once; a second, different document invalidates the turn and a rejected one cannot be repaired by " +
  "submitting again. Only use data you actually obtained in this conversation; never invent numbers, sources, IDs " +
  "or URLs. Calling this does not save or publish anything and returns no link: never write a URL for it and " +
  "never say it was saved or published. Keep your chat reply short and do not paste the HTML into it.";

/** One collector per request. */
export function createArtifactOutputCollector(): ArtifactOutputCollector {
  let captured: ArtifactOutput | undefined;
  let captureKey: string | undefined;
  let invalidated: "invalid_artifact" | "conflicting_artifact" | null = null;

  const refuse = (reasonCode: "invalid_artifact" | "conflicting_artifact"): ArtifactToolResult => {
    invalidated = reasonCode;
    captured = undefined;
    captureKey = undefined;
    return { accepted: false, published: false, reasonCode };
  };

  const submit = (input: unknown): ArtifactToolResult => {
    if (invalidated) return { accepted: false, published: false, reasonCode: "collector_invalid" };
    const artifact = parseArtifactOutput(input);
    if (!artifact) return refuse("invalid_artifact");
    // parseArtifactOutput builds keys in a fixed order, so equal JSON is equal content.
    const key = JSON.stringify(artifact);
    if (captureKey !== undefined && captureKey !== key) return refuse("conflicting_artifact");
    captured = artifact;
    captureKey = key;
    return { accepted: true, published: false };
  };

  const tool: Tool = defineTool({
    description: TOOL_DESCRIPTION,
    inputSchema: jsonSchema(ARTIFACT_SCHEMA as Parameters<typeof jsonSchema>[0]),
    execute: async (input: unknown) => submit(input),
  });

  return {
    tool,
    observeStep: (step: unknown) => {
      if (!invalidated && dispatchFailed(step)) refuse("invalid_artifact");
    },
    reset: () => {
      captured = undefined;
      captureKey = undefined;
      invalidated = null;
    },
    checkpoint: () => {
      const saved = { captured, captureKey, invalidated };
      return () => {
        ({ captured, captureKey, invalidated } = saved);
      };
    },
    finish: () => (captured && !invalidated ? { ...captured } : undefined),
    problem: () => invalidated,
  };
}

/**
 * Whether a finished SDK step holds a `submit_artifact` call the SDK refused
 * to dispatch. Other tools' failures are ordinary results and do not count.
 */
function dispatchFailed(step: unknown): boolean {
  const { toolCalls, content } = (step ?? {}) as { toolCalls?: unknown; content?: unknown };
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const parts = Array.isArray(content) ? content : [];
  const ours = (part: unknown): boolean => (part as { toolName?: unknown } | null)?.toolName === ARTIFACT_OUTPUT_TOOL_NAME;
  if (calls.some((call) => ours(call) && (call as { invalid?: unknown }).invalid === true)) return true;
  // Its execute never throws, so any tool-error of ours is a refused dispatch.
  return parts.some((part) => {
    if (!ours(part)) return false;
    const p = part as { type?: unknown; invalid?: unknown };
    return p.type === "tool-error" || (p.type === "tool-call" && p.invalid === true);
  });
}

/** Answer-model context for a turn that offers `submit_artifact`. Generic: no design or hosting rules. */
export function artifactPromptSection(): string {
  return (
    "\n\n## Visual report output\n\n" +
    `This turn offers \`${ARTIFACT_OUTPUT_TOOL_NAME}\`. When the user asks for a report, comparison, chart or analysis ` +
    "that is clearly better as a page, build one self-contained HTML document from data you obtained in this " +
    "conversation and submit it once; otherwise answer in text only. The tool returns no link and publishes nothing: " +
    "never write a URL for the document or say it was saved or published, because the caller decides that. " +
    "Keep the chat reply to a short summary and never paste HTML into it."
  );
}
