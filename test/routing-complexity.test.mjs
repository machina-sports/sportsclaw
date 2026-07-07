import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyQueryComplexity, planSkillCaps } from "../dist/routing/complexity.js";

const base = { routingMaxSkills: 2, routingAllowSpillover: 1 };

describe("query complexity planning", () => {
  it("keeps a simple score query at <= 2 skills", () => {
    const plan = planSkillCaps("lakers score", base);
    assert.ok(plan.maxSkills <= 2);
  });

  it("expands a betting query to >= 3 skills with a market skill", () => {
    const plan = planSkillCaps("best Lakers bets tonight", base);
    assert.ok(plan.maxSkills >= 3);
    assert.ok(plan.addSkills.some((s) => ["betting", "markets", "kalshi", "polymarket"].includes(s)));
  });

  it("expands a multi-sport query to >= 4 skills", () => {
    const plan = planSkillCaps("what's happening tonight across sports", base);
    assert.ok(plan.maxSkills >= 4);
  });

  it("classifies an injury/news query as compound", () => {
    assert.equal(classifyQueryComplexity("any injury news for the lakers?"), "compound");
  });
});
