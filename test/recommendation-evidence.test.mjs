import assert from "node:assert/strict";
import test from "node:test";
import { buildTemplatePrompt } from "../dist/response-templates.js";

for (const intent of ["prediction", "best_bets"]) {
  test(`${intent} only recommends on supporting evidence`, () => {
    const hint = buildTemplatePrompt(intent);
    assert.match(hint, /do not make a pick/i);
    assert.match(hint, /confidence.*strength of the evidence.*not a win probability/i);
    assert.match(hint, /supporting data point.*source.*key risk/i);
  });
}
