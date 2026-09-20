/**
 * Optional Jev evidence verifier.
 *
 * Jev is a decision provider, never a chat model: it answers a fixed set of
 * `choice` questions about one draft against the same evidence the generative
 * verifier sees. These tests drive the real engine dispatch point
 * (validateResponseEvidence) with an injected transport — no live calls.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { sportsclawEngine } from "../dist/engine.js";
import {
  buildVerificationState,
  CHOICE_OPTIONS,
  DEFAULT_JEV_MODEL,
  EVIDENCE_CRITERIA,
  JEV_ENDPOINT,
  resolveEvidenceVerifierSettings,
  runJevDecision,
} from "../dist/evidence-verifier.js";

const CLEAN = '{"isValid":true,"discrepancies":[]}';
const input = {
  userPrompt: "Research up to three distinct leads",
  draft: "Low scores prove tactical containment.",
  toolOutputs: [{ toolName: "mcp__pod__search_documents", output: "Two recorded games finished 0-0." }],
  callerSystemPrompt: "Keep coverage gaps explicit. Do not generate or publish content. Use Portuguese.",
};

/**
 * Confidence is distribution-derived, so it is reported separately from the
 * winning probability. `topProbability` defaults to the confidence only because
 * most fixtures do not care about the difference.
 */
function choiceAnswer(choice, confidence, topProbability = confidence) {
  const rest = (1 - topProbability) / (CHOICE_OPTIONS.length - 1);
  const probabilities = {};
  for (const option of CHOICE_OPTIONS) probabilities[option] = option === choice ? topProbability : rest;
  return { type: "choice", choice, confidence, probabilities };
}

/** Build a well-formed Jev body; `per` overrides individual criteria. */
function jevBody(per = {}, overrides = {}) {
  const answers = {};
  for (const key of EVIDENCE_CRITERIA) {
    const spec = per[key] ?? per["*"] ?? { choice: "supported", confidence: 1 };
    answers[key] = choiceAnswer(spec.choice, spec.confidence, spec.topProbability);
  }
  return {
    model: DEFAULT_JEV_MODEL,
    answers,
    usage: { input_tokens: 364, output_tokens: 44 },
    ...overrides,
  };
}

function trapEnv() {
  return Object.defineProperty({}, "TYPESAFE_API_KEY", {
    get() { assert.fail("credential must not be read before admission"); },
  });
}

function jsonResponse(body, status = 200, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
}

/** Transport recorder. `handler(callNumber, url, init)` returns a Response. */
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

function fixture({ replies = [], verifier } = {}) {
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: replies.shift() ?? CLEAN }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
      warnings: [],
    }),
  });
  const engine = Object.create(sportsclawEngine.prototype);
  engine.mainModel = model;
  engine.config = { verbose: false, evidenceVerifier: verifier };
  return { engine, model };
}

/** Opt-in settings with cloud consent and an injected transport. */
function optIn(transport, extra = {}) {
  return {
    provider: "jev",
    dataPolicy: "cloud_allowed",
    transport,
    env: { TYPESAFE_API_KEY: "test-key" },
    ...extra,
  };
}

