/**
 * Provider tool-cap overflow — regression suite
 *
 * Azure Foundry / OpenAI reject any request carrying more than 128 tool
 * definitions ("Invalid tools: array too long. Expected maximum 128, got 291").
 * The Vercel AI SDK only narrows the tool payload when `activeTools` is set —
 * omitting it sends the WHOLE registry. With all 22 sport schemas installed the
 * registry is 291 tools, so any route that omits `activeTools` is a hard
 * provider failure, not a soft degradation.
 *
 * These tests are fully offline: the registry is stubbed and the router model
 * throws, which `routePromptToSkills` catches (deterministic heuristic path).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { sportsclawEngine } from "../dist/index.js";
import {
  PROVIDER_TOOL_CEILING,
  ProviderToolCeilingError,
  finalizeActiveTools,
  providerToolCeiling,
  resolveParallelAgentRoutedTools,
} from "../dist/routing/tool-activation.js";

const SPORTS = [
  "nba", "nfl", "mlb", "nhl", "football", "tennis", "golf", "cricket",
  "volleyball", "wnba", "cbb", "cfb", "fastf1", "xctf", "news", "metadata",
  "kalshi", "polymarket", "betting", "markets", "esports", "openshell",
];

const INTERNAL_TOOLS = [
  "generate_image", "generate_video", "update_agent_config", "update_context",
  "update_fan_profile", "update_soul", "reflect", "evolve_strategy",
  "get_agent_config", "install_sport", "remove_sport", "upgrade_sports_skills",
  "spawn_subagent", "list_subagents", "schedule_task", "list_scheduled_tasks",
  "cancel_scheduled_task", "consolidate_memory", "run_selftest",
  "ask_user_question", "write_file", "execute_command", "render_chart", "create_task",
];

const REVIEW_ENGINE_TOOLS = [
  "ask_user_question", "write_file", "execute_command", "render_chart", "create_task",
];

/** Name of the MCP tool used by the MCP-visibility fixture variant. */
const MCP_TOOL = "mcp__demo__health";

/**
 * Reproduces the shipped 291-tool registry with engine-owned and sport tools.
 * With `{ withMcpTool: true }` one sport tool is swapped for an MCP tool, so
 * the registry stays at 291 while carrying a tool that must survive routing.
 */
function buildLargeRegistry({ withMcpTool = false } = {}) {
  const skillOf = new Map();
  const sportTools = [];
  const sportToolCount = 291 - INTERNAL_TOOLS.length;
  for (let i = 0; i < sportToolCount; i++) {
    const sport = SPORTS[i % SPORTS.length];
    const name = `${sport}_tool_${i}`;
    sportTools.push(name);
    skillOf.set(name, sport);
  }
  if (withMcpTool) {
    const replaced = sportTools[sportTools.length - 1];
    skillOf.delete(replaced);
    sportTools[sportTools.length - 1] = MCP_TOOL;
  }
  const toolNames = [...INTERNAL_TOOLS, ...sportTools];
  return {
    toolNames,
    registry: {
      getInstalledSkills: () => [...SPORTS],
      getAllToolSpecs: () =>
        toolNames.map((name) => ({
          name,
          description: `tool ${name}`,
          parameters: {},
        })),
      getSkillName: (name) => skillOf.get(name),
    },
  };
}

/** A model whose calls always fail, so no test ever reaches the network. */
const offlineModel = {
  specificationVersion: "v2",
  provider: "offline-test",
  modelId: "offline-test",
  supportedUrls: {},
  async doGenerate() {
    throw new Error("offline test model: no network calls in tests");
  },
  async doStream() {
    throw new Error("offline test model: no network calls in tests");
  },
};

