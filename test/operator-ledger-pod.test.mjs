/**
 * Operator Daemon Ledgers & Pod Sync — test suite
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { createOperatorDaemon } from "../dist/operator-daemon.js";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "operator-ledger-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function baseConfig(overrides) {
  return {
    jobId: "test-ledger-job",
    intervalMs: 1000,
    model: { id: "test-model" },
    role: "Test persona",
    rootDir: tmpDir,
    enableMemoryTools: false,
    ...overrides,
  };
}

function makeGenWithResult(result) {
  const calls = [];
  const impl = async (args) => {
    calls.push(args);
    return result;
  };
  impl.calls = calls;
  return impl;
}

class MockMcpManager {
  constructor() {
    this.calls = [];
    this.documents = new Map(); // name -> doc
  }

  getMachinaServerName() {
    return "mock-machina-server";
  }

  async callToolDirect(serverName, toolName, args) {
    this.calls.push({ serverName, toolName, args });

    if (toolName === "search_documents") {
      const name = args.filters?.name;
      const doc = this.documents.get(name);
      if (!doc) {
        return { content: JSON.stringify({ data: { data: [] } }), isError: false };
      }
      return {
        content: JSON.stringify({
          data: {
            data: [
              {
                _id: "doc-id-123",
                value: doc.value,
              },
            ],
          },
        }),
        isError: false,
      };
    }

    if (toolName === "create_document") {
      this.documents.set(args.name, { value: args.content?.value });
      return { content: JSON.stringify({ _id: "doc-id-123" }), isError: false };
    }

    if (toolName === "update_document") {
      // Find the document and update it
      for (const [name, doc] of this.documents.entries()) {
        this.documents.set(name, { value: args.content?.value });
      }
      return { content: JSON.stringify({ ok: true }), isError: false };
    }

    return { content: "{}", isError: false };
  }
}

describe("Operator Daemon — Ledgers & Pod Sync", () => {
  it("records agent runs locally in JSONL format", async () => {
    const gen = makeGenWithResult({ text: "Standard published broadcast" });
    const daemon = createOperatorDaemon(
      baseConfig({
        generateTextImpl: gen,
      }),
    );

    const event = await daemon.tickOnce();
    assert.strictEqual(event.type, "tick_published");

    // Verify local ledger file exists and contains valid JSONL
    const ledgerPath = path.join(tmpDir, "operator-runs.jsonl");
    assert.ok(fs.existsSync(ledgerPath), "local run ledger should exist");

    const content = fs.readFileSync(ledgerPath, "utf8").trim();
    const parsed = JSON.parse(content);

    assert.strictEqual(parsed.id, event.tickId);
    assert.strictEqual(parsed.agentId, "test-ledger-job");
    assert.strictEqual(parsed.status, "completed");
    assert.strictEqual(parsed.decisions[0].action, "publish");
  });

  it("logs incidents to a local file when tick fails", async () => {
    // Inject a generating failure
    const gen = async () => {
      throw new Error("Inference Timeout Error");
    };
    const daemon = createOperatorDaemon(
      baseConfig({
        generateTextImpl: gen,
      }),
    );

    const event = await daemon.tickOnce();
    assert.strictEqual(event.type, "tick_failed");

    // Verify local incident ledger file exists
    const incidentPath = path.join(tmpDir, "incidents.jsonl");
    assert.ok(fs.existsSync(incidentPath), "local incident ledger should exist");

    const content = fs.readFileSync(incidentPath, "utf8").trim();
    const parsed = JSON.parse(content);

    assert.strictEqual(parsed.level, "critical");
    assert.match(parsed.message, /Tick crashed: Inference Timeout Error/);
    assert.strictEqual(parsed.component, "operator-daemon");
  });

  it("syncs agent run records and incidents to the Pod via MCP", async () => {
    const invalidManifest = {
      id: "manifest-bad",
      channelId: "test-ledger-job",
      blocks: [], // fails validation, triggers fallback & incident
      createdAt: new Date().toISOString(),
    };

    const mcpManager = new MockMcpManager();
    const gen = makeGenWithResult({ experimental_output: invalidManifest });

    const daemon = createOperatorDaemon(
      baseConfig({
        generateTextImpl: gen,
        outputSchema: {
          schema: {
            type: "object",
            properties: { id: { type: "string" }, blocks: { type: "array" } },
          },
        },
        broadcastSafety: {
          enabled: true,
        },
        mcpManager,
      }),
    );

    await daemon.tickOnce();

    // Verify MCP tools were called
    const calls = mcpManager.calls;
    assert.ok(calls.length > 0, "MCP tools should be invoked");

    // We should see a doc creation or update for both "operator-runs-ledger" and "incident-ledger"
    const runLedger = mcpManager.documents.get("operator-runs-ledger");
    const incidentLedger = mcpManager.documents.get("incident-ledger");

    assert.ok(runLedger, "runs ledger doc should be created/updated in the Pod");
    assert.ok(incidentLedger, "incident ledger doc should be created/updated in the Pod");

    const runRecord = JSON.parse(runLedger.value.records[0]);
    assert.strictEqual(runRecord.status, "completed");
    assert.strictEqual(runRecord.decisions[0].action, "fallback");

    const incidentRecord = JSON.parse(incidentLedger.value.records[0]);
    assert.strictEqual(incidentRecord.level, "error");
    assert.strictEqual(incidentRecord.component, "safety-gate");
  });

  // -------------------------------------------------------------------------
  // TickEvent.ledgerSync — visibility for downstream observers
  // -------------------------------------------------------------------------

  it("populates TickEvent.ledgerSync with local=ok / pod=skipped when MCP is absent", async () => {
    const gen = makeGenWithResult({ text: "Standard published broadcast" });
    const daemon = createOperatorDaemon(
      baseConfig({ generateTextImpl: gen }),
    );

    const event = await daemon.tickOnce();
    assert.ok(event.ledgerSync, "ledgerSync should be populated on tick_published");
    assert.strictEqual(event.ledgerSync.localRun, "ok");
    assert.strictEqual(event.ledgerSync.podRun, "skipped");
  });

  it("populates ledgerSync with podRun=ok when MCP succeeds", async () => {
    const mcpManager = new MockMcpManager();
    const gen = makeGenWithResult({ text: "Standard published broadcast" });
    const daemon = createOperatorDaemon(
      baseConfig({ generateTextImpl: gen, mcpManager }),
    );

    const event = await daemon.tickOnce();
    assert.ok(event.ledgerSync);
    assert.strictEqual(event.ledgerSync.localRun, "ok");
    assert.strictEqual(event.ledgerSync.podRun, "ok");
  });

  it("surfaces podRun=failed with an error string when the Pod sync throws", async () => {
    // MockMcpManager that throws on every callToolDirect.
    const flakyMcp = {
      getMachinaServerName() { return "mock-machina-server"; },
      async callToolDirect() { throw new Error("ECONNRESET"); },
    };
    const gen = makeGenWithResult({ text: "Standard published broadcast" });
    const daemon = createOperatorDaemon(
      baseConfig({ generateTextImpl: gen, mcpManager: flakyMcp }),
    );

    const event = await daemon.tickOnce();
    assert.ok(event.ledgerSync);
    assert.strictEqual(event.ledgerSync.localRun, "ok", "local ledger is independent");
    assert.strictEqual(event.ledgerSync.podRun, "failed");
    assert.match(event.ledgerSync.podRunError ?? "", /ECONNRESET/);
  });

  it("populates ledgerSync on tick_failed (carrying the incident sync outcome too)", async () => {
    const mcpManager = new MockMcpManager();
    const gen = async () => { throw new Error("Inference Timeout Error"); };
    const daemon = createOperatorDaemon(
      baseConfig({ generateTextImpl: gen, mcpManager }),
    );

    const event = await daemon.tickOnce();
    assert.strictEqual(event.type, "tick_failed");
    assert.ok(event.ledgerSync);
    assert.strictEqual(event.ledgerSync.localRun, "ok");
    assert.strictEqual(event.ledgerSync.localIncident, "ok");
    assert.strictEqual(event.ledgerSync.podRun, "ok");
    assert.strictEqual(event.ledgerSync.podIncident, "ok");
  });
});
