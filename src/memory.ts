/**
 * sportsclaw — Markdown Persistent Memory (OpenClaw Architecture)
 *
 * A 6-file memory system using plain .md files, each with a single purpose:
 *
 *   CONTEXT.md       — HOT:  ephemeral state snapshot (overwritten on context shifts)
 *   SOUL.md          — WARM: agent personality & relationship with this user (evolves)
 *   FAN_PROFILE.md   — WARM: interest graph — teams, leagues, sports (read-merge-write)
 *   REFLECTIONS.md   — WARM: append-only lessons learned from tool failures & discoveries
 *   STRATEGY.md      — WARM: self-authored behavioral directives (injected into system prompt)
 *   <date>.md        — WARM/COLD: append-only conversation archive
 *
 * Storage layout:
 *   ~/.sportsclaw/memory/<userId>/CONTEXT.md
 *   ~/.sportsclaw/memory/<userId>/SOUL.md
 *   ~/.sportsclaw/memory/<userId>/FAN_PROFILE.md
 *   ~/.sportsclaw/memory/<userId>/REFLECTIONS.md
 *   ~/.sportsclaw/memory/<userId>/STRATEGY.md
 *   ~/.sportsclaw/memory/<userId>/2026-02-25.md
 *
 * No SQLite. No JSON blobs. Just markdown.
 *
 * All file I/O is async to avoid blocking the Node.js event loop under
 * concurrent bot traffic (Discord/Telegram listeners).
 */

import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEMORY_BASE =
  process.env.sportsclaw_MEMORY_DIR ||
  join(homedir(), ".sportsclaw", "memory");

const CONTEXT_FILE = "CONTEXT.md";
const SOUL_FILE = "SOUL.md";
const FAN_PROFILE_FILE = "FAN_PROFILE.md";
const REFLECTIONS_FILE = "REFLECTIONS.md";
const STRATEGY_FILE = "STRATEGY.md";

/** Maximum tail lines injected from today's log into the memory block */
const MAX_LOG_LINES = 100;

/** Marker that starts each conversation entry in the daily log */
const ENTRY_SEPARATOR = "---";

// ---------------------------------------------------------------------------
// Soul types (only exchange counter is tracked by code — rest is LLM-driven)
// ---------------------------------------------------------------------------

interface SoulData {
  born: string;
  exchanges: number;
  rest: string; // everything after the header, written freely by the LLM
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get today's date as YYYY-MM-DD */
function todayStamp(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

/**
 * Read a file, returning empty string if it doesn't exist.
 * Only swallows ENOENT — all other errors propagate.
 */
async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw err;
  }
}

/** Format a timestamp for log entries */
function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// ---------------------------------------------------------------------------
// MemoryManager
// ---------------------------------------------------------------------------

export class MemoryManager {
  private dir: string;
  private userId: string;
  private dirReady: Promise<void>;

  constructor(userId: string) {
    this.userId = userId;
    this.dir = join(MEMORY_BASE, sanitizeId(userId));
    // Ensure directory exists asynchronously — callers await `ready()` or
    // individual methods await it internally.
    this.dirReady = mkdir(this.dir, { recursive: true }).then(() => {});
  }

  /** Wait for the memory directory to be ready */
  async ready(): Promise<void> {
    await this.dirReady;
  }

  /** Absolute path to the user's memory directory */
  get memoryDir(): string {
    return this.dir;
  }

  // -------------------------------------------------------------------------
  // HOT layer — CONTEXT.md
  // -------------------------------------------------------------------------

  /** Read the user's current context snapshot */
  async readContext(): Promise<string> {
    await this.dirReady;
    return safeRead(join(this.dir, CONTEXT_FILE));
  }

  /** Overwrite the user's context snapshot */
  async writeContext(content: string): Promise<void> {
    await this.dirReady;
    await writeFile(join(this.dir, CONTEXT_FILE), content, "utf-8");
  }