describe("default behavior is unchanged", () => {
  it("never reaches Jev without opt-in", async () => {
    const { transport, calls } = recorder(() => jsonResponse(jevBody()));
    const { engine, model } = fixture({ replies: [CLEAN], verifier: { transport, env: {} } });
    assert.equal(await engine.validateResponseEvidence(input), input.draft);
    assert.equal(calls.length, 0);
    assert.equal(model.doGenerateCalls.length, 1);
    assert.deepEqual(engine.evidenceReceipts, []);
  });

  it("keeps working when no verifier settings exist at all", async () => {
    const { engine, model } = fixture({ replies: [CLEAN] });
    assert.equal(await engine.validateResponseEvidence(input), input.draft);
    assert.equal(model.doGenerateCalls.length, 1);
  });

  it("local_only stops the requested verification without any verifier egress", async () => {
    const { transport, calls } = recorder(() => {
      throw new Error("must not fetch");
    });
    const { engine, model } = fixture({
      replies: [CLEAN],
      verifier: { provider: "jev", dataPolicy: "local_only", transport, env: { TYPESAFE_API_KEY: "test-key" } },
    });
    assert.equal(await engine.validateResponseEvidence(input), input.draft);
    assert.equal(calls.length, 0);
    // Withheld cloud consent must not be worked around by sending the same
    // draft and evidence to the generative verifier instead.
    assert.equal(model.doGenerateCalls.length, 0);
    assert.equal(engine.evidenceReceipts[0].reasonCode, "local_only");
    assert.equal(engine.evidenceReceipts[0].status, "blocked");
    assert.equal(engine.evidenceReceipts[0].requestedModel, DEFAULT_JEV_MODEL);
    assert.equal(engine.evidenceReceipts[0].model, undefined);
  });

  it("local_only does not fall through even when fallback is configured", async () => {
    const { transport, calls } = recorder(() => {
      throw new Error("must not fetch");
    });
    const { engine, model } = fixture({
      replies: [CLEAN],
      verifier: {
        provider: "jev",
        dataPolicy: "local_only",
        fallbackToGenerative: true,
        transport,
        env: { TYPESAFE_API_KEY: "test-key" },
      },
    });
    assert.equal(await engine.validateResponseEvidence(input), input.draft);
    assert.equal(calls.length, 0);
    assert.equal(model.doGenerateCalls.length, 0);
  });

  it("refuses rather than shipping an unchecked correction when blocked mid-chain", async () => {
    const { transport } = recorder(() => {
      throw new Error("must not fetch");
    });
    const { engine, model } = fixture({
      replies: [CLEAN],
      verifier: { provider: "jev", dataPolicy: "local_only", transport, env: {} },
    });
    const out = await engine.validateResponseEvidence({ ...input, correctionAttempted: true });
    assert.match(out, /could not verify/i);
    assert.equal(model.doGenerateCalls.length, 0);
  });
});

describe("opt-in support path", () => {
  it("skips the generative verifier on high-confidence support", async () => {
    const { transport, calls } = recorder(() => jsonResponse(jevBody()));
    const { engine, model } = fixture({ verifier: optIn(transport) });
    assert.equal(await engine.validateResponseEvidence(input), input.draft);
    assert.equal(calls.length, 1);
    assert.equal(model.doGenerateCalls.length, 0);
    const [receipt] = engine.evidenceReceipts;
    assert.equal(receipt.provider, "jev");
    assert.equal(receipt.status, "supported");
    assert.equal(receipt.model, DEFAULT_JEV_MODEL);
    assert.equal(receipt.questionCount, EVIDENCE_CRITERIA.length);
    assert.deepEqual(receipt.usage, { inputTokens: 364, outputTokens: 44 });
    assert.equal(receipt.fallbackUsed, false);
    assert.equal(receipt.recheck, false);
  });

  it("sends one bounded request to the fixed endpoint with the pinned model", async () => {
    const { transport, calls } = recorder(() => jsonResponse(jevBody()));
    const { engine } = fixture({ verifier: optIn(transport) });
    await engine.validateResponseEvidence(input);
    const [call] = calls;
    assert.equal(call.url, JEV_ENDPOINT);
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.redirect, "manual");
    assert.equal(call.body.model, DEFAULT_JEV_MODEL);
    assert.deepEqual(Object.keys(call.body.questions).sort(), [...EVIDENCE_CRITERIA].sort());
    for (const question of Object.values(call.body.questions)) {
      assert.equal(question.type, "choice");
      assert.ok(question.instructions.length > 0);
      assert.deepEqual(Object.keys(question.criteria).sort(), [...CHOICE_OPTIONS].sort());
    }
  });

  it("preserves caller policy, attribution and missing-coverage rules in the state", async () => {
    const { transport, calls } = recorder(() => jsonResponse(jevBody()));
    const { engine } = fixture({ verifier: optIn(transport) });
    await engine.validateResponseEvidence(input);
    const state = calls[0].body.state;
    assert.match(state, /Keep coverage gaps explicit/);
    assert.match(state, /cite genuine publishers and URLs/);
    assert.match(state, /Two recorded games finished 0-0/);
    assert.match(state, /Low scores prove tactical containment/);
    const questions = JSON.stringify(calls[0].body.questions);
    assert.match(questions, /Missing optional coverage does not invalidate/);
    assert.match(questions, /untrusted/i);
  });
});

