/**
 * A story timeline: clips and cards, with each caption named only by the id of a checked line.
 *
 * A timeline holds no caption text at all, so an unchecked caption cannot be drawn: `caption`,
 * `text` and every other unknown key are refused at both levels. resolveTimeline validates
 * the timeline and returns a fresh plain-JSON copy with `captions[i]` set to the checked line's
 * text for segment i's lineId (null when the segment has none).
 *
 * A clip may name its play by eventId instead of startSec/endSec: the window is filled from the event
 * index the timeline's lines were checked against (ctx.events). A clip that names an eventId and gives
 * startSec/endSec must lie within the event's [startSec - EVENT_SLACK_SEC, endSec + EVENT_SLACK_SEC]
 * (`clip_not_event`); an eventId not in that index is `unknown_event`. The resolved timeline always
 * carries startSec/endSec on every clip.
 *
 * A caption belongs to its clip: when a clip names an eventId and a lineId, and that checked line cites one or
 * more events of the index, one of them must be the clip's (`caption_not_event`). A line that cites only
 * facts, a clip placed by seconds alone, and a card are not checked: nothing says which play they are about.
 */

import type { ArtifactKind } from "./types.js";
import type { CheckedLine } from "./lines.js";
import type { IndexedEvent } from "./event-index.js";

export interface TimelineSegment {
  kind: "clip" | "card";
  eventId?: string;
  startSec?: number;
  endSec?: number;
  lineId?: string;
  voiceArtifactId?: string;
  subjectTracksArtifactId?: string;
  overlay?: Record<string, string | number>;
  cardSeconds?: number;
}

export interface StoryTimeline {
  version: 1;
  sourceArtifactId: string;
  linesArtifactId?: string;
  segments: TimelineSegment[];
}

export type ResolvedTimeline = StoryTimeline & { captions: (string | null)[] };

export type TimelineErrorCode =
  | "unknown_field"
  | "unknown_line"
  | "missing_lines_artifact"
  | "bad_clip"
  | "clip_outside_source"
  | "missing_artifact"
  | "too_many_segments"
  | "too_long"
  | "bad_card"
  | "bad_version"
  | "clip_not_event"
  | "unknown_event"
  | "caption_not_event";

export class TimelineError extends Error {
  constructor(
    public code: TimelineErrorCode,
    message: string,
    public segmentIndex: number | null = null,
  ) {
    super(message);
    this.name = "TimelineError";
  }
}

export const MAX_SEGMENTS = 40;
export const MIN_CLIP_SEC = 1;
export const MAX_CLIP_SEC = 60;
export const MIN_CARD_SEC = 1;
export const MAX_CARD_SEC = 10;
export const MAX_TOTAL_SEC = 600;
/** How far a clip that names an eventId may reach past the event's own window, each side. */
export const EVENT_SLACK_SEC = 5;

const TIMELINE_KEYS = new Set(["version", "sourceArtifactId", "linesArtifactId", "segments"]);
const SEGMENT_KEYS = new Set([
  "kind", "eventId", "startSec", "endSec", "lineId", "voiceArtifactId",
  "subjectTracksArtifactId", "overlay", "cardSeconds",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function unknownKey(obj: Record<string, unknown>, allowed: Set<string>, index: number | null): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      const where = index === null ? "timeline" : `segment ${index}`;
      const hint = key === "caption" || key === "text" ? "; captions are named by lineId of a checked line, never written here" : "";
      throw new TimelineError("unknown_field", `Unknown field "${key}" on ${where}${hint}`, index);
    }
  }
}

function optionalString(v: unknown, name: string, index: number, code: TimelineErrorCode): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v === "") throw new TimelineError(code, `Segment ${index}: ${name} must be a non-empty string`, index);
  return v;
}

function checkOverlay(v: unknown, index: number): Record<string, string | number> | undefined {
  if (v === undefined) return undefined;
  const bad = () => new TimelineError("unknown_field", `Segment ${index}: overlay must map names to strings or numbers`, index);
  if (!isRecord(v)) throw bad();
  const out: Record<string, string | number> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string" || (typeof val === "number" && Number.isFinite(val))) out[k] = val;
    else throw bad();
  }
  return out;
}