  // -------------------------------------------------------------------------
  // WARM layer — <date>.md
  // -------------------------------------------------------------------------

  /** Read today's conversation log */
  async readTodayLog(): Promise<string> {
    await this.dirReady;
    return safeRead(join(this.dir, `${todayStamp()}.md`));
  }

  /** Append a user→assistant exchange to today's log */
  async appendExchange(userPrompt: string, assistantReply: string): Promise<void> {
    await this.dirReady;
    const logPath = join(this.dir, `${todayStamp()}.md`);
    const ts = timestamp();

    const entry = [
      `## [${ts}]`,
      "",
      `**User:** ${userPrompt}`,
      "",
      `**Assistant:** ${assistantReply}`,
      "",
      ENTRY_SEPARATOR,
      "",
    ].join("\n");

    await appendFile(logPath, entry, "utf-8");
  }

  /** Append a raw note (e.g., tool output) to today's log */
  async appendNote(label: string, content: string): Promise<void> {
    await this.dirReady;
    const logPath = join(this.dir, `${todayStamp()}.md`);
    const ts = timestamp();

    const entry = [`> **${label}** (${ts}): ${content}`, ""].join("\n");

    await appendFile(logPath, entry, "utf-8");
  }

  // -------------------------------------------------------------------------
  // WARM layer — SOUL.md (agent personality & relationship)
  // -------------------------------------------------------------------------

  /** Read the raw soul markdown */
  async readSoul(): Promise<string> {
    await this.dirReady;
    return safeRead(join(this.dir, SOUL_FILE));
  }

  /** Write the soul file. Content is fully LLM-authored markdown. */
  async writeSoul(content: string): Promise<void> {
    await this.dirReady;
    await writeFile(join(this.dir, SOUL_FILE), content, "utf-8");
  }

