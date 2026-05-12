/**
 * OperatorSinkPlugin — interface + resolver tests.
 *
 * Pins the contract that domain plugins implement and the resolver that
 * picks one based on cfg.sink / cfg.tailServer. Tests live in sportsclaw
 * core because the resolver itself does (the broadcast sink itself moves
 * to TV repo in the follow-up).
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";

import { noopSink, resolveSink } from "../dist/operator-sink.js";

// ---------------------------------------------------------------------------
// stderr capture — the bundled broadcast sink emits a deprecation warning
// on every resolution. Capture stderr per-test so the assertions can pin it
// AND so the warning doesn't pollute the test run output.
// ---------------------------------------------------------------------------

function captureStderr() {
  const original = process.stderr.write;
  const chunks = [];
  process.stderr.write = (chunk) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  return {
    text: () => chunks.join(""),
    restore: () => { process.stderr.write = original; },
  };
}

// ---------------------------------------------------------------------------
// noopSink contract
// ---------------------------------------------------------------------------

describe("noopSink", () => {
  it("is named \"noop\"", () => {
    assert.strictEqual(noopSink.name, "noop");
  });

  it("implements none of the optional hooks", () => {
    assert.strictEqual(noopSink.registerTools, undefined);
    assert.strictEqual(noopSink.wrapImageGenerator, undefined);
    assert.strictEqual(noopSink.onTickEvent, undefined);
    assert.strictEqual(noopSink.onToolCall, undefined);
  });
});

// ---------------------------------------------------------------------------
// resolveSink — backward compat + explicit selection
// ---------------------------------------------------------------------------

describe("resolveSink", () => {
  const baseCfg = {
    jobId: "j",
    intervalMs: 60_000,
    personaText: "x",
  };

  let capture;
  beforeEach(() => {
    capture = captureStderr();
  });
  afterEach(() => {
    capture.restore();
  });

  it("returns noopSink for cfg.sink=\"noop\"", async () => {
    const s = await resolveSink({ ...baseCfg, sink: "noop" });
    assert.strictEqual(s.name, "noop");
    assert.strictEqual(capture.text(), "", "noop must not emit any deprecation warning");
  });

  it("returns the broadcast sink for cfg.sink=\"broadcast\" (with deprecation warning)", async () => {
    const s = await resolveSink({ ...baseCfg, sink: "broadcast" });
    assert.strictEqual(s.name, "broadcast");
    assert.match(capture.text(), /DEPRECATED/);
    assert.match(capture.text(), /@machina-sports\/tv-operator-sink/);
  });

  it("falls back to broadcast when cfg.tailServer is set (with deprecation warning)", async () => {
    const s = await resolveSink({ ...baseCfg, tailServer: "http://localhost:8090" });
    assert.strictEqual(s.name, "broadcast");
    assert.match(capture.text(), /DEPRECATED/);
    assert.match(capture.text(), /falling back to the BUNDLED broadcast sink/i);
  });

  it("returns noopSink when neither sink nor tailServer is set (no warning)", async () => {
    const s = await resolveSink(baseCfg);
    assert.strictEqual(s.name, "noop");
    assert.strictEqual(capture.text(), "");
  });

  it("prefers cfg.sink over cfg.tailServer when both are set", async () => {
    const s = await resolveSink({
      ...baseCfg,
      sink: "noop",
      tailServer: "http://localhost:8090",
    });
    assert.strictEqual(s.name, "noop");
    assert.strictEqual(capture.text(), "");
  });

  it("SPORTSCLAW_SUPPRESS_DEPRECATION=1 silences the warning", async () => {
    const prev = process.env.SPORTSCLAW_SUPPRESS_DEPRECATION;
    process.env.SPORTSCLAW_SUPPRESS_DEPRECATION = "1";
    try {
      const s = await resolveSink({ ...baseCfg, sink: "broadcast" });
      assert.strictEqual(s.name, "broadcast");
      assert.strictEqual(capture.text(), "");
    } finally {
      if (prev === undefined) delete process.env.SPORTSCLAW_SUPPRESS_DEPRECATION;
      else process.env.SPORTSCLAW_SUPPRESS_DEPRECATION = prev;
    }
  });

  // External sink resolution (filesystem path + npm package name) is
  // covered by test/operator-sink-external.test.mjs alongside its
  // fixture modules — see that file for path / package / shape cases.
});
