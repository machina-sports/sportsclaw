import assert from "node:assert/strict";
import test from "node:test";

import {
  RUN_MANIFEST_VERSION,
  buildRunManifest,
  formatProviderWarnings,
  hashToolSurface,
  sha256,
  stableStringify,
  takeSamplingArgs,
  validateSampling,
} from "../dist/run-manifest.js";

const baseInput = {
  sportsclawVersion: "0.29.4",
  sportsSkillsVersion: "0.33.0",
  provider: "anthropic",
  model: "claude-test",
  sampling: { temperature: 0, seed: 7 },
  maxOutputTokens: 4096,
  maxTurns: 25,
  thinkingBudget: 0,
  env: {},
};

test("validateSampling accepts valid pins and drops unset ones", () => {
  assert.deepEqual(validateSampling(undefined), {});
  assert.deepEqual(validateSampling({}), {});
  assert.deepEqual(validateSampling({ temperature: 0 }), { temperature: 0 });
  assert.deepEqual(validateSampling({ temperature: 2, seed: 0 }), { temperature: 2, seed: 0 });
  assert.deepEqual(validateSampling({ seed: 2147483647 }), { seed: 2147483647 });
});

test("validateSampling rejects out-of-range or non-integer values", () => {
  for (const bad of [{ temperature: -0.1 }, { temperature: 2.5 }, { temperature: Number.NaN }, { temperature: Infinity }]) {
    assert.throws(() => validateSampling(bad), /temperature must be a number between 0 and 2/);
  }
  for (const bad of [{ seed: -1 }, { seed: 1.5 }, { seed: 2147483648 }, { seed: Number.NaN }]) {
    assert.throws(() => validateSampling(bad), /seed must be an integer/);
  }
});

test("takeSamplingArgs parses both flag forms and removes them from argv", () => {
  const args = ["--temperature", "0", "who", "won", "--seed=42", "--json"];
  assert.deepEqual(takeSamplingArgs(args), { temperature: 0, seed: 42 });
  assert.deepEqual(args, ["who", "won", "--json"]);

  const untouched = ["nba", "scores", "--json"];
  assert.deepEqual(takeSamplingArgs(untouched), {});
  assert.deepEqual(untouched, ["nba", "scores", "--json"]);
});

test("takeSamplingArgs fails loudly on missing or invalid values", () => {
  assert.throws(() => takeSamplingArgs(["--temperature"]), /--temperature requires a value/);
  assert.throws(() => takeSamplingArgs(["--seed", "--json"]), /--seed requires a value/);
  assert.throws(() => takeSamplingArgs(["--seed="]), /--seed requires a value/);
  assert.throws(() => takeSamplingArgs(["--temperature=hot"]), /--temperature must be a number/);
  assert.throws(() => takeSamplingArgs(["--temperature", "3"]), /between 0 and 2/);
  assert.throws(() => takeSamplingArgs(["--seed", "1.5"]), /seed must be an integer/);
});

test("stableStringify ignores key order and drops functions", () => {
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
  assert.equal(stableStringify({ a: 1, fn: () => 1, u: undefined }), '{"a":1}');
});

test("hashToolSurface is order-insensitive and sensitive to descriptions and schemas", () => {
  const tools = {
    nba_scores: { description: "NBA scores", inputSchema: { jsonSchema: { type: "object" } }, execute() {} },
    nfl_scores: { description: "NFL scores", inputSchema: { jsonSchema: { type: "object" } }, execute() {} },
  };
  const a = hashToolSurface(tools, ["nba_scores", "nfl_scores"]);
  assert.equal(a, hashToolSurface(tools, ["nfl_scores", "nba_scores", "nba_scores"]));

  const renamed = { ...tools, nba_scores: { ...tools.nba_scores, description: "NBA live scores" } };
  assert.notEqual(a, hashToolSurface(renamed, ["nba_scores", "nfl_scores"]));

  const reshaped = { ...tools, nba_scores: { ...tools.nba_scores, inputSchema: { jsonSchema: { type: "string" } } } };
  assert.notEqual(a, hashToolSurface(reshaped, ["nba_scores", "nfl_scores"]));

  assert.notEqual(a, hashToolSurface(tools, ["nba_scores"]));
});

test("formatProviderWarnings flattens, dedupes and sorts", () => {
  const steps = [
    { warnings: [{ type: "unsupported", feature: "seed" }] },
    {
      warnings: [
        { type: "unsupported", feature: "seed" },
        { type: "unsupported", feature: "temperature", details: "temperature is not supported when thinking is enabled" },
      ],
    },
    {},
  ];
  assert.deepEqual(formatProviderWarnings(steps), [
    "unsupported seed",
    "unsupported temperature: temperature is not supported when thinking is enabled",
  ]);
  assert.deepEqual(formatProviderWarnings(undefined), []);
});

