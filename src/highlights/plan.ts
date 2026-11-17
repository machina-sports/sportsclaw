/**
 * Deterministic request validation and candidate-window planning.
 *
 * Pure functions only: no filesystem, no FFmpeg, no LLM calls. Every invalid
 * or missing input fails closed with a HighlightsValidationError naming the
 * offending field. PBP clock time maps to source-video seconds through either
 * a fixed sync anchor (elapsed-ascending clocks) or a clock map (which also
 * covers countdown-per-period clocks). Unsupported clock semantics are
 * rejected explicitly, never guessed.
 */

import {
  CLOCK_SEMANTICS,
  ClockMapError,
  clockToVideoSec,
  parseClockMap,
} from "../media/clock-map.js";
import {
  SUPPORTED_CLOCK_SEMANTICS,
  type CandidateWindow,
  type SyncAnchor,
  type HighlightsRequest,
  type PBPAction,
  type RightsAuthorization,
  type WindowPolicy,
} from "./types.js";
import type { ClockMap } from "../media/clock-map.js";
import type { RightsCheckMode } from "../media/types.js";

export class HighlightsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HighlightsValidationError";
  }
}

export const DEFAULT_WINDOW_POLICY: WindowPolicy = {
  preRollSec: 8,
  postRollSec: 12,
  maxCandidates: 5,
};

/** Windows sharing at least this fraction of the shorter window are coalesced. */
export const STRONG_WINDOW_OVERLAP_RATIO = 0.9;

/** Hard ceilings so a single request stays bounded regardless of caller. */
const MAX_CANDIDATES_CEILING = 20;
const MAX_ACTIONS = 500;

function fail(message: string): never {
  throw new HighlightsValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  return value;
}

function requireNumber(value: unknown, field: string, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) {
    fail(`${field} must be a finite number >= ${min}`);
  }
  return value;
}

function validateAction(value: unknown, field: string): PBPAction {
  if (!isRecord(value)) fail(`${field} must be an object`);
  const actionId = requireString(value.actionId, `${field}.actionId`);
  const provider = requireString(value.provider, `${field}.provider`);
  const label = requireString(value.label, `${field}.label`);
  const type = requireString(value.type, `${field}.type`);
  const provenance = requireString(value.provenance, `${field}.provenance`);

  if (typeof value.period !== "number" || !Number.isInteger(value.period) || value.period < 1) {
    fail(`${field}.period must be an integer >= 1`);
  }

  if (!isRecord(value.clock)) fail(`${field}.clock must be an object`);
  const semantics = requireString(value.clock.semantics, `${field}.clock.semantics`);
  if (!(CLOCK_SEMANTICS as readonly string[]).includes(semantics)) {
    fail(
      `${field}.clock.semantics "${semantics}" is unsupported — ` +
      `only ${CLOCK_SEMANTICS.map((s) => `"${s}"`).join(" and ")} clocks are supported`
    );
  }
  const elapsedSec = requireNumber(value.clock.elapsedSec, `${field}.clock.elapsedSec`, 0);

  let importance: number | undefined;
  if (value.importance !== undefined) {
    importance = requireNumber(value.importance, `${field}.importance`, 0);
    if (importance > 100) fail(`${field}.importance must be <= 100`);
  }

  return {
    actionId,
    provider,
    period: value.period,
    clock: { semantics, elapsedSec },
    label,
    type,
    importance,
    provenance,
  };
}

/**
 * Strictly validate an untyped payload (e.g. parsed JSON) into a
 * HighlightsRequest. Fails closed on any missing or invalid field.
 */
