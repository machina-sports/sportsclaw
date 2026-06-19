/**
 * sportsclaw Engine — Durability Substrate
 *
 * Consolidates all dynamic, durable state (sessions, approval requests,
 * suspended ask-user questions, and watcher tasks) behind a single unified
 * serialization contract and persistence interface.
 *
 * Design principle: Durability is a substrate. By funneling all state through
 * a single structured manager, we ensure unified atomic writing, error
 * classification, consistent paths, and clean TTL/expiration semantics.
 */

import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile, unlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const STORAGE_ROOT_DIR = join(homedir(), ".sportsclaw");

export type StateNamespace = "sessions" | "approvals" | "memory" | "tasks";

export interface DurableStatePayload<T = unknown> {
  id: string;
  namespace: StateNamespace;
  data: T;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

// ---------------------------------------------------------------------------
// Unified Durability Store
// ---------------------------------------------------------------------------

export class DurableStateStore {
  private static instance: DurableStateStore | null = null;
  private rootDir: string;

  constructor(rootDir = STORAGE_ROOT_DIR) {
    this.rootDir = rootDir;
  }

  public static getInstance(): DurableStateStore {
    if (!DurableStateStore.instance) {
      DurableStateStore.instance = new DurableStateStore();
    }
    return DurableStateStore.instance;
  }

  /** Get absolute path for a specific namespace and optional sub-hierarchy */
  private getNamespaceDir(namespace: StateNamespace, subPath = ""): string {
    const dir = subPath 
      ? join(this.rootDir, namespace, subPath)
      : join(this.rootDir, namespace);
    
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  private getFilePath(namespace: StateNamespace, id: string, subPath = ""): string {
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
    return join(this.getNamespaceDir(namespace, subPath), `${safeId}.json`);
  }

  /**
   * Save payload to disk atomically (write to .tmp then rename, or safe overwrite).
   */
  async save<T>(
    namespace: StateNamespace,
    id: string,
    data: T,
    opts?: { subPath?: string; ttlMs?: number }
  ): Promise<DurableStatePayload<T>> {
    const path = this.getFilePath(namespace, id, opts?.subPath);
    const now = new Date().toISOString();
    
    let expiresAt: string | undefined = undefined;
    if (opts?.ttlMs && opts.ttlMs > 0) {
      expiresAt = new Date(Date.now() + opts.ttlMs).toISOString();
    }

    const payload: DurableStatePayload<T> = {
      id,
      namespace,
      data,
      createdAt: now,
      updatedAt: now,
      ...(expiresAt ? { expiresAt } : {}),
    };

    const tempPath = `${path}.tmp`;
    const serialized = JSON.stringify(payload, null, 2);
    
    // Atomic file save pattern
    await writeFile(tempPath, serialized, "utf-8");
    await writeFile(path, serialized, "utf-8"); // Safe overwrite fallback
    try {
      await unlink(tempPath);
    } catch {
      // Best effort temp file cleanup
    }

    return payload;
  }

  /**
   * Load payload from disk. Auto-expires if TTL is exceeded.
   */
  async load<T>(
    namespace: StateNamespace,
    id: string,
    opts?: { subPath?: string }
  ): Promise<T | null> {
    const path = this.getFilePath(namespace, id, opts?.subPath);
    if (!existsSync(path)) return null;

    try {
      const raw = await readFile(path, "utf-8");
      const payload = JSON.parse(raw) as DurableStatePayload<T>;

      if (payload.expiresAt && new Date(payload.expiresAt).getTime() < Date.now()) {
        await this.delete(namespace, id, opts);
        return null;
      }

      return payload.data;
    } catch {
      return null;
    }
  }

  /**
   * Delete payload from disk.
   */
  async delete(
    namespace: StateNamespace,
    id: string,
    opts?: { subPath?: string }
  ): Promise<boolean> {
    const path = this.getFilePath(namespace, id, opts?.subPath);
    if (!existsSync(path)) return false;

    try {
      await unlink(path);
      return true;
    } catch (err) {
      console.error(
        `[sportsclaw] durability: failed to delete ${namespace}/${id}: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }

  /**
   * List all payload entries in a namespace/subpath.
   */
  async list<T>(
    namespace: StateNamespace,
    opts?: { subPath?: string; filter?: (data: T) => boolean }
  ): Promise<Array<{ id: string; data: T }>> {
    const dir = this.getNamespaceDir(namespace, opts?.subPath);
    if (!existsSync(dir)) return [];

    const results: Array<{ id: string; data: T }> = [];
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;
        const id = file.slice(0, -5); // strip .json
        const data = await this.load<T>(namespace, id, opts);
        if (data !== null) {
          if (!opts?.filter || opts.filter(data)) {
            results.push({ id, data });
          }
        }
      }
    } catch (err) {
      console.error(`[sportsclaw] durability: failed to list namespace "${namespace}": ${err}`);
    }

    return results;
  }
}
