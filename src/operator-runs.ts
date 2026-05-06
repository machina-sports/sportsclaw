/**
 * Operator Run Record Primitives
 *
 * Append-only JSONL ledger for recording structured agent/operator run records.
 * Data-only utilities — no engine wiring or behavior.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { AgentRunRecord, ValidationResult } from "./schema/tv.js";
import { validateDecisionRecord } from "./decision-ledger.js";

// ---------------------------------------------------------------------------
// validateAgentRunRecord
// ---------------------------------------------------------------------------

const REQUIRED_STRING_FIELDS = ["id", "agentId", "startedAt"] as const;
const VALID_STATUSES = new Set(["running", "completed", "failed"]);

function isValidDateString(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

export function validateAgentRunRecord(record: unknown): ValidationResult {
  if (!record || typeof record !== "object") {
    return { ok: false, error: "Record must be a non-null object." };
  }

  const r = record as Record<string, unknown>;

  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof r[field] !== "string" || r[field] === "") {
      return { ok: false, error: `Record must have a non-empty ${field}.` };
    }
  }

  if (!isValidDateString(r.startedAt as string)) {
    return { ok: false, error: "Record startedAt must be a valid date string." };
  }

  if (typeof r.status !== "string" || !VALID_STATUSES.has(r.status)) {
    return { ok: false, error: "Record status must be running, completed, or failed." };
  }

  if (!Array.isArray(r.decisions)) {
    return { ok: false, error: "Record decisions must be an array." };
  }

  for (let i = 0; i < r.decisions.length; i += 1) {
    const decisionResult = validateDecisionRecord(r.decisions[i]);
    if (!decisionResult.ok) {
      return {
        ok: false,
        error: `Record decisions[${i}] is invalid: ${decisionResult.error}`,
      };
    }
  }

  if (r.status === "completed" || r.status === "failed") {
    if (typeof r.endedAt !== "string" || r.endedAt === "") {
      return {
        ok: false,
        error: "Record must have a non-empty endedAt when status is completed or failed.",
      };
    }
  }

  if (r.endedAt !== undefined) {
    if (typeof r.endedAt !== "string" || r.endedAt === "") {
      return { ok: false, error: "Record endedAt must be a valid date string." };
    }
    if (!isValidDateString(r.endedAt)) {
      return { ok: false, error: "Record endedAt must be a valid date string." };
    }
    if (Date.parse(r.endedAt) < Date.parse(r.startedAt as string)) {
      return { ok: false, error: "Record endedAt must be greater than or equal to startedAt." };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// serializeAgentRunRecord
// ---------------------------------------------------------------------------

export function serializeAgentRunRecord(record: AgentRunRecord): string {
  return JSON.stringify(record) + "\n";
}

// ---------------------------------------------------------------------------
// parseAgentRunRecordLine
// ---------------------------------------------------------------------------

export function parseAgentRunRecordLine(line: string): AgentRunRecord {
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

  const result = validateAgentRunRecord(parsed);
  if (!result.ok) {
    throw new Error(`Invalid agent run record: ${result.error}`);
  }

  return parsed as AgentRunRecord;
}

// ---------------------------------------------------------------------------
// appendAgentRunRecord
// ---------------------------------------------------------------------------

export async function appendAgentRunRecord(
  filePath: string,
  record: AgentRunRecord,
): Promise<void> {
  const result = validateAgentRunRecord(record);
  if (!result.ok) {
    throw new Error(`Invalid agent run record: ${result.error}`);
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, serializeAgentRunRecord(record), "utf-8");
}

// ---------------------------------------------------------------------------
// readAgentRunLedger
// ---------------------------------------------------------------------------

export async function readAgentRunLedger(filePath: string): Promise<AgentRunRecord[]> {
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
    .map(parseAgentRunRecordLine);
}

// ---------------------------------------------------------------------------
// readLatestAgentRunRecords
// ---------------------------------------------------------------------------

export async function readLatestAgentRunRecords(
  filePath: string,
  limit: number,
): Promise<AgentRunRecord[]> {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("Limit must be a positive integer.");
  }

  const all = await readAgentRunLedger(filePath);
  return all.slice(-limit);
}
