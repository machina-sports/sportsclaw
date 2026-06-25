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
 *   HindsightMemoryStorage — Vectorize Hindsight HTTP API (explicit opt-in)
 *
 * Backend is selected once at MemoryManager construction — no hybrid, no sync.
 */

import { mkdir, readFile, writeFile, appendFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
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

/** Hard cap for semantic recall injected into an engine turn. */
const MAX_SEMANTIC_RECALL_CHARS = 8_000;
const MAX_SEMANTIC_RECALL_RESULTS = 8;
const SEMANTIC_RECALL_MAX_TOKENS = 2_048;

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

export interface SemanticMemoryResult {
  text: string;
  document_id?: string;
  type?: string;
}

export interface SemanticRecallOptions {
  tags?: string[];
  budget?: string;
  maxTokens?: number;
  agentId?: string;
}

// ---------------------------------------------------------------------------
// Storage Interface
// ---------------------------------------------------------------------------

export interface MemoryStorage {
  read(userId: string, file: string, agentId?: string): Promise<string>;
  write(userId: string, file: string, content: string, agentId?: string): Promise<void>;
  append(userId: string, file: string, content: string, agentId?: string): Promise<void>;
  list(userId: string, pattern: string, agentId?: string): Promise<string[]>;
  remove(userId: string, file: string, agentId?: string): Promise<void>;
  /** Optional semantic lookup. Exact structured reads continue to use read(). */
  recall?(
    userId: string,
    query: string,
    options?: SemanticRecallOptions
  ): Promise<SemanticMemoryResult[]>;
  /** Optional backend-atomic append of complete thread messages. */
  appendThread?(
    userId: string,
    messages: ThreadMessage[],
    agentId?: string
  ): Promise<void>;
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

export class FileMemoryStorage implements MemoryStorage {
  private base: string;
  private dirCache = new Set<string>();

  constructor(base: string) {
    this.base = base;
  }

  private userDir(userId: string, agentId?: string): string {
    const userDir = join(this.base, sanitizeId(userId));
    return agentId ? join(userDir, "agents", sanitizeId(agentId)) : userDir;
  }

  private async ensureDir(userId: string, agentId?: string): Promise<string> {
    const dir = this.userDir(userId, agentId);
    if (!this.dirCache.has(dir)) {
      await mkdir(dir, { recursive: true });
      this.dirCache.add(dir);
    }
    return dir;
  }

  async read(userId: string, file: string, agentId?: string): Promise<string> {
    const dir = await this.ensureDir(userId, agentId);
    return safeRead(join(dir, file));
  }

  async write(userId: string, file: string, content: string, agentId?: string): Promise<void> {
    const dir = await this.ensureDir(userId, agentId);
    const path = join(dir, file);
    // Atomic write: temp + rename so a crash mid-write never tears the file.
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await writeFile(tmp, content, "utf-8");
    await rename(tmp, path);
  }

  async append(userId: string, file: string, content: string, agentId?: string): Promise<void> {
    const dir = await this.ensureDir(userId, agentId);
    await appendFile(join(dir, file), content, "utf-8");
  }

  async list(userId: string, _pattern: string, agentId?: string): Promise<string[]> {
    const dir = await this.ensureDir(userId, agentId);
    try {
      const files = await readdir(dir);
      return files
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .sort();
    } catch {
      return [];
    }
  }

  async remove(userId: string, file: string, agentId?: string): Promise<void> {
    const dir = this.userDir(userId, agentId);
    const { unlink } = await import("node:fs/promises");
    try {
      await unlink(join(dir, file));
    } catch {
      // Skip files that can't be deleted
    }
  }

  /** Absolute path to a user's memory directory */
  getUserDir(userId: string, agentId?: string): string {
    return this.userDir(userId, agentId);
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
  private namespaceKey(userId: string, agentId?: string): string {
    return agentId ? `${userId}::agent::${agentId}` : userId;
  }

  private documentName(userId: string, agentId?: string): string {
    if (!agentId) return `memory-${userId}`;
    const userHash = createHash("sha256").update(userId).digest("hex").slice(0, 32);
    return `memory-agent-${userHash}-${sanitizeId(agentId)}`;
  }

  private loadCached(userId: string, agentId?: string): Promise<MemoryEntry> {
    const key = this.namespaceKey(userId, agentId);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const promise = this.loadFromPod(userId, agentId);
    this.cache.set(key, promise);
    return promise;
  }

  private async loadFromPod(userId: string, agentId?: string): Promise<MemoryEntry> {
    // Search for the most-recently-updated consolidated doc with a non-empty
    // value. This handles two failure modes from earlier engine versions:
    //   (1) zombie empty docs from prior race-condition migrations, and
    //   (2) accidental dupes from non-deterministic create paths.
    // We always prefer the freshest doc that actually has content; if every
    // hit is empty, we fall back to the freshest empty hit (still better than
    // re-creating).
    const result = await this.callPod("search_documents", {
      filters: { name: this.documentName(userId, agentId) },
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
    const migrated = agentId
      ? { doc: {}, docId: null }
      : await this.migrateOldDocs(userId);
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

  async read(userId: string, file: string, agentId?: string): Promise<string> {
    try {
      const { doc } = await this.loadCached(userId, agentId);
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

  async write(userId: string, file: string, content: string, agentId?: string): Promise<void> {
    try {
      const entry = await this.loadCached(userId, agentId);
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
      await this.flush(userId, agentId);
    } catch {
      // Non-fatal
    }
  }

  async append(userId: string, file: string, content: string, agentId?: string): Promise<void> {
    // Serialize concurrent appends per userId. read+write share a cached doc
    // that mutates synchronously, but the read→mutate→flush sequence isn't
    // atomic, so two concurrent appends would both read pre-mutation state
    // and the second write would overwrite the first. Queue them instead.
    const key = this.namespaceKey(userId, agentId);
    const previous = this.appendChain.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {}) // existing append swallowed errors; preserve that
      .then(async () => {
        const existing = await this.read(userId, file, agentId);
        await this.write(userId, file, existing ? `${existing}\n${content}` : content, agentId);
      });
    this.appendChain.set(key, next);
    try {
      await next;
    } finally {
      // Drop the entry once we're the tail of the chain so the map doesn't grow.
      if (this.appendChain.get(key) === next) {
        this.appendChain.delete(key);
      }
    }
  }

  async list(userId: string, _pattern: string, agentId?: string): Promise<string[]> {
    try {
      const { doc } = await this.loadCached(userId, agentId);
      if (doc.today && doc.today_date) {
        return [`${doc.today_date}.md`];
      }
      return [];
    } catch {
      return [];
    }
  }

  async remove(userId: string, file: string, agentId?: string): Promise<void> {
    try {
      const entry = await this.loadCached(userId, agentId);
      const { field } = fileToField(file);

      if (field === "today") {
        entry.doc.today = "";
        entry.doc.today_date = "";
      } else {
        entry.doc[field] = "";
      }

      entry.dirty = true;
      await this.flush(userId, agentId);
    } catch {
      // Non-fatal
    }
  }

  /** Write cached doc back to pod if dirty. */
  async flush(userId: string, agentId?: string): Promise<void> {
    const cachedPromise = this.cache.get(this.namespaceKey(userId, agentId));
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
          name: this.documentName(userId, agentId),
          content: { value: entry.doc },
          metadata: {
            type: "user-memory",
            user_id: userId,
            ...(agentId ? { agent_id: agentId } : {}),
          },
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
//   - One Hindsight *bank* per user/agent scope. The bank ID contains a SHA-256
//     digest of both IDs so arbitrary IDs cannot collide after sanitization.
//   - Each logical memory file → exactly one memory addressed by a stable
//     `document_id` (the field/slot key from fileToField), tagged with its source
//     surface. Exact reads use the document endpoint's `original_text`; semantic
//     recall is intentionally reserved for the explicit recall() capability.
//   - read()   → GET the exact document.
//   - write()  → retain a single item with update_mode="replace" (upsert).
//   - append() → retain with update_mode="append", serialized by Hindsight per
//     document across clients and processes.
//   - appendThread() → append a JSON-array fragment. Hindsight atomically merges
//     JSON arrays, while existing file and pod thread formats remain unchanged.
//
// Writes remain best-effort. Reads distinguish a real 404 from transport/server
// failure so a failed read can never be mistaken for an empty document and then
// destructively replaced by a read-modify-write operation.

export interface HindsightConfig {
  /** Base URL of the Hindsight instance, e.g. http://localhost:8888 */
  baseUrl: string;
  /** Bank id prefix; bank = `${bankPrefix}-${sha256(user/agent scope)}`. */
  bankPrefix: string;
  /** Optional bearer token; omit for local/Ollama instances that need no auth. */
  apiKey?: string;
  /** Bank retain extraction mode. */
  extractionMode: string;
  /** Recall/reflect compute budget. */
  recallBudget: "low" | "mid" | "high";
  /** Max tokens returned by semantic recall/reflect. */
  recallMaxTokens: number;
  /** Per-request timeout (ms). */
  timeoutMs: number;
  /** Optional thread/session id, stored in memory metadata for provenance. */
  threadId?: string;
  /** Injectable fetch implementation (tests). Defaults to the global fetch. */
  fetchImpl?: typeof globalThis.fetch;
  /** Log transport failures to stderr. */
  verbose?: boolean;
  /** Abort Hindsight requests when the owning engine turn is cancelled. */
  abortSignal?: AbortSignal;
}

const HINDSIGHT_EXTRACTION_MODES = ["concise", "verbose", "custom", "verbatim", "chunks"] as const;

function normalizeHindsightBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid HINDSIGHT_BASE_URL=${value}. Expected an absolute http(s) URL.`);
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(
      `Invalid HINDSIGHT_BASE_URL=${value}. Use an http(s) URL without credentials, query, or fragment.`
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function parsePositiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`Invalid ${name}=${value}. Expected a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid ${name}=${value}. Expected a positive safe integer.`);
  }
  return parsed;
}

function validateHindsightConfig(config: HindsightConfig): HindsightConfig {
  const bankPrefix = config.bankPrefix.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(bankPrefix)) {
    throw new Error(
      `Invalid HINDSIGHT_BANK_PREFIX=${config.bankPrefix}. Use 1-64 letters, numbers, underscores, or hyphens.`
    );
  }
  if (
    !HINDSIGHT_EXTRACTION_MODES.includes(
      config.extractionMode as (typeof HINDSIGHT_EXTRACTION_MODES)[number]
    )
  ) {
    throw new Error(
      `Invalid HINDSIGHT_RETAIN_EXTRACTION_MODE=${config.extractionMode}. Expected ${HINDSIGHT_EXTRACTION_MODES.join(", ")}.`
    );
  }
  if (!["low", "mid", "high"].includes(config.recallBudget)) {
    throw new Error(`Invalid HINDSIGHT_RECALL_BUDGET=${config.recallBudget}. Expected low, mid, or high.`);
  }
  if (!Number.isSafeInteger(config.recallMaxTokens) || config.recallMaxTokens <= 0) {
    throw new Error("HINDSIGHT_RECALL_MAX_TOKENS must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0) {
    throw new Error("HINDSIGHT_REQUEST_TIMEOUT_MS must be a positive safe integer.");
  }
  return {
    ...config,
    baseUrl: normalizeHindsightBaseUrl(config.baseUrl),
    bankPrefix,
  };
}

export class HindsightMemoryStorage implements MemoryStorage {
  private readonly baseUrl: string;
  private readonly bankPrefix: string;
  private readonly apiKey?: string;
  private readonly extractionMode: string;
  private readonly recallBudget: string;
  private readonly recallMaxTokens: number;
  private readonly timeoutMs: number;
  private readonly threadId?: string;
  private readonly verbose: boolean;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly abortSignal?: AbortSignal;
  /** Fail fast for the rest of this turn after a transport/server failure. */
  private unavailable = false;

  /** Banks confirmed-created this process (avoids re-issuing create on every write). */
  private banksEnsured = new Set<string>();

  /** In-flight bank creation requests, shared by concurrent first writes. */
  private banksEnsuring = new Map<string, Promise<boolean>>();

  /** Scopes with an indeterminate exact read cannot safely replace documents. */
  private failedReadScopes = new Set<string>();

  constructor(config: HindsightConfig) {
    const validated = validateHindsightConfig(config);
    this.baseUrl = validated.baseUrl;
    this.bankPrefix = validated.bankPrefix;
    this.apiKey = validated.apiKey;
    this.extractionMode = validated.extractionMode;
    this.recallBudget = validated.recallBudget;
    this.recallMaxTokens = validated.recallMaxTokens;
    this.timeoutMs = validated.timeoutMs;
    this.threadId = validated.threadId;
    this.verbose = validated.verbose ?? false;
    this.fetchImpl = validated.fetchImpl ?? globalThis.fetch;
    this.abortSignal = validated.abortSignal;
  }

  private scopeHash(userId: string, agentId?: string): string {
    return createHash("sha256")
      .update(JSON.stringify([userId, agentId ?? null]))
      .digest("hex");
  }

  private bankId(userId: string, agentId?: string): string {
    return `${this.bankPrefix}-${this.scopeHash(userId, agentId)}`;
  }

  private bankPath(userId: string, agentId?: string, suffix = ""): string {
    return `/v1/default/banks/${encodeURIComponent(this.bankId(userId, agentId))}${suffix}`;
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
  private tagsFor(userId: string, surface: string, date?: string, agentId?: string): string[] {
    const tags = ["sportsclaw", `scope:${this.scopeHash(userId, agentId)}`, `surface:${surface}`];
    if (date) tags.push(`date:${date}`);
    return tags;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ ok: boolean; status?: number; data?: any }> {
    if (this.unavailable) return { ok: false };
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;
    try {
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const signal = this.abortSignal
        ? AbortSignal.any([this.abortSignal, timeoutSignal])
        : timeoutSignal;
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        if (res.status !== 404) this.unavailable = true;
        if (this.verbose) {
          console.error(`[sportsclaw] hindsight ${method} ${path} -> HTTP ${res.status}`);
        }
        return { ok: false, status: res.status };
      }
      const text = await res.text();
      if (!text) return { ok: true, status: res.status };
      try {
        return { ok: true, status: res.status, data: JSON.parse(text) };
      } catch {
        return { ok: true, status: res.status };
      }
    } catch (err: unknown) {
      this.unavailable = true;
      if (this.verbose) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[sportsclaw] hindsight ${method} ${path} failed: ${msg}`);
      }
      return { ok: false };
    }
  }

  /**
   * Create-or-update the per-scope bank with the configured extraction. Best-effort and
   * cached: once issued for a bank this process, we don't repeat it.
   */
  private async ensureBank(userId: string, agentId?: string): Promise<boolean> {
    const bank = this.bankId(userId, agentId);
    if (this.banksEnsured.has(bank)) return true;
    const inFlight = this.banksEnsuring.get(bank);
    if (inFlight) return inFlight;

    const promise = (async () => {
      const result = await this.request("PUT", this.bankPath(userId, agentId), {
        retain_extraction_mode: this.extractionMode,
      });
      const succeeded = result.ok && result.data?.bank_id === bank;
      if (succeeded) this.banksEnsured.add(bank);
      return succeeded;
    })();
    this.banksEnsuring.set(bank, promise);
    try {
      return await promise;
    } finally {
      this.banksEnsuring.delete(bank);
    }
  }

  async read(userId: string, file: string, agentId?: string): Promise<string> {
    const { slot } = this.slotFor(file);
    const result = await this.request(
      "GET",
      this.bankPath(userId, agentId, `/documents/${encodeURIComponent(slot)}`)
    );
    if (result.status === 404) return "";
    if (!result.ok || typeof result.data?.original_text !== "string") {
      this.failedReadScopes.add(this.scopeHash(userId, agentId));
      throw new Error(`Hindsight failed to read ${file}`);
    }
    return result.data.original_text ?? "";
  }

  async write(userId: string, file: string, content: string, agentId?: string): Promise<void> {
    if (this.failedReadScopes.has(this.scopeHash(userId, agentId))) {
      throw new Error("Hindsight replacement blocked after a failed read for this memory scope");
    }
    if (!content) {
      await this.remove(userId, file, agentId);
      return;
    }
    if (!(await this.ensureBank(userId, agentId))) {
      throw new Error("Hindsight failed to create or update the memory bank");
    }
    const { slot, surface, date } = this.slotFor(file);
    const tags = this.tagsFor(userId, surface, date, agentId);
    const result = await this.request("POST", this.bankPath(userId, agentId, "/memories"), {
      items: [
        {
          content,
          document_id: slot,
          tags,
          metadata: {
            userId,
            ...(agentId ? { agentId } : {}),
            ...(this.threadId ? { threadId: this.threadId } : {}),
            surface,
            file,
          },
          update_mode: "replace",
        },
      ],
      async: false,
    });
    if (!result.ok || result.data?.success !== true) {
      throw new Error(`Hindsight failed to write ${file}`);
    }
  }

  async append(userId: string, file: string, content: string, agentId?: string): Promise<void> {
    if (!content) return;
    await this.retain(userId, file, content, "append", agentId);
  }

  async appendThread(
    userId: string,
    messages: ThreadMessage[],
    agentId?: string
  ): Promise<void> {
    if (messages.length === 0) return;
    await this.retain(userId, THREAD_FILE, JSON.stringify(messages), "append", agentId);
  }

  private async retain(
    userId: string,
    file: string,
    content: string,
    updateMode: "replace" | "append",
    agentId?: string
  ): Promise<void> {
    if (!(await this.ensureBank(userId, agentId))) {
      throw new Error("Hindsight failed to create or update the memory bank");
    }
    const { slot, surface, date } = this.slotFor(file);
    const result = await this.request("POST", this.bankPath(userId, agentId, "/memories"), {
      items: [
        {
          content,
          document_id: slot,
          tags: this.tagsFor(userId, surface, date, agentId),
          metadata: {
            userId,
            ...(agentId ? { agentId } : {}),
            ...(this.threadId ? { threadId: this.threadId } : {}),
            surface,
            file,
          },
          update_mode: updateMode,
        },
      ],
      async: false,
    });
    if (!result.ok || result.data?.success !== true) {
      throw new Error(`Hindsight failed to ${updateMode} ${file}`);
    }
  }

  async list(userId: string, _pattern: string, agentId?: string): Promise<string[]> {
    // Mirror PodMemoryStorage: surface only today's daily log. Hindsight performs
    // its own long-horizon consolidation, so SportsClaw-side consolidateOldLogs
    // is inert here (as it already is for the pod backend).
    try {
      const today = todayStamp();
      const content = await this.read(userId, `${today}.md`, agentId);
      return content ? [`${today}.md`] : [];
    } catch {
      return [];
    }
  }

  async remove(userId: string, file: string, agentId?: string): Promise<void> {
    if (this.failedReadScopes.has(this.scopeHash(userId, agentId))) {
      throw new Error("Hindsight removal blocked after a failed read for this memory scope");
    }
    const { slot } = this.slotFor(file);
    const result = await this.request(
      "DELETE",
      this.bankPath(userId, agentId, `/documents/${encodeURIComponent(slot)}`)
    );
    if (result.status === 404) return;
    if (!result.ok || result.data?.success !== true) {
      throw new Error(`Hindsight failed to remove ${file}`);
    }
  }

  // -------------------------------------------------------------------------
  // Extra capabilities (not part of MemoryStorage) — Hindsight's semantic
  // pipelines, exposed for downstream/manual use and covered by tests.
  // -------------------------------------------------------------------------

  /** Free-form semantic recall across a user's bank (semantic + keyword + graph + temporal). */
  async recall(
    userId: string,
    query: string,
    opts: SemanticRecallOptions = {}
  ): Promise<SemanticMemoryResult[]> {
    try {
      const res = await this.request("POST", this.bankPath(userId, opts.agentId, "/memories/recall"), {
        query,
        ...(opts.tags ? { tags: opts.tags, tags_match: "any" } : {}),
        budget: opts.budget ?? this.recallBudget,
        max_tokens: opts.maxTokens ?? this.recallMaxTokens,
      });
      return res.ok && Array.isArray(res.data?.results) ? res.data.results : [];
    } catch {
      return [];
    }
  }

  /** Reflect over a user's memories to synthesize an insight (Hindsight reflect pipeline). */
  async reflect(
    userId: string,
    query: string,
    opts: { budget?: string; maxTokens?: number; agentId?: string } = {}
  ): Promise<string> {
    try {
      const res = await this.request("POST", this.bankPath(userId, opts.agentId, "/reflect"), {
        query,
        budget: opts.budget ?? this.recallBudget,
        max_tokens: opts.maxTokens ?? this.recallMaxTokens,
      });
      return res.ok && typeof res.data?.text === "string" ? res.data.text : "";
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
  const budget = (process.env.HINDSIGHT_RECALL_BUDGET ?? "mid").trim().toLowerCase();
  return validateHindsightConfig({
    baseUrl: process.env.HINDSIGHT_BASE_URL || "http://localhost:8888",
    bankPrefix: process.env.HINDSIGHT_BANK_PREFIX || "sportsclaw",
    apiKey: process.env.HINDSIGHT_API_KEY || undefined,
    extractionMode: process.env.HINDSIGHT_RETAIN_EXTRACTION_MODE || "verbatim",
    recallBudget: budget as "low" | "mid" | "high",
    recallMaxTokens: parsePositiveInteger(
      "HINDSIGHT_RECALL_MAX_TOKENS",
      process.env.HINDSIGHT_RECALL_MAX_TOKENS,
      32_768
    ),
    timeoutMs: parsePositiveInteger(
      "HINDSIGHT_REQUEST_TIMEOUT_MS",
      process.env.HINDSIGHT_REQUEST_TIMEOUT_MS,
      30_000
    ),
    ...overrides,
  });
}

export interface CreateMemoryStorageOptions {
  /** Required for pod/auto selection (to discover a Machina MCP server). */
  mcpManager?: McpManager;
  /** Optional thread/session id (stored as Hindsight memory metadata). */
  threadId?: string;
  verbose?: boolean;
  abortSignal?: AbortSignal;
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
  const allowed =
    usingLegacyVar || rawProvider === undefined
      ? ["auto", "file", "pod"]
      : ["file", "pod", "hindsight"];

  if (!allowed.includes(requested)) {
    const varName = usingLegacyVar ? "SPORTSCLAW_MEMORY_BACKEND" : "SPORTSCLAW_MEMORY_PROVIDER";
    const raw = rawProvider ?? rawBackend;
    const expected = usingLegacyVar ? '"auto", "file", or "pod"' : '"file", "pod", or "hindsight"';
    throw new Error(`Invalid ${varName}=${raw}. Expected ${expected}.`);
  }

  if (requested === "hindsight") {
    const cfg = hindsightConfigFromEnv({
      threadId: opts.threadId,
      verbose: opts.verbose,
      abortSignal: opts.abortSignal,
    });
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
  private agentId?: string;

  constructor(userId: string, storage?: MemoryStorage, agentId?: string) {
    this.userId = userId;
    this.storage = storage ?? new FileMemoryStorage(MEMORY_BASE);
    this.agentId = agentId;
  }

  /** Absolute path to the user's memory directory (only meaningful for file storage) */
  get memoryDir(): string {
    if (this.storage instanceof FileMemoryStorage) {
      return this.storage.getUserDir(this.userId, this.agentId);
    }
    const userDir = join(MEMORY_BASE, sanitizeId(this.userId));
    return this.agentId ? join(userDir, "agents", sanitizeId(this.agentId)) : userDir;
  }

  // -------------------------------------------------------------------------
  // HOT layer — CONTEXT.md
  // -------------------------------------------------------------------------

  async readContext(): Promise<string> {
    return this.storage.read(this.userId, CONTEXT_FILE, this.agentId);
  }

  async writeContext(content: string): Promise<void> {
    await this.storage.write(this.userId, CONTEXT_FILE, content, this.agentId);
  }

  // -------------------------------------------------------------------------
  // WARM layer — <date>.md
  // -------------------------------------------------------------------------

  async readTodayLog(): Promise<string> {
    return this.storage.read(this.userId, `${todayStamp()}.md`, this.agentId);
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

    await this.storage.append(this.userId, `${todayStamp()}.md`, entry, this.agentId);
  }

  async appendNote(label: string, content: string): Promise<void> {
    const ts = timestamp();
    const entry = [`> **${label}** (${ts}): ${content}`, ""].join("\n");
    await this.storage.append(this.userId, `${todayStamp()}.md`, entry, this.agentId);
  }

  // -------------------------------------------------------------------------
  // WARM layer — SOUL.md (agent personality & relationship)
  // -------------------------------------------------------------------------

  async readSoul(): Promise<string> {
    return this.storage.read(this.userId, SOUL_FILE, this.agentId);
  }

  async writeSoul(content: string): Promise<void> {
    await this.storage.write(this.userId, SOUL_FILE, content, this.agentId);
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
    const increment = (raw: string): string => {
      const data = this.parseSoulHeader(raw);
      data.exchanges++;
      const header = `# Soul\nBorn: ${data.born}\nExchanges: ${data.exchanges}\n`;
      return data.rest ? `${header}\n${data.rest}\n` : header;
    };
    // This legacy counter is not used as an authoritative turn count. Backends
    // without an atomic mutate primitive may lose concurrent increments.
    await this.storage.write(this.userId, SOUL_FILE, increment(await this.readSoul()), this.agentId);
  }

  // -------------------------------------------------------------------------
  // WARM layer — FAN_PROFILE.md
  // -------------------------------------------------------------------------

  async readFanProfile(): Promise<string> {
    return this.storage.read(this.userId, FAN_PROFILE_FILE, this.agentId);
  }

  async writeFanProfile(content: string): Promise<void> {
    await this.storage.write(this.userId, FAN_PROFILE_FILE, content, this.agentId);
  }

  // -------------------------------------------------------------------------
  // WARM layer — REFLECTIONS.md (append-only lessons learned)
  // -------------------------------------------------------------------------

  async readReflections(): Promise<string> {
    return this.storage.read(this.userId, REFLECTIONS_FILE, this.agentId);
  }

  async appendReflection(entry: string): Promise<void> {
    await this.storage.append(this.userId, REFLECTIONS_FILE, entry + "\n", this.agentId);
  }

  // -------------------------------------------------------------------------
  // WARM layer — STRATEGY.md (self-authored behavioral directives)
  // -------------------------------------------------------------------------

  async readStrategy(): Promise<string> {
    return this.storage.read(this.userId, STRATEGY_FILE, this.agentId);
  }

  async writeStrategy(content: string): Promise<void> {
    await this.storage.write(this.userId, STRATEGY_FILE, content, this.agentId);
  }

  // -------------------------------------------------------------------------
  // Thread persistence — conversation history across process restarts
  // -------------------------------------------------------------------------

  async readThread(): Promise<ThreadMessage[]> {
    const raw = await this.storage.read(this.userId, THREAD_FILE, this.agentId);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.slice(-MAX_THREAD_MESSAGES) : [];
    } catch {
      return [];
    }
  }

  async writeThread(messages: ThreadMessage[]): Promise<void> {
    const capped = messages.slice(-MAX_THREAD_MESSAGES);
    await this.storage.write(this.userId, THREAD_FILE, JSON.stringify(capped), this.agentId);
  }

  async appendToThread(userPrompt: string, assistantReply: string): Promise<void> {
    const ts = new Date().toISOString();
    const messages: ThreadMessage[] = [
      { role: "user", content: userPrompt, ts },
      { role: "assistant", content: assistantReply, ts },
    ];
    if (this.storage.appendThread) {
      await this.storage.appendThread(this.userId, messages, this.agentId);
      return;
    }
    const appendMessages = (raw: string): string => {
      let thread: ThreadMessage[] = [];
      if (raw) {
        try {
          thread = JSON.parse(raw);
        } catch {
          thread = [];
        }
      }
      thread.push(...messages);
      return JSON.stringify(thread.slice(-MAX_THREAD_MESSAGES));
    };
    await this.storage.write(
      this.userId,
      THREAD_FILE,
      appendMessages(await this.storage.read(this.userId, THREAD_FILE, this.agentId)),
      this.agentId
    );
  }

  /**
   * Retrieve bounded, non-authoritative semantic context when the backend
   * supports it. Structured memory files are still loaded through exact reads.
   */
  async recallContext(query: string): Promise<string> {
    if (!this.storage.recall || !query.trim()) return "";
    const results = await this.storage.recall(this.userId, query, {
      agentId: this.agentId,
      maxTokens: SEMANTIC_RECALL_MAX_TOKENS,
    });
    const unique = new Set<string>();
    const parts: string[] = [];
    let chars = 0;
    for (const result of results.slice(0, MAX_SEMANTIC_RECALL_RESULTS)) {
      const text = typeof result?.text === "string" ? result.text.trim() : "";
      if (!text || unique.has(text) || chars >= MAX_SEMANTIC_RECALL_CHARS) continue;
      unique.add(text);
      const remaining = MAX_SEMANTIC_RECALL_CHARS - chars;
      const bounded = text.slice(0, remaining);
      parts.push(bounded);
      chars += bounded.length;
    }
    return parts.join("\n\n---\n\n").slice(0, MAX_SEMANTIC_RECALL_CHARS);
  }

  // -------------------------------------------------------------------------
  // CONSOLIDATED.md — compressed knowledge from old daily logs
  // -------------------------------------------------------------------------

  async readConsolidated(): Promise<string> {
    return this.storage.read(this.userId, CONSOLIDATED_FILE, this.agentId);
  }

  async writeConsolidated(content: string): Promise<void> {
    await this.storage.write(this.userId, CONSOLIDATED_FILE, content, this.agentId);
  }

  async listDailyLogs(): Promise<string[]> {
    return this.storage.list(this.userId, "daily-log", this.agentId);
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

      const content = await this.storage.read(this.userId, file, this.agentId);
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
      await this.storage.remove(this.userId, file, this.agentId);
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
