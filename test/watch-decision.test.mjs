/**
 * Jev typed watch decision — `watch-decision-v1` on POST /api/watch-intent
 *
 *   - `runWatchIntent()` from dist/watch-intent-relay.js dispatches the
 *     alternate contract. `options.decisionTransport` is the existing
 *     `DecisionTransport` seam: the real JevDecisionClient validation and the
 *     unified `inference/decide` wrapper run; only the network is mocked.
 *   - docker/relay/test_watch_decision.py covers the Python handler; it is run
 *     from here so `npm test` exercises both sides.
 *
 * Contract (jev-watch-design.md, "Concrete wire seam"):
 *   intent  {contract,stage:"intent",text,locale}
 *        -> {contract,ok:true,stage:"intent",intent,model,confidence,margin}
 *   target  {contract,stage:"target",text,locale,candidates:[{id,label}],referenceIds?}
 *        -> {contract,ok:true,stage:"target",selection:{status,targetId},model,confidence,margin}
 *   error   {contract,ok:false,reasonCode}
 *
 * Operator gates: SPORTSCLAW_WATCH_INTENT_ENABLED (route) plus
 * SPORTSCLAW_WATCH_JEV_ENABLED=true and SPORTSCLAW_WATCH_JEV_DATA_POLICY=cloud_allowed,
 * TYPESAFE_API_KEY, pinned jev-1.14.0. A native-only route config blocks egress.
 * Policy: confidence >= 0.80 AND top-two margin >= 0.15, else clarify; the
 * semantic abstain option is always clarify. No generative fallback.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

globalThis.AI_SDK_LOG_WARNINGS = false;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(repoRoot, "dist");
const WORKER = join(distDir, "watch-intent-relay.js");
const PYTHON = process.env.PYTHON_PATH || "python3";

const D = "watch-decision-v1";
const LEGACY = "watch-intent-v1";
const MODEL = "jev-1.14.0";
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const KEY = "synthetic-typesafe-test-credential";
const ENV = Object.freeze({
  SPORTSCLAW_WATCH_INTENT_ENABLED: "true",
  SPORTSCLAW_WATCH_JEV_ENABLED: "true",
  SPORTSCLAW_WATCH_JEV_DATA_POLICY: "cloud_allowed",
  TYPESAFE_API_KEY: KEY,
});

const relay = await import("../dist/watch-intent-relay.js");
const decisionClient = await import("../dist/decision-client.js");

// Escaped real network is a failure, not a silent pass.
let escapedFetches = 0;
let realFetch;
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    escapedFetches += 1;
    throw new Error("network is forbidden in these tests");
  };
});
after(() => {
  globalThis.fetch = realFetch;
  assert.equal(escapedFetches, 0, "every Jev call must go through the injected decisionTransport");
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Intent options: the public probe-v2 labels, mapped to contract intents. */
const INTENT_OPTIONS = ["follow", "stop", "pause", "resume", "list_available", "list_following", "ordinary", "uncertain"];

const CANDIDATES = [
  { id: "pub_fx_chelsea_arsenal_20261025", label: "Chelsea vs Arsenal · Premier League · 25 Oct 15:00 UTC" },
  { id: "pub_fx_chelsea_w_arsenal_w_20261026", label: "Chelsea Women vs Arsenal Women · WSL · 26 Oct 12:30 UTC" },
  { id: "pub_take_lakers_clutch", label: "Lakers clutch moments · NBA" },
];

const intentBody = (text = "Watch the Chelsea game for me", locale = "en", extra = {}) =>
  ({ contract: D, stage: "intent", text, locale, ...extra });

const targetBody = (text = "follow the Lakers clutch take", extra = {}) =>
  ({ contract: D, stage: "target", text, locale: "en", candidates: CANDIDATES.map((c) => ({ ...c })), ...extra });

const reply = (status, payload) =>
  new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Exactly one Choice question per stage request (probe v2: one isolated decision). */
function onlyQuestion(wire) {
  const ids = Object.keys(wire.questions);
  assert.equal(ids.length, 1, `one question per decision: ${ids}`);
  const question = wire.questions[ids[0]];
  assert.equal(question.type, "choice");
  return [ids[0], question];
}