describe("contradiction reaches correction", () => {
  it("corrects and rechecks a confirmed contradiction", async () => {
    const { transport, calls } = recorder((n) =>
      jsonResponse(n === 1 ? jevBody({ factual_support: { choice: "contradicted", confidence: 1 } }) : jevBody())
    );
    const { engine, model } = fixture({
      replies: ["Two recorded games finished 0-0."],
      verifier: optIn(transport),
    });
    assert.equal(await engine.validateResponseEvidence(input), "Two recorded games finished 0-0.");
    // one correction on the main model, two Jev decisions (check + recheck)
    assert.equal(model.doGenerateCalls.length, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.state.includes("Two recorded games finished 0-0."), true);
    assert.deepEqual(
      engine.evidenceReceipts.map((r) => [r.status, r.recheck]),
      [["contradicted", false], ["supported", true]]
    );
  });

  it("hands fixed criterion descriptions to the corrector, not invented quotes", async () => {
    const { transport } = recorder((n) =>
      jsonResponse(n === 1 ? jevBody({ "*": { choice: "contradicted", confidence: 1 } }) : jevBody())
    );
    const { engine, model } = fixture({ replies: ["Corrected."], verifier: optIn(transport) });
    await engine.validateResponseEvidence(input);
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
    assert.match(prompt, /Keep coverage gaps explicit/);
    assert.match(prompt, /factual_support/);
    assert.doesNotMatch(prompt, /jev-/);
  });

  it("refuses rather than shipping the draft when the recheck is unavailable", async () => {
    const { transport, calls } = recorder((n) => {
      if (n === 1) return jsonResponse(jevBody({ factual_support: { choice: "contradicted", confidence: 1 } }));
      return jsonResponse({ error: "boom" }, 503);
    });
    const { engine } = fixture({ replies: ["Corrected but unchecked."], verifier: optIn(transport) });
    const out = await engine.validateResponseEvidence(input);
    assert.notEqual(out, input.draft);
    assert.notEqual(out, "Corrected but unchecked.");
    assert.match(out, /could not verify/i);
    assert.equal(calls.length, 2);
  });

  it("refuses when the recheck confirms the correction is still unsupported", async () => {
    const { transport } = recorder(() => jsonResponse(jevBody({ "*": { choice: "contradicted", confidence: 1 } })));
    const { engine } = fixture({ replies: ["Still wrong."], verifier: optIn(transport) });
    assert.match(await engine.validateResponseEvidence(input), /could not verify/i);
  });

  it("refuses when correction generation itself fails", async () => {
    const { transport } = recorder(() => jsonResponse(jevBody({ "*": { choice: "contradicted", confidence: 1 } })));
    const engine = Object.create(sportsclawEngine.prototype);
    engine.mainModel = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("upstream 503");
      },
    });
    engine.config = { verbose: false, evidenceVerifier: optIn(transport) };
    assert.match(await engine.validateResponseEvidence(input), /could not verify/i);
  });
});

describe("ambiguous decisions", () => {
  const ambiguous = {
    unknown: { "*": { choice: "unknown", confidence: 1 } },
    low_confidence: { "*": { choice: "supported", confidence: 0.55 } },
  };

  for (const [label, per] of Object.entries(ambiguous)) {
    it(`keeps the unverified draft for ${label} without configured fallback`, async () => {
      const { transport, calls } = recorder(() => jsonResponse(jevBody(per)));
      const { engine, model } = fixture({ verifier: optIn(transport) });
      assert.equal(await engine.validateResponseEvidence(input), input.draft);
      assert.equal(model.doGenerateCalls.length, 0);
      assert.equal(calls.length, 1);
      assert.equal(engine.evidenceReceipts[0].status, "inconclusive");
      assert.equal(engine.evidenceReceipts[0].reasonCode, label);
      assert.equal(engine.evidenceReceipts[0].fallbackUsed, false);
    });

    it(`uses the generative verifier for ${label} when fallback is configured`, async () => {
      const { transport } = recorder(() => jsonResponse(jevBody(per)));
      const { engine, model } = fixture({
        replies: [CLEAN],
        verifier: optIn(transport, { fallbackToGenerative: true }),
      });
      assert.equal(await engine.validateResponseEvidence(input), input.draft);
      assert.equal(model.doGenerateCalls.length, 1);
      assert.equal(engine.evidenceReceipts[0].fallbackUsed, true);
    });
  }
});

