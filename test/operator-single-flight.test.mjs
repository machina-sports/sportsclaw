/**
 * Operator daemon — tick single-flight, awaited hooks, and drain (PR1).
 *
 * Injects a mock generateText that tracks concurrency + an onTickEvent hook, so
 * we can assert: only one inference runs at a time under manual/timer pressure,
 * tickOnce() awaits the sink hook, and drain() waits for the active tick and
 * starts no new inference.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { createOperatorDaemon } from "../dist/operator-daemon.js";
import { HeartbeatService } from "../dist/heartbeat.js";

let tmpDir;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "single-flight-")); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** generateText stub that tracks max concurrency + call/done counts. */
function makeConcurrencyGen(sleepMs) {
  let active = 0;
  const stats = { max: 0, calls: 0, done: 0 };
  const impl = async () => {
    active++; stats.calls++; stats.max = Math.max(stats.max, active);
    await wait(sleepMs);
    active--; stats.done++;
    return { text: "ok" };
  };
  impl.stats = stats;
  return impl;
}

function baseConfig(overrides = {}) {
  return {
    jobId: "single-flight-test",
    intervalMs: 60_000,
    rootDir: tmpDir,
    role: "You are a test operator.",
    model: { name: "mock-model" },
    heartbeat: new HeartbeatService(),
    persistence: false, // in-memory; no lock/fs timing in these tests
    generateTextImpl: makeConcurrencyGen(60),
    ...overrides,
  };
}

describe("tick single-flight + drain (PR1)", () => {
  it("serializes concurrent manual ticks — inference concurrency stays 1", async () => {
    const gen = makeConcurrencyGen(50);
    const d = createOperatorDaemon(baseConfig({ generateTextImpl: gen }));
    const events = await Promise.all([d.tickOnce(), d.tickOnce(), d.tickOnce(), d.tickOnce()]);
    assert.equal(gen.stats.max, 1, "no two inferences overlapped");
    assert.equal(gen.stats.calls, 4, "all four ticks ran (FIFO)");
    assert.ok(events.every((e) => e.type === "tick_published" || e.type === "tick_silent"));
  });

  it("tickOnce() awaits the onTickEvent hook (>= 200ms hook keeps it pending)", async () => {
    let hits = 0;
    const onTickEvent = async () => { hits++; await wait(120); };
    const d = createOperatorDaemon(baseConfig({ onTickEvent }));
    const t0 = Date.now();
    await d.tickOnce();
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 200, `tickOnce should await hooks (elapsed=${elapsed}ms)`);
    assert.ok(hits >= 2, "hook fired for tick_started and the terminal event");
  });

  it("recurring cron fire during an active tick is skipped (no overlap)", async () => {
    const gen = makeConcurrencyGen(120);
    const d = createOperatorDaemon(baseConfig({ intervalMs: 50, generateTextImpl: gen }));
    d.start();
    await wait(320);
    await d.drain();
    assert.equal(gen.stats.max, 1, "cron fires never overlapped the running tick");
  });

  it("wakeGate denial skips ticks with zero model calls (cheap wake)", async () => {
    const gen = makeConcurrencyGen(30);
    const d = createOperatorDaemon(baseConfig({
      intervalMs: 40,
      generateTextImpl: gen,
      wakeGate: () => ({ wake: false, reason: "no pending work" }),
    }));
    d.start();
    await wait(220); // several cron fires, all wake-denied
    await d.drain();
    assert.equal(gen.stats.calls, 0, "wake gate denied every fire → no inference");
  });

  it("drain() waits for the active tick and starts no new inference", async () => {
    const gen = makeConcurrencyGen(120);
    const d = createOperatorDaemon(baseConfig({ generateTextImpl: gen }));
    const p = d.tickOnce();
    await wait(20); // let the tick begin
    await d.drain(); // must not resolve until the active tick finished
    assert.equal(gen.stats.done, 1, "drain awaited the in-flight tick");
    await p;
    const before = gen.stats.calls;
    await wait(60);
    assert.equal(gen.stats.calls, before, "drain started no new inference");
  });
});
