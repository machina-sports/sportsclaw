/**
 * Decision Ledger Primitives
 *
 * Append-only JSONL ledger for recording structured decision records.
 * Data-only utilities — no engine wiring or behavior.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { DecisionRecord, ValidationResult } from "./schema/tv.js";

// ---------------------------------------------------------------------------
// validateDecisionRecord
// ---------------------------------------------------------------------------

const REQUIRED_STRING_FIELDS = ["id", "timestamp", "action", "reason"] as const;

export function validateDecisionRecord(record: unknown): ValidationResult {
  if (!record || typeof record !== "object") {
    return { ok: false, error: "Record must be a non-null object." };
  }

  const r = record as Record<string, unknown>;

  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof r[field] !== "string" || r[field] === "") {
      return { ok: false, error: `Record must have a non-empty ${field}.` };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// serializeDecisionRecord
// ---------------------------------------------------------------------------

export function serializeDecisionRecord(record: DecisionRecord): string {
  return JSON.stringify(record) + "\n";
}

// ---------------------------------------------------------------------------
// parseDecisionRecordLine
// ---------------------------------------------------------------------------

export function parseDecisionRecordLine(line: string): DecisionRecord {
  const trimmed = line.trim();
  if (trimmed === "") {
    throw new Error("Invalid JSON: empty line.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("Invalid JSON: could not parse line.");
  }
  const result = validateDecisionRecord(parsed);
  if (!result.ok) {
    throw new Error(`Invalid decision record: ${result.error}`);
  }
  return parsed as DecisionRecord;
}

// ---------------------------------------------------------------------------
// appendDecisionRecord
// ---------------------------------------------------------------------------

export async function appendDecisionRecord(
  filePath: string,
  record: DecisionRecord,
): Promise<void> {
  const result = validateDecisionRecord(record);
  if (!result.ok) {
    throw new Error(`Invalid decision record: ${result.error}`);
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, serializeDecisionRecord(record), "utf-8");
}

// ---------------------------------------------------------------------------
// readDecisionLedger
// ---------------------------------------------------------------------------

export async function readDecisionLedger(
  filePath: string,
): Promise<DecisionRecord[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  return content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(parseDecisionRecordLine);
}

// ---------------------------------------------------------------------------
// readLatestDecisionRecords
// ---------------------------------------------------------------------------

export async function readLatestDecisionRecords(
  filePath: string,
  limit: number,
): Promise<DecisionRecord[]> {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("Limit must be a positive integer.");
  }

  const all = await readDecisionLedger(filePath);
  return all.slice(-limit);
}
