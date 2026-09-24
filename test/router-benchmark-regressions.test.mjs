// Routing regressions found by the Sports Agent Bench pilot (#173):
// plain stat questions were classified as betting because of words like
// "line", "total" and "over", pulling ~50 market tools in, and a question
// naming a team (without its league) routed to the wrong sport.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MockLanguageModelV3 } from "ai/test";

import { classifyQueryComplexity, planSkillCaps } from "../dist/routing/complexity.js";
import { TEAM_ALIASES } from "../dist/routing/team-aliases.js";
import { routePromptToSkills } from "../dist/router.js";
import { DEFAULT_TOKEN_BUDGETS } from "../dist/types.js";

const MARKET_SKILLS = ["betting", "markets", "kalshi", "polymarket"];
const BENCH_SUFFIX =
  "\n\nEnd your reply with exactly one line of the form 'FINAL: <answer>'. " +
  "If the data does not let you answer, or the question's premise is false, write 'FINAL: UNKNOWN'.";

function notJsonModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: "NOT_JSON" }],
      finishReason: { unified: "stop", raw: undefined },
      usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 }, totalTokens: { total: 2 }, reasoningTokens: { total: undefined } },
      warnings: [],
    }),
  });
}

async function route(prompt, installedSkills) {
  return routePromptToSkills({
    prompt,
    installedSkills,
    toolSpecs: [],
    model: notJsonModel(),
    modelId: "mock",
    provider: "anthropic",
    config: { routingMode: "soft_lock", routingMaxSkills: 2, routingAllowSpillover: 1, thinkingBudget: 0, tokenBudgets: DEFAULT_TOKEN_BUDGETS },
  });
}

describe("betting classification uses unambiguous vocabulary only", () => {
  it("plain stat questions are not betting", () => {
    for (const q of [
      "How many total rushing yards did the Carolina Panthers have against the Miami Dolphins?",
      "How many NBA games on 2026-01-01 were decided by over 10 points?",
      "Who is the best edge rusher in the NFL this season?",
      "Which pitchers allowed under 2 runs last night?",
      "How many three-pointers did the Miami Heat make on 2026-01-01?" + BENCH_SUFFIX,
    ]) {
      assert.notEqual(classifyQueryComplexity(q), "betting", q);
      const plan = planSkillCaps(q, { routingMaxSkills: 2, routingAllowSpillover: 1 });
      assert.ok(!plan.addSkills.some((s) => MARKET_SKILLS.includes(s)), q);
    }
  });

  it("real betting questions still are", () => {
    for (const q of [
      "what are the odds the Lakers win tonight",
      "best parlay for Sunday",
      "what's the over/under for Chiefs vs Bills",
      "Chiefs moneyline",
      "where is the Kalshi market for the Super Bowl",
      "best lakers bets tonight",
    ]) {
      assert.equal(classifyQueryComplexity(q), "betting", q);
    }
  });

  it("'out' alone no longer means injury news, but real injury wording does", () => {
    assert.notEqual(classifyQueryComplexity("help me figure out who won the game"), "compound");
    assert.equal(classifyQueryComplexity("is LeBron ruled out tonight"), "compound");
    assert.equal(classifyQueryComplexity("who is out injured"), "compound");
  });
});

describe("team names route to their league", () => {
  it("the alias table covers five leagues with full, multi-word names and no collisions", () => {
    const all = Object.values(TEAM_ALIASES).flat();
    assert.deepEqual(Object.keys(TEAM_ALIASES).sort(), ["mlb", "nba", "nfl", "nhl", "wnba"]);
    assert.equal(new Set(all).size, all.length, "a name maps to exactly one league");
    assert.ok(all.every((n) => n === n.toLowerCase() && n.includes(" ")), "lowercase full names only");
    assert.ok(TEAM_ALIASES.nba.includes("miami heat"));
  });

  it("the pilot's misrouted Heat question selects nba, not cbb or market skills", async () => {
    const result = await route(
      "How many three-pointers did the Miami Heat make in their game on 2026-01-01?" + BENCH_SUFFIX,
      ["nba", "cbb", "wnba", "nfl", ...MARKET_SKILLS],
    );
    assert.ok(result.decision.selectedSkills.includes("nba"), result.decision.selectedSkills.join(","));
    assert.ok(!result.decision.selectedSkills.includes("cbb"));
    assert.ok(!result.decision.selectedSkills.some((s) => MARKET_SKILLS.includes(s)));
  });

  it("teams from different leagues route to their own skills", async () => {
    const result = await route("Did the Kansas City Chiefs or the Boston Bruins win last night?", ["nba", "nfl", "nhl", "mlb"]);
    assert.ok(result.decision.selectedSkills.includes("nfl"));
    assert.ok(result.decision.selectedSkills.includes("nhl"));
  });
});