export async function resolveTimeline(
  t: unknown,
  ctx: {
    lines: CheckedLine[];
    sourceDurationSec: number;
    hasArtifact: (id: string, kind: ArtifactKind) => Promise<boolean>;
    /** The event index the timeline's lines were checked against; needed when a clip names an eventId. */
    events?: ReadonlyArray<Pick<IndexedEvent, "eventId" | "startSec" | "endSec">>;
  },
): Promise<ResolvedTimeline> {
  if (!isRecord(t)) throw new TimelineError("bad_version", "Timeline must be an object with version 1");
  unknownKey(t, TIMELINE_KEYS, null);
  if (t.version !== 1) throw new TimelineError("bad_version", "Timeline version must be 1");
  if (typeof t.sourceArtifactId !== "string" || t.sourceArtifactId === "") {
    throw new TimelineError("missing_artifact", "Timeline needs a sourceArtifactId");
  }
  if (t.linesArtifactId !== undefined && (typeof t.linesArtifactId !== "string" || t.linesArtifactId === "")) {
    throw new TimelineError("missing_artifact", "linesArtifactId must be a non-empty string");
  }
  if (!Array.isArray(t.segments) || t.segments.length < 1 || t.segments.length > MAX_SEGMENTS) {
    throw new TimelineError("too_many_segments", `A timeline needs 1 to ${MAX_SEGMENTS} segments`);
  }

  if (!(await ctx.hasArtifact(t.sourceArtifactId, "source"))) {
    throw new TimelineError("missing_artifact", `No source artifact ${t.sourceArtifactId}`);
  }
  if (t.linesArtifactId !== undefined && !(await ctx.hasArtifact(t.linesArtifactId, "lines-checked"))) {
    throw new TimelineError("missing_artifact", `No lines-checked artifact ${t.linesArtifactId}`);
  }

  const linesById = new Map(ctx.lines.map((l) => [l.lineId, l]));
  const eventsById = new Map((ctx.events ?? []).map((e) => [e.eventId, e]));
  const segments: TimelineSegment[] = [];
  const captions: (string | null)[] = [];
  let total = 0;

  for (let i = 0; i < t.segments.length; i++) {
    const raw: unknown = t.segments[i];
    if (!isRecord(raw)) throw new TimelineError("bad_clip", `Segment ${i} must be an object`, i);
    unknownKey(raw, SEGMENT_KEYS, i);
    const seg: TimelineSegment = { kind: raw.kind as "clip" | "card" };

    if (raw.kind === "clip") {
      let { startSec, endSec } = raw;
      if (raw.cardSeconds !== undefined) throw new TimelineError("bad_clip", `Segment ${i}: a clip has no cardSeconds`, i);
      const eventId = optionalString(raw.eventId, "eventId", i, "bad_clip");
      if (eventId !== undefined) {
        if (t.linesArtifactId === undefined || ctx.events === undefined) {
          throw new TimelineError("missing_lines_artifact", `Segment ${i} names event ${eventId}, but the timeline has no linesArtifactId whose event index could place it`, i);
        }
        const event = eventsById.get(eventId);
        if (event === undefined) throw new TimelineError("unknown_event", `Segment ${i}: ${eventId} is not in the event index the lines were checked against`, i);
        if (startSec === undefined && endSec === undefined) {
          startSec = event.startSec;
          endSec = event.endSec;
        } else if (
          typeof startSec === "number" && typeof endSec === "number" &&
          (startSec < event.startSec - EVENT_SLACK_SEC || endSec > event.endSec + EVENT_SLACK_SEC)
        ) {
          throw new TimelineError(
            "clip_not_event",
            `Segment ${i}: clip ${startSec}-${endSec}s is not within ${EVENT_SLACK_SEC}s of ${eventId} (${event.startSec}-${event.endSec}s)`,
            i,
          );
        }
      }
      if (typeof startSec !== "number" || typeof endSec !== "number" || !Number.isFinite(startSec) || !Number.isFinite(endSec)) {
        throw new TimelineError("bad_clip", `Segment ${i}: a clip needs finite startSec and endSec`, i);
      }
      const length = endSec - startSec;
      if (startSec >= endSec || length < MIN_CLIP_SEC || length > MAX_CLIP_SEC) {
        throw new TimelineError("bad_clip", `Segment ${i}: a clip must run ${MIN_CLIP_SEC} to ${MAX_CLIP_SEC} seconds, start before end`, i);
      }
      if (startSec < 0 || endSec > ctx.sourceDurationSec) {
        throw new TimelineError("clip_outside_source", `Segment ${i}: clip ${startSec}-${endSec}s is outside the source (0-${ctx.sourceDurationSec}s)`, i);
      }
      seg.startSec = startSec;
      seg.endSec = endSec;
      total += length;
    } else if (raw.kind === "card") {
      const { cardSeconds } = raw;
      if (raw.startSec !== undefined || raw.endSec !== undefined || raw.eventId !== undefined || raw.subjectTracksArtifactId !== undefined) {
        throw new TimelineError("bad_card", `Segment ${i}: a card has no startSec, endSec, eventId or subjectTracksArtifactId`, i);
      }
      if (typeof cardSeconds !== "number" || !Number.isFinite(cardSeconds) || cardSeconds < MIN_CARD_SEC || cardSeconds > MAX_CARD_SEC) {
        throw new TimelineError("bad_card", `Segment ${i}: a card needs cardSeconds from ${MIN_CARD_SEC} to ${MAX_CARD_SEC}`, i);
      }
      seg.cardSeconds = cardSeconds;
      total += cardSeconds;
    } else {
      throw new TimelineError("bad_clip", `Segment ${i}: kind must be "clip" or "card"`, i);
    }

    const eventId = optionalString(raw.eventId, "eventId", i, "bad_clip");
    if (eventId !== undefined) seg.eventId = eventId;
    const overlay = checkOverlay(raw.overlay, i);
    if (overlay !== undefined) seg.overlay = overlay;

    const lineId = optionalString(raw.lineId, "lineId", i, "unknown_line");
    let caption: string | null = null;
    if (lineId !== undefined) {
      if (t.linesArtifactId === undefined) {
        throw new TimelineError("missing_lines_artifact", `Segment ${i} names line ${lineId} but the timeline has no linesArtifactId`, i);
      }
      const line = linesById.get(lineId);
      if (line === undefined) throw new TimelineError("unknown_line", `Segment ${i}: ${lineId} is not a checked line`, i);
      if (raw.kind === "clip" && eventId !== undefined) {
        const cited = line.cites.filter((c) => eventsById.has(c));
        if (cited.length > 0 && !cited.includes(eventId)) {
          const citing = ctx.lines.filter((l) => l.cites.includes(eventId)).map((l) => l.lineId);
          throw new TimelineError(
            "caption_not_event",
            `Segment ${i}: ${lineId} cites ${cited.join(", ")}, not this clip's ${eventId}. ` +
              (citing.length > 0
                ? `The checked line that cites ${eventId} is ${citing.join(" or ")}: use it as this clip's lineId.`
                : `No checked line cites ${eventId}: leave this clip without a lineId.`),
            i,
          );
        }
      }
      seg.lineId = lineId;
      caption = line.text;
    }

    const voiceId = optionalString(raw.voiceArtifactId, "voiceArtifactId", i, "missing_artifact");
    if (voiceId !== undefined) {
      if (!(await ctx.hasArtifact(voiceId, "voice"))) {
        throw new TimelineError("missing_artifact", `Segment ${i}: no voice artifact ${voiceId}`, i);
      }
      seg.voiceArtifactId = voiceId;
    }
    const tracksId = optionalString(raw.subjectTracksArtifactId, "subjectTracksArtifactId", i, "missing_artifact");
    if (tracksId !== undefined) {
      if (!(await ctx.hasArtifact(tracksId, "subject-tracks"))) {
        throw new TimelineError("missing_artifact", `Segment ${i}: no subject-tracks artifact ${tracksId}`, i);
      }
      seg.subjectTracksArtifactId = tracksId;
    }

    segments.push(seg);
    captions.push(caption);
  }

  if (total > MAX_TOTAL_SEC) {
    throw new TimelineError("too_long", `Timeline runs ${total} seconds; the limit is ${MAX_TOTAL_SEC}`);
  }

  const out: ResolvedTimeline = { version: 1, sourceArtifactId: t.sourceArtifactId, segments, captions };
  if (t.linesArtifactId !== undefined) out.linesArtifactId = t.linesArtifactId as string;
  return out;
}
