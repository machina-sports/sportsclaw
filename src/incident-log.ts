/**
 * Incident Log Primitives
 *
 * Append-only JSONL ledger for recording structured operational incidents.
 * Data-only utilities — no engine wiring or behavior.
 */

import type { IncidentRecord, ValidationResult } from "./schema/tv.js";
import { FileLedgerStorage } from "./ledger.js";

// ---------------------------------------------------------------------------
// validateIncidentRecord
// ---------------------------------------------------------------------------

const REQUIRED_STRING_FIELDS = ["id", "timestamp", "message", "component"] as const;
const VALID_LEVELS = new Set(["warning", "error", "critical"]);

function isValidDateString(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

export function validateIncidentRecord(record: unknown): ValidationResult {
  if (!record || typeof record !== "object") {
    return { ok: false, error: "Record must be a non-null object." };
  }

  const r = record as Record<string, unknown>;

  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof r[field] !== "string" || r[field] === "") {
      return { ok: false, error: `Record must have a non-empty ${field}.` };
    }
  }

  if (!isValidDateString(r.timestamp as string)) {
    return { ok: false, error: "Record timestamp must be a valid date string." };
  }

  if (typeof r.level !== "string" || !VALID_LEVELS.has(r.level)) {
    return { ok: false, error: "Record level must be warning, error, or critical." };
  }

  if (r.resolvedAt !== undefined) {
    if (typeof r.resolvedAt !== "string" || r.resolvedAt === "") {
      return { ok: false, error: "Record resolvedAt must be a valid date string." };
    }
    if (!isValidDateString(r.resolvedAt)) {
      return { ok: false, error: "Record resolvedAt must be a valid date string." };
    }
    if (Date.parse(r.resolvedAt) < Date.parse(r.timestamp as string)) {
      return { ok: false, error: "Record resolvedAt must be greater than or equal to timestamp." };
    }
    if (typeof r.resolution !== "string" || r.resolution === "") {
      return { ok: false, error: "Record must have a non-empty resolution when resolvedAt is present." };
    }
  } else if (r.resolution !== undefined) {
    return { ok: false, error: "Record cannot have a resolution without resolvedAt." };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// serializeIncidentRecord
// ---------------------------------------------------------------------------

export function serializeIncidentRecord(record: IncidentRecord): string {
  const result = validateIncidentRecord(record);
  if (!result.ok) {
    throw new Error(`Invalid incident record: ${result.error}`);
  }
  return JSON.stringify(record) + "\n";
}

// ---------------------------------------------------------------------------
// parseIncidentRecordLine
// ---------------------------------------------------------------------------

export function parseIncidentRecordLine(line: string): IncidentRecord {
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

  const result = validateIncidentRecord(parsed);
  if (!result.ok) {
    throw new Error(`Invalid incident record: ${result.error}`);
  }

  return parsed as IncidentRecord;
}

// ---------------------------------------------------------------------------
// FileIncidentLedger
// ---------------------------------------------------------------------------

export class FileIncidentLedger extends FileLedgerStorage<IncidentRecord> {
  constructor(filePath: string) {
    super(filePath, parseIncidentRecordLine, serializeIncidentRecord);
  }
}

// ---------------------------------------------------------------------------
// Standalone helpers (delegate to a temporary instance)
// ---------------------------------------------------------------------------

export async function appendIncidentRecord(
  filePath: string,
  record: IncidentRecord,
): Promise<void> {
  return new FileIncidentLedger(filePath).append(record);
}

export async function readIncidentLog(filePath: string): Promise<IncidentRecord[]> {
  return new FileIncidentLedger(filePath).readAll();
}

export async function readLatestIncidentRecords(
  filePath: string,
  limit: number,
): Promise<IncidentRecord[]> {
  return new FileIncidentLedger(filePath).readLatest(limit);
}

import { PodLedgerStorage } from "./ledger.js";
import type { McpManager } from "./mcp.js";

export class PodIncidentLedger extends PodLedgerStorage<IncidentRecord> {
  constructor(mcpManager: McpManager, serverName: string, ledgerName: string = "incident-ledger") {
    super(mcpManager, serverName, ledgerName, parseIncidentRecordLine, serializeIncidentRecord);
  }
}
