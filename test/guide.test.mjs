import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateGuideResponse, isGuideIntent } from "../dist/guide.js";

const FORBIDDEN_PROMO = /Machina Clawd|machina-templates|Coming Soon on Machina|Machina Skills/i;

describe("guide intent routing", () => {
  it("does not intercept API-Football source questions as marketing/help", () => {
    const prompt = "The api-football you refer as source there is from the Machina Sports TV pod, or directly?";
    assert.equal(isGuideIntent(prompt), false);
  });

  it("does not include Machina Clawd or template promotion in help output", () => {
    const response = generateGuideResponse("help");
    assert.ok(response.includes("sportsclaw Features"));
    assert.doesNotMatch(response, FORBIDDEN_PROMO);
  });

  it("still handles explicit help intents", () => {
    assert.equal(isGuideIntent("help"), true);
    assert.equal(isGuideIntent("what sports do you support?"), true);
  });
});
