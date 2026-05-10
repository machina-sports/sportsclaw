/**
 * Wake gate — focused tests
 *
 * Covers:
 *   - HeartbeatStateStore.markRunSkipped + skipCount + lastSkipReason
 *   - HeartbeatService cron flow with a wake gate (allow / deny / throw)
 *   - cron_skipped event vs cron_fired event
 *   - wakeContext propagation on cron_fired
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { HeartbeatService } from "../dist/heartbeat.js";
import { HeartbeatStateStore } from "../dist/heartbeat-state.js";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-gate-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// HeartbeatStateStore.markRunSkipped
// ---------------------------------------------------------------------------

describe("HeartbeatStateStore.markRunSkipped", () => {
  it("creates a fresh record with skipCount=1 when none exists", async () => {
    const store = new HeartbeatStateStore(path.join(tmpDir, "state.json"));
    const state = await store.markRunSkipped("job-1", {
      intervalMs: 60_000,
      reason: "no work to do",
    });
    assert.strictEqual(state.runCount, 0);
    assert.strictEqual(state.skipCount, 1);
    assert.strictEqual(state.lastStatus, "skipped");
    assert.strictEqual(state.lastSkipReason, "no work to do");
    assert.ok(state.lastSkipAt);
  });

  it("does NOT bump runCount", async () => {
    const store = new HeartbeatStateStore(path.join(tmpDir, "state.json"));
    await store.markRunStart("job-1", { intervalMs: 1000 });
    await store.markRunStart("job-1", { intervalMs: 1000 });
    await store.markRunSkipped("job-1", { intervalMs: 1000, reason: "quiet" });
    const final = store.get("job-1");
    assert.strictEqual(final.runCount, 2);
    assert.strictEqual(final.skipCount, 1);
  });

  it("preserves nextRunAt from a prior run rather than overwriting", async () => {
    const store = new HeartbeatStateStore(path.join(tmpDir, "state.json"));
    const first = await store.markRunStart("job-1", { intervalMs: 60_000 });
    await store.markRunSkipped("job-1", { intervalMs: 60_000, reason: "x" });
    const after = store.get("job-1");
    assert.strictEqual(after.nextRunAt, first.nextRunAt);
  });

  it("preserves lastError from a prior failure", async () => {
    const store = new HeartbeatStateStore(path.join(tmpDir, "state.json"));
    await store.markRunStart("job-1", { intervalMs: 1000 });
    await store.markRunFailed("job-1", new Error("oops"));
    await store.markRunSkipped("job-1", { intervalMs: 1000, reason: "quiet" });
    const after = store.get("job-1");
    assert.strictEqual(after.lastStatus, "skipped");
    assert.strictEqual(after.lastError, "oops");
  });

  it("starts a fresh run cleanly after skips (lastStatus flips to running)", async () => {
    const store = new HeartbeatStateStore(path.join(tmpDir, "state.json"));
    await store.markRunSkipped("job-1", { intervalMs: 1000, reason: "x" });
    await store.markRunSkipped("job-1", { intervalMs: 1000, reason: "y" });
    await store.markRunStart("job-1", { intervalMs: 1000 });
    const state = store.get("job-1");
    assert.strictEqual(state.runCount, 1);
    assert.strictEqual(state.skipCount, 2);
    assert.strictEqual(state.lastStatus, "running");
  });

  it("survives reload (skip metadata is persisted)", async () => {
    const a = new HeartbeatStateStore(path.join(tmpDir, "state.json"));
    await a.markRunSkipped("job-1", { intervalMs: 1000, reason: "no input" });
    const b = new HeartbeatStateStore(path.join(tmpDir, "state.json"));
    await b.load();
    const state = b.get("job-1");
    assert.strictEqual(state.skipCount, 1);
    assert.strictEqual(state.lastSkipReason, "no input");
  });
});

// ---------------------------------------------------------------------------
// HeartbeatService cron with wake gate
// ---------------------------------------------------------------------------

describe("HeartbeatService cron + wake gate", () => {
  it("ALLOW gate: emits cron_fired with wakeContext, bumps runCount", async () => {
    const fires = [];
    const skips = [];
    const hb = new HeartbeatService({ intervalMs: 60_000 });
    hb.configurePersistence({ stateDir: tmpDir });
    hb.setEventHandler((evt) => {
      if (evt.type === "cron_fired") fires.push(evt);
      if (evt.type === "cron_skipped") skips.push(evt);
    });
    hb.start();
    const job = hb.scheduleCron({
      label: "always-on",
      prompt: "ignored",
      userId: "tester",
      intervalMs: 1_000_000,
      recurring: true,
      wakeGate: () => ({ wake: true, context: "fixtures-changed" }),
    });
    await wait(80);
    hb.stop();

    assert.strictEqual(fires.length, 1, "expected one cron_fired event");
    assert.strictEqual(skips.length, 0, "should not skip when gate allows");
    assert.strictEqual(fires[0].wakeContext, "fixtures-changed");
    const persisted = await hb.getPersistedJob(job.id);
    assert.strictEqual(persisted.runCount, 1);
    assert.strictEqual(persisted.skipCount, 0);
    assert.strictEqual(persisted.lastStatus, "running");
  });

  it("DENY gate: emits cron_skipped, runCount unchanged, skipCount bumps", async () => {
    const fires = [];
    const skips = [];
    const hb = new HeartbeatService({ intervalMs: 60_000 });
    hb.configurePersistence({ stateDir: tmpDir });
    hb.setEventHandler((evt) => {
      if (evt.type === "cron_fired") fires.push(evt);
      if (evt.type === "cron_skipped") skips.push(evt);
    });
    hb.start();
    const job = hb.scheduleCron({
      label: "gated-off",
      prompt: "ignored",
      userId: "tester",
      intervalMs: 1_000_000,
      recurring: true,
      wakeGate: () => ({ wake: false, reason: "no fresh fixtures" }),
    });
    await wait(80);
    hb.stop();

    assert.strictEqual(fires.length, 0, "no cron_fired when gate denies");
    assert.strictEqual(skips.length, 1, "expected one cron_skipped");
    assert.strictEqual(skips[0].result, "no fresh fixtures");
    const persisted = await hb.getPersistedJob(job.id);
    assert.strictEqual(persisted.runCount, 0);
    assert.strictEqual(persisted.skipCount, 1);
    assert.strictEqual(persisted.lastStatus, "skipped");
    assert.strictEqual(persisted.lastSkipReason, "no fresh fixtures");
  });

  it("DENY without explicit reason: records 'wake gate denied'", async () => {
    const skips = [];
    const hb = new HeartbeatService({ intervalMs: 60_000 });
    hb.configurePersistence({ stateDir: tmpDir });
    hb.setEventHandler((evt) => {
      if (evt.type === "cron_skipped") skips.push(evt);
    });
    hb.start();
    const job = hb.scheduleCron({
      label: "no-reason",
      prompt: "x",
      userId: "tester",
      intervalMs: 1_000_000,
      recurring: true,
      wakeGate: () => ({ wake: false }),
    });
    await wait(80);
    hb.stop();

    assert.strictEqual(skips.length, 1);
    const persisted = await hb.getPersistedJob(job.id);
    assert.match(persisted.lastSkipReason, /denied/i);
  });

  it("ASYNC gate is awaited", async () => {
    const fires = [];
    const hb = new HeartbeatService({ intervalMs: 60_000 });
    hb.configurePersistence({ stateDir: tmpDir });
    hb.setEventHandler((evt) => {
      if (evt.type === "cron_fired") fires.push(evt);
    });
    hb.start();
    hb.scheduleCron({
      label: "async-gate",
      prompt: "x",
      userId: "tester",
      intervalMs: 1_000_000,
      recurring: true,
      wakeGate: async () => {
        await wait(20);
        return { wake: true, context: "via-async" };
      },
    });
    await wait(120);
    hb.stop();

    assert.strictEqual(fires.length, 1);
    assert.strictEqual(fires[0].wakeContext, "via-async");
  });

  it("THROWING gate fails closed (treated as denied) and recorded", async () => {
    const fires = [];
    const skips = [];
    const hb = new HeartbeatService({ intervalMs: 60_000 });
    hb.configurePersistence({ stateDir: tmpDir });
    hb.setEventHandler((evt) => {
      if (evt.type === "cron_fired") fires.push(evt);
      if (evt.type === "cron_skipped") skips.push(evt);
    });
    hb.start();
    const job = hb.scheduleCron({
      label: "broken-gate",
      prompt: "x",
      userId: "tester",
      intervalMs: 1_000_000,
      recurring: true,
      wakeGate: () => {
        throw new Error("upstream 503");
      },
    });
    await wait(80);
    hb.stop();

    assert.strictEqual(fires.length, 0, "must not fire when gate throws");
    assert.strictEqual(skips.length, 1);
    assert.match(skips[0].error ?? "", /503/);
    const persisted = await hb.getPersistedJob(job.id);
    assert.strictEqual(persisted.skipCount, 1);
    assert.match(persisted.lastSkipReason, /threw/i);
  });

  it("gate sees a frozen job snapshot WITHOUT the wakeGate function", async () => {
    let observed = null;
    const hb = new HeartbeatService({ intervalMs: 60_000 });
    hb.start();
    hb.scheduleCron({
      label: "introspect",
      prompt: "p",
      userId: "tester",
      intervalMs: 1_000_000,
      recurring: true,
      wakeGate: (ctx) => {
        observed = ctx;
        return { wake: false, reason: "done" };
      },
    });
    await wait(60);
    hb.stop();

    assert.ok(observed);
    assert.strictEqual(observed.job.label, "introspect");
    assert.strictEqual(observed.job.prompt, "p");
    assert.strictEqual(observed.job.wakeGate, undefined);
  });

  it("missing gate behaves as before (always fires)", async () => {
    const fires = [];
    const hb = new HeartbeatService({ intervalMs: 60_000 });
    hb.configurePersistence({ stateDir: tmpDir });
    hb.setEventHandler((evt) => {
      if (evt.type === "cron_fired") fires.push(evt);
    });
    hb.start();
    hb.scheduleCron({
      label: "no-gate",
      prompt: "x",
      userId: "tester",
      intervalMs: 1_000_000,
      recurring: true,
      // no wakeGate
    });
    await wait(80);
    hb.stop();

    assert.strictEqual(fires.length, 1);
    assert.strictEqual(fires[0].wakeContext, undefined);
  });
});

// ---------------------------------------------------------------------------
// markJobSkipped public API
// ---------------------------------------------------------------------------

describe("HeartbeatService.markJobSkipped", () => {
  it("records a skip via the public surface", async () => {
    const hb = new HeartbeatService({ intervalMs: 60_000 });
    hb.configurePersistence({ stateDir: tmpDir });
    hb.start();
    const job = hb.scheduleCron({
      label: "manual-skip-target",
      prompt: "x",
      userId: "tester",
      intervalMs: 5_000,
      recurring: true,
      wakeGate: () => ({ wake: true }), // gate allows; we'll skip externally
    });
    // wait so the gate fires once and bumps runCount
    await wait(60);
    await hb.markJobSkipped(job.id, "ops paused upstream");
    hb.stop();
    const persisted = await hb.getPersistedJob(job.id);
    assert.strictEqual(persisted.lastStatus, "skipped");
    assert.strictEqual(persisted.lastSkipReason, "ops paused upstream");
    assert.ok(persisted.skipCount >= 1);
  });

  it("noops cleanly when persistence is off", async () => {
    const hb = new HeartbeatService({ intervalMs: 60_000 });
    await hb.markJobSkipped("nope", "irrelevant");
    // simply did not throw
  });
});
