import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runSelftest } from "../dist/selftest/runner.js";
import { renderMarkdown } from "../dist/selftest/report.js";

describe("runSelftest", () => {
  it("returns one result per case for the requested sport (offline)", async () => {
    const report = await runSelftest({
      sports: ["metadata"],
      live: false,
      execute: async () => ({ ok: true, latencyMs: 1, note: "stub" }),
    });
    assert.ok(report.results.length >= 1);
    assert.equal(report.results[0].sport, "metadata");
    assert.equal(report.failed, 0);
  });

  it("produces a JSON-serializable report", async () => {
    const report = await runSelftest({
      sports: ["metadata"],
      live: false,
      execute: async () => ({ ok: true, latencyMs: 1 }),
    });
    const json = JSON.stringify(report.toJSON());
    assert.ok(json.includes("passed"));
  });

  it("marks a failing case as fail with a note", async () => {
    const report = await runSelftest({
      sports: ["metadata"],
      live: true,
      execute: async () => ({ ok: false, latencyMs: 2, note: "401 auth" }),
    });
    assert.equal(report.failed >= 1, true);
    assert.equal(report.results.some((r) => r.status === "fail"), true);
  });

  it("marks a throwing execute case as fail and continues without rejecting", async () => {
    const report = await runSelftest({
      sports: ["metadata"],
      live: true,
      execute: async () => { throw new Error("boom"); },
    });
    assert.equal(report.results.length >= 1, true);
    assert.equal(report.results.every((r) => r.status === "fail"), true);
  });

  it("marks an executor-signaled skip as skip, not pass", async () => {
    const report = await runSelftest({
      sports: ["metadata"],
      live: true,
      execute: async () => ({ ok: true, skip: true, latencyMs: 0, note: "skipped (quick)" }),
    });
    assert.equal(report.passed, 0);
    assert.equal(report.skipped >= 1, true);
    assert.equal(report.results.every((r) => r.status === "skip"), true);
  });

  it("renders a markdown table with a header row", () => {
    const md = renderMarkdown({
      version: "0.29.1", passed: 1, failed: 0, skipped: 0,
      results: [{ sport: "nba", check: "scoreboard", status: "pass", latencyMs: 431, notes: "6 games" }],
      toJSON() { return {}; },
    });
    assert.ok(md.includes("Sport"));
    assert.ok(md.includes("nba"));
  });
});
