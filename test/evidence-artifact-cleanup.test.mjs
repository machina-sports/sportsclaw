/**
 * stripInternalEvidenceArtifacts — deterministic cleanup of internal
 * evidence-gate bookkeeping from user-facing text. The self-correction
 * banner and [Tool N] citations must never reach users, while real answer
 * content (teams, venues) must survive untouched.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  stripInternalEvidenceArtifacts,
  summarizeToolOutputForEvidence,
} from "../dist/engine.js";

describe("stripInternalEvidenceArtifacts", () => {
  it("removes the self-correction warning banner", () => {
    const input =
      "⚠️ Self-correction pass completed: verified and aligned response with raw data.\n\n" +
      "Norway vs England kicks off today at Hard Rock Stadium.";
    const out = stripInternalEvidenceArtifacts(input);
    assert.ok(!/self-correction/i.test(out), "warning banner should be gone");
    assert.ok(!out.includes("⚠️"), "warning emoji should be gone");
    assert.ok(out.includes("Norway vs England"), "real content preserved");
    assert.ok(out.includes("Hard Rock Stadium"), "venue preserved");
  });

  it("removes [Tool N] and [Tool N: name] citation markers", () => {
    const input =
      "Norway vs England [Tool 10] is scheduled at Hard Rock Stadium " +
      "[Tool 1, Tool 6]. Kickoff confirmed [Tool 1: worldcup-get-schedule].";
    const out = stripInternalEvidenceArtifacts(input);
    assert.ok(!/\[Tool\s*\d/i.test(out), "no [Tool N] markers should remain");
    assert.ok(!out.includes("worldcup-get-schedule"), "tool label stripped");
    assert.ok(out.includes("Norway vs England"), "real content preserved");
    assert.ok(out.includes("Hard Rock Stadium"), "venue preserved");
    assert.ok(!/\s{2,}/.test(out), "no doubled whitespace left behind");
  });

  it("removes raw mcp__server__tool identifiers", () => {
    const input =
      "Fetched via mcp__world-cup-mcp__execute_workflow — Norway vs England at Hard Rock Stadium.";
    const out = stripInternalEvidenceArtifacts(input);
    assert.ok(!/mcp__/.test(out), "internal mcp identifier stripped");
    assert.ok(out.includes("Norway vs England"), "real content preserved");
  });

  it("removes internal source labels from evidence validation prompts", () => {
    const input =
      "Norway vs England [Internal source 1 — private, never cite] is at Hard Rock Stadium.";
    const out = stripInternalEvidenceArtifacts(input);
    assert.ok(!/internal source/i.test(out), "internal source label stripped");
    assert.ok(out.includes("Norway vs England"), "real content preserved");
    assert.ok(out.includes("Hard Rock Stadium"), "venue preserved");
  });

  it("leaves clean text untouched", () => {
    const input = "Norway vs England kicks off at Hard Rock Stadium.";
    assert.equal(stripInternalEvidenceArtifacts(input), input);
  });
});

describe("summarizeToolOutputForEvidence", () => {
  it("compacts an oversized pretty-JSON string, keeping beginning and end facts under the limit", () => {
    // Mirrors the production worldcup-get-schedule payload: pretty JSON is
    // >4000 chars while its compact form is well under, so a head-only slice
    // would drop the final venue.
    const matches = Array.from({ length: 26 }, (_, i) => ({
      matchId: 1000 + i,
      stage: "group",
      home: `Team Home ${i}`,
      away: `Team Away ${i}`,
      kickoff: "2026-06-15T18:00:00Z",
      venue: `Stadium ${i}`,
    }));
    const payload = {
      tournament: "World Cup",
      firstVenue: "Hard Rock Stadium",
      matches,
      finalVenue: "New York New Jersey Stadium",
    };
    const pretty = JSON.stringify(payload, null, 2);
    const compact = JSON.stringify(payload);

    // Precondition: reproduces the production shape (pretty > limit, compact within).
    assert.ok(pretty.length > 4000, `pretty JSON must exceed 4000 (was ${pretty.length})`);
    assert.ok(compact.length <= 4000, `compact JSON must be within 4000 (was ${compact.length})`);

    const out = summarizeToolOutputForEvidence(pretty);

    assert.ok(out.length <= 4000, `summary must stay within 4000 (was ${out.length})`);
    assert.ok(out.includes("Hard Rock Stadium"), "beginning fact preserved");
    assert.ok(
      out.includes("New York New Jersey Stadium"),
      "ending fact preserved (the final venue must survive)"
    );
  });

  it("balances head and tail when truncating an oversized non-JSON string", () => {
    const prefix = "PREFIX_MARKER_START";
    const suffix = "SUFFIX_MARKER_END";
    const input = `${prefix} ${"filler ".repeat(1000)} ${suffix}`;
    assert.ok(input.length > 4000, "input must exceed 4000 to force truncation");
    assert.ok(!isJson(input), "input must not be valid JSON");

    const out = summarizeToolOutputForEvidence(input);

    assert.ok(out.length <= 4000, `summary must stay within 4000 (was ${out.length})`);
    assert.ok(out.includes(prefix), "head prefix preserved");
    assert.ok(out.includes(suffix), "tail suffix preserved");
  });

  it("compacts pretty JSON carried inside a legacy {content:string} envelope", () => {
    // Legacy supported envelope: the payload is a pretty-printed JSON string
    // nested under `content`. It must go through the same compaction as a bare
    // string so the whole payload survives instead of a head+tail slice that
    // drops the middle.
    const matches = Array.from({ length: 26 }, (_, i) => ({
      matchId: 1000 + i,
      stage: "group",
      home: `Team Home ${i}`,
      away: `Team Away ${i}`,
      kickoff: "2026-06-15T18:00:00Z",
      venue: `Stadium ${i}`,
    }));
    const payload = {
      tournament: "World Cup",
      firstVenue: "Hard Rock Stadium",
      matches,
      finalVenue: "New York New Jersey Stadium",
    };
    const pretty = JSON.stringify(payload, null, 2);
    const compact = JSON.stringify(payload);
    assert.ok(pretty.length > 4000, `pretty JSON must exceed 4000 (was ${pretty.length})`);
    assert.ok(compact.length <= 4000, `compact JSON must be within 4000 (was ${compact.length})`);

    const out = summarizeToolOutputForEvidence({ content: pretty });

    assert.ok(out.length <= 4000, `summary must stay within 4000 (was ${out.length})`);
    assert.ok(out.includes("Hard Rock Stadium"), "beginning fact preserved");
    assert.ok(out.includes("Stadium 13"), "middle fact preserved (compaction kept the whole payload)");
    assert.ok(
      out.includes("New York New Jersey Stadium"),
      "late fact preserved (the final venue must survive)"
    );
  });

  it("balanced-truncates a {content:string} JSON payload that stays oversized after compaction", () => {
    const matches = Array.from({ length: 60 }, (_, i) => ({
      matchId: 1000 + i,
      stage: "group",
      home: `TeamHome${i}`,
      away: `TeamAway${i}`,
      kickoff: "2026-06-15T18:00:00Z",
      venue: `Stadium${i}`,
    }));
    const payload = {
      headMarker: "HARDROCKSTADIUM",
      matches,
      tailMarker: "NEWYORKNEWJERSEYSTADIUM",
    };
    const pretty = JSON.stringify(payload, null, 2);
    const compact = JSON.stringify(payload);
    assert.ok(compact.length > 4000, `compact JSON must exceed 4000 (was ${compact.length})`);

    const out = summarizeToolOutputForEvidence({ content: pretty });

    assert.ok(out.length <= 4000, `summary must stay within 4000 (was ${out.length})`);
    assert.ok(out.includes("HARDROCKSTADIUM"), "head marker preserved");
    assert.ok(out.includes("NEWYORKNEWJERSEYSTADIUM"), "tail marker preserved");
    // Compaction must have run: pretty-print indentation must not survive.
    assert.ok(!out.includes("  "), "no pretty-print indentation should remain (payload was compacted)");
  });

  it("never throws for unexpected top-level values", () => {
    const cyclic = {};
    cyclic.self = cyclic;
    assert.doesNotThrow(() => summarizeToolOutputForEvidence(undefined), "undefined must not throw");
    assert.doesNotThrow(() => summarizeToolOutputForEvidence(() => 42), "function must not throw");
    assert.doesNotThrow(() => summarizeToolOutputForEvidence(Symbol("x")), "symbol must not throw");
    assert.doesNotThrow(() => summarizeToolOutputForEvidence(10n), "BigInt must not throw");
    assert.doesNotThrow(() => summarizeToolOutputForEvidence(cyclic), "cyclic object must not throw");
    // Each must yield a string (the safe deterministic fallback).
    assert.equal(typeof summarizeToolOutputForEvidence(undefined), "string");
    assert.equal(typeof summarizeToolOutputForEvidence(10n), "string");
    assert.equal(typeof summarizeToolOutputForEvidence(cyclic), "string");
  });

  it("returns an exactly-4000-char string unchanged", () => {
    const input = "x".repeat(4000);
    assert.equal(input.length, 4000);
    const out = summarizeToolOutputForEvidence(input);
    assert.equal(out, input);
    assert.equal(out.length, 4000);
  });

  it("bounds a 4001-char string to <=4000 while preserving both ends", () => {
    const input = `HEAD${"x".repeat(3993)}TAIL`;
    assert.equal(input.length, 4001);
    const out = summarizeToolOutputForEvidence(input);
    assert.ok(out.length <= 4000, `summary must stay within 4000 (was ${out.length})`);
    assert.ok(out.startsWith("HEAD"), "head preserved");
    assert.ok(out.endsWith("TAIL"), "tail preserved");
  });
});

function isJson(value) {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
