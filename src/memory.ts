/**
 * sportsclaw — Persistent Memory with Pluggable Storage
 *
 * A 6-file memory system, each with a single purpose:
 *
 *   CONTEXT.md       — HOT:  ephemeral state snapshot (overwritten on context shifts)
 *   SOUL.md          — WARM: agent personality & relationship with this user (evolves)
 *   FAN_PROFILE.md   — WARM: interest graph — teams, leagues, sports (read-merge-write)
 *   REFLECTIONS.md   — WARM: append-only lessons learned from tool failures & discoveries
 *   STRATEGY.md      — WARM: self-authored behavioral directives (injected into system prompt)
 *   <date>.md        — WARM/COLD: append-only conversation archive
 *
 * Storage backends:
 *   FileMemoryStorage — local ~/.sportsclaw/memory/<userId>/ (default, open-source CLI)
 *   PodMemoryStorage  — Machina MCP pod documents (multi-tenant relay deployments)
 *
 * Backend is selected once at MemoryManager construction — no hybrid, no sync.
 */

import { mkdir, readFile, writeFile, appendFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { McpManager } from "./mcp.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MEMORY_BASE =
  process.env.SPORTSCLAW_MEMORY_DIR ||
  join(homedir(), ".sportsclaw", "memory");

const CONTEXT_FILE = "CONTEXT.md";
const SOUL_FILE = "SOUL.md";
const FAN_PROFILE_FILE = "FAN_PROFILE.md";
const REFLECTIONS_FILE = "REFLECTIONS.md";
const STRATEGY_FILE = "STRATEGY.md";
const THREAD_FILE = "thread.json";
const CONSOLIDATED_FILE = "CONSOLIDATED.md";

/** Maximum thread messages kept on disk (20 user/assistant pairs) */
const MAX_THREAD_MESSAGES = 40;

/** Maximum tail lines injected from today's log into the memory block */
const MAX_LOG_LINES = 100;

/** Maximum tail lines injected from consolidated memory into the memory block */
const MAX_CONSOLIDATED_LINES = 80;

/** Marker that starts each conversation entry in the daily log */
const ENTRY_SEPARATOR = "---";

/** Default age threshold for consolidation: logs older than 3 days */
const DEFAULT_CONSOLIDATION_AGE_DAYS = 3;

/** Maximum characters of old logs to send for consolidation in one batch */
const MAX_CONSOLIDATION_INPUT_CHARS = 50_000;

// ---------------------------------------------------------------------------
// Soul types (only exchange counter is tracked by code — rest is LLM-driven)
// ---------------------------------------------------------------------------

interface SoulData {
  born: string;
  exchanges: number;
  rest: string; // everything after the header, written freely by the LLM
}

export interface ThreadMessage {
  role: "user" | "assistant";
  content: string;
  ts: string;
}

// ---------------------------------------------------------------------------
// Storage Interface
// ---------------------------------------------------------------------------

export interface MemoryStorage {
  read(userId: string, file: string): Promise<string>;
  write(userId: string, file: string, content: string): Promise<void>;
  append(userId: string, file: string, content: string): Promise<void>;
  list(userId: string, pattern: string): Promise<string[]>;
  remove(userId: string, file: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// FileMemoryStorage — local filesystem (default)
// ---------------------------------------------------------------------------

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

/**
 * Sanitize a user/thread ID for safe use as a directory name.
 * Uses a hash suffix when characters are replaced to reduce collision risk.
 */
function sanitizeId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
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

class FileMemoryStorage implements MemoryStorage {
  private base: string;
  private dirCache = new Set<string>();

  constructor(base: string) {
    this.base = base;
  }

  private userDir(userId: string): string {
    return join(this.base, sanitizeId(userId));
  }

  private async ensureDir(userId: string): Promise<string> {
    const dir = this.userDir(userId);
    if (!this.dirCache.has(dir)) {
      await mkdir(dir, { recursive: true });
      this.dirCache.add(dir);
    }
    return dir;
  }

  async read(userId: string, file: string): Promise<string> {
    const dir = await this.ensureDir(userId);
    return safeRead(join(dir, file));
  }

  async write(userId: string, file: string, content: string): Promise<void> {
    const dir = await this.ensureDir(userId);
    await writeFile(join(dir, file), content, "utf-8");
  }

  async append(userId: string, file: string, content: string): Promise<void> {
    const dir = await this.ensureDir(userId);
    await appendFile(join(dir, file), content, "utf-8");
  }

  async list(userId: string, _pattern: string): Promise<string[]> {
    const dir = await this.ensureDir(userId);
    try {
      const files = await readdir(dir);
      return files
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .sort();
    } catch {
      return [];
    }
  }

  async remove(userId: string, file: string): Promise<void> {
    const dir = this.userDir(userId);
    const { unlink } = await import("node:fs/promises");
    try {
      await unlink(join(dir, file));
    } catch {
      // Skip files that can't be deleted
    }
  }

  /** Absolute path to a user's memory directory */
  getUserDir(userId: string): string {
    return this.userDir(userId);
  }
}

// ---------------------------------------------------------------------------
// PodMemoryStorage — Machina MCP pod documents
// ---------------------------------------------------------------------------

/** Map memory filenames to field keys in the single consolidated document. */
const FILE_FIELD_MAP: Record<string, string> = {
  SOUL: "soul",
  FAN_PROFILE: "fan_profile",
  CONTEXT: "context",
  REFLECTIONS: "reflections",
  STRATEGY: "strategy",
  CONSOLIDATED: "consolidated",
  thread: "thread",
};

/** Old multi-doc type names (for migration lookups). */
const OLD_DOC_TYPES = ["soul", "fan-profile", "context", "reflections", "strategy", "consolidated", "thread"];

/**
 * Map a memory filename to a field key in the consolidated document.
 * Daily logs (YYYY-MM-DD.md) map to "today".
 */
function fileToField(file: string): { field: string; date?: string } {
  const name = file.replace(/\.(md|json)$/, "");
  const dateMatch = name.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (dateMatch) return { field: "today", date: dateMatch[1] };
  return { field: FILE_FIELD_MAP[name] ?? name.toLowerCase() };
}

/**
 * Single-document pod storage. All memory fields for a user live in one
 * document named `memory-{userId}` with fields as top-level value keys.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MemoryEntry = { doc: Record<string, any>; docId: string | null; dirty: boolean };

export class PodMemoryStorage implements MemoryStorage {
  // Per-turn in-memory cache. Stores PROMISES (not resolved entries) so
  // concurrent loadCached calls within the same turn share one search/create
  // round-trip — without this, Promise.all([buildMemoryBlock(), readStrategy()])
  // races and each branch creates its own duplicate memory doc.
  private cache = new Map<string, Promise<MemoryEntry>>();

  // Per-userId serialization chain for read-modify-write operations (append).
  // Without this, two concurrent append() calls on the same userId both read
  // the pre-mutation doc and the second flush overwrites the first — losing
  // an entry. Chaining serializes the RMW segment so both writes land.
  private appendChain = new Map<string, Promise<void>>();

  constructor(private mcpManager: McpManager, private serverName: string) {}

  /**
   * Load (or create) the single consolidated memory document for a user.
   * Includes auto-migration from old multi-doc layout on first access.
   * Concurrent calls share one in-flight promise to prevent duplicate-doc creation.
   */
  private loadCached(userId: string): Promise<MemoryEntry> {
    const cached = this.cache.get(userId);
    if (cached) return cached;
    const promise = this.loadFromPod(userId);
    this.cache.set(userId, promise);
    return promise;
  }

  private async loadFromPod(userId: string): Promise<MemoryEntry> {
    // Search for the most-recently-updated consolidated doc with a non-empty
    // value. This handles two failure modes from earlier engine versions:
    //   (1) zombie empty docs from prior race-condition migrations, and
    //   (2) accidental dupes from non-deterministic create paths.
    // We always prefer the freshest doc that actually has content; if every
    // hit is empty, we fall back to the freshest empty hit (still better than
    // re-creating).
    const result = await this.callPod("search_documents", {
      filters: { name: `memory-${userId}` },
      fields: ["_id", "value", "content", "updated"],
      sorters: [["updated", -1]],
      page_size: 10,
    });

    // Machina Core API returns search results double-nested:
    // { status, message, data: { data: [...], status, total_documents } }
    // — so the array lives at result.data.data, not result.data.
    const hits = (result?.data?.data ?? []) as Array<Record<string, unknown>>;
    if (hits.length > 0) {
      const pickContent = (h: Record<string, unknown>): boolean => {
        const v = (h?.value ?? h?.content ?? {}) as Record<string, unknown>;
        return Object.keys(v).length > 0;
      };
      const chosen = hits.find(pickContent) ?? hits[0];
      const doc = ((chosen?.value ?? chosen?.content ?? {}) as Record<string, unknown>) as Record<string, unknown>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { doc: doc as Record<string, any>, docId: (chosen?._id as string) ?? null, dirty: false };
    }

    // No consolidated doc anywhere — attempt migration from old multi-doc layout
    const migrated = await this.migrateOldDocs(userId);
    return { doc: migrated.doc, docId: migrated.docId, dirty: false };
  }

  /**
   * Migrate old individual memory-{userId}-{type} documents into a single
   * memory-{userId} document. Deletes old docs after migration.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async migrateOldDocs(userId: string): Promise<{ doc: Record<string, any>; docId: string | null }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc: Record<string, any> = {};
    const oldDocIds: string[] = [];

    // Map old doc type names to new field names
    const typeToField: Record<string, string> = {
      "soul": "soul",
      "fan-profile": "fan_profile",
      "context": "context",
      "reflections": "reflections",
      "strategy": "strategy",
      "consolidated": "consolidated",
      "thread": "thread",
    };

    // Search for each old doc type
    for (const oldType of OLD_DOC_TYPES) {
      try {
        const oldName = `memory-${userId}-${oldType}`;
        const res = await this.callPod("search_documents", {
          filters: { name: oldName },
          fields: ["_id", "value", "content", "text"],
          page_size: 1,
        });
        const oldDoc = res?.data?.data?.[0];
        if (oldDoc) {
          const text = oldDoc?.value?.text ?? oldDoc?.content?.text ?? oldDoc?.text ?? "";
          if (text) {
            doc[typeToField[oldType] ?? oldType] = text;
          }
          if (oldDoc._id) oldDocIds.push(oldDoc._id);
        }
      } catch {
        // Skip failed lookups
      }
    }

    // Check for today's daily log
    try {
      const today = todayStamp();
      const dailyRes = await this.callPod("search_documents", {
        filters: { name: `memory-${userId}-daily-${today}` },
        fields: ["_id", "value", "content", "text"],
        page_size: 1,
      });
      const dailyDoc = dailyRes?.data?.data?.[0];
      if (dailyDoc) {
        const text = dailyDoc?.value?.text ?? dailyDoc?.content?.text ?? dailyDoc?.text ?? "";
        if (text) {
          doc.today = text;
          doc.today_date = today;
        }
        if (dailyDoc._id) oldDocIds.push(dailyDoc._id);
      }
    } catch {
      // Skip
    }

    // If there was nothing to migrate, do not create an empty consolidated
    // memory doc. Empty docs can outrank real memory during later unsorted
    // searches and make the agent appear stateless.
    if (Object.keys(doc).length === 0) {
      return { doc, docId: null };
    }

    // Create the consolidated document only when there is real memory content.
    const createResult = await this.callPod("create_document", {
      name: `memory-${userId}`,
      content: { value: doc },
      metadata: { type: "user-memory", user_id: userId },
    });
    // create_document also double-nests: { data: { data: { _id, ... } } }
    const docId = createResult?.data?.data?._id ?? null;

    // Fire-and-forget: delete old individual docs
    for (const id of oldDocIds) {
      this.callPod("delete_document", { item_id: id }).catch(() => {});
    }

    return { doc, docId };
  }

  async read(userId: string, file: string): Promise<string> {
    try {
      const { doc } = await this.loadCached(userId);
      const { field, date } = fileToField(file);

      if (field === "today" && date) {
        // If requesting a date that isn't today_date, return empty
        if (doc.today_date && doc.today_date !== date) return "";
        return doc.today ?? "";
      }

      return doc[field] ?? "";
    } catch {
      return "";
    }
  }

  async write(userId: string, file: string, content: string): Promise<void> {
    try {
      const entry = await this.loadCached(userId);
      const { field, date } = fileToField(file);

      if (field === "today" && date) {
        // Daily log rotation: if writing for a new day, move old today to consolidated
        if (entry.doc.today_date && entry.doc.today_date !== date && entry.doc.today) {
          const existing = entry.doc.consolidated ?? "";
          entry.doc.consolidated = existing
            ? `${existing}\n\n## ${entry.doc.today_date}\n${entry.doc.today}`
            : `## ${entry.doc.today_date}\n${entry.doc.today}`;
        }
        entry.doc.today = content;
        entry.doc.today_date = date;
      } else {
        entry.doc[field] = content;
      }

      entry.dirty = true;
      await this.flush(userId);
    } catch {
      // Non-fatal
    }
  }

  async append(userId: string, file: string, content: string): Promise<void> {
    // Serialize concurrent appends per userId. read+write share a cached doc
    // that mutates synchronously, but the read→mutate→flush sequence isn't
    // atomic, so two concurrent appends would both read pre-mutation state
    // and the second write would overwrite the first. Queue them instead.
    const previous = this.appendChain.get(userId) ?? Promise.resolve();
    const next = previous
      .catch(() => {}) // existing append swallowed errors; preserve that
      .then(async () => {
        const existing = await this.read(userId, file);
        await this.write(userId, file, existing ? `${existing}\n${content}` : content);
      });
    this.appendChain.set(userId, next);
    try {
      await next;
    } finally {
      // Drop the entry once we're the tail of the chain so the map doesn't grow.
      if (this.appendChain.get(userId) === next) {
        this.appendChain.delete(userId);
      }
    }
  }

  async list(userId: string, _pattern: string): Promise<string[]> {
    try {
      const { doc } = await this.loadCached(userId);
      if (doc.today && doc.today_date) {
        return [`${doc.today_date}.md`];
      }
      return [];
    } catch {
      return [];
    }
  }

  async remove(userId: string, file: string): Promise<void> {
    try {
      const entry = await this.loadCached(userId);
      const { field } = fileToField(file);

      if (field === "today") {
        entry.doc.today = "";
        entry.doc.today_date = "";
      } else {
        entry.doc[field] = "";
      }

      entry.dirty = true;
      await this.flush(userId);
    } catch {
      // Non-fatal
    }
  }

  /** Write cached doc back to pod if dirty. */
  async flush(userId: string): Promise<void> {
    const cachedPromise = this.cache.get(userId);
    if (!cachedPromise) return;
    const entry = await cachedPromise;
    if (!entry?.dirty) return;

    try {
      if (entry.docId) {
        await this.callPod("update_document", {
          item_id: entry.docId,
          content: { value: entry.doc },
        });
      } else {
        const result = await this.callPod("create_document", {
          name: `memory-${userId}`,
          content: { value: entry.doc },
          metadata: { type: "user-memory", user_id: userId },
        });
        entry.docId = result?.data?.data?._id ?? null;
      }
      entry.dirty = false;
    } catch {
      // Non-fatal
    }
  }

  /** Clear per-turn cache (call between turns if engine instance is reused). */
  clearCache(): void {
    this.cache.clear();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async callPod(toolName: string, args: Record<string, unknown>): Promise<any> {
    const result = await this.mcpManager.callToolDirect(this.serverName, toolName, args);
    if (result.isError) return {};
    try {
      return JSON.parse(result.content || "{}");
    } catch {
      return {};
    }
  }
}

// ---------------------------------------------------------------------------
// HindsightMemoryStorage — Vectorize Hindsight agent-memory server
// ---------------------------------------------------------------------------
//
// Hindsight (https://github.com/vectorize-io/hindsight) is a standalone memory
// server with a retain / recall / reflect HTTP API. It is selected via
// SPORTSCLAW_MEMORY_PROVIDER=hindsight and is mutually exclusive with the file
// and pod drivers — a single MemoryManager run uses exactly one.
//
// Mapping strategy (zero-regression round-trips):
//   - One Hindsight *bank* per user  → bank_id = `${bankPrefix}-${sanitizeId(userId)}`.
//     Recall is bank-scoped, so memories are isolated by userId by construction.
//   - Each logical memory file → exactly one *verbatim* memory addressed by a
//     stable `document_id` (the field/slot key from fileToField), tagged with
//     its source surface. Bank is created with retain_extraction_mode=verbatim
//     so recall returns the original bytes — required for SOUL.md header parsing
//     and thread.json JSON round-trips.
//   - read()   → recall filtered by the slot's tags (semantic + tag hybrid).
//   - write()  → retain a single item with update_mode="replace" (upsert).
//   - append() → read-concat-write, serialized per (userId, slot) to avoid the
//     concurrent-append race (same approach as PodMemoryStorage.append).
//
// All interface methods swallow transport errors and degrade to "stateless"
// (return ""/[]), never throwing into the engine turn — matching PodMemoryStorage.

export interface HindsightConfig {
  /** Base URL of the Hindsight instance, e.g. http://localhost:8888 */
  baseUrl: string;
  /** API namespace path segment (Hindsight default is "default"). */
  namespace: string;
  /** Bank id prefix; bank = `${bankPrefix}-${sanitizeId(userId)}`. */
  bankPrefix: string;
  /** Optional bearer token; omit for local/Ollama instances that need no auth. */
  apiKey?: string;
  /** Bank retain extraction mode. "verbatim" preserves original text exactly. */
  extractionMode: string;
  /** Recall/reflect compute budget. */
  recallBudget: "low" | "mid" | "high";
  /** Max tokens returned by recall — must be generous enough to round-trip a slot. */
  recallMaxTokens: number;
  /** Per-request timeout (ms). */
  timeoutMs: number;
  /** Optional thread/session id, stored in memory metadata for provenance. */
  threadId?: string;
  /** Injectable fetch implementation (tests). Defaults to the global fetch. */
  fetchImpl?: typeof globalThis.fetch;
  /** Log transport failures to stderr. */
  verbose?: boolean;
}

export class HindsightMemoryStorage implements MemoryStorage {
  private readonly baseUrl: string;
  private readonly namespace: string;
  private readonly bankPrefix: string;
  private readonly apiKey?: string;
  private readonly extractionMode: string;
  private readonly recallBudget: string;
  private readonly recallMaxTokens: number;
  private readonly timeoutMs: number;
  private readonly threadId?: string;
  private readonly verbose: boolean;
  private readonly fetchImpl: typeof globalThis.fetch;

  /** Banks confirmed-created this process (avoids re-issuing create on every write). */
  private banksEnsured = new Set<string>();

  /** Per-(userId, slot) serialization chain for read-modify-write appends. */
  private appendChain = new Map<string, Promise<void>>();

  constructor(config: HindsightConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.namespace = config.namespace;
    this.bankPrefix = config.bankPrefix;
    this.apiKey = config.apiKey;
    this.extractionMode = config.extractionMode;
    this.recallBudget = config.recallBudget;
    this.recallMaxTokens = config.recallMaxTokens;
    this.timeoutMs = config.timeoutMs;
    this.threadId = config.threadId;
    this.verbose = config.verbose ?? false;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
  }

  private bankId(userId: string): string {
    return `${this.bankPrefix}-${sanitizeId(userId)}`;
  }

  private bankPath(userId: string, suffix = ""): string {
    return `/v1/${this.namespace}/banks/${encodeURIComponent(this.bankId(userId))}${suffix}`;
  }

  /**
   * Resolve a memory filename to a Hindsight slot: a stable document_id used for
   * upsert/replace, the source surface (for tags/metadata), and the daily date
   * if applicable. Built on the shared fileToField mapping.
   */
  private slotFor(file: string): { slot: string; surface: string; date?: string } {
    const { field, date } = fileToField(file);
    if (field === "today" && date) {
      return { slot: `daily:${date}`, surface: "daily", date };
    }
    return { slot: field, surface: field };
  }

  /** Tag set carried on every memory: source surface + user scope (+ date). */
  private tagsFor(userId: string, surface: string, date?: string): string[] {
    const tags = ["sportsclaw", `user:${sanitizeId(userId)}`, `surface:${surface}`];
    if (date) tags.push(`date:${date}`);
    return tags;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        if (this.verbose) {
          console.error(`[sportsclaw] hindsight ${method} ${path} -> HTTP ${res.status}`);
        }
        return { ok: false, status: res.status };
      }
      const text = await res.text();
      if (!text) return { ok: true };
      try {
        return JSON.parse(text);
      } catch {
        return { ok: true };
      }
    } catch (err: unknown) {
      if (this.verbose) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[sportsclaw] hindsight ${method} ${path} failed: ${msg}`);
      }
      return { ok: false };
    }
  }

  /**
   * Create-or-update the per-user bank with verbatim extraction. Best-effort and
   * cached: once issued for a bank this process, we don't repeat it.
   */
  private async ensureBank(userId: string): Promise<void> {
    const bank = this.bankId(userId);
    if (this.banksEnsured.has(bank)) return;
    await this.request("POST", this.bankPath(userId), {
      retain_extraction_mode: this.extractionMode,
    });
    // Mark ensured regardless of outcome: a transient failure shouldn't make
    // every subsequent write re-attempt creation, and retain is non-fatal anyway.
    this.banksEnsured.add(bank);
  }

  async read(userId: string, file: string): Promise<string> {
    try {
      const { slot, surface, date } = this.slotFor(file);
      const tags = this.tagsFor(userId, surface, date);
      const res = await this.request("POST", this.bankPath(userId, "/memory/recall"), {
        query: slot,
        tags,
        tags_match: "all",
        budget: this.recallBudget,
        max_tokens: this.recallMaxTokens,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results: any[] = Array.isArray(res?.results) ? res.results : [];
      if (results.length === 0) return "";
      // Prefer memories addressed by this exact slot's document_id. With
      // update_mode="replace" there is normally one; if verbatim chunking split
      // a large slot, concatenate the chunks in returned order.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matching = results.filter((r: any) => r?.document_id === slot);
      const use = matching.length > 0 ? matching : results;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return use.map((r: any) => (typeof r?.text === "string" ? r.text : "")).join("");
    } catch {
      return "";
    }
  }

  async write(userId: string, file: string, content: string): Promise<void> {
    try {
      await this.ensureBank(userId);
      const { slot, surface, date } = this.slotFor(file);
      const tags = this.tagsFor(userId, surface, date);
      await this.request("POST", this.bankPath(userId, "/memory/retain"), {
        items: [
          {
            content,
            document_id: slot,
            tags,
            metadata: {
              userId,
              ...(this.threadId ? { threadId: this.threadId } : {}),
              surface,
              file,
            },
            update_mode: "replace",
          },
        ],
        async: false,
      });
    } catch {
      // Non-fatal — memory writes never block a turn.
    }
  }

  async append(userId: string, file: string, content: string): Promise<void> {
    // Serialize concurrent appends per (userId, slot). read+write is not atomic,
    // so two concurrent appends would both read pre-mutation state and the second
    // replace would overwrite the first, losing an entry. Chain them instead.
    const { slot } = this.slotFor(file);
    const key = `${userId}:${slot}`;
    const previous = this.appendChain.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const existing = await this.read(userId, file);
        await this.write(userId, file, existing ? `${existing}\n${content}` : content);
      });
    this.appendChain.set(key, next);
    try {
      await next;
    } finally {
      if (this.appendChain.get(key) === next) {
        this.appendChain.delete(key);
      }
    }
  }

  async list(userId: string, _pattern: string): Promise<string[]> {
    // Mirror PodMemoryStorage: surface only today's daily log. Hindsight performs
    // its own long-horizon consolidation, so SportsClaw-side consolidateOldLogs
    // is inert here (as it already is for the pod backend).
    try {
      const today = todayStamp();
      const content = await this.read(userId, `${today}.md`);
      return content ? [`${today}.md`] : [];
    } catch {
      return [];
    }
  }

  async remove(userId: string, file: string): Promise<void> {
    // Match PodMemoryStorage semantics: clear the slot's content (replace empty).
    await this.write(userId, file, "");
  }

  // -------------------------------------------------------------------------
  // Extra capabilities (not part of MemoryStorage) — Hindsight's semantic
  // pipelines, exposed for downstream/manual use and covered by tests.
  // -------------------------------------------------------------------------

  /** Free-form semantic recall across a user's bank (semantic + keyword + graph + temporal). */
  async recall(
    userId: string,
    query: string,
    opts: { tags?: string[]; budget?: string; maxTokens?: number } = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any[]> {
    try {
      const res = await this.request("POST", this.bankPath(userId, "/memory/recall"), {
        query,
        ...(opts.tags ? { tags: opts.tags, tags_match: "any" } : {}),
        budget: opts.budget ?? this.recallBudget,
        max_tokens: opts.maxTokens ?? this.recallMaxTokens,
      });
      return Array.isArray(res?.results) ? res.results : [];
    } catch {
      return [];
    }
  }

  /** Reflect over a user's memories to synthesize an insight (Hindsight reflect pipeline). */
  async reflect(
    userId: string,
    query: string,
    opts: { budget?: string; maxTokens?: number } = {}
  ): Promise<string> {
    try {
      const res = await this.request("POST", this.bankPath(userId, "/reflect"), {
        query,
        budget: opts.budget ?? this.recallBudget,
        max_tokens: opts.maxTokens ?? this.recallMaxTokens,
      });
      return typeof res?.text === "string" ? res.text : "";
    } catch {
      return "";
    }
  }
}

// ---------------------------------------------------------------------------
// Provider selection — file | pod | hindsight
// ---------------------------------------------------------------------------

/** Build a HindsightConfig from environment variables (+ optional overrides). */
export function hindsightConfigFromEnv(overrides: Partial<HindsightConfig> = {}): HindsightConfig {
  const budget = (process.env.HINDSIGHT_RECALL_BUDGET ?? "mid").toLowerCase();
  return {
    baseUrl: process.env.HINDSIGHT_BASE_URL || "http://localhost:8888",
    namespace: process.env.HINDSIGHT_NAMESPACE || "default",
    bankPrefix: process.env.HINDSIGHT_BANK_PREFIX || "sportsclaw",
    apiKey: process.env.HINDSIGHT_API_KEY || undefined,
    extractionMode: process.env.HINDSIGHT_RETAIN_EXTRACTION_MODE || "verbatim",
    recallBudget: (["low", "mid", "high"].includes(budget) ? budget : "mid") as "low" | "mid" | "high",
    recallMaxTokens: Number(process.env.HINDSIGHT_RECALL_MAX_TOKENS) || 32_768,
    timeoutMs: Number(process.env.HINDSIGHT_REQUEST_TIMEOUT_MS) || 30_000,
    ...overrides,
  };
}

export interface CreateMemoryStorageOptions {
  /** Required for pod/auto selection (to discover a Machina MCP server). */
  mcpManager?: McpManager;
  /** Optional thread/session id (stored as Hindsight memory metadata). */
  threadId?: string;
  verbose?: boolean;
}

export interface MemoryStorageSelection {
  /** Undefined → MemoryManager falls back to its FileMemoryStorage default. */
  storage?: MemoryStorage;
  /** The driver actually selected. */
  provider: "file" | "pod" | "hindsight";
  /** Raw requested value (provider/backend env, lower-cased). */
  requested: string;
  /** Pod server name or Hindsight base URL, when applicable. */
  server?: string;
  /** Stable key for de-duplicating the one-time selection log line. */
  logKey: string;
  /** Pre-formatted one-time log line. */
  logLine: string;
}

/**
 * Select the memory storage driver from the environment.
 *
 *   SPORTSCLAW_MEMORY_PROVIDER = file | pod | hindsight   (canonical)
 *   SPORTSCLAW_MEMORY_BACKEND  = auto | file | pod         (legacy fallback)
 *
 * If SPORTSCLAW_MEMORY_PROVIDER is unset we fall back to the legacy
 * SPORTSCLAW_MEMORY_BACKEND so existing deployments are unaffected. When both
 * are unset the default is "auto" (pod if a Machina server is connected, else
 * file) — preserving prior out-of-the-box behavior.
 */
export function createMemoryStorage(opts: CreateMemoryStorageOptions = {}): MemoryStorageSelection {
  const rawProvider = process.env.SPORTSCLAW_MEMORY_PROVIDER;
  const rawBackend = process.env.SPORTSCLAW_MEMORY_BACKEND;
  const usingLegacyVar = rawProvider === undefined && rawBackend !== undefined;
  const requested = (rawProvider ?? rawBackend ?? "auto").toLowerCase();

  if (!["file", "pod", "hindsight", "auto"].includes(requested)) {
    const varName = usingLegacyVar ? "SPORTSCLAW_MEMORY_BACKEND" : "SPORTSCLAW_MEMORY_PROVIDER";
    const raw = rawProvider ?? rawBackend;
    throw new Error(
      `Invalid ${varName}=${raw}. Expected "file", "pod", or "hindsight"` +
        (varName === "SPORTSCLAW_MEMORY_BACKEND" ? ' (or legacy "auto").' : ' (or "auto").')
    );
  }

  if (requested === "hindsight") {
    const cfg = hindsightConfigFromEnv({ threadId: opts.threadId, verbose: opts.verbose });
    return {
      storage: new HindsightMemoryStorage(cfg),
      provider: "hindsight",
      requested,
      server: cfg.baseUrl,
      logKey: `${requested}:hindsight:${cfg.baseUrl}`,
      logLine: `[sportsclaw] memory_backend requested=${requested} selected=hindsight base_url=${cfg.baseUrl}`,
    };
  }

  // file | pod | auto — unchanged pod-or-file logic.
  const machinaServer = requested === "file" ? undefined : opts.mcpManager?.getMachinaServerName();

  if (requested === "pod" && !machinaServer) {
    throw new Error(
      'Memory provider "pod" requires a connected Machina MCP server exposing ' +
        "search_documents, create_document, and update_document."
    );
  }

  const storage =
    machinaServer && opts.mcpManager
      ? new PodMemoryStorage(opts.mcpManager, machinaServer)
      : undefined;
  const selected: "pod" | "file" = storage ? "pod" : "file";

  return {
    storage,
    provider: selected,
    requested,
    server: machinaServer,
    logKey: `${requested}:${selected}:${machinaServer ?? "local"}`,
    logLine:
      `[sportsclaw] memory_backend requested=${requested} selected=${selected}` +
      (machinaServer ? ` server=${machinaServer}` : ""),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get today's date as YYYY-MM-DD */
function todayStamp(): string {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

/** Format a timestamp for log entries */
function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// ---------------------------------------------------------------------------
// MemoryManager
// ---------------------------------------------------------------------------

export class MemoryManager {
  private storage: MemoryStorage;
  private userId: string;

  constructor(userId: string, storage?: MemoryStorage) {
    this.userId = userId;
    this.storage = storage ?? new FileMemoryStorage(MEMORY_BASE);
  }

  /** Absolute path to the user's memory directory (only meaningful for file storage) */
  get memoryDir(): string {
    if (this.storage instanceof FileMemoryStorage) {
      return this.storage.getUserDir(this.userId);
    }
    return join(MEMORY_BASE, sanitizeId(this.userId));
  }

  // -------------------------------------------------------------------------
  // HOT layer — CONTEXT.md
  // -------------------------------------------------------------------------

  async readContext(): Promise<string> {
    return this.storage.read(this.userId, CONTEXT_FILE);
  }

  async writeContext(content: string): Promise<void> {
    await this.storage.write(this.userId, CONTEXT_FILE, content);
  }

  // -------------------------------------------------------------------------
  // WARM layer — <date>.md
  // -------------------------------------------------------------------------

  async readTodayLog(): Promise<string> {
    return this.storage.read(this.userId, `${todayStamp()}.md`);
  }

  async appendExchange(userPrompt: string, assistantReply: string): Promise<void> {
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

    await this.storage.append(this.userId, `${todayStamp()}.md`, entry);
  }

  async appendNote(label: string, content: string): Promise<void> {
    const ts = timestamp();
    const entry = [`> **${label}** (${ts}): ${content}`, ""].join("\n");
    await this.storage.append(this.userId, `${todayStamp()}.md`, entry);
  }

  // -------------------------------------------------------------------------
  // WARM layer — SOUL.md (agent personality & relationship)
  // -------------------------------------------------------------------------

  async readSoul(): Promise<string> {
    return this.storage.read(this.userId, SOUL_FILE);
  }

  async writeSoul(content: string): Promise<void> {
    await this.storage.write(this.userId, SOUL_FILE, content);
  }

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

  async incrementSoulExchanges(): Promise<void> {
    const raw = await this.readSoul();
    const data = this.parseSoulHeader(raw);
    data.exchanges++;

    const header = `# Soul\nBorn: ${data.born}\nExchanges: ${data.exchanges}\n`;
    const content = data.rest ? `${header}\n${data.rest}\n` : header;
    await this.storage.write(this.userId, SOUL_FILE, content);
  }

  // -------------------------------------------------------------------------
  // WARM layer — FAN_PROFILE.md
  // -------------------------------------------------------------------------

  async readFanProfile(): Promise<string> {
    return this.storage.read(this.userId, FAN_PROFILE_FILE);
  }

  async writeFanProfile(content: string): Promise<void> {
    await this.storage.write(this.userId, FAN_PROFILE_FILE, content);
  }

  // -------------------------------------------------------------------------
  // WARM layer — REFLECTIONS.md (append-only lessons learned)
  // -------------------------------------------------------------------------

  async readReflections(): Promise<string> {
    return this.storage.read(this.userId, REFLECTIONS_FILE);
  }

  async appendReflection(entry: string): Promise<void> {
    await this.storage.append(this.userId, REFLECTIONS_FILE, entry + "\n");
  }

  // -------------------------------------------------------------------------
  // WARM layer — STRATEGY.md (self-authored behavioral directives)
  // -------------------------------------------------------------------------

  async readStrategy(): Promise<string> {
    return this.storage.read(this.userId, STRATEGY_FILE);
  }

  async writeStrategy(content: string): Promise<void> {
    await this.storage.write(this.userId, STRATEGY_FILE, content);
  }

  // -------------------------------------------------------------------------
  // Thread persistence — conversation history across process restarts
  // -------------------------------------------------------------------------

  async readThread(): Promise<ThreadMessage[]> {
    const raw = await this.storage.read(this.userId, THREAD_FILE);
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  async writeThread(messages: ThreadMessage[]): Promise<void> {
    const capped = messages.slice(-MAX_THREAD_MESSAGES);
    await this.storage.write(this.userId, THREAD_FILE, JSON.stringify(capped));
  }

  async appendToThread(userPrompt: string, assistantReply: string): Promise<void> {
    const thread = await this.readThread();
    const ts = new Date().toISOString();
    thread.push(
      { role: "user", content: userPrompt, ts },
      { role: "assistant", content: assistantReply, ts },
    );
    await this.writeThread(thread);
  }

  // -------------------------------------------------------------------------
  // CONSOLIDATED.md — compressed knowledge from old daily logs
  // -------------------------------------------------------------------------

  async readConsolidated(): Promise<string> {
    return this.storage.read(this.userId, CONSOLIDATED_FILE);
  }

  async writeConsolidated(content: string): Promise<void> {
    await this.storage.write(this.userId, CONSOLIDATED_FILE, content);
  }

  async listDailyLogs(): Promise<string[]> {
    return this.storage.list(this.userId, "daily-log");
  }

  async getConsolidationCandidates(
    ageDays: number = DEFAULT_CONSOLIDATION_AGE_DAYS
  ): Promise<{ files: string[]; content: string; totalChars: number }> {
    const allLogs = await this.listDailyLogs();
    const today = todayStamp();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - ageDays);
    const cutoffStamp = cutoffDate.toISOString().slice(0, 10);

    const eligibleFiles: string[] = [];
    const contents: string[] = [];
    let totalChars = 0;

    for (const file of allLogs) {
      const dateStr = file.replace(".md", "");
      if (dateStr >= cutoffStamp || dateStr === today) continue;

      const content = await this.storage.read(this.userId, file);
      if (!content.trim()) continue;

      if (totalChars + content.length > MAX_CONSOLIDATION_INPUT_CHARS) break;

      eligibleFiles.push(file);
      contents.push(`## ${dateStr}\n\n${content}`);
      totalChars += content.length;
    }

    return {
      files: eligibleFiles,
      content: contents.join("\n\n---\n\n"),
      totalChars,
    };
  }

  async consolidateOldLogs(
    summarize: (content: string, existingSummary: string) => Promise<string>,
    ageDays: number = DEFAULT_CONSOLIDATION_AGE_DAYS
  ): Promise<number> {
    const candidates = await this.getConsolidationCandidates(ageDays);
    if (candidates.files.length === 0) return 0;

    const existing = await this.readConsolidated();
    const summary = await summarize(candidates.content, existing);
    if (!summary.trim()) return 0;

    await this.writeConsolidated(summary);

    for (const file of candidates.files) {
      await this.storage.remove(this.userId, file);
    }

    return candidates.files.length;
  }

  // -------------------------------------------------------------------------
  // Combined read for prompt injection-safe context assembly
  // -------------------------------------------------------------------------

  async buildMemoryBlock(): Promise<string> {
    const [context, todayLog, fanProfile, soul, reflections, consolidated] = await Promise.all([
      this.readContext(),
      this.readTodayLog(),
      this.readFanProfile(),
      this.readSoul(),
      this.readReflections(),
      this.readConsolidated(),
    ]);

    if (!context && !todayLog && !fanProfile && !soul && !reflections && !consolidated) return "";

    const parts: string[] = [
      "## Persistent Memory",
      `User ID: ${this.userId}`,
    ];

    if (soul) {
      parts.push("", "### Soul (SOUL.md)", soul);
    }

    if (fanProfile) {
      parts.push("", "### Fan Profile (FAN_PROFILE.md)", fanProfile);
    }

    if (context) {
      parts.push("", "### Current Context (CONTEXT.md)", context);
    }

    if (consolidated) {
      const tail = truncateAtEntryBoundary(consolidated, MAX_CONSOLIDATED_LINES);
      parts.push("", "### Consolidated Knowledge (older conversations)", tail);
    }

    if (reflections) {
      const tail = truncateAtEntryBoundary(reflections, 60);
      parts.push("", "### Reflections (REFLECTIONS.md)", tail);
    }

    if (todayLog) {
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
 * Truncate a log to approximately `maxLines` lines, but always cut at an
 * entry boundary (the "---" separator) to avoid splitting a conversation
 * entry in half.
 */
function truncateAtEntryBoundary(log: string, maxLines: number): string {
  const lines = log.split("\n");
  if (lines.length <= maxLines) return log;

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