describe("credential and transport failures", () => {
  it("never fetches and never falls back when the key is missing", async () => {
    const { transport, calls } = recorder(() => jsonResponse(jevBody()));
    const { engine, model } = fixture({
      verifier: optIn(transport, { env: {}, fallbackToGenerative: true }),
    });
    assert.equal(await engine.validateResponseEvidence(input), input.draft);
    assert.equal(calls.length, 0);
    assert.equal(model.doGenerateCalls.length, 0);
    assert.equal(engine.evidenceReceipts[0].reasonCode, "missing_credential");
  });

  for (const status of [401, 403]) {
    it(`does not retry or switch providers on ${status}`, async () => {
      const { transport, calls } = recorder(() => jsonResponse({ error: "denied" }, status));
      const { engine, model } = fixture({
        replies: [CLEAN],
        verifier: optIn(transport, { fallbackToGenerative: true }),
      });
      assert.equal(await engine.validateResponseEvidence(input), input.draft);
      assert.equal(calls.length, 1);
      assert.equal(model.doGenerateCalls.length, 0);
      assert.equal(engine.evidenceReceipts[0].reasonCode, "auth_denied");
    });
  }

  const transportCases = [
    ["rate_limited", () => jsonResponse({ error: "slow down" }, 429)],
    ["upstream_error", () => jsonResponse({ error: "boom" }, 503)],
    ["redirect_refused", () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test" } })],
    ["malformed_response", () => jsonResponse("not json at all")],
    ["response_too_large", () => jsonResponse("x".repeat(600_000))],
    ["network_error", () => Promise.reject(new TypeError("fetch failed"))],
  ];

  for (const [reasonCode, handler] of transportCases) {
    it(`makes exactly one attempt and keeps the unverified draft for ${reasonCode}`, async () => {
      const { transport, calls } = recorder(handler);
      const { engine, model } = fixture({ verifier: optIn(transport) });
      assert.equal(await engine.validateResponseEvidence(input), input.draft);
      assert.equal(calls.length, 1);
      assert.equal(model.doGenerateCalls.length, 0);
      assert.equal(engine.evidenceReceipts[0].status, "unavailable");
      assert.equal(engine.evidenceReceipts[0].reasonCode, reasonCode);
    });
  }

  it("times out with a bounded deadline and aborts the request", async () => {
    const { transport, calls } = recorder(
      (_n, _url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason ?? new Error("aborted")));
        })
    );
    const { engine } = fixture({ verifier: optIn(transport, { timeoutMs: 250 }) });
    assert.equal(await engine.validateResponseEvidence(input), input.draft);
    assert.equal(calls.length, 1);
    assert.equal(engine.evidenceReceipts[0].reasonCode, "timeout");
    assert.ok(engine.evidenceReceipts[0].latencyMs >= 0);
  });
});

describe("caller cancellation", () => {
  it("does not start a request after the caller has already aborted", async () => {
    const { transport, calls } = recorder(() => jsonResponse(jevBody()));
    const { engine, model } = fixture({ verifier: optIn(transport) });
    const out = await engine.validateResponseEvidence({ ...input, abortSignal: AbortSignal.abort() });
    assert.match(out, /could not verify/i);
    assert.equal(calls.length, 0);
    assert.equal(model.doGenerateCalls.length, 0);
  });

  it("refuses without retry or fallback when the caller aborts during the request", async () => {
    const controller = new AbortController();
    const { transport, calls } = recorder(
      (_n, _url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
          controller.abort();
        })
    );
    const { engine, model } = fixture({
      verifier: optIn(transport, { fallbackToGenerative: true }),
    });
    const out = await engine.validateResponseEvidence({ ...input, abortSignal: controller.signal });
    assert.match(out, /could not verify/i);
    assert.equal(calls.length, 1);
    assert.equal(model.doGenerateCalls.length, 0);
    assert.equal(engine.evidenceReceipts[0].reasonCode, "aborted");
  });
});

