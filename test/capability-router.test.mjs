/**
 * Standalone capability routing primitive.
 *
 * The router is not wired into the engine: every test builds a catalog by hand,
 * injects a transport and an env, and asserts the returned outcome. No live
 * calls, no credentials, no generative model.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_JEV_MODEL } from "../dist/decision-client.js";
import { CapabilityRouter, ROUTING_LIMITS } from "../dist/routing/capability-router.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CATALOG = [
  { id: "fetch_scores", description: "Retrieve the score of a supplied fixture" },
  { id: "fetch_injuries", description: "Retrieve the injury report of a supplied team" },
];

function request(overrides = {}) {
  return { prompt: "Score and injuries for the supplied fixture", candidates: CATALOG, ...overrides };
}

/** A choice answer in the native wire shape. Confidence is its own signal. */
function choice(chosen, probabilities, confidence) {
  return { type: "choice", choice: chosen, confidence, probabilities };
}

function dispositionAnswer(chosen, confidence = 0.97, probabilities) {
  const base = { select: 0, clarify: 0, unsupported: 0, ...(probabilities ?? { [chosen]: 1 }) };
  return choice(chosen, base, confidence);
}

function candidateAnswer(chosen, confidence = 0.97, probabilities) {
  const base = {
    required: 0,
    not_required: 0,
    unknown: 0,
    ...(probabilities ?? { [chosen]: 1 }),
  };
  return choice(chosen, base, confidence);
}

/**
 * Transport that answers exactly the questions it was sent. `plan.disposition`
 * and `plan.byRef` are keyed by the router's own opaque question IDs.
 */