export function parseHighlightsRequest(
  value: unknown,
  opts?: { rightsCheck?: RightsCheckMode },
): HighlightsRequest {
  if (!isRecord(value)) fail("highlights request must be a JSON object");

  // Rights authorization — refuse to clip without explicit clearance, unless
  // the operator turned the rights check off and no block was supplied.
  let rights: RightsAuthorization | undefined;
  if (opts?.rightsCheck === "off" && value.rights === undefined) {
    rights = undefined;
  } else {
    if (!isRecord(value.rights)) fail("rights authorization block is required");
    if (value.rights.clearedForClipping !== true) {
      fail("rights.clearedForClipping must be explicitly true — media is not cleared for clipping");
    }
    const territories = value.rights.territories;
    if (territories !== undefined) {
      if (!Array.isArray(territories) || territories.some((t) => typeof t !== "string")) {
        fail("rights.territories must be an array of strings");
      }
    }
    rights = {
      rightsHolder: requireString(value.rights.rightsHolder, "rights.rightsHolder"),
      licenseRef: requireString(value.rights.licenseRef, "rights.licenseRef"),
      clearedForClipping: true,
      territories: territories as string[] | undefined,
    };
  }

  // Source media reference — V1 is local-file only.
  if (!isRecord(value.source)) fail("source media reference is required");
  if (value.source.kind !== "local-file") {
    fail('source.kind must be "local-file" in V1 (signed/object references are not implemented)');
  }
  const source = {
    kind: "local-file" as const,
    path: requireString(value.source.path, "source.path"),
  };

  // Canonical event identity.
  if (!isRecord(value.event)) fail("canonical event block is required");
  const event = {
    provider: requireString(value.event.provider, "event.provider"),
    sport: requireString(value.event.sport, "event.sport"),
    eventId: requireString(value.event.eventId, "event.eventId"),
  };

  // Real PBP actions.
  if (!Array.isArray(value.actions) || value.actions.length === 0) {
    fail("actions must be a non-empty array of real PBP actions");
  }
  if (value.actions.length > MAX_ACTIONS) {
    fail(`actions must contain at most ${MAX_ACTIONS} entries`);
  }
  const actions = value.actions.map((a, i) => validateAction(a, `actions[${i}]`));
  const seen = new Set<string>();
  for (const a of actions) {
    if (seen.has(a.actionId)) fail(`duplicate actionId "${a.actionId}" in actions`);
    seen.add(a.actionId);
  }

  // Exactly one of a fixed sync anchor or a clock map aligns PBP clock to video time.
  let syncAnchor: SyncAnchor | undefined;
  let clockMap: ClockMap | undefined;
  if (value.syncAnchor !== undefined && value.clockMap !== undefined) {
    fail("syncAnchor and clockMap are mutually exclusive — supply exactly one");
  }
  if (value.clockMap !== undefined) {
    try {
      clockMap = parseClockMap(value.clockMap);
    } catch (err) {
      if (err instanceof ClockMapError) fail(err.message);
      throw err;
    }
  } else {
    if (!isRecord(value.syncAnchor)) fail("syncAnchor (or clockMap) is required to align PBP clock to video time");
    syncAnchor = {
      videoSec: requireNumber(value.syncAnchor.videoSec, "syncAnchor.videoSec", 0),
      clockSec: requireNumber(value.syncAnchor.clockSec, "syncAnchor.clockSec", 0),
      period: value.syncAnchor.period as number | undefined,
    };
    if (syncAnchor.period !== undefined && (!Number.isInteger(syncAnchor.period) || syncAnchor.period < 1)) {
      fail("syncAnchor.period must be an integer >= 1");
    }
  }
  const mapSemantics = clockMap?.semantics ?? SUPPORTED_CLOCK_SEMANTICS;
  for (const [i, a] of actions.entries()) {
    if (a.clock.semantics !== mapSemantics) {
      fail(`actions[${i}].clock.semantics "${a.clock.semantics}" must match the request's "${mapSemantics}" clock`);
    }
  }

  // Window policy (optional; defaults applied at planning time).
  let window: WindowPolicy | undefined;
  if (value.window !== undefined) {
    if (!isRecord(value.window)) fail("window must be an object");
    const preRollSec = requireNumber(value.window.preRollSec, "window.preRollSec", 0);
    const postRollSec = requireNumber(value.window.postRollSec, "window.postRollSec", 0);
    if (postRollSec <= 0) fail("window.postRollSec must be > 0");
    const maxCandidates = value.window.maxCandidates;
    if (typeof maxCandidates !== "number" || !Number.isInteger(maxCandidates) || maxCandidates < 1) {
      fail("window.maxCandidates must be an integer >= 1");
    }
    if (maxCandidates > MAX_CANDIDATES_CEILING) {
      fail(`window.maxCandidates must be <= ${MAX_CANDIDATES_CEILING}`);
    }
    window = { preRollSec, postRollSec, maxCandidates };
  }

  const outputDir = requireString(value.outputDir, "outputDir");

  return { rights, source, event, actions, ...(syncAnchor ? { syncAnchor } : { clockMap }), window, outputDir };
}