describe("answer validation — unknown or malformed never becomes verified", () => {
  const malformed = {
    model_mismatch: jevBody({}, { model: "jev-9.9.9" }),
    malformed_response: { answers: jevBody().answers },
    answer_type_mismatch: (() => {
      const body = jevBody();
      body.answers[EVIDENCE_CRITERIA[0]].type = "score";
      return body;
    })(),
    option_set_mismatch: (() => {
      const body = jevBody();
      body.answers[EVIDENCE_CRITERIA[0]].choice = "refuted";
      return body;
    })(),
    probability_invalid: (() => {
      const body = jevBody();
      body.answers[EVIDENCE_CRITERIA[0]].probabilities.unknown = Number.NaN;
      return body;
    })(),
    probability_sum_invalid: (() => {
      const body = jevBody();
      body.answers[EVIDENCE_CRITERIA[0]].probabilities.unknown = 0.5;
      return body;
    })(),
    argmax_mismatch: (() => {
      const body = jevBody({ "*": { choice: "supported", confidence: 0.6 } });
      body.answers[EVIDENCE_CRITERIA[0]].probabilities = { supported: 0.2, contradicted: 0.6, unknown: 0.2 };
      return body;
    })(),
    confidence_invalid: (() => {
      const body = jevBody();
      body.answers[EVIDENCE_CRITERIA[0]].confidence = 1.4;
      return body;
    })(),
  };
  // missing / extra questions
  const missing = jevBody();
  delete missing.answers[EVIDENCE_CRITERIA[0]];
  malformed.question_set_missing = missing;
  const extra = jevBody();
  extra.answers.bonus_question = choiceAnswer("supported", 1);
  malformed.question_set_extra = extra;

  for (const [label, body] of Object.entries(malformed)) {
    it(`never verifies on ${label}`, async () => {
      const { transport, calls } = recorder(() => jsonResponse(body));
      const { engine, model } = fixture({ verifier: optIn(transport) });
      assert.equal(await engine.validateResponseEvidence(input), input.draft);
      assert.equal(calls.length, 1, "malformed data must not trigger a retry");
      assert.equal(model.doGenerateCalls.length, 0);
      assert.equal(engine.evidenceReceipts[0].status, "unavailable");
    });
  }

  it("reports a distinct reason code per malformed shape", async () => {
    for (const [label, body] of Object.entries(malformed)) {
      const { transport } = recorder(() => jsonResponse(body));
      const { engine } = fixture({ verifier: optIn(transport) });
      await engine.validateResponseEvidence(input);
      const expected = label.startsWith("question_set") ? "question_set_mismatch" : label;
      assert.equal(engine.evidenceReceipts[0].reasonCode, expected, label);
    }
  });

  it("accepts a confidence that differs from the winning probability", async () => {
    // TypeSafe confidence is derived from the whole distribution: the published
    // example pairs a top probability of 0.88 with a confidence of 0.81.
    const per = { "*": { choice: "supported", confidence: 0.81, topProbability: 0.88 } };
    const { transport, calls } = recorder(() => jsonResponse(jevBody(per)));
    const { engine, model } = fixture({ verifier: optIn(transport, { confidenceThreshold: 0.75 }) });
    assert.equal(await engine.validateResponseEvidence(input), input.draft);
    assert.equal(calls.length, 1);
    assert.equal(model.doGenerateCalls.length, 0);
    const [receipt] = engine.evidenceReceipts;
    assert.equal(receipt.status, "supported");
    assert.equal(receipt.checks[0].confidence, 0.81);
    assert.equal(receipt.checks[0].probabilities.supported, 0.88);
  });

  it("abstains when a confident-looking distribution carries a low confidence", async () => {
    const per = { "*": { choice: "supported", confidence: 0.6, topProbability: 0.95 } };
    const { transport } = recorder(() => jsonResponse(jevBody(per)));
    const { engine, model } = fixture({ verifier: optIn(transport) });
    assert.equal(await engine.validateResponseEvidence(input), input.draft);
    assert.equal(model.doGenerateCalls.length, 0);
    assert.equal(engine.evidenceReceipts[0].status, "inconclusive");
    assert.equal(engine.evidenceReceipts[0].reasonCode, "low_confidence");
  });

  it("treats a low-confidence contradiction as inconclusive, never as a contradiction", async () => {
    const { transport } = recorder(() => jsonResponse(jevBody({ "*": { choice: "contradicted", confidence: 0.4 } })));
    const { engine, model } = fixture({ verifier: optIn(transport) });
    assert.equal(await engine.validateResponseEvidence(input), input.draft);
    assert.equal(model.doGenerateCalls.length, 0);
    assert.equal(engine.evidenceReceipts[0].status, "inconclusive");
  });
});

