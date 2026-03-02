import { generateText } from "ai";
import type {
  LLMProvider,
  RouteDecision,
  RouteMeta,
  RouteOutcome,
  ToolSpec,
  sportsclawConfig,
} from "./types.js";
import { buildProviderOptions, DEFAULT_TOKEN_BUDGETS } from "./types.js";
import type { AgentDef } from "./agents.js";

type ModelType = Parameters<typeof generateText>[0]["model"];

interface RouteInput {
  prompt: string;
  installedSkills: string[];
  toolSpecs: ToolSpec[];
  memoryBlock?: string;
  recentContext?: string; // Last few user messages for multi-turn context
  model: ModelType;
  modelId: string;
  provider: LLMProvider;
  config: Pick<
    Required<sportsclawConfig>,
    "routingMode" | "routingMaxSkills" | "routingAllowSpillover" | "thinkingBudget" | "tokenBudgets"
  >;
}

interface LlmRouteAttempt {
  decision: Partial<RouteDecision> | null;
  durationMs: number;
  succeeded: boolean;
}

const HELPER_SKILLS = new Set(["news", "kalshi", "polymarket", "betting", "markets"]);
const TOOL_TOKEN_STOP_WORDS = new Set([
  "get",
  "list",
  "fetch",
  "items",
  "item",
  "current",
  "season",
  "team",
  "teams",
  "player",
  "players",
  "info",
  "stats",
  "data",
  "by",
  "for",
  "and",
  "all",
]);

const SKILL_ALIASES: Record<string, string[]> = {
  football: [
    "soccer",
    "premier league",
    "la liga",
    "serie a",
    "bundesliga",
    "champions league",
    "europa league",
    "mls",
  ],
  f1: ["formula 1", "formula one", "grand prix"],
  cfb: ["college football", "ncaaf"],
  cbb: ["college basketball", "march madness", "ncaab"],
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function countWordHits(text: string, phrase: string): number {
  const pattern = `\\b${escapeRegex(phrase.toLowerCase())}\\b`;
  const matches = text.match(new RegExp(pattern, "g"));
  return matches ? matches.length : 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function extractFanProfileSection(memoryBlock?: string): string {
  if (!memoryBlock) return "";
  const marker = "### Fan Profile (FAN_PROFILE.md)";
  const idx = memoryBlock.indexOf(marker);
  if (idx < 0) return "";
  const tail = memoryBlock.slice(idx + marker.length);
  const nextHeader = tail.search(/\n###\s+/);
  return (nextHeader >= 0 ? tail.slice(0, nextHeader) : tail).toLowerCase();
}

function inferHelperSkills(prompt: string, installed: Set<string>): Set<string> {
  const p = prompt.toLowerCase();
  const out = new Set<string>();
  if (
    installed.has("news") &&
    /\b(news|headline|headlines|rumor|rumours|report|latest)\b/.test(p)
  ) {
    out.add("news");
  }
  if (
    /\b(odds|moneyline|spread|futures|market|bet|betting|prediction)\b/.test(
      p
    )
  ) {
    if (installed.has("kalshi")) out.add("kalshi");
    if (installed.has("polymarket")) out.add("polymarket");
  }
  if (installed.has("kalshi") && /\bkalshi\b/.test(p)) out.add("kalshi");
  if (installed.has("polymarket") && /\bpolymarket\b/.test(p)) {
    out.add("polymarket");
  }

  // Betting analysis — de-vigging, Kelly criterion, edge detection, arbitrage
  if (
    installed.has("betting") &&
    /\b(devig|de-vig|kelly|edge|arbitrage|parlay|convert odds|vig|line movement)\b/.test(p)
  ) {
    out.add("betting");
  }

  // Markets dashboard — unified odds comparison across sources
  if (installed.has("markets")) {
    if (/\b(markets dashboard|compare odds|evaluate market|unified odds)\b/.test(p)) {
      out.add("markets");
    }
    // Co-activate with prediction market skills when both present
    if (
      (out.has("kalshi") || out.has("polymarket")) &&
      (out.has("kalshi") && out.has("polymarket"))
    ) {
      out.add("markets");
    }
  }

  return out;
}

function buildToolTokensBySkill(
  installedSkills: string[],
  toolSpecs: ToolSpec[]
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const installed = new Set(installedSkills);

  for (const skill of installedSkills) {
    map.set(skill, new Set());
  }

  for (const spec of toolSpecs) {
    const splitIdx = spec.name.indexOf("_");
    if (splitIdx <= 0) continue;
    const skill = spec.name.slice(0, splitIdx);
    if (!installed.has(skill)) continue;
    const suffix = spec.name.slice(splitIdx + 1);
    const parts = suffix
      .split("_")
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length >= 3 && !TOOL_TOKEN_STOP_WORDS.has(part));
    const bucket = map.get(skill);
    if (!bucket) continue;
    for (const part of parts) {
      bucket.add(part);
    }
  }

  return map;
}

function parseRouterJson(text: string): Partial<RouteDecision> | null {
  const candidate = text.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate) as {
      selected_skills?: unknown;
      mode?: unknown;
      confidence?: unknown;
      reason?: unknown;
    };
    const selectedSkills = Array.isArray(parsed.selected_skills)
      ? parsed.selected_skills.filter(
          (value): value is string => typeof value === "string"
        )
      : [];
    const mode =
      parsed.mode === "focused" || parsed.mode === "ambiguous"
        ? parsed.mode
        : undefined;
    const confidence =
      typeof parsed.confidence === "number" ? clamp01(parsed.confidence) : 0;
    const reason = typeof parsed.reason === "string" ? parsed.reason : "";
    return {
      selectedSkills,
      ...(mode ? { mode } : {}),
      confidence,
      reason,
    };
  } catch {
    return null;
  }
}

