/**
 * Tool-Call Guardrails — test suite
 *
 * Tests for the anti-loop circuit breaker controller. Pure data; no engine
 * dependency, so no fixtures or temp dirs required.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ToolGuardController,
  DEFAULT_IDEMPOTENT_TOOLS,
  DEFAULT_MUTATING_TOOLS,
  hashCanonical,
  digestResult,
} from "../dist/guardrails.js";

import * as publicEntry from "../dist/index.js";

// ---------------------------------------------------------------------------
// hashCanonical / signature stability
// ---------------------------------------------------------------------------

describe("hashCanonical", () => {
  it("produces a stable sha256 hex digest", () => {
    const h = hashCanonical({ a: 1, b: 2 });
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  it("is stable across object key order", () => {
    const a = hashCanonical({ a: 1, b: 2, c: { x: 1, y: 2 } });
    const b = hashCanonical({ c: { y: 2, x: 1 }, b: 2, a: 1 });
    assert.strictEqual(a, b);
  });

  it("preserves array order (arrays are NOT canonicalised)", () => {
    const a = hashCanonical([1, 2, 3]);
    const b = hashCanonical([3, 2, 1]);
    assert.notStrictEqual(a, b);
  });

  it("differs for different values", () => {
    assert.notStrictEqual(hashCanonical({ a: 1 }), hashCanonical({ a: 2 }));
  });
});

describe("ToolGuardController.signature", () => {
  it("returns the same signature for equivalent args", () => {
    const g = new ToolGuardController();
    const a = g.signature("search_documents", { name: "x", limit: 1 });
    const b = g.signature("search_documents", { limit: 1, name: "x" });
    assert.strictEqual(a.toolName, b.toolName);
    assert.strictEqual(a.argsHash, b.argsHash);
  });

  it("returns different signatures for different tool names", () => {
    const g = new ToolGuardController();
    const a = g.signature("search_documents", { name: "x" });
    const b = g.signature("get_document", { name: "x" });
    assert.notStrictEqual(a.argsHash + a.toolName, b.argsHash + b.toolName);
  });
});

// ---------------------------------------------------------------------------
// beforeCall — allow path
// ---------------------------------------------------------------------------

describe("ToolGuardController.beforeCall", () => {
  it("allows a fresh call", () => {
    const g = new ToolGuardController();
    const d = g.beforeCall("search_documents", { name: "x" });
    assert.strictEqual(d.action, "allow");
    assert.ok(d.signature);
    assert.strictEqual(d.signature.toolName, "search_documents");
  });

  it("does not mutate counters on beforeCall", () => {
    const g = new ToolGuardController();
    g.beforeCall("search_documents", { name: "x" });
    g.beforeCall("search_documents", { name: "x" });
    g.beforeCall("search_documents", { name: "x" });
    const snap = g.snapshot();
    assert.strictEqual(snap.consecutiveIdenticalFailures.size, 0);
    assert.strictEqual(snap.perToolFailures.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Identical (tool, args) failure tracking
// ---------------------------------------------------------------------------

describe("identical (tool, args) failure tracking", () => {
  it("warns at identicalFailureWarn (default 3)", () => {
    const g = new ToolGuardController();
    const args = { workflow: "ingest" };

    for (let i = 0; i < 2; i++) {
      g.afterCall("execute_workflow", args, false);
    }
    // 2 prior failures — still allow on the 3rd attempt
    let d = g.beforeCall("execute_workflow", args);
    assert.strictEqual(d.action, "allow");

    g.afterCall("execute_workflow", args, false); // 3rd failure
    d = g.beforeCall("execute_workflow", args);
    assert.strictEqual(d.action, "warn");
    assert.match(d.message, /3 times/);
  });

  it("blocks at identicalFailureBlock (default 5) with syntheticResult", () => {
    const g = new ToolGuardController();
    const args = { workflow: "ingest" };
    for (let i = 0; i < 5; i++) g.afterCall("execute_workflow", args, false);

    const d = g.beforeCall("execute_workflow", args);
    assert.strictEqual(d.action, "block");
    assert.ok(d.syntheticResult);
    assert.strictEqual(typeof d.syntheticResult.error, "string");
    assert.strictEqual(
      d.syntheticResult.guardrail.toolName,
      "execute_workflow",
    );
    assert.strictEqual(
      d.syntheticResult.guardrail.consecutiveIdenticalFailures,
      5,
    );
  });

  it("resets the consecutive-failure streak on success", () => {
    const g = new ToolGuardController();
    const args = { workflow: "ingest" };
    for (let i = 0; i < 4; i++) g.afterCall("execute_workflow", args, false);
    g.afterCall("execute_workflow", args, true); // success resets

    const d = g.beforeCall("execute_workflow", args);
    assert.strictEqual(d.action, "allow");

    const snap = g.snapshot();
    const sigKey = Array.from(snap.consecutiveIdenticalFailures.keys())[0];
    assert.strictEqual(snap.consecutiveIdenticalFailures.get(sigKey), 0);
  });

  it("tracks failures per-signature, not per-tool", () => {
    const g = new ToolGuardController();
    // 3 failures on one set of args, 1 on another — only the first warns
    for (let i = 0; i < 3; i++) {
      g.afterCall("execute_workflow", { workflow: "a" }, false);
    }
    g.afterCall("execute_workflow", { workflow: "b" }, false);

    const dA = g.beforeCall("execute_workflow", { workflow: "a" });
    const dB = g.beforeCall("execute_workflow", { workflow: "b" });
    assert.strictEqual(dA.action, "warn");
    assert.strictEqual(dB.action, "allow");
  });
});

// ---------------------------------------------------------------------------
// Per-tool failure tracking (any-args)
// ---------------------------------------------------------------------------

describe("per-tool failure tracking", () => {
  it("warns at perToolFailureWarn (default 5) regardless of args", () => {
    const g = new ToolGuardController();
    // 5 failures across 5 different arg shapes — none cross the per-sig
    // warn threshold, but the per-tool counter does.
    for (let i = 0; i < 5; i++) {
      g.afterCall("execute_workflow", { i }, false);
    }
    const d = g.beforeCall("execute_workflow", { i: 99 });
    assert.strictEqual(d.action, "warn");
    assert.match(d.message, /5 times this turn/);
  });
});

// ---------------------------------------------------------------------------
// Idempotent same-result repeats
// ---------------------------------------------------------------------------

describe("idempotent same-result repeats", () => {
  it("warns at idempotentRepeatWarn (default 3) when the same digest comes back", () => {
    const g = new ToolGuardController();
    const args = { name: "tv-stat-snapshot" };
    const digest = digestResult({ documents: [], total: 0 });

    for (let i = 0; i < 3; i++) {
      g.afterCall("search_documents", args, true, digest);
    }
    const d = g.beforeCall("search_documents", args);
    assert.strictEqual(d.action, "warn");
    assert.match(d.message, /3 times/);
  });

  it("blocks at idempotentRepeatBlock (default 5) with syntheticResult", () => {
    const g = new ToolGuardController();
    const args = { name: "tv-stat-snapshot" };
    const digest = digestResult({ documents: [], total: 0 });

    for (let i = 0; i < 5; i++) {
      g.afterCall("search_documents", args, true, digest);
    }
    const d = g.beforeCall("search_documents", args);
    assert.strictEqual(d.action, "block");
    assert.ok(d.syntheticResult);
    assert.strictEqual(d.syntheticResult.guardrail.idempotentRepeats, 5);
  });

  it("does NOT count repeats for mutating tools", () => {
    const g = new ToolGuardController();
    const args = { workflow: "publish-approved" };
    const digest = digestResult({ ok: true });

    for (let i = 0; i < 5; i++) {
      g.afterCall("execute_workflow", args, true, digest);
    }
    const d = g.beforeCall("execute_workflow", args);
    assert.strictEqual(d.action, "allow");
  });

  it("does NOT trigger when results differ", () => {
    const g = new ToolGuardController();
    const args = { name: "tv-news-feed" };
    for (let i = 0; i < 5; i++) {
      g.afterCall(
        "search_documents",
        args,
        true,
        digestResult({ tick: i }), // unique each time
      );
    }
    const d = g.beforeCall("search_documents", args);
    assert.strictEqual(d.action, "allow");
  });
});

// ---------------------------------------------------------------------------
// Custom thresholds & options
// ---------------------------------------------------------------------------

describe("custom options", () => {
  it("respects custom identicalFailureWarn / Block thresholds", () => {
    const g = new ToolGuardController({
      identicalFailureWarn: 1,
      identicalFailureBlock: 2,
    });
    g.afterCall("foo", { x: 1 }, false);
    let d = g.beforeCall("foo", { x: 1 });
    assert.strictEqual(d.action, "warn");

    g.afterCall("foo", { x: 1 }, false);
    d = g.beforeCall("foo", { x: 1 });
    assert.strictEqual(d.action, "block");
  });

  it("treats a tool as idempotent when added via custom set", () => {
    const custom = new Set(["my_read_tool"]);
    const g = new ToolGuardController({ idempotentTools: custom });
    assert.ok(g.isIdempotent("my_read_tool"));
    assert.ok(!g.isIdempotent("search_documents")); // overridden
  });
});

// ---------------------------------------------------------------------------
// reset / snapshot
// ---------------------------------------------------------------------------

describe("reset / snapshot", () => {
  it("reset() clears all internal counters", () => {
    const g = new ToolGuardController();
    for (let i = 0; i < 5; i++) g.afterCall("execute_workflow", { i }, false);
    g.afterCall("search_documents", { name: "x" }, true, "digest-1");

    g.reset();

    const snap = g.snapshot();
    assert.strictEqual(snap.consecutiveIdenticalFailures.size, 0);
    assert.strictEqual(snap.perToolFailures.size, 0);
    assert.strictEqual(snap.idempotentResultRepeats.size, 0);
  });

  it("snapshot() returns counts without mutating state", () => {
    const g = new ToolGuardController();
    g.afterCall("execute_workflow", { x: 1 }, false);
    g.afterCall("execute_workflow", { x: 1 }, false);

    const a = g.snapshot();
    const b = g.snapshot();
    assert.strictEqual(a.perToolFailures.get("execute_workflow"), 2);
    assert.strictEqual(b.perToolFailures.get("execute_workflow"), 2);
  });
});

// ---------------------------------------------------------------------------
// Default tool sets
// ---------------------------------------------------------------------------

describe("default tool sets", () => {
  it("DEFAULT_IDEMPOTENT_TOOLS includes the common tv-mcp reads", () => {
    for (const t of [
      "search_documents",
      "get_document",
      "search_workflow",
      "get_workflow_execution",
      "health_check",
    ]) {
      assert.ok(
        DEFAULT_IDEMPOTENT_TOOLS.has(t),
        `expected ${t} in DEFAULT_IDEMPOTENT_TOOLS`,
      );
    }
  });

  it("DEFAULT_MUTATING_TOOLS includes the common tv-mcp mutations", () => {
    for (const t of [
      "execute_workflow",
      "create_document",
      "update_document",
      "delete_document",
      "create_agent",
      "update_agent",
    ]) {
      assert.ok(
        DEFAULT_MUTATING_TOOLS.has(t),
        `expected ${t} in DEFAULT_MUTATING_TOOLS`,
      );
    }
  });

  it("idempotent and mutating sets are disjoint", () => {
    for (const t of DEFAULT_IDEMPOTENT_TOOLS) {
      assert.ok(
        !DEFAULT_MUTATING_TOOLS.has(t),
        `${t} appears in both default sets`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Public entry re-exports
// ---------------------------------------------------------------------------

describe("public entry re-exports", () => {
  it("re-exports ToolGuardController and default sets from index.js", () => {
    assert.strictEqual(
      typeof publicEntry.ToolGuardController,
      "function",
      "ToolGuardController should be re-exported",
    );
    assert.ok(publicEntry.DEFAULT_IDEMPOTENT_TOOLS instanceof Set);
    assert.ok(publicEntry.DEFAULT_MUTATING_TOOLS instanceof Set);
    assert.strictEqual(typeof publicEntry.hashCanonical, "function");
    assert.strictEqual(typeof publicEntry.digestResult, "function");
  });
});