describe("oversized material is refused, never truncated", () => {
  const longSource = "Recorded result line. ".repeat(3_000);

  it("keeps the state complete instead of cutting the draft off the end", () => {
    const state = buildVerificationState({
      userPrompt: input.userPrompt,
      serializedToolOutputs: longSource,
      draft: input.draft,
      callerSystemPrompt: input.callerSystemPrompt,
    });
    assert.ok(state.length > 32_000);
    assert.doesNotMatch(state, /\[truncated\]/);
    assert.match(state, /Low scores prove tactical containment/);
    assert.match(state, /Keep coverage gaps explicit/);
  });

  const oversized = {
    "long context": { ...input, toolOutputs: [{ toolName: "mcp__pod__search_documents", output: longSource }] },
    "long draft": { ...input, draft: `${input.draft} ${"Padding sentence. ".repeat(2_500)}` },
  };

  for (const [label, oversizedInput] of Object.entries(oversized)) {
    it(`refuses a ${label} before any credential read or request`, async () => {
      const { transport, calls } = recorder(() => jsonResponse(jevBody()));
      const { engine, model } = fixture({ verifier: optIn(transport, { env: trapEnv() }) });
      assert.equal(await engine.validateResponseEvidence(oversizedInput), oversizedInput.draft);
      assert.equal(calls.length, 0);
      assert.equal(model.doGenerateCalls.length, 0);
      assert.equal(engine.evidenceReceipts[0].status, "unavailable");
      assert.equal(engine.evidenceReceipts[0].reasonCode, "request_too_large");
    });
  }

  it("does not hand oversized material to the generative verifier instead", async () => {
    const { transport, calls } = recorder(() => jsonResponse(jevBody()));
    const { engine, model } = fixture({
      replies: [CLEAN],
      verifier: optIn(transport, { fallbackToGenerative: true }),
    });
    const oversizedInput = oversized["long context"];
    assert.equal(await engine.validateResponseEvidence(oversizedInput), oversizedInput.draft);
    assert.equal(calls.length, 0);
    assert.equal(model.doGenerateCalls.length, 0);
    assert.equal(engine.evidenceReceipts[0].fallbackUsed, false);
  });
});

describe("runJevDecision enforces its own gates", () => {
  const settingsFor = (config) => resolveEvidenceVerifierSettings({ ...config, env: config.env ?? {} });

  const gated = {
    local_only: {
      settings: settingsFor({ provider: "jev" }),
      state: "short state",
    },
    request_too_large: {
      settings: settingsFor({ provider: "jev", dataPolicy: "cloud_allowed" }),
      state: "x".repeat(32_001),
    },
    aborted: {
      settings: settingsFor({ provider: "jev", dataPolicy: "cloud_allowed" }),
      state: "short state",
      abortSignal: AbortSignal.abort(),
    },
  };

  for (const [reasonCode, params] of Object.entries(gated)) {
    it(`returns ${reasonCode} without reading the credential or fetching`, async () => {
      const { transport, calls } = recorder(() => jsonResponse(jevBody()));
      const decision = await runJevDecision({ ...params, transport, env: trapEnv() });
      assert.equal(decision.status, "unavailable");
      assert.equal(decision.reasonCode, reasonCode);
      assert.equal(calls.length, 0);
      assert.equal(decision.receipt.requestedModel, DEFAULT_JEV_MODEL);
      assert.equal(decision.receipt.model, undefined);
    });
  }

  it("cancels the response body when it exits before reading it", async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start() {},
      cancel() {
        cancelled = true;
      },
    });
    const { transport } = recorder(() => new Response(body, { status: 503 }));
    const decision = await runJevDecision({
      settings: settingsFor({ provider: "jev", dataPolicy: "cloud_allowed" }),
      state: "short state",
      transport,
      env: { TYPESAFE_API_KEY: "test-key" },
    });
    assert.equal(decision.reasonCode, "upstream_error");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
  });
});