/** A real-shaped Choice answer over the offered options. */
function choice(question, option, { confidence, top = confidence, second = 0, runnerUp } = {}) {
  const keys = Object.keys(question.criteria);
  assert.ok(keys.includes(option), `offered options must include ${option}: ${keys}`);
  const others = keys.filter((k) => k !== option);
  const ru = runnerUp ?? others[0];
  const rest = others.filter((k) => k !== ru);
  const share = (1 - top - second) / rest.length;
  const probabilities = {};
  for (const k of keys) probabilities[k] = k === option ? top : k === ru ? second : share;
  return { type: "choice", choice: option, confidence, probabilities };
}

/** Option whose public description carries this candidate label. */
function optionFor(question, label) {
  const hits = Object.entries(question.criteria).filter(([, text]) => text.includes(label));
  assert.equal(hits.length, 1, `exactly one option describes ${label}`);
  return hits[0][0];
}

const marginOf = (probabilities) => {
  const [a, b] = Object.values(probabilities).sort((x, y) => y - x);
  return a - b;
};

/** Mock Jev network: answers each request through `answer(question, wire)`. */
function jev(answer = () => assert.fail("Jev must not be called")) {
  const calls = [];
  const answers = [];
  const transport = async (url, init) => {
    const wire = JSON.parse(init.body);
    calls.push({ url, init, wire });
    const [id, question] = onlyQuestion(wire);
    const out = answer(question, wire);
    if (out instanceof Response) return out;
    answers.push(out);
    return reply(200, { model: MODEL, answers: { [id]: out }, usage: { input_tokens: 120, output_tokens: 3 } });
  };
  return { calls, answers, transport };
}

/** A transport that never answers until its signal aborts. */
function hanging() {
  let started;
  const calls = [];
  const startedP = new Promise((resolve) => (started = resolve));
  const transport = (url, init) => {
    calls.push({ url, init });
    started();
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  };
  return { calls, started: startedP, transport };
}

async function decide(body, { env = ENV, transport = jev().transport, abortSignal } = {}) {
  const generative = [];
  const result = await relay.runWatchIntent(typeof body === "string" ? body : JSON.stringify(body), {
    env: { ...env },
    decisionTransport: transport,
    abortSignal,
    createModel: (...args) => {
      generative.push(args);
      throw new Error("generative fallback is forbidden for watch-decision-v1");
    },
  });
  return { result, generative };
}

function assertFailure(result, reasonCode, label = reasonCode) {
  assert.deepEqual(result, { contract: D, ok: false, reasonCode }, label);
}

function assertDecision(result, stage, value, answer) {
  const field = stage === "intent" ? "intent" : "selection";
  assert.deepEqual(Object.keys(result).sort(), ["confidence", "contract", field, "margin", "model", "ok", "stage"].sort());
  assert.equal(result.contract, D);
  assert.equal(result.ok, true);
  assert.equal(result.stage, stage);
  assert.deepEqual(result[field], value);
  assert.equal(result.model, MODEL, "the model reported by the validated Jev answer");
  assert.equal(result.confidence, answer.confidence, "native confidence, not the top probability");
  assert.ok(Math.abs(result.margin - marginOf(answer.probabilities)) < 1e-9, `margin ${result.margin}`);
}

/** The single validated Jev request: fixed endpoint, pinned model, server credential. */
function assertWire(call, mustInclude = []) {
  assert.equal(call.url, ENDPOINT);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.redirect, "manual");
  assert.equal(new Headers(call.init.headers).get("authorization"), `Bearer ${KEY}`);
  assert.deepEqual(Object.keys(call.wire).sort(), ["model", "questions", "state"]);
  assert.equal(call.wire.model, MODEL);
  const state = JSON.stringify(call.wire.state);
  for (const s of mustInclude) assert.ok(state.includes(s), `state carries ${s}`);
  assert.doesNotMatch(call.init.body, /acct_|sub_active|userId|"history"|"profile"/, "no private records reach Jev");
}

// ---------------------------------------------------------------------------
// Intent stage
// ---------------------------------------------------------------------------