function jevTransport(plan, overrides = {}) {
  const calls = [];
  const transport = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, init });
    const answers = {};
    for (const id of Object.keys(body.questions)) {
      answers[id] =
        id === "disposition"
          ? plan.disposition
          : (plan.byRef?.[id] ?? candidateAnswer("not_required"));
    }
    return new Response(
      JSON.stringify({ model: DEFAULT_JEV_MODEL, answers, usage: { input_tokens: 120, output_tokens: 30 }, ...overrides }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  return { calls, transport };
}

/** An env whose credential getter fails the test if it is ever read. */
function trapEnv() {
  return Object.defineProperty({}, "TYPESAFE_API_KEY", {
    get() {
      assert.fail("credential must not be read on this path");
    },
  });
}

function failTransport() {
  return async () => assert.fail("no request may be sent on this path");
}

function jevRouter(config = {}) {
  return new CapabilityRouter({
    provider: "jev",
    dataPolicy: "cloud_allowed",
    env: { TYPESAFE_API_KEY: "test-key" },
    ...config,
  });
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe("CapabilityRouter configuration", () => {
  it("defaults to the deterministic provider under a local-only policy", () => {
    const router = new CapabilityRouter();
    assert.equal(router.provider, "deterministic");
    assert.equal(router.dataPolicy, "local_only");
    assert.equal(router.confidenceThreshold, ROUTING_LIMITS.defaultConfidenceThreshold);
    assert.equal(router.marginThreshold, ROUTING_LIMITS.defaultMarginThreshold);
    assert.equal(router.maxSelected, ROUTING_LIMITS.defaultMaxSelected);
  });

  it("rejects invalid configuration visibly instead of changing the provider", () => {
    assert.throws(() => new CapabilityRouter({ provider: "openai" }), TypeError);
    assert.throws(() => new CapabilityRouter({ dataPolicy: "cloud" }), TypeError);
    assert.throws(() => new CapabilityRouter({ confidenceThreshold: 2 }), TypeError);
    assert.throws(() => new CapabilityRouter({ confidenceThreshold: Number.NaN }), TypeError);
    assert.throws(() => new CapabilityRouter({ marginThreshold: -0.1 }), TypeError);
    assert.throws(() => new CapabilityRouter({ maxSelected: 1.5 }), TypeError);
    assert.throws(() => new CapabilityRouter({ maxSelected: 0 }), TypeError);
    assert.throws(() => new CapabilityRouter({ model: "gpt-4" }), TypeError);
    // Unsupported fields are refused rather than silently ignored.
    assert.throws(() => new CapabilityRouter({ fallback: "deterministic" }), TypeError);
  });
});

// ---------------------------------------------------------------------------
// Deterministic path — no model, no credential, no network
// ---------------------------------------------------------------------------

describe("CapabilityRouter deterministic path", () => {
  it("returns a supplied complete rule result without a model or a credential", async () => {
    const router = new CapabilityRouter({ transport: failTransport(), env: trapEnv() });
    const outcome = await router.route(request({ deterministicSelectedIds: ["fetch_scores"] }));
    assert.equal(outcome.status, "selected");
    assert.deepEqual(outcome.selectedIds, ["fetch_scores"]);
    assert.equal(outcome.source, "deterministic");
    assert.equal(outcome.reasonCode, "deterministic_selection");
    // Confidence is model-derived only; a rule decision never fabricates one.
    assert.equal(outcome.confidence, undefined);
    assert.equal(outcome.margin, undefined);
    assert.equal(outcome.model, undefined);
  });

  it("returns a supplied rule result before cloud or credential access on the jev provider", async () => {
    const router = jevRouter({ transport: failTransport(), env: trapEnv() });
    const outcome = await router.route(request({ deterministicSelectedIds: ["fetch_injuries"] }));
    assert.equal(outcome.status, "selected");
    assert.equal(outcome.source, "deterministic");
  });

  it("clarifies when the deterministic-only path has no rule result", async () => {
    const router = new CapabilityRouter({ transport: failTransport(), env: trapEnv() });
    for (const extra of [{}, { deterministicSelectedIds: [] }]) {
      const outcome = await router.route(request(extra));
      assert.equal(outcome.status, "clarify");
      assert.equal(outcome.reasonCode, "no_deterministic_result");
      assert.equal(outcome.source, "deterministic");
      assert.equal(outcome.selectedIds, undefined);
    }
  });

  it("rejects a rule result that is not a valid subset of the catalog", async () => {
    const router = new CapabilityRouter({ transport: failTransport(), env: trapEnv() });
    for (const ids of [["missing"], ["fetch_scores", "fetch_scores"], [1], ["fetch_scores", "fetch_injuries", "missing"]]) {
      const outcome = await router.route(request({ deterministicSelectedIds: ids }));
      assert.equal(outcome.status, "unavailable");
      assert.equal(outcome.reasonCode, "invalid_request");
    }
  });

  it("rejects a rule result larger than maxSelected", async () => {
    const router = new CapabilityRouter({ maxSelected: 1, transport: failTransport(), env: trapEnv() });
    const outcome = await router.route(request({ deterministicSelectedIds: ["fetch_scores", "fetch_injuries"] }));
    assert.equal(outcome.status, "unavailable");
    assert.equal(outcome.reasonCode, "invalid_request");
  });
});

// ---------------------------------------------------------------------------
// Request validation — always before any credential or network access
// ---------------------------------------------------------------------------

describe("CapabilityRouter request validation", () => {
  it("treats an empty catalog as unsupported", async () => {
    const router = jevRouter({ transport: failTransport(), env: trapEnv() });
    const outcome = await router.route({ prompt: "anything", candidates: [] });
    assert.equal(outcome.status, "unsupported");
    assert.equal(outcome.reasonCode, "empty_catalog");
    assert.equal(outcome.source, "deterministic");
  });

  it("rejects invalid, duplicate and oversized catalog entries", async () => {
    const router = jevRouter({ transport: failTransport(), env: trapEnv() });
    const invalid = [
      [{ id: "a", description: "x" }, { id: "a", description: "y" }],
      [{ id: "", description: "x" }],
      [{ id: "a".repeat(ROUTING_LIMITS.maxIdChars + 1), description: "x" }],
      [{ id: "a", description: "" }],
      [{ id: "a", description: "x".repeat(ROUTING_LIMITS.maxDescriptionChars + 1) }],
      [{ id: "a" }],
      [{ id: 7, description: "x" }],
      ["a"],
    ];
    for (const candidates of invalid) {
      const outcome = await router.route({ prompt: "p", candidates });
      assert.equal(outcome.status, "unavailable");
      assert.equal(outcome.reasonCode, "invalid_request");
    }
  });

  it("refuses an oversize catalog rather than truncating it", async () => {
    const router = jevRouter({ transport: failTransport(), env: trapEnv() });
    const candidates = Array.from({ length: ROUTING_LIMITS.maxCandidates + 1 }, (_value, index) => ({
      id: `c_${index}`,
      description: `capability ${index}`,
    }));
    const outcome = await router.route({ prompt: "p", candidates });
    assert.equal(outcome.status, "unavailable");
    assert.equal(outcome.reasonCode, "catalog_too_large");
  });

  it("rejects an invalid prompt or recent context", async () => {
    const router = jevRouter({ transport: failTransport(), env: trapEnv() });
    const bad = [
      { prompt: "", candidates: CATALOG },
      { prompt: 7, candidates: CATALOG },
      { prompt: "x".repeat(ROUTING_LIMITS.maxPromptChars + 1), candidates: CATALOG },
      { prompt: "p", candidates: CATALOG, recentContext: "x".repeat(ROUTING_LIMITS.maxContextChars + 1) },
      { prompt: "p", candidates: CATALOG, recentContext: 7 },
    ];
    for (const req of bad) {
      const outcome = await router.route(req);
      assert.equal(outcome.status, "unavailable");
      assert.equal(outcome.reasonCode, "invalid_request");
    }
  });
});

// ---------------------------------------------------------------------------
// Jev dispatch — exactly one call
// ---------------------------------------------------------------------------

describe("CapabilityRouter jev dispatch", () => {
  it("selects every required capability from one transport call", async () => {
    const { calls, transport } = jevTransport({
      disposition: dispositionAnswer("select"),
      byRef: { c0: candidateAnswer("required"), c1: candidateAnswer("required") },
    });
    const outcome = await jevRouter({ transport }).route(request());
    assert.equal(calls.length, 1);
    assert.equal(outcome.status, "selected");
    assert.deepEqual(outcome.selectedIds, ["fetch_scores", "fetch_injuries"]);
    assert.equal(outcome.source, "jev");
    assert.equal(outcome.reasonCode, "model_selection");
    assert.equal(outcome.model, DEFAULT_JEV_MODEL);
    assert.equal(outcome.confidence, 0.97);
    assert.equal(outcome.margin, 1);
    assert.equal(outcome.receipt?.provider, "jev");
    assert.equal(outcome.receipt?.questionCount, 3);
  });

  it("sends opaque question IDs and no caller IDs", async () => {
    const { calls, transport } = jevTransport({
      disposition: dispositionAnswer("select"),
      byRef: { c0: candidateAnswer("required") },
    });
    await jevRouter({ transport }).route(request());
    const [{ body }] = calls;
    assert.deepEqual(Object.keys(body.questions).sort(), ["c0", "c1", "disposition"]);
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes("fetch_scores"));
    assert.ok(!serialized.includes("fetch_injuries"));
  });

  it("does not look up a credential when cloud access is withheld", async () => {
    const router = new CapabilityRouter({ provider: "jev", transport: failTransport(), env: trapEnv() });
    const outcome = await router.route(request());
    assert.equal(outcome.status, "unavailable");
    assert.equal(outcome.reasonCode, "local_only");
    assert.equal(outcome.source, "jev");
    assert.equal(outcome.selectedIds, undefined);
  });

  it("clarifies on low confidence and on a thin probability margin", async () => {
    const low = jevTransport({ disposition: dispositionAnswer("select", 0.4) });
    const lowOutcome = await jevRouter({ transport: low.transport }).route(request());
    assert.equal(lowOutcome.status, "clarify");
    assert.equal(lowOutcome.reasonCode, "low_confidence");
    assert.equal(lowOutcome.confidence, 0.4);

    const thin = jevTransport({
      disposition: dispositionAnswer("select", 0.98, { select: 0.52, clarify: 0.48, unsupported: 0 }),
    });
    const thinOutcome = await jevRouter({ transport: thin.transport }).route(request());
    assert.equal(thinOutcome.status, "clarify");
    assert.equal(thinOutcome.reasonCode, "low_margin");
  });

  it("clarifies on an unknown or unconfident capability answer", async () => {
    const unknown = jevTransport({
      disposition: dispositionAnswer("select"),
      byRef: { c0: candidateAnswer("unknown"), c1: candidateAnswer("required") },
    });
    const unknownOutcome = await jevRouter({ transport: unknown.transport }).route(request());
    assert.equal(unknownOutcome.status, "clarify");
    assert.equal(unknownOutcome.reasonCode, "unknown_requirement");
    assert.equal(unknownOutcome.selectedIds, undefined);

    const unsure = jevTransport({
      disposition: dispositionAnswer("select"),
      byRef: { c0: candidateAnswer("required", 0.5), c1: candidateAnswer("required") },
    });
    const unsureOutcome = await jevRouter({ transport: unsure.transport }).route(request());
    assert.equal(unsureOutcome.status, "clarify");
    assert.equal(unsureOutcome.reasonCode, "low_confidence");
  });

  it("clarifies rather than truncating when more capabilities are required than the cap", async () => {
    const { transport } = jevTransport({
      disposition: dispositionAnswer("select"),
      byRef: { c0: candidateAnswer("required"), c1: candidateAnswer("required") },
    });
    const outcome = await jevRouter({ transport, maxSelected: 1 }).route(request());
    assert.equal(outcome.status, "clarify");
    assert.equal(outcome.reasonCode, "too_many_required");
    assert.equal(outcome.selectedIds, undefined);
  });

  it("clarifies rather than picking a top capability when nothing is required", async () => {
    const { transport } = jevTransport({ disposition: dispositionAnswer("select") });
    const outcome = await jevRouter({ transport }).route(request());
    assert.equal(outcome.status, "clarify");
    assert.equal(outcome.reasonCode, "no_required_capability");
  });

  it("passes a confident model clarify through without prose", async () => {
    const { transport } = jevTransport({ disposition: dispositionAnswer("clarify") });
    const outcome = await jevRouter({ transport }).route(request());
    assert.equal(outcome.status, "clarify");
    assert.equal(outcome.reasonCode, "model_clarify");
    assert.deepEqual(Object.keys(outcome).sort(), ["confidence", "margin", "model", "reasonCode", "receipt", "source", "status"]);
  });

  it("distinguishes a confident unsupported from a provider failure", async () => {
    const supported = jevTransport({ disposition: dispositionAnswer("unsupported") });
    const unsupportedOutcome = await jevRouter({ transport: supported.transport }).route(request());
    assert.equal(unsupportedOutcome.status, "unsupported");
    assert.equal(unsupportedOutcome.reasonCode, "model_unsupported");

    const failing = async () =>
      new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    const failedOutcome = await jevRouter({ transport: failing }).route(request());
    assert.equal(failedOutcome.status, "unavailable");
    assert.equal(failedOutcome.reasonCode, "upstream_error");
    assert.equal(failedOutcome.selectedIds, undefined);
  });
});

// ---------------------------------------------------------------------------
// Failure handling — one attempt, no fallback
// ---------------------------------------------------------------------------

describe("CapabilityRouter failure handling", () => {
  it("reports a malformed response as unavailable", async () => {
    const transport = async () =>
      new Response("not json", { status: 200, headers: { "content-type": "application/json" } });
    const outcome = await jevRouter({ transport }).route(request());
    assert.equal(outcome.status, "unavailable");
    assert.equal(outcome.reasonCode, "malformed_response");
  });

  it("reports a timeout as unavailable without a second attempt", async () => {
    let calls = 0;
    const transport = async (_url, init) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    };
    const outcome = await jevRouter({ transport, timeoutMs: 250 }).route(request());
    assert.equal(calls, 1);
    assert.equal(outcome.status, "unavailable");
    assert.equal(outcome.reasonCode, "timeout");
  });

  it("reports a missing credential or denied auth as unavailable, never as a fallback selection", async () => {
    const missing = await jevRouter({ transport: failTransport(), env: {} }).route(request());
    assert.equal(missing.status, "unavailable");
    assert.equal(missing.reasonCode, "missing_credential");

    let calls = 0;
    const denied = async () => {
      calls += 1;
      return new Response("{}", { status: 401, headers: { "content-type": "application/json" } });
    };
    const outcome = await jevRouter({ transport: denied }).route(request());
    assert.equal(calls, 1);
    assert.equal(outcome.status, "unavailable");
    assert.equal(outcome.reasonCode, "auth_denied");
    assert.equal(outcome.source, "jev");
  });

  it("reports caller cancellation as unavailable", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await jevRouter({ transport: failTransport() }).route(request(), {
      abortSignal: controller.signal,
    });
    assert.equal(outcome.status, "unavailable");
    assert.equal(outcome.reasonCode, "aborted");
  });
});

