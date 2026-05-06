import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendAgentRunRecord,
  parseAgentRunRecordLine,
  readAgentRunLedger,
  readLatestAgentRunRecords,
  serializeAgentRunRecord,
  validateAgentRunRecord,
} from "../dist/index.js";

const validDecision = {
  id: "decision-1",
  timestamp: "2026-05-06T22:00:00.000Z",
  action: "select-next-block",
  reason: "scheduled block is ready",
};

const validRun = {
  id: "run-1",
  agentId: "agent-1",
  startedAt: "2026-05-06T22:00:00.000Z",
  endedAt: "2026-05-06T22:01:30.000Z",
  decisions: [validDecision],
  status: "completed",
};

async function tempFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sportsclaw-runs-"));
  return path.join(dir, "runs.jsonl");
}

test("validateAgentRunRecord accepts a valid completed run", () => {
  assert.deepEqual(validateAgentRunRecord(validRun), { ok: true });
});

test("validateAgentRunRecord accepts a running run without endedAt", () => {
  assert.deepEqual(
    validateAgentRunRecord({ ...validRun, status: "running", endedAt: undefined }),
    { ok: true },
  );
});

test("validateAgentRunRecord rejects non-object values", () => {
  assert.deepEqual(validateAgentRunRecord(null), {
    ok: false,
    error: "Record must be a non-null object.",
  });
});

test("validateAgentRunRecord requires id, agentId, and startedAt", () => {
  for (const field of ["id", "agentId", "startedAt"]) {
    const record = { ...validRun, [field]: "" };
    assert.deepEqual(validateAgentRunRecord(record), {
      ok: false,
      error: `Record must have a non-empty ${field}.`,
    });
  }
});

test("validateAgentRunRecord rejects unknown status values", () => {
  assert.deepEqual(validateAgentRunRecord({ ...validRun, status: "queued" }), {
    ok: false,
    error: "Record status must be running, completed, or failed.",
  });
});

test("validateAgentRunRecord requires decisions to be an array", () => {
  assert.deepEqual(validateAgentRunRecord({ ...validRun, decisions: {} }), {
    ok: false,
    error: "Record decisions must be an array.",
  });
});

test("validateAgentRunRecord rejects invalid decision records", () => {
  assert.deepEqual(
    validateAgentRunRecord({ ...validRun, decisions: [{ ...validDecision, reason: "" }] }),
    {
      ok: false,
      error: "Record decisions[0] is invalid: Record must have a non-empty reason.",
    },
  );
});

test("validateAgentRunRecord requires endedAt when status is completed", () => {
  assert.deepEqual(validateAgentRunRecord({ ...validRun, endedAt: undefined }), {
    ok: false,
    error: "Record must have a non-empty endedAt when status is completed or failed.",
  });
});

test("validateAgentRunRecord requires endedAt when status is failed", () => {
  assert.deepEqual(validateAgentRunRecord({ ...validRun, status: "failed", endedAt: "" }), {
    ok: false,
    error: "Record must have a non-empty endedAt when status is completed or failed.",
  });
});

test("validateAgentRunRecord rejects endedAt before startedAt", () => {
  assert.deepEqual(
    validateAgentRunRecord({
      ...validRun,
      startedAt: "2026-05-06T22:02:00.000Z",
      endedAt: "2026-05-06T22:01:00.000Z",
    }),
    {
      ok: false,
      error: "Record endedAt must be greater than or equal to startedAt.",
    },
  );
});

test("serializeAgentRunRecord returns newline-delimited JSON", () => {
  assert.equal(serializeAgentRunRecord(validRun), `${JSON.stringify(validRun)}\n`);
});

test("parseAgentRunRecordLine parses valid JSONL", () => {
  assert.deepEqual(parseAgentRunRecordLine(JSON.stringify(validRun)), validRun);
});

test("parseAgentRunRecordLine rejects empty lines", () => {
  assert.throws(() => parseAgentRunRecordLine("   "), /Invalid JSON: empty line\./);
});

test("parseAgentRunRecordLine rejects malformed JSON", () => {
  assert.throws(() => parseAgentRunRecordLine("{"), /Invalid JSON: could not parse line\./);
});

test("parseAgentRunRecordLine rejects parsed records with invalid shape", () => {
  assert.throws(
    () => parseAgentRunRecordLine(JSON.stringify({ ...validRun, agentId: "" })),
    /Invalid agent run record: Record must have a non-empty agentId\./,
  );
});

test("appendAgentRunRecord writes valid JSONL and creates parent directories", async () => {
  const filePath = await tempFile();
  await appendAgentRunRecord(filePath, validRun);
  await appendAgentRunRecord(filePath, { ...validRun, id: "run-2" });

  const content = await fs.readFile(filePath, "utf-8");
  assert.equal(content.split("\n").filter(Boolean).length, 2);
  assert.deepEqual(await readAgentRunLedger(filePath), [validRun, { ...validRun, id: "run-2" }]);
});

test("appendAgentRunRecord rejects invalid records before writing", async () => {
  const filePath = await tempFile();
  await assert.rejects(
    () => appendAgentRunRecord(filePath, { ...validRun, id: "" }),
    /Invalid agent run record: Record must have a non-empty id\./,
  );
  await assert.rejects(() => fs.stat(filePath), { code: "ENOENT" });
});

test("readAgentRunLedger returns empty array for missing file", async () => {
  const filePath = await tempFile();
  assert.deepEqual(await readAgentRunLedger(filePath), []);
});

test("readLatestAgentRunRecords returns the latest records", async () => {
  const filePath = await tempFile();
  await appendAgentRunRecord(filePath, { ...validRun, id: "run-1" });
  await appendAgentRunRecord(filePath, { ...validRun, id: "run-2" });
  await appendAgentRunRecord(filePath, { ...validRun, id: "run-3" });

  assert.deepEqual(await readLatestAgentRunRecords(filePath, 2), [
    { ...validRun, id: "run-2" },
    { ...validRun, id: "run-3" },
  ]);
});

test("readLatestAgentRunRecords rejects invalid limits", async () => {
  const filePath = await tempFile();
  await assert.rejects(() => readLatestAgentRunRecords(filePath, 0), /Limit must be a positive integer\./);
  await assert.rejects(() => readLatestAgentRunRecords(filePath, 1.5), /Limit must be a positive integer\./);
});
