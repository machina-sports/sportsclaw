/**
 * Gemini decision provider.
 *
 * Same request, same answer shape and same answer checks as the Jev client; only the
 * wire differs. Every test uses an injected transport — no live calls, no credentials.
 * Response fixtures follow the shapes in Google's Decisions API guide; none of them is
 * a recorded live response.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DECISION_LIMITS } from "../dist/decision-client.js";
import {
  DEFAULT_GEMINI_DECISION_MODEL,
  GEMINI_DECISIONS_ENDPOINT,
  GeminiDecisionClient,
} from "../dist/gemini-decision-client.js";

const STATE = "Synthetic match report: Falcons 2-1 Rovers. This fixture supplies no injury report.";

const LEVELS = ["No result mentioned", "Possible result mentioned", "Final result explicitly supplied"];

function mixedQuestions() {
  return {
    route: {
      type: "choice",
      instructions: "Choose a supplied action",
      criteria: {
        summarize_result: "Retrieve and summarize the final result",
        analyze_injuries: "Retrieve injury details",
        review: "Escalate to human review",
      },
    },
    result_evidence: {
      type: "score",
      instructions: "Rate how explicitly the final result is supplied",
      criteria: [...LEVELS],
    },
    has_injuries: {
      type: "noul",
      instructions: "Does the state report an injury?",
      criteria: { true: "An injury is reported", false: "No injury is reported" },
    },
  };
}

function geminiBody(overrides = {}) {
  return {
    answers: {
      route: {
        type: "choice",
        choice: "summarize_result",
        probabilities: { summarize_result: 0.97, analyze_injuries: 0.01, review: 0.02 },
        confidence: 0.97,
      },
      result_evidence: {
        type: "score",
        score: 1.98,
        legend: { 0: LEVELS[0], 1: LEVELS[1], 2: LEVELS[2] },
        probabilities: { 0: 0.01, 1: 0, 2: 0.99 },
        confidence: 0.99,
      },
      has_injuries: { type: "noul", noul: 0.03, confidence: 0.97 },
    },
    usage: {
      total_input_tokens: 324,
      input_tokens_by_modality: [{ modality: "text", tokens: 324 }],
      total_output_tokens: 0,
      total_tokens: 324,
    },
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "content-type": "application/json" } });
}

function recorder(handler) {
  const calls = [];
  return {
    calls,
    transport: async (url, init) => {
      calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
      return handler(calls.length, url, init);
    },
  };
}

/** An env whose credential getter fails the test if it is ever read. */
function trapEnv() {
  return Object.defineProperty({}, "GEMINI_API_KEY", {
    get() {
      assert.fail("credential must not be read before admission");
    },
  });
}

function client(transport, config = {}) {
  return new GeminiDecisionClient({
    dataPolicy: "cloud_allowed",
    transport,
    env: { GEMINI_API_KEY: "test-key" },
    ...config,
  });
}

