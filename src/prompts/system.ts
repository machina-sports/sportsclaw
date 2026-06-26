/**
 * sportsclaw — System prompt composer.
 *
 * Composes a sectioned system prompt for the main reasoning model. Replaces
 * the old monolithic BASE_SYSTEM_PROMPT in engine.ts.
 *
 * Design:
 *   - Static sections live in `sections.ts` (Identity, Voice, Tools, etc.).
 *   - Sport-specific behaviors live in `built-in-guides.ts` and only surface
 *     when the relevant skill is active.
 *   - The composer interleaves dynamic capability blocks (installed sports,
 *     tools, MCP pods) and ends with a "Current Turn" block that injects the
 *     user's actual question + detected sport + intent. Putting this last
 *     gives it the strongest attention weight on the next-token prediction.
 *
 * Every LLM call rebuilds the prompt with fresh per-turn context. There is no
 * caching at the prompt layer — caching happens at the provider's prompt-cache
 * boundary (the static sections naturally land at the front for cache hits).
 */

import type { ToolSpec, SkillGuide } from "../types.js";
import type { LLMProvider } from "../types.js";
import type { AgentDef } from "../agents.js";
import type { McpManager } from "../mcp.js";
import type { QueryIntent } from "../response-templates.js";
import { buildTemplatePrompt } from "../response-templates.js";
import { getSecurityDirectives } from "../security.js";
import { getBuiltInSkillGuides } from "./built-in-guides.js";
import { CORE_BEHAVIOR_SECTIONS, EXAMPLES, SECURITY_FLOOR } from "./sections.js";

// ---------------------------------------------------------------------------
// Context — the engine passes one of these for every prompt build.
// ---------------------------------------------------------------------------

export interface SystemPromptContext {
  /** Package version for self-awareness. */
  packageVersion: string;

  /** Provider + model — surfaced in self-awareness so the model knows what it is. */
  provider: LLMProvider;
  modelId: string;

  /** Routing config — surfaced so the model can reason about its own constraints. */
  routingMaxSkills: number;
  routingAllowSpillover: number;

  /** Trading + fan-profile gates. */
  allowTrading: boolean;
  skipFanProfile: boolean;

  /** Sports schemas. */
  installedSports: string[];
  availableSports: string[];

  /** Tool capabilities (already filtered by activeTools at the AI SDK layer). */
  toolSpecs: ToolSpec[];

  /** MCP layer. Pass the manager so we can pull pod inventories lazily. */
  mcpManager: McpManager;

  /** Discord integration status — used by the self-awareness block. */
  discordConfigured: boolean;
  discordPrefix: string;

  /** Memory + agents. */
  hasMemory: boolean;
  agents?: AgentDef[];

  /** Disk-loaded skill guides (from SPORTSCLAW_SKILL_GUIDES_DIR). */
  diskSkillGuides: ReadonlyArray<SkillGuide>;

  /** Evolved strategies (self-authored agent rules). */
  strategyContent?: string;

  /** Caller-supplied prompt prefix (e.g. CLI --system flag). */
  callerSystemPrompt?: string;

  /** Engine config systemPrompt suffix. */
  userSystemPrompt?: string;

  // -------------------------------------------------------------------------
  // Per-turn dynamic context — the "Claude Code-style" injection.
  // These change every call and live in the final "Current Turn" section.
  // -------------------------------------------------------------------------

  /** The user's current request, sanitized. */
  userPrompt: string;

  /** Skills the router selected for this turn. Drives skill-guide filtering. */
  selectedSkills: ReadonlyArray<string>;

  /** Intent classified by the router — drives the response shape template. */
  queryIntent?: QueryIntent;