const p = (spec) => Object.fromEntries(INTENT_OPTIONS.map((k) => [k, spec[k] ?? 0]));

/** Recorded public probe-v2 answers (policy guidance, not an accuracy claim). */
const PROBE = [
  ["Watch the Chelsea game for me", "en", "follow", 0.99, p({ follow: 0.99, uncertain: 0.01 }), "follow"],
  ["Where can I watch the Chelsea game replay?", "en", "ordinary", 1, p({ ordinary: 1 }), "none"],
  ["Stop watching the Chelsea game", "en", "stop", 1, p({ stop: 1 }), "unfollow"],
  ["Pause my match alerts", "en", "pause", 0.99, p({ pause: 0.99, stop: 0.01 }), "pause"],
  ["Start sending my paused match alerts again", "en", "resume", 0.99, p({ resume: 0.99, follow: 0.01 }), "resume"],
  ["What matches can I monitor?", "en", "list_available", 0.59,
    p({ follow: 0.03, list_available: 0.64, list_following: 0.18, ordinary: 0.01, uncertain: 0.14 }), "clarify"],
  ["Which matches am I following?", "en", "list_following", 1, p({ list_following: 1 }), "list_following"],
  ["Acompanhe o jogo do Chelsea para mim", "pt", "follow", 0.99, p({ follow: 0.99, uncertain: 0.01 }), "follow"],
  ["¿Dónde puedo ver el partido del Chelsea?", "es", "ordinary", 1, p({ ordinary: 1 }), "none"],
];

describe("watch-decision intent stage", () => {
  for (const [text, locale, option, confidence, probabilities, intent] of PROBE) {
    it(`${JSON.stringify(text)} -> ${intent}`, async () => {
      const j = jev((question) => {
        assert.deepEqual(Object.keys(question.criteria).sort(), [...INTENT_OPTIONS].sort());
        return { type: "choice", choice: option, confidence, probabilities };
      });
      const { result, generative } = await decide(intentBody(text, locale), { transport: j.transport });
      assertDecision(result, "intent", intent, j.answers[0]);
      assert.equal(j.calls.length, 1);
      assertWire(j.calls[0], [text]);
      assert.equal(generative.length, 0, "no generative model");
    });
  }

  it("treats the semantic abstain option as clarify even at full confidence", async () => {
    const j = jev((q) => choice(q, "uncertain", { confidence: 1, top: 1 }));
    const { result } = await decide(intentBody("Watch or stop, whatever"), { transport: j.transport });
    assertDecision(result, "intent", "clarify", j.answers[0]);
    assert.equal(j.calls.length, 1);
  });

  it("passes the gate at exactly confidence 0.80 with a wide margin", async () => {
    const j = jev((q) => choice(q, "follow", { confidence: 0.8, top: 0.9, second: 0.05 }));
    const { result } = await decide(intentBody(), { transport: j.transport });
    assertDecision(result, "intent", "follow", j.answers[0]);
  });

  it("clarifies on low confidence even when the top probability is high", async () => {
    const j = jev((q) => choice(q, "follow", { confidence: 0.7, top: 0.99, second: 0.01 }));
    const { result } = await decide(intentBody(), { transport: j.transport });
    assertDecision(result, "intent", "clarify", j.answers[0]);
  });

  it("clarifies on a narrow top-two margin even when confidence is high", async () => {
    const j = jev((q) => choice(q, "follow", { confidence: 0.95, top: 0.52, second: 0.42, runnerUp: "list_available" }));
    const { result } = await decide(intentBody(), { transport: j.transport });
    assertDecision(result, "intent", "clarify", j.answers[0]);
  });

  it("clarifies rather than answering ordinarily when 'ordinary' is uncertain", async () => {
    const j = jev((q) => choice(q, "ordinary", { confidence: 0.6, top: 0.6, second: 0.3, runnerUp: "follow" }));
    const { result } = await decide(intentBody("Chelsea later?"), { transport: j.transport });
    assertDecision(result, "intent", "clarify", j.answers[0]);
  });
});

// ---------------------------------------------------------------------------
// Target stage
// ---------------------------------------------------------------------------