describe("gemini decision request", () => {
  it("sends one POST to the decisions endpoint with the key in x-goog-api-key", async () => {
    const { transport, calls } = recorder(() => jsonResponse(geminiBody()));
    await client(transport).decide({ state: STATE, questions: mixedQuestions() });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, GEMINI_DECISIONS_ENDPOINT);
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal(calls[0].init.headers["x-goog-api-key"], "test-key");
    assert.equal(calls[0].init.headers.authorization, undefined);
  });

  it("sends the state as input and renames the true/false descriptions", async () => {
    const { transport, calls } = recorder(() => jsonResponse(geminiBody()));
    await client(transport).decide({ state: STATE, questions: mixedQuestions() });
    const questions = mixedQuestions();
    assert.deepEqual(calls[0].body, {
      model: DEFAULT_GEMINI_DECISION_MODEL,
      input: STATE,
      questions: {
        route: questions.route,
        result_evidence: questions.result_evidence,
        has_injuries: {
          type: "noul",
          instructions: "Does the state report an injury?",
          criteria: { true_description: "An injury is reported", false_description: "No injury is reported" },
        },
      },
    });
  });

  it("sends a structured state as its JSON text", async () => {
    const { transport, calls } = recorder(() => jsonResponse(geminiBody()));
    const state = { home: "Falcons", score: [2, 1] };
    await client(transport).decide({ state, questions: mixedQuestions() });
    assert.equal(calls[0].body.input, JSON.stringify(state));
  });

  it("refuses an empty state, which the service does not accept, before reading the key", async () => {
    const { transport, calls } = recorder(() => jsonResponse(geminiBody()));
    const result = await client(transport, { env: trapEnv() }).decide({ state: "", questions: mixedQuestions() });
    assert.equal(result.reasonCode, "invalid_state");
    assert.equal(calls.length, 0);
  });

  it("refuses a question key the service does not accept, before reading the key", async () => {
    const { transport, calls } = recorder(() => jsonResponse(geminiBody()));
    const result = await client(transport, { env: trapEnv() }).decide({
      state: STATE,
      questions: { "has injuries?": { type: "noul", instructions: "Does the state report an injury?" } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "invalid_questions");
    assert.equal(result.receipt.status, "blocked");
    assert.equal(calls.length, 0);
  });

  it("sends nothing without cloud consent", async () => {
    const { transport, calls } = recorder(() => jsonResponse(geminiBody()));
    const result = await new GeminiDecisionClient({ transport, env: trapEnv() }).decide({
      state: STATE,
      questions: mixedQuestions(),
    });
    assert.equal(result.reasonCode, "local_only");
    assert.equal(calls.length, 0);
  });

  it("sends nothing when GEMINI_API_KEY is not set", async () => {
    const { transport, calls } = recorder(() => jsonResponse(geminiBody()));
    const result = await client(transport, { env: {} }).decide({ state: STATE, questions: mixedQuestions() });
    assert.equal(result.reasonCode, "missing_credential");
    assert.equal(calls.length, 0);
  });

  it("rejects a model that is not a Gemini decision model", () => {
    assert.throws(() => new GeminiDecisionClient({ model: "jev-1.13.0" }), TypeError);
    assert.throws(() => new GeminiDecisionClient({ model: "gemini-3-pro" }), TypeError);
  });
});

describe("gemini decision answers", () => {
  it("returns the shared answer shape and a gemini receipt", async () => {
    const { transport } = recorder(() => jsonResponse(geminiBody()));
    const result = await client(transport).decide({ state: STATE, questions: mixedQuestions() });
    assert.equal(result.ok, true);
    assert.equal(result.model, DEFAULT_GEMINI_DECISION_MODEL);
    assert.deepEqual({ ...result.answers.route, probabilities: { ...result.answers.route.probabilities } }, {
      type: "choice",
      choice: "summarize_result",
      confidence: 0.97,
      probabilities: { summarize_result: 0.97, analyze_injuries: 0.01, review: 0.02 },
    });
    assert.equal(result.answers.result_evidence.score, 1.98);
    // The shared noul answer is a probability only.
    assert.deepEqual({ ...result.answers.has_injuries }, { type: "noul", noul: 0.03 });
    assert.equal(result.receipt.provider, "gemini");
    assert.equal(result.receipt.status, "answered");
    assert.equal(result.receipt.requestedModel, DEFAULT_GEMINI_DECISION_MODEL);
    // The service does not report which model answered.
    assert.equal(result.receipt.model, undefined);
    assert.deepEqual(result.receipt.usage, { inputTokens: 324, outputTokens: 0 });
    assert.deepEqual(result.receipt.kindCounts, { choice: 1, score: 1, noul: 1 });
  });

  it("applies the same answer checks as Jev", async () => {
    const body = geminiBody();
    body.answers.route.choice = "not_offered";
    const { transport } = recorder(() => jsonResponse(body));
    const result = await client(transport).decide({ state: STATE, questions: mixedQuestions() });
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "option_set_mismatch");
    assert.equal(result.answers, undefined);
  });

  it("refuses a response that does not answer every question", async () => {
    const body = geminiBody();
    delete body.answers.has_injuries;
    const { transport } = recorder(() => jsonResponse(body));
    const result = await client(transport).decide({ state: STATE, questions: mixedQuestions() });
    assert.equal(result.reasonCode, "question_set_mismatch");
  });
});

