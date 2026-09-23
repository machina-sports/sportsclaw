import assert from "node:assert/strict";
import test from "node:test";

import { AskUserQuestionHalt } from "../dist/ask.js";
import {
  BENCH_OUTPUT_VERSION,
  parseBenchArgs,
  parseDataset,
  parseToolList,
  runBench,
  unknownTools,
} from "../dist/bench.js";
import { takeSamplingArgs } from "../dist/run-manifest.js";

// ---------------------------------------------------------------------------
// Dataset parsing
// ---------------------------------------------------------------------------

test("parseDataset accounts for every non-blank line", () => {
  const text = [
    JSON.stringify({ id: "a", prompt: "NBA scores?" }),
    "",
    "not json",
    JSON.stringify({ id: "b" }),
    JSON.stringify({ prompt: "no id" }),
    JSON.stringify(["array"]),
    JSON.stringify({ id: "a", prompt: "dup" }),
    JSON.stringify({ id: "c", prompt: "ok", system_prompt: 3 }),
    JSON.stringify({ id: "d", prompt: "ok", metadata: [] }),
    JSON.stringify({ id: "e", prompt: "EPL table", system_prompt: "terse", metadata: { sport: "soccer" } }),
    "   ",
  ].join("\n");
  const ds = parseDataset(text);

  assert.equal(ds.lineCount, 9);
  assert.deepEqual(ds.cases.map((c) => [c.id, c.line]), [["a", 1], ["e", 10]]);
  assert.equal(ds.cases[1].systemPrompt, "terse");
  assert.deepEqual(ds.cases[1].metadata, { sport: "soccer" });
  assert.deepEqual(
    ds.problems.map((p) => [p.line, p.kind, p.id]),
    [[3, "invalid", null], [4, "invalid", "b"], [5, "invalid", null], [6, "invalid", null],
     [7, "duplicate", "a"], [8, "invalid", "c"], [9, "invalid", "d"]],
  );
  assert.equal(ds.cases.length + ds.problems.length, ds.lineCount);
  assert.match(ds.sha256, /^[0-9a-f]{64}$/);
  assert.equal(parseDataset(text).sha256, ds.sha256);
});

test("tool lists are normalized and unknown names are reported", () => {
  assert.deepEqual(parseToolList(" nba_scores, ,nfl_scores,nba_scores "), ["nba_scores", "nfl_scores"]);
  assert.deepEqual(unknownTools(["nba_scores", "made_up"], ["nba_scores", "nfl_scores"]), ["made_up"]);
});

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

test("parseBenchArgs reads every option", () => {
  const args = parseBenchArgs(
    ["data.jsonl", "--out", "r.jsonl", "--limit=5", "--tools", "b,a", "--system-prompt", "be terse",
     "--temperature", "0", "--seed=3", "-v"],
    takeSamplingArgs,
  );
  assert.deepEqual(args, {
    datasetPath: "data.jsonl", out: "r.jsonl", limit: 5, tools: ["a", "b"], allTools: false,
    systemPrompt: "be terse", verbose: true, sampling: { temperature: 0, seed: 3 },
    arm: "routed", caseTimeoutS: 300,
  });
  assert.deepEqual(parseBenchArgs(["d.jsonl", "--all-tools"], takeSamplingArgs).allTools, true);
});