async function runLlmRouter(
  input: RouteInput,
  model: ModelType,
  deterministicCandidates: string[],
  memoryRanking: string[]
): Promise<LlmRouteAttempt> {
  const allowedSkills = input.installedSkills.join(", ");
  const candidateHint =
    deterministicCandidates.length > 0
      ? deterministicCandidates.join(", ")
      : "none";
  const memoryHint = memoryRanking.length > 0 ? memoryRanking.join(", ") : "none";
  const startedAt = Date.now();

  try {
    const result = await generateText({
      model,
      system: [
        "You route sports queries to tool skill domains.",
        "Return STRICT JSON only. No markdown, no prose.",
        "Choose only from allowed skills. Keep selection minimal.",
        "If one sport is explicit, mode must be focused.",
        "If prompt is broad/vague, mode may be ambiguous.",
      ].join(" "),
      prompt: [
        `Allowed skills: ${allowedSkills}`,
        `Deterministic candidates: ${candidateHint}`,
        `Memory preference ranking: ${memoryHint}`,
        ...(input.recentContext ? [`Recent conversation context: ${input.recentContext}`] : []),
        `User prompt: ${input.prompt}`,
        `Return JSON schema: {"selected_skills":["skill"],"mode":"focused|ambiguous","confidence":0.0,"reason":"short reason"}`,
      ].join("\n"),
      maxOutputTokens: input.config.tokenBudgets?.router ?? DEFAULT_TOKEN_BUDGETS.router,
      ...(() => {
        const mainBudget = input.config.thinkingBudget ?? 8192;
        const routerBudget = mainBudget > 0 ? Math.max(256, Math.floor(mainBudget / 16)) : 0;
        const opts = buildProviderOptions(input.provider, routerBudget);
        return opts ? { providerOptions: opts } : {};
      })(),
    });
    const parsed = parseRouterJson(result.text ?? "");
    return {
      decision: parsed,
      durationMs: Date.now() - startedAt,
      succeeded: Boolean(parsed),
    };
  } catch {
    return {
      decision: null,
      durationMs: Date.now() - startedAt,
      succeeded: false,
    };
  }
}

