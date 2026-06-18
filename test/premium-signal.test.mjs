/**
 * Premium Signal + Skill Coverage — test suite
 *
 * Guards two things:
 *  1. The PREMIUM_SIGNAL behavior block is present, correctly scoped, and wired
 *     into the engine's core system prompt (so the agent surfaces the data
 *     layer's `upgrade` field instead of swallowing it).
 *  2. DEFAULT_SKILLS and SKILL_DESCRIPTIONS stay in sync, including the newly
 *     added cricket/volleyball/xctf/metadata modules.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PREMIUM_SIGNAL, CORE_BEHAVIOR_SECTIONS } from "../dist/prompts/sections.js";
import { DEFAULT_SKILLS, SKILL_DESCRIPTIONS } from "../dist/schema.js";

describe("premium signal prompt section", () => {
  it("keys off the data layer's `upgrade` field, not the model's own judgement", () => {
    assert.ok(/`upgrade`/.test(PREMIUM_SIGNAL), "must reference the `upgrade` field");
    assert.ok(
      /never invent/i.test(PREMIUM_SIGNAL),
      "must forbid inventing a premium hint — the data layer decides what is premium"
    );
  });

  it("routes the user to the sports-skills premium path", () => {
    assert.ok(/sports-skills premium/.test(PREMIUM_SIGNAL));
  });

  it("answers with data first and stays non-pushy", () => {
    assert.ok(/answer first/i.test(PREMIUM_SIGNAL));
    assert.ok(/single|one short line/i.test(PREMIUM_SIGNAL));
  });

  it("excludes itself from autonomous broadcasts and [SILENT] ticks", () => {
    assert.ok(/broadcast/i.test(PREMIUM_SIGNAL));
    assert.ok(/\[SILENT\]/.test(PREMIUM_SIGNAL));
  });

  it("is wired into the engine's core behavior sections", () => {
    // buildSystemPrompt pushes every CORE_BEHAVIOR_SECTIONS entry unconditionally,
    // so membership here means it lands in every interactive system prompt.
    assert.ok(CORE_BEHAVIOR_SECTIONS.includes(PREMIUM_SIGNAL));
  });
});

describe("skill coverage", () => {
  it("exposes the previously-missing modules", () => {
    for (const skill of ["cricket", "volleyball", "xctf", "metadata"]) {
      assert.ok(DEFAULT_SKILLS.includes(skill), `${skill} should be in DEFAULT_SKILLS`);
    }
  });

  it("has a description for every default skill (no drift)", () => {
    for (const skill of DEFAULT_SKILLS) {
      assert.ok(
        typeof SKILL_DESCRIPTIONS[skill] === "string" && SKILL_DESCRIPTIONS[skill].length > 0,
        `${skill} is missing a SKILL_DESCRIPTIONS entry`
      );
    }
  });

  it("has no orphan descriptions for skills not shipped", () => {
    for (const skill of Object.keys(SKILL_DESCRIPTIONS)) {
      assert.ok(
        DEFAULT_SKILLS.includes(skill),
        `${skill} has a description but is not in DEFAULT_SKILLS`
      );
    }
  });
});
