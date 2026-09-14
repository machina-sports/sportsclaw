import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { buildSystemPrompt } from "../dist/prompts/system.js";

function manager(machina = false) {
  return {
    getServerDescriptions: () => new Map(),
    getPodCapabilities: () => new Map(),
    getMachinaLoopServer: () => undefined,
    getMachinaServerName: () => (machina ? "project" : undefined),
  };
}

function context(overrides = {}) {
  return {
    packageVersion: "test",
    provider: "anthropic",
    modelId: "test",
    routingMaxSkills: 2,
    routingAllowSpillover: 0,
    allowTrading: false,
    skipFanProfile: true,
    installedSports: [],
    availableSports: [],
    toolSpecs: [],
    mcpManager: manager(false),
    discordConfigured: false,
    discordPrefix: "!",
    hasMemory: false,
    diskSkillGuides: [],
    userPrompt: "build a game",
    selectedSkills: [],
    ...overrides,
  };
}

describe("Machina stack guide", () => {
  it("is absent without Machina scope", () => {
    assert.doesNotMatch(buildSystemPrompt(context()), /one scheduler owner/i);
  });

  it("is present for explicit or connected Machina scope", () => {
    const explicit = buildSystemPrompt(
      context({ selectedSkills: ["machina"] }),
    );
    const connected = buildSystemPrompt(
      context({ mcpManager: manager(true) }),
    );
    for (const prompt of [explicit, connected]) {
      assert.match(prompt, /local SportsClaw agents/i);
      assert.match(prompt, /live tool schema discovery/i);
      assert.match(prompt, /deterministic sync workflows/i);
      assert.match(prompt, /one scheduler owner/i);
    }
  });

  it("keeps disk guide override semantics while preserving activation", () => {
    const disk = [{
      id: "machina-stack",
      name: "Override",
      description: "custom",
      body: "CUSTOM MACHINA STACK GUIDE",
    }];
    assert.doesNotMatch(
      buildSystemPrompt(context({ diskSkillGuides: disk })),
      /CUSTOM MACHINA STACK GUIDE/,
    );
    assert.match(
      buildSystemPrompt(context({ selectedSkills: ["machina"], diskSkillGuides: disk })),
      /CUSTOM MACHINA STACK GUIDE/,
    );
  });

  it("ships the guide in the npm package", () => {
    const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
      encoding: "utf-8",
    });
    const packed = JSON.parse(output);
    const files = packed[0].files.map((entry) => entry.path);
    assert.ok(files.includes("dist/prompts/built-in-guides.js"));
    assert.ok(files.includes("dist/build-brief.js"));
    assert.ok(files.includes("dist/games.js"));
  });
});
