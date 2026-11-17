/**
 * Event index: official play-by-play actions placed on the source video via a
 * clock map, plus a search over them. Pure and JSON-safe.
 */

import { DEFAULT_WINDOW_POLICY } from "../highlights/plan.js";
import type { PBPAction, WindowPolicy } from "../highlights/types.js";
import { clockToVideoSec, type ClockMap } from "./clock-map.js";

export interface IndexedEvent {
  eventId: string;
  actionId: string;
  period: number;
  clockSec: number;
  label: string;
  type: string;
  people: string[];
  videoSec: number;
  startSec: number;
  endSec: number;
}

export interface EventIndex {
  version: 1;
  sourceSha256: string;
  events: IndexedEvent[];
  skipped: { actionId: string; reason: "no_stretch" }[];
}

export const DEFAULT_FIND_LIMIT = 12;
export const MAX_FIND_LIMIT = 50;

export function buildEventIndex(input: {
  sourceSha256: string;
  sourceDurationSec: number;
  clockMap: ClockMap;
  actions: (PBPAction & { people?: string[] })[];
  window?: WindowPolicy;
}): EventIndex {
  const { sourceDurationSec, clockMap } = input;
  const window = input.window ?? DEFAULT_WINDOW_POLICY;
  const seen = new Set<string>();
  const events: IndexedEvent[] = [];
  const skipped: EventIndex["skipped"] = [];

  for (const a of input.actions) {
    if (seen.has(a.actionId)) throw new Error(`duplicate actionId: ${a.actionId}`);
    seen.add(a.actionId);
    const videoSec = clockToVideoSec(clockMap, a.period, a.clock.elapsedSec);
    if (videoSec === null || videoSec < 0 || videoSec > sourceDurationSec) {
      skipped.push({ actionId: a.actionId, reason: "no_stretch" });
      continue;
    }
    events.push({
      eventId: `ev_${a.actionId}`,
      actionId: a.actionId,
      period: a.period,
      clockSec: a.clock.elapsedSec,
      label: a.label,
      type: a.type,
      people: [...(a.people ?? [])],
      videoSec,
      startSec: Math.max(0, videoSec - window.preRollSec),
      endSec: Math.min(sourceDurationSec, videoSec + window.postRollSec),
    });
  }

  // Array.prototype.sort is stable, so ties keep input order.
  const direction = clockMap.semantics === "countdown-per-period" ? -1 : 1;
  events.sort((x, y) => x.period - y.period || direction * (x.clockSec - y.clockSec));

  return { version: 1, sourceSha256: input.sourceSha256, events, skipped };
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

export function findEvents(
  index: EventIndex,
  q: { text?: string; people?: string[]; period?: number; type?: string; limit?: number },
): IndexedEvent[] {
  const limit =
    typeof q.limit === "number" && Number.isInteger(q.limit)
      ? Math.min(MAX_FIND_LIMIT, Math.max(1, q.limit))
      : DEFAULT_FIND_LIMIT;
  const queryWords = q.text ? words(q.text) : [];
  const wantPeople = (q.people ?? []).map((p) => p.trim().toLowerCase());
  const wantType = q.type?.trim().toLowerCase();

  const out: IndexedEvent[] = [];
  for (const e of index.events) {
    if (q.period !== undefined && e.period !== q.period) continue;
    if (wantType !== undefined && e.type.trim().toLowerCase() !== wantType) continue;
    if (queryWords.length > 0) {
      const labelWords = new Set(words(e.label));
      if (!queryWords.every((w) => labelWords.has(w))) continue;
    }
    if (wantPeople.length > 0) {
      const have = new Set(e.people.map((p) => p.trim().toLowerCase()));
      if (!wantPeople.every((p) => have.has(p))) continue;
    }
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}
