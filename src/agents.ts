/**
 * sportsclaw — Agent Definitions (Swarm Architecture)
 *
 * Agents are markdown files on disk that define specialized sub-agents.
 * Each agent has its own:
 *   - Directives (system prompt injection)
 *   - Skills filter (which sports tools it can use)
 *   - Voice/style (seeded into per-agent SOUL.md)
 *   - Evolution (per-agent soul that grows from usage)
 *
 * Storage layout:
 *   ~/.sportsclaw/agents/analyst.md
 *   ~/.sportsclaw/agents/scoreboard.md
 *   ~/.sportsclaw/agents/newsdesk.md
 *   ~/.sportsclaw/agents/my-custom-agent.md   (user-created)
 *
 * Per-agent soul (evolves independently):
 *   ~/.sportsclaw/memory/<userId>/agents/<agentId>/SOUL.md
 *
 * Format: YAML frontmatter + markdown body
 * ---
 * name: The Analyst
 * skills: [kalshi, polymarket, nfl, nba, football]
 * ---
 * ## Directives
 * ...
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENTS_DIR = join(homedir(), ".sportsclaw", "agents");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentDef {
  /** Filesystem ID derived from filename (e.g. "analyst") */
  id: string;
  /** Display name (from frontmatter) */
  name: string;
  /** Skills this agent can use. Empty = all skills (no filter). */
  skills: string[];
  /** The full markdown body (directives + voice), injected into system prompt */
  body: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a YAML-frontmatter markdown agent file.
 *
 * We do NOT depend on a YAML library — frontmatter is simple enough
 * (name: string, skills: [list]) to parse with regex.
 */
function parseAgentFile(id: string, raw: string): AgentDef {
  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!fmMatch) {
    // No frontmatter — treat entire file as body
    return { id, name: id, skills: [], body: raw.trim() };
  }

  const frontmatter = fmMatch[1];
  const body = fmMatch[2].trim();

  // Parse name
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const name = nameMatch ? nameMatch[1].trim() : id;

  // Parse skills array: skills: [a, b, c] or skills:\n  - a\n  - b
  let skills: string[] = [];
  const inlineMatch = frontmatter.match(/^skills:\s*\[([^\]]*)\]/m);
  if (inlineMatch) {
    skills = inlineMatch[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    // Check for YAML list style
    const listMatch = frontmatter.match(/^skills:\s*\n((?:\s+-\s+.+\n?)+)/m);
    if (listMatch) {
      skills = listMatch[1]
        .split("\n")
        .map((line) => line.replace(/^\s*-\s*/, "").trim())
        .filter(Boolean);
    }
  }

  return { id, name, skills, body };
}

// ---------------------------------------------------------------------------
// Load / List
// ---------------------------------------------------------------------------

/** Ensure the agents directory exists */
function ensureAgentsDir(): void {
  if (!existsSync(AGENTS_DIR)) {
    mkdirSync(AGENTS_DIR, { recursive: true });
  }
}

/** Load all agent definitions from disk */
export function loadAgents(): AgentDef[] {
  ensureAgentsDir();
  const agents: AgentDef[] = [];

  for (const file of readdirSync(AGENTS_DIR)) {
    if (!file.endsWith(".md")) continue;
    const id = file.replace(/\.md$/, "");
    try {
      const raw = readFileSync(join(AGENTS_DIR, file), "utf-8");
      agents.push(parseAgentFile(id, raw));
    } catch {
      // Skip unreadable files
    }
  }

  return agents;
}

/** Load a single agent by ID, or undefined if not found */
export function loadAgent(id: string): AgentDef | undefined {
  const filePath = join(AGENTS_DIR, `${id}.md`);
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = readFileSync(filePath, "utf-8");
    return parseAgentFile(id, raw);
  } catch {
    return undefined;
  }
}

/** List agent IDs on disk */
export function listAgentIds(): string[] {
  ensureAgentsDir();
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
}

/** Get the agents directory path */
export function getAgentsDir(): string {
  return AGENTS_DIR;
}

// ---------------------------------------------------------------------------
// Built-in agent templates
// ---------------------------------------------------------------------------

const BUILTIN_AGENTS: Record<string, string> = {
  analyst: `---
name: The Analyst
skills: [kalshi, polymarket, nfl, nba, mlb, nhl, football, f1]
---

## Directives

You are The Analyst — a prediction markets and odds specialist.

When answering questions:
- Lead with odds, probabilities, and market prices when available
- Compare lines across Kalshi and Polymarket when both are relevant
- Highlight value discrepancies and market movement
- Frame analysis around expected value and edge, not just who will win
- Use tables for odds comparisons when showing multiple markets
- When no markets data is available, fall back to stats-based analysis
- Cross-reference market prices with recent performance data

## Voice

Analytical and precise. Data-first, opinion second.
Comfortable with probability language — "62% implied", "positive EV", "-3.5 consensus".
Not a tout — present edges neutrally and let the user decide.

## Style

Tables for odds. Bullet points for quick takes. Prose only for deep dives.
Always cite the market source and timestamp.
`,

  scoreboard: `---
name: The Scoreboard
skills: [nfl, nba, nhl, mlb, wnba, cfb, cbb, football, tennis, golf, f1]
---

## Directives

You are The Scoreboard — a multi-sport scores and standings machine.

When answering questions:
- Lead with scores, records, and standings — not analysis
- Use compact formats: team abbreviations, W-L records, score lines
- When asked about a sport, include today's games + standings in one response
- On vague queries like "what's happening", show scores across multiple sports
- Parallel tool calls are critical — fetch scores from multiple sports simultaneously
- Keep responses scannable: tables, score lines, minimal prose
- Always show game status: Final, In Progress (with time/period), or Scheduled (with start time)

## Voice

Fast and clean. Scoreboard energy — no fluff, just the numbers.
Like a sports ticker that can talk back.

## Style

Score lines and tables. Compact team abbreviations.
Bold for final scores, regular for in-progress. Minimal commentary.
Group by sport when showing multi-sport results.
`,

  newsdesk: `---
name: The News Desk
skills: [news, football, nfl, nba, mlb, nhl, tennis]
---

## Directives

You are The News Desk — a sports news editor curating headlines and stories.

When answering questions:
- Lead with the headline, then provide context
- Aggregate news across multiple sources and sports when relevant
- For transfer rumors, note the reliability tier of the source when possible
- Structure digests with clear sections: Breaking, Headlines, Transfers, Upcoming
- When asked for a morning update or digest, compile a multi-sport briefing
- Pair news with relevant data (standings, upcoming fixtures) for context
- Track storylines — connect today's news to yesterday's developments

## Voice

Editorial and informed. Like a beat reporter who covers every sport.
Separate fact from rumor. Cite sources naturally.

## Style

Headlines first, details second. Sections for multi-topic digests.
Italics for source attribution. Bold for breaking news.
Time-stamp major stories.
`,
};

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Write built-in agent files to disk if they don't already exist.
 * Called on first run or when agents directory is empty.
 * Returns the number of agents bootstrapped.
 */
export function bootstrapDefaultAgents(): number {
  ensureAgentsDir();
  let count = 0;

  for (const [id, content] of Object.entries(BUILTIN_AGENTS)) {
    const filePath = join(AGENTS_DIR, `${id}.md`);
    if (!existsSync(filePath)) {
      writeFileSync(filePath, content, "utf-8");
      count++;
    }
  }

  return count;
}

/** Check if default agents need bootstrapping */
export function needsAgentBootstrap(): boolean {
  ensureAgentsDir();
  const existing = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
  return existing.length === 0;
}
