/**
 * OperatorSinkPlugin — interface + resolver tests.
 *
 * Pins the contract that domain plugins implement and the resolver that
 * picks one based on cfg.sink. External resolution (filesystem path + npm
 * package name) is covered by test/operator-sink-external.test.mjs.
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
// resolveSink — built-in + default
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

  it("returns noopSink when sink is unset", async () => {
    const s = await resolveSink(baseCfg);
    assert.strictEqual(s.name, "noop");
  });

  it("returns noopSink when sink is unset even with tailServer set", async () => {
    // tailServer is a sink-consumed field but no longer triggers any
    // implicit sink resolution — the only built-in is "noop".
    const s = await resolveSink({
      ...baseCfg,
      tailServer: "http://localhost:8090",
    });
    assert.strictEqual(s.name, "noop");
  });

  // External sink resolution (filesystem path + npm package name) is
  // covered by test/operator-sink-external.test.mjs alongside its
  // fixture modules — see that file for path / package / shape cases.
});
