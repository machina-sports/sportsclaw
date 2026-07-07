import assert from "node:assert/strict";
import { describe, it } from "node:test";

// The planner is the unit under test at the routing boundary; this guards the
// contract router.ts relies on so a future refactor can't silently narrow it.
import { planSkillCaps } from "../dist/routing/complexity.js";

describe("router complexity integration contract", () => {
  it("a betting prompt raises the effective max above the base of 2", () => {
    const plan = planSkillCaps("best bets for lakers tonight", { routingMaxSkills: 2, routingAllowSpillover: 1 });
    const effective = Math.max(2, plan.maxSkills);
    assert.ok(effective >= 3);
  });
});
