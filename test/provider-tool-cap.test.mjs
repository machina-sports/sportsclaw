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
  finalizeActiveTools,
} from "../dist/routing/tool-activation.js";

/** Providers cap tool definitions at 128; the registry is far larger. */
const PROVIDER_CEILING = 128;

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
];

/** Reproduces the shipped 291-tool registry: 19 internal + 272 sport tools. */
function buildLargeRegistry() {
  const skillOf = new Map();
  const sportTools = [];
  for (let i = 0; i < 272; i++) {
    const sport = SPORTS[i % SPORTS.length];
    const name = `${sport}_tool_${i}`;
    sportTools.push(name);
    skillOf.set(name, sport);
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

function makeEngine() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-tool-cap-"));
  const engine = new sportsclawEngine({ rootDir: tmpDir, verbose: false });
  const { toolNames, registry } = buildLargeRegistry();
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
        routing.activeTools.length <= PROVIDER_CEILING,
        `activeTools must stay within the ${PROVIDER_CEILING}-tool provider ceiling, got ${routing.activeTools.length}`,
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
    } finally {
      cleanup();
    }
  });
});

describe("finalizeActiveTools — provider ceiling boundary", () => {
  it("exposes the provider ceiling as 128", () => {
    assert.equal(PROVIDER_TOOL_CEILING, 128);
  });

  it("keeps the routed filter and merges history on a low-confidence follow-up when the registry exceeds the ceiling", () => {
    const active = finalizeActiveTools({
      routedActiveTools: ["generate_image", "reflect"],
      isFollowUp: true,
      lowConfidence: true,
      historyToolNames: ["nba_scores", "reflect"],
      totalToolCount: PROVIDER_TOOL_CEILING + 1,
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
        }),
        undefined,
        `registry of ${totalToolCount} fits the provider ceiling, so the old widen-to-all behavior is preserved`,
      );
    }
  });
});