// ---------------------------------------------------------------------------
// Snapshot safety
// ---------------------------------------------------------------------------

describe("CapabilityRouter snapshot safety", () => {
  it("answers against the snapshot even when the caller mutates during the await", async () => {
    const candidates = [...CATALOG];
    const { transport } = jevTransport({
      disposition: dispositionAnswer("select"),
      byRef: { c1: candidateAnswer("required") },
    });
    const wrapped = async (url, init) => {
      candidates.length = 0;
      candidates.push({ id: "swapped", description: "a different capability" });
      return transport(url, init);
    };
    const outcome = await jevRouter({ transport: wrapped }).route({ prompt: "p", candidates });
    assert.equal(outcome.status, "selected");
    assert.deepEqual(outcome.selectedIds, ["fetch_injuries"]);
  });

  it("carries a caller ID like __proto__ through safely", async () => {
    const candidates = [
      { id: "__proto__", description: "a capability with a hostile-looking ID" },
      { id: "constructor", description: "another reserved-looking ID" },
    ];
    const { transport } = jevTransport({
      disposition: dispositionAnswer("select"),
      byRef: { c0: candidateAnswer("required") },
    });
    const outcome = await jevRouter({ transport }).route({ prompt: "p", candidates });
    assert.equal(outcome.status, "selected");
    assert.deepEqual(outcome.selectedIds, ["__proto__"]);
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal({}.description, undefined);
  });

  it("does not normalize caller IDs", async () => {
    const candidates = [
      { id: " Fetch_Scores ", description: "a capability whose ID has case and spacing" },
      { id: "fetch_scores", description: "a distinct capability" },
    ];
    const { transport } = jevTransport({
      disposition: dispositionAnswer("select"),
      byRef: { c0: candidateAnswer("required") },
    });
    const outcome = await jevRouter({ transport }).route({ prompt: "p", candidates });
    assert.deepEqual(outcome.selectedIds, [" Fetch_Scores "]);
  });
});

