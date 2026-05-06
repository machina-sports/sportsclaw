/**
 * Decision Ledger Primitives — test suite
 *
 * Tests for append-only JSONL decision ledger utilities.
 * Written test-first (TDD).
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  validateDecisionRecord,
  serializeDecisionRecord,
  parseDecisionRecordLine,
  appendDecisionRecord,
  readDecisionLedger,
  readLatestDecisionRecords,
  FileDecisionLedger,
} from "../dist/decision-ledger.js";

import * as publicEntry from "../dist/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validRecord(overrides = {}) {
  return {
    id: "rec-001",
    timestamp: "2026-05-06T12:00:00.000Z",
    action: "swap-block",
    reason: "Source went stale",
    ...overrides,
  };
}

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// validateDecisionRecord
// ---------------------------------------------------------------------------

describe("validateDecisionRecord", () => {
  it("accepts a valid minimal record", () => {
    const result = validateDecisionRecord(validRecord());
    assert.strictEqual(result.ok, true);
  });

  it("accepts a record with all optional fields", () => {
    const result = validateDecisionRecord(
      validRecord({ blockId: "blk-1", agentId: "agent-7", meta: { foo: 1 } }),
    );
    assert.strictEqual(result.ok, true);
  });

  it("rejects null", () => {
    const result = validateDecisionRecord(null);
    assert.strictEqual(result.ok, false);
  });

  it("rejects undefined", () => {
    const result = validateDecisionRecord(undefined);
    assert.strictEqual(result.ok, false);
  });

  it("rejects missing id", () => {
    const { id, ...rest } = validRecord();
    const result = validateDecisionRecord(rest);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("id"));
  });

  it("rejects empty id", () => {
    const result = validateDecisionRecord(validRecord({ id: "" }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("id"));
  });

  it("rejects missing timestamp", () => {
    const { timestamp, ...rest } = validRecord();
    const result = validateDecisionRecord(rest);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("timestamp"));
  });

  it("rejects empty timestamp", () => {
    const result = validateDecisionRecord(validRecord({ timestamp: "" }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("timestamp"));
  });

  it("rejects missing action", () => {
    const { action, ...rest } = validRecord();
    const result = validateDecisionRecord(rest);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("action"));
  });

  it("rejects empty action", () => {
    const result = validateDecisionRecord(validRecord({ action: "" }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("action"));
  });

  it("rejects missing reason", () => {
    const { reason, ...rest } = validRecord();
    const result = validateDecisionRecord(rest);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("reason"));
  });

  it("rejects empty reason", () => {
    const result = validateDecisionRecord(validRecord({ reason: "" }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("reason"));
  });

  it("rejects non-string id", () => {
    const result = validateDecisionRecord(validRecord({ id: 123 }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.toLowerCase().includes("id"));
  });
});

// ---------------------------------------------------------------------------
// serializeDecisionRecord
// ---------------------------------------------------------------------------

describe("serializeDecisionRecord", () => {
  it("produces a single line of JSON with a trailing newline", () => {
    const line = serializeDecisionRecord(validRecord());
    assert.ok(!line.includes("\n") || line.indexOf("\n") === line.length - 1);
    assert.ok(line.endsWith("\n"));
  });

  it("round-trips through JSON.parse", () => {
    const rec = validRecord({ blockId: "blk-1", meta: { x: 42 } });
    const line = serializeDecisionRecord(rec);
    const parsed = JSON.parse(line);
    assert.deepStrictEqual(parsed, rec);
  });
});

// ---------------------------------------------------------------------------
// parseDecisionRecordLine
// ---------------------------------------------------------------------------

describe("parseDecisionRecordLine", () => {
  it("parses a valid JSON line", () => {
    const rec = validRecord();
    const line = JSON.stringify(rec);
    const parsed = parseDecisionRecordLine(line);
    assert.deepStrictEqual(parsed, rec);
  });

  it("parses a line with trailing newline", () => {
    const rec = validRecord();
    const line = JSON.stringify(rec) + "\n";
    const parsed = parseDecisionRecordLine(line);
    assert.deepStrictEqual(parsed, rec);
  });

  it("throws on invalid JSON", () => {
    assert.throws(() => parseDecisionRecordLine("{not json"), {
      message: /invalid json/i,
    });
  });

  it("throws on empty line", () => {
    assert.throws(() => parseDecisionRecordLine(""), {
      message: /invalid json|empty/i,
    });
  });

  it("throws on whitespace-only line", () => {
    assert.throws(() => parseDecisionRecordLine("   "), {
      message: /invalid json|empty/i,
    });
  });

});

// ---------------------------------------------------------------------------
// appendDecisionRecord
// ---------------------------------------------------------------------------

describe("appendDecisionRecord", () => {
  it("creates file and parent dirs if they do not exist", async () => {
    const filePath = path.join(tmpDir, "sub", "dir", "ledger.jsonl");
    await appendDecisionRecord(filePath, validRecord());
    assert.ok(fs.existsSync(filePath));
  });

  it("appends multiple records as separate lines", async () => {
    const filePath = path.join(tmpDir, "ledger.jsonl");
    await appendDecisionRecord(filePath, validRecord({ id: "r1" }));
    await appendDecisionRecord(filePath, validRecord({ id: "r2" }));
    const lines = fs.readFileSync(filePath, "utf-8").trimEnd().split("\n");
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(JSON.parse(lines[0]).id, "r1");
    assert.strictEqual(JSON.parse(lines[1]).id, "r2");
  });
});

// ---------------------------------------------------------------------------
// readDecisionLedger
// ---------------------------------------------------------------------------

describe("readDecisionLedger", () => {
  it("returns empty array for missing file", async () => {
    const filePath = path.join(tmpDir, "nope.jsonl");
    const records = await readDecisionLedger(filePath);
    assert.deepStrictEqual(records, []);
  });

  it("reads all records in order", async () => {
    const filePath = path.join(tmpDir, "ledger.jsonl");
    await appendDecisionRecord(filePath, validRecord({ id: "a" }));
    await appendDecisionRecord(filePath, validRecord({ id: "b" }));
    await appendDecisionRecord(filePath, validRecord({ id: "c" }));
    const records = await readDecisionLedger(filePath);
    assert.strictEqual(records.length, 3);
    assert.strictEqual(records[0].id, "a");
    assert.strictEqual(records[1].id, "b");
    assert.strictEqual(records[2].id, "c");
  });

  it("skips trailing empty lines", async () => {
    const filePath = path.join(tmpDir, "ledger.jsonl");
    const line = JSON.stringify(validRecord()) + "\n\n";
    fs.writeFileSync(filePath, line);
    const records = await readDecisionLedger(filePath);
    assert.strictEqual(records.length, 1);
  });
});

// ---------------------------------------------------------------------------
// readLatestDecisionRecords
// ---------------------------------------------------------------------------

describe("readLatestDecisionRecords", () => {
  it("returns last N records in ledger order", async () => {
    const filePath = path.join(tmpDir, "ledger.jsonl");
    for (const id of ["a", "b", "c", "d", "e"]) {
      await appendDecisionRecord(filePath, validRecord({ id }));
    }
    const latest = await readLatestDecisionRecords(filePath, 3);
    assert.strictEqual(latest.length, 3);
    assert.strictEqual(latest[0].id, "c");
    assert.strictEqual(latest[1].id, "d");
    assert.strictEqual(latest[2].id, "e");
  });

  it("returns all records when limit exceeds count", async () => {
    const filePath = path.join(tmpDir, "ledger.jsonl");
    await appendDecisionRecord(filePath, validRecord({ id: "only" }));
    const latest = await readLatestDecisionRecords(filePath, 10);
    assert.strictEqual(latest.length, 1);
    assert.strictEqual(latest[0].id, "only");
  });

  it("returns empty array for missing file", async () => {
    const filePath = path.join(tmpDir, "nope.jsonl");
    const latest = await readLatestDecisionRecords(filePath, 5);
    assert.deepStrictEqual(latest, []);
  });

  it("throws on non-positive limit", async () => {
    const filePath = path.join(tmpDir, "ledger.jsonl");
    await assert.rejects(() => readLatestDecisionRecords(filePath, 0), {
      message: /positive/i,
    });
    await assert.rejects(() => readLatestDecisionRecords(filePath, -1), {
      message: /positive/i,
    });
  });
});

// ---------------------------------------------------------------------------
// Public entrypoint exports
// ---------------------------------------------------------------------------

describe("public entrypoint exports", () => {
  it("re-exports all decision ledger utilities from the package entrypoint", () => {
    assert.strictEqual(typeof publicEntry.validateDecisionRecord, "function");
    assert.strictEqual(typeof publicEntry.serializeDecisionRecord, "function");
    assert.strictEqual(typeof publicEntry.parseDecisionRecordLine, "function");
    assert.strictEqual(typeof publicEntry.appendDecisionRecord, "function");
    assert.strictEqual(typeof publicEntry.readDecisionLedger, "function");
    assert.strictEqual(typeof publicEntry.readLatestDecisionRecords, "function");
  });

  it("re-exports FileDecisionLedger class and storage abstractions", () => {
    assert.strictEqual(typeof publicEntry.FileDecisionLedger, "function");
    assert.strictEqual(typeof publicEntry.FileLedgerStorage, "function");
  });

  it("entrypoint utilities behave the same as direct imports", () => {
    const directResult = validateDecisionRecord(validRecord());
    const entryResult = publicEntry.validateDecisionRecord(validRecord());
    assert.deepStrictEqual(directResult, entryResult);
  });
});

// ---------------------------------------------------------------------------
// FileDecisionLedger (class-based API)
// ---------------------------------------------------------------------------

describe("FileDecisionLedger", () => {
  it("append + readAll round-trips records", async () => {
    const filePath = path.join(tmpDir, "class-ledger.jsonl");
    const ledger = new FileDecisionLedger(filePath);
    await ledger.append(validRecord({ id: "c1" }));
    await ledger.append(validRecord({ id: "c2" }));
    const records = await ledger.readAll();
    assert.strictEqual(records.length, 2);
    assert.strictEqual(records[0].id, "c1");
    assert.strictEqual(records[1].id, "c2");
  });

  it("readAll returns empty array for missing file", async () => {
    const filePath = path.join(tmpDir, "missing.jsonl");
    const ledger = new FileDecisionLedger(filePath);
    const records = await ledger.readAll();
    assert.deepStrictEqual(records, []);
  });

  it("readLatest returns last N records", async () => {
    const filePath = path.join(tmpDir, "class-latest.jsonl");
    const ledger = new FileDecisionLedger(filePath);
    for (const id of ["a", "b", "c", "d"]) {
      await ledger.append(validRecord({ id }));
    }
    const latest = await ledger.readLatest(2);
    assert.strictEqual(latest.length, 2);
    assert.strictEqual(latest[0].id, "c");
    assert.strictEqual(latest[1].id, "d");
  });

  it("append rejects invalid records", async () => {
    const filePath = path.join(tmpDir, "class-invalid.jsonl");
    const ledger = new FileDecisionLedger(filePath);
    await assert.rejects(() => ledger.append({ id: "", timestamp: "t", action: "a", reason: "r" }), {
      message: /id|invalid|non-empty/i,
    });
  });
});

// ---------------------------------------------------------------------------
// appendDecisionRecord — validation gate
// ---------------------------------------------------------------------------

describe("appendDecisionRecord validation", () => {
  it("rejects an invalid record before writing", async () => {
    const filePath = path.join(tmpDir, "ledger.jsonl");
    const bad = { id: "", timestamp: "t", action: "a", reason: "r" };
    await assert.rejects(() => appendDecisionRecord(filePath, bad), {
      message: /id|invalid|non-empty/i,
    });
    assert.strictEqual(fs.existsSync(filePath), false);
  });

  it("rejects null record without creating the file", async () => {
    const filePath = path.join(tmpDir, "ledger.jsonl");
    await assert.rejects(() => appendDecisionRecord(filePath, null));
    assert.strictEqual(fs.existsSync(filePath), false);
  });

  it("does not create parent dirs when validation fails", async () => {
    const filePath = path.join(tmpDir, "nested", "dir", "ledger.jsonl");
    const bad = { id: "x", timestamp: "t", action: "a" };
    await assert.rejects(() => appendDecisionRecord(filePath, bad));
    assert.strictEqual(fs.existsSync(path.join(tmpDir, "nested")), false);
  });

  it("preserves prior content when a later append is rejected", async () => {
    const filePath = path.join(tmpDir, "ledger.jsonl");
    await appendDecisionRecord(filePath, validRecord({ id: "ok-1" }));
    const bad = { id: "x", timestamp: "t", action: "a" };
    await assert.rejects(() => appendDecisionRecord(filePath, bad));
    const records = await readDecisionLedger(filePath);
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].id, "ok-1");
  });
});

// ---------------------------------------------------------------------------
// parseDecisionRecordLine — validation gate
// ---------------------------------------------------------------------------

describe("parseDecisionRecordLine validation", () => {
  it("throws a clear Error when JSON is valid but record fails validation", () => {
    const badRecord = { id: "", timestamp: "t", action: "a", reason: "r" };
    const line = JSON.stringify(badRecord);
    assert.throws(() => parseDecisionRecordLine(line), {
      message: /invalid decision record|non-empty|id/i,
    });
  });

  it("throws when required fields are missing entirely", () => {
    const line = JSON.stringify({ id: "x", timestamp: "t" });
    assert.throws(() => parseDecisionRecordLine(line), {
      message: /invalid decision record|action|reason/i,
    });
  });

  it("still throws JSON-shaped error for malformed JSON (validation not reached)", () => {
    assert.throws(() => parseDecisionRecordLine("{not json"), {
      message: /invalid json/i,
    });
  });
});
