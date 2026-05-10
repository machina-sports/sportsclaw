/**
 * Editorial Memory — bounded, atomically-swapped, frozen-snapshotted markdown notes.
 *
 * The mutable "curated lessons" surface in the SportsClaw memory triad:
 *
 *   DecisionLedger   immutable append-only LOG          ─ what happened, when, why
 *   EditorialMemory  mutable, bounded, snapshot LESSONS ─ what we have learned (this file)
 *   LastTickBrief    per-tick handoff for the next run  ─ the most recent decision summary
 *
 * Each EditorialMemory file holds free-form markdown entries separated by `\n§\n`.
 * The runtime keeps an in-memory snapshot of the file contents from `load()` time;
 * mutations (`add`, `replace`, `remove`) update the on-disk file via atomic-rename
 * but do NOT change the snapshot. The snapshot is what gets concatenated into the
 * system prompt, so prompt-prefix caching survives mid-session writes — exactly
 * the trick used by Hermes' `MemoryStore` (see external review notes).
 *
 * Concurrency: writes are atomic (write-to-temp + fs.rename) so a crash mid-write
 * cannot corrupt the file. Multi-process writers are not supported by design;
 * the operator daemon is the only intended writer. If we ever need multi-writer,
 * pair this with proper-lockfile.
 *
 * Threat scanner: every `add` / `replace` body is checked against
 * `DEFAULT_THREAT_PATTERNS` (e.g. "ignore previous instructions", "system prompt:")
 * because memory contents end up inside the system prompt.
 */

import fs from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EditorialMemoryOptions {
  /** Hard char cap on the total file body. Default 4096. */
  maxChars?: number;
  /**
   * Reject `add` / `replace` bodies matching any of these patterns.
   * Defaults to `DEFAULT_THREAT_PATTERNS` (prompt-injection guards).
   * Pass `[]` to disable.
   */
  threatPatterns?: RegExp[];
}

export const ENTRY_DELIMITER = "\n§\n";
export const SILENT_BODY_THREAT = "memory entry is empty after sanitization";
export const DEFAULT_MAX_CHARS = 4096;

/** Patterns that are likely prompt-injection attempts. Memory body is rejected on match. */
export const DEFAULT_THREAT_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|messages|context)/i,
  /(?:disregard|forget)\s+(?:all\s+)?(?:previous|prior|the)\s+(?:instructions|context)/i,
  /you\s+are\s+now\s+(?:a|an)\s+\w+/i,
  /system\s*[:\-]\s*you\s+(?:are|must|will)/i,
  /<\s*\/?\s*system\s*>/i,
  /\[\s*system\s+(?:prompt|message|instruction)\s*\]/i,
];

// ---------------------------------------------------------------------------
// EditorialMemory
// ---------------------------------------------------------------------------

export class EditorialMemory {
  private readonly maxChars: number;
  private readonly threatPatterns: RegExp[];
  private snapshotText: string = "";
  private loaded = false;

  constructor(
    public readonly filePath: string,
    options: EditorialMemoryOptions = {},
  ) {
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    this.threatPatterns = options.threatPatterns ?? DEFAULT_THREAT_PATTERNS;
  }

