/**
 * HeartbeatStateStore — test suite
 *
 * Persists per-cron-job runtime state across daemon ticks so a crashed and
 * restarted operator daemon can pick up without double-firing.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { HeartbeatStateStore } from "../dist/heartbeat-state.js";

let tmpDir;
let statePath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-state-test-"));
  statePath = path.join(tmpDir, "state.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// load / cold start
// ---------------------------------------------------------------------------

describe("HeartbeatStateStore.load", () => {
  it("starts empty when the file does not exist", async () => {
    const store = new HeartbeatStateStore(statePath);
    await store.load();
    assert.deepStrictEqual(store.list(), []);
  });

  it("creates the parent directory if missing", async () => {
    const nested = path.join(tmpDir, "deep", "nested", "state.json");
    const store = new HeartbeatStateStore(nested);
    await store.load();
    await store.markRunStart("job-1", { intervalMs: 60_000 });
    assert.ok(fs.existsSync(nested));
  });

  it("reads back persisted state across instances", async () => {
    const a = new HeartbeatStateStore(statePath);
    await a.markRunStart("job-1", { intervalMs: 60_000 });
    await a.markRunSuccess("job-1");
    const b = new HeartbeatStateStore(statePath);
    await b.load();
    const list = b.list();
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].jobId, "job-1");
    assert.strictEqual(list[0].lastStatus, "succeeded");
  });

  it("starts empty when file is corrupt JSON", async () => {
    fs.writeFileSync(statePath, "{ this is not json", "utf8");
    const store = new HeartbeatStateStore(statePath);
    await assert.rejects(() => store.load(), /JSON/i);
  });

  it("starts empty when file has wrong version", async () => {
    fs.writeFileSync(statePath, JSON.stringify({ version: 999, jobs: {} }), "utf8");
    const store = new HeartbeatStateStore(statePath);
    await store.load();
    assert.deepStrictEqual(store.list(), []);
  });
});

// ---------------------------------------------------------------------------
// markRunStart — advance-before-execute
// ---------------------------------------------------------------------------

describe("HeartbeatStateStore.markRunStart", () => {
  it("creates a job record on first call", async () => {
    const store = new HeartbeatStateStore(statePath);
    const state = await store.markRunStart("job-1", { intervalMs: 60_000 });
    assert.strictEqual(state.jobId, "job-1");
    assert.strictEqual(state.runCount, 1);
    assert.strictEqual(state.lastStatus, "running");
    assert.strictEqual(state.state, "active");
  });

  it("computes nextRunAt as now + intervalMs", async () => {
    const store = new HeartbeatStateStore(statePath);
    const before = Date.now();
    const state = await store.markRunStart("job-1", { intervalMs: 60_000 });
    const after = Date.now();
    const next = new Date(state.nextRunAt).getTime();
    assert.ok(next >= before + 60_000);
    assert.ok(next <= after + 60_000 + 50);
  });

  it("increments runCount across calls", async () => {
    const store = new HeartbeatStateStore(statePath);
    await store.markRunStart("job-1", { intervalMs: 1000 });
    await store.markRunStart("job-1", { intervalMs: 1000 });
    const state = await store.markRunStart("job-1", { intervalMs: 1000 });
    assert.strictEqual(state.runCount, 3);
  });

  it("PERSISTS nextRunAt before any work could fail (crash safety)", async () => {
    const a = new HeartbeatStateStore(statePath);
    await a.markRunStart("job-1", { intervalMs: 60_000 });
    // simulate a crash by NOT calling markRunSuccess and re-loading from disk
    const b = new HeartbeatStateStore(statePath);
    await b.load();
    const recovered = b.get("job-1");
    assert.ok(recovered);
    assert.strictEqual(recovered.lastStatus, "running");
    // next fire is already scheduled — at-most-once on crash
    assert.ok(recovered.nextRunAt);
  });

  it("clears lastError when a fresh run starts", async () => {
    const store = new HeartbeatStateStore(statePath);
    await store.markRunStart("job-1", { intervalMs: 1000 });
    await store.markRunFailed("job-1", new Error("boom"));
    const failed = store.get("job-1");
    assert.strictEqual(failed.lastError, "boom");
    await store.markRunStart("job-1", { intervalMs: 1000 });
    const fresh = store.get("job-1");
    assert.strictEqual(fresh.lastError, undefined);
    assert.strictEqual(fresh.lastStatus, "running");
  });
});

// ---------------------------------------------------------------------------
// markRunSuccess / markRunFailed
// ---------------------------------------------------------------------------

describe("HeartbeatStateStore.markRunSuccess", () => {
  it("flips lastStatus to succeeded", async () => {
    const store = new HeartbeatStateStore(statePath);
    await store.markRunStart("job-1", { intervalMs: 1000 });
    const after = await store.markRunSuccess("job-1");
    assert.strictEqual(after.lastStatus, "succeeded");
  });

  it("returns null for unknown job", async () => {
    const store = new HeartbeatStateStore(statePath);
    const result = await store.markRunSuccess("does-not-exist");
    assert.strictEqual(result, null);
  });
});

describe("HeartbeatStateStore.markRunFailed", () => {
  it("records the error message", async () => {
    const store = new HeartbeatStateStore(statePath);
    await store.markRunStart("job-1", { intervalMs: 1000 });
    const after = await store.markRunFailed("job-1", new Error("upstream 500"));
    assert.strictEqual(after.lastStatus, "failed");
    assert.strictEqual(after.lastError, "upstream 500");
  });

  it("does NOT silently disable a recurring job (lifecycle stays active)", async () => {
    const store = new HeartbeatStateStore(statePath);
    await store.markRunStart("job-1", { intervalMs: 1000 });
    const after = await store.markRunFailed("job-1", "boom");
    assert.strictEqual(after.state, "active");
  });

  it("records non-Error throwables as their string form", async () => {
    const store = new HeartbeatStateStore(statePath);
    await store.markRunStart("job-1", { intervalMs: 1000 });
    const after = await store.markRunFailed("job-1", "string error");
    assert.strictEqual(after.lastError, "string error");
  });
});

// ---------------------------------------------------------------------------
// setLifecycle
// ---------------------------------------------------------------------------

describe("HeartbeatStateStore.setLifecycle", () => {
  it("moves a job to error / paused / completed", async () => {
    const store = new HeartbeatStateStore(statePath);
    await store.markRunStart("job-1", { intervalMs: 1000 });
    await store.setLifecycle("job-1", "paused");
    assert.strictEqual(store.get("job-1").state, "paused");
    await store.setLifecycle("job-1", "error");
    assert.strictEqual(store.get("job-1").state, "error");
  });

  it("returns null for unknown job", async () => {
    const store = new HeartbeatStateStore(statePath);
    const result = await store.setLifecycle("missing", "paused");
    assert.strictEqual(result, null);
  });
});

// ---------------------------------------------------------------------------
// forget / clear
// ---------------------------------------------------------------------------

describe("HeartbeatStateStore.forget", () => {
  it("removes a job and persists", async () => {
    const store = new HeartbeatStateStore(statePath);
    await store.markRunStart("job-1", { intervalMs: 1000 });
    await store.markRunStart("job-2", { intervalMs: 1000 });
    const removed = await store.forget("job-1");
    assert.strictEqual(removed, true);
    assert.deepStrictEqual(store.list().map((j) => j.jobId), ["job-2"]);
    // verify persisted
    const reload = new HeartbeatStateStore(statePath);
    await reload.load();
    assert.deepStrictEqual(reload.list().map((j) => j.jobId), ["job-2"]);
  });

  it("returns false for unknown job", async () => {
    const store = new HeartbeatStateStore(statePath);
    const result = await store.forget("missing");
    assert.strictEqual(result, false);
  });
});

describe("HeartbeatStateStore.clear", () => {
  it("removes everything", async () => {
    const store = new HeartbeatStateStore(statePath);
    await store.markRunStart("job-1", { intervalMs: 1000 });
    await store.markRunStart("job-2", { intervalMs: 1000 });
    await store.clear();
    assert.deepStrictEqual(store.list(), []);
  });
});