// ---------------------------------------------------------------------------
// Cancellation — before the call and after it returns
// ---------------------------------------------------------------------------

describe("CapabilityRouter cancellation", () => {
  it("refuses an already-aborted call before even the rule result is returned", async () => {
    // A complete rule result is the cheapest possible success, so this is the
    // strictest place to prove the pre-abort guard runs first.
    const router = new CapabilityRouter({ transport: failTransport(), env: trapEnv() });
    const controller = new AbortController();
    controller.abort();
    const outcome = await router.route(request({ deterministicSelectedIds: ["fetch_scores"] }), {
      abortSignal: controller.signal,
    });
    assert.equal(outcome.status, "unavailable");
    assert.equal(outcome.reasonCode, "aborted");
    assert.equal(outcome.source, "deterministic");
    assert.equal(outcome.selectedIds, undefined);
  });

  it("discards a valid answer that arrives after the caller aborted, without a second call", async () => {
    // The transport aborts mid-flight and still returns a well-formed
    // selection: the client reports success, so only the router's POST-await
    // guard can stop a cancelled turn from acquiring capabilities.
    const controller = new AbortController();
    const { calls, transport } = jevTransport({
      disposition: dispositionAnswer("select"),
      byRef: { c0: candidateAnswer("required"), c1: candidateAnswer("required") },
    });
    const wrapped = async (url, init) => {
      controller.abort();
      return transport(url, init);
    };
    const outcome = await jevRouter({ transport: wrapped }).route(request(), {
      abortSignal: controller.signal,
    });
    assert.equal(calls.length, 1);
    assert.equal(outcome.status, "unavailable");
    assert.equal(outcome.reasonCode, "aborted");
    assert.equal(outcome.source, "jev");
    assert.equal(outcome.selectedIds, undefined);
  });
});

