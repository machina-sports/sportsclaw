/**
 * sportsclaw — Bench runner
 *
 * Runs a JSONL dataset of prompts through the engine, one case at a time, and
 * writes one JSON line per case plus a start header and a closing summary.
 * It produces evidence, not scores: grading belongs to the evaluator (Arena).
 *
 * Dataset format — one JSON object per line, blank lines ignored:
 *   {"id": "nba-001", "prompt": "Who won Knicks vs Celtics on 2026-01-01?",
 *    "system_prompt": "optional per-case caller prompt",
 *    "skills": ["nba"],  // tool scope for the raw-tools arm
 *    "metadata": {"any": "passthrough"}}
 *
 * Every non-blank line is accounted for in the output: `ok`, `halted` (the
 * model asked the user a question), `error`, `timeout` (exceeded the per-case
 * limit), `invalid` (unparseable or missing fields) or `duplicate` (repeated
 * id; only the first occurrence runs). Cases past `--limit` are counted as
 * `not_run`. Nothing is silently dropped.
 */

import { createHash } from "node:crypto";
import { isHalt, TOOL_OUTPUT_CHAR_CAP, type TokenUsage } from "./engine.js";
import { buildRunManifest, type RunManifest, type RunTrace, type SportsSkillsSource } from "./run-manifest.js";
import type { LLMProvider, SamplingConfig, ToolProgressEvent } from "./types.js";

export const BENCH_OUTPUT_VERSION = 1;

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

export interface BenchCase {
  id: string;
  prompt: string;
  systemPrompt?: string;
  /** Skills whose data tools the raw-tools arm offers for this case. */
  skills?: string[];
  metadata?: Record<string, unknown>;
  /** 1-based line number in the dataset file. */
  line: number;
}

export interface DatasetProblem {
  line: number;
  kind: "invalid" | "duplicate";
  id: string | null;
  message: string;
}

export interface ParsedDataset {
  cases: BenchCase[];
  problems: DatasetProblem[];
  /** Non-blank lines in the file. */
  lineCount: number;
  sha256: string;
}

export function parseDataset(text: string): ParsedDataset {
  const cases: BenchCase[] = [];
  const problems: DatasetProblem[] = [];
  const seen = new Set<string>();
  let lineCount = 0;

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    if (raw.trim() === "") return;
    lineCount++;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (err) {
      problems.push({ line, kind: "invalid", id: null, message: `not valid JSON: ${(err as Error).message}` });
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      problems.push({ line, kind: "invalid", id: null, message: "each line must be a JSON object" });
      return;
    }
    const obj = value as Record<string, unknown>;
    const id = typeof obj.id === "string" && obj.id.trim() !== "" ? obj.id : null;
    if (!id) {
      problems.push({ line, kind: "invalid", id: null, message: "missing or empty string field \"id\"" });
      return;
    }
    if (typeof obj.prompt !== "string" || obj.prompt.trim() === "") {
      problems.push({ line, kind: "invalid", id, message: "missing or empty string field \"prompt\"" });
      return;
    }
    if (obj.system_prompt !== undefined && typeof obj.system_prompt !== "string") {
      problems.push({ line, kind: "invalid", id, message: "\"system_prompt\" must be a string" });
      return;
    }
    if (obj.metadata !== undefined && (typeof obj.metadata !== "object" || obj.metadata === null || Array.isArray(obj.metadata))) {
      problems.push({ line, kind: "invalid", id, message: "\"metadata\" must be an object" });
      return;
    }
    if (
      obj.skills !== undefined &&
      (!Array.isArray(obj.skills) || obj.skills.some((s) => typeof s !== "string" || s.trim() === ""))
    ) {
      problems.push({ line, kind: "invalid", id, message: "\"skills\" must be an array of non-empty strings" });
      return;
    }
    if (seen.has(id)) {
      problems.push({ line, kind: "duplicate", id, message: `duplicate id; first occurrence runs, this one does not` });
      return;
    }
    seen.add(id);
    cases.push({
      id,
      prompt: obj.prompt,
      ...(obj.system_prompt !== undefined ? { systemPrompt: obj.system_prompt as string } : {}),
      ...(obj.skills !== undefined ? { skills: [...new Set(obj.skills as string[])].sort() } : {}),
      ...(obj.metadata !== undefined ? { metadata: obj.metadata as Record<string, unknown> } : {}),
      line,
    });
  });

  return { cases, problems, lineCount, sha256: createHash("sha256").update(text, "utf8").digest("hex") };
}

