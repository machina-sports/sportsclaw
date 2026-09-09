import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { routePromptToSkills } from "../dist/router.js";

function input(prompt, installedSkills = ["football", "news"]) {
  return { prompt, installedSkills,
    toolSpecs: [{ name: "mcp__pod__search_documents", description: "Search pod documents", input_schema: {} }],
    model: new MockLanguageModelV3({ doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify({ selected_skills: ["football"], mode: "focused", confidence: 0.9, reason: "fixture", intent: "analysis" }) }],
      finishReason: { unified: "stop", raw: "stop" }, warnings: [],
      usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
    }) }), modelId: "mock", provider: "google",
    config: { routingMode: "soft_lock", routingMaxSkills: 2, routingAllowSpillover: 1, thinkingBudget: 0 } };
}

for (const prompt of [
  "Brief me on this fixture's strongest sourced stories and selection decisions.",
  "Research three distinct story leads using the pod's installed tools.",
  "Use Machina to research team news for this fixture.",
  "Pesquise notícias e pautas para este jogo no pod.",
]) {
  test(`keeps installed news reachable for: ${prompt}`, async () => {
    const result = await routePromptToSkills(input(prompt));
    assert.ok(result.decision.selectedSkills.includes("news"));
    assert.ok(result.decision.selectedSkills.includes("football"));
  });
}

test("pure pod administration still skips the sport router", async () => {
  const request = input("list my workflows on the pod");
  const result = await routePromptToSkills(request);
  assert.deepEqual(result.decision.selectedSkills, []);
  assert.equal(request.model.doGenerateCalls.length, 0);
});

test("does not activate an uninstalled news skill or add it to a score lookup", async () => {
  assert.ok(!(await routePromptToSkills(input("Brief me on match stories", ["football"]))).decision.selectedSkills.includes("news"));
  assert.ok(!(await routePromptToSkills(input("Sevilla score"))).decision.selectedSkills.includes("news"));
});
