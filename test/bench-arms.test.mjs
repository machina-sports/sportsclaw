// Bench arms (routed / raw_tools / direct), per-case timeout, cold flag and
// the trading-skill exclusion. Uses a fake engine; see run-direct.test.mjs for
// the real minimal loop.
import assert from "node:assert/strict";
import test from "node:test";

import {
  BENCH_EXCLUDED_SKILLS,
  DEFAULT_CASE_TIMEOUT_S,
  parseBenchArgs,
  parseDataset,
  runBench,
  withoutExcludedSkills,
} from "../dist/bench.js";
import { TOOL_OUTPUT_CHAR_CAP } from "../dist/engine.js";
import { buildRunManifest, takeSamplingArgs } from "../dist/run-manifest.js";

function fakeEngine(behavior = {}) {
  const calls = [];
  let usage = null;
  let trace = null;
  const settle = (kind, prompt, options) => {
    calls.push({ kind, prompt, skills: options.skills ?? null, hasSignal: options.abortSignal instanceof AbortSignal });
    usage = { inputTokens: 2, outputTokens: 1, totalTokens: 3 };
    const b = behavior[prompt] ?? "answer";
    if (b === "hang") return new Promise(() => {});
    if (b === "hang-until-abort") {
      return new Promise((_, reject) => options.abortSignal.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    trace = { servedModelId: "m", offeredTools: [], toolSurfaceSha256: "0".repeat(64), providerWarnings: [], parallelAgents: false };
    return Promise.resolve(`${kind}:${prompt}`);
  };
  return {
    calls,
    modelId: "fake",
    packageVersion: "0.29.4",
    manifestConfig: { provider: "openai", sampling: {}, maxOutputTokens: 100, maxTurns: 3, thinkingBudget: 0, toolAllowlist: ["nba_x"] },
    get lastRunTrace() { return trace; },
    get lastTokenUsage() { return usage; },
    reset() { usage = null; trace = null; },
    run(prompt, options) { return settle("routed", prompt, options); },
    runDirect(prompt, options) { return settle("direct", prompt, options); },
  };
}

async function collect(opts) {
  const lines = [];
  const summary = await runBench({ datasetPath: "d", sportsSkillsVersion: null, env: {}, ...opts, emit: (l) => { lines.push(JSON.parse(JSON.stringify(l))); } });
  return { lines, cases: lines.filter((l) => l.type === "case"), summary };
}

const ds = (rows) => parseDataset(rows.map((r) => JSON.stringify(r)).join("\n"));

test("a hung case times out, the next case still runs, and the summary adds up", async () => {
  const engine = fakeEngine({ slow: "hang-until-abort", stuck: "hang" });
  const { cases, summary } = await collect({
    engine,
    dataset: ds([{ id: "a", prompt: "slow" }, { id: "b", prompt: "stuck" }, { id: "c", prompt: "fine" }]),
    caseTimeoutS: 0.05,
    abortGraceMs: 20,
  });
  assert.deepEqual(cases.map((c) => [c.id, c.status]), [["a", "timeout"], ["b", "timeout"], ["c", "ok"]]);
  assert.match(cases[0].error, /0.05s timeout/);
  assert.equal(cases[0].usage, null);
  assert.equal(cases[0].run, null);
  assert.ok(engine.calls.every((c) => c.hasSignal), "every run gets an abort signal");
  assert.equal(summary.timed_out, 2);
  assert.equal(summary.ok, 1);
  assert.equal(
    summary.ok + summary.halted + summary.errored + summary.timed_out + summary.invalid + summary.duplicate + summary.not_run,
    summary.expected,
  );
});

test("arms dispatch to the right loop with the right tool scope", async () => {
  const dataset = ds([{ id: "a", prompt: "p", skills: ["nba", "betting", "nba"] }]);
  const routed = await collect({ engine: fakeEngine(), dataset });
  const raw = await collect({ engine: fakeEngine(), dataset, arm: "raw_tools" });
  const direct = await collect({ engine: fakeEngine(), dataset, arm: "direct" });

  assert.equal(routed.cases[0].answer, "routed:p");
  assert.equal(raw.cases[0].answer, "direct:p");
  assert.equal(direct.cases[0].answer, "direct:p");
  assert.deepEqual(raw.lines[0].config.bench, { arm: "raw_tools", case_timeout_s: DEFAULT_CASE_TIMEOUT_S, tool_output_char_cap: TOOL_OUTPUT_CHAR_CAP });

  const rawEngine = fakeEngine();
  await collect({ engine: rawEngine, dataset, arm: "raw_tools" });
  assert.deepEqual(rawEngine.calls[0].skills, ["betting", "nba"], "skills deduped and sorted");
  const directEngine = fakeEngine();
  await collect({ engine: directEngine, dataset, arm: "direct" });
  assert.deepEqual(directEngine.calls[0].skills, [], "direct offers no tools");

  const hashes = new Set([routed, raw, direct].map((r) => r.cases[0].config_sha256));
  assert.equal(hashes.size, 3, "each arm has its own config_sha256");
  assert.equal(raw.lines[0].config.tool_allowlist, null, "baseline arms don't claim the engine allowlist");
  assert.deepEqual(routed.lines[0].config.tool_allowlist, ["nba_x"]);
  assert.equal(raw.cases[0].arm, "raw_tools");
});

test("raw_tools refuses cases without skills or with excluded skills, and counts them invalid", async () => {
  const engine = fakeEngine();
  const { cases, summary } = await collect({
    engine,
    arm: "raw_tools",
    dataset: ds([
      { id: "no-skills", prompt: "p1" },
      { id: "trading", prompt: "p2", skills: ["polymarket", "polymarket-trading"] },
      { id: "ok", prompt: "p3", skills: ["polymarket"] },
    ]),
  });
  assert.deepEqual(cases.map((c) => [c.id, c.status]), [["no-skills", "invalid"], ["trading", "invalid"], ["ok", "ok"]]);
  assert.match(cases[0].error, /needs a "skills" array/);
  assert.match(cases[1].error, /polymarket-trading/);
  assert.deepEqual(engine.calls.map((c) => c.prompt), ["p3"], "refused cases never reach the model");
  assert.equal(summary.invalid, 2);
  assert.equal(summary.ok + summary.invalid, summary.expected);
});

test("only the first executed case is cold; timing is recorded", async () => {
  const { cases } = await collect({ engine: fakeEngine(), dataset: ds([{ id: "a", prompt: "x" }, { id: "b", prompt: "y" }]) });
  assert.deepEqual(cases.map((c) => c.cold), [true, false]);
  for (const c of cases) {
    assert.equal(c.timing.total_ms, c.latency_ms);
    assert.equal(c.timing.tool_ms_sum, 0);
    assert.ok(Array.isArray(c.timing.phases));
  }
});

test("baseline arms need an engine that implements runDirect", async () => {
  const engine = fakeEngine();
  delete engine.runDirect;
  await assert.rejects(collect({ engine, dataset: ds([{ id: "a", prompt: "x", skills: ["nba"] }]), arm: "direct" }), /needs an engine with runDirect/);
});

test("the trading skill is excluded from the benchmark tool surface", () => {
  assert.deepEqual(BENCH_EXCLUDED_SKILLS, ["polymarket-trading"]);
  assert.deepEqual(
    withoutExcludedSkills(["polymarket_get_order_book", "polymarket-trading_get_orders", "polymarket-trading_configure", "nba_get_scoreboard"]),
    ["polymarket_get_order_book", "nba_get_scoreboard"],
  );
});

test("parseBenchArgs reads --arm and --case-timeout and rejects bad values", () => {
  const a = parseBenchArgs(["d.jsonl", "--arm", "raw-tools", "--case-timeout=45"], takeSamplingArgs);
  assert.equal(a.arm, "raw_tools");
  assert.equal(a.caseTimeoutS, 45);
  assert.equal(parseBenchArgs(["d.jsonl", "--arm=direct"], takeSamplingArgs).arm, "direct");
  assert.equal(parseBenchArgs(["d.jsonl"], takeSamplingArgs).caseTimeoutS, DEFAULT_CASE_TIMEOUT_S);
  for (const [argv, pattern] of [
    [["d.jsonl", "--arm", "yolo"], /--arm must be one of/],
    [["d.jsonl", "--case-timeout", "0"], /positive number of seconds/],
    [["d.jsonl", "--case-timeout", "soon"], /positive number of seconds/],
    [["d.jsonl", "--arm", "direct", "--tools", "nba_x"], /routed arm only/],
    [["d.jsonl", "--arm", "raw-tools", "--all-tools"], /routed arm only/],
  ]) {
    assert.throws(() => parseBenchArgs(argv, takeSamplingArgs), pattern, JSON.stringify(argv));
  }
});

test("one-shot query manifests carry no bench block, so their config_sha256 is unchanged", () => {
  const base = { sportsclawVersion: "0.29.4", provider: "openai", model: "m", sampling: {}, maxOutputTokens: 1, maxTurns: 1, thinkingBudget: 0, env: {} };
  const query = buildRunManifest(base);
  assert.equal("bench" in query.config, false);
  const bench = buildRunManifest({ ...base, bench: { arm: "direct", case_timeout_s: 300, tool_output_char_cap: TOOL_OUTPUT_CHAR_CAP, skills: ["nfl", "nba"] } });
  assert.deepEqual(bench.config.bench.skills, ["nba", "nfl"]);
  assert.notEqual(bench.config_sha256, query.config_sha256);
});

test("routed_oracle runs the full engine over the case's skills tools only", async () => {
  const engine = fakeEngine();
  const allowlists = [];
  engine.dataToolNamesForSkills = (skills) => skills.flatMap((s) => [`${s}_a`, `${s}_b`]);
  engine.setToolAllowlist = (names) => { allowlists.push(names); engine.manifestConfig.toolAllowlist = names; };
  const { cases, lines } = await collect({
    engine,
    arm: "routed_oracle",
    dataset: ds([
      { id: "a", prompt: "p1", skills: ["nba"] },
      { id: "b", prompt: "p2", skills: ["nfl", "polymarket-trading"] },
      { id: "c", prompt: "p3" },
    ]),
  });
  assert.deepEqual(cases.map((c) => [c.id, c.status]), [["a", "ok"], ["b", "invalid"], ["c", "invalid"]]);
  assert.equal(cases[0].answer, "routed:p1", "the full engine answered, not the minimal loop");
  assert.deepEqual(allowlists, [["nba_a", "nba_b"]]);
  assert.deepEqual(cases[0].arm, "routed_oracle");
  assert.equal(lines[0].config.bench.arm, "routed_oracle");
  assert.match(cases[2].error, /routed_oracle arm needs a "skills" array/);
});

test("routed_oracle requires the allowlist hooks, and --arm routed-oracle parses", async () => {
  await assert.rejects(
    collect({ engine: fakeEngine(), arm: "routed_oracle", dataset: ds([{ id: "a", prompt: "x", skills: ["nba"] }]) }),
    /needs an engine with dataToolNamesForSkills/,
  );
  assert.equal(parseBenchArgs(["d.jsonl", "--arm", "routed-oracle"], takeSamplingArgs).arm, "routed_oracle");
});
