import assert from "node:assert/strict";
import { describe, it } from "node:test";

// The planner is the unit under test at the routing boundary; this guards the
// contract router.ts relies on so a future refactor can't silently narrow it.
import { planSkillCaps } from "../dist/routing/complexity.js";
import { routePromptToSkills } from "../dist/router.js";
import { DEFAULT_TOKEN_BUDGETS } from "../dist/types.js";

// MockLanguageModelV3 (shipped by the "ai" SDK for exactly this purpose) lets
// us drive routePromptToSkills end-to-end with no network call: doGenerate
// returns non-JSON text, so the LLM attempt fails to parse and the function
// falls through to its deterministic/memory-fallback code paths.
import { MockLanguageModelV3 } from "ai/test";

function makeMockModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: "NOT_JSON" }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 10 },
        outputTokens: { total: 5 },
        totalTokens: { total: 15 },
        reasoningTokens: { total: undefined },
      },
      warnings: [],
    }),
  });
}

const baseConfig = {
  routingMode: "soft_lock",
  routingMaxSkills: 2,
  routingAllowSpillover: 1,
  thinkingBudget: 0,
  tokenBudgets: DEFAULT_TOKEN_BUDGETS,
};

describe("router complexity integration contract", () => {
  it("a betting prompt raises the effective max above the base of 2", () => {
    const plan = planSkillCaps("best bets for lakers tonight", { routingMaxSkills: 2, routingAllowSpillover: 1 });
    const effective = Math.max(2, plan.maxSkills);
    assert.ok(effective >= 3);
  });

  it("routePromptToSkills seeds market skills into the deterministic candidate hint for a betting prompt", async () => {
    const mockModel = makeMockModel();
    // Only "nba" is a real sport skill here, so without the capPlan.addSkills
    // union (router.ts:406-408) the deterministic candidate list would be
    // just ["nba"] — it can only contain "betting"/"markets" if the seeded
    // market skills from planSkillCaps are actually merged in.
    await routePromptToSkills({
      prompt: "who has the best bet tonight",
      installedSkills: ["nba", "betting", "markets", "kalshi", "polymarket"],
      toolSpecs: [],
      memoryBlock: "### Fan Profile (FAN_PROFILE.md)\nBig fan of nba.",
      model: mockModel,
      modelId: "mock-model",
      provider: "anthropic",
      config: baseConfig,
    });

    const call = mockModel.doGenerateCalls[0];
    const userMessage = call.prompt.find((m) => m.role === "user");
    const promptText = userMessage.content.map((part) => part.text).join("\n");
    const candidateLine = promptText.split("\n").find((line) => line.startsWith("Deterministic candidates"));

    assert.ok(candidateLine, "expected a 'Deterministic candidates' line in the router prompt");
    assert.match(candidateLine, /\b(betting|markets)\b/);
  });

  it("routePromptToSkills applies the raised effective cap to the skills it actually selects", async () => {
    const mockModel = makeMockModel();
    // Four installed sport skills, none named in the prompt, so selection
    // falls through to the fan-profile memory ranking (router.ts:470) and
    // then the ambiguous-mode limit (router.ts:494) — both gated on
    // effectiveMaxSkills. A multi-sport prompt raises planSkillCaps'
    // maxSkills to 4, well above the base routingMaxSkills of 2.
    const result = await routePromptToSkills({
      prompt: "what's happening across sports tonight",
      installedSkills: ["nba", "nfl", "mlb", "nhl"],
      toolSpecs: [],
      memoryBlock: "### Fan Profile (FAN_PROFILE.md)\nI love nba, nfl, mlb, and nhl.",
      model: mockModel,
      modelId: "mock-model",
      provider: "anthropic",
      config: baseConfig,
    });

    // With the base cap of 2 this would top out at 2 skills; the wiring
    // under test raises it to 4 for a multi-sport prompt. A revert of either
    // effectiveMaxSkills call site back to routingMaxSkills caps this at 2.
    assert.ok(
      result.decision.selectedSkills.length > 2,
      `expected more than the base cap of 2 skills, got: ${result.decision.selectedSkills.join(", ")}`
    );
  });
});
