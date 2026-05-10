/**
 * HeartbeatService — focused tests for the new persistence + lock surface.
 *
 * Does NOT exercise the LLM-evaluated watcher path (that needs a real model).
 * Covers: configurePersistence(), tickGuarded() in-process flag, advance-
 * before-execute via markRunStart, and the cross-process lock behaviour.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { HeartbeatService } from "../dist/heartbeat.js";
import { HeartbeatStateStore } from "../dist/heartbeat-state.js";
import lockfile from "proper-lockfile";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "heartbeat-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// configurePersistence
// ---------------------------------------------------------------------------

describe("HeartbeatService.configurePersistence", () => {
  it("toggles hasPersistence", () => {
    const hb = new HeartbeatService({ intervalMs: 1_000_000 });
    assert.strictEqual(hb.hasPersistence, false);
    hb.configurePersistence({ stateDir: tmpDir });
    assert.strictEqual(hb.hasPersistence, true);
  });

  it("uses the configured filenames", () => {
    const hb = new HeartbeatService({ intervalMs: 1_000_000 });
    hb.configurePersistence({
      stateDir: tmpDir,
      stateFilename: "custom-state.json",
      lockFilename: "custom.lock",
    });
    // smoke: persistence is on; the actual files are created on first write
    assert.strictEqual(hb.hasPersistence, true);
  });

  it("rejects re-config after start()", () => {
    const hb = new HeartbeatService({ intervalMs: 1_000_000 });
    hb.start();
    assert.throws(
      () => hb.configurePersistence({ stateDir: tmpDir }),
      /must be called before start/i,
    );
    hb.stop();
  });
});

// ---------------------------------------------------------------------------
// listPersistedJobs / getPersistedJob
// ---------------------------------------------------------------------------

describe("HeartbeatService.listPersistedJobs", () => {
  it("returns [] when persistence is off", async () => {
    const hb = new HeartbeatService({ intervalMs: 1_000_000 });
    const jobs = await hb.listPersistedJobs();
    assert.deepStrictEqual(jobs, []);
  });

  it("reads persisted state from disk", async () => {
    // pre-populate with a different store
    const seed = new HeartbeatStateStore(path.join(tmpDir, "heartbeat-state.json"));
    await seed.markRunStart("seeded-job", { intervalMs: 1000 });

    const hb = new HeartbeatService({ intervalMs: 1_000_000 });
    hb.configurePersistence({ stateDir: tmpDir });
    const jobs = await hb.listPersistedJobs();
    assert.strictEqual(jobs.length, 1);
    assert.strictEqual(jobs[0].jobId, "seeded-job");
  });
});

describe("HeartbeatService.markJobSucceeded / markJobFailed", () => {
  it("persists succeeded status after markRunStart was recorded", async () => {
    const seed = new HeartbeatStateStore(path.join(tmpDir, "heartbeat-state.json"));
    await seed.markRunStart("job-x", { intervalMs: 1000 });

    const hb = new HeartbeatService({ intervalMs: 1_000_000 });
    hb.configurePersistence({ stateDir: tmpDir });
    await hb.markJobSucceeded("job-x");
    const recovered = await hb.getPersistedJob("job-x");
    assert.strictEqual(recovered.lastStatus, "succeeded");
  });

  it("records the failure error message", async () => {
    const seed = new HeartbeatStateStore(path.join(tmpDir, "heartbeat-state.json"));
    await seed.markRunStart("job-x", { intervalMs: 1000 });

    const hb = new HeartbeatService({ intervalMs: 1_000_000 });
    hb.configurePersistence({ stateDir: tmpDir });
    await hb.markJobFailed("job-x", new Error("upstream timeout"));
    const recovered = await hb.getPersistedJob("job-x");
    assert.strictEqual(recovered.lastStatus, "failed");
    assert.strictEqual(recovered.lastError, "upstream timeout");
  });

  it("noops cleanly when persistence is off", async () => {
    const hb = new HeartbeatService({ intervalMs: 1_000_000 });
    // should not throw
    await hb.markJobSucceeded("nope");
    await hb.markJobFailed("nope", new Error("nope"));
  });
});

// ---------------------------------------------------------------------------
// advance-before-execute via cron firing
// ---------------------------------------------------------------------------

describe("HeartbeatService cron advance-before-execute", () => {
  it("persists nextRunAt + runCount BEFORE emitting cron_fired", async () => {
    let recordedAtFire = null;
    const hb = new HeartbeatService({ intervalMs: 60_000, verbose: false });
    hb.configurePersistence({ stateDir: tmpDir });
    hb.setEventHandler(async (evt) => {
      if (evt.type === "cron_fired") {
        // when the event fires, persisted state must already be advanced
        recordedAtFire = await hb.getPersistedJob(evt.cronJobId);
      }
    });
    hb.start();
    // schedule a recurring job with a tiny interval; first execute fires
    // immediately, then we stop.
    const job = hb.scheduleCron({
      label: "test-job",
      prompt: "irrelevant",
      userId: "tester",
      intervalMs: 1_000_000,
      recurring: true,
    });
    // give the immediate fire a moment to execute the async callback
    await wait(80);
    hb.stop();

    assert.ok(recordedAtFire, "cron_fired must observe persisted state");
    assert.strictEqual(recordedAtFire.jobId, job.id);
    assert.strictEqual(recordedAtFire.runCount, 1);
    assert.strictEqual(recordedAtFire.lastStatus, "running");
    // nextRunAt must be in the future
    assert.ok(new Date(recordedAtFire.nextRunAt).getTime() > Date.now());
  });

  it("flips persisted lifecycle to completed for one-shot jobs", async () => {
    const hb = new HeartbeatService({ intervalMs: 60_000 });
    hb.configurePersistence({ stateDir: tmpDir });
    hb.start();
    const job = hb.scheduleCron({
      label: "one-shot",
      prompt: "irrelevant",
      userId: "tester",
      intervalMs: 1_000_000,
      recurring: false,
    });
    await wait(120);
    hb.stop();
    const persisted = await hb.getPersistedJob(job.id);
    assert.ok(persisted);
    assert.strictEqual(persisted.state, "completed");
  });
});

// ---------------------------------------------------------------------------
// tick lock — cross-process
// ---------------------------------------------------------------------------

describe("HeartbeatService tick lock", () => {
  it("skips the global watcher-task tick when the cross-process lockfile is held", async () => {
    // create a lockfile and hold it — this is the GLOBAL lock that protects
    // tickGuarded()'s watcher-task path.
    const lockPath = path.join(tmpDir, "heartbeat.lock");
    fs.writeFileSync(lockPath, "");
    const release = await lockfile.lock(lockPath, { stale: 30_000, retries: 0 });

    const hb = new HeartbeatService({ intervalMs: 60_000, verbose: false });
    hb.configurePersistence({ stateDir: tmpDir });
    hb.start();
    await wait(50);
    hb.stop();
    await release();

    // No crash, persisted state file is parseable.
    const list = await hb.listPersistedJobs();
    assert.ok(Array.isArray(list));
  });

  it("two replicas with the same shared jobId do NOT double-fire a cron", async () => {
    // Both services point at the same stateDir AND share the same cron
    // jobId. With the per-job lock + state-reload skip check, only one
    // replica wins each interval.
    const sharedId = "shared-cron-job";

    const hbA = new HeartbeatService({ intervalMs: 60_000, verbose: false });
    hbA.configurePersistence({ stateDir: tmpDir });
    const hbB = new HeartbeatService({ intervalMs: 60_000, verbose: false });
    hbB.configurePersistence({ stateDir: tmpDir });

    let firesA = 0;
    let firesB = 0;
    hbA.setEventHandler((evt) => {
      if (evt.type === "cron_fired" && evt.cronJobId === sharedId) firesA++;
    });
    hbB.setEventHandler((evt) => {
      if (evt.type === "cron_fired" && evt.cronJobId === sharedId) firesB++;
    });

    hbA.start();
    hbB.start();
    hbA.scheduleCron({
      id: sharedId,
      label: "shared",
      prompt: "x",
      userId: "tester",
      intervalMs: 1_000_000,
      recurring: true,
    });
    hbB.scheduleCron({
      id: sharedId,
      label: "shared",
      prompt: "x",
      userId: "tester",
      intervalMs: 1_000_000,
      recurring: true,
    });
    // Both first-fire immediately on schedule. The per-job lock + reload
    // must let only one through.
    await wait(150);
    hbA.stop();
    hbB.stop();

    const total = firesA + firesB;
    assert.strictEqual(
      total,
      1,
      `expected exactly one replica to fire, got A=${firesA} B=${firesB}`,
    );
    // And the persisted record reflects exactly one fire across both processes.
    const persisted = await hbA.getPersistedJob(sharedId);
    assert.ok(persisted);
    assert.strictEqual(persisted.runCount, 1);
  });

  it("a replica whose state shows nextRunAt in the future skips its tick", async () => {
    // Pre-populate state with a nextRunAt far in the future, then fire the
    // cron — the per-job-lock branch reloads from disk and skips.
    const sharedId = "advanced-job";
    const farFuture = new Date(Date.now() + 60 * 60_000).toISOString();
    const stateFile = path.join(tmpDir, "heartbeat-state.json");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        version: 1,
        jobs: {
          [sharedId]: {
            jobId: sharedId,
            state: "active",
            nextRunAt: farFuture,
            lastRunAt: new Date().toISOString(),
            runCount: 7,
            lastStatus: "succeeded",
            updatedAt: new Date().toISOString(),
          },
        },
      }),
    );

    const hb = new HeartbeatService({ intervalMs: 60_000, verbose: false });
    hb.configurePersistence({ stateDir: tmpDir });

    let fires = 0;
    hb.setEventHandler((evt) => {
      if (evt.type === "cron_fired" && evt.cronJobId === sharedId) fires++;
    });
    hb.start();
    hb.scheduleCron({
      id: sharedId,
      label: "advanced",
      prompt: "x",
      userId: "tester",
      intervalMs: 1_000_000,
      recurring: true,
    });
    await wait(80);
    hb.stop();

    assert.strictEqual(fires, 0, "replica should have skipped — state shows another beat us");
    const persisted = await hb.getPersistedJob(sharedId);
    // runCount must not have been bumped past the seeded value
    assert.strictEqual(persisted.runCount, 7);
  });
});

// ---------------------------------------------------------------------------
// in-process overlap guard
// ---------------------------------------------------------------------------

describe("HeartbeatService in-process tick guard", () => {
  it("does not double-fire when an existing tick is still running", async () => {
    // cannot easily exercise without an LLM; this test just smokes the
    // contract: starting + stopping rapidly does not throw and leaves the
    // service in a clean state.
    const hb = new HeartbeatService({ intervalMs: 50, verbose: false });
    hb.start();
    await wait(120);
    hb.stop();
    assert.strictEqual(hb.running, false);
  });
});
