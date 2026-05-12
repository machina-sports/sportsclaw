/**
 * OperatorSinkPlugin — interface + resolver tests.
 *
 * Pins the contract that domain plugins implement and the resolver that
 * picks one based on cfg.sink / cfg.tailServer. Tests live in sportsclaw
 * core because the resolver itself does (the broadcast sink itself moves
 * to TV repo in the follow-up).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { noopSink, resolveSink } from "../dist/operator-sink.js";

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

  it("returns noopSink for cfg.sink=\"noop\"", async () => {
    const s = await resolveSink({ ...baseCfg, sink: "noop" });
    assert.strictEqual(s.name, "noop");
  });

  it("returns the broadcast sink for cfg.sink=\"broadcast\"", async () => {
    const s = await resolveSink({ ...baseCfg, sink: "broadcast" });
    assert.strictEqual(s.name, "broadcast");
  });

  it("falls back to broadcast when cfg.tailServer is set (backward compat)", async () => {
    const s = await resolveSink({ ...baseCfg, tailServer: "http://localhost:8090" });
    assert.strictEqual(s.name, "broadcast");
  });

  it("returns noopSink when neither sink nor tailServer is set", async () => {
    const s = await resolveSink(baseCfg);
    assert.strictEqual(s.name, "noop");
  });

  it("throws a clear error for unknown sink names (until external resolver lands)", async () => {
    await assert.rejects(
      resolveSink({ ...baseCfg, sink: "@example/some-other-sink" }),
      /not a built-in/i,
    );
  });

  it("prefers cfg.sink over cfg.tailServer when both are set", async () => {
    const s = await resolveSink({
      ...baseCfg,
      sink: "noop",
      tailServer: "http://localhost:8090",
    });
    assert.strictEqual(s.name, "noop");
  });
});