  /** Parse just the header fields (Born/Exchanges) from SOUL.md */
  parseSoulHeader(raw: string): SoulData {
    const data: SoulData = { born: new Date().toISOString(), exchanges: 0, rest: "" };
    if (!raw.trim()) return data;

    const lines = raw.split("\n");
    const restLines: string[] = [];
    let pastHeader = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("Born:")) {
        data.born = trimmed.replace("Born:", "").trim();
      } else if (trimmed.startsWith("Exchanges:")) {
        data.exchanges = parseInt(trimmed.replace("Exchanges:", "").trim(), 10) || 0;
      } else if (trimmed.startsWith("## ") || pastHeader) {
        pastHeader = true;
        restLines.push(line);
      }
    }

    data.rest = restLines.join("\n");
    return data;
  }

  /**
   * Increment the exchange counter on SOUL.md.
   * Called post-response — the only thing code touches automatically.
   * Creates the soul file on first interaction.
   */
  async incrementSoulExchanges(): Promise<void> {
    await this.dirReady;
    const raw = await this.readSoul();
    const data = this.parseSoulHeader(raw);
    data.exchanges++;

    const header = `# Soul\nBorn: ${data.born}\nExchanges: ${data.exchanges}\n`;
    const content = data.rest ? `${header}\n${data.rest}\n` : header;
    await writeFile(join(this.dir, SOUL_FILE), content, "utf-8");
  }

  // -------------------------------------------------------------------------
  // WARM layer — FAN_PROFILE.md
  // -------------------------------------------------------------------------

  /** Read the raw fan profile markdown */
  async readFanProfile(): Promise<string> {
    await this.dirReady;
    return safeRead(join(this.dir, FAN_PROFILE_FILE));
  }

  /** Write the fan profile. Content is fully LLM-authored markdown. */
  async writeFanProfile(content: string): Promise<void> {
    await this.dirReady;
    await writeFile(join(this.dir, FAN_PROFILE_FILE), content, "utf-8");
  }

  // -------------------------------------------------------------------------
  // WARM layer — REFLECTIONS.md (append-only lessons learned)
  // -------------------------------------------------------------------------

  /** Read the reflections log */
  async readReflections(): Promise<string> {
    await this.dirReady;
    return safeRead(join(this.dir, REFLECTIONS_FILE));
  }

  /** Append a structured reflection entry */
  async appendReflection(entry: string): Promise<void> {
    await this.dirReady;
    await appendFile(join(this.dir, REFLECTIONS_FILE), entry + "\n", "utf-8");
  }

  // -------------------------------------------------------------------------
  // WARM layer — STRATEGY.md (self-authored behavioral directives)
  // -------------------------------------------------------------------------

  /** Read the strategy file */
  async readStrategy(): Promise<string> {
    await this.dirReady;
    return safeRead(join(this.dir, STRATEGY_FILE));
  }

  /** Write the strategy file. Content is fully LLM-authored markdown. */
  async writeStrategy(content: string): Promise<void> {
    await this.dirReady;
    await writeFile(join(this.dir, STRATEGY_FILE), content, "utf-8");
  }

  // -------------------------------------------------------------------------
  // Combined read for prompt injection-safe context assembly
  // -------------------------------------------------------------------------

  /**
   * Build a memory block suitable for injection into the conversation.
   *
   * Returns empty string if the user has no memory yet.
   * Content is intended to be injected as a *user-role* message (not system)
   * to reduce prompt injection surface area.
   */
  async buildMemoryBlock(): Promise<string> {
    const [context, todayLog, fanProfile, soul, reflections] = await Promise.all([
      this.readContext(),
      this.readTodayLog(),
      this.readFanProfile(),
      this.readSoul(),
      this.readReflections(),
    ]);

    if (!context && !todayLog && !fanProfile && !soul && !reflections) return "";

    const parts: string[] = [
      "## Persistent Memory",
      `User ID: ${this.userId}`,
    ];

    // Soul first — shapes how the agent talks
    if (soul) {
      parts.push("", "### Soul (SOUL.md)", soul);
    }

    // Fan profile second — shapes what content to fetch
    if (fanProfile) {
      parts.push("", "### Fan Profile (FAN_PROFILE.md)", fanProfile);
    }

    if (context) {
      parts.push("", "### Current Context (CONTEXT.md)", context);
    }

    // Reflections — lessons learned from past interactions
    if (reflections) {
      const tail = truncateAtEntryBoundary(reflections, 60);
      parts.push("", "### Reflections (REFLECTIONS.md)", tail);
    }

    if (todayLog) {
      // Truncate at entry boundaries (---) instead of splitting mid-entry
      const tail = truncateAtEntryBoundary(todayLog, MAX_LOG_LINES);
      parts.push("", "### Today's Conversation Log", tail);
    }

    return parts.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Sanitize a user/thread ID for safe use as a directory name.
 * Uses a hash suffix when characters are replaced to reduce collision risk.
 */
function sanitizeId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
  // If sanitization changed the string, append a short hash to reduce collisions
  if (safe !== id) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
    }
    const suffix = Math.abs(hash).toString(36).slice(0, 6);
    return `${safe.slice(0, 121)}_${suffix}`;
  }
  return safe;
}

/**
 * Truncate a log to approximately `maxLines` lines, but always cut at an
 * entry boundary (the "---" separator) to avoid splitting a conversation
 * entry in half.
 */
function truncateAtEntryBoundary(log: string, maxLines: number): string {
  const lines = log.split("\n");
  if (lines.length <= maxLines) return log;

  // Walk backwards from the cut point to find the nearest entry separator
  const cutStart = lines.length - maxLines;
  let adjustedStart = cutStart;
  for (let i = cutStart; i < lines.length; i++) {
    if (lines[i].trim() === ENTRY_SEPARATOR) {
      adjustedStart = i + 1;
      break;
    }
  }

  return lines.slice(adjustedStart).join("\n");
}

/** Get the base memory directory (useful for CLI / diagnostics) */
export function getMemoryDir(): string {
  return MEMORY_BASE;
}