  /**
   * Read the file from disk and freeze its contents as the snapshot used for
   * prompt assembly during this session. Creates an empty file if missing.
   */
  async load(): Promise<void> {
    try {
      this.snapshotText = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.writeFile(this.filePath, "", "utf8");
        this.snapshotText = "";
      } else {
        throw err;
      }
    }
    this.loaded = true;
  }

  /**
   * Frozen text used for system-prompt assembly. Stable for the lifetime of
   * this instance — mutations after `load()` do NOT change this. Returns
   * `""` until `load()` is called.
   */
  snapshot(): string {
    return this.snapshotText;
  }

  /**
   * Re-read the file and update the snapshot. Use sparingly — every call
   * invalidates the prompt-prefix cache.
   */
  async refreshSnapshot(): Promise<void> {
    await this.load();
  }

  /** Read the LIVE file contents (not the snapshot). */
  async readLive(): Promise<string> {
    return fs.readFile(this.filePath, "utf8").catch((err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw err;
    });
  }

  /** Live entries split on the delimiter, trimmed, empties dropped. */
  async entries(): Promise<string[]> {
    const text = await this.readLive();
    return splitEntries(text);
  }

  /**
   * Append a new entry. Throws if the body is empty after trim, contains a
   * threat pattern, or pushes the file over `maxChars`.
   */
  async add(body: string): Promise<void> {
    const cleaned = sanitizeBody(body, this.threatPatterns);
    const live = await this.readLive();
    const next = live === "" ? cleaned : live.replace(/\s+$/, "") + ENTRY_DELIMITER + cleaned;
    this.assertFits(next);
    await this.writeAtomic(next);
  }

  /**
   * Replace the first entry whose body contains `needle` (substring match)
   * with `replacement`. Returns true if an entry matched.
   */
  async replace(needle: string, replacement: string): Promise<boolean> {
    if (!needle) throw new Error("Editorial memory: needle must be non-empty.");
    const cleaned = sanitizeBody(replacement, this.threatPatterns);
    const list = await this.entries();
    let replaced = false;
    const next = list.map((e) => {
      if (!replaced && e.includes(needle)) {
        replaced = true;
        return cleaned;
      }
      return e;
    });
    if (!replaced) return false;
    const text = next.join(ENTRY_DELIMITER);
    this.assertFits(text);
    await this.writeAtomic(text);
    return true;
  }

  /**
   * Remove the first entry whose body contains `needle`. Returns true if
   * an entry matched.
   */
  async remove(needle: string): Promise<boolean> {
    if (!needle) throw new Error("Editorial memory: needle must be non-empty.");
    const list = await this.entries();
    let removed = false;
    const next = list.filter((e) => {
      if (!removed && e.includes(needle)) {
        removed = true;
        return false;
      }
      return true;
    });
    if (!removed) return false;
    await this.writeAtomic(next.join(ENTRY_DELIMITER));
    return true;
  }

  /** Replace the entire file contents in one atomic swap. */
  async overwrite(body: string): Promise<void> {
    const cleaned = sanitizeBody(body, this.threatPatterns);
    this.assertFits(cleaned);
    await this.writeAtomic(cleaned);
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private assertFits(text: string): void {
    if (text.length > this.maxChars) {
      throw new Error(
        `Editorial memory: ${this.filePath} would exceed ${this.maxChars} chars (got ${text.length}).`,
      );
    }
  }

  private async writeAtomic(text: string): Promise<void> {
    if (!this.loaded) {
      // load() must be called first so we know the file's parent dir exists.
      await this.load();
    }
    const dir = path.dirname(this.filePath);
    const tmp = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`);
    await fs.writeFile(tmp, text, "utf8");
    await fs.rename(tmp, this.filePath);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function splitEntries(text: string): string[] {
  if (!text) return [];
  return text
    .split(ENTRY_DELIMITER)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}

function sanitizeBody(body: string, threats: RegExp[]): string {
  const trimmed = (body ?? "").trim();
  if (!trimmed) {
    throw new Error("Editorial memory: " + SILENT_BODY_THREAT);
  }
  for (const pattern of threats) {
    if (pattern.test(trimmed)) {
      throw new Error(
        `Editorial memory: rejected for matching threat pattern ${pattern}.`,
      );
    }
  }
  return trimmed;
}

/** Parse a body string into entries — exposed for tooling, no I/O. */
export function parseMemoryBody(body: string): string[] {
  return splitEntries(body);
}

/** Combine entries into the canonical on-disk format — exposed for tooling, no I/O. */
export function formatMemoryBody(entries: string[]): string {
  return entries.map((e) => e.trim()).filter((e) => e.length > 0).join(ENTRY_DELIMITER);
}
