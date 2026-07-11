/**
 * stripInternalEvidenceArtifacts — deterministic cleanup of internal
 * evidence-gate bookkeeping from user-facing text. The self-correction
 * banner and [Tool N] citations must never reach users, while real answer
 * content (teams, venues) must survive untouched.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { stripInternalEvidenceArtifacts } from "../dist/engine.js";

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
