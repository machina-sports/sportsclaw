import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTemplatePrompt } from "../dist/response-templates.js";

// Prompt-contract regressions, not live model or exchange verification.
// Comparisons must answer the comparison rather than dump unrelated markets.
describe("market conversation contract", () => {
  const odds = buildTemplatePrompt("odds");
  const analysis = buildTemplatePrompt("analysis");

  it("compares matching markets across every requested venue", () => {
    assert.match(odds, /compar/i);
    assert.match(odds, /every requested venue|each requested venue|all requested venues/i);
    assert.match(odds, /period/i);
    assert.match(odds, /selection/i);
    assert.doesNotMatch(odds, /Show the spread\/line, moneyline, and over\/under/);
  });

  it("keeps price provenance and execution type explicit", () => {
    assert.match(odds, /bid/i);
    assert.match(odds, /ask/i);
    assert.match(odds, /last/i);
    assert.match(odds, /timestamp|quote time|freshness/i);
  });

  it("requires tool calculations and preserves source prices if unavailable", () => {
    assert.match(odds, /calculation tool|conversion tool|betting.*convert_odds/i);
    assert.match(odds, /unavailable.*original|original.*unavailable/i);
  });

  it("limits arbitrage claims to checked scope and executable matching quotes", () => {
    assert.match(analysis, /arbitrage/i);
    assert.match(analysis, /checked|scanned/i);
    for (const condition of [/fees/i, /liquidity|size/i, /settlement/i, /executable/i]) {
      assert.match(analysis, condition);
    }
    assert.match(analysis, /incomplete|unverified|not verified/i);
    assert.match(analysis, /risk.free/i);
  });

  it("leads with the result without unsolicited allocation worksheets", () => {
    assert.match(odds, /short|compact/i);
    assert.match(analysis, /allocation.*asked|unless.*asked.*allocation|allocation.*requested/i);
  });
});
