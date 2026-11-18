/**
 * Media story tools — the agent runs every step of a media story through these, and the
 * preconditions here (not the prompt) enforce the order.
 *
 *   media_source_open -> media_job_start / media_job_status / media_job_cancel -> media_find_events
 *   -> story_facts_collect -> story_draft_lines -> story_check_lines -> speech_synthesize
 *   -> story_timeline_build -> story_render
 *
 * Every input that names an artifact is checked with ArtifactStore.require: known, of the kind the step
 * needs, made in this run (or shared for a source opened in this run), and its file unchanged. A refused
 * call returns `{ error_code, message }` as its tool result; it never throws into the run. Each successful
 * call appends `{ tool, artifactIds, jobId?, checker?, output?, input }` to `steps`, in call order. A step's
 * input has every string cut to STEP_INPUT_STRING_CHARS, except story_draft_lines' `brief`, kept whole (up to
 * MAX_BRIEF_CHARS); that step's `output` holds the lines the writer returned and whose writing guide it was
 * given, so a run shows what the writer was told and what it wrote.
 *
 * Errors the model sees: the engine's own refusals, with absolute paths replaced by "<path>"; a failed
 * writer or speech call as `model_call_failed` / `speech_failed` with the router's error code (`code`) and
 * no provider text; anything else as `failed` with a generic message. Job views cap the error at 2 KiB and
 * facts JSON at 8 KiB (`truncated: true`).
 *
 * Choices made here:
 *   - Paths: a source must resolve (realpath) to a regular file inside media.workspaceDir. Files the tools
 *     write go under <workspaceDir>/story/<random>/.
 *   - Artifact hand-off: in a job kind's inputSchema, a property annotated "x-artifact-kind": "<kind>" whose
 *     type is "string" (one id) or "array" (of ids) holds artifact ids. Each id is required as that kind and
 *     handed to the job in input.json's `artifacts` map. A "source" annotation needs a readsSource kind and
 *     must name the job's own source (same sha256 as sourceArtifactId), else `source_mismatch`.
 *   - Facts: Sports Skills data tools (ctx.isDataTool) plus media.factTools; nothing else.
 *   - Line checks: the skill's "check-lines" job runs when the skill whose job made the index (in this run)
 *     has that kind approved. For an index from an earlier run, the one approved skill with a "check-lines"
 *     kind (several -> checker_ambiguous). Otherwise only the built-in checks. The model cannot pick it.
 *     A run gets MAX_CHECK_ROUNDS checks (the first plus two rewrites); the next is `rewrite_limit`. The
 *     result and its step name the checker that ran ("<skill>/check-lines" or "built-in").
 *   - Writing rules: a skill's writing guide (jobs.json "writingGuide", part of its approved bundle) goes into
 *     story_draft_lines' writer prompt word for word, whatever the brief says. Whose guide: chosen as the line
 *     checker is (the skill whose job made the index in this run; for an earlier run's index, the one approved
 *     skill with a guide; several -> writing_guide_ambiguous). The result names that skill (`writingGuide`).
 *   - Voice: with inference.speech configured, story_timeline_build refuses (`voice_missing`) a segment that has
 *     a caption (lineId) and no voiceArtifactId, unless the latest speech_synthesize call for that line in this
 *     run failed in the speech service (`speech_failed`). Checked when the timeline is built, not at render: a
 *     timeline artifact is only ever made here, in this run, so none reaches a renderer unchecked, and the
 *     agent learns of it one cheap call earlier than a render.
 *   - Renderers: a kind whose produces includes "video" runs only through story_render; media_job_start
 *     refuses it (`renderer_only`), so a renderer never gets a timeline the engine did not resolve.
 *     story_render's optional `input` (never `timeline`) is merged as { timeline, ...input }, validated
 *     against the renderer's schema, and its x-artifact-kind ids go through the same checks as a job's.
 *   - Rights: under rightsCheck "require", reading the source (a source-reading job, a skill renderer, the
 *     plain renderer) needs a clearance whose sourceSha256 is the source's sha256, from operator config
 *     (media.clearances) or the app starting the run (ctx.clearances). No tool takes a rights input, so
 *     the model cannot clear a video. Under "off" nothing is needed and "off (operator)" is recorded.
 *     A video or subject-tracks artifact from an earlier run (shared) needs the same clearance for its
 *     sourceSha256 before any tool uses it.
 *   - facts, lines-checked, voice and timeline (TOOL_MINTED_KINDS) are made only by these tools: an id of
 *     one is accepted only if these tools registered it in this run (`artifact_not_minted`), so no job,
 *     earlier run or shared registry entry can supply unchecked text, voice or evidence.
 *   - A role proxy (for every configured role but brain) runs while the tools live; dispose closes it.
 *   - Prep jobs (kinds declared "prep": true) run on ctx.prep, the engine's MediaPrep: dispose does not cancel
 *     them, and media_job_status / media_job_cancel take a prep job's id from any run on that engine. A run
 *     may start config.maxJobsPerRun prep jobs, besides its own jobs. Without ctx.prep the tools keep their
 *     own MediaPrep and dispose closes it.
 */

import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve, sep } from "node:path";
import { probeVideo } from "../highlights/ffmpeg.js";
import type { RightsAuthorization } from "../highlights/types.js";
import type { ModelRoleRouterConfig } from "../inference/model-role-router.js";
import type { ModelRole } from "../inference/model-roles.js";
import type { InferenceReceipt } from "../inference/receipt.js";
import { InferenceRouteError } from "../inference/model-role-router.js";
import { SpeechRouteError, synthesizeSpeech } from "../inference/speech.js";
import type { HostToolDef, RunToolResult, SkillGuide } from "../types.js";
import { ArtifactError, ArtifactStore, hashFile } from "./artifacts.js";
import { approvedJobBundles, type ApprovedBundle, type JobKindDecl } from "./bundle.js";
import { findEvents, type EventIndex, type IndexedEvent } from "./event-index.js";
import { DEFAULT_MAX_JOBS_PER_RUN, JobError, LocalJobRunner, rightsCleared, type JobArtifactRef, type JobRecord, type JobRunner } from "./jobs.js";
import { LinesError, checkLines, collectFacts, draftLines, jobLineChecker, type CheckedLine, type DraftLine, type Fact, type LineChecker } from "./lines.js";
import { MediaPrep, type PrepSink } from "./prep.js";
import { renderPlain } from "./render-plain.js";
import { RIGHTS_OFF_NOTE, parseClearances, resolveRightsCheck } from "./rights.js";
import { startRoleProxy, type RoleProxy } from "./role-proxy.js";
import { EVENT_SLACK_SEC, TimelineError, resolveTimeline, type ResolvedTimeline } from "./timeline.js";
import { ARTIFACT_KINDS, TOOL_MINTED_KINDS, type Artifact, type ArtifactKind, type MediaClearance, type MediaConfig } from "./types.js";

export const MEDIA_TOOL_NAMES = [
  "media_source_open",
  "media_job_start",
  "media_job_status",
  "media_job_cancel",
  "media_find_events",
  "story_facts_collect",
  "story_draft_lines",
  "story_check_lines",
  "speech_synthesize",
  "story_timeline_build",
  "story_render",
] as const;

export type MediaToolName = (typeof MEDIA_TOOL_NAMES)[number];

