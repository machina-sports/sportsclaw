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
 * active: true
 * ---
 * ## Directives
 * ...
 */

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import lockfile from "proper-lockfile";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_AGENTS_DIR = join(homedir(), ".sportsclaw", "agents");
const AGENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_AGENT_ID_LENGTH = 64;
const MAX_AGENT_NAME_LENGTH = 80;
const MAX_AGENT_TITLE_LENGTH = 120;
const MAX_AGENT_BODY_LENGTH = 100_000;
const MAX_AGENT_LIST_LENGTH = 64;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentDef {
  /** Filesystem ID derived from filename (e.g. "analyst") */
  id: string;
  /** Display name (from frontmatter) */
  name: string;
  /** Optional display title (from frontmatter). Empty when omitted. */
  title: string;
  /** Skills this agent can use. Empty = all skills (no filter). */
  skills: string[];
  /**
   * Intent tags this agent claims (e.g. "visual", "data", "briefing").
   * Used by the router to prefer purpose-built agents on intent matches
   * before falling back to skill-overlap scoring. Empty = no claims.
   */
  tags: string[];
  /** The full markdown body (directives + voice), injected into system prompt */
  body: string;
  /** Inactive agents remain on disk but cannot be selected or routed. */
  active: boolean;
  /** Built-ins are reserved and cannot be modified or inactivated. */
  builtin: boolean;
}

export interface CreateAgentInput {
  id: string;
  name: string;
  title?: string;
  body: string;
  skills?: string[];
  tags?: string[];
}