describe("receipt semantics", () => {
  it("records the validated model and per-criterion checks on success", async () => {
    const { transport } = recorder(() =>
      jsonResponse(jevBody({ coverage_freshness: { choice: "supported", confidence: 0.95, topProbability: 0.97 } }))
    );
    const { engine } = fixture({ verifier: optIn(transport) });
    await engine.validateResponseEvidence(input);
    const [receipt] = engine.evidenceReceipts;
    assert.equal(receipt.requestedModel, DEFAULT_JEV_MODEL);
    assert.equal(receipt.model, DEFAULT_JEV_MODEL);
    assert.deepEqual(receipt.checks.map((check) => check.criterion), [...EVIDENCE_CRITERIA]);
    for (const check of receipt.checks) {
      assert.equal(check.choice, "supported");
      assert.ok(check.confidence >= 0 && check.confidence <= 1);
      assert.deepEqual(Object.keys(check.probabilities).sort(), [...CHOICE_OPTIONS].sort());
    }
    assert.equal(receipt.checks[2].probabilities.supported, 0.97);
    assert.deepEqual(receipt.usage, { inputTokens: 364, outputTokens: 44 });
  });

  it("records the requested model but no actual model when the call fails", async () => {
    const { transport } = recorder(() => jsonResponse({ error: "boom" }, 503));
    const { engine } = fixture({ verifier: optIn(transport) });
    await engine.validateResponseEvidence(input);
    const [receipt] = engine.evidenceReceipts;
    assert.equal(receipt.requestedModel, DEFAULT_JEV_MODEL);
    assert.equal(receipt.model, undefined);
    assert.equal(receipt.checks, undefined);
    assert.equal(receipt.usage, undefined);
  });

  it("never records a model a mismatched response claimed", async () => {
    const { transport } = recorder(() => jsonResponse(jevBody({}, { model: "jev-9.9.9" })));
    const { engine } = fixture({ verifier: optIn(transport) });
    await engine.validateResponseEvidence(input);
    const [receipt] = engine.evidenceReceipts;
    assert.equal(receipt.reasonCode, "model_mismatch");
    assert.equal(receipt.requestedModel, DEFAULT_JEV_MODEL);
    assert.equal(receipt.model, undefined);
  });

  const unusableUsage = [
    ["fractional", { input_tokens: 12.5, output_tokens: 44 }],
    ["negative", { input_tokens: -1, output_tokens: 44 }],
    ["non-finite", { input_tokens: Number.MAX_VALUE * 2, output_tokens: 44 }],
    ["non-numeric", { input_tokens: "364", output_tokens: 44 }],
    ["absent", undefined],
  ];

  for (const [label, usage] of unusableUsage) {
    it(`omits ${label} token usage while still recording the decision`, async () => {
      const { transport } = recorder(() => jsonResponse(jevBody({}, { usage })));
      const { engine } = fixture({ verifier: optIn(transport) });
      assert.equal(await engine.validateResponseEvidence(input), input.draft);
      assert.equal(engine.evidenceReceipts[0].status, "supported");
      assert.equal(engine.evidenceReceipts[0].usage, undefined);
    });
  }
});

