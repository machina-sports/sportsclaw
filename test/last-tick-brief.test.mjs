/**
 * Last-Tick Brief — test suite
 *
 * Per-tick handoff between autonomous runs. Briefs are persisted under
 * `<rootDir>/<jobId>/<tickId>.md`; subsequent ticks pull the most-recent
 * brief into their prompt as context.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  LastTickBrief,
  SILENT_SENTINEL,
  MAX_PAYLOAD_BYTES,
  serializeBrief,
  parseBrief,
  newTickId,
} from "../dist/last-tick-brief.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tick-brief-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// write / loadOne / loadRecent
// ---------------------------------------------------------------------------

describe("LastTickBrief.write", () => {
  it("persists a brief to <rootDir>/<jobId>/<tickId>.md", async () => {
    const ltb = new LastTickBrief(tmpDir);
    const brief = await ltb.write({
      tickId: "tick_001",
      jobId: "plan-run-of-show",
      body: "queued 3 blocks for the next 60 minutes.",
    });
    const filePath = path.join(tmpDir, "plan-run-of-show", "tick_001.md");
    assert.ok(fs.existsSync(filePath));
    assert.strictEqual(brief.tickId, "tick_001");
    assert.strictEqual(brief.jobId, "plan-run-of-show");
    assert.strictEqual(brief.silent, false);
  });

  it("sets silent=true when the body is exactly [SILENT]", async () => {
    const ltb = new LastTickBrief(tmpDir);
    const brief = await ltb.write({ tickId: "t", jobId: "j", body: "[SILENT]" });
    assert.strictEqual(brief.silent, true);
  });

  it("sets silent=true when body is `  [SILENT]  ` (whitespace tolerant)", async () => {
    const ltb = new LastTickBrief(tmpDir);
    const brief = await ltb.write({ tickId: "t", jobId: "j", body: "  [SILENT]  " });
    assert.strictEqual(brief.silent, true);
  });

  it("trims the body before persisting", async () => {
    const ltb = new LastTickBrief(tmpDir);
    const brief = await ltb.write({ tickId: "t", jobId: "j", body: "  hello\n  " });
    assert.strictEqual(brief.body, "hello");
  });

  it("requires a tickId and jobId", async () => {
    const ltb = new LastTickBrief(tmpDir);
    await assert.rejects(() => ltb.write({ tickId: "", jobId: "j", body: "x" }));
    await assert.rejects(() => ltb.write({ tickId: "t", jobId: "", body: "x" }));
  });

  it("sanitises path-traversal attempts in jobId / tickId", async () => {
    const ltb = new LastTickBrief(tmpDir);
    await ltb.write({ tickId: "../escape", jobId: "../also-escape", body: "x" });
    // file should land under tmpDir, not above
    const escaped = path.resolve(tmpDir, "..", "escape.md");
    assert.ok(!fs.existsSync(escaped));
  });

  it("rejects bare '..' as a jobId — file lands inside rootDir", async () => {
    const ltb = new LastTickBrief(tmpDir);
    await ltb.write({ tickId: "t1", jobId: "..", body: "x" });
    // Without the fix, this would land at <tmpDir>/../t1.md
    const escaped = path.resolve(tmpDir, "..", "t1.md");
    assert.ok(!fs.existsSync(escaped), "brief escaped rootDir via jobId='..'");
    // And nothing should be written into rootDir's parent under any name
    const parent = path.dirname(tmpDir);
    const siblings = fs.readdirSync(parent);
    for (const name of siblings) {
      assert.ok(
        !name.endsWith("t1.md"),
        `unexpected sibling file ${name} in ${parent}`,
      );
    }
  });

  it("rejects bare '.' as a jobId — file does not collide with rootDir contents", async () => {
    const ltb = new LastTickBrief(tmpDir);
    await ltb.write({ tickId: "t2", jobId: ".", body: "x" });
    // Without the fix, this would resolve to <tmpDir>/t2.md (in rootDir itself)
    const collision = path.join(tmpDir, "t2.md");
    assert.ok(!fs.existsSync(collision), "brief should not write directly into rootDir");
  });
});

describe("LastTickBrief.loadOne", () => {
  it("loads a previously written brief", async () => {
    const ltb = new LastTickBrief(tmpDir);
    await ltb.write({ tickId: "t1", jobId: "j", body: "first" });
    const loaded = await ltb.loadOne("j", "t1");
    assert.ok(loaded);
    assert.strictEqual(loaded.tickId, "t1");
    assert.strictEqual(loaded.body, "first");
  });

  it("returns null when missing", async () => {
    const ltb = new LastTickBrief(tmpDir);
    const loaded = await ltb.loadOne("j", "missing");
    assert.strictEqual(loaded, null);
  });
});

describe("LastTickBrief.loadRecent", () => {
  it("returns [] when the per-job dir doesn't exist", async () => {
    const ltb = new LastTickBrief(tmpDir);
    const recent = await ltb.loadRecent("nonexistent");
    assert.deepStrictEqual(recent, []);
  });

  it("returns the most recent N briefs newest-first", async () => {
    const ltb = new LastTickBrief(tmpDir);
    // tickIds are sortable lexicographically when generated by newTickId();
    // explicit sequence here for determinism.
    await ltb.write({ tickId: "tick_001", jobId: "j", body: "one" });
    await ltb.write({ tickId: "tick_002", jobId: "j", body: "two" });
    await ltb.write({ tickId: "tick_003", jobId: "j", body: "three" });
    const recent = await ltb.loadRecent("j", 2);
    assert.strictEqual(recent.length, 2);
    assert.strictEqual(recent[0].body, "three");
    assert.strictEqual(recent[1].body, "two");
  });

  it("returns [] for limit=0", async () => {
    const ltb = new LastTickBrief(tmpDir);
    await ltb.write({ tickId: "t", jobId: "j", body: "x" });
    const recent = await ltb.loadRecent("j", 0);
    assert.deepStrictEqual(recent, []);
  });
});

// ---------------------------------------------------------------------------
// contextFrom
// ---------------------------------------------------------------------------

describe("LastTickBrief.contextFrom", () => {
  it("renders sections per job, newest-first within each job", async () => {
    const ltb = new LastTickBrief(tmpDir);
    await ltb.write({ tickId: "tick_001", jobId: "alpha", body: "alpha-one" });
    await ltb.write({ tickId: "tick_002", jobId: "alpha", body: "alpha-two" });
    await ltb.write({ tickId: "tick_001", jobId: "beta", body: "beta-one" });
    const ctx = await ltb.contextFrom(["alpha", "beta"], { perJobLimit: 2 });
    assert.ok(ctx.includes("alpha-two"));
    assert.ok(ctx.includes("alpha-one"));
    assert.ok(ctx.includes("beta-one"));
    // newest-first: alpha-two should appear before alpha-one
    assert.ok(ctx.indexOf("alpha-two") < ctx.indexOf("alpha-one"));
  });

  it("dropSilent filters out silent briefs", async () => {
    const ltb = new LastTickBrief(tmpDir);
    await ltb.write({ tickId: "tick_001", jobId: "j", body: "[SILENT]" });
    await ltb.write({ tickId: "tick_002", jobId: "j", body: "real content" });
    const noisy = await ltb.contextFrom(["j"], { perJobLimit: 5, dropSilent: false });
    assert.ok(noisy.includes("(silent)"));
    const clean = await ltb.contextFrom(["j"], { perJobLimit: 5, dropSilent: true });
    assert.ok(!clean.includes("(silent)"));
    assert.ok(clean.includes("real content"));
  });

  it("truncates to maxChars", async () => {
    const ltb = new LastTickBrief(tmpDir);
    await ltb.write({ tickId: "tick_001", jobId: "j", body: "x".repeat(2000) });
    const ctx = await ltb.contextFrom(["j"], { maxChars: 200 });
    assert.ok(ctx.length <= 220, `got ${ctx.length} chars`);
    assert.ok(ctx.endsWith("[truncated]"));
  });

  it("returns empty string when no briefs exist", async () => {
    const ltb = new LastTickBrief(tmpDir);
    const ctx = await ltb.contextFrom(["nope"]);
    assert.strictEqual(ctx, "");
  });
});

// ---------------------------------------------------------------------------
// silent sentinel
// ---------------------------------------------------------------------------

describe("LastTickBrief.isSilent", () => {
  it("matches the literal sentinel", () => {
    assert.strictEqual(LastTickBrief.isSilent(SILENT_SENTINEL), true);
  });
  it("matches with surrounding whitespace", () => {
    assert.strictEqual(LastTickBrief.isSilent("  [SILENT]\n"), true);
  });
  it("does not match free text containing the token", () => {
    assert.strictEqual(LastTickBrief.isSilent("we returned [SILENT] earlier"), false);
  });
});

// ---------------------------------------------------------------------------
// serializeBrief / parseBrief round-trip
// ---------------------------------------------------------------------------

describe("serializeBrief / parseBrief", () => {
  it("round-trips a brief through serialize → parse", () => {
    const brief = {
      tickId: "tick_001",
      jobId: "plan-run-of-show",
      timestamp: "2026-05-10T20:00:00.000Z",
      body: "ran the planner; 3 blocks queued.",
      silent: false,
    };
    const text = serializeBrief(brief);
    const parsed = parseBrief(text);
    assert.deepStrictEqual(parsed, brief);
  });

  it("rejects text without frontmatter", () => {
    assert.throws(() => parseBrief("# Just a body"));
  });

  it("rejects unterminated frontmatter", () => {
    assert.throws(() => parseBrief("---\ntickId: t\nstill in fm"));
  });

  it("rejects missing required frontmatter fields", () => {
    assert.throws(() => parseBrief("---\ntickId: t\n---\n\nbody"));
  });

  it("round-trips a small payload verbatim", () => {
    const brief = {
      tickId: "tick_pl",
      jobId: "tv-channel-1",
      timestamp: "2026-05-22T12:00:00.000Z",
      body: "Playing live feed.",
      silent: false,
      payload: { remainingPlayoutSec: 420, cue: "midroll_1" },
    };
    const text = serializeBrief(brief);
    const parsed = parseBrief(text);
    assert.deepStrictEqual(parsed.payload, brief.payload);
  });

  it("elides a payload that exceeds MAX_PAYLOAD_BYTES with an _elided marker", () => {
    // Build a payload guaranteed to exceed the cap.
    const big = { junk: "x".repeat(MAX_PAYLOAD_BYTES + 100) };
    const brief = {
      tickId: "tick_big",
      jobId: "tv-channel-1",
      timestamp: "2026-05-22T12:01:00.000Z",
      body: "Tick with oversized payload.",
      silent: false,
      payload: big,
    };
    const text = serializeBrief(brief);

    // The serialized form must NOT contain the original junk string.
    assert.ok(
      !text.includes(big.junk),
      "oversized payload content must not be persisted",
    );

    // The frontmatter must carry an elision marker that re-parses cleanly.
    const parsed = parseBrief(text);
    assert.ok(parsed.payload && typeof parsed.payload === "object");
    assert.strictEqual(parsed.payload._elided, true);
    assert.strictEqual(typeof parsed.payload.approxBytes, "number");
    assert.ok(parsed.payload.approxBytes > MAX_PAYLOAD_BYTES);
  });

  it("does not elide a payload exactly at the cap", () => {
    // A payload whose JSON length is below the cap survives intact.
    // Build one carefully: { "s": "<chars>" } — overhead of `{"s":""}` is 8 bytes.
    const filler = "y".repeat(MAX_PAYLOAD_BYTES - 16);
    const brief = {
      tickId: "tick_edge",
      jobId: "tv-channel-1",
      timestamp: "2026-05-22T12:02:00.000Z",
      body: "Edge case.",
      silent: false,
      payload: { s: filler },
    };
    const parsed = parseBrief(serializeBrief(brief));
    assert.deepStrictEqual(parsed.payload, brief.payload);
  });
});

// ---------------------------------------------------------------------------
// newTickId
// ---------------------------------------------------------------------------

describe("newTickId", () => {
  it("returns a string starting with `tick_`", () => {
    const id = newTickId();
    assert.match(id, /^tick_\d+_[a-z0-9]+$/);
  });

  it("returns sortable ids when called in sequence", async () => {
    const a = newTickId();
    await new Promise((r) => setTimeout(r, 5));
    const b = newTickId();
    assert.ok(a < b, `expected ${a} < ${b}`);
  });
});