// Sports Agent Bench v1: when the router's JSON did not come back (Gemini's
// thinking tokens count against a 220-token cap), the tool-name fallback
// sent tennis and volleyball questions to cbb.
describe("a failed LLM route is retried and named events route to their sport", () => {
  const OK_USAGE = { inputTokens: { total: 10 }, outputTokens: { total: 5 }, totalTokens: { total: 15 }, reasoningTokens: { total: undefined } };
  function flakyModel(answers) {
    let call = 0;
    return {
      model: new MockLanguageModelV3({
        doGenerate: async () => ({
          content: [{ type: "text", text: answers[Math.min(call++, answers.length - 1)] }],
          finishReason: { unified: "stop", raw: undefined },
          usage: OK_USAGE,
          warnings: [],
        }),
      }),
      calls: () => call,
    };
  }
  const INSTALLED = ["cbb", "cfb", "tennis", "golf", "volleyball", "nhl", "cricket", "metadata", "xctf", "nba"];
  const routeWith = (prompt, model) => routePromptToSkills({
    prompt, installedSkills: INSTALLED, toolSpecs: [], model, modelId: "mock", provider: "anthropic",
    config: { routingMode: "soft_lock", routingMaxSkills: 2, routingAllowSpillover: 1, thinkingBudget: 0, tokenBudgets: DEFAULT_TOKEN_BUDGETS },
  });

  it("the router budget leaves room for thinking tokens", () => {
    assert.ok(DEFAULT_TOKEN_BUDGETS.router >= 1024);
  });

  it("retries once and uses the second answer", async () => {
    const m = flakyModel(['{"selected_skills":["tennis"', '{"selected_skills":["cfb"],"mode":"focused","confidence":0.9,"reason":"r"}']);
    const result = await routeWith("How many touchdown passes did James Madison throw at Texas State on 2025-10-28?", m.model);
    assert.equal(m.calls(), 2);
    assert.deepEqual(result.decision.selectedSkills, ["cfb"]);
    assert.equal(result.meta.llmSucceeded, true);
    assert.equal(result.meta.llmUsage.totalTokens, 30, "both attempts are counted");
  });

  it("does not retry a decision that parsed", async () => {
    const m = flakyModel(['{"selected_skills":["cfb"],"mode":"focused","confidence":0.9,"reason":"r"}']);
    await routeWith("How many touchdown passes did James Madison throw at Texas State on 2025-10-28?", m.model);
    assert.equal(m.calls(), 1);
  });

  it("names of events and providers select their skill even when the router fails", async () => {
    for (const [q, skill] of [
      ["In the 2025 US Open men's singles final, how many games did the runner-up win?", "tennis"],
      ["How many sets did the 2025 Wimbledon champion lose?", "tennis"],
      ["According to Nevobo's club registry, when was DES founded?", "volleyball"],
      ["In the men's Olympic ice hockey game between Canada and France, how many goals did Canada score?", "nhl"],
      ["What is the listed capacity of the IPL 2026 final venue?", "cricket"],
      ["Per TFRRS, what was Jane Hedengren's 800 m time?", "xctf"],
      ["Which stadium does TheSportsDB list as the home ground of the IPL 2026 champion?", "metadata"],
    ]) {
      const result = await route(q, INSTALLED);
      assert.ok(result.decision.selectedSkills.includes(skill), `${q} -> ${result.decision.selectedSkills}`);
      assert.ok(!result.decision.selectedSkills.includes("cbb"), q);
    }
  });

  it("'US Open' alone does not pick a sport, since tennis and golf both have one", async () => {
    const result = await route("Who won the 2025 US Open?", INSTALLED);
    assert.ok(!result.decision.reason.startsWith("Explicit intent detected for: tennis"));
  });
});