/** Validate a request, throwing HighlightsValidationError on any problem. */
export function validateHighlightsRequest(value: unknown): void {
  parseHighlightsRequest(value);
}

/**
 * Deterministically map real PBP actions to clamped source-video windows.
 *
 * With a sync anchor: videoSec = anchor.videoSec + (action.elapsedSec - anchor.clockSec).
 * With a clock map: clockToVideoSec, dropping actions whose clock no running
 * stretch contains.
 *
 * Actions landing outside [0, sourceDurationSec] are dropped. In primary
 * selection order, remaining windows sharing at least 90% of the shorter
 * window directly with that primary are coalesced. maxCandidates then keeps
 * the highest-importance primaries (ties break on earlier video time, then
 * actionId). The final list is sorted by start time, then actionId.
 */
export function planCandidateWindows(
  request: HighlightsRequest | unknown,
  sourceDurationSec: number,
  opts?: { rightsCheck?: RightsCheckMode },
): CandidateWindow[] {
  const req = parseHighlightsRequest(request, opts);
  if (!Number.isFinite(sourceDurationSec) || sourceDurationSec <= 0) {
    fail("sourceDurationSec must be a finite number > 0");
  }
  const window = req.window ?? DEFAULT_WINDOW_POLICY;
  const { clockMap, syncAnchor } = req;

  const mapped: CandidateWindow[] = [];
  for (const a of req.actions) {
    // Anchor requests keep the original formula bit-for-bit; only clock maps go through the map.
    const actionVideoSec = clockMap
      ? clockToVideoSec(clockMap, a.period, a.clock.elapsedSec)
      : syncAnchor!.videoSec + (a.clock.elapsedSec - syncAnchor!.clockSec);
    if (actionVideoSec === null || actionVideoSec < 0 || actionVideoSec > sourceDurationSec) continue;
    const startSec = Math.max(0, actionVideoSec - window.preRollSec);
    const endSec = Math.min(sourceDurationSec, actionVideoSec + window.postRollSec);
    if (endSec <= startSec) continue;
    mapped.push({
      actionId: a.actionId,
      provider: a.provider,
      provenance: a.provenance,
      label: a.label,
      type: a.type,
      period: a.period,
      importance: a.importance,
      actionVideoSec,
      startSec,
      endSec,
    });
  }

  const byImportance = (x: CandidateWindow, y: CandidateWindow) =>
    (y.importance ?? 0) - (x.importance ?? 0) ||
    x.actionVideoSec - y.actionVideoSec ||
    x.actionId.localeCompare(y.actionId);
  const stronglyOverlaps = (x: CandidateWindow, y: CandidateWindow) => {
    const overlapSec = Math.max(0, Math.min(x.endSec, y.endSec) - Math.max(x.startSec, y.startSec));
    const shorterSec = Math.min(x.endSec - x.startSec, y.endSec - y.startSec);
    return overlapSec / shorterSec >= STRONG_WINDOW_OVERLAP_RATIO;
  };

  // Select primaries deterministically, then attach only windows that directly
  // strongly overlap that primary. This avoids transitive overlap chains.
  const coalesced: CandidateWindow[] = [];
  let remaining = [...mapped].sort(byImportance);
  while (remaining.length > 0) {
    const primary = remaining[0];
    const attached = [primary];
    const unattached: CandidateWindow[] = [];
    for (const candidate of remaining.slice(1)) {
      if (stronglyOverlaps(primary, candidate)) {
        attached.push(candidate);
      } else {
        unattached.push(candidate);
      }
    }
    remaining = unattached;
    if (attached.length === 1) {
      coalesced.push(primary);
      continue;
    }
    coalesced.push({
      ...primary,
      startSec: Math.min(...attached.map((candidate) => candidate.startSec)),
      endSec: Math.max(...attached.map((candidate) => candidate.endSec)),
      mergedActions: attached.map(({ actionId, provider, provenance, label, type, period, importance }) => ({
        actionId,
        provider,
        provenance,
        label,
        type,
        period,
        importance,
      })),
    });
  }

  const selected = [...coalesced].sort(byImportance).slice(0, window.maxCandidates);

  return [...selected].sort(
    (x, y) => x.startSec - y.startSec || x.actionId.localeCompare(y.actionId),
  );
}