// ---------------------------------------------------------------------------
// Tool allowlist
// ---------------------------------------------------------------------------

/** Parse a comma-separated tool list; empty entries dropped, order-insensitive. */
export function parseToolList(value: string): string[] {
  return [...new Set(value.split(",").map((s) => s.trim()).filter(Boolean))].sort();
}

/** Allowlisted names the engine does not provide. */
export function unknownTools(allowlist: readonly string[], available: readonly string[]): string[] {
  const have = new Set(available);
  return allowlist.filter((name) => !have.has(name)).sort();
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** The engine surface the runner uses; `sportsclawEngine` satisfies it. */
export interface BenchEngine {
  run(prompt: string, options?: {
    systemPrompt?: string;
    onProgress?: (event: ToolProgressEvent) => void;
    abortSignal?: AbortSignal;
  }): Promise<string>;
  /** Minimal baseline loop (no routing/verification); required for the direct and raw-tools arms. */
  runDirect?(prompt: string, options: {
    skills: readonly string[];
    systemPrompt?: string;
    onProgress?: (event: ToolProgressEvent) => void;
    abortSignal?: AbortSignal;
  }): Promise<string>;
  /** Registry data tools of the given skills; required for the routed_oracle arm. */
  dataToolNamesForSkills?(skills: readonly string[]): string[];
  /** Restrict the offered tools (null removes the restriction); required for routed_oracle. */
  setToolAllowlist?(names: readonly string[] | null): void;
  reset(): void;
  readonly lastRunTrace: RunTrace | null;
  readonly lastTokenUsage: TokenUsage | null;
  readonly modelId: string;
  readonly packageVersion: string;
  readonly manifestConfig: {
    provider: LLMProvider;
    sampling: SamplingConfig;
    maxOutputTokens: number;
    maxTurns: number;
    thinkingBudget: number;
    toolAllowlist: string[] | null;
  };
}

export type CaseStatus = "ok" | "halted" | "error" | "timeout" | "invalid" | "duplicate";

/**
 * Which harness answers each case:
 *   - `routed`: the full sportsclaw engine (routing, verification, evidence gate);
 *   - `raw_tools`: a minimal tool loop over the case's `skills` data tools;
 *   - `direct`: the same minimal loop with no tools;
 *   - `routed_oracle` (diagnostic): the full engine, but offered only the case's
 *     `skills` tools, so routing loss and pipeline loss can be told apart.
 */
export type BenchArm = "routed" | "raw_tools" | "direct" | "routed_oracle";
export const BENCH_ARMS: readonly BenchArm[] = ["routed", "raw_tools", "direct", "routed_oracle"];

/** Arms whose tool surface comes from each case's `skills`. */
const SKILL_SCOPED_ARMS: readonly BenchArm[] = ["raw_tools", "direct", "routed_oracle"];

export const DEFAULT_CASE_TIMEOUT_S = 300;

/**
 * Skills never offered in a benchmark: account/order tools that need
 * credentials, move money, and return no sports data.
 */
export const BENCH_EXCLUDED_SKILLS: readonly string[] = ["polymarket-trading"];

/** Drop tools that belong to an excluded skill (tool names are `<skill>_<command>`). */
export function withoutExcludedSkills(toolNames: readonly string[]): string[] {
  return toolNames.filter((name) => !BENCH_EXCLUDED_SKILLS.some((skill) => name.startsWith(`${skill}_`)));
}

export interface ToolCallRecord {
  name: string;
  success: boolean | null;
  duration_ms: number | null;
  /** JSON of the model-provided arguments, capped at TRACE_TEXT_CAP chars. */
  args: string | null;
  /** Error text of a failed call, capped at TRACE_TEXT_CAP chars. */
  error: string | null;
  /** Length of the output handed back to the model. */
  output_chars: number | null;
  /** Whether the output was cut at TOOL_OUTPUT_CHAR_CAP. */
  truncated: boolean | null;
}

/** Cap for per-call args and error text in case lines. */
export const TRACE_TEXT_CAP = 300;

function capText(text: string): string {
  return text.length > TRACE_TEXT_CAP ? `${text.slice(0, TRACE_TEXT_CAP - 1)}…` : text;
}

function argsText(input: unknown): string | null {
  if (input === undefined) return null;
  try {
    const json = JSON.stringify(input);
    return json === undefined ? null : capText(json);
  } catch {
    return null;
  }
}

export interface BenchRunOptions {
  engine: BenchEngine;
  dataset: ParsedDataset;
  datasetPath: string;
  sportsSkillsVersion: string | null;
  sportsSkillsSource?: SportsSkillsSource | null;
  /** Caller system prompt applied to cases that do not set their own. */
  systemPrompt?: string;
  /** Run at most this many valid cases; the rest are counted `not_run`. */
  limit?: number;
  /** Harness per case. Defaults to `routed`. */
  arm?: BenchArm;
  /** Per-case wall-clock limit; the case is aborted and recorded as `timeout`. */
  caseTimeoutS?: number;
  /** How long a timed-out run gets to unwind before the next case (default 5 s). */
  abortGraceMs?: number;
  /** Receives each output line as an object; the caller serializes it. */
  emit: (line: Record<string, unknown>) => void | Promise<void>;
  now?: () => number;
  env?: Record<string, string | undefined>;
}

export interface BenchSummary {
  type: "bench_summary";
  expected: number;
  ok: number;
  halted: number;
  errored: number;
  timed_out: number;
  invalid: number;
  duplicate: number;
  not_run: number;
  wall_ms: number;
  tokens: { input: number; output: number; total: number };
}

/** How long an aborted (timed-out) run gets to unwind before the next case starts. */
const ABORT_GRACE_MS = 5_000;

class CaseTimeout extends Error {
  constructor(seconds: number) {
    super(`case exceeded the ${seconds}s timeout and was aborted`);
    this.name = "CaseTimeout";
  }
}

function manifestFor(
  opts: BenchRunOptions,
  systemPrompt: string | undefined,
  trace: RunTrace | null,
  skills?: readonly string[],
): RunManifest {
  const cfg = opts.engine.manifestConfig;
  const arm = opts.arm ?? "routed";
  return buildRunManifest({
    bench: {
      arm,
      case_timeout_s: opts.caseTimeoutS ?? DEFAULT_CASE_TIMEOUT_S,
      tool_output_char_cap: TOOL_OUTPUT_CHAR_CAP,
      // The baseline arms don't use the engine allowlist; their surface is the case's skills.
      ...(arm !== "routed" && skills !== undefined ? { skills: [...skills] } : {}),
    },
    sportsclawVersion: opts.engine.packageVersion,
    sportsSkillsVersion: opts.sportsSkillsVersion,
    sportsSkillsSource: opts.sportsSkillsSource,
    provider: cfg.provider,
    model: opts.engine.modelId,
    sampling: cfg.sampling,
    maxOutputTokens: cfg.maxOutputTokens,
    maxTurns: cfg.maxTurns,
    thinkingBudget: cfg.thinkingBudget,
    // routed_oracle sets the engine allowlist per case, so it is recorded as such.
    toolAllowlist: arm === "routed" || arm === "routed_oracle" ? cfg.toolAllowlist : null,
    callerSystemPrompt: systemPrompt,
    env: opts.env,
    trace,
  });
}

export async function runBench(opts: BenchRunOptions): Promise<BenchSummary> {
  const now = opts.now ?? Date.now;
  const started = now();
  const { dataset } = opts;
  const limit = opts.limit !== undefined ? Math.max(0, Math.floor(opts.limit)) : dataset.cases.length;
  const toRun = dataset.cases.slice(0, limit);
  const arm = opts.arm ?? "routed";
  const caseTimeoutS = opts.caseTimeoutS ?? DEFAULT_CASE_TIMEOUT_S;
  if (!(caseTimeoutS > 0)) throw new Error(`caseTimeoutS must be positive (got ${caseTimeoutS})`);
  if ((arm === "raw_tools" || arm === "direct") && !opts.engine.runDirect) {
    throw new Error(`the ${arm} arm needs an engine with runDirect()`);
  }
  if (arm === "routed_oracle" && !(opts.engine.dataToolNamesForSkills && opts.engine.setToolAllowlist)) {
    throw new Error("the routed_oracle arm needs an engine with dataToolNamesForSkills() and setToolAllowlist()");
  }

  const base = manifestFor(opts, opts.systemPrompt, null);
  await opts.emit({
    type: "bench_start",
    bench_output_version: BENCH_OUTPUT_VERSION,
    started_at: new Date(started).toISOString(),
    dataset: {
      path: opts.datasetPath,
      sha256: dataset.sha256,
      lines: dataset.lineCount,
      valid_cases: dataset.cases.length,
      problems: dataset.problems.length,
    },
    limit: opts.limit ?? null,
    arm,
    case_timeout_s: caseTimeoutS,
    manifest_version: base.manifest_version,
    config_sha256: base.config_sha256,
    config: base.config,
  });

  const counts = { ok: 0, halted: 0, errored: 0, timedOut: 0, invalid: 0 };
  const tokens = { input: 0, output: 0, total: 0 };
  let executed = 0;

  for (const problem of dataset.problems) {
    await opts.emit({
      type: "case",
      id: problem.id,
      line: problem.line,
      status: problem.kind satisfies CaseStatus,
      error: problem.message,
    });
  }

  for (const c of toRun) {
    const systemPrompt = c.systemPrompt ?? opts.systemPrompt;
    const toolCalls: ToolCallRecord[] = [];
    const pending = new Map<string, ToolCallRecord>();
    const onProgress = (event: ToolProgressEvent) => {
      if (event.type === "tool_start") {
        const record: ToolCallRecord = {
          name: event.toolName, success: null, duration_ms: null, args: null, error: null, output_chars: null, truncated: null,
        };
        toolCalls.push(record);
        pending.set(event.toolCallId, record);
      } else if (event.type === "tool_finish") {
        const finished = {
          success: event.success ?? null,
          duration_ms: event.durationMs ?? null,
          args: argsText(event.input),
          error: event.error !== undefined ? capText(event.error) : null,
          output_chars: event.outputChars ?? null,
          truncated: event.truncated ?? null,
        };
        const record = pending.get(event.toolCallId);
        if (record) {
          Object.assign(record, finished);
          pending.delete(event.toolCallId);
        } else {
          toolCalls.push({ name: event.toolName, ...finished });
        }
      }
    };

    const skills = arm === "direct" ? [] : SKILL_SCOPED_ARMS.includes(arm) ? (c.skills ?? null) : undefined;
    const excluded = skills?.filter((s) => BENCH_EXCLUDED_SKILLS.includes(s)) ?? [];
    if (skills === null || excluded.length > 0) {
      // raw_tools needs a declared tool scope; never guess one, never widen it.
      counts.invalid++;
      await opts.emit({
        type: "case",
        id: c.id,
        line: c.line,
        status: "invalid" satisfies CaseStatus,
        error: skills === null
          ? `${arm} arm needs a "skills" array on the case`
          : `skills not allowed in a benchmark: ${excluded.join(", ")}`,
      });
      continue;
    }

    // Each case starts from an empty conversation; no userId, so no memory.
    opts.engine.reset();
    const caseStart = now();
    const phases: Array<{ label: string; at_ms: number }> = [];
    const observe = (event: ToolProgressEvent) => {
      if (event.type === "phase") phases.push({ label: event.label, at_ms: now() - caseStart });
      onProgress(event);
    };
    let status: CaseStatus = "ok";
    let answer: string | null = null;
    let error: string | null = null;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Flag first: a run that honours the signal rejects as soon as we abort,
        // and that rejection must still be recorded as a timeout, not an error.
        timedOut = true;
        reject(new CaseTimeout(caseTimeoutS));
        controller.abort();
      }, caseTimeoutS * 1000);
    });
    let running: Promise<string> | undefined;
    try {
      const common = {
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        onProgress: observe,
        abortSignal: controller.signal,
      };
      if (arm === "routed_oracle") {
        // Full engine (routing, verification, evidence gate) over the gold surface.
        opts.engine.setToolAllowlist!(withoutExcludedSkills(opts.engine.dataToolNamesForSkills!(skills ?? [])));
      }
      running = skills === undefined || arm === "routed_oracle"
        ? opts.engine.run(c.prompt, common)
        : opts.engine.runDirect!(c.prompt, { ...common, skills });
      // Abort is best effort (a tool subprocess may ignore it), so the
      // deadline also races the run: a hung case can never stall the bench.
      running.catch(() => {});
      answer = await Promise.race([running, deadline]);
    } catch (err) {
      if (timedOut || err instanceof CaseTimeout) {
        status = "timeout";
        error = new CaseTimeout(caseTimeoutS).message;
        // Give the aborted run a moment to unwind so it can't write into the next case.
        let grace: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          running?.catch(() => {}),
          new Promise((r) => { grace = setTimeout(r, opts.abortGraceMs ?? ABORT_GRACE_MS); }),
        ]);
        clearTimeout(grace);
      } else if (isHalt(err)) {
        status = "halted";
        error = `run halted: ${err instanceof Error ? err.message : String(err)}`;
      } else {
        status = "error";
        error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      clearTimeout(timer);
    }
    const latency = now() - caseStart;
    const usage = status === "timeout" ? null : opts.engine.lastTokenUsage;
    if (usage) {
      tokens.input += usage.inputTokens ?? 0;
      tokens.output += usage.outputTokens ?? 0;
      tokens.total += usage.totalTokens ?? 0;
    }
    if (status === "ok") counts.ok++;
    else if (status === "halted") counts.halted++;
    else if (status === "timeout") counts.timedOut++;
    else counts.errored++;

    const toolMs = toolCalls.reduce((sum, t) => sum + (t.duration_ms ?? 0), 0);
    const manifest = manifestFor(opts, systemPrompt, status === "timeout" ? null : opts.engine.lastRunTrace, skills);
    await opts.emit({
      type: "case",
      id: c.id,
      line: c.line,
      status,
      arm,
      answer,
      error,
      latency_ms: latency,
      // First executed case is cold (process start, first provider/data loads).
      cold: executed === 0,
      timing: { total_ms: latency, tool_ms_sum: toolMs, phases },
      usage: usage
        ? { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0, total: usage.totalTokens ?? 0 }
        : null,
      tool_calls: toolCalls,
      config_sha256: manifest.config_sha256,
      run: manifest.run,
      ...(c.metadata !== undefined ? { metadata: c.metadata } : {}),
    });
    executed++;
  }

  const summary: BenchSummary = {
    type: "bench_summary",
    expected: dataset.lineCount,
    ok: counts.ok,
    halted: counts.halted,
    errored: counts.errored,
    timed_out: counts.timedOut,
    invalid: dataset.problems.filter((p) => p.kind === "invalid").length + counts.invalid,
    duplicate: dataset.problems.filter((p) => p.kind === "duplicate").length,
    not_run: dataset.cases.length - toRun.length,
    wall_ms: now() - started,
    tokens,
  };
  await opts.emit(summary as unknown as Record<string, unknown>);
  return summary;
}

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