function makeEngine(options) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-tool-cap-"));
  const engine = new sportsclawEngine({ rootDir: tmpDir, verbose: false });
  const { toolNames, registry } = buildLargeRegistry(options);
  engine.registry = registry;
  engine.mainModel = offlineModel;
  return { engine, toolNames, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

describe("Provider tool-cap overflow", () => {
  it("a no-sport conversational first turn keeps an active tool filter instead of exposing all 291 registry tools", async () => {
    const { engine, toolNames, cleanup } = makeEngine();
    try {
      assert.equal(toolNames.length, 291, "fixture must reproduce the 291-tool registry");

      const routing = await engine.resolveActiveToolsForPrompt(
        "hey, how are you doing today?",
        toolNames,
        undefined,
      );

      assert.ok(
        Array.isArray(routing.activeTools),
        "activeTools must be present — omitting it makes the AI SDK send all 291 tools and the provider rejects the request",
      );
      assert.ok(
        routing.activeTools.length <= PROVIDER_TOOL_CEILING,
        `activeTools must stay within the ${PROVIDER_TOOL_CEILING}-tool provider ceiling, got ${routing.activeTools.length}`,
      );
      assert.deepEqual(
        routing.activeTools.filter((n) => !INTERNAL_TOOLS.includes(n)),
        [],
        "no sport-schema tool may be active when routing selected no skill",
      );
      assert.ok(
        routing.activeTools.includes("generate_image"),
        "internal tools must stay available on a conversational turn",
      );
      for (const name of REVIEW_ENGINE_TOOLS) {
        assert.ok(
          routing.activeTools.includes(name),
          `${name} must stay active when getSkillName() reports no sport owner`,
        );
      }
    } finally {
      cleanup();
    }
  });

  it("keeps an MCP tool active on a no-sport route through the 291-tool registry", async () => {
    const { engine, toolNames, cleanup } = makeEngine({ withMcpTool: true });
    try {
      assert.equal(toolNames.length, 291, "fixture must reproduce the 291-tool registry");
      assert.ok(toolNames.includes(MCP_TOOL), "fixture must carry the MCP tool");

      const routing = await engine.resolveActiveToolsForPrompt(
        "hey, how are you doing today?",
        toolNames,
        undefined,
      );

      assert.ok(Array.isArray(routing.activeTools), "activeTools must be an explicit list");
      assert.ok(
        routing.activeTools.includes(MCP_TOOL),
        `${MCP_TOOL} must stay active — MCP tools are not sport-schema tools and routing must never drop them`,
      );
      assert.ok(
        routing.activeTools.length <= PROVIDER_TOOL_CEILING,
        `activeTools must stay within the ${PROVIDER_TOOL_CEILING}-tool provider ceiling, got ${routing.activeTools.length}`,
      );
      assert.deepEqual(
        routing.activeTools.filter((n) => !INTERNAL_TOOLS.includes(n) && n !== MCP_TOOL),
        [],
        "no sport-schema tool may be active when routing selected no skill",
      );
    } finally {
      cleanup();
    }
  });

  it("keeps every engine-owned fixture tool and MCP while skill-filtering a specialized agent", () => {
    const { engine, toolNames, cleanup } = makeEngine({ withMcpTool: true });
    try {
      assert.equal(toolNames.length, 291, "fixture must stay at exactly 291 tools");
      const active = engine.filterToolsForAgent(
        { id: "nba", name: "NBA", skills: ["nba"], tags: [], body: "" },
        toolNames,
      );

      assert.ok(Array.isArray(active));
      for (const name of REVIEW_ENGINE_TOOLS) {
        assert.ok(active.includes(name), `${name} must remain active for a skilled agent`);
      }
      assert.ok(active.includes(MCP_TOOL), "MCP tools must remain active for a skilled agent");
      assert.ok(active.some((name) => name.startsWith("nba_tool_")));
      assert.ok(!active.some((name) => name.startsWith("nfl_tool_")));
    } finally {
      cleanup();
    }
  });
});

describe("parallel generalist tool routing", () => {
  const mainActiveTools = ["generate_image", "nba_scores"];

  it("preserves no-filter semantics for uncapped providers", () => {
    for (const provider of ["anthropic", "google"]) {
      assert.equal(
        resolveParallelAgentRoutedTools({
          agentRoutedTools: undefined,
          mainActiveTools,
          totalToolCount: 291,
          ceiling: providerToolCeiling(provider),
        }),
        undefined,
        provider,
      );
    }
  });

  it("preserves no-filter semantics when a capped provider can fit the registry", () => {
    assert.equal(
      resolveParallelAgentRoutedTools({
        agentRoutedTools: undefined,
        mainActiveTools,
        totalToolCount: PROVIDER_TOOL_CEILING,
        ceiling: providerToolCeiling("openai"),
      }),
      undefined,
    );
  });

  it("falls back to the safe main filter only for a capped oversized registry", () => {
    const routed = resolveParallelAgentRoutedTools({
      agentRoutedTools: undefined,
      mainActiveTools,
      totalToolCount: PROVIDER_TOOL_CEILING + 1,
      ceiling: providerToolCeiling("azure-foundry"),
    });
    assert.deepEqual(routed, mainActiveTools);

    const finalized = finalizeActiveTools({
      routedActiveTools: routed,
      isFollowUp: true,
      lowConfidence: false,
      historyToolNames: ["history_tool"],
      totalToolCount: PROVIDER_TOOL_CEILING + 1,
      ceiling: providerToolCeiling("azure-foundry"),
    });
    assert.deepEqual(finalized, [...mainActiveTools, "history_tool"]);
  });

  it("preserves a specialized agent's own filter", () => {
    const agentRoutedTools = ["generate_image", "nfl_scores"];
    assert.equal(
      resolveParallelAgentRoutedTools({
        agentRoutedTools,
        mainActiveTools,
        totalToolCount: 291,
        ceiling: providerToolCeiling("openai"),
      }),
      agentRoutedTools,
    );
  });
});

describe("finalizeActiveTools — provider ceiling boundary", () => {
  it("exposes the provider ceiling as 128", () => {
    assert.equal(PROVIDER_TOOL_CEILING, 128);
  });

  it("applies the ceiling only to OpenAI and Azure Foundry", () => {
    assert.equal(providerToolCeiling("openai"), PROVIDER_TOOL_CEILING);
    assert.equal(providerToolCeiling("azure-foundry"), PROVIDER_TOOL_CEILING);
    assert.equal(providerToolCeiling("anthropic"), undefined);
    assert.equal(providerToolCeiling("google"), undefined);
  });

  it("keeps the routed filter and merges history on a low-confidence follow-up when the registry exceeds the ceiling", () => {
    const active = finalizeActiveTools({
      routedActiveTools: ["generate_image", "reflect"],
      isFollowUp: true,
      lowConfidence: true,
      historyToolNames: ["nba_scores", "reflect"],
      totalToolCount: PROVIDER_TOOL_CEILING + 1,
      ceiling: providerToolCeiling("openai"),
    });

    assert.ok(
      Array.isArray(active),
      "an oversized registry must never fall back to `undefined` (= send all tools)",
    );
    assert.deepEqual(
      [...active].sort(),
      ["generate_image", "nba_scores", "reflect"],
      "routed filter is preserved and widened with history tools, deduped, not truncated",
    );
  });

  it("returns undefined on a low-confidence follow-up when the registry fits the ceiling", () => {
    for (const totalToolCount of [PROVIDER_TOOL_CEILING - 1, PROVIDER_TOOL_CEILING]) {
      assert.equal(
        finalizeActiveTools({
          routedActiveTools: ["generate_image"],
          isFollowUp: true,
          lowConfidence: true,
          historyToolNames: ["nba_scores"],
          totalToolCount,
          ceiling: providerToolCeiling("azure-foundry"),
        }),
        undefined,
        `registry of ${totalToolCount} fits the provider ceiling, so the old widen-to-all behavior is preserved`,
      );
    }
  });
});

describe("finalizeActiveTools — oversized registry never resolves to undefined", () => {
  it("fails closed with an empty list on a first turn when routing produced no filter", () => {
    const active = finalizeActiveTools({
      routedActiveTools: undefined,
      isFollowUp: false,
      lowConfidence: false,
      historyToolNames: [],
      totalToolCount: PROVIDER_TOOL_CEILING + 1,
      ceiling: providerToolCeiling("openai"),
    });

    assert.deepEqual(
      active,
      [],
      "an oversized registry with no routed filter must send an explicit empty list, not `undefined` (= all tools)",
    );
  });

  it("fails closed with the deduped history tools on a follow-up when routing produced no filter", () => {
    const active = finalizeActiveTools({
      routedActiveTools: undefined,
      isFollowUp: true,
      lowConfidence: false,
      historyToolNames: ["nba_scores", "reflect", "nba_scores"],
      totalToolCount: PROVIDER_TOOL_CEILING + 1,
      ceiling: providerToolCeiling("azure-foundry"),
    });

    assert.ok(Array.isArray(active), "must never fall back to `undefined` above the ceiling");
    assert.deepEqual(
      [...active].sort(),
      ["nba_scores", "reflect"],
      "historical tool calls must stay defined, deduped, with no other tool added",
    );
  });

  it("still allows undefined below the ceiling when routing produced no filter", () => {
    assert.equal(
      finalizeActiveTools({
        routedActiveTools: undefined,
        isFollowUp: false,
        lowConfidence: false,
        historyToolNames: [],
        totalToolCount: PROVIDER_TOOL_CEILING,
        ceiling: providerToolCeiling("openai"),
      }),
      undefined,
      "small-registry behavior is unchanged: no filter means the whole registry is safe to send",
    );
  });
});

describe("finalizeActiveTools — explicit list never silently truncates", () => {
  const toolList = (count, prefix = "tool") =>
    Array.from({ length: count }, (_, i) => `${prefix}_${i}`);

  it(`accepts an explicit list of exactly ${PROVIDER_TOOL_CEILING} tools`, () => {
    const routedActiveTools = toolList(PROVIDER_TOOL_CEILING);
    const active = finalizeActiveTools({
      routedActiveTools,
      isFollowUp: false,
      lowConfidence: false,
      historyToolNames: [],
      totalToolCount: 291,
      ceiling: providerToolCeiling("openai"),
    });

    assert.equal(active.length, PROVIDER_TOOL_CEILING);
    assert.deepEqual(active, routedActiveTools);
  });

  it(`rejects an explicit routed list of ${PROVIDER_TOOL_CEILING + 1} tools before the provider is called`, () => {
    assert.throws(
      () =>
        finalizeActiveTools({
          routedActiveTools: toolList(PROVIDER_TOOL_CEILING + 1),
          isFollowUp: false,
          lowConfidence: false,
          historyToolNames: [],
          totalToolCount: 291,
          ceiling: providerToolCeiling("openai"),
        }),
      (err) => {
        assert.ok(
          err instanceof ProviderToolCeilingError,
          "must raise the local pre-provider ceiling error",
        );
        assert.match(err.message, new RegExp(String(PROVIDER_TOOL_CEILING)));
        assert.match(err.message, new RegExp(String(PROVIDER_TOOL_CEILING + 1)));
        assert.equal(err.ceiling, PROVIDER_TOOL_CEILING);
        assert.equal(err.count, PROVIDER_TOOL_CEILING + 1);
        assert.match(err.message, /\/compact|fresh session/i);
        return true;
      },
    );
  });

  it(`rejects a merged routed+history list of ${PROVIDER_TOOL_CEILING + 1} tools`, () => {
    assert.throws(
      () =>
        finalizeActiveTools({
          routedActiveTools: toolList(PROVIDER_TOOL_CEILING),
          isFollowUp: true,
          lowConfidence: false,
          historyToolNames: ["history_only_tool"],
          totalToolCount: 291,
          ceiling: providerToolCeiling("azure-foundry"),
        }),
      (err) => {
        assert.ok(err instanceof ProviderToolCeilingError);
        assert.equal(err.count, PROVIDER_TOOL_CEILING + 1);
        return true;
      },
    );
  });

  it("accepts a merged list that dedupes back down to the ceiling", () => {
    const routedActiveTools = toolList(PROVIDER_TOOL_CEILING);
    const active = finalizeActiveTools({
      routedActiveTools,
      isFollowUp: true,
      lowConfidence: false,
      historyToolNames: [routedActiveTools[0], routedActiveTools[5]],
      totalToolCount: 291,
      ceiling: providerToolCeiling("openai"),
    });

    assert.equal(active.length, PROVIDER_TOOL_CEILING);
  });

  it("preserves an explicit 291-tool list for unlimited providers", () => {
    const routedActiveTools = toolList(291);
    for (const provider of ["anthropic", "google"]) {
      const active = finalizeActiveTools({
        routedActiveTools,
        isFollowUp: false,
        lowConfidence: false,
        historyToolNames: [],
        totalToolCount: 291,
        ceiling: providerToolCeiling(provider),
      });
      assert.deepEqual(active, routedActiveTools, provider);
    }
  });

  it("preserves unlimited legacy widening to the whole registry", () => {
    assert.equal(
      finalizeActiveTools({
        routedActiveTools: ["nba_scores"],
        isFollowUp: true,
        lowConfidence: true,
        historyToolNames: ["history_tool"],
        totalToolCount: 291,
        ceiling: providerToolCeiling("anthropic"),
      }),
      undefined,
    );
  });
});

describe("no installed skills / no MCP regression", () => {
  it("keeps every engine-owned tool explicitly active instead of using a partial allowlist", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-tool-small-"));
    const engine = new sportsclawEngine({ rootDir: tmpDir, verbose: false });
    const toolNames = ["generate_image", "reflect", "run_selftest", ...REVIEW_ENGINE_TOOLS];
    engine.registry = {
      getInstalledSkills: () => [],
      getAllToolSpecs: () => [],
      getSkillName: () => undefined,
    };
    try {
      const routing = await engine.resolveActiveToolsForPrompt("hello", toolNames);
      assert.deepEqual(routing.activeTools, toolNames);
      const final = finalizeActiveTools({
        routedActiveTools: routing.activeTools,
        isFollowUp: false,
        lowConfidence: false,
        historyToolNames: [],
        totalToolCount: toolNames.length,
        ceiling: providerToolCeiling("openai"),
      });
      assert.deepEqual(final, toolNames);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