describe("watch-decision target stage", () => {
  it("maps the selected option back to the caller's public ID", async () => {
    const j = jev((q) => {
      assert.ok(Object.hasOwn(q.criteria, "no_match") && Object.hasOwn(q.criteria, "uncertain"));
      assert.equal(Object.keys(q.criteria).length, CANDIDATES.length + 2);
      return choice(q, optionFor(q, CANDIDATES[2].label), { confidence: 0.93, top: 0.9, second: 0.06, runnerUp: "uncertain" });
    });
    const { result, generative } = await decide(targetBody(), { transport: j.transport });
    assertDecision(result, "target", { status: "selected", targetId: "pub_take_lakers_clutch" }, j.answers[0]);
    assert.equal(j.calls.length, 1);
    assertWire(j.calls[0], ["follow the Lakers clutch take", ...CANDIDATES.map((c) => c.label)]);
    assert.equal(generative.length, 0);
  });

  it("emits one sanitized decision receipt with the actual pinned model", async () => {
    const receipts = [];
    const j = jev((q) => choice(q, optionFor(q, CANDIDATES[2].label), { confidence: 0.93, top: 0.9, second: 0.06 }));
    const result = await relay.runWatchIntent(JSON.stringify(targetBody()), {
      env: { ...ENV },
      decisionTransport: j.transport,
      onReceipt: (r) => receipts.push(r),
      createModel: () => assert.fail("no generative model"),
    });
    assert.equal(result.ok, true);
    assert.equal(receipts.length, 1);
    const [r] = receipts;
    assert.equal(r.kind, "decision");
    assert.equal(r.purpose, "watch_intent");
    assert.equal(r.status, "completed");
    assert.equal(r.decision.model, MODEL);
    assert.equal(r.decision.requestedModel, MODEL);
    assert.deepEqual(r.decision.kindCounts, { choice: 1, score: 0, noul: 0 });
    const serialized = JSON.stringify(r);
    for (const leak of ["Lakers", "follow the Lakers", "pub_take_lakers_clutch", "no_match", KEY]) {
      assert.ok(!serialized.includes(leak), `receipt must not carry ${leak}`);
    }
  });

  it("offers positional option keys, never the public IDs, and still never sends private data", async () => {
    const j = jev((q) => choice(q, "no_match", { confidence: 0.97, top: 0.95, second: 0.02 }));
    await decide(targetBody(undefined, { referenceIds: [CANDIDATES[1].id] }), { transport: j.transport });
    const [, question] = onlyQuestion(j.calls[0].wire);
    for (const c of CANDIDATES) assert.ok(!Object.hasOwn(question.criteria, c.id), c.id);
    assert.ok(!j.calls[0].init.body.includes(KEY), "the credential travels only in the header");
  });

  it("accepts verified public reference anchors that are candidates", async () => {
    const j = jev((q) => choice(q, optionFor(q, CANDIDATES[0].label), { confidence: 0.9, top: 0.85, second: 0.1 }));
    const { result } = await decide(targetBody("keep me posted on that match", { referenceIds: [CANDIDATES[0].id] }), { transport: j.transport });
    assertDecision(result, "target", { status: "selected", targetId: CANDIDATES[0].id }, j.answers[0]);
    assert.equal(j.calls.length, 1);
  });

  it("returns no_match with a null target", async () => {
    const j = jev((q) => choice(q, "no_match", { confidence: 0.97, top: 0.95, second: 0.02 }));
    const { result } = await decide(targetBody("follow Flamengo vs Palmeiras"), { transport: j.transport });
    assertDecision(result, "target", { status: "no_match", targetId: null }, j.answers[0]);
  });

  it("treats abstain as clarify with a null target", async () => {
    const j = jev((q) => choice(q, "uncertain", { confidence: 0.99, top: 0.99, second: 0.005 }));
    const { result } = await decide(targetBody("follow the Chelsea match"), { transport: j.transport });
    assertDecision(result, "target", { status: "clarify", targetId: null }, j.answers[0]);
  });

  it("clarifies a low-margin pick between two public fixtures", async () => {
    const j = jev((q) => choice(q, optionFor(q, CANDIDATES[0].label), {
      confidence: 0.9, top: 0.5, second: 0.45, runnerUp: optionFor(q, CANDIDATES[1].label),
    }));
    const { result } = await decide(targetBody("follow Chelsea vs Arsenal"), { transport: j.transport });
    assertDecision(result, "target", { status: "clarify", targetId: null }, j.answers[0]);
  });

  it("clarifies a low-confidence no_match", async () => {
    const j = jev((q) => choice(q, "no_match", { confidence: 0.5, top: 0.9, second: 0.05 }));
    const { result } = await decide(targetBody(), { transport: j.transport });
    assertDecision(result, "target", { status: "clarify", targetId: null }, j.answers[0]);
  });

  it("refuses a model-authored option instead of trusting it", async () => {
    const j = jev((q) => ({ ...choice(q, "no_match", { confidence: 0.99, top: 0.99 }), choice: "pub_fx_injected" }));
    const { result } = await decide(targetBody(), { transport: j.transport });
    assertFailure(result, "invalid_response");
    assert.equal(j.calls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Request validation: nothing invalid reaches Jev
// ---------------------------------------------------------------------------

describe("watch-decision request validation", () => {
  const many = (n, label = (i) => `Public fixture ${i}`) =>
    Array.from({ length: n }, (_, i) => ({ id: `pub_fx_${String(i).padStart(3, "0")}`, label: label(i) }));
  const refs = (n) => many(n).map((c) => c.id);

  const bad = {
    "not json": "{nope",
    "array": JSON.stringify([intentBody()]),
    "empty": "",
    "unknown stage": intentBody(undefined, undefined, { stage: "select" }),
    "missing stage": (({ stage, ...rest }) => rest)(intentBody()),
    "empty text": intentBody("   "),
    "text over 4000": intentBody("x".repeat(4001)),
    "locale EN": intentBody(undefined, "EN"),
    "locale fr": intentBody(undefined, "fr"),
    // Every field within its own bound; only the UTF-8 byte total is over.
    "body over 32KiB": targetBody(undefined, { candidates: many(100, () => "é".repeat(160)) }),
    "intent with candidates": intentBody(undefined, undefined, { candidates: CANDIDATES }),
    "intent with referenceIds": intentBody(undefined, undefined, { referenceIds: [] }),
    "target missing candidates": (({ candidates, ...rest }) => rest)(targetBody()),
    "target zero candidates": targetBody(undefined, { candidates: [] }),
    "101 candidates": targetBody(undefined, { candidates: many(101) }),
    "label over 160": targetBody(undefined, { candidates: [{ id: "pub_fx_a", label: "l".repeat(161) }, CANDIDATES[0]] }),
    "duplicate candidate id": targetBody(undefined, { candidates: [CANDIDATES[0], { ...CANDIDATES[0], label: "other" }] }),
    "non-opaque candidate id": targetBody(undefined, { candidates: [{ id: "pub fx", label: "x" }, CANDIDATES[0]] }),
    "candidate private field": targetBody(undefined, { candidates: [{ ...CANDIDATES[0], subscriptionId: "sub_active_1" }] }),
    "candidate owner field": targetBody(undefined, { candidates: [{ ...CANDIDATES[0], owned: true }] }),
    "11 referenceIds": targetBody(undefined, { candidates: many(11), referenceIds: refs(11) }),
    "nonmember referenceId": targetBody(undefined, { referenceIds: ["pub_fx_elsewhere"] }),
    "duplicate referenceId": targetBody(undefined, { referenceIds: [CANDIDATES[0].id, CANDIDATES[0].id] }),
    "referenceIds not a list": targetBody(undefined, { referenceIds: CANDIDATES[0].id }),
    "legacy eligible on new contract": intentBody(undefined, undefined, { eligible: { takes: [], subscriptions: [] } }),
    "private subscriptions": targetBody(undefined, { subscriptions: [{ id: "sub_active_1" }] }),
    "history": intentBody(undefined, undefined, { history: [{ role: "user", content: "earlier" }] }),
    "identity": intentBody(undefined, undefined, { userId: "acct_5150" }),
    "profile": intentBody(undefined, undefined, { profile: { team: "Chelsea" } }),
  };
  for (const key of ["model", "provider", "endpoint", "baseUrl", "apiKey", "dataPolicy", "mode", "timeoutMs", "purpose"]) {
    bad[`request-owned ${key}`] = intentBody(undefined, undefined, { [key]: key === "timeoutMs" ? 60_000 : "jev-9.9.9" });
  }

  // Refused before the contract is known: either envelope contract is acceptable.
  const preParse = new Set(["not json", "array", "empty", "body over 32KiB"]);
  for (const [label, body] of Object.entries(bad)) {
    it(`refuses ${label} as invalid_request with zero Jev calls`, async () => {
      const j = jev();
      const { result, generative } = await decide(body, { transport: j.transport });
      if (preParse.has(label)) {
        assert.equal(result.ok, false);
        assert.equal(result.reasonCode, "invalid_request");
      } else {
        assertFailure(result, "invalid_request", label);
      }
      assert.equal(j.calls.length, 0, label);
      assert.equal(generative.length, 0, label);
    });
  }

  it("accepts every bound exactly at its limit without truncation", async () => {
    const text = "t".repeat(4000);
    const candidates = many(100, (i) => `${String(i).padStart(3, "0")}${"L".repeat(157)}`);
    const body = { contract: D, stage: "target", text, locale: "en", candidates, referenceIds: refs(10) };
    assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 32 * 1024, "fixture sanity: within 32KiB");
    const j = jev((q) => choice(q, optionFor(q, candidates[99].label), { confidence: 0.9, top: 0.9, second: 0.05 }));
    const { result } = await decide(body, { transport: j.transport });
    assertDecision(result, "target", { status: "selected", targetId: "pub_fx_099" }, j.answers[0]);
    assert.equal(j.calls.length, 1);
    assert.equal(Object.keys(onlyQuestion(j.calls[0].wire)[1].criteria).length, 102);
    assertWire(j.calls[0], [text, candidates[0].label, candidates[99].label]);
  });
});

// ---------------------------------------------------------------------------
// Operator gates: consent, credential, native-only isolation
// ---------------------------------------------------------------------------

describe("watch-decision operator gates", () => {
  const without = (key) => Object.fromEntries(Object.entries(ENV).filter(([k]) => k !== key));
  const disabled = {
    "route flag unset": without("SPORTSCLAW_WATCH_INTENT_ENABLED"),
    "Jev flag unset": without("SPORTSCLAW_WATCH_JEV_ENABLED"),
    "Jev flag 1": { ...ENV, SPORTSCLAW_WATCH_JEV_ENABLED: "1" },
    "Jev flag TRUE": { ...ENV, SPORTSCLAW_WATCH_JEV_ENABLED: "TRUE" },
    "data policy unset": without("SPORTSCLAW_WATCH_JEV_DATA_POLICY"),
    "data policy local_only": { ...ENV, SPORTSCLAW_WATCH_JEV_DATA_POLICY: "local_only" },
    "data policy misspelled": { ...ENV, SPORTSCLAW_WATCH_JEV_DATA_POLICY: "Cloud_Allowed" },
    "generic decision consent only": { ...without("SPORTSCLAW_WATCH_JEV_DATA_POLICY"), SPORTSCLAW_DECISION_DATA_POLICY: "cloud_allowed" },
    "explicit native-only route": {
      ...ENV,
      SPORTSCLAW_WATCH_INTENT_NATIVE_CONFIG: JSON.stringify({ route: "nim", model: "synthetic-native-model", baseUrl: "http://127.0.0.1:9/v1" }),
    },
  };
  for (const [label, env] of Object.entries(disabled)) {
    it(`${label}: disabled, zero Jev calls, no generative fallback`, async () => {
      const j = jev();
      const { result, generative } = await decide(intentBody(), { env, transport: j.transport });
      assert.equal(result.ok, false, label);
      assert.equal(result.reasonCode, "disabled", label);
      if (env.SPORTSCLAW_WATCH_INTENT_ENABLED === "true") assertFailure(result, "disabled", label);
      assert.equal(j.calls.length, 0, label);
      assert.equal(generative.length, 0, label);
    });
  }

  for (const [label, key] of [["missing", undefined], ["blank", "   "]]) {
    it(`a ${label} TYPESAFE_API_KEY is inference_unavailable before egress`, async () => {
      const env = key === undefined ? without("TYPESAFE_API_KEY") : { ...ENV, TYPESAFE_API_KEY: key };
      const j = jev();
      const { result, generative } = await decide(targetBody(), { env, transport: j.transport });
      assertFailure(result, "inference_unavailable");
      assert.equal(j.calls.length, 0);
      assert.equal(generative.length, 0);
    });
  }

  it("ignores the generic provider/model env and generic Jev defaults", async () => {
    const env = { ...ENV, SPORTSCLAW_PROVIDER: "openai", SPORTSCLAW_MODEL: "jev-1.13.0", OPENAI_API_KEY: "x" };
    const j = jev((q) => choice(q, "follow", { confidence: 0.99, top: 0.99 }));
    const { result } = await decide(intentBody(), { env, transport: j.transport });
    assert.equal(result.model, MODEL);
    assert.equal(j.calls[0].wire.model, MODEL);
    assert.equal(decisionClient.DEFAULT_JEV_MODEL, "jev-1.13.0", "global decision default is unchanged");
  });
});

// ---------------------------------------------------------------------------
// Jev failures: typed, never a fallback, never "ordinary"
// ---------------------------------------------------------------------------

describe("watch-decision Jev failures", () => {
  const follow = (q) => choice(q, "follow", { confidence: 0.99, top: 0.99 });
  const failures = {
    "401": [() => reply(401, { error: "bad key" }), "inference_unavailable"],
    "403": [() => reply(403, { error: "forbidden" }), "inference_unavailable"],
    "429": [() => reply(429, { error: "slow down" }), "inference_unavailable"],
    "500": [() => reply(500, { error: "boom" }), "inference_unavailable"],
    "redirect": [() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example" } }), "inference_unavailable"],
    "malformed JSON": [() => reply(200, "{not json"), "invalid_response"],
    "model mismatch": [(q, wire) =>
      reply(200, { model: "jev-1.13.0", answers: { [Object.keys(wire.questions)[0]]: follow(q) } }), "invalid_response"],
    "probabilities off": [(q) => ({ ...follow(q), probabilities: p({ follow: 0.5 }) }), "invalid_response"],
  };
  for (const [label, [respond, reasonCode]] of Object.entries(failures)) {
    it(`${label} -> ${reasonCode} after exactly one call`, async () => {
      const j = jev(respond);
      const { result, generative } = await decide(intentBody(), { transport: j.transport });
      assertFailure(result, reasonCode, label);
      assert.equal(j.calls.length, 1, label);
      assert.equal(generative.length, 0, `${label}: no generative fallback`);
    });
  }

  it("a network error is inference_unavailable", async () => {
    let calls = 0;
    const transport = async () => {
      calls += 1;
      throw new TypeError("fetch failed: synthetic");
    };
    const { result, generative } = await decide(intentBody(), { transport });
    assertFailure(result, "inference_unavailable");
    assert.equal(calls, 1);
    assert.equal(generative.length, 0);
  });

  it("the client deadline maps to timeout", { timeout: 10_000 }, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = hanging();
    const pending = decide(intentBody(), { transport: h.transport });
    assert.equal(await Promise.race([h.started.then(() => true), pending.then(() => false)]), true, "request must reach the controlled transport before it settles");
    t.mock.timers.tick(60_000);
    const { result, generative } = await pending;
    assertFailure(result, "timeout");
    assert.equal(h.calls.length, 1);
    assert.equal(generative.length, 0);
  });

  it("an already-cancelled caller makes no call", async () => {
    const j = jev();
    const { result } = await decide(intentBody(), { transport: j.transport, abortSignal: AbortSignal.abort() });
    assertFailure(result, "aborted");
    assert.equal(j.calls.length, 0);
  });

  it("a mid-flight cancel aborts the Jev request", { timeout: 10_000 }, async () => {
    const h = hanging();
    const controller = new AbortController();
    const pending = decide(targetBody(), { transport: h.transport, abortSignal: controller.signal });
    assert.equal(await Promise.race([h.started.then(() => true), pending.then(() => false)]), true, "request must reach the controlled transport before it settles");
    controller.abort();
    const { result, generative } = await pending;
    assertFailure(result, "aborted");
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].init.signal.aborted, true, "the transport signal is cancelled");
    assert.equal(generative.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Legacy compatibility and import graph
// ---------------------------------------------------------------------------

describe("watch-intent-v1 is untouched by the Jev consumer", () => {
  it("still uses the generative interpreter with Jev fully enabled", async () => {
    const model = {
      calls: [],
      specificationVersion: "v2",
      provider: "fake",
      modelId: "fake-intent-model",
      supportedUrls: {},
      async doGenerate(options) {
        this.calls.push(options);
        return { content: [{ type: "text", text: '{"action":"follow","targetId":"take_lakers_clutch"}' }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
      },
      async doStream() {
        throw new Error("no streaming");
      },
    };
    const j = jev();
    const body = {
      contract: LEGACY, text: "follow the Lakers clutch take", locale: "en",
      eligible: { takes: [{ id: "take_lakers_clutch", label: "Lakers clutch moments" }], subscriptions: [] },
    };
    const result = await relay.runWatchIntent(JSON.stringify(body), { env: { ...ENV }, decisionTransport: j.transport, createModel: () => model });
    assert.deepEqual(result, { contract: LEGACY, ok: true, intent: { action: "follow", targetId: "take_lakers_clutch" } });
    assert.equal(model.calls.length, 1);
    assert.equal(j.calls.length, 0);
  });
});

function runWorker(input, env = {}) {
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (/_API_KEY$|^SPORTSCLAW_|^OPENAI_BASE_URL$|^NIM_|^TYPESAFE_/.test(key)) delete childEnv[key];
  }
  Object.assign(childEnv, env);
  return spawnSync(process.execPath, [WORKER], { input, encoding: "utf-8", timeout: 60_000, env: childEnv });
}

describe("watch-decision compiled worker", () => {
  it("answers one typed line without a credential and without egress", () => {
    const { TYPESAFE_API_KEY, ...env } = ENV;
    const run = runWorker(JSON.stringify(intentBody("Watch the Chelsea game · acct_5150")), env);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    const lines = run.stdout.split("\n").filter(Boolean);
    assert.equal(lines.length, 1, run.stdout);
    assert.deepEqual(JSON.parse(lines[0]), { contract: D, ok: false, reasonCode: "inference_unavailable" });
    assert.doesNotMatch(run.stdout, /Chelsea|acct_5150/);
  });

  it("reaches Jev only through inference/decide and the decision client", () => {
    const seen = new Set();
    const visit = (file) => {
      if (seen.has(file)) return;
      seen.add(file);
      let source;
      try {
        source = readFileSync(file, "utf-8");
      } catch {
        return;
      }
      for (const [, spec] of [...source.matchAll(/\bfrom\s*"([^"]+)"/g), ...source.matchAll(/\bimport\s*\(\s*"([^"]+)"/g)]) {
        if (spec.startsWith(".")) visit(join(dirname(file), spec));
      }
    };
    visit(WORKER);
    const rels = [...seen].map((f) => f.slice(distDir.length + 1));
    assert.ok(rels.includes("inference/decide.js"), "the Jev path uses the unified decision boundary");
    assert.ok(rels.includes("decision-client.js"));
    for (const rel of rels) {
      assert.doesNotMatch(rel, /^(engine|mcp|tools|index|operate|operator-daemon|decision-relay)\.js$|memory|listeners?\//, rel);
    }
  });
});

describe("watch-decision Python relay contract", () => {
  it("docker/relay/test_watch_decision.py passes", () => {
    const script = join(repoRoot, "docker/relay/test_watch_decision.py");
    assert.ok(existsSync(script));
    const run = spawnSync(PYTHON, [script], {
      encoding: "utf-8",
      timeout: 120_000,
      env: { ...process.env, WD_NODE_BIN: process.execPath },
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  });
});
