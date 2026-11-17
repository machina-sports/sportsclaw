/**
 * Clock map: game clock (period, clockSec) -> source-video second.
 *
 * A map is a list of video stretches, each tied to a stretch of one period's
 * clock. Only running stretches map; a stopped clock (timeout, free throw)
 * maps to null so plays that share one stopped clock reading are left out
 * rather than guessed. Pure and JSON-safe (finite numbers only).
 */

import type { SyncAnchor } from "../highlights/types.js";

export const CLOCK_SEMANTICS = ["elapsed-ascending", "countdown-per-period"] as const;

export interface ClockStretch {
  videoStartSec: number;
  videoEndSec: number;
  period: number;
  clockStartSec: number;
  clockEndSec: number;
  running: boolean;
}

export interface ClockMap {
  version: 1;
  semantics: (typeof CLOCK_SEMANTICS)[number];
  stretches: ClockStretch[];
}

export const MAX_CLOCK_STRETCHES = 20000;

/** Finite upper clock bound standing in for "no upper bound" on a sync-anchor map. */
const ANCHOR_CLOCK_CEILING_SEC = 1e9;

export class ClockMapError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`${field} ${message}`);
    this.name = "ClockMapError";
    this.field = field;
  }
}

function fail(field: string, message: string): never {
  throw new ClockMapError(field, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(field, "must be a finite number");
  return value;
}

export function parseClockMap(value: unknown): ClockMap {
  if (!isRecord(value)) fail("clockMap", "must be an object");
  if (value.version !== 1) fail("clockMap.version", "must be 1");
  const semantics = CLOCK_SEMANTICS.find((s) => s === value.semantics);
  if (!semantics) fail("clockMap.semantics", `must be one of ${CLOCK_SEMANTICS.join(", ")}`);
  if (!Array.isArray(value.stretches)) fail("clockMap.stretches", "must be an array");
  if (value.stretches.length > MAX_CLOCK_STRETCHES) {
    fail("clockMap.stretches", `must contain at most ${MAX_CLOCK_STRETCHES} entries`);
  }

  const stretches = value.stretches.map((raw, i): ClockStretch => {
    const f = `clockMap.stretches[${i}]`;
    if (!isRecord(raw)) fail(f, "must be an object");
    const videoStartSec = finite(raw.videoStartSec, `${f}.videoStartSec`);
    const videoEndSec = finite(raw.videoEndSec, `${f}.videoEndSec`);
    const clockStartSec = finite(raw.clockStartSec, `${f}.clockStartSec`);
    const clockEndSec = finite(raw.clockEndSec, `${f}.clockEndSec`);
    if (typeof raw.period !== "number" || !Number.isInteger(raw.period) || raw.period < 1) {
      fail(`${f}.period`, "must be an integer >= 1");
    }
    if (typeof raw.running !== "boolean") fail(`${f}.running`, "must be a boolean");
    if (videoEndSec <= videoStartSec) fail(`${f}.videoEndSec`, "must be greater than videoStartSec");
    if (raw.running) {
      if (semantics === "countdown-per-period" && clockEndSec > clockStartSec) {
        fail(`${f}.clockEndSec`, "must not exceed clockStartSec on a running countdown stretch");
      }
      if (semantics === "elapsed-ascending" && clockEndSec < clockStartSec) {
        fail(`${f}.clockEndSec`, "must not be below clockStartSec on a running ascending stretch");
      }
    } else if (clockStartSec !== clockEndSec) {
      fail(`${f}.clockEndSec`, "must equal clockStartSec on a stopped stretch");
    }
    return { videoStartSec, videoEndSec, period: raw.period, clockStartSec, clockEndSec, running: raw.running };
  });

  const byVideo = stretches
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.videoStartSec - b.s.videoStartSec || a.i - b.i);
  for (let k = 1; k < byVideo.length; k++) {
    if (byVideo[k].s.videoStartSec < byVideo[k - 1].s.videoEndSec) {
      fail(`clockMap.stretches[${byVideo[k].i}].videoStartSec`, "overlaps another stretch's video range");
    }
  }

  return { version: 1, semantics, stretches };
}

/** Video second of (period, clockSec), or null when no running stretch contains it. */
export function clockToVideoSec(map: ClockMap, period: number, clockSec: number): number | null {
  const ascending = map.semantics === "elapsed-ascending";
  let best: ClockStretch | null = null;
  for (const s of map.stretches) {
    if (!s.running) continue;
    if (!ascending && s.period !== period) continue;
    const lo = Math.min(s.clockStartSec, s.clockEndSec);
    const hi = Math.max(s.clockStartSec, s.clockEndSec);
    if (clockSec < lo || clockSec > hi) continue;
    if (best === null || s.videoStartSec < best.videoStartSec) best = s;
  }
  if (best === null) return null;
  return ascending
    ? best.videoStartSec + (clockSec - best.clockStartSec)
    : best.videoStartSec + (best.clockStartSec - clockSec);
}

/**
 * The single stretch equivalent to `video = anchor.videoSec + (clock - anchor.clockSec)`.
 * Clocks are >= 0 and negative video seconds are never usable, so the stretch
 * starts at the later of clock 0 and video 0 and ends at a finite ceiling.
 */
export function clockMapFromSyncAnchor(anchor: SyncAnchor): ClockMap {
  const clockStartSec = Math.max(0, anchor.clockSec - anchor.videoSec);
  const videoStartSec = anchor.videoSec + (clockStartSec - anchor.clockSec);
  return {
    version: 1,
    semantics: "elapsed-ascending",
    stretches: [
      {
        videoStartSec,
        videoEndSec: videoStartSec + (ANCHOR_CLOCK_CEILING_SEC - clockStartSec),
        period: anchor.period ?? 1,
        clockStartSec,
        clockEndSec: ANCHOR_CLOCK_CEILING_SEC,
        running: true,
      },
    ],
  };
}