/** The record that the agent ran a step: what it produced, or the code it was refused with. */
export interface MediaStep {
  tool: string;
  /** Empty for a refused step. */
  artifactIds: string[];
  jobId?: string;
  /** story_check_lines: the checker that ran, "<skill>/check-lines" or "built-in". */
  checker?: string;
  /** The error_code the call returned (e.g. job_budget, bundle_changed); absent when the call succeeded. */
  refused?: string;
  /**
   * story_draft_lines: `{ lines, writingGuide? }`, the lines the writer returned (each text cut to
   * STEP_OUTPUT_LINE_CHARS) and, when a skill's writing guide was given to it, `{ skill, sha256 }` of that guide.
   */
  output?: unknown;
  /** The call's input, every string capped at STEP_INPUT_STRING_CHARS; story_draft_lines' brief at MAX_BRIEF_CHARS. */
  input: unknown;
}

export const STEP_INPUT_STRING_CHARS = 200;
/** The longest brief story_draft_lines takes. Its step keeps all of it: it is what the writer was told. */
export const MAX_BRIEF_CHARS = 2000;
/** Longest line text kept in a story_draft_lines step's output. */
export const STEP_OUTPUT_LINE_CHARS = 1000;

/** A JSON copy of `v` with every string cut to `max` characters. */
function capStrings(v: unknown, max = STEP_INPUT_STRING_CHARS): unknown {
  if (typeof v === "string") return v.slice(0, max);
  if (Array.isArray(v)) return v.map((x) => capStrings(x, max));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capStrings(x, max)]));
  return typeof v === "number" && !Number.isFinite(v) ? null : v;
}

/** A step's record of a call's input. */
function stepInput(tool: MediaToolName, input: unknown): unknown {
  const capped = capStrings(input);
  if (tool === "story_draft_lines" && isPlainObject(input) && typeof input.brief === "string") {
    return { ...(capped as Record<string, unknown>), brief: input.brief.slice(0, MAX_BRIEF_CHARS) };
  }
  return capped;
}

export interface MediaToolsContext {
  config: MediaConfig;
  guides: ReadonlyArray<SkillGuide>;
  inference?: ModelRoleRouterConfig;
  runId: string;
  getToolResults: () => RunToolResult[];
  env?: Record<string, string | undefined>;
  onReceipt?: (r: InferenceReceipt) => void;
  /** True for the engine's Sports Skills data tools. Absent: only media.factTools count as facts. */
  isDataTool?: (toolName: string) => boolean;
  /** The operator's Python (sportsclawConfig.pythonPath): the job interpreter when media.interpreters has no default. */
  pythonPath?: string;
  /** Clearances the app starting this run supplies (RunOptions.mediaClearances), on top of media.clearances. */
  clearances?: MediaClearance[];
  /**
   * The engine's prep jobs (kinds declared "prep": true), which outlive this run. Absent: these tools keep
   * their own, closed by dispose().
   */
  prep?: MediaPrep;
}

/** Story checks per run: the first and two rewrite rounds. */
export const MAX_CHECK_ROUNDS = 3;
/** Longest wait one media_job_status call may ask for. */
export const MAX_STATUS_WAIT_SEC = 60;
const DEFAULT_MAX_LINES = 8;
const MAX_LINES = 20;
const MAX_JSON_ARTIFACT_BYTES = 32 * 1024 * 1024;
const CHECK_KIND = "check-lines";
/** Kinds that carry footage: shared from an earlier run, they need a clearance for their source under "require". */
const SHARED_FOOTAGE_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>(["video", "subject-tracks"]);

class Refusal extends Error {
  /** model_call_failed / speech_failed: the router's error code (a closed enum, never provider text). */
  public routeCode?: string;
  constructor(public code: string, message: string) {
    super(message);
    this.name = "Refusal";
  }
}

/** Longest error text and facts JSON a job view shows the model. */
export const MAX_VIEW_ERROR_CHARS = 2 * 1024;
export const MAX_VIEW_FACTS_CHARS = 8 * 1024;