export interface UpdateAgentInput {
  name?: string;
  title?: string;
  body?: string;
  skills?: string[];
  tags?: string[];
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
  validateAgentId(id);
  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!fmMatch) {
    // No frontmatter — treat entire file as body
    return {
      id,
      name: id,
      title: "",
      skills: [],
      tags: [],
      body: validateBody(raw),
      active: true,
      builtin: isBuiltinAgent(id),
    };
  }

  const frontmatter = fmMatch[1];
  const body = fmMatch[2].trim();

  // Parse name
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const name = validateName(nameMatch ? nameMatch[1].trim() : id);

  // Parse optional title. Legacy files without it normalize to an empty title.
  const titleMatch = frontmatter.match(/^title:\s*(.*)$/m);
  const title = validateTitle(titleMatch ? titleMatch[1].trim() : "");

  // Parse a YAML list field (inline `[a, b, c]` or block `\n  - a\n  - b`)
  const parseList = (key: string): string[] => {
    const inline = frontmatter.match(new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, "m"));
    if (inline) {
      return inline[1].split(",").map((s) => s.trim()).filter(Boolean);
    }
    const block = frontmatter.match(new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s+.+\\n?)+)`, "m"));
    if (block) {
      return block[1]
        .split("\n")
        .map((line) => line.replace(/^\s*-\s*/, "").trim())
        .filter(Boolean);
    }
    return [];
  };

  const skills = validateSlugList(parseList("skills"), "skills");
  const tags = validateSlugList(parseList("tags"), "tags");
  const activeLine = frontmatter.match(/^active:\s*(.+)$/m);
  if (activeLine && activeLine[1] !== "true" && activeLine[1] !== "false") {
    throw new Error('Invalid agent active status: expected "true" or "false"');
  }
  const active = activeLine?.[1] !== "false";

  return {
    id,
    name,
    title,
    skills,
    tags,
    body: validateBody(body),
    active,
    builtin: isBuiltinAgent(id),
  };
}

// ---------------------------------------------------------------------------
// Load / List
// ---------------------------------------------------------------------------

/** Ensure the agents directory exists */
function agentsDir(): string {
  return process.env.SPORTSCLAW_AGENTS_DIR || DEFAULT_AGENTS_DIR;
}

function ensureAgentsDir(): string {
  const dir = agentsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  if (!lstatSync(dir).isDirectory()) {
    throw new Error("Agents path must be a real directory");
  }
  return dir;
}

function validateAgentId(id: unknown): string {
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > MAX_AGENT_ID_LENGTH ||
    !AGENT_ID_PATTERN.test(id)
  ) {
    throw new Error(
      "Invalid agent id: expected a lowercase slug using letters, numbers, and single hyphens"
    );
  }
  return id;
}

function validateName(name: unknown): string {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > MAX_AGENT_NAME_LENGTH ||
    name !== name.trim() ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new Error(`Invalid agent name: expected 1-${MAX_AGENT_NAME_LENGTH} printable characters`);
  }
  return name;
}

function validateTitle(title: unknown): string {
  if (
    typeof title !== "string" ||
    title.length > MAX_AGENT_TITLE_LENGTH ||
    title !== title.trim() ||
    /[\u0000-\u001f\u007f]/.test(title)
  ) {
    throw new Error(`Invalid agent title: expected at most ${MAX_AGENT_TITLE_LENGTH} printable characters`);
  }
  return title;
}

function validateBody(body: unknown): string {
  if (
    typeof body !== "string" ||
    body.trim().length === 0 ||
    body.length > MAX_AGENT_BODY_LENGTH ||
    body.includes("\0")
  ) {
    throw new Error(`Invalid agent body: expected 1-${MAX_AGENT_BODY_LENGTH} characters`);
  }
  return body.trim();
}

function validateSlugList(value: unknown, field: "skills" | "tags"): string[] {
  if (!Array.isArray(value) || value.length > MAX_AGENT_LIST_LENGTH) {
    throw new Error(`Invalid agent ${field}: expected an array of at most ${MAX_AGENT_LIST_LENGTH} slugs`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.length > MAX_AGENT_ID_LENGTH || !AGENT_ID_PATTERN.test(item)) {
      throw new Error(`Invalid agent ${field}: every value must be a lowercase slug`);
    }
    if (seen.has(item)) {
      throw new Error(`Invalid agent ${field}: duplicate value "${item}"`);
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

function agentPath(id: string): string {
  return join(ensureAgentsDir(), `${validateAgentId(id)}.md`);
}

function assertRegularAgentFile(path: string): void {
  if (existsSync(path) && !lstatSync(path).isFile()) {
    throw new Error("Agent definition must be a regular file");
  }
}

function readAgentContents(path: string): string {
  assertRegularAgentFile(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Agent definition must be a regular file");
    return readFileSync(fd, "utf-8");
  } finally {
    closeSync(fd);
  }
}

function withAgentLock<T>(path: string, operation: () => T): T {
  const release = lockfile.lockSync(path, {
    realpath: false,
  });
  try {
    return operation();
  } finally {
    release();
  }
}

function serializeAgent(agent: Pick<AgentDef, "name" | "title" | "skills" | "tags" | "body" | "active">): string {
  return [
    "---",
    `name: ${agent.name}`,
    `title: ${agent.title}`,
    `skills: [${agent.skills.join(", ")}]`,
    `tags: [${agent.tags.join(", ")}]`,
    `active: ${agent.active}`,
    "---",
    "",
    agent.body,
    "",
  ].join("\n");
}

function writeAgentAtomic(path: string, content: string, createOnly = false): void {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    writeFileSync(tmp, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
    if (createOnly) {
      linkSync(tmp, path);
      unlinkSync(tmp);
    } else {
      renameSync(tmp, path);
    }
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may already have been linked and removed.
    }
    throw error;
  }
}

/** Load all agent definitions from disk */
export function loadAgents(): AgentDef[] {
  return listAgents();
}

/** List native agent definitions, excluding inactive agents by default. */
export function listAgents(options?: { includeInactive?: boolean }): AgentDef[] {
  const dir = ensureAgentsDir();
  const agents: AgentDef[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".md")) continue;
    const id = file.replace(/\.md$/, "");
    if (!AGENT_ID_PATTERN.test(id)) continue;
    try {
      const path = join(dir, file);
      const agent = parseAgentFile(id, readAgentContents(path));
      if (agent.active || options?.includeInactive) agents.push(agent);
    } catch {
      // Skip unreadable or unsafe files during bulk listing.
    }
  }
  return agents;
}

/** Load a single agent by ID, or undefined if not found */
export function loadAgent(id: string): AgentDef | undefined {
  const filePath = agentPath(id);
  if (!existsSync(filePath)) return undefined;
  const raw = readAgentContents(filePath);
  return parseAgentFile(id, raw);
}

/** List agent IDs on disk */
export function listAgentIds(): string[] {
  return loadAgents().map((agent) => agent.id);
}

/** Get the agents directory path */
export function getAgentsDir(): string {
  return ensureAgentsDir();
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

export function isBuiltinAgent(id: string): boolean {
  return Object.hasOwn(BUILTIN_AGENTS, id);
}

export function createAgent(input: CreateAgentInput): AgentDef {
  const id = validateAgentId(input?.id);
  if (isBuiltinAgent(id)) {
    throw new Error(`Agent "${id}" is a reserved built-in agent`);
  }
  const filePath = agentPath(id);
  if (existsSync(filePath)) throw new Error(`Agent "${id}" already exists`);

  const agent: AgentDef = {
    id,
    name: validateName(input?.name),
    title: validateTitle(input?.title ?? ""),
    skills: validateSlugList(input?.skills ?? [], "skills"),
    tags: validateSlugList(input?.tags ?? [], "tags"),
    body: validateBody(input?.body),
    active: true,
    builtin: false,
  };
  try {
    writeAgentAtomic(filePath, serializeAgent(agent), true);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Agent "${id}" already exists`);
    }
    throw error;
  }
  return agent;
}