// ---------------------------------------------------------------------------
// Ordering and reported metrics
// ---------------------------------------------------------------------------

describe("CapabilityRouter selection order and metrics", () => {
  it("returns a rule result in catalog order, not in the order the caller listed it", async () => {
    const router = new CapabilityRouter({ transport: failTransport(), env: trapEnv() });
    const outcome = await router.route(
      request({ deterministicSelectedIds: ["fetch_injuries", "fetch_scores"] })
    );
    assert.equal(outcome.status, "selected");
    assert.deepEqual(outcome.selectedIds, ["fetch_scores", "fetch_injuries"]);
  });

  it("returns jev selections in catalog order regardless of answer order", async () => {
    // byRef is declared c1-first; the outcome must still follow the catalog.
    const { transport } = jevTransport({
      disposition: dispositionAnswer("select"),
      byRef: { c1: candidateAnswer("required"), c0: candidateAnswer("required") },
    });
    const outcome = await jevRouter({ transport }).route(request());
    assert.deepEqual(outcome.selectedIds, ["fetch_scores", "fetch_injuries"]);
  });

  it("reports the failing capability's own confidence and margin, not the disposition's", async () => {
    const { transport } = jevTransport({
      disposition: dispositionAnswer("select", 0.99),
      byRef: {
        c0: candidateAnswer("required", 0.6, { required: 0.7, not_required: 0.3, unknown: 0 }),
      },
    });
    const outcome = await jevRouter({ transport }).route(request());
    assert.equal(outcome.status, "clarify");
    assert.equal(outcome.reasonCode, "low_confidence");
    // A confident disposition must not mask an unconfident capability answer.
    assert.equal(outcome.confidence, 0.6);
    assert.ok(Math.abs(outcome.margin - 0.4) < 1e-9, `expected the capability margin 0.4, got ${outcome.margin}`);
  });

  it("reports the minimum confidence and margin across every judgment it acted on", async () => {
    const { transport } = jevTransport({
      disposition: dispositionAnswer("select", 0.99, { select: 0.95, clarify: 0.05, unsupported: 0 }),
      byRef: {
        c0: candidateAnswer("required", 0.93, { required: 0.6, not_required: 0.4, unknown: 0 }),
        c1: candidateAnswer("required", 0.97, { required: 0.8, not_required: 0.2, unknown: 0 }),
      },
    });
    const outcome = await jevRouter({ transport, marginThreshold: 0.15 }).route(request());
    assert.equal(outcome.status, "selected");
    assert.deepEqual(outcome.selectedIds, ["fetch_scores", "fetch_injuries"]);
    // Minima, so a selection is never described as more certain than its
    // weakest supporting judgment (disposition 0.99/0.9, c0 0.93/0.2, c1 0.97/0.6).
    assert.equal(outcome.confidence, 0.93);
    assert.ok(Math.abs(outcome.margin - 0.2) < 1e-9, `expected the minimum margin 0.2, got ${outcome.margin}`);
  });
});