test("parseBenchArgs rejects bad input with clear messages", () => {
  const cases = [
    [[], /missing dataset path/],
    [["a.jsonl", "b.jsonl"], /expected one dataset path/],
    [["d.jsonl", "--limit", "-1"], /--limit must be a non-negative integer/],
    [["d.jsonl", "--limit", "2.5"], /--limit must be a non-negative integer/],
    [["d.jsonl", "--tools", "a", "--all-tools"], /cannot be combined/],
    [["d.jsonl", "--tools", " , "], /at least one tool/],
    [["d.jsonl", "--out"], /--out requires a value/],
    [["d.jsonl", "--nope"], /unknown option --nope/],
    [["d.jsonl", "--temperature", "7"], /between 0 and 2/],
  ];
  for (const [argv, pattern] of cases) {
    assert.throws(() => parseBenchArgs(argv, takeSamplingArgs), pattern, JSON.stringify(argv));
  }
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function fakeEngine(script) {
  const calls = [];
  let resets = 0;
  let trace = null;
  let usage = null;
  return {
    calls,
    get resets() { return resets; },
    modelId: "fake-model",
    packageVersion: "0.29.4",
    manifestConfig: {
      provider: "openai", sampling: { temperature: 0, seed: 1 }, maxOutputTokens: 1024,
      maxTurns: 5, thinkingBudget: 0, toolAllowlist: ["nba_get_scores"],
    },
    get lastRunTrace() { return trace; },
    get lastTokenUsage() { return usage; },
    reset() { resets++; trace = null; usage = null; },
    async run(prompt, options) {
      calls.push({ prompt, systemPrompt: options?.systemPrompt ?? null });
      const step = script[prompt];
      usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
      if (step.tools) {
        for (const [i, t] of step.tools.entries()) {
          options.onProgress({ type: "tool_start", toolName: t.name, toolCallId: `c${i}` });
          options.onProgress({ type: "tool_finish", toolName: t.name, toolCallId: `c${i}`, durationMs: t.ms, success: t.ok });
        }
      }
      if (step.throws) throw step.throws;
      trace = {
        servedModelId: "fake-served", mainSystemPromptSha256: "f".repeat(64), offeredTools: ["nba_get_scores"],
        toolSurfaceSha256: "e".repeat(64), providerWarnings: [], parallelAgents: false,
      };
      return step.answer;
    },
  };
}

async function collect(opts) {
  const lines = [];
  let t = 1_000;
  const summary = await runBench({ ...opts, emit: (l) => { lines.push(JSON.parse(JSON.stringify(l))); }, now: () => (t += 10), env: {} });
  return { lines, summary };
}

test("runBench emits a header, one line per dataset line, and a closing summary", async () => {
  const dataset = parseDataset([
    JSON.stringify({ id: "ok-1", prompt: "p-ok", metadata: { sport: "nba" } }),
    JSON.stringify({ id: "ask-1", prompt: "p-ask" }),
    JSON.stringify({ id: "err-1", prompt: "p-err" }),
    "garbage",
    JSON.stringify({ id: "ok-1", prompt: "p-ok" }),
  ].join("\n"));
  const engine = fakeEngine({
    "p-ok": { answer: "Knicks 110-104", tools: [{ name: "nba_get_scores", ms: 42, ok: true }] },
    "p-ask": { throws: new AskUserQuestionHalt({ prompt: "Which team?", options: [], contextKey: "k" }) },
    "p-err": { throws: new Error("provider exploded"), tools: [{ name: "nba_get_scores", ms: 7, ok: false }] },
  });
  const { lines, summary } = await collect({ engine, dataset, datasetPath: "d.jsonl", sportsSkillsVersion: "0.33.0" });

  const [start, ...rest] = lines;
  const end = rest.pop();
  assert.equal(start.type, "bench_start");
  assert.equal(start.bench_output_version, BENCH_OUTPUT_VERSION);
  assert.deepEqual(start.dataset, { path: "d.jsonl", sha256: dataset.sha256, lines: 5, valid_cases: 3, problems: 2 });
  assert.deepEqual(start.config.tool_allowlist, ["nba_get_scores"]);
  assert.equal(start.config.sports_skills_version, "0.33.0");

  const byId = Object.fromEntries(rest.filter((l) => l.id && l.status !== "duplicate").map((l) => [l.id, l]));
  assert.equal(rest.length, 5, "every dataset line has exactly one case line");
  assert.deepEqual(rest.map((l) => l.status).sort(), ["duplicate", "error", "halted", "invalid", "ok"]);

  const ok = byId["ok-1"];
  assert.equal(ok.answer, "Knicks 110-104");
  assert.deepEqual(ok.tool_calls, [{ name: "nba_get_scores", success: true, duration_ms: 42 }]);
  assert.deepEqual(ok.usage, { input: 10, output: 5, total: 15 });
  assert.deepEqual(ok.metadata, { sport: "nba" });
  assert.equal(ok.config_sha256, start.config_sha256);
  assert.equal(ok.run.served_model_id, "fake-served");
  assert.equal(typeof ok.latency_ms, "number");

  assert.match(byId["ask-1"].error, /Which team\?/);
  assert.equal(byId["ask-1"].answer, null);
  assert.equal(byId["err-1"].error, "provider exploded");
  assert.deepEqual(byId["err-1"].tool_calls, [{ name: "nba_get_scores", success: false, duration_ms: 7 }]);
  assert.equal(byId["err-1"].run, null, "a failed run leaves no trace");

  assert.equal(end.type, "bench_summary");
  assert.deepEqual(
    { ...summary, wall_ms: 0 },
    { type: "bench_summary", expected: 5, ok: 1, halted: 1, errored: 1, timed_out: 0, invalid: 1, duplicate: 1, not_run: 0,
      wall_ms: 0, tokens: { input: 30, output: 15, total: 45 } },
  );
  assert.equal(summary.ok + summary.halted + summary.errored + summary.invalid + summary.duplicate + summary.not_run, summary.expected);

  assert.equal(engine.resets, 3, "conversation reset before every case");
});

test("--limit runs the first cases and counts the rest as not_run", async () => {
  const dataset = parseDataset(["a", "b", "c"].map((id) => JSON.stringify({ id, prompt: `p-${id}` })).join("\n"));
  const engine = fakeEngine({ "p-a": { answer: "A" }, "p-b": { answer: "B" }, "p-c": { answer: "C" } });
  const { lines, summary } = await collect({ engine, dataset, datasetPath: "d", sportsSkillsVersion: null, limit: 2 });
  assert.deepEqual(engine.calls.map((c) => c.prompt), ["p-a", "p-b"]);
  assert.equal(summary.not_run, 1);
  assert.equal(lines[0].limit, 2);
});

test("per-case system prompts override the global one and change config_sha256", async () => {
  const dataset = parseDataset([
    JSON.stringify({ id: "g", prompt: "p1" }),
    JSON.stringify({ id: "own", prompt: "p2", system_prompt: "case-specific" }),
  ].join("\n"));
  const engine = fakeEngine({ p1: { answer: "1" }, p2: { answer: "2" } });
  const { lines } = await collect({ engine, dataset, datasetPath: "d", sportsSkillsVersion: null, systemPrompt: "global" });
  assert.deepEqual(engine.calls.map((c) => c.systemPrompt), ["global", "case-specific"]);
  const [start, g, own] = lines;
  assert.equal(g.config_sha256, start.config_sha256);
  assert.notEqual(own.config_sha256, start.config_sha256);
  assert.ok(!JSON.stringify(lines).includes("case-specific"), "prompt text never appears in the output");
});
