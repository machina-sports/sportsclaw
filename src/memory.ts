/**
 * SportsClaw — Markdown Persistent Memory (OpenClaw Architecture)
 *
 * A 3-layer memory system using plain .md files:
 *
 *   HOT   → CONTEXT.md   — Current state snapshot (overwritten on context shifts)
 *   WARM  → <date>.md    — Append-only conversation log for today
 *   COLD  → older .md    — Previous days' logs (read-only archive)
 *
 * Storage layout:
 *   ~/.sportsclaw/memory/<userId>/CONTEXT.md
 *   ~/.sportsclaw/memory/<userId>/2026-02-23.md
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
  process.env.SPORTSCLAW_MEMORY_DIR ||
  join(homedir(), ".sportsclaw", "memory");

const CONTEXT_FILE = "CONTEXT.md";

/** Maximum size (in bytes) for CONTEXT.md to prevent unbounded writes */
const MAX_CONTEXT_BYTES = 32_768; // 32 KB

/** Maximum tail lines injected from today's log */
const MAX_LOG_LINES = 100;

/** Marker that starts each conversation entry in the daily log */
const ENTRY_SEPARATOR = "---";

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

  /**
   * Overwrite the user's context snapshot.
   * Enforces a size cap to prevent unbounded writes from LLM output.
   */
  async writeContext(content: string): Promise<void> {
    await this.dirReady;
    const capped =
      content.length > MAX_CONTEXT_BYTES
        ? content.slice(0, MAX_CONTEXT_BYTES) +
          "\n\n<!-- truncated: exceeded 32 KB limit -->"
        : content;
    await writeFile(join(this.dir, CONTEXT_FILE), capped, "utf-8");
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
    const context = await this.readContext();
    const todayLog = await this.readTodayLog();

    if (!context && !todayLog) return "";

    const parts: string[] = [
      "## Persistent Memory",
      `User ID: ${this.userId}`,
    ];

    if (context) {
      parts.push("", "### Current Context (CONTEXT.md)", context);
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
