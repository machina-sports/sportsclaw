/**
 * The `judge` config entry: which decision provider answers typed questions.
 *
 * It sits beside the model roles in the inference config and builds a `DecisionProvider`.
 * No live calls, no credentials.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JEV_ENDPOINT } from "../dist/decision-client.js";
import { GEMINI_DECISIONS_ENDPOINT, GeminiDecisionClient } from "../dist/gemini-decision-client.js";
import { decide } from "../dist/inference/decide.js";
import { createDecisionProvider } from "../dist/inference/judge.js";
import { validateModelRoleRouterConfig } from "../dist/inference/model-role-router.js";
import * as sdk from "../dist/index.js";

const REQUEST = {
  state: "Synthetic match report: Falcons 2-1 Rovers.",
  questions: { has_result: { type: "noul", instructions: "Does the state give a final result?" } },
};

function recorder(body) {
  const calls = [];
  return {
    calls,
    transport: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
}

describe("judge config", () => {
  const check = (judge) => validateModelRoleRouterConfig({ roles: {}, judge });

  it("accepts a provider alone and a fully stated entry", () => {
    assert.deepEqual(check({ provider: "gemini" }), { ok: true });
    assert.deepEqual(check({ provider: "jev", model: "jev-1.14.0", dataPolicy: "cloud_allowed", timeoutMs: 5000 }), { ok: true });
  });

  it("stays optional", () => {
    assert.deepEqual(validateModelRoleRouterConfig({ roles: {} }), { ok: true });
  });

  it("names the providers it knows when given another", () => {
    assert.match(check({ provider: "openai" }).error, /jev, gemini/);
    assert.match(check("gemini").error, /judge/i);
  });

  it("refuses a model that belongs to the other provider", () => {
    assert.match(check({ provider: "gemini", model: "jev-1.13.0" }).error, /gemini-decision/);
    assert.match(check({ provider: "jev", model: "gemini-decision-1" }).error, /jev-X\.Y\.Z/);
  });

  it("refuses a key pasted into the config", () => {
    assert.match(check({ provider: "gemini", apiKey: "not-a-real-key" }).error, /apiKey/);
  });

  it("refuses a bad data policy or deadline", () => {
    assert.match(check({ provider: "gemini", dataPolicy: "cloud" }).error, /dataPolicy/);
    assert.match(check({ provider: "gemini", timeoutMs: 1 }).error, /timeoutMs/);
  });
});

describe("createDecisionProvider", () => {
  it("defaults to the provider's own model and to no cloud consent", () => {
    const judge = createDecisionProvider({ provider: "gemini" });
    assert.equal(judge.provider, "gemini");
    assert.equal(judge.model, "gemini-decision-1");
    assert.equal(judge.dataPolicy, "local_only");
  });

  it("builds a Gemini provider that calls the Gemini endpoint", async () => {
    const { transport, calls } = recorder({ answers: { has_result: { type: "noul", noul: 0.98, confidence: 0.98 } } });
    const judge = createDecisionProvider(
      { provider: "gemini", dataPolicy: "cloud_allowed" },
      { transport, env: { GEMINI_API_KEY: "test-key" } }
    );
    const result = await judge.decide(REQUEST);
    assert.equal(result.ok, true);
    assert.equal(calls[0].url, GEMINI_DECISIONS_ENDPOINT);
  });

  it("builds a Jev provider on the stated model", async () => {
    const { transport, calls } = recorder({ model: "jev-1.14.0", answers: { has_result: { type: "noul", noul: 0.98 } } });
    const judge = createDecisionProvider(
      { provider: "jev", model: "jev-1.14.0", dataPolicy: "cloud_allowed" },
      { transport, env: { TYPESAFE_API_KEY: "test-key" } }
    );
    const result = await judge.decide(REQUEST);
    assert.equal(result.ok, true);
    assert.equal(calls[0].url, JEV_ENDPOINT);
    assert.equal(calls[0].body.model, "jev-1.14.0");
  });

  it("is exported from the package with the Gemini client", () => {
    assert.equal(sdk.createDecisionProvider, createDecisionProvider);
    assert.equal(sdk.GeminiDecisionClient, GeminiDecisionClient);
  });
});

describe("decide() with a Gemini provider", () => {
  it("reports blocked content as a refusal in the inference receipt", async () => {
    const client = new GeminiDecisionClient({
      dataPolicy: "cloud_allowed",
      env: { GEMINI_API_KEY: "test-key" },
      transport: async () =>
        new Response(JSON.stringify({ error: { code: "safety", message: "blocked" } }), { status: 400 }),
    });
    const receipts = [];
    const result = await decide({ purpose: "other", onReceipt: (r) => receipts.push(r) }, client, REQUEST);
    assert.equal(result.reasonCode, "content_blocked");
    assert.equal(receipts[0].status, "failed");
    assert.equal(receipts[0].errorCode, "refused");
    assert.equal(receipts[0].decision.provider, "gemini");
  });
});
