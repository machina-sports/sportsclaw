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
 *    "metadata": {"any": "passthrough"}}
 *
 * Every non-blank line is accounted for in the output: `ok`, `halted` (the
 * model asked the user a question), `error`, `invalid` (unparseable or missing
 * fields) or `duplicate` (repeated id; only the first occurrence runs). Cases
 * past `--limit` are counted as `not_run`. Nothing is silently dropped.
 */

import { createHash } from "node:crypto";
import { isHalt, type TokenUsage } from "./engine.js";
import { buildRunManifest, type RunManifest, type RunTrace } from "./run-manifest.js";
import type { LLMProvider, SamplingConfig, ToolProgressEvent } from "./types.js";

export const BENCH_OUTPUT_VERSION = 1;

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

export interface BenchCase {
  id: string;
  prompt: string;
  systemPrompt?: string;
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
    if (seen.has(id)) {
      problems.push({ line, kind: "duplicate", id, message: `duplicate id; first occurrence runs, this one does not` });
      return;
    }
    seen.add(id);
    cases.push({
      id,
      prompt: obj.prompt,
      ...(obj.system_prompt !== undefined ? { systemPrompt: obj.system_prompt as string } : {}),
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
  }): Promise<string>;
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

export type CaseStatus = "ok" | "halted" | "error" | "invalid" | "duplicate";

export interface ToolCallRecord {
  name: string;
  success: boolean | null;
  duration_ms: number | null;
}

export interface BenchRunOptions {
  engine: BenchEngine;
  dataset: ParsedDataset;
  datasetPath: string;
  sportsSkillsVersion: string | null;
  /** Caller system prompt applied to cases that do not set their own. */
  systemPrompt?: string;
  /** Run at most this many valid cases; the rest are counted `not_run`. */
  limit?: number;
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
  invalid: number;
  duplicate: number;
  not_run: number;
  wall_ms: number;
  tokens: { input: number; output: number; total: number };
}

function manifestFor(opts: BenchRunOptions, systemPrompt: string | undefined, trace: RunTrace | null): RunManifest {
  const cfg = opts.engine.manifestConfig;
  return buildRunManifest({
    sportsclawVersion: opts.engine.packageVersion,
    sportsSkillsVersion: opts.sportsSkillsVersion,
    provider: cfg.provider,
    model: opts.engine.modelId,
    sampling: cfg.sampling,
    maxOutputTokens: cfg.maxOutputTokens,
    maxTurns: cfg.maxTurns,
    thinkingBudget: cfg.thinkingBudget,
    toolAllowlist: cfg.toolAllowlist,
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
    manifest_version: base.manifest_version,
    config_sha256: base.config_sha256,
    config: base.config,
  });

  const counts = { ok: 0, halted: 0, errored: 0 };
  const tokens = { input: 0, output: 0, total: 0 };

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
        const record: ToolCallRecord = { name: event.toolName, success: null, duration_ms: null };
        toolCalls.push(record);
        pending.set(event.toolCallId, record);
      } else if (event.type === "tool_finish") {
        const record = pending.get(event.toolCallId);
        if (record) {
          record.success = event.success ?? null;
          record.duration_ms = event.durationMs ?? null;
          pending.delete(event.toolCallId);
        } else {
          toolCalls.push({ name: event.toolName, success: event.success ?? null, duration_ms: event.durationMs ?? null });
        }
      }
    };

    // Each case starts from an empty conversation; no userId, so no memory.
    opts.engine.reset();
    const caseStart = now();
    let status: CaseStatus = "ok";
    let answer: string | null = null;
    let error: string | null = null;
    try {
      answer = await opts.engine.run(c.prompt, {
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        onProgress,
      });
    } catch (err) {
      if (isHalt(err)) {
        status = "halted";
        error = `run halted: ${err instanceof Error ? err.message : String(err)}`;
      } else {
        status = "error";
        error = err instanceof Error ? err.message : String(err);
      }
    }
    const latency = now() - caseStart;
    const usage = opts.engine.lastTokenUsage;
    if (usage) {
      tokens.input += usage.inputTokens ?? 0;
      tokens.output += usage.outputTokens ?? 0;
      tokens.total += usage.totalTokens ?? 0;
    }
    if (status === "ok") counts.ok++;
    else if (status === "halted") counts.halted++;
    else counts.errored++;

    const manifest = manifestFor(opts, systemPrompt, opts.engine.lastRunTrace);
    await opts.emit({
      type: "case",
      id: c.id,
      line: c.line,
      status,
      answer,
      error,
      latency_ms: latency,
      usage: usage
        ? { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0, total: usage.totalTokens ?? 0 }
        : null,
      tool_calls: toolCalls,
      config_sha256: manifest.config_sha256,
      run: manifest.run,
      ...(c.metadata !== undefined ? { metadata: c.metadata } : {}),
    });
  }

  const summary: BenchSummary = {
    type: "bench_summary",
    expected: dataset.lineCount,
    ok: counts.ok,
    halted: counts.halted,
    errored: counts.errored,
    invalid: dataset.problems.filter((p) => p.kind === "invalid").length,
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
}

export const BENCH_USAGE =
  "Usage: sportsclaw bench <dataset.jsonl> [--out <results.jsonl>] [--limit <n>] " +
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
  const allTools = takeSwitch(args, "--all-tools");
  const verbose = takeSwitch(args, "--verbose", "-v");

  let limit: number | undefined;
  if (limitRaw !== undefined) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 0) throw new Error(`--limit must be a non-negative integer (got ${JSON.stringify(limitRaw)})`);
  }
  if (toolsRaw !== undefined && allTools) throw new Error("--tools and --all-tools cannot be combined");
  const tools = toolsRaw !== undefined ? parseToolList(toolsRaw) : undefined;
  if (tools && tools.length === 0) throw new Error("--tools needs at least one tool name");

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
  };
}