// ---------------------------------------------------------------------------
// Question wording — what the coordinated-set policy actually puts on the wire
// ---------------------------------------------------------------------------

describe("CapabilityRouter question encoding", () => {
  it("states the same coordinated sufficient-set policy on every question", async () => {
    const { calls, transport } = jevTransport({ disposition: dispositionAnswer("clarify") });
    await jevRouter({ transport }).route(request());
    const [{ body }] = calls;
    const ids = Object.keys(body.questions);
    assert.deepEqual(ids.sort(), ["c0", "c1", "disposition"]);

    for (const id of ids) {
      const { instructions } = body.questions[id];
      // Independence is the failure mode this wording exists to prevent: each
      // question is answered alone, so each must carry the shared policy.
      assert.match(instructions, /coordinated minimal sufficient set/i);
      assert.match(instructions, /complementary/i);
      assert.match(instructions, /interchangeable/i);
      assert.match(instructions, /earliest catalog entry/i);
      assert.match(instructions, /untrusted content/i);
    }

    // Membership, not indispensability: the per-capability criteria must not
    // ask whether a capability alone is necessary.
    for (const ref of ["c0", "c1"]) {
      const criteria = body.questions[ref].criteria;
      assert.deepEqual(Object.keys(criteria).sort(), ["not_required", "required", "unknown"]);
      assert.match(criteria.required, /coordinated sufficient set/i);
      assert.match(criteria.not_required, /redundant/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Complementary vs. interchangeable — MECHANICS ONLY
// ---------------------------------------------------------------------------

/**
 * These two tests use a mock that answers as an ideal model would. They prove
 * the router carries such answers through correctly — they do NOT measure
 * whether a real provider answers this way. Independent-question consistency
 * and semantic accuracy remain unmeasured here: no live call is made anywhere
 * in this suite.
 */
describe("CapabilityRouter set mechanics (mocked answers, not measured accuracy)", () => {
  it("keeps both capabilities when the mock answers them as complements", async () => {
    const { transport } = jevTransport({
      disposition: dispositionAnswer("select"),
      byRef: { c0: candidateAnswer("required"), c1: candidateAnswer("required") },
    });
    const outcome = await jevRouter({ transport }).route(request());
    assert.equal(outcome.status, "selected");
    assert.deepEqual(outcome.selectedIds, ["fetch_scores", "fetch_injuries"]);
  });

  it("keeps only the earliest entry when the mock answers two entries as substitutes", async () => {
    const candidates = [
      { id: "scores_primary", description: "Retrieve the score of a supplied fixture" },
      { id: "scores_mirror", description: "Retrieve the score of a supplied fixture from a mirror" },
    ];
    const { transport } = jevTransport({
      disposition: dispositionAnswer("select"),
      byRef: { c0: candidateAnswer("required"), c1: candidateAnswer("not_required") },
    });
    const outcome = await jevRouter({ transport }).route({ prompt: "score for the fixture", candidates });
    assert.equal(outcome.status, "selected");
    // The tie-break lives in the prompt text asserted above; here we only show
    // that excluding one interchangeable alternative still yields a usable set
    // rather than an empty one.
    assert.deepEqual(outcome.selectedIds, ["scores_primary"]);
  });

  it("clarifies rather than acting when the mock excludes every interchangeable alternative", async () => {
    const { transport } = jevTransport({
      disposition: dispositionAnswer("select"),
      byRef: { c0: candidateAnswer("not_required"), c1: candidateAnswer("not_required") },
    });
    const outcome = await jevRouter({ transport }).route(request());
    assert.equal(outcome.status, "clarify");
    assert.equal(outcome.reasonCode, "no_required_capability");
  });
});
