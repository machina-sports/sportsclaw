/**
 * Ledger Storage Abstraction
 *
 * Generic interface and file-backed implementation for append-only JSONL ledgers.
 * Data-only utilities — no engine wiring or behavior.
 */

import fs from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// LedgerStorage interface
// ---------------------------------------------------------------------------

export interface LedgerStorage<T> {
  append(record: T): Promise<void>;
  readAll(): Promise<T[]>;
  readLatest(limit: number): Promise<T[]>;
}

// ---------------------------------------------------------------------------
// FileLedgerStorage
// ---------------------------------------------------------------------------

export class FileLedgerStorage<T> implements LedgerStorage<T> {
  constructor(
    protected readonly filePath: string,
    protected readonly parse: (line: string) => T,
    protected readonly serialize: (record: T) => string,
  ) {}

  async append(record: T): Promise<void> {
    // Serialize first — this will throw if the record is invalid
    // (subclasses override serialize to include validation).
    const line = this.serialize(record);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, line, "utf-8");
  }

  async readAll(): Promise<T[]> {
    let content: string;
    try {
      content = await fs.readFile(this.filePath, "utf-8");
    } catch (err: any) {
      if (err.code === "ENOENT") return [];
      throw err;
    }

    return content
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map(this.parse);
  }

  async readLatest(limit: number): Promise<T[]> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("Limit must be a positive integer.");
    }

    const all = await this.readAll();
    return all.slice(-limit);
  }
}

// ---------------------------------------------------------------------------
// PodLedgerStorage
// ---------------------------------------------------------------------------

import type { McpManager } from "./mcp.js";

export class PodLedgerStorage<T> implements LedgerStorage<T> {
  // A cache for the document ID so we don't have to search every time we append.
  private docId: string | null = null;
  private inFlightSync: Promise<void> | null = null;

  constructor(
    private readonly mcpManager: McpManager,
    private readonly serverName: string,
    private readonly ledgerName: string,
    private readonly parse: (line: string) => T,
    private readonly serialize: (record: T) => string
  ) {}

  private async callPod(toolName: string, args: Record<string, unknown>): Promise<any> {
    const result = await this.mcpManager.callToolDirect(this.serverName, toolName, args);
    if (result.isError) return {};
    try {
      return JSON.parse(result.content || "{}");
    } catch {
      return {};
    }
  }

  private async loadDoc(): Promise<{ id: string | null; records: T[] }> {
    const res = await this.callPod("search_documents", {
      filters: { name: this.ledgerName },
      fields: ["_id", "value"],
      page_size: 1,
    });
    const hit = res?.data?.data?.[0];
    if (!hit) {
      return { id: null, records: [] };
    }
    const rawArray = hit?.value?.records || [];
    // Convert back from strings if they were serialized
    const records = (Array.isArray(rawArray) ? rawArray : []).map((r: any) => {
      if (typeof r === "string") return this.parse(r);
      return r as T;
    });
    return { id: hit._id, records };
  }

  async append(record: T): Promise<void> {
    // Wait for any existing sync to finish
    while (this.inFlightSync) await this.inFlightSync;

    this.inFlightSync = (async () => {
      const { id, records } = await this.loadDoc();
      const serialized = this.serialize(record).trim();
      records.push(this.parse(serialized));

      const rawRecords = records.map(r => this.serialize(r).trim());

      if (id) {
        await this.callPod("update_document", {
          item_id: id,
          content: { value: { records: rawRecords } },
        });
        this.docId = id;
      } else {
        const createRes = await this.callPod("create_document", {
          name: this.ledgerName,
          content: { value: { records: rawRecords } },
          metadata: { type: "ledger", ledger_name: this.ledgerName },
        });
        this.docId = createRes?.data?.data?._id || null;
      }
    })();
    
    try {
      await this.inFlightSync;
    } finally {
      this.inFlightSync = null;
    }
  }

  async readAll(): Promise<T[]> {
    const { records } = await this.loadDoc();
    return records;
  }

  async readLatest(limit: number): Promise<T[]> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("Limit must be a positive integer.");
    }
    const all = await this.readAll();
    return all.slice(-limit);
  }
}
