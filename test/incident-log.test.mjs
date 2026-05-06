import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendIncidentRecord,
  parseIncidentRecordLine,
  readIncidentLog,
  readLatestIncidentRecords,
  serializeIncidentRecord,
  validateIncidentRecord,
} from "../dist/index.js";

const validIncident = {
  id: "inc-1",
  timestamp: "2026-05-06T22:00:00.000Z",
  level: "error",
  message: "Failed to connect to MCP server.",
  component: "mcp",
};

const resolvedIncident = {
  ...validIncident,
  resolvedAt: "2026-05-06T22:05:00.000Z",
  resolution: "Reconnected to MCP server.",
};

async function tempFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sportsclaw-incidents-"));
  return path.join(dir, "incidents.jsonl");
}

test("validateIncidentRecord accepts a valid unresolved incident", () => {
  assert.deepEqual(validateIncidentRecord(validIncident), { ok: true });
});

test("validateIncidentRecord accepts a valid resolved incident", () => {
  assert.deepEqual(validateIncidentRecord(resolvedIncident), { ok: true });
});

test("validateIncidentRecord rejects non-object values", () => {
  assert.deepEqual(validateIncidentRecord(null), {
    ok: false,
    error: "Record must be a non-null object.",
  });
});

test("validateIncidentRecord requires id, timestamp, message, and component", () => {
  for (const field of ["id", "timestamp", "message", "component"]) {
    const record = { ...validIncident, [field]: "" };
    assert.deepEqual(validateIncidentRecord(record), {
      ok: false,
      error: `Record must have a non-empty ${field}.`,
    });
  }
});

test("validateIncidentRecord rejects invalid timestamp", () => {
  assert.deepEqual(validateIncidentRecord({ ...validIncident, timestamp: "not-a-date" }), {
    ok: false,
    error: "Record timestamp must be a valid date string.",
  });
});

test("validateIncidentRecord rejects unknown level values", () => {
  assert.deepEqual(validateIncidentRecord({ ...validIncident, level: "info" }), {
    ok: false,
    error: "Record level must be warning, error, or critical.",
  });
});

test("validateIncidentRecord rejects resolvedAt before timestamp", () => {
  assert.deepEqual(
    validateIncidentRecord({
      ...resolvedIncident,
      timestamp: "2026-05-06T22:05:00.000Z",
      resolvedAt: "2026-05-06T22:00:00.000Z",
    }),
    {
      ok: false,
      error: "Record resolvedAt must be greater than or equal to timestamp.",
    },
  );
});

test("validateIncidentRecord requires resolution when resolvedAt is present", () => {
  assert.deepEqual(
    validateIncidentRecord({ ...resolvedIncident, resolution: undefined }),
    {
      ok: false,
      error: "Record must have a non-empty resolution when resolvedAt is present.",
    },
  );
});

test("validateIncidentRecord rejects resolution without resolvedAt", () => {
  assert.deepEqual(
    validateIncidentRecord({ ...validIncident, resolution: "Fixed it" }),
    {
      ok: false,
      error: "Record cannot have a resolution without resolvedAt.",
    },
  );
});

test("serializeIncidentRecord returns newline-delimited JSON", () => {
  assert.equal(serializeIncidentRecord(validIncident), `${JSON.stringify(validIncident)}\n`);
});

test("parseIncidentRecordLine parses valid JSONL", () => {
  assert.deepEqual(parseIncidentRecordLine(JSON.stringify(validIncident)), validIncident);
});

test("parseIncidentRecordLine rejects empty lines", () => {
  assert.throws(() => parseIncidentRecordLine("   "), /Invalid JSON: empty line\./);
});

test("parseIncidentRecordLine rejects malformed JSON", () => {
  assert.throws(() => parseIncidentRecordLine("{"), /Invalid JSON: could not parse line\./);
});

test("parseIncidentRecordLine rejects parsed records with invalid shape", () => {
  assert.throws(
    () => parseIncidentRecordLine(JSON.stringify({ ...validIncident, level: "info" })),
    /Invalid incident record: Record level must be warning, error, or critical\./,
  );
});

test("appendIncidentRecord writes valid JSONL and creates parent directories", async () => {
  const filePath = await tempFile();
  await appendIncidentRecord(filePath, validIncident);
  await appendIncidentRecord(filePath, { ...validIncident, id: "inc-2" });

  const content = await fs.readFile(filePath, "utf-8");
  assert.equal(content.split("\n").filter(Boolean).length, 2);
  assert.deepEqual(await readIncidentLog(filePath), [validIncident, { ...validIncident, id: "inc-2" }]);
});

test("appendIncidentRecord rejects invalid records before writing", async () => {
  const filePath = await tempFile();
  await assert.rejects(
    () => appendIncidentRecord(filePath, { ...validIncident, id: "" }),
    /Invalid incident record: Record must have a non-empty id\./,
  );
  await assert.rejects(() => fs.stat(filePath), { code: "ENOENT" });
});

test("readIncidentLog returns empty array for missing file", async () => {
  const filePath = await tempFile();
  assert.deepEqual(await readIncidentLog(filePath), []);
});

test("readLatestIncidentRecords returns the latest records", async () => {
  const filePath = await tempFile();
  await appendIncidentRecord(filePath, { ...validIncident, id: "inc-1" });
  await appendIncidentRecord(filePath, { ...validIncident, id: "inc-2" });
  await appendIncidentRecord(filePath, { ...validIncident, id: "inc-3" });

  assert.deepEqual(await readLatestIncidentRecords(filePath, 2), [
    { ...validIncident, id: "inc-2" },
    { ...validIncident, id: "inc-3" },
  ]);
});

test("readLatestIncidentRecords rejects invalid limits", async () => {
  const filePath = await tempFile();
  await assert.rejects(() => readLatestIncidentRecords(filePath, 0), /Limit must be a positive integer\./);
  await assert.rejects(() => readLatestIncidentRecords(filePath, 1.5), /Limit must be a positive integer\./);
});