export function updateAgent(id: string, updates: UpdateAgentInput): AgentDef {
  validateAgentId(id);
  if (isBuiltinAgent(id)) throw new Error(`Built-in agent "${id}" cannot be modified`);
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
    throw new Error("Agent updates must be an object");
  }
  const allowed = new Set(["name", "title", "body", "skills", "tags"]);
  const keys = Object.keys(updates);
  if (keys.length === 0 || keys.some((key) => !allowed.has(key))) {
    throw new Error("Agent updates may contain only name, title, body, skills, and tags");
  }
  const filePath = agentPath(id);
  if (!existsSync(filePath)) throw new Error(`Agent "${id}" not found`);
  return withAgentLock(filePath, () => {
    const current = parseAgentFile(id, readAgentContents(filePath));
    const agent: AgentDef = {
      ...current,
      ...(updates.name !== undefined ? { name: validateName(updates.name) } : {}),
      ...(updates.title !== undefined ? { title: validateTitle(updates.title) } : {}),
      ...(updates.body !== undefined ? { body: validateBody(updates.body) } : {}),
      ...(updates.skills !== undefined ? { skills: validateSlugList(updates.skills, "skills") } : {}),
      ...(updates.tags !== undefined ? { tags: validateSlugList(updates.tags, "tags") } : {}),
    };
    writeAgentAtomic(filePath, serializeAgent(agent));
    return agent;
  });
}

export function inactivateAgent(id: string): AgentDef {
  validateAgentId(id);
  if (isBuiltinAgent(id)) throw new Error(`Built-in agent "${id}" cannot be inactivated`);
  const filePath = agentPath(id);
  if (!existsSync(filePath)) throw new Error(`Agent "${id}" not found`);
  return withAgentLock(filePath, () => {
    const current = parseAgentFile(id, readAgentContents(filePath));
    const agent = { ...current, active: false };
    writeAgentAtomic(filePath, serializeAgent(agent));
    return agent;
  });
}

/** Resolve one caller-selected active agent without falling back to routing. */
export function selectExplicitAgents(agents: AgentDef[], agentIds: readonly string[]): AgentDef[] {
  if (agentIds.length !== 1) throw new Error("Explicit agent selection requires exactly one agent id");
  const id = validateAgentId(agentIds[0]);
  const agent = agents.find((candidate) => candidate.id === id);
  if (!agent) throw new Error(`Agent "${id}" not found`);
  if (!agent.active) throw new Error(`Agent "${id}" is inactive`);
  return [agent];
}

/** Restrict skill-owned tools while preserving safe engine and MCP tools. */
export function filterToolNamesForAgent(
  agent: AgentDef,
  allToolNames: readonly string[],
  getSkillName: (toolName: string) => string | undefined,
): string[] | undefined {
  if (agent.skills.length === 0) return undefined;
  const skills = new Set(agent.skills);
  return allToolNames.filter((name) => {
    if (name.startsWith("mcp__")) return true;
    const skill = getSkillName(name);
    return skill === undefined || skills.has(skill);
  });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Write built-in agent files to disk if they don't already exist.
 * Called on first run or when agents directory is empty.
 * Returns the number of agents bootstrapped.
 */
export function bootstrapDefaultAgents(): number {
  const dir = ensureAgentsDir();
  let count = 0;

  for (const [id, content] of Object.entries(BUILTIN_AGENTS)) {
    const filePath = join(dir, `${id}.md`);
    if (!existsSync(filePath)) {
      try {
        writeAgentAtomic(filePath, content, true);
        count++;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST")) {
          throw error;
        }
      }
    }
  }

  return count;
}

/** Check if default agents need bootstrapping */
export function needsAgentBootstrap(): boolean {
  const dir = ensureAgentsDir();
  return Object.keys(BUILTIN_AGENTS).some((id) => !existsSync(join(dir, `${id}.md`)));
}
