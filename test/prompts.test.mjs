/**
 * Prompt fragments + system-prompt builder — test suite
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildSystemPrompt,
  CRON_AUTONOMY_FRAGMENT,
  TOOL_DISCIPLINE_FRAGMENT,
  SILENT_SENTINEL_FRAGMENT,
  BROADCAST_DIRECTIVE_FRAGMENT,
  EDITORIAL_MEMORY_FRAGMENT_HEADER,
  TICK_BRIEF_FRAGMENT_HEADER,
  SILENT_SENTINEL_TOKEN,
} from "../dist/prompts.js";

import { SILENT_SENTINEL } from "../dist/last-tick-brief.js";

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

describe("fragments", () => {
  it("CRON_AUTONOMY_FRAGMENT mentions 'no human present'", () => {
    assert.match(CRON_AUTONOMY_FRAGMENT, /no human present/i);
  });

  it("TOOL_DISCIPLINE_FRAGMENT mentions parallel calls", () => {
    assert.match(TOOL_DISCIPLINE_FRAGMENT, /parallel/i);
  });

  it("SILENT_SENTINEL_FRAGMENT mentions [SILENT]", () => {
    assert.ok(SILENT_SENTINEL_FRAGMENT.includes("[SILENT]"));
  });

  it("SILENT_SENTINEL_TOKEN matches the canonical sentinel from last-tick-brief", () => {
    assert.strictEqual(SILENT_SENTINEL_TOKEN, SILENT_SENTINEL);
  });

  it("BROADCAST_DIRECTIVE_FRAGMENT is exported and mentions on-air", () => {
    assert.match(BROADCAST_DIRECTIVE_FRAGMENT, /on-air/i);
  });
});

// ---------------------------------------------------------------------------
// Domain neutrality — the autonomy / discipline / sentinel fragments must
// NOT carry broadcast-specific wording so non-broadcast workers (betting,
// scouting, fan-engagement) can reuse them unchanged.
// ---------------------------------------------------------------------------

describe("domain neutrality", () => {
  const broadcastTerms = [
    /broadcast/i,
    /\bon-air\b/i,
    /telemetry/i,
    /editorial/i,
    /\bfan signal\b/i,
  ];

  for (const term of broadcastTerms) {
    it(`CRON_AUTONOMY_FRAGMENT does not contain ${term}`, () => {
      assert.doesNotMatch(CRON_AUTONOMY_FRAGMENT, term);
    });
    it(`TOOL_DISCIPLINE_FRAGMENT does not contain ${term}`, () => {
      assert.doesNotMatch(TOOL_DISCIPLINE_FRAGMENT, term);
    });
    it(`SILENT_SENTINEL_FRAGMENT does not contain ${term}`, () => {
      assert.doesNotMatch(SILENT_SENTINEL_FRAGMENT, term);
    });
  }

  it("BROADCAST_DIRECTIVE_FRAGMENT IS allowed to mention broadcast/on-air", () => {
    // Sanity check: the directive fragment is where broadcast wording lives.
    assert.match(BROADCAST_DIRECTIVE_FRAGMENT, /broadcast/i);
    assert.match(BROADCAST_DIRECTIVE_FRAGMENT, /on-air/i);
  });
});

// ---------------------------------------------------------------------------
// buildSystemPrompt
// ---------------------------------------------------------------------------

describe("buildSystemPrompt", () => {
  it("returns just the role when no fragments are enabled", () => {
    const out = buildSystemPrompt({ role: "You are SportsClaw." });
    assert.strictEqual(out, "You are SportsClaw.");
  });

  it("composes role + cron + discipline + sentinel in order", () => {
    const out = buildSystemPrompt({
      role: "ROLE",
      isCron: true,
      toolDiscipline: true,
      silentSentinel: true,
    });
    const roleIdx = out.indexOf("ROLE");
    const cronIdx = out.indexOf("Autonomous mode");
    const disciplineIdx = out.indexOf("Tool use discipline");
    const silentIdx = out.indexOf("[SILENT] sentinel");
    assert.ok(roleIdx >= 0 && cronIdx > roleIdx, "cron should follow role");
    assert.ok(disciplineIdx > cronIdx, "discipline should follow cron");
    assert.ok(silentIdx > disciplineIdx, "silent should follow discipline");
  });

  it("renders editorial memory section when snapshot is non-empty", () => {
    const out = buildSystemPrompt({
      role: "ROLE",
      editorialMemorySnapshot: "lesson 1\n§\nlesson 2",
    });
    assert.ok(out.includes(EDITORIAL_MEMORY_FRAGMENT_HEADER));
    assert.ok(out.includes("lesson 1"));
    assert.ok(out.includes("lesson 2"));
  });

  it("skips editorial memory section when snapshot is empty/whitespace", () => {
    const out = buildSystemPrompt({ role: "ROLE", editorialMemorySnapshot: "   " });
    assert.ok(!out.includes(EDITORIAL_MEMORY_FRAGMENT_HEADER));
  });

  it("renders tick brief section when provided", () => {
    const out = buildSystemPrompt({
      role: "ROLE",
      recentTickBrief: "## Recent brief from job 'plan'\n\nbody here",
    });
    assert.ok(out.includes(TICK_BRIEF_FRAGMENT_HEADER));
    assert.ok(out.includes("body here"));
  });

  it("appends extras at the end, skipping empties", () => {
    const out = buildSystemPrompt({
      role: "ROLE",
      extras: ["", "  ", "extra-1", "extra-2"],
    });
    assert.ok(out.endsWith("extra-2"));
    assert.ok(out.indexOf("extra-1") < out.indexOf("extra-2"));
    assert.ok(!out.includes("  \n"), "empty extras should be dropped");
  });

  it("delimits sections with `\\n\\n---\\n\\n`", () => {
    const out = buildSystemPrompt({
      role: "ROLE",
      isCron: true,
    });
    assert.ok(out.includes("\n\n---\n\n"));
  });

  it("trims the role to avoid stray leading/trailing whitespace", () => {
    const out = buildSystemPrompt({ role: "   ROLE   ", isCron: true });
    assert.ok(out.startsWith("ROLE"));
  });

  it("broadcast workers opt in by passing BROADCAST_DIRECTIVE_FRAGMENT via extras", () => {
    const out = buildSystemPrompt({
      role: "ROLE",
      isCron: true,
      toolDiscipline: true,
      silentSentinel: true,
      extras: [BROADCAST_DIRECTIVE_FRAGMENT],
    });
    // Domain-neutral fragments are present
    assert.ok(out.includes("Autonomous mode"));
    assert.ok(out.includes("Tool use discipline"));
    // Domain-specific framing is present too — opted in via extras
    assert.ok(out.includes("Broadcast directive"));
    assert.match(out, /on-air/i);
  });
});
