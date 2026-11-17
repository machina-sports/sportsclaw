/**
 * Lines of a story: facts from the run's tool results, lines drafted by the writer role,
 * and the checks a line must pass before it is spoken or drawn.
 *
 * A line passes only if every built-in check passes (each cite names a known event or fact,
 * there is at least one cite, every number is in the cited evidence) AND the skill's checker,
 * if any, says ok. A checker that throws or answers anything but one verdict per line fails
 * every line ("checker_failed"): no line gets through on a broken check.
 */

import { invokeModelRole, type ModelRoleRouterConfig } from "../inference/model-role-router.js";
import type { InferenceReceipt } from "../inference/receipt.js";
import { unsupportedNumbers } from "../number-grounding.js";
import type { RunToolResult } from "../types.js";
import type { JobKindDecl } from "./bundle.js";
import type { IndexedEvent } from "./event-index.js";
import type { JobRunner } from "./jobs.js";

export interface Fact { factId: string; toolName: string; output: string; }
export interface DraftLine { text: string; cites: string[]; }
export interface CheckedLine extends DraftLine { lineId: string; }
export interface LineVerdict { text: string; ok: boolean; reasons: string[]; }

export type LineChecker = (lines: DraftLine[], evidence: { events: IndexedEvent[]; facts: Fact[] }) => Promise<LineVerdict[]>;

export class LinesError extends Error {
  constructor(public code: "draft_unusable", message: string) {
    super(message);
    this.name = "LinesError";
  }
}

const DEFAULT_CHECK_KIND = "check-lines";
const DEFAULT_CHECK_TIMEOUT_SEC = 600;

/** Every tool result that is not an error is a fact, numbered fact_1.. in result order. */
export function collectFacts(results: RunToolResult[]): Fact[] {
  return results
    .filter((r) => !r.isError)
    .map((r, i) => ({ factId: `fact_${i + 1}`, toolName: r.toolName, output: String(r.output) }));
}

function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function draftPrompt(brief: string, events: IndexedEvent[], facts: Fact[], maxLines: number): string {
  return [
    "Write the spoken lines of a sports story.",
    `Brief: ${brief}`,
    "",
    "Events from the official play-by-play (eventId | period | clock | label | people):",
    ...events.map((e) => `- ${e.eventId} | period ${e.period} | ${clock(e.clockSec)} | ${e.label} | ${e.people.join(", ")}`),
    "",
    "Facts from data tools (factId: output):",
    ...facts.map((f) => `- ${f.factId}: ${f.output}`),
    "",
    `Write at most ${maxLines} lines. Every line must cite the eventIds and factIds that back it, and say nothing they do not.`,
    'Reply with only a JSON array of {"text": string, "cites": string[]} and nothing else.',
  ].join("\n");
}

function isDraftLine(v: unknown): v is DraftLine {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.text === "string" && o.text.trim() !== "" &&
    Array.isArray(o.cites) && o.cites.every((c) => typeof c === "string")
  );
}

function parseDraft(reply: unknown): DraftLine[] {
  const unusable = (why: string) => new LinesError("draft_unusable", `The writer's reply is not usable: ${why}.`);
  if (typeof reply !== "string") throw unusable("it is not text");
  let body = reply.trim();
  const fence = /^```json[ \t]*\n([\s\S]*?)\n?```$/.exec(body);
  if (fence) body = fence[1].trim();
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    throw unusable("it is not a JSON array");
  }
  if (!Array.isArray(doc)) throw unusable("it is not a JSON array");
  if (!doc.every(isDraftLine)) throw unusable("each element must be { text: non-empty string, cites: string[] }");
  return doc.map((l) => ({ text: l.text, cites: [...l.cites] }));
}

/** One writer-role call; its reply must be a JSON array of { text, cites } (optionally in one ```json fence). */
export async function draftLines(args: {
  inference: ModelRoleRouterConfig;
  brief: string;
  events: IndexedEvent[];
  facts: Fact[];
  maxLines: number;
  abortSignal?: AbortSignal;
  onReceipt?: (r: InferenceReceipt) => void;
}): Promise<DraftLine[]> {
  const result = await invokeModelRole({
    role: "writer",
    input: draftPrompt(args.brief, args.events, args.facts, args.maxLines),
    source: "sportsclaw-operator",
    config: args.inference,
    abortSignal: args.abortSignal,
    onReceipt: args.onReceipt,
  });
  return parseDraft(result.output).slice(0, args.maxLines);
}