test("config_sha256 is stable for equal configs and changes with any pinned field", () => {
  const a = buildRunManifest(baseInput);
  const b = buildRunManifest({ ...baseInput });
  assert.equal(a.manifest_version, RUN_MANIFEST_VERSION);
  assert.equal(a.config_sha256, b.config_sha256);
  assert.equal(a.config_sha256, sha256(stableStringify(a.config)));

  for (const change of [
    { sampling: { temperature: 0, seed: 8 } },
    { sampling: { temperature: 0.2, seed: 7 } },
    { model: "claude-other" },
    { sportsSkillsVersion: "0.34.0" },
    { callerSystemPrompt: "be terse" },
    { env: { SPORTS_SKILLS_REPLAY: "replay" } },
    { toolAllowlist: ["nba_get_scores"] },
  ]) {
    assert.notEqual(buildRunManifest({ ...baseInput, ...change }).config_sha256, a.config_sha256, JSON.stringify(change));
  }
});

test("run trace is reported but excluded from config_sha256", () => {
  const trace = {
    servedModelId: "claude-test-2026",
    mainSystemPromptSha256: sha256("system prompt with today's date"),
    offeredTools: ["nba_scores"],
    toolSurfaceSha256: "abc",
    providerWarnings: ["unsupported seed"],
    parallelAgents: false,
  };
  const withTrace = buildRunManifest({ ...baseInput, trace });
  const withoutTrace = buildRunManifest(baseInput);
  assert.equal(withTrace.config_sha256, withoutTrace.config_sha256);
  assert.equal(withoutTrace.run, null);
  assert.deepEqual(withTrace.run, {
    served_model_id: "claude-test-2026",
    main_system_prompt_sha256: trace.mainSystemPromptSha256,
    offered_tools: ["nba_scores"],
    tool_surface_sha256: "abc",
    provider_warnings: ["unsupported seed"],
    parallel_agents: false,
    routed_skills: null,
  });
});

test("routed_skills is reported in run and excluded from config_sha256", () => {
  const trace = {
    offeredTools: ["nba_scores"], toolSurfaceSha256: "abc", providerWarnings: [], parallelAgents: false,
    routedSkills: ["nba", "betting"],
  };
  const routed = buildRunManifest({ ...baseInput, trace });
  const unrouted = buildRunManifest({ ...baseInput, trace: { ...trace, routedSkills: undefined } });
  assert.deepEqual(routed.run.routed_skills, ["nba", "betting"]);
  assert.equal(unrouted.run.routed_skills, null);
  assert.equal(routed.config_sha256, unrouted.config_sha256);
  assert.equal(routed.config_sha256, buildRunManifest(baseInput).config_sha256);
  assert.equal("routed_skills" in routed.config, false);
});

test("sports_skills_source is config: absent leaves the hash unchanged, present changes it", () => {
  // config_sha256 of baseInput before sports_skills_source existed.
  const before = "bf5e96178218b7a785d08e3e6fea857beee6f3983dbc4c509fce585241418c5f";
  const absent = buildRunManifest(baseInput);
  assert.equal(absent.config_sha256, before);
  assert.equal("sports_skills_source" in absent.config, false);
  assert.equal(buildRunManifest({ ...baseInput, sportsSkillsSource: null }).config_sha256, before);

  const git = { url: "git+https://github.com/machina-sports/sports-skills@53e949e5d23070c6af5c51396af4df1a0d724983" };
  const withGit = buildRunManifest({ ...baseInput, sportsSkillsSource: git });
  assert.deepEqual(withGit.config.sports_skills_source, git);
  assert.notEqual(withGit.config_sha256, before);
  const otherCommit = buildRunManifest({ ...baseInput, sportsSkillsSource: { url: git.url.replace(/@.*$/, "@deadbeef") } });
  assert.notEqual(otherCommit.config_sha256, withGit.config_sha256);
});

test("manifest carries hashes, never prompt text", () => {
  const secretPrompt = "internal caller instructions — do not leak";
  const manifest = buildRunManifest({ ...baseInput, callerSystemPrompt: secretPrompt });
  assert.equal(manifest.config.caller_system_prompt_sha256, sha256(secretPrompt));
  assert.ok(!JSON.stringify(manifest).includes("do not leak"));
});

test("unset sampling pins are omitted rather than recorded as null", () => {
  const manifest = buildRunManifest({ ...baseInput, sampling: {} });
  assert.deepEqual(manifest.config.sampling, {});
  assert.equal(manifest.config.replay_mode, "off");
  assert.equal(manifest.config.tool_allowlist, null);
});

test("tool_allowlist is normalized (sorted, deduped) so order does not change the hash", () => {
  const a = buildRunManifest({ ...baseInput, toolAllowlist: ["b", "a", "a"] });
  const b = buildRunManifest({ ...baseInput, toolAllowlist: ["a", "b"] });
  assert.deepEqual(a.config.tool_allowlist, ["a", "b"]);
  assert.equal(a.config_sha256, b.config_sha256);
});