  /** Compact summary of the last few user turns (for follow-up coherence). */
  recentContext?: string;
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

export function buildSystemPrompt(ctx: SystemPromptContext): string {
  const sections: string[] = [];

  if (ctx.callerSystemPrompt && ctx.callerSystemPrompt.trim()) {
    sections.push(ctx.callerSystemPrompt.trim());
  }

  // ---- Core behavior (static, cache-friendly) ----
  for (const block of CORE_BEHAVIOR_SECTIONS) {
    sections.push(block);
  }

  // ---- Memory directives (static-ish — only varies by hasMemory + skipFanProfile) ----
  if (ctx.hasMemory) {
    sections.push(memorySection(ctx.skipFanProfile));
  }

  // ---- Security floor (always present) ----
  sections.push(SECURITY_FLOOR);
  sections.push(getSecurityDirectives(ctx.allowTrading));

  // ---- Self-awareness (dynamic, but stable for the session) ----
  sections.push(selfAwarenessSection(ctx));

  // ---- Capabilities (dynamic — depends on installed schemas + MCP) ----
  const toolsBlock = capabilitiesSection(ctx);
  if (toolsBlock) sections.push(toolsBlock);

  // ---- Evolved strategies (self-authored rules — system-trust level) ----
  if (ctx.strategyContent && ctx.strategyContent.trim()) {
    sections.push(
      [
        "## Evolved Strategies",
        "",
        "These were developed through experience with this user. Treat them as behavioral rules. " +
          "When calling `evolve_strategy`, read these, modify as needed, and write the full updated content back.",
        "",
        ctx.strategyContent.trim(),
      ].join("\n")
    );
  }

  // ---- Active agents ----
  if (ctx.agents && ctx.agents.length > 0) {
    sections.push(agentsSection(ctx.agents));
  }

  // ---- Skill guides (filtered by selected skills + installed) ----
  const guides = resolveSkillGuides(ctx);
  if (guides.length > 0) {
    sections.push(skillGuidesSection(guides));
  }

  // ---- Examples (static, cache-friendly, end of stable region) ----
  sections.push(EXAMPLES);

  // ---- User-supplied system prompt (engine config) ----
  if (ctx.userSystemPrompt && ctx.userSystemPrompt.trim()) {
    sections.push(ctx.userSystemPrompt.trim());
  }

  // ---- Per-turn context (dynamic, MUST be last for attention weight) ----
  sections.push(currentTurnSection(ctx));

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Sub-section builders
// ---------------------------------------------------------------------------

function memorySection(skipFanProfile: boolean): string {
  const lines = [
    "## Memory",
    "",
    "Persistent memory is provided in a preceding `[MEMORY]` user message. It contains your fan profile, soul, reflections, and today's conversation log.",
    "",
    "Use it to:",
    "- Skip lookup steps (use stored team_id / competition_id directly).",
    "- Prioritize entities the user has shown interest in.",
    "- On vague queries that don't name a sport/team/league, proactively fetch data for high-interest entities in parallel.",
    "",
    "Update it via these tools (silently — never mention these calls in your response):",
    "- `update_context` when the user changes topic or you need to save state (active game, current focus).",
  ];

  if (!skipFanProfile) {
    lines.push(
      "- `update_fan_profile` after EVERY sports answer to record teams, leagues, players, sports asked about. Include entity IDs when known."
    );
  } else {
    lines.push("- (Fan profile updates disabled for this request.)");
  }

  lines.push(
    "- `update_soul` when you genuinely notice something new about the user's communication style, a memorable moment, or a content preference. Don't call it every turn.",
    "- `reflect` and `evolve_strategy` for self-improvement. Only when a real surprise or repeated pattern emerges. Read existing reflections in `[MEMORY]` to avoid past mistakes.",
    "",
    "Memory hygiene: keep CONTEXT.md current-state-only (overwrite, don't accumulate); SOUL.md as one-sentence observations; FAN_PROFILE.md as entity-level data only. Each file should skim in seconds."
  );

  return lines.join("\n");
}

function selfAwarenessSection(ctx: SystemPromptContext): string {
  const now = new Date();
  const lines = [
    "## Self-Awareness",
    "",
    `You are sportsclaw v${ctx.packageVersion}.`,
    `Provider: ${ctx.provider} · Model: ${ctx.modelId}`,
    `Routing: maxSkills=${ctx.routingMaxSkills}, spillover=${ctx.routingAllowSpillover}`,
    `Local time: ${now.toLocaleString("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "short" })}`,
    `Local date: ${now.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "long", year: "numeric", month: "long", day: "numeric" })}`,
    "",
    `Installed sports (${ctx.installedSports.length}): ${ctx.installedSports.length > 0 ? ctx.installedSports.join(", ") : "(none)"}`,
    `Available (not installed): ${ctx.availableSports.length > 0 ? ctx.availableSports.join(", ") : "(all installed)"}`,
    "",
    "Self-management tools: `get_agent_config`, `update_agent_config`, `install_sport`, `remove_sport`, `upgrade_sports_skills`.",
    "",
    "Background tasks:",
    "- `spawn_subagent`: launch async research that runs in the background. Use when a query is complex and the user doesn't need to wait. Tell them \"I'll look into that and get back to you.\"",
    "- `schedule_task` / `cancel_scheduled_task` / `list_scheduled_tasks`: recurring notifications (e.g., morning injury report).",
    "- `consolidate_memory`: compress old conversation logs into lean summaries. Use when memory feels bloated or the user asks to clean up.",
  ];

  if (ctx.installedSports.length === 0) {
    lines.push(
      "",
      "When the user asks about a sport, automatically call `install_sport` to load it — no confirmation needed on first use."
    );
  } else {
    lines.push(
      "",
      "When the user asks about a sport you DON'T have installed, tell them and offer to install it. Always include the disclaimer. User must confirm first."
    );
  }

  lines.push(
    "",
    `Discord integration: ${ctx.discordConfigured ? "configured" : "not configured"} (prefix: ${ctx.discordPrefix}).`,
    "`update_agent_config` supports: `discordBotToken`, `discordAllowedUsers`, `discordPrefix`. Guide users to https://discord.com/developers/applications for a bot token when needed."
  );

  return lines.join("\n");
}

function capabilitiesSection(ctx: SystemPromptContext): string | null {
  const pythonTools = ctx.toolSpecs.filter((s) => !s.name.startsWith("mcp__"));
  const mcpTools = ctx.toolSpecs.filter((s) => s.name.startsWith("mcp__"));

  const parts: string[] = ["## Available Tools"];

  if (pythonTools.length === 0 && mcpTools.length === 0) return null;

  if (pythonTools.length > 0) {
    parts.push("", `**Python skills:** ${pythonTools.map((s) => s.name).join(", ")}`);
    parts.push("Use the most specific tool available for each query.");
  }

  if (mcpTools.length > 0) {
    parts.push("", "**MCP server tools (Cloud Pods):**");
    const serverDescs = ctx.mcpManager.getServerDescriptions();
    const byServer = new Map<string, ToolSpec[]>();
    for (const spec of mcpTools) {
      const serverName = spec.name.split("__")[1];
      if (!byServer.has(serverName)) byServer.set(serverName, []);
      byServer.get(serverName)!.push(spec);
    }
    for (const [server, tools] of byServer) {
      const desc = serverDescs.get(server);
      parts.push("", `_${server}_${desc ? ` — ${desc}` : ""}`);
      for (const tool of tools) {
        parts.push(`- \`${tool.name}\`: ${tool.description}`);
      }
    }

    parts.push(
      "",
      "MCP tools connect to cloud services and may be slower than local tools. " +
        "If an MCP tool returns an `error_code`, check the `hint` field before retrying."
    );

    // Pod strategy + entity reference
    parts.push(
      "",
      "### Pod strategy",
      "1. CHECK POD FIRST — `search_documents`, `search_agents`, `search_workflows` to discover stored data and capabilities.",
      "2. USE PYTHON SKILLS for live data — scores, standings, odds, schedules change constantly.",
      "3. COMBINE BOTH for rich answers — pod context (analyses, research) alongside live Python data.",
      "4. SAVE TO POD — `create_document` to persist valuable insights for future queries.",
      "5. EXECUTE WORKFLOWS / AGENTS — `execute_workflow` and `execute_agent` for complex multi-step tasks.",
      "",
      "Rules:",
      "- Pod queries (documents, workflows, agents, connectors, templates) → MCP tools only.",
      "- Live sports data → Python skills.",
      "- Analysis / research / historical context → check pod first, supplement with live data.",
      "- Never ask \"which sport?\" for pod queries — they are not sport queries.",
      "",
      "### Pod entities",
      "- **Documents**: persistent data store. `search_documents` to query, `create_document` to save, `update_document` to modify.",
      "- **Workflows**: multi-step pipelines. `execute_workflow` with inputs; check `workflow-status` in the response.",
      "- **Agents**: orchestrators chaining workflows with conditional logic. `execute_agent` for complex multi-workflow tasks.",
      "- **Connectors**: external service integrations. `connector_search` to discover, `connector_executor` to call.",
      "- **Prompts**: reusable LLM templates with structured output. `execute_prompt` for one-shot reasoning.",
      "- **Templates**: bundles of agents+workflows+connectors+prompts. `import_template_from_git` to install."
    );

    const podCaps = ctx.mcpManager.getPodCapabilities();
    if (podCaps.size > 0) {
      const sectionLines: string[] = [];
      for (const [server, caps] of podCaps) {
        const prefix = podCaps.size > 1 ? `[${server}] ` : "";
        if (caps.workflows.length > 0)
          sectionLines.push(`${prefix}**Workflows:** ${caps.workflows.map((w) => w.name).join(", ")}`);
        if (caps.agents.length > 0)
          sectionLines.push(`${prefix}**Agents:** ${caps.agents.map((a) => a.name).join(", ")}`);
        if (caps.connectors.length > 0)
          sectionLines.push(`${prefix}**Connectors:** ${caps.connectors.map((c) => c.name).join(", ")}`);
      }
      if (sectionLines.length > 0) {
        parts.push(
          "",
          "### Pod inventory (discovered at startup)",
          ...sectionLines,
          "",
          "These are pre-installed capabilities you can execute directly."
        );
      }
    }

    if (ctx.mcpManager.getMachinaLoopServer()) {
      parts.push(
        "",
        "### Durable loop available",
        "This pod runs the Machina durable agentic loop. For a long, multi-step, or resumable task — " +
          "especially autonomous/background work that should survive interruptions — delegate it with the " +
          "`machina_loop` tool (action: start → returns a session_id; read → fetch the result; continue → follow up). " +
          "It persists every turn server-side, unlike a one-shot tool call. Prefer direct tools for quick answers."
      );
    }
  }

  return parts.join("\n");
}

function agentsSection(agents: AgentDef[]): string {
  if (agents.length === 1) {
    const a = agents[0];
    const skillLine =
      a.skills.length > 0
        ? `\n\nThis agent specializes in: ${a.skills.join(", ")}. Prioritize tools from these skills when relevant.`
        : "";
    return `## Active Agent: ${a.name} (${a.id})\n\n${a.body}${skillLine}`;
  }

  const lines: string[] = [
    "## Active Agents",
    "",
    "Multiple agents are active. Combine their perspectives and directives for a comprehensive answer.",
  ];
  for (const a of agents) {
    lines.push("", `### ${a.name} (${a.id})`, "", a.body);
    if (a.skills.length > 0) {
      lines.push("", `Specializes in: ${a.skills.join(", ")}.`);
    }
  }
  return lines.join("\n");
}

function skillGuidesSection(guides: SkillGuide[]): string {
  const lines: string[] = [
    "## Skill Guides",
    "",
    "Specialized workflows. When the user's request matches a guide's domain, follow its steps.",
  ];
  for (const g of guides) {
    lines.push("", `### ${g.name}`);
    if (g.description) lines.push("", g.description);
    lines.push("", g.body);
  }
  return lines.join("\n");
}

function currentTurnSection(ctx: SystemPromptContext): string {
  const lines: string[] = ["## Current Turn"];

  const skillsLabel =
    ctx.selectedSkills.length > 0 ? ctx.selectedSkills.join(", ") : "unspecified";
  lines.push("", `Routed skills: ${skillsLabel}`);

  if (ctx.queryIntent && ctx.queryIntent !== "ambiguous") {
    lines.push(`Detected intent: ${ctx.queryIntent.replace(/_/g, " ")}`);
  }

  if (ctx.recentContext && ctx.recentContext.trim()) {
    lines.push("", "Recent conversation:", ctx.recentContext.trim());
  }

  // Inject the user's actual request near the bottom of the prompt.
  // The model still sees it in the user message, but echoing it here in the
  // system context gives it a strong attention prior — same trick Claude Code
  // and other agentic systems use for "the question is X, the tools are Y".
  lines.push("", "User request:", `> ${ctx.userPrompt.replace(/\n/g, "\n> ")}`);

  // Append the response-shape template last so it's the freshest signal.
  if (ctx.queryIntent) {
    const tpl = buildTemplatePrompt(ctx.queryIntent);
    if (tpl) {
      lines.push("", tpl);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Skill guide resolution — merge disk + built-in, dedupe by id, filter by skills.
// ---------------------------------------------------------------------------

function resolveSkillGuides(ctx: SystemPromptContext): SkillGuide[] {
  const activeSkills = new Set<string>([
    ...ctx.selectedSkills,
    ...ctx.installedSports,
  ]);

  // Disk guides win on id collision (user customizations override built-ins).
  const byId = new Map<string, SkillGuide>();

  for (const g of getBuiltInSkillGuides(activeSkills)) {
    byId.set(g.id, g);
  }
  for (const g of ctx.diskSkillGuides) {
    byId.set(g.id, g);
  }

  return Array.from(byId.values());
}