export async function routePromptToSkills(input: RouteInput): Promise<RouteOutcome> {
  const isSoftLock = input.config.routingMode === "soft_lock";
  const installedSet = new Set(input.installedSkills);
  if (installedSet.size === 0) {
    return {
      decision: {
        selectedSkills: [],
        mode: "ambiguous",
        confidence: 0,
        reason: "No sport schemas installed.",
      },
      meta: {
        modelUsed: null,
        llmAttempted: false,
        llmSucceeded: false,
        llmDurationMs: 0,
      },
    };
  }

  const promptNorm = normalizeText(input.prompt);
  const helperSkills = inferHelperSkills(promptNorm, installedSet);
  const fanProfile = extractFanProfileSection(input.memoryBlock);
  const toolTokens = buildToolTokensBySkill(input.installedSkills, input.toolSpecs);

  const skillScore = new Map<string, number>();
  const explicitSkills = new Set<string>();
  const memoryScore = new Map<string, number>();

  for (const skill of input.installedSkills) {
    if (HELPER_SKILLS.has(skill)) continue;
    let score = 0;

    if (countWordHits(promptNorm, skill) > 0) {
      score += 4;
      explicitSkills.add(skill);
    }

    for (const alias of SKILL_ALIASES[skill] ?? []) {
      const aliasHits = countWordHits(promptNorm, alias);
      if (aliasHits > 0) {
        score += 3 * aliasHits;
        explicitSkills.add(skill);
      }
    }

    for (const token of toolTokens.get(skill) ?? []) {
      if (countWordHits(promptNorm, token) > 0) {
        score += 0.4;
      }
    }

    skillScore.set(skill, score);

    let affinity = countWordHits(fanProfile, skill);
    for (const alias of SKILL_ALIASES[skill] ?? []) {
      affinity += countWordHits(fanProfile, alias);
    }
    memoryScore.set(skill, affinity);
  }

  const rankedDeterministic = Array.from(skillScore.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([skill]) => skill);

  const rankedMemory = Array.from(memoryScore.entries())
    .filter((entry) => entry[1] > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([skill]) => skill);

  const primaryAttempt = await runLlmRouter(
    input,
    input.model,
    rankedDeterministic.slice(0, 4),
    rankedMemory.slice(0, 4)
  );
  const llmDecision = primaryAttempt.decision;
  const llmDurationMs = primaryAttempt.durationMs;
  const llmSucceeded = primaryAttempt.succeeded;
  const modelUsed: string | null = llmSucceeded ? input.modelId : null;

  const selected = new Set<string>();
  let mode: "focused" | "ambiguous" =
    explicitSkills.size <= 1 ? "focused" : "ambiguous";
  let confidence = explicitSkills.size > 0 ? 0.9 : 0.55;
  let reason =
    explicitSkills.size > 0
      ? `Explicit intent detected for: ${Array.from(explicitSkills).join(", ")}`
      : "No explicit sport detected; using broad routing.";

  if (llmDecision?.selectedSkills && llmDecision.selectedSkills.length > 0) {
    const valid = llmDecision.selectedSkills.filter((skill) =>
      installedSet.has(skill)
    );
    for (const skill of valid) {
      selected.add(skill);
    }
    if (llmDecision.mode) mode = llmDecision.mode;
    if (typeof llmDecision.confidence === "number") {
      confidence = clamp01(llmDecision.confidence);
    }
    if (llmDecision.reason) reason = llmDecision.reason;
  }

  let primarySkills: string[] = [];

  if (explicitSkills.size > 0) {
    // If the user explicitly named a sport, keep routing locked to that sport
    // to prevent unrelated tool calls.
    primarySkills = Array.from(explicitSkills);
    const spilloverLimit = 0;
    for (const memorySkill of rankedMemory) {
      if (primarySkills.length >= explicitSkills.size + spilloverLimit) break;
      if (explicitSkills.has(memorySkill)) continue;
      primarySkills.push(memorySkill);
    }
  } else if (selected.size === 0) {
    const fallback = rankedDeterministic.find((skill) => skillScore.get(skill)! > 0);
    if (fallback) {
      selected.add(fallback);
      mode = "focused";
      confidence = Math.max(confidence, 0.65);
      reason = `Deterministic fallback selected: ${fallback}`;
    } else {
      for (const skill of rankedMemory.slice(0, input.config.routingMaxSkills)) {
        selected.add(skill);
      }
      if (selected.size > 0) {
        mode = "ambiguous";
        confidence = Math.max(confidence, 0.45);
        reason = "Used fan profile preference ranking for broad prompt.";
      }
    }
    primarySkills = Array.from(selected).filter(
      (skill) => !HELPER_SKILLS.has(skill)
    );
  } else {
    primarySkills = Array.from(selected).filter(
      (skill) => !HELPER_SKILLS.has(skill)
    );
  }
  let routedPrimary: string[] = [];

  if (mode === "focused") {
    const spillover = isSoftLock ? input.config.routingAllowSpillover : 0;
    const limit = Math.max(1, 1 + spillover);
    routedPrimary = primarySkills.slice(0, limit);
  } else {
    const limit = Math.max(1, input.config.routingMaxSkills);
    routedPrimary = primarySkills.slice(0, limit);
  }

  if (routedPrimary.length === 0 && primarySkills.length > 0) {
    routedPrimary = [primarySkills[0]];
  }

  const finalSkills = new Set<string>();
  for (const skill of routedPrimary) {
    finalSkills.add(skill);
  }
  for (const helper of helperSkills) {
    finalSkills.add(helper);
  }

  return {
    decision: {
      selectedSkills: Array.from(finalSkills),
      mode,
      confidence: clamp01(confidence),
      reason,
    },
    meta: {
      modelUsed,
      llmAttempted: true,
      llmSucceeded,
      llmDurationMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Agent routing — pick the best agent for a given prompt + selected skills
// ---------------------------------------------------------------------------

export interface AgentRouteResult {
  agent: AgentDef;
  score: number;
  reason: string;
}

/**
 * Given the skills selected by `routePromptToSkills`, score each agent
 * and return the top matches. Uses a simple overlap-based heuristic:
 *
 *   1. If prompt explicitly mentions an agent name → that agent wins (solo)
 *   2. Otherwise, score = (agent.skills ∩ selectedSkills).size / selectedSkills.size
 *   3. Agents with empty skills[] are generalists (score = 0.3 baseline)
 *   4. Tie-break: agent with broader coverage (more skills) wins
 *
 * Returns up to `maxAgents` agents with score > 0.5 (at least 1 if any exist).
 * Returns empty array if no agents are available.
 */
export function routeToAgents(
  agents: AgentDef[],
  selectedSkills: string[],
  prompt: string,
  maxAgents = 2
): AgentRouteResult[] {
  if (agents.length === 0) return [];
  if (agents.length === 1) {
    return [{ agent: agents[0], score: 1, reason: "Only agent available." }];
  }

  const promptLower = prompt.toLowerCase();
  const selectedSet = new Set(selectedSkills);

  // Phase 1: Check for explicit agent name in prompt
  for (const agent of agents) {
    const nameLower = agent.name.toLowerCase();
    const idLower = agent.id.toLowerCase();
    if (
      promptLower.includes(nameLower) ||
      promptLower.includes(idLower) ||
      promptLower.includes(`@${idLower}`)
    ) {
      return [{ agent, score: 1, reason: `Explicit mention: "${agent.name}"` }];
    }
  }

  // Phase 2: Score by skill overlap
  const scored: AgentRouteResult[] = [];

  for (const agent of agents) {
    if (agent.skills.length === 0) {
      // Generalist agent — low baseline score
      scored.push({ agent, score: 0.3, reason: "Generalist (no skill filter)." });
      continue;
    }

    const agentSkillSet = new Set(agent.skills);

    if (selectedSet.size === 0) {
      // No skills were selected (e.g. conversational query)
      scored.push({ agent, score: 0.3, reason: "No skills to match." });
      continue;
    }

    // Count overlap
    let overlap = 0;
    for (const skill of selectedSkills) {
      if (agentSkillSet.has(skill)) overlap++;
    }

    // Score = overlap ratio, with bonus for coverage breadth
    const overlapRatio = overlap / selectedSet.size;
    // Coverage bonus: agents with more skills = broader coverage, better generalist
    const coverageBonus = overlap > 0 ? 0.01 * (agent.skills.length / 20) : 0;
    const score = overlapRatio + coverageBonus;

    const reason =
      overlap > 0
        ? `Skill overlap: ${overlap}/${selectedSet.size} (${agent.skills.filter((s) => selectedSet.has(s)).join(", ")})`
        : "No skill overlap.";

    scored.push({ agent, score, reason });
  }

  // Sort: highest score first, then by broader coverage (more skills = better generalist)
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.agent.skills.length - a.agent.skills.length;
  });

  // Return top agents with score > 0.5, capped at maxAgents.
  // Always return at least 1 if any agents exist.
  const strong = scored.filter((r) => r.score > 0.5).slice(0, maxAgents);
  if (strong.length > 0) return strong;
  return scored.length > 0 ? [scored[0]] : [];
}
