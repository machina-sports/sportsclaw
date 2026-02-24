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
 */

import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEMORY_BASE =
  process.env.SPORTSCLAW_MEMORY_DIR ||
  join(homedir(), ".sportsclaw", "memory");

const CONTEXT_FILE = "CONTEXT.md";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get today's date as YYYY-MM-DD */
function todayStamp(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

/** Read a file, returning empty string if it doesn't exist */
function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
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

  constructor(userId: string) {
    this.userId = userId;
    this.dir = join(MEMORY_BASE, sanitizeId(userId));
    mkdirSync(this.dir, { recursive: true });
  }

  /** Absolute path to the user's memory directory */
  get memoryDir(): string {
    return this.dir;
  }

  // -------------------------------------------------------------------------
  // HOT layer — CONTEXT.md
  // -------------------------------------------------------------------------

  /** Read the user's current context snapshot */
  readContext(): string {
    return safeRead(join(this.dir, CONTEXT_FILE));
  }

  /** Overwrite the user's context snapshot */
  writeContext(content: string): void {
    writeFileSync(join(this.dir, CONTEXT_FILE), content, "utf-8");
  }

  // -------------------------------------------------------------------------
  // WARM layer — <date>.md
  // -------------------------------------------------------------------------

  /** Read today's conversation log */
  readTodayLog(): string {
    return safeRead(join(this.dir, `${todayStamp()}.md`));
  }

  /** Append a user→assistant exchange to today's log */
  appendExchange(userPrompt: string, assistantReply: string): void {
    const logPath = join(this.dir, `${todayStamp()}.md`);
    const ts = timestamp();

    const entry = [
      `## [${ts}]`,
      "",
      `**User:** ${userPrompt}`,
      "",
      `**Assistant:** ${assistantReply}`,
      "",
      "---",
      "",
    ].join("\n");

    appendFileSync(logPath, entry, "utf-8");
  }

  /** Append a raw note (e.g., tool output) to today's log */
  appendNote(label: string, content: string): void {
    const logPath = join(this.dir, `${todayStamp()}.md`);
    const ts = timestamp();

    const entry = [`> **${label}** (${ts}): ${content}`, ""].join("\n");

    appendFileSync(logPath, entry, "utf-8");
  }

  // -------------------------------------------------------------------------
  // Combined read for system prompt injection
  // -------------------------------------------------------------------------

  /**
   * Build a memory block suitable for injection into the system prompt.
   * Returns empty string if the user has no memory yet.
   */
  buildMemoryBlock(): string {
    const context = this.readContext();
    const todayLog = this.readTodayLog();

    if (!context && !todayLog) return "";

    const parts: string[] = [
      "## Persistent Memory",
      `User ID: ${this.userId}`,
    ];

    if (context) {
      parts.push("", "### Current Context (CONTEXT.md)", context);
    }

    if (todayLog) {
      // Only inject the tail of today's log to stay within token budget
      const lines = todayLog.split("\n");
      const MAX_LOG_LINES = 100;
      const tail =
        lines.length > MAX_LOG_LINES
          ? lines.slice(-MAX_LOG_LINES).join("\n")
          : todayLog;

      parts.push("", "### Today's Conversation Log", tail);
    }

    return parts.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Sanitize a user/thread ID for safe use as a directory name */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}

/** Get the base memory directory (useful for CLI / diagnostics) */
export function getMemoryDir(): string {
  return MEMORY_BASE;
}