export interface BenchArgs {
  datasetPath: string;
  out?: string;
  limit?: number;
  /** Explicit allowlist from --tools. */
  tools?: string[];
  /** --all-tools: no allowlist at all. */
  allTools: boolean;
  systemPrompt?: string;
  verbose: boolean;
  sampling: SamplingConfig;
  arm: BenchArm;
  caseTimeoutS: number;
}

export const BENCH_USAGE =
  "Usage: sportsclaw bench <dataset.jsonl> [--out <results.jsonl>] [--limit <n>] " +
  "[--arm routed|raw-tools|direct|routed-oracle] [--case-timeout <seconds>] " +
  "[--tools <a,b,...> | --all-tools] [--system-prompt <text>] [--temperature <n>] [--seed <n>] [--verbose]";

function takeValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      args.splice(i, 2);
      return value;
    }
    if (args[i].startsWith(`${flag}=`)) {
      const value = args[i].slice(flag.length + 1);
      args.splice(i, 1);
      if (value === "") throw new Error(`${flag} requires a value`);
      return value;
    }
  }
  return undefined;
}

function takeSwitch(args: string[], ...flags: string[]): boolean {
  let found = false;
  for (const flag of flags) {
    let i: number;
    while ((i = args.indexOf(flag)) >= 0) {
      args.splice(i, 1);
      found = true;
    }
  }
  return found;
}

