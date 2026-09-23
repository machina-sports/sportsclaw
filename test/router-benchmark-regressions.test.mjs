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
