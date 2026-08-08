import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveSubagentActiveTools } from "../dist/subagent.js";
import { ProviderToolCeilingError } from "../dist/routing/tool-activation.js";

const SKILLS = [
  "nba", "nfl", "mlb", "nhl", "wnba", "cbb", "cfb", "football",
  "tennis", "golf", "cricket", "volleyball", "f1", "xctf", "news",
  "metadata", "kalshi", "polymarket", "betting", "markets", "esports",
  "polymarket-trading",
];

function buildRegistry291() {
  const skillByTool = new Map();
  const toolNames = [];
  for (let i = 0; i < 290; i++) {
    const skill = SKILLS[i % SKILLS.length];
    const name = `${skill}_tool_${i}`;
    toolNames.push(name);
    skillByTool.set(name, skill);
  }
  toolNames.push("mcp__demo__health");
  return { toolNames, skillByTool };
}

describe("subagent provider-safe tool routing", () => {
  it("routes a deterministic 291-tool registry below the cap for OpenAI and Azure", () => {
    const { toolNames, skillByTool } = buildRegistry291();
    assert.equal(toolNames.length, 291);
    for (const provider of ["openai", "azure-foundry"]) {
      const active = resolveSubagentActiveTools({
        provider,
        toolNames,
        selectedSkills: ["nba"],
        getSkillName: (name) => skillByTool.get(name),
      });
      assert.ok(Array.isArray(active), provider);
      assert.ok(active.length > 0 && active.length <= 128, `${provider}: ${active.length}`);
      assert.ok(active.includes("mcp__demo__health"), provider);
      assert.ok(active.every((name) =>
        name.startsWith("mcp__") || skillByTool.get(name) === "nba"
      ));
    }
  });

  it("allows all 291 explicitly routed tools for Anthropic", () => {
    const { toolNames, skillByTool } = buildRegistry291();
    const active = resolveSubagentActiveTools({
      provider: "anthropic",
      toolNames,
      selectedSkills: SKILLS,
      getSkillName: (name) => skillByTool.get(name),
    });
    assert.equal(active.length, 291);
  });

  it("throws locally rather than slicing an oversized capped route", () => {
    const { toolNames, skillByTool } = buildRegistry291();
    assert.throws(
      () => resolveSubagentActiveTools({
        provider: "openai",
        toolNames,
        selectedSkills: SKILLS,
        getSkillName: (name) => skillByTool.get(name),
      }),
      ProviderToolCeilingError,
    );
  });

  it("preserves restricted exclusions even when a restricted name maps to a selected skill", () => {
    const active = resolveSubagentActiveTools({
      provider: "anthropic",
      toolNames: ["nba_scores", "spawn_subagent", "generate_image", "mcp__demo__health"],
      selectedSkills: ["nba"],
      getSkillName: () => "nba",
    });
    assert.deepEqual(active, ["nba_scores", "mcp__demo__health"]);
  });
});