describe("gemini decision refusals", () => {
  const BLOCK_MESSAGE = "Request blocked due to safety violations (harmful content).";

  for (const code of ["safety", "prohibited_content", "blocklist", "image_safety", "content_blocked"]) {
    it(`reports a 400 "${code}" error as blocked content, without the provider's text`, async () => {
      const { transport } = recorder(() => jsonResponse({ error: { code, message: BLOCK_MESSAGE } }, 400));
      const result = await client(transport).decide({ state: STATE, questions: mixedQuestions() });
      assert.equal(result.ok, false);
      assert.equal(result.reasonCode, "content_blocked");
      assert.equal(result.receipt.status, "failed");
      assert.equal(result.answers, undefined);
      assert.ok(!JSON.stringify(result).includes("safety violations"));
    });
  }

  it("reports a block stated in prompt_feedback as blocked content", async () => {
    const { transport } = recorder(() =>
      jsonResponse({ answers: {}, prompt_feedback: { block_reason: "safety", block_reason_message: BLOCK_MESSAGE } })
    );
    const result = await client(transport).decide({ state: STATE, questions: mixedQuestions() });
    assert.equal(result.reasonCode, "content_blocked");
    assert.ok(!JSON.stringify(result).includes("safety violations"));
  });

  it("reports any other 400 as an upstream error", async () => {
    const { transport } = recorder(() =>
      jsonResponse({ error: { code: "invalid_argument", message: "questions: too many" } }, 400)
    );
    const result = await client(transport).decide({ state: STATE, questions: mixedQuestions() });
    assert.equal(result.reasonCode, "upstream_error");
  });

  for (const [status, reasonCode] of [[401, "auth_denied"], [403, "auth_denied"], [429, "rate_limited"], [500, "upstream_error"], [302, "redirect_refused"]]) {
    it(`maps HTTP ${status} to ${reasonCode}`, async () => {
      const { transport } = recorder(() => jsonResponse({ error: { code: "x", message: "y" } }, status));
      const result = await client(transport).decide({ state: STATE, questions: mixedQuestions() });
      assert.equal(result.reasonCode, reasonCode);
    });
  }
});

describe("gemini decision with images", () => {
  const PNG = Buffer.from("89504e470d0a1a0a-synthetic", "utf8").toString("base64");
  const image = (extra = {}) => ({ kind: "image", data: PNG, mimeType: "image/png", ...extra });

  it("sends the state as a text block followed by the images", async () => {
    const { transport, calls } = recorder(() => jsonResponse(geminiBody()));
    const result = await client(transport).decide({ state: STATE, questions: mixedQuestions(), media: [image(), image({ mimeType: "image/jpeg" })] });
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0].body.input, [
      { type: "text", text: STATE },
      { type: "image", data: PNG, mime_type: "image/png" },
      { type: "image", data: PNG, mime_type: "image/jpeg" },
    ]);
    assert.equal(result.receipt.images, 2);
  });

  it("keeps the plain string input when there are no images", async () => {
    const { transport, calls } = recorder(() => jsonResponse(geminiBody()));
    const result = await client(transport).decide({ state: STATE, questions: mixedQuestions(), media: [] });
    assert.equal(calls[0].body.input, STATE);
    assert.equal(result.receipt.images, undefined);
  });

  it("accepts an image far larger than the text request limit", async () => {
    const { transport, calls } = recorder(() => jsonResponse(geminiBody()));
    const big = Buffer.alloc(600 * 1024, 7).toString("base64");
    const result = await client(transport).decide({ state: STATE, questions: mixedQuestions(), media: [image({ data: big })] });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
  });

  it("refuses bad media before reading the key", async () => {
    const { transport, calls } = recorder(() => jsonResponse(geminiBody()));
    const tooBig = Buffer.alloc(DECISION_LIMITS.maxMediaBytes + 1, 7).toString("base64");
    for (const [media, reason] of [
      [[image({ kind: "video" })], "invalid_media"],
      [[image({ mimeType: "image/gif" })], "invalid_media"],
      [[image({ data: "not base64!" })], "invalid_media"],
      [[image({ data: "" })], "invalid_media"],
      ["x", "invalid_media"],
      [Array.from({ length: DECISION_LIMITS.maxImages + 1 }, () => image()), "invalid_media"],
      [[image({ data: tooBig })], "request_too_large"],
    ]) {
      const result = await client(transport, { env: trapEnv() }).decide({ state: STATE, questions: mixedQuestions(), media });
      assert.equal(result.reasonCode, reason);
    }
    assert.equal(calls.length, 0);
  });
});

describe("gemini decision key", () => {
  it("falls back to the name sportsclaw saves a Google key under", async () => {
    const { transport, calls } = recorder(() => jsonResponse(geminiBody()));
    const result = await client(transport, { env: { GOOGLE_GENERATIVE_AI_API_KEY: "saved-key" } }).decide({ state: STATE, questions: mixedQuestions() });
    assert.equal(result.ok, true);
    assert.equal(calls[0].init.headers["x-goog-api-key"], "saved-key");
  });

  it("prefers GEMINI_API_KEY when both are set", async () => {
    const { transport, calls } = recorder(() => jsonResponse(geminiBody()));
    await client(transport, { env: { GEMINI_API_KEY: "first", GOOGLE_GENERATIVE_AI_API_KEY: "second" } }).decide({ state: STATE, questions: mixedQuestions() });
    assert.equal(calls[0].init.headers["x-goog-api-key"], "first");
  });
});