function isVerdict(v: unknown): v is LineVerdict {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o.text === "string" && typeof o.ok === "boolean" && Array.isArray(o.reasons) && o.reasons.every((r) => typeof r === "string");
}

/** The checker's verdicts if there is exactly one well-formed verdict per line, in order; else undefined. */
function usableVerdicts(lines: DraftLine[], verdicts: unknown): LineVerdict[] | undefined {
  if (!Array.isArray(verdicts) || verdicts.length !== lines.length) return undefined;
  if (!verdicts.every((v, i) => isVerdict(v) && v.text === lines[i].text)) return undefined;
  return verdicts as LineVerdict[];
}

function failedVerdicts(lines: DraftLine[]): LineVerdict[] {
  return lines.map((l) => ({ text: l.text, ok: false, reasons: ["checker_failed"] }));
}

function builtInReasons(line: DraftLine, events: Map<string, IndexedEvent>, facts: Map<string, Fact>): string[] {
  const reasons: string[] = [];
  if (line.cites.some((c) => !events.has(c) && !facts.has(c))) reasons.push("unknown_cite");
  if (line.cites.length === 0) reasons.push("no_cite");
  const sources: string[] = [];
  for (const c of line.cites) {
    const e = events.get(c);
    if (e) sources.push([e.label, ...e.people].join(" "));
    const f = facts.get(c);
    if (f) sources.push(f.output);
  }
  if (unsupportedNumbers(line.text, sources).length > 0) reasons.push("unsupported_number");
  return reasons;
}

export async function checkLines(args: {
  lines: DraftLine[];
  events: IndexedEvent[];
  facts: Fact[];
  checker?: LineChecker;
}): Promise<{ verdicts: LineVerdict[]; passed: CheckedLine[] }> {
  const { lines } = args;
  const events = new Map(args.events.map((e) => [e.eventId, e]));
  const facts = new Map(args.facts.map((f) => [f.factId, f]));

  let skill: LineVerdict[] | undefined;
  if (args.checker) {
    try {
      skill = usableVerdicts(lines, await args.checker(lines, { events: args.events, facts: args.facts }));
    } catch {
      skill = undefined;
    }
    skill ??= failedVerdicts(lines);
  }

  const verdicts: LineVerdict[] = [];
  const passed: CheckedLine[] = [];
  lines.forEach((line, i) => {
    const reasons = builtInReasons(line, events, facts);
    let ok = reasons.length === 0;
    if (skill) {
      reasons.push(...skill[i].reasons);
      ok = ok && skill[i].ok;
    }
    verdicts.push({ text: line.text, ok, reasons });
    if (ok) passed.push({ text: line.text, cites: [...line.cites], lineId: `line_${passed.length + 1}` });
  });
  return { verdicts, passed };
}

/**
 * The skill's checker as a job: runs `kind` (default "check-lines") from the skill's approved bundle with
 * input { lines, evidence: { events, facts } } and reads the manifest's facts.verdicts. `skill.decls` are the
 * approved declarations of that skill (approvedJobKinds). Fails closed: no approved kind, a refused or failed
 * job, a job still running after timeoutSec (it is canceled), or verdicts that are not one LineVerdict per
 * line -> every line fails with "checker_failed".
 */
export function jobLineChecker(args: {
  runner: JobRunner;
  skill: { skillDir: string; bundleSha256: string; decls: JobKindDecl[] };
  kind?: string;
  timeoutSec?: number;
}): LineChecker {
  const kind = args.kind ?? DEFAULT_CHECK_KIND;
  const timeoutSec = args.timeoutSec ?? DEFAULT_CHECK_TIMEOUT_SEC;
  return async (lines, evidence) => {
    const decl = args.skill.decls.find((d) => d.kind === kind);
    if (!decl) return failedVerdicts(lines);
    try {
      const started = await args.runner.start({
        decl,
        skillDir: args.skill.skillDir,
        bundleSha256: args.skill.bundleSha256,
        input: { lines, evidence },
      });
      let rec = await args.runner.status(started.jobId, { waitSec: timeoutSec });
      if (rec.state === "running") rec = await args.runner.cancel(started.jobId);
      if (rec.state !== "succeeded") return failedVerdicts(lines);
      return usableVerdicts(lines, rec.facts.verdicts) ?? failedVerdicts(lines);
    } catch {
      return failedVerdicts(lines);
    }
  };
}
