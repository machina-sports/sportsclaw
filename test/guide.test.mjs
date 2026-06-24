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

describe("premium / Machina guide", () => {
  it("routes premium-data intents to the guide", () => {
    assert.equal(isGuideIntent("how do I get premium data?"), true);
    assert.equal(isGuideIntent("I need licensed feeds"), true);
    assert.equal(isGuideIntent("machina cli setup"), true);
  });

  it("does not false-positive on premier league or incidental machina mentions", () => {
    assert.equal(isGuideIntent("premier league standings"), false);
    assert.equal(
      isGuideIntent("is the api-football from the Machina Sports TV pod?"),
      false,
    );
    assert.equal(isGuideIntent("what are today's NBA scores?"), false);
  });

  it("explains Machina using only existing commands", () => {
    const response = generateGuideResponse("how do I get premium data?");
    assert.match(response, /machina/i);
    assert.match(response, /machina-cli/);
    assert.match(response, /sportsclaw mcp add/);
    assert.match(response, /sports-skills premium/);
    assert.doesNotMatch(response, FORBIDDEN_PROMO);
  });
});
