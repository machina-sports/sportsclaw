/**
 * Decision Ledger Primitives
 *
 * Append-only JSONL ledger for recording structured decision records.
 * Data-only utilities — no engine wiring or behavior.
 */

import type { DecisionRecord, ValidationResult } from "./schema/tv.js";
import { FileLedgerStorage } from "./ledger.js";

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
  const result = validateDecisionRecord(record);
  if (!result.ok) {
    throw new Error(`Invalid decision record: ${result.error}`);
  }
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
// FileDecisionLedger
// ---------------------------------------------------------------------------

export class FileDecisionLedger extends FileLedgerStorage<DecisionRecord> {
  constructor(filePath: string) {
    super(filePath, parseDecisionRecordLine, serializeDecisionRecord);
  }
}

// ---------------------------------------------------------------------------
// Standalone helpers (delegate to a temporary instance)
// ---------------------------------------------------------------------------

export async function appendDecisionRecord(
  filePath: string,
  record: DecisionRecord,
): Promise<void> {
  return new FileDecisionLedger(filePath).append(record);
}

export async function readDecisionLedger(
  filePath: string,
): Promise<DecisionRecord[]> {
  return new FileDecisionLedger(filePath).readAll();
}

export async function readLatestDecisionRecords(
  filePath: string,
  limit: number,
): Promise<DecisionRecord[]> {
  return new FileDecisionLedger(filePath).readLatest(limit);
}