/** Parse `bench` arguments. Throws with a user-facing message on bad input. */
export function parseBenchArgs(argv: readonly string[], takeSampling: (args: string[]) => SamplingConfig): BenchArgs {
  const args = [...argv];
  const sampling = takeSampling(args);
  const out = takeValue(args, "--out");
  const limitRaw = takeValue(args, "--limit");
  const toolsRaw = takeValue(args, "--tools");
  const systemPrompt = takeValue(args, "--system-prompt");
  const armRaw = takeValue(args, "--arm");
  const timeoutRaw = takeValue(args, "--case-timeout");
  const allTools = takeSwitch(args, "--all-tools");
  const verbose = takeSwitch(args, "--verbose", "-v");

  const arm = (armRaw ?? "routed").replace(/-/g, "_") as BenchArm;
  if (!BENCH_ARMS.includes(arm)) {
    throw new Error(`--arm must be one of routed, raw-tools, direct, routed-oracle (got ${JSON.stringify(armRaw)})`);
  }
  let caseTimeoutS = DEFAULT_CASE_TIMEOUT_S;
  if (timeoutRaw !== undefined) {
    caseTimeoutS = Number(timeoutRaw);
    if (!Number.isFinite(caseTimeoutS) || caseTimeoutS <= 0) {
      throw new Error(`--case-timeout must be a positive number of seconds (got ${JSON.stringify(timeoutRaw)})`);
    }
  }

  let limit: number | undefined;
  if (limitRaw !== undefined) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 0) throw new Error(`--limit must be a non-negative integer (got ${JSON.stringify(limitRaw)})`);
  }
  if (toolsRaw !== undefined && allTools) throw new Error("--tools and --all-tools cannot be combined");
  const tools = toolsRaw !== undefined ? parseToolList(toolsRaw) : undefined;
  if (tools && tools.length === 0) throw new Error("--tools needs at least one tool name");
  if (arm !== "routed" && (tools || allTools)) {
    throw new Error("--tools/--all-tools apply to the routed arm only; baseline arms use each case's \"skills\"");
  }

  const unknownFlag = args.find((a) => a.startsWith("-"));
  if (unknownFlag) throw new Error(`unknown option ${unknownFlag}`);
  if (args.length === 0) throw new Error("missing dataset path");
  if (args.length > 1) throw new Error(`expected one dataset path, got: ${args.join(" ")}`);

  return {
    datasetPath: args[0],
    ...(out !== undefined ? { out } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(tools ? { tools } : {}),
    allTools,
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    verbose,
    sampling,
    arm,
    caseTimeoutS,
  };
}
