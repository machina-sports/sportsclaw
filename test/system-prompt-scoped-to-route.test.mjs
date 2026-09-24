// Sports Agent Bench v1: the routed main loop re-sent a 23k-char system prompt
// on every step: 7k chars listed all 291 tool names although 23 were offered,
// and 4k chars of skill guides covered every installed sport (Kalshi, March
// Madness brackets) for an NFL question.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildSystemPrompt } from "../dist/prompts/system.js";

function context(overrides = {}) {
  return {
    packageVersion: "test", provider: "anthropic", modelId: "test",
    routingMaxSkills: 2, routingAllowSpillover: 0, allowTrading: false, skipFanProfile: true,
    installedSports: ["nfl", "cbb", "kalshi", "football"], availableSports: [],
    toolSpecs: [], mcpManager: {
      getServerDescriptions: () => new Map(), getPodCapabilities: () => new Map(),
      getMachinaLoopServer: () => undefined, getMachinaServerName: () => undefined,
    },
    discordConfigured: false, discordPrefix: "!", hasMemory: false, diskSkillGuides: [],
    userPrompt: "Who won the AFC Championship?", selectedSkills: [], ...overrides,
  };
}

describe("skill guides follow the route", () => {
  it("a routed turn gets only its skills' guides", () => {
    const routed = buildSystemPrompt(context({ selectedSkills: ["nfl"] }));
    assert.doesNotMatch(routed, /March Madness/);
    assert.doesNotMatch(routed, /Kalshi market lookups/);
  });
  it("an unrouted turn keeps every installed skill's guides", () => {
    const unrouted = buildSystemPrompt(context());
    assert.match(unrouted, /March Madness/);
    assert.match(unrouted, /Kalshi market lookups/);
  });
});

describe("the tool list names only offered tools", () => {
  it("the engine passes the offered tools to both prompt builders (source check)", () => {
    const source = readFileSync(new URL("../dist/engine.js", import.meta.url), "utf8");
    assert.match(source, /activeTools \? \{ activeToolNames: activeTools \}/);
    assert.match(source, /agentActiveTools !== undefined \? \{ activeToolNames: agentActiveTools \}/);
    assert.match(source, /spec\.name\.startsWith\("mcp__"\) \|\| offered\.has\(spec\.name\)/);
  });
  it("the prompt lists the specs it is given", () => {
    const prompt = buildSystemPrompt(context({ toolSpecs: [{ name: "nfl_get_scoreboard", description: "", input_schema: {} }] }));
    assert.match(prompt, /\*\*Python skills:\*\* nfl_get_scoreboard\n/);
  });
});