describe("settings resolution", () => {
  it("defaults to the generative provider", () => {
    const settings = resolveEvidenceVerifierSettings({ env: {} });
    assert.equal(settings.enabled, false);
    assert.equal(settings.provider, "generative");
  });

  it("opts in through the environment", () => {
    const settings = resolveEvidenceVerifierSettings({
      env: {
        SPORTSCLAW_EVIDENCE_VERIFIER: "jev",
        SPORTSCLAW_EVIDENCE_DATA_POLICY: "cloud_allowed",
        SPORTSCLAW_EVIDENCE_TIMEOUT_MS: "5000",
        SPORTSCLAW_EVIDENCE_CONFIDENCE: "0.75",
        SPORTSCLAW_EVIDENCE_FALLBACK: "generative",
      },
    });
    assert.equal(settings.enabled, true);
    assert.equal(settings.timeoutMs, 5000);
    assert.equal(settings.confidenceThreshold, 0.75);
    assert.equal(settings.fallbackToGenerative, true);
    assert.equal(settings.model, DEFAULT_JEV_MODEL);
  });

  it("programmatic settings win over the environment", () => {
    const settings = resolveEvidenceVerifierSettings({
      provider: "generative",
      env: { SPORTSCLAW_EVIDENCE_VERIFIER: "jev", SPORTSCLAW_EVIDENCE_DATA_POLICY: "cloud_allowed" },
    });
    assert.equal(settings.enabled, false);
  });

  it("requires explicit cloud consent", () => {
    const settings = resolveEvidenceVerifierSettings({ provider: "jev", env: {} });
    assert.equal(settings.enabled, false);
    assert.equal(settings.reasonCode, "local_only");
  });

  const rejected = [
    [{ provider: "jev", dataPolicy: "cloud_allowed", timeoutMs: 5 }, "timeoutMs", 8000],
    [{ provider: "jev", dataPolicy: "cloud_allowed", timeoutMs: 10 * 60_000 }, "timeoutMs", 8000],
    [{ provider: "jev", dataPolicy: "cloud_allowed", timeoutMs: Number.NaN }, "timeoutMs", 8000],
    [{ provider: "jev", dataPolicy: "cloud_allowed", confidenceThreshold: 0.1 }, "confidenceThreshold", 0.9],
    [{ provider: "jev", dataPolicy: "cloud_allowed", confidenceThreshold: 2 }, "confidenceThreshold", 0.9],
    [{ provider: "jev", dataPolicy: "cloud_allowed", confidenceThreshold: "high" }, "confidenceThreshold", 0.9],
  ];
  for (const [config, field, fallback] of rejected) {
    it(`rejects an out-of-range ${field} (${String(config[field])}) and uses the conservative default`, () => {
      const settings = resolveEvidenceVerifierSettings({ ...config, env: {} });
      assert.equal(settings[field], fallback);
      assert.ok(settings.diagnostics.includes(`invalid_${field}`));
    });
  }

  it("rejects an unrecognised provider, policy and model", () => {
    const settings = resolveEvidenceVerifierSettings({
      env: {
        SPORTSCLAW_EVIDENCE_VERIFIER: "gpt-4",
        SPORTSCLAW_EVIDENCE_DATA_POLICY: "whatever",
        SPORTSCLAW_EVIDENCE_MODEL: "https://evil.test/model",
      },
    });
    assert.equal(settings.provider, "generative");
    assert.equal(settings.dataPolicy, "local_only");
    assert.equal(settings.model, DEFAULT_JEV_MODEL);
    assert.deepEqual(settings.diagnostics.sort(), ["invalid_dataPolicy", "invalid_model", "invalid_provider"]);
  });

  it("never persists or exposes the credential", () => {
    const settings = resolveEvidenceVerifierSettings({
      provider: "jev",
      dataPolicy: "cloud_allowed",
      env: { TYPESAFE_API_KEY: "super-secret" },
    });
    assert.doesNotMatch(JSON.stringify(settings), /super-secret/);
  });
});

describe("receipts stay sanitized", () => {
  it("leaks no draft, source, policy, key or raw provider error", async () => {
    const bodies = [
      () => jsonResponse(jevBody()),
      () => jsonResponse({ error: "internal trace: super-secret at db.internal" }, 500),
      () => jsonResponse(jevBody({ "*": { choice: "unknown", confidence: 1 } })),
    ];
    for (const handler of bodies) {
      const { transport } = recorder(handler);
      const { engine } = fixture({ verifier: optIn(transport) });
      await engine.validateResponseEvidence(input);
      const serialized = JSON.stringify(engine.evidenceReceipts);
      for (const secret of [
        "test-key",
        "super-secret",
        input.draft,
        input.callerSystemPrompt,
        "Two recorded games finished 0-0",
        "internal trace",
      ]) {
        assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
      assert.deepEqual(Object.keys(engine.evidenceReceipts[0]).sort(), [
        "checks",
        "fallbackUsed",
        "latencyMs",
        "model",
        "provider",
        "questionCount",
        "reasonCode",
        "recheck",
        "requestedModel",
        "status",
        "usage",
      ]);
    }
  });

  it("does not insert receipts into the user-facing answer", async () => {
    const { transport } = recorder(() => jsonResponse(jevBody()));
    const { engine } = fixture({ verifier: optIn(transport) });
    const out = await engine.validateResponseEvidence(input);
    assert.doesNotMatch(out, /jev|receipt|reasonCode|verified by/i);
  });
});
