/**
 * sportsclaw — Swarm Storage: Local Filesystem Backend
 *
 * Implements ISwarmStorage by writing JSON documents to:
 *   ~/.sportsclaw/swarm/<namespace>/<id>.json
 *
 * Each namespace is a directory. Each document is a single JSON file.
 * TTL expiry is checked lazily on read and eagerly via purgeExpired().
 *
 * This backend is designed for single-node / development use. Production
 * deployments should swap in a cloud-backed implementation that maps to
 * Machina Core pod documents.
 */

import { existsSync, mkdirSync } from "node:fs";
import { readdir, readFile, writeFile, unlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  ISwarmStorage,
  SwarmDocument,
  SwarmQueryOptions,
} from "./interfaces.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_ROOT = join(homedir(), ".sportsclaw", "swarm");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function isExpired(doc: SwarmDocument): boolean {
  if (doc.ttlMs == null) return false;
  const expiresAt = new Date(doc.createdAt).getTime() + doc.ttlMs;
  return Date.now() > expiresAt;
}

function matchesLabels(
  doc: SwarmDocument,
  labels: Record<string, string>,
): boolean {
  for (const [key, value] of Object.entries(labels)) {
    if (doc.labels[key] !== value) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// LocalFileStorageBackend
// ---------------------------------------------------------------------------

export class LocalFileStorageBackend implements ISwarmStorage {
  private readonly root: string;

  constructor(root?: string) {
    this.root = root ?? DEFAULT_ROOT;
    ensureDir(this.root);
  }

  // -------------------------------------------------------------------------
  // Path resolution
  // -------------------------------------------------------------------------

  private nsDir(namespace: string): string {
    return join(this.root, namespace);
  }

  private docPath(namespace: string, id: string): string {
    return join(this.nsDir(namespace), `${id}.json`);
  }

  // -------------------------------------------------------------------------
  // ISwarmStorage — put
  // -------------------------------------------------------------------------

  async put<T>(
    namespace: string,
    id: string,
    data: T,
    options?: { ttlMs?: number; labels?: Record<string, string> },
  ): Promise<SwarmDocument<T>> {
    ensureDir(this.nsDir(namespace));

    const now = new Date().toISOString();
    const existing = await this.readRaw<T>(namespace, id);

    const doc: SwarmDocument<T> = {
      id,
      namespace,
      data,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ttlMs: options?.ttlMs ?? null,
      labels: options?.labels ?? existing?.labels ?? {},
    };

    await writeFile(
      this.docPath(namespace, id),
      JSON.stringify(doc, null, 2),
      "utf-8",
    );

    return doc;
  }

  // -------------------------------------------------------------------------
  // ISwarmStorage — get
  // -------------------------------------------------------------------------

  async get<T = unknown>(
    namespace: string,
    id: string,
  ): Promise<SwarmDocument<T> | null> {
    const doc = await this.readRaw<T>(namespace, id);
    if (!doc) return null;

    // Lazy TTL expiry
    if (isExpired(doc)) {
      await this.delete(namespace, id);
      return null;
    }

    return doc;
  }

  // -------------------------------------------------------------------------
  // ISwarmStorage — delete
  // -------------------------------------------------------------------------

  async delete(namespace: string, id: string): Promise<boolean> {
    const path = this.docPath(namespace, id);
    if (!existsSync(path)) return false;

    try {
      await unlink(path);
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // ISwarmStorage — list
  // -------------------------------------------------------------------------

  async list<T = unknown>(
    namespace: string,
    options?: SwarmQueryOptions,
  ): Promise<SwarmDocument<T>[]> {
    const dir = this.nsDir(namespace);
    if (!existsSync(dir)) return [];

    const files = await readdir(dir);
    const docs: SwarmDocument<T>[] = [];
    const expiredIds: string[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      try {
        const raw = await readFile(join(dir, file), "utf-8");
        const doc = JSON.parse(raw) as SwarmDocument<T>;

        if (isExpired(doc)) {
          expiredIds.push(doc.id);
          continue;
        }

        if (options?.labels && !matchesLabels(doc, options.labels)) continue;

        docs.push(doc);
      } catch {
        // Skip malformed files
      }
    }

    // Clean up expired docs encountered during scan
    for (const id of expiredIds) {
      await this.delete(namespace, id).catch(() => {});
    }

    // Sort
    const sortDir = options?.sort ?? "desc";
    docs.sort((a, b) => {
      const ta = new Date(a.updatedAt).getTime();
      const tb = new Date(b.updatedAt).getTime();
      return sortDir === "desc" ? tb - ta : ta - tb;
    });

    // Limit
    if (options?.limit && options.limit > 0) {
      return docs.slice(0, options.limit);
    }

    return docs;
  }

  // -------------------------------------------------------------------------
  // ISwarmStorage — purgeExpired
  // -------------------------------------------------------------------------

  async purgeExpired(): Promise<number> {
    let purged = 0;

    if (!existsSync(this.root)) return 0;

    const namespaces = await readdir(this.root);

    for (const ns of namespaces) {
      const nsPath = join(this.root, ns);

      // Skip non-directories
      let files: string[];
      try {
        files = await readdir(nsPath);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith(".json")) continue;

        try {
          const raw = await readFile(join(nsPath, file), "utf-8");
          const doc = JSON.parse(raw) as SwarmDocument;

          if (isExpired(doc)) {
            await unlink(join(nsPath, file));
            purged++;
          }
        } catch {
          // Skip malformed
        }
      }

      // Remove empty namespace directories
      try {
        const remaining = await readdir(nsPath);
        if (remaining.length === 0) {
          await rm(nsPath, { recursive: true });
        }
      } catch {
        // Ignore
      }
    }

    return purged;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async readRaw<T>(
    namespace: string,
    id: string,
  ): Promise<SwarmDocument<T> | null> {
    const path = this.docPath(namespace, id);
    if (!existsSync(path)) return null;

    try {
      const raw = await readFile(path, "utf-8");
      return JSON.parse(raw) as SwarmDocument<T>;
    } catch {
      return null;
    }
  }
}
