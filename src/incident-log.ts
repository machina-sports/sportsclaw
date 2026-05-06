/**
 * Incident Log Primitives
 *
 * Append-only JSONL ledger for recording structured operational incidents.
 * Data-only utilities — no engine wiring or behavior.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { IncidentRecord, ValidationResult } from "./schema/tv.js";

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
// appendIncidentRecord
// ---------------------------------------------------------------------------

export async function appendIncidentRecord(
  filePath: string,
  record: IncidentRecord,
): Promise<void> {
  const result = validateIncidentRecord(record);
  if (!result.ok) {
    throw new Error(`Invalid incident record: ${result.error}`);
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, serializeIncidentRecord(record), "utf-8");
}

// ---------------------------------------------------------------------------
// readIncidentLog
// ---------------------------------------------------------------------------

export async function readIncidentLog(filePath: string): Promise<IncidentRecord[]> {
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
    .map(parseIncidentRecordLine);
}

// ---------------------------------------------------------------------------
// readLatestIncidentRecords
// ---------------------------------------------------------------------------

export async function readLatestIncidentRecords(
  filePath: string,
  limit: number,
): Promise<IncidentRecord[]> {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("Limit must be a positive integer.");
  }

  const all = await readIncidentLog(filePath);
  return all.slice(-limit);
}
