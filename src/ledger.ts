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