/** An absolute POSIX path (not the second half of "a/b"): what fs, spawn and job stderr text can carry. */
const ABS_PATH_RE = /(?<![\w.~-])\/[^\s"'`<>|,;()]+/g;

/** Text for the model: absolute paths replaced by "<path>". */
function pathFree(text: string): string {
  return text.replace(ABS_PATH_RE, "<path>");
}

function routeResult(r: Refusal): Record<string, unknown> {
  return { error_code: r.code, code: r.routeCode, message: r.message };
}

function routeRefusal(kind: "model_call_failed" | "speech_failed", code: string | undefined): Refusal {
  const what = kind === "speech_failed" ? "speech" : "model";
  const r = new Refusal(kind, `The ${what} call failed (${code ?? "unknown"}).`);
  r.routeCode = code ?? "unknown";
  return r;
}

/** `value`, or when its JSON is longer than `max`, the first `max` characters of that JSON. */
function capJson(value: Record<string, unknown>, max: number): { value: unknown; cut: boolean } {
  const text = JSON.stringify(value);
  return text.length <= max ? { value, cut: false } : { value: text.slice(0, max), cut: true };
}

/** What the model sees for a call that threw: only the engine's own refusals carry a message (paths removed). */
function refusalResult(name: string, err: unknown): Record<string, unknown> {
  if (err instanceof Refusal || err instanceof ArtifactError || err instanceof JobError || err instanceof TimelineError || err instanceof LinesError) {
    return {
      error_code: err.code,
      ...(err instanceof Refusal && err.routeCode ? { code: err.routeCode } : {}),
      message: pathFree(err.message),
    };
  }
  if (err instanceof InferenceRouteError) return routeResult(routeRefusal("model_call_failed", undefined));
  if (err instanceof SpeechRouteError) return routeResult(routeRefusal("speech_failed", undefined));
  return { error_code: "failed", message: `${name} failed for an internal reason; the details are not shown.` };
}

function refuse(code: string, message: string): never {
  throw new Refusal(code, message);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Input readers: the model's arguments are untrusted.
// ---------------------------------------------------------------------------

function args(input: unknown): Record<string, unknown> {
  return isPlainObject(input) ? input : refuse("invalid_input", "Arguments must be a JSON object.");
}

function str(a: Record<string, unknown>, key: string, max = 500): string {
  const v = a[key];
  if (typeof v !== "string" || v === "" || v.length > max) refuse("invalid_input", `"${key}" must be a non-empty string.`);
  return v;
}

function optStr(a: Record<string, unknown>, key: string, max = 500): string | undefined {
  return a[key] === undefined ? undefined : str(a, key, max);
}

function strList(a: Record<string, unknown>, key: string, maxItems: number): string[] {
  const v = a[key];
  if (!Array.isArray(v) || v.length === 0 || v.length > maxItems || !v.every((s) => typeof s === "string" && s !== "" && s.length <= 500)) {
    refuse("invalid_input", `"${key}" must be a list of 1 to ${maxItems} non-empty strings.`);
  }
  return v as string[];
}

function optInt(a: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = a[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) refuse("invalid_input", `"${key}" must be an integer from ${min} to ${max}.`);
  return v;
}

/** A game clock in seconds: a finite number, zero or more. */
function optClockSec(a: Record<string, unknown>, key: string): number | undefined {
  const v = a[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) refuse("invalid_input", `"${key}" must be a number of seconds, 0 or more.`);
  return v;
}

function draftLinesArg(a: Record<string, unknown>): DraftLine[] {
  const v = a.lines;
  const good = (l: unknown): l is DraftLine =>
    isPlainObject(l) && typeof l.text === "string" && l.text.trim() !== "" && l.text.length <= 1000 &&
    Array.isArray(l.cites) && l.cites.length <= 40 && l.cites.every((c) => typeof c === "string");
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_LINES || !v.every(good)) {
    refuse("invalid_input", `"lines" must be 1 to ${MAX_LINES} lines of { text, cites: string[] }.`);
  }
  return (v as DraftLine[]).map((l) => ({ text: l.text, cites: [...l.cites] }));
}

function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Artifact documents written by the tools or by jobs
// ---------------------------------------------------------------------------

async function readJsonArtifact(a: Artifact, code: string): Promise<unknown> {
  if (a.sizeBytes > MAX_JSON_ARTIFACT_BYTES) refuse(code, `Artifact ${a.id} is larger than ${MAX_JSON_ARTIFACT_BYTES} bytes.`);
  try {
    return JSON.parse(await fs.readFile(a.path, "utf8"));
  } catch {
    return refuse(code, `Artifact ${a.id} is not valid JSON.`);
  }
}

const EVENT_KEYS = "actionId,clockSec,endSec,eventId,label,people,period,startSec,type,videoSec";

function isIndexedEvent(e: unknown): e is IndexedEvent {
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  return (
    isPlainObject(e) &&
    Object.keys(e).sort().join(",") === EVENT_KEYS &&
    typeof e.eventId === "string" && e.eventId !== "" &&
    typeof e.actionId === "string" &&
    typeof e.period === "number" && Number.isInteger(e.period) && e.period >= 1 &&
    finite(e.clockSec) && finite(e.videoSec) && finite(e.startSec) && finite(e.endSec) &&
    typeof e.label === "string" && typeof e.type === "string" &&
    Array.isArray(e.people) && e.people.every((p) => typeof p === "string")
  );
}

/** Task 7's EventIndex shape, exactly, for one of the given sources. */
function parseIndex(doc: unknown, sourceShas: string[]): EventIndex {
  const bad: (why: string) => never = (why) => refuse("bad_index", `The event index is not usable: ${why}.`);
  if (!isPlainObject(doc) || Object.keys(doc).sort().join(",") !== "events,skipped,sourceSha256,version") {
    bad("it must be { version, sourceSha256, events, skipped }");
  }
  if (doc.version !== 1) bad("version must be 1");
  if (typeof doc.sourceSha256 !== "string" || !sourceShas.includes(doc.sourceSha256)) bad("it is for another source");
  if (!Array.isArray(doc.events) || !doc.events.every(isIndexedEvent)) bad("each event must have exactly the indexed-event fields");
  const ids = new Set((doc.events as IndexedEvent[]).map((e) => e.eventId));
  if (ids.size !== (doc.events as IndexedEvent[]).length) bad("event ids repeat");
  const skippedOk = (s: unknown) =>
    isPlainObject(s) && Object.keys(s).sort().join(",") === "actionId,reason" && typeof s.actionId === "string" && s.reason === "no_stretch";
  if (!Array.isArray(doc.skipped) || !doc.skipped.every(skippedOk)) bad("skipped must be a list of { actionId, reason }");
  return doc as unknown as EventIndex;
}

function parseFacts(doc: unknown): Fact[] {
  const ok = (f: unknown): f is Fact =>
    isPlainObject(f) && Object.keys(f).sort().join(",") === "factId,output,toolName" &&
    typeof f.factId === "string" && typeof f.toolName === "string" && typeof f.output === "string";
  if (!isPlainObject(doc) || doc.version !== 1 || !Array.isArray(doc.facts) || !doc.facts.every(ok)) {
    refuse("bad_facts", "The facts artifact is not usable.");
  }
  return doc.facts as Fact[];
}

/** A lines-checked document: the lines that passed and the event index they were checked against. */
function parseLines(doc: unknown): { lines: CheckedLine[]; indexArtifactId: string } {
  const ok = (l: unknown): l is CheckedLine =>
    isPlainObject(l) && typeof l.lineId === "string" && typeof l.text === "string" &&
    Array.isArray(l.cites) && l.cites.every((c) => typeof c === "string");
  if (
    !isPlainObject(doc) || doc.version !== 1 || typeof doc.indexArtifactId !== "string" ||
    !Array.isArray(doc.lines) || !doc.lines.every(ok)
  ) {
    refuse("bad_lines", "The lines-checked artifact is not usable.");
  }
  return { lines: doc.lines as CheckedLine[], indexArtifactId: doc.indexArtifactId };
}

// ---------------------------------------------------------------------------
// Tool schemas (none names an operator setting)
// ---------------------------------------------------------------------------

const ID = { type: "string", description: "An artifact id (art_...)." };
const IDS = { type: "array", items: { type: "string" } };

const SCHEMAS: Record<MediaToolName, Record<string, unknown>> = {
  media_source_open: {
    type: "object",
    properties: {
      path: { type: "string", description: "The video file, relative to the media workspace." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  media_job_start: {
    type: "object",
    properties: {
      skill: { type: "string" },
      kind: { type: "string" },
      input: { type: "object", description: "The job's input, as its skill's jobs.json schema describes." },
      sourceArtifactId: ID,
    },
    required: ["skill", "kind", "input"],
  },
  media_job_status: {
    type: "object",
    properties: { jobId: { type: "string" }, waitSec: { type: "number", description: `Wait up to this long (max ${MAX_STATUS_WAIT_SEC}) for the job to end.` } },
    required: ["jobId"],
  },
  media_job_cancel: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] },
  media_find_events: {
    type: "object",
    properties: {
      indexArtifactId: ID,
      text: { type: "string", description: "Words that must all appear in the play's label." },
      people: { ...IDS, description: "People who must all be in the play." },
      period: { type: "integer" },
      clockMinSec: { type: "number", description: "Keep plays whose game clock, in seconds, is this or more." },
      clockMaxSec: { type: "number", description: "Keep plays whose game clock, in seconds, is this or less." },
      type: { type: "string" },
      limit: { type: "integer" },
    },
    required: ["indexArtifactId"],
  },
  story_facts_collect: { type: "object", properties: {} },
  story_draft_lines: {
    type: "object",
    properties: {
      indexArtifactId: ID,
      eventIds: { ...IDS, description: "The plays the story is about." },
      factsArtifactId: ID,
      brief: { type: "string", description: "The angle of the story." },
      maxLines: { type: "integer" },
    },
    required: ["indexArtifactId", "eventIds", "brief"],
  },
  story_check_lines: {
    type: "object",
    properties: {
      indexArtifactId: ID,
      factsArtifactId: ID,
      lines: {
        type: "array",
        items: { type: "object", properties: { text: { type: "string" }, cites: IDS }, required: ["text", "cites"] },
      },
    },
    required: ["indexArtifactId", "lines"],
  },
  speech_synthesize: {
    type: "object",
    properties: { linesArtifactId: ID, lineIds: IDS, voice: { type: "string" } },
    required: ["linesArtifactId", "lineIds"],
  },
  story_timeline_build: {
    type: "object",
    properties: {
      timeline: {
        type: "object",
        description:
          "{ version: 1, sourceArtifactId, linesArtifactId?, segments: [{ kind: 'clip', eventId?, startSec?, endSec?, lineId?, " +
          "voiceArtifactId?, subjectTracksArtifactId?, overlay? } | { kind: 'card', cardSeconds, lineId?, voiceArtifactId?, overlay? }] }. " +
          "A clip names its play by eventId (its window comes from the event index the lines were checked against) or gives " +
          `startSec and endSec; with both, the window must be within ${EVENT_SLACK_SEC}s of the event's. ` +
          "Captions are named by lineId, never written. A clip's lineId is the checked line that cites its eventId, never just the " +
          "next line in order (caption_not_event).",
      },
    },
    required: ["timeline"],
  },
  story_render: {
    type: "object",
    properties: {
      timelineArtifactId: ID,
      renderer: { type: "string", description: '"plain" (default) or an approved "<skill>/<kind>".' },
      input: { type: "object", description: "A skill renderer's own input, as its jobs.json schema describes; the engine adds timeline." },
    },
    required: ["timelineArtifactId"],
  },
};

function descriptionsFor(kinds: JobKindDecl[], guideSkills: string[]): Record<MediaToolName, string> {
  const list = kinds.length
    ? kinds
        .map((d) => {
          const notes = [
            `produces ${d.produces.join(", ") || "facts only"}`,
            ...(d.readsSource ? ["needs sourceArtifactId"] : []),
            ...(d.produces.includes("video") ? ["a renderer: run it with story_render"] : []),
            ...(d.prep ? ["prep: keeps running after this run"] : []),
          ];
          return `${d.skill}/${d.kind} (${notes.join("; ")})`;
        })
        .join("; ")
    : "none";
  return {
    media_source_open: "Open a video in the media workspace as this run's source. Returns its artifact id, duration and the artifacts already prepared for it.",
    media_job_start: `Start an approved media job. Approved kinds: ${list}.`,
    media_job_status: "A job's state; when it is done, its artifact ids and facts.",
    media_job_cancel: "Cancel a running job.",
    media_find_events:
      "Search an event-index artifact for plays. Returns eventId, period, clock, label, people, type, and where the play is in the " +
      "video: videoSec and its clip window startSec-endSec. For a stretch of the game, filter by clock instead of reading clocks " +
      "off the rows: clockMinSec and clockMaxSec bound the game clock in seconds, as the clock column shows it (5:00 is 300), " +
      "within the period you give. On a clock that counts down, the final five minutes of a period are that period with " +
      "clockMaxSec 300; on a clock that counts up, use clockMinSec.",
    story_facts_collect: "Store this run's data-tool results as a facts artifact. Returns fact ids with their tool names.",
    story_draft_lines:
      "Draft the story's lines from chosen plays and facts (one writer call). Lines are drafts until checked." +
      (guideSkills.length
        ? ` The writer is also given the writing rules of the index's skill (${guideSkills.join(", ")}), so brief is only the story's angle: do not copy rules into it.`
        : ""),
    story_check_lines: `Check lines against the plays and facts they cite. Returns verdicts and a lines-checked artifact of the lines that passed. ${MAX_CHECK_ROUNDS} checks per run.`,
    speech_synthesize: "Speak checked lines. One voice artifact per line.",
    story_timeline_build:
      "Validate a story timeline and store it as a timeline artifact. When speech is configured, every segment with a lineId " +
      "needs that line's voiceArtifactId (voice_missing), unless speech_synthesize failed for the line in this run.",
    story_render: "Render a timeline artifact to a video artifact.",
  };
}

// ---------------------------------------------------------------------------
// createMediaTools
// ---------------------------------------------------------------------------

interface OpenedSource {
  artifact: Artifact;
  durationSec: number | null;
}

interface Approved {
  bundle: ApprovedBundle;
  decl: JobKindDecl;
}

type StepResult = { result: Record<string, unknown>; artifactIds: string[]; jobId?: string; checker?: string; output?: unknown };

export async function createMediaTools(ctx: MediaToolsContext): Promise<{
  tools: Record<MediaToolName, HostToolDef>;
  /** Calls in order, refused ones with their code (the run trace's mediaSteps). */
  steps: MediaStep[];
  dispose(): Promise<void>;
}> {
  const env = ctx.env ?? process.env;
  const config = ctx.config;
  const interpreters = { ...config.interpreters };
  if (!interpreters.default && ctx.pythonPath) interpreters.default = [ctx.pythonPath];

  const clearances = [
    ...parseClearances(config.clearances, "media.clearances"),
    ...parseClearances(ctx.clearances, "mediaClearances"),
  ];
  const bundles = await approvedJobBundles(ctx.guides, env);
  const kinds = new Map<string, Approved>();
  for (const bundle of bundles) for (const decl of bundle.decls) kinds.set(`${bundle.skill}/${decl.kind}`, { bundle, decl });

  await fs.mkdir(config.workspaceDir, { recursive: true });
  const workspace = await fs.realpath(config.workspaceDir);
  const storyDir = join(workspace, "story", `run_${randomBytes(8).toString("hex")}`);
  let storyDirReady: Promise<unknown> | undefined;
  const storyFile = async (name: string): Promise<string> => {
    storyDirReady ??= fs.mkdir(storyDir, { recursive: true, mode: 0o700 });
    await storyDirReady;
    return join(storyDir, `${name}-${randomBytes(6).toString("hex")}`);
  };

  const roles = Object.keys(ctx.inference?.roles ?? {}).filter((r) => r !== "brain") as ModelRole[];
  const proxy: RoleProxy | undefined =
    ctx.inference && roles.length > 0 ? await startRoleProxy({ inference: ctx.inference, allowRoles: roles, onReceipt: ctx.onReceipt }) : undefined;

  const store = new ArtifactStore({ workspaceDir: workspace, runId: ctx.runId });
  const runner = new LocalJobRunner({
    store,
    config: { ...config, workspaceDir: workspace, interpreters },
    env,
    ...(proxy ? { roleProxy: { url: proxy.url, token: proxy.token } } : {}),
  });

  // Prep jobs run on the engine's MediaPrep; their receipts come here until dispose() ends this run.
  const ownPrep = ctx.prep ? undefined : new MediaPrep({ config, ...(ctx.inference ? { inference: ctx.inference } : {}), env, ...(ctx.pythonPath ? { pythonPath: ctx.pythonPath } : {}) });
  const prep = ctx.prep ?? ownPrep!;
  const prepSink: PrepSink = { ...(ctx.onReceipt ? { onReceipt: ctx.onReceipt } : {}), ended: false };
  let prepStarted = 0;

  const steps: MediaStep[] = [];
  const sources = new Map<string, OpenedSource>();
  /** Jobs this run started on its own runner (not prep jobs); dispose cancels them. */
  const jobs = new Map<string, Approved>();
  /** artifact id -> skill whose job made it (this run). */
  const producers = new Map<string, string>();
  let checkRounds = 0;
  /**
   * "<linesArtifactId>/<lineId>" of each line whose latest speech_synthesize call in this run failed in the
   * speech service (speech_failed): the lines story_timeline_build lets go without a voice.
   */
  const speechFailed = new Set<string>();

  const openedShas = () => [...new Set([...sources.values()].map((s) => s.artifact.sha256))];

  /**
   * The authorization for reading a source. Under "require": the first clearance for exactly this sha256
   * that clears clipping, else rights_required. Under "off": none needed.
   */
  function authorize(sha: string): { rightsOff: boolean; rights?: RightsAuthorization } {
    if (resolveRightsCheck(config, env) === "off") return { rightsOff: true };
    const c = clearances.find((x) => x.sourceSha256 === sha && rightsCleared(x));
    if (!c) {
      refuse(
        "rights_required",
        "This source has no clearance. A clearance for its exact sha256 must come from the operator config (media.clearances) " +
          "or the app starting the run (mediaClearances), not from the model.",
      );
    }
    const { sourceSha256: _sha, ...rights } = c;
    return { rightsOff: false, rights };
  }

  /** Ids of TOOL_MINTED_KINDS artifacts these tools registered in this run. */
  const minted = new Set<string>();

  async function mint(input: Parameters<ArtifactStore["register"]>[0]): Promise<Artifact> {
    const artifact = await store.register(input);
    minted.add(artifact.id);
    return artifact;
  }

  /**
   * require(), and for a shared artifact from an earlier run, require() for `sourceSha` or a source opened
   * in this run. A TOOL_MINTED_KINDS artifact must also have been registered by these tools in this run.
   */
  async function need(id: unknown, kind: ArtifactKind, sourceSha?: string): Promise<Artifact> {
    const artifact = await requireAny(id, kind, sourceSha);
    if (TOOL_MINTED_KINDS.has(kind) && !minted.has(artifact.id)) {
      refuse("artifact_not_minted", `Artifact ${artifact.id} is a ${kind} the story tools did not make in this run.`);
    }
    // Footage from an earlier run (a video, or subject tracks drawn from it) needs this run's clearance too.
    if (SHARED_FOOTAGE_KINDS.has(kind) && artifact.runId !== ctx.runId) authorize(artifact.sourceSha256 ?? "");
    return artifact;
  }

  async function requireAny(id: unknown, kind: ArtifactKind, sourceSha?: string): Promise<Artifact> {
    if (typeof id !== "string" || id === "") refuse("invalid_input", `A ${kind} artifact id is required.`);
    try {
      return await store.require(id, kind);
    } catch (err) {
      if (!(err instanceof ArtifactError) || err.code !== "artifact_wrong_source") throw err;
      for (const sha of sourceSha ? [sourceSha] : openedShas()) {
        try {
          return await store.require(id, kind, { sourceSha256: sha });
        } catch (again) {
          if (!(again instanceof ArtifactError) || again.code !== "artifact_wrong_source") throw again;
        }
      }
      throw err;
    }
  }

  async function needSource(id: unknown): Promise<OpenedSource> {
    const artifact = await need(id, "source");
    return sources.get(artifact.id) ?? { artifact, durationSec: null };
  }

  async function loadIndex(id: unknown): Promise<{ artifact: Artifact; index: EventIndex }> {
    const artifact = await need(id, "event-index");
    const shas = artifact.sourceSha256 ? [artifact.sourceSha256] : openedShas();
    return { artifact, index: parseIndex(await readJsonArtifact(artifact, "bad_index"), shas) };
  }

  async function loadFacts(id: unknown): Promise<Fact[]> {
    if (id === undefined) return [];
    return parseFacts(await readJsonArtifact(await need(id, "facts"), "bad_facts"));
  }

  async function loadLines(id: unknown): Promise<{ lines: CheckedLine[]; indexArtifactId: string }> {
    return parseLines(await readJsonArtifact(await need(id, "lines-checked"), "bad_lines"));
  }

  function noteProducers(rec: JobRecord): void {
    if (rec.state === "succeeded") for (const a of rec.artifacts) producers.set(a.id, rec.skill);
  }

  /**
   * A job record as the model sees it: no absolute paths in the error, the error capped at
   * MAX_VIEW_ERROR_CHARS and each facts object's JSON at MAX_VIEW_FACTS_CHARS (cut to a string),
   * with `truncated: true` when anything was cut.
   */
  function jobView(rec: JobRecord): Record<string, unknown> {
    let truncated = false;
    let error: string | undefined;
    if (rec.error) {
      error = pathFree(rec.error);
      if (error.length > MAX_VIEW_ERROR_CHARS) {
        error = error.slice(0, MAX_VIEW_ERROR_CHARS);
        truncated = true;
      }
    }
    const facts = (f: Record<string, unknown>) => {
      const capped = capJson(f, MAX_VIEW_FACTS_CHARS);
      truncated ||= capped.cut;
      return capped.value;
    };
    const view: Record<string, unknown> = {
      jobId: rec.jobId,
      skill: rec.skill,
      kind: rec.kind,
      state: rec.state,
      ...(error !== undefined ? { error } : {}),
      artifacts: rec.artifacts.map((a) => ({ artifactId: a.id, kind: a.kind, ...(a.facts ? { facts: facts(a.facts) } : {}) })),
      facts: facts(rec.facts),
      ...(rec.rightsCheck ? { rightsCheck: rec.rightsCheck } : {}),
      ...(rec.rights ? { rights: rec.rights } : {}),
    };
    if (truncated) view.truncated = true;
    return view;
  }

  /** The artifacts map for a job: every id in an x-artifact-kind property of its input. */
  async function artifactInputs(decl: JobKindDecl, input: Record<string, unknown>, sourceSha?: string): Promise<Record<string, JobArtifactRef>> {
    const out: Record<string, JobArtifactRef> = {};
    const props = isPlainObject(decl.inputSchema.properties) ? decl.inputSchema.properties : {};
    for (const [key, prop] of Object.entries(props)) {
      if (!isPlainObject(prop) || prop["x-artifact-kind"] === undefined) continue;
      const kind = prop["x-artifact-kind"];
      if (typeof kind !== "string" || !(ARTIFACT_KINDS as readonly string[]).includes(kind)) {
        refuse("invalid_input", `The job kind's schema names an unknown artifact kind for "${key}".`);
      }
      if (kind === "source" && !decl.readsSource) refuse("invalid_input", "Only a job kind that reads the source may take a source artifact.");
      if (!Object.hasOwn(input, key)) continue;
      const v = input[key];
      const ids = typeof v === "string" ? [v] : Array.isArray(v) && v.every((s) => typeof s === "string") ? (v as string[]) : undefined;
      if (!ids) refuse("invalid_input", `"${key}" must hold ${kind} artifact id(s).`);
      for (const id of ids) {
        const a = await need(id, kind as ArtifactKind, sourceSha);
        // One source per job: its clearance (authorize) is for sourceArtifactId's bytes only.
        if (kind === "source" && (sourceSha === undefined || a.sha256 !== sourceSha)) {
          refuse("source_mismatch", `"${key}" must name the job's own source (sourceArtifactId).`);
        }
        out[a.id] = { kind: a.kind, path: a.path, sha256: a.sha256 };
      }
    }
    return out;
  }

  /** A job of this run, or a prep job on this engine (any run's). */
  function runnerOf(jobId: string): Pick<JobRunner, "status" | "cancel"> {
    if (jobs.has(jobId)) return runner;
    if (prep.has(jobId)) return prep;
    return refuse("unknown_job", "No such job in this run, and no prep job by that id.");
  }

  async function waitForJob(jobId: string, abortSignal?: AbortSignal): Promise<JobRecord> {
    let rec = await runner.status(jobId);
    while (rec.state === "running") {
      if (abortSignal?.aborted) {
        await runner.cancel(jobId);
        refuse("aborted", "The run was aborted.");
      }
      rec = await runner.status(jobId, { waitSec: 1 });
    }
    noteProducers(rec);
    return rec;
  }

  /**
   * The approved skill an index belongs to, among those that `has` picks: the skill whose job made the index
   * in this run, else (an index from an earlier run) the only such skill; with several, `ambiguous` refuses.
   */
  function skillFor(index: Artifact, has: (b: ApprovedBundle) => boolean, ambiguous: () => never): ApprovedBundle | undefined {
    const having = bundles.filter(has);
    let skill = producers.get(index.id);
    if (skill === undefined) {
      if (having.length > 1) ambiguous();
      skill = having[0]?.skill;
    }
    return having.find((x) => x.skill === skill);
  }

  /** The line checker for an index and its name ("<skill>/check-lines", or "built-in" when there is none). */
  function checkerFor(index: Artifact): { checker?: LineChecker; name: string } {
    const b = skillFor(
      index,
      (x) => x.decls.some((d) => d.kind === CHECK_KIND),
      () => refuse("checker_ambiguous", "Several skills declare a line checker and none made this index in this run."),
    );
    if (!b) return { name: "built-in" };
    return {
      checker: jobLineChecker({ runner, skill: { skillDir: b.skillDir, bundleSha256: b.bundleSha256, decls: b.decls } }),
      name: `${b.skill}/${CHECK_KIND}`,
    };
  }

  /** The writing guide for an index: its skill's (chosen as the line checker is), or none. The model cannot pick it. */
  function guideFor(index: Artifact): { skill: string; text: string } | undefined {
    const b = skillFor(
      index,
      (x) => x.writingGuide !== undefined,
      () => refuse("writing_guide_ambiguous", "Several skills declare a writing guide and none made this index in this run."),
    );
    return b?.writingGuide === undefined ? undefined : { skill: b.skill, text: b.writingGuide };
  }

  /** A timeline only ever comes out of resolveTimeline, with lines from the exact artifact it names. */
  async function resolveForStory(t: unknown): Promise<{ resolved: ResolvedTimeline; source: OpenedSource }> {
    if (!isPlainObject(t)) refuse("invalid_input", "timeline must be an object.");
    const source = await needSource(t.sourceArtifactId);
    const checked = typeof t.linesArtifactId === "string" ? await loadLines(t.linesArtifactId) : undefined;
    const sourceDurationSec = source.durationSec;
    if (sourceDurationSec === null || !Number.isFinite(sourceDurationSec)) {
      refuse("source_duration_unknown", "The source's duration could not be read, so clips cannot be placed on it.");
    }
    const sha = source.artifact.sha256;
    // A clip may name its play by eventId: place it with the index the lines were checked against.
    const namesEvent = Array.isArray(t.segments) && t.segments.some((s) => isPlainObject(s) && s.kind === "clip" && s.eventId !== undefined);
    let events: EventIndex["events"] | undefined;
    if (checked && namesEvent) {
      const indexArtifact = await need(checked.indexArtifactId, "event-index", sha);
      events = parseIndex(await readJsonArtifact(indexArtifact, "bad_index"), [sha]).events;
    }
    const resolved = await resolveTimeline(t, {
      lines: checked?.lines ?? [],
      ...(events ? { events } : {}),
      sourceDurationSec,
      hasArtifact: async (id, kind) => {
        await need(id, kind, sha);
        return true;
      },
    });
    return { resolved, source };
  }

  async function timelineArtifacts(resolved: ResolvedTimeline, source: OpenedSource): Promise<Record<string, JobArtifactRef>> {
    const sha = source.artifact.sha256;
    const refs: [string, ArtifactKind][] = [[resolved.sourceArtifactId, "source"]];
    if (resolved.linesArtifactId) refs.push([resolved.linesArtifactId, "lines-checked"]);
    for (const s of resolved.segments) {
      if (s.voiceArtifactId) refs.push([s.voiceArtifactId, "voice"]);
      if (s.subjectTracksArtifactId) refs.push([s.subjectTracksArtifactId, "subject-tracks"]);
    }
    const out: Record<string, JobArtifactRef> = {};
    for (const [id, kind] of refs) {
      const a = await need(id, kind, sha);
      out[a.id] = { kind: a.kind, path: a.path, sha256: a.sha256 };
    }
    return out;
  }

  /**
   * A writer or speech call. A route failure becomes model_call_failed / speech_failed with the router's
   * error code from the call's receipt: the error's own message can carry provider text that echoes keys.
   */
  async function routed<T>(kind: "model_call_failed" | "speech_failed", call: (onReceipt: (r: InferenceReceipt) => void) => Promise<T>): Promise<T> {
    let code: string | undefined;
    const onReceipt = (r: InferenceReceipt) => {
      if (r.errorCode) code = r.errorCode;
      ctx.onReceipt?.(r);
    };
    try {
      return await call(onReceipt);
    } catch (err) {
      if (!(err instanceof InferenceRouteError) && !(err instanceof SpeechRouteError)) throw err;
      throw routeRefusal(kind, code);
    }
  }

  const handlers: Record<MediaToolName, (a: Record<string, unknown>, abortSignal?: AbortSignal) => Promise<StepResult>> = {
    async media_source_open(a) {
      const extra = Object.keys(a).find((k) => k !== "path");
      if (extra !== undefined) {
        refuse("unknown_field", `media_source_open takes only "path" (got "${extra.slice(0, 40)}"); footage is cleared by the operator, not in a tool call.`);
      }
      const path = str(a, "path", 4096);
      const real = await fs.realpath(resolve(workspace, path)).catch(() => undefined);
      if (real === undefined) refuse("source_not_found", "No file at that path in the media workspace.");
      if (!real.startsWith(workspace + sep)) refuse("source_outside", "The source must be a file inside the media workspace.");
      const st = await fs.stat(real);
      if (!st.isFile()) refuse("source_not_found", "The source is not a regular file.");
      const sha = await hashFile(real);
      const artifact = await store.register({ kind: "source", path: real, sourceSha256: sha });
      let durationSec: number | null = null;
      try {
        const d = Number((await probeVideo(real)).format?.duration);
        if (Number.isFinite(d) && d > 0) durationSec = d;
      } catch {
        durationSec = null;
      }
      sources.set(artifact.id, { artifact, durationSec });
      const shared = (await store.forSource(sha)).map((s) => ({
        artifactId: s.id,
        kind: s.kind,
        createdAt: s.createdAt,
        ...(s.facts ? { facts: s.facts } : {}),
      }));
      return { result: { sourceArtifactId: artifact.id, sha256: sha, durationSec, shared }, artifactIds: [artifact.id] };
    },

    async media_job_start(a) {
      const skill = str(a, "skill", 200);
      const kind = str(a, "kind", 200);
      const approved = kinds.get(`${skill}/${kind}`);
      if (!approved) refuse("unknown_kind", `No approved job kind ${skill}/${kind}.`);
      if (!isPlainObject(a.input)) refuse("invalid_input", "input must be an object.");
      const { bundle, decl } = approved;
      // A renderer draws captions: it runs only through story_render, on a timeline the engine resolved.
      if (decl.produces.includes("video")) refuse("renderer_only", `${skill}/${kind} is a renderer; run it with story_render.`);
      const source = a.sourceArtifactId === undefined ? undefined : await needSource(a.sourceArtifactId);
      const artifacts = await artifactInputs(decl, a.input, source?.artifact.sha256);
      if (decl.readsSource && !source) refuse("source_required", "This job kind reads the source: give sourceArtifactId.");
      const rights = decl.readsSource && source ? authorize(source.artifact.sha256).rights : undefined;
      const req = {
        decl,
        skillDir: bundle.skillDir,
        bundleSha256: bundle.bundleSha256,
        input: a.input,
        ...(decl.readsSource && source
          ? { source: { path: source.artifact.path, sha256: source.artifact.sha256, ...(rights ? { rights } : {}) } }
          : {}),
        artifacts,
      };
      if (decl.prep) {
        const maxJobs = config.maxJobsPerRun ?? DEFAULT_MAX_JOBS_PER_RUN;
        if (prepStarted >= maxJobs) refuse("job_budget", `This run already started its ${maxJobs} prep jobs.`);
        const rec = await prep.start(req, prepSink);
        prepStarted++;
        return { result: { jobId: rec.jobId, state: rec.state, prep: true }, artifactIds: [], jobId: rec.jobId };
      }
      const rec = await runner.start(req);
      jobs.set(rec.jobId, approved);
      return { result: { jobId: rec.jobId, state: rec.state }, artifactIds: [], jobId: rec.jobId };
    },

    async media_job_status(a) {
      const jobId = str(a, "jobId", 100);
      const raw = a.waitSec;
      const waitSec = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.min(MAX_STATUS_WAIT_SEC, raw) : 0;
      const rec = await runnerOf(jobId).status(jobId, { waitSec });
      noteProducers(rec);
      return { result: jobView(rec), artifactIds: rec.artifacts.map((x) => x.id), jobId };
    },

    async media_job_cancel(a) {
      const jobId = str(a, "jobId", 100);
      const rec = await runnerOf(jobId).cancel(jobId);
      noteProducers(rec);
      return { result: jobView(rec), artifactIds: rec.artifacts.map((x) => x.id), jobId };
    },

    async media_find_events(a) {
      const { index } = await loadIndex(a.indexArtifactId);
      const people = a.people === undefined ? undefined : strList(a, "people", 10);
      const rows = findEvents(index, {
        text: optStr(a, "text"),
        people,
        period: optInt(a, "period", 1, 100),
        clockMinSec: optClockSec(a, "clockMinSec"),
        clockMaxSec: optClockSec(a, "clockMaxSec"),
        type: optStr(a, "type", 100),
        limit: optInt(a, "limit", 1, 1000),
      }).map((e) => ({
        eventId: e.eventId, period: e.period, clock: clock(e.clockSec), label: e.label, people: e.people,
        type: e.type, videoSec: e.videoSec, startSec: e.startSec, endSec: e.endSec,
      }));
      return { result: { events: rows }, artifactIds: [] };
    },

    async story_facts_collect() {
      const listed = new Set(config.factTools ?? []);
      const isDataTool = (name: string) => listed.has(name) || (ctx.isDataTool?.(name) ?? false);
      const facts = collectFacts(ctx.getToolResults(), { isDataTool });
      const file = await storyFile("facts");
      await fs.writeFile(file, JSON.stringify({ version: 1, facts }), { mode: 0o600 });
      const artifact = await mint({ kind: "facts", path: file });
      return {
        result: { factsArtifactId: artifact.id, facts: facts.map((f) => ({ factId: f.factId, toolName: f.toolName })) },
        artifactIds: [artifact.id],
      };
    },

    async story_draft_lines(a, abortSignal) {
      const { artifact: indexArtifact, index } = await loadIndex(a.indexArtifactId);
      const eventIds = strList(a, "eventIds", 40);
      const brief = str(a, "brief", MAX_BRIEF_CHARS);
      const maxLines = optInt(a, "maxLines", 1, MAX_LINES) ?? DEFAULT_MAX_LINES;
      const facts = await loadFacts(a.factsArtifactId);
      const byId = new Map(index.events.map((e) => [e.eventId, e]));
      const events = eventIds.map((id) => byId.get(id) ?? refuse("unknown_event", `No event ${id.slice(0, 60)} in the index.`));
      if (!ctx.inference?.roles?.writer) refuse("no_writer", "No writer role is configured (inference.roles.writer).");
      const inference = ctx.inference;
      const guide = guideFor(indexArtifact);
      const lines = await routed("model_call_failed", (onReceipt) =>
        draftLines({ inference, brief, ...(guide ? { guide: guide.text } : {}), events, facts, maxLines, abortSignal, onReceipt }),
      );
      return {
        result: { lines, ...(guide ? { writingGuide: guide.skill } : {}) },
        artifactIds: [],
        output: {
          lines: capStrings(lines, STEP_OUTPUT_LINE_CHARS),
          ...(guide ? { writingGuide: { skill: guide.skill, sha256: createHash("sha256").update(guide.text).digest("hex") } } : {}),
        },
      };
    },

    async story_check_lines(a) {
      const lines = draftLinesArg(a);
      const { artifact: indexArtifact, index } = await loadIndex(a.indexArtifactId);
      const facts = await loadFacts(a.factsArtifactId);
      if (checkRounds >= MAX_CHECK_ROUNDS) {
        refuse("rewrite_limit", `This run has used its ${MAX_CHECK_ROUNDS} checks (two rewrite rounds); drop the lines that failed.`);
      }
      const { checker, name: checkerName } = checkerFor(indexArtifact);
      checkRounds++;
      const { verdicts, passed } = await checkLines({ lines, events: index.events, facts, checker });
      const file = await storyFile("lines");
      await fs.writeFile(file, JSON.stringify({ version: 1, indexArtifactId: indexArtifact.id, lines: passed }), { mode: 0o600 });
      const artifact = await mint({ kind: "lines-checked", path: file });
      return {
        result: {
          verdicts,
          linesArtifactId: artifact.id,
          passed: passed.map((l) => ({ lineId: l.lineId, text: l.text })),
          rewritesLeft: MAX_CHECK_ROUNDS - checkRounds,
          checker: checkerName,
        },
        artifactIds: [artifact.id],
        checker: checkerName,
      };
    },

    async speech_synthesize(a, abortSignal) {
      const lineIds = strList(a, "lineIds", MAX_LINES);
      const voice = optStr(a, "voice", 200);
      const lines = new Map((await loadLines(a.linesArtifactId)).lines.map((l) => [l.lineId, l]));
      const chosen = lineIds.map((id) => lines.get(id) ?? refuse("unknown_line", `${id.slice(0, 60)} is not a line that passed the check.`));
      if (!ctx.inference?.speech) refuse("no_speech", "No speech route is configured (inference.speech).");
      const voices: { lineId: string; voiceArtifactId: string; durationMs: number }[] = [];
      const inference = ctx.inference;
      const keys = chosen.map((line) => `${a.linesArtifactId}/${line.lineId}`);
      try {
        for (const line of chosen) {
          const said = await routed("speech_failed", (onReceipt) =>
            synthesizeSpeech({ text: line.text, config: inference, ...(voice ? { voice } : {}), abortSignal, onReceipt, env }),
          );
          const file = `${await storyFile("voice")}.wav`;
          await fs.writeFile(file, said.audio, { mode: 0o600 });
          const artifact = await mint({ kind: "voice", path: file });
          voices.push({ lineId: line.lineId, voiceArtifactId: artifact.id, durationMs: said.durationMs });
        }
      } catch (err) {
        // A failed call returns no voice id for any of its lines, also those spoken before the failing one.
        if (err instanceof Refusal && err.code === "speech_failed") for (const key of keys) speechFailed.add(key);
        throw err;
      }
      for (const key of keys) speechFailed.delete(key);
      return { result: { voices }, artifactIds: voices.map((v) => v.voiceArtifactId) };
    },

    async story_timeline_build(a) {
      const { resolved } = await resolveForStory(a.timeline);
      // A voiced story has a voice: with speech configured, every captioned segment carries its line's voice,
      // unless speaking that line failed in this run.
      if (ctx.inference?.speech) {
        const unvoiced = resolved.segments.flatMap((s, i) =>
          s.lineId !== undefined && s.voiceArtifactId === undefined && !speechFailed.has(`${resolved.linesArtifactId}/${s.lineId}`)
            ? [`segment ${i} (${s.lineId})`]
            : [],
        );
        if (unvoiced.length > 0) {
          refuse(
            "voice_missing",
            `Speech is configured, but ${unvoiced.join(", ")} ${unvoiced.length > 1 ? "have" : "has"} a caption and no voiceArtifactId. ` +
              "Call speech_synthesize for those lineIds and put each line's voiceArtifactId on its segment. " +
              "A line may go without a voice only when speech_synthesize failed for it (speech_failed) in this run.",
          );
        }
      }
      const { captions: _captions, ...timeline } = resolved;
      const file = await storyFile("timeline");
      await fs.writeFile(file, JSON.stringify(timeline), { mode: 0o600 });
      const artifact = await mint({ kind: "timeline", path: file });
      return { result: { timelineArtifactId: artifact.id, segments: resolved.segments.length }, artifactIds: [artifact.id] };
    },

    async story_render(a, abortSignal) {
      const timelineArtifact = await need(a.timelineArtifactId, "timeline");
      const renderer = optStr(a, "renderer", 200) ?? "plain";
      if (a.input !== undefined && !isPlainObject(a.input)) refuse("invalid_input", "input must be an object.");
      const extra = a.input ?? {};
      if (Object.hasOwn(extra, "timeline")) refuse("invalid_input", '"timeline" is reserved: story_render passes the timeline it resolved.');
      if (renderer === "plain" && Object.keys(extra).length > 0) refuse("invalid_input", "input is for a skill renderer; the plain renderer takes none.");
      const { resolved, source } = await resolveForStory(await readJsonArtifact(timelineArtifact, "bad_timeline"));
      const sha = source.artifact.sha256;

      if (renderer !== "plain") {
        const approved = kinds.get(renderer);
        if (!approved) refuse("unknown_kind", `No approved renderer ${renderer}.`);
        const { bundle, decl } = approved;
        if (!decl.produces.includes("video") || !decl.readsSource) {
          refuse("renderer_invalid", `${renderer} is not a renderer: it must read the source and produce video.`);
        }
        // The renderer's own input (its schema, x-artifact-kind ids, one source) beside the resolved timeline.
        const artifacts = { ...(await artifactInputs(decl, extra, sha)), ...(await timelineArtifacts(resolved, source)) };
        const { rights } = authorize(sha);
        const started = await runner.start({
          decl,
          skillDir: bundle.skillDir,
          bundleSha256: bundle.bundleSha256,
          input: { timeline: resolved, ...extra },
          source: { path: source.artifact.path, sha256: sha, ...(rights ? { rights } : {}) },
          artifacts,
        });
        jobs.set(started.jobId, approved);
        const rec = await waitForJob(started.jobId, abortSignal);
        if (rec.state !== "succeeded") refuse("render_failed", (rec.error ?? `the render job ended ${rec.state}`).slice(0, MAX_VIEW_ERROR_CHARS));
        const video = rec.artifacts.find((x) => x.kind === "video");
        if (!video) refuse("render_failed", "The renderer made no video artifact.");
        let durationSec: number | null = Number((await probeVideo(video.path).catch(() => undefined))?.format?.duration);
        if (!Number.isFinite(durationSec)) durationSec = null;
        return {
          result: {
            videoArtifactId: video.id, durationSec, renderer, jobId: rec.jobId,
            ...(rec.rightsCheck ? { rightsCheck: rec.rightsCheck } : {}),
            ...(rec.rights ? { rights: rec.rights } : {}),
          },
          artifactIds: rec.artifacts.map((x) => x.id),
          jobId: rec.jobId,
        };
      }

      const { rightsOff, rights } = authorize(sha);
      const used = rights
        ? { rightsHolder: rights.rightsHolder, licenseRef: rights.licenseRef, ...(rights.territories ? { territories: rights.territories } : {}) }
        : undefined;
      const voicePaths: Record<string, string> = {};
      for (const s of resolved.segments) {
        if (s.voiceArtifactId) voicePaths[s.voiceArtifactId] = (await need(s.voiceArtifactId, "voice", sha)).path;
      }
      const outPath = `${await storyFile("video")}.mp4`;
      const { durationSec } = await renderPlain({ timeline: resolved, sourcePath: source.artifact.path, voicePaths, outPath, abortSignal });
      const video = await store.register({
        kind: "video",
        path: outPath,
        sourceSha256: sha,
        facts: rightsOff ? { rightsCheck: RIGHTS_OFF_NOTE } : { rights: used },
      });
      return {
        result: { videoArtifactId: video.id, durationSec, renderer, ...(rightsOff ? { rightsCheck: RIGHTS_OFF_NOTE } : { rights: used }) },
        artifactIds: [video.id],
      };
    },
  };

  const descriptions = descriptionsFor(
    [...kinds.values()].map((k) => k.decl),
    bundles.filter((b) => b.writingGuide !== undefined).map((b) => b.skill),
  );
  const tools = {} as Record<MediaToolName, HostToolDef>;
  for (const name of MEDIA_TOOL_NAMES) {
    tools[name] = {
      description: descriptions[name],
      inputSchema: SCHEMAS[name],
      async execute(input, { abortSignal }) {
        try {
          const out = await handlers[name](args(input ?? {}), abortSignal);
          steps.push({
            tool: name,
            artifactIds: out.artifactIds,
            ...(out.jobId ? { jobId: out.jobId } : {}),
            ...(out.checker ? { checker: out.checker } : {}),
            ...(out.output !== undefined ? { output: out.output } : {}),
            input: stepInput(name, input ?? {}),
          });
          return out.result;
        } catch (err) {
          const out = refusalResult(name, err);
          // A refused call is a step too: the trace must not read as if it never happened (or as if it ran).
          steps.push({ tool: name, artifactIds: [], refused: String(out.error_code), input: stepInput(name, input ?? {}) });
          return out;
        }
      },
    };
  }

  let disposed: Promise<void> | undefined;
  return {
    tools,
    steps,
    dispose() {
      disposed ??= (async () => {
        // This run's jobs end with it; prep jobs on the engine's MediaPrep keep running.
        prepSink.ended = true;
        for (const jobId of jobs.keys()) await runner.cancel(jobId).catch(() => undefined);
        await ownPrep?.close();
        await proxy?.close();
      })();
      return disposed;
    },
  };
}
