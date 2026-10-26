/**
 * Jev slip decision — `slip-decision-v1` via `runSlipDecision()` in
 * dist/slip-decision.js.
 *
 *   request {contract,text,proposal:SlipChange,context:SlipRevision|null}
 *        -> {contract,ok:true,decision:{status:"selected",change,model}}
 *         | {contract,ok:true,decision:{status:"none"|"clarify",model}}
 *         | {contract,ok:false,reasonCode}
 *
 * The answer model's proposal is a candidate extraction, not an authorized
 * action. Jev (native unified inference `decide` + the existing
 * JevDecisionClient, pinned jev-1.14.0) selects the action, and for targeted
 * actions the target among the current legs offered under ephemeral labels
 * leg_1..leg_n. Any disagreement with the proposal is clarify; confirm is never
 * an option. `options.transport` is the existing DecisionTransport seam: only
 * the network is mocked.
 *
 * Operator gates: SPORTSCLAW_SLIP_ENABLED=true AND
 * SPORTSCLAW_SLIP_JEV_DATA_POLICY=cloud_allowed, no native-only route
 * (SPORTSCLAW_WATCH_INTENT_NATIVE_CONFIG or SPORTSCLAW_SLIP_NATIVE_ONLY=true).
 * Initial conservative policy: confidence >= 0.80 AND margin >= 0.15 (borrowed
 * from watch decisions; not a calibration claim).
 *
 * Question layout is deliberately not frozen beyond: one Choice question
 * whose options are exactly the seven actions, and (targeted actions only) one
 * Choice question whose options are leg_1..leg_n, optionally proposed_group,
 * and clarify. The mock answers whichever of those it is sent.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

const decision = await import("../dist/slip-decision.js");

const C = "slip-decision-v1";
const MODEL = "jev-1.14.0";
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const KEY = "synthetic-typesafe-test-credential";
const ENV = Object.freeze({
  SPORTSCLAW_SLIP_ENABLED: "true",
  SPORTSCLAW_SLIP_JEV_DATA_POLICY: "cloud_allowed",
  TYPESAFE_API_KEY: KEY,
});
const ACTIONS = ["create", "append", "remove", "replace", "review", "none", "clarify"];

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
  assert.equal(escapedFetches, 0, "every Jev call must go through the injected transport");
});

// ---------------------------------------------------------------------------
// Fixtures: every private ID carries SENTINEL so egress checks are one search
// ---------------------------------------------------------------------------

const sid = (prefix, tag) => `${prefix}_${(tag + "0".repeat(22)).slice(0, 22)}`;
const clone = (value) => structuredClone(value);

const SLIP_ID = sid("slp", "SENTINELslip");
const REV_ID = sid("slr", "SENTINELrev");
const LEG_IDS = [sid("sll", "SENTINELlegA"), sid("sll", "SENTINELlegB"), sid("sll", "SENTINELlegC")];

const LEG_A = {
  event: "Chelsea vs Arsenal", market: "Match result", selection: "Chelsea", period: null, line: null,
  quotedOdds: { value: "2.10", format: "decimal" }, source: "user_text", unresolved: [],
};
const LEG_B = {
  event: "Lakers vs Celtics", market: "Spread", selection: "Lakers", period: "Full game", line: "-3.5",
  quotedOdds: null, source: "user_text", unresolved: [],
};
const LEG_C = {
  event: "Flamengo vs Palmeiras", market: "Total goals", selection: "Over", period: null, line: "2.5",
  quotedOdds: { value: "+120", format: "american" }, source: "user_image", unresolved: [],
};
const LEG_D = {
  event: "Real Madrid vs Barcelona", market: "Both teams to score", selection: "Yes", period: null, line: null,
  quotedOdds: null, source: "user_text", unresolved: [],
};

const CONTEXT = Object.freeze({
  contract: "slip-revision-v1",
  slipId: SLIP_ID,
  revisionId: REV_ID,
  parentRevisionId: null,
  status: "proposed",
  legs: [LEG_A, LEG_B, LEG_C].map((leg, i) => ({ ...clone(leg), id: LEG_IDS[i] })),
  unresolved: [],
});

const change = (action, { base = null, targets = [], legs = [] } = {}) => ({
  contract: "slip-change-v1", action, baseRevisionId: base, targetLegIds: targets, legs: legs.map(clone), unresolved: [],
});

const CREATE = change("create", { legs: [LEG_A, LEG_B] });
const APPEND = change("append", { base: REV_ID, legs: [LEG_D] });
const REMOVE_B = change("remove", { base: REV_ID, targets: [LEG_IDS[1]] });
const REMOVE_AC = change("remove", { base: REV_ID, targets: [LEG_IDS[0], LEG_IDS[2]] });
const REPLACE_C = change("replace", { base: REV_ID, targets: [LEG_IDS[2]], legs: [LEG_D] });

const request = (text, proposal, context = null, extra = {}) =>
  ({ contract: C, text, proposal: clone(proposal), context: context && clone(context), ...extra });

// ---------------------------------------------------------------------------
// Real-shaped Jev mock (same packets as test/watch-decision.test.mjs)
// ---------------------------------------------------------------------------

const reply = (status, payload) =>
  new Response(typeof payload === "string" ? payload : JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A real-shaped Choice answer over the offered options. */
function choice(question, option, { confidence, top = confidence, second = 0, runnerUp } = {}) {
  const keys = Object.keys(question.criteria);
  assert.ok(keys.includes(option), `offered options must include ${option}: ${keys}`);
  const others = keys.filter((k) => k !== option);
  const ru = runnerUp ?? others[0];
  const rest = others.filter((k) => k !== ru);
  const share = rest.length ? (1 - top - second) / rest.length : 0;
  const probabilities = {};
  for (const k of keys) probabilities[k] = k === option ? top : k === ru ? second : share;
  return { type: "choice", choice: option, confidence, probabilities };
}

const isActionQuestion = (q) => ACTIONS.every((a) => Object.hasOwn(q.criteria, a));

/** Option whose description carries this leg's event. */
function legOption(question, leg) {
  const hits = Object.entries(question.criteria).filter(([, text]) => text.includes(leg.event));
  assert.equal(hits.length, 1, `exactly one option describes ${leg.event}`);
  return hits[0][0];
}

const SURE = { confidence: 0.95, top: 0.9, second: 0.05 };

/**
 * Answer plan: `action` for the action question, `target` (a leg fixture or a
 * literal option such as "proposed_group"/"clarify") for the target question.
 * A target question that the plan did not expect fails the test.
 */
const plan = ({ action, actionSpec = SURE, target, targetSpec = SURE }) => (q) => {
  assert.equal(q.type, "choice");
  if (isActionQuestion(q)) return choice(q, action, actionSpec);
  assert.ok(target, `no target question expected: ${Object.keys(q.criteria)}`);
  return choice(q, typeof target === "string" ? target : legOption(q, target), targetSpec);
};

/** Mock Jev network: answers each question of each request through `answer`. */
function jev(answer = () => assert.fail("Jev must not be called")) {
  const calls = [];
  const transport = async (url, init) => {
    const wire = JSON.parse(init.body);
    calls.push({ url, init, wire });
    const answers = {};
    for (const [id, question] of Object.entries(wire.questions)) {
      const out = answer(question, wire);
      if (out instanceof Response) return out;
      answers[id] = out;
    }
    return reply(200, { model: MODEL, answers, usage: { input_tokens: 140, output_tokens: 4 } });
  };
  return { calls, transport };
}

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

const run = (body, { env = ENV, transport = jev().transport, ...rest } = {}) =>
  decision.runSlipDecision(body, { env: { ...env }, transport, ...rest });

const questionsOf = (calls) => calls.flatMap((c) => Object.values(c.wire.questions));
const targetQuestion = (calls) => questionsOf(calls).find((q) => !isActionQuestion(q));

function assertSelected(result, change) {
  assert.deepEqual(result, { contract: C, ok: true, decision: { status: "selected", change, model: MODEL } });
}

function assertStatus(result, status) {
  assert.deepEqual(result, { contract: C, ok: true, decision: { status, model: MODEL } });
}

function assertFailure(result, reasonCode, label = reasonCode) {
  assert.deepEqual(result, { contract: C, ok: false, reasonCode }, label);
}

/** Fixed endpoint, pinned model, server credential, and nothing private on the wire. */
function assertWire(calls, mustInclude = []) {
  assert.ok(calls.length >= 1);
  for (const call of calls) {
    assert.equal(call.url, ENDPOINT);
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.redirect, "manual");
    assert.equal(new Headers(call.init.headers).get("authorization"), `Bearer ${KEY}`);
    assert.deepEqual(Object.keys(call.wire).sort(), ["model", "questions", "state"]);
    assert.equal(call.wire.model, MODEL);
    assert.ok(!call.init.body.includes("SENTINEL"), "no slip, revision or leg ID reaches Jev");
    assert.ok(!call.init.body.includes(KEY), "the credential travels only in the header");
    assert.doesNotMatch(call.init.body, /acct_|ownerId|userId|"history"|"profile"|slipId|revisionId/);
    for (const q of Object.values(call.wire.questions)) {
      assert.ok(!Object.hasOwn(q.criteria, "confirm"), "confirm is never offered");
    }
  }
  const state = calls.map((c) => JSON.stringify(c.wire.state)).join("\n");
  for (const s of mustInclude) assert.ok(state.includes(s), `state carries ${s}`);
}

// ---------------------------------------------------------------------------
// Selected changes
// ---------------------------------------------------------------------------

describe("slip-decision selected changes", () => {
  it("identifies the complete singleton draft in target guidance without bypassing Jev", async () => {
    const context = { ...clone(CONTEXT), legs: [clone(CONTEXT.legs[1])] };
    const proposal = change("review", { base: REV_ID, targets: [LEG_IDS[1]] });
    const j = jev(plan({ action: "review", target: "leg_1", targetSpec: { confidence: 0.95, top: 0.95, second: 0.05 } }));
    assertSelected(await run(request("Review the remaining leg without changes", proposal, context), { transport: j.transport }), proposal);
    assert.equal(j.calls.length, 2);
    const q = targetQuestion(j.calls);
    assert.match(q.instructions, /complete active draft/i);
    assert.match(q.instructions, /exactly one current leg/i);
    assert.match(q.instructions, /conflicting event or selection/i);
    assert.match(q.instructions, /Explicit ordinal references/i);
    assert.match(q.criteria.leg_1, /^Only current slip leg:/);
    assertWire(j.calls);
  });

  it("keeps singleton target abstention and confidence gates instead of forcing the only leg", async () => {
    const context = { ...clone(CONTEXT), legs: [clone(CONTEXT.legs[1])] };
    const proposal = change("review", { base: REV_ID, targets: [LEG_IDS[1]] });
    for (const target of ["clarify", "leg_1"]) {
      const j = jev(plan({ action: "review", target, targetSpec: target === "clarify" ? {confidence:0.95,top:0.95,second:0.05} : {confidence:0.79,top:0.9,second:0.1} }));
      assertStatus(await run(request("Review a different event", proposal, context), { transport: j.transport }), "clarify");
      assert.equal(j.calls.length, 2);
      assertWire(j.calls);
    }
    assert.equal(decision.SLIP_DECISION_POLICY.minConfidence, 0.8);
    assert.equal(decision.SLIP_DECISION_POLICY.minMargin, 0.15);
  });

  it("selects a create from a new slip request with exactly the seven action options", async () => {
    const j = jev(plan({ action: "create" }));
    const text = "Make me a slip: Chelsea to beat Arsenal at 2.10 and Lakers -3.5";
    assertSelected(await run(request(text, CREATE), { transport: j.transport }), CREATE);
    const [actionQ, ...others] = questionsOf(j.calls);
    assert.deepEqual(Object.keys(actionQ.criteria).sort(), [...ACTIONS].sort());
    assert.equal(others.length, 0, "create has no target question");
    assertWire(j.calls, [text]);
  });

  it("selects an append against the current slip", async () => {
    const j = jev(plan({ action: "append" }));
    const result = await run(request("Add Real Madrid v Barcelona both teams to score", APPEND, CONTEXT), { transport: j.transport });
    assertSelected(result, APPEND);
    assertWire(j.calls);
  });

  it("selects a targeted remove under ephemeral labels and maps back to the real leg ID locally", async () => {
    const j = jev(plan({ action: "remove", target: LEG_B }));
    const result = await run(request("Drop the Lakers leg", REMOVE_B, CONTEXT), { transport: j.transport });
    assertSelected(result, REMOVE_B);
    const q = targetQuestion(j.calls);
    assert.deepEqual(Object.keys(q.criteria).filter((k) => k.startsWith("leg_")), ["leg_1", "leg_2", "leg_3"]);
    assert.equal(legOption(q, LEG_B), "leg_2");
    assert.ok(Object.hasOwn(q.criteria, "clarify"), "the target question can abstain");
    assert.ok(!Object.hasOwn(q.criteria, "proposed_group"), "no group option for a singleton proposal");
    assertWire(j.calls, ["Drop the Lakers leg", LEG_A.event, LEG_B.event, LEG_C.event]);
  });

  it("selects a targeted replace", async () => {
    const j = jev(plan({ action: "replace", target: LEG_C }));
    const result = await run(request("Swap the Flamengo total for Madrid v Barca BTTS", REPLACE_C, CONTEXT), { transport: j.transport });
    assertSelected(result, REPLACE_C);
  });

  it("returns none for an ordinary turn", async () => {
    const j = jev(plan({ action: "none", actionSpec: { confidence: 1, top: 1 } }));
    assertStatus(await run(request("What time does Chelsea kick off?", APPEND, CONTEXT), { transport: j.transport }), "none");
    assert.equal(targetQuestion(j.calls), undefined, "none needs no target");
  });

  it("emits sanitized receipts with the actual pinned model and no private content", async () => {
    const receipts = [];
    const j = jev(plan({ action: "remove", target: LEG_B }));
    const result = await run(request("Drop the Lakers leg", REMOVE_B, CONTEXT), {
      transport: j.transport,
      onReceipt: (r) => receipts.push(r),
    });
    assert.equal(result.ok, true);
    assert.ok(receipts.length >= 1);
    for (const r of receipts) {
      assert.equal(r.kind, "decision");
      assert.equal(r.status, "completed");
      assert.equal(r.decision.model, MODEL);
      assert.equal(r.decision.requestedModel, MODEL);
    }
    const serialized = JSON.stringify(receipts);
    for (const leak of ["SENTINEL", "Lakers", "Drop the", "leg_2", KEY]) {
      assert.ok(!serialized.includes(leak), `receipt must not carry ${leak}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Multi-target interpretation
// ---------------------------------------------------------------------------

describe("slip-decision multi-target groups", () => {
  it("offers one proposed_group option for a valid multi-target remove and selects it", async () => {
    const j = jev(plan({ action: "remove", target: "proposed_group" }));
    const result = await run(request("Remove the Chelsea and Flamengo legs", REMOVE_AC, CONTEXT), { transport: j.transport });
    assertSelected(result, REMOVE_AC);
    const q = targetQuestion(j.calls);
    const keys = Object.keys(q.criteria);
    assert.equal(keys.filter((k) => k === "proposed_group").length, 1);
    assert.deepEqual(keys.filter((k) => k.startsWith("leg_")), ["leg_1", "leg_2", "leg_3"]);
    assert.equal(keys.length, 5, "legs + proposed_group + clarify; no invented subsets");
    assertWire(j.calls);
  });

  it("clarifies when Jev picks one member of a plural request", async () => {
    const j = jev(plan({ action: "remove", target: LEG_A }));
    assertStatus(await run(request("Remove the Chelsea and Flamengo legs", REMOVE_AC, CONTEXT), { transport: j.transport }), "clarify");
  });

  it("clarifies when the chosen single target disagrees with the proposal's target", async () => {
    const j = jev(plan({ action: "remove", target: LEG_C }));
    assertStatus(await run(request("Drop the Lakers leg", REMOVE_B, CONTEXT), { transport: j.transport }), "clarify");
  });

  it("clarifies when no complete target interpretation exists", async () => {
    const j = jev(plan({ action: "remove", target: "clarify", targetSpec: { confidence: 1, top: 1 } }));
    assertStatus(await run(request("Drop that one", REMOVE_B, CONTEXT), { transport: j.transport }), "clarify");
  });
});

// ---------------------------------------------------------------------------
// Uncertainty, mismatch and thresholds
// ---------------------------------------------------------------------------

describe("slip-decision policy", () => {
  it("treats a full-confidence clarify as clarify", async () => {
    const j = jev(plan({ action: "clarify", actionSpec: { confidence: 1, top: 1 } }));
    assertStatus(await run(request("Do something with my slip", APPEND, CONTEXT), { transport: j.transport }), "clarify");
  });

  it("clarifies, without repairing, when the selected action disagrees with the proposal", async () => {
    const j = jev(plan({ action: "remove", target: LEG_B }));
    assertStatus(await run(request("Add Madrid v Barca", APPEND, CONTEXT), { transport: j.transport }), "clarify");
    assert.equal(j.calls.length <= 2, true, "no extra repair call");
  });

  it("passes the gate at exactly confidence 0.80 with a 0.15 margin", async () => {
    const j = jev(plan({ action: "create", actionSpec: { confidence: 0.8, top: 0.55, second: 0.4 } }));
    assertSelected(await run(request("Make me a slip", CREATE), { transport: j.transport }), CREATE);
  });

  it("clarifies on low winning confidence even with a decisive distribution", async () => {
    const j = jev(plan({ action: "create", actionSpec: { confidence: 0.79, top: 0.99, second: 0.01 } }));
    assertStatus(await run(request("Make me a slip", CREATE), { transport: j.transport }), "clarify");
  });

  it("clarifies on a narrow top-two margin even with high confidence", async () => {
    const j = jev(plan({ action: "create", actionSpec: { confidence: 0.95, top: 0.5, second: 0.36, runnerUp: "none" } }));
    assertStatus(await run(request("Make me a slip", CREATE), { transport: j.transport }), "clarify");
  });

  it("clarifies an uncertain 'none' rather than answering ordinarily", async () => {
    const j = jev(plan({ action: "none", actionSpec: { confidence: 0.6, top: 0.6, second: 0.3, runnerUp: "append" } }));
    assertStatus(await run(request("Madrid later?", APPEND, CONTEXT), { transport: j.transport }), "clarify");
  });

  it("clarifies a low-margin target pick", async () => {
    const j = jev(plan({
      action: "remove",
      target: LEG_B,
      targetSpec: { confidence: 0.9, top: 0.5, second: 0.45, runnerUp: "leg_1" },
    }));
    assertStatus(await run(request("Drop that leg", REMOVE_B, CONTEXT), { transport: j.transport }), "clarify");
  });
});

// ---------------------------------------------------------------------------
// Strict request validation: nothing invalid reaches Jev
// ---------------------------------------------------------------------------

describe("slip-decision private identifier egress", () => {
  for (const marker of [CONTEXT.slipId, CONTEXT.revisionId, ...LEG_IDS, sid("sll", "unknownPrivate")]) {
    it(`refuses private identifier text ${marker.slice(0, 4)} before credentials or transport`, async () => {
      const j = jev();
      let reads = 0;
      const env = { ...ENV };
      Object.defineProperty(env, "TYPESAFE_API_KEY", { get() { reads += 1; return KEY; } });
      assertFailure(await decision.runSlipDecision(request(`Remove ${marker}`, REMOVE_B, CONTEXT), { env, transport: j.transport }), "invalid_request");
      assert.equal(j.calls.length, 0);
      assert.equal(reads, 0);
    });
  }
  it("refuses private identifiers embedded in semantic leg descriptions before transport", async () => {
    const context = structuredClone(CONTEXT);
    context.legs[0].selection = CONTEXT.revisionId;
    const j = jev();
    assertFailure(await run(request("Drop the Lakers leg", REMOVE_B, context), { transport: j.transport }), "invalid_request");
    assert.equal(j.calls.length, 0);
  });
});

describe("slip-decision import and explanation policy", () => {
  it("distinguishes initial imports and existing-leg explanations from ordinary chat", async () => {
    const j = jev(plan({ action: "create" }));
    await run(request("Here is my supplied slip; review it", CREATE), { transport: j.transport });
    const q = questionsOf(j.calls).find(isActionQuestion);
    assert.ok(q);
    assert.equal(decision.SLIP_DECISION_POLICY.version, "slip-decision-policy-3");
    assert.match(q.criteria.create, /import|capture/i);
    assert.match(q.criteria.create, /suggest/i);
    assert.match(q.criteria.review, /explain/i);
    assert.doesNotMatch(q.instructions, /Questions about games, odds or the slip that do not ask to change or show it are none/);
  });
});

describe("slip-decision request validation", () => {
  const bigLeg = () => ({
    event: "é".repeat(160), market: "é".repeat(160), selection: "é".repeat(160), period: null, line: null,
    quotedOdds: null, source: "user_text", unresolved: Array.from({ length: 16 }, () => "é".repeat(160)),
  });
  const bad = {
    "not an object": "remove the Lakers leg",
    "wrong contract": request("x", CREATE, null, { contract: "slip-decision-v2" }),
    "missing context": (({ context, ...rest }) => rest)(request("x", CREATE)),
    "empty text": request("   ", CREATE),
    "non-string text": { ...request("x", CREATE), text: 42 },
    // 2001 astral characters: 2001 code points, 4002 UTF-16 units.
    "text over 4000 UTF-16 units": request("😀".repeat(2001), CREATE),
    "request over 65536 UTF-8 bytes": request("x".repeat(4000), change("create", { legs: Array.from({ length: 10 }, bigLeg) })),
    "owner id": request("x", CREATE, null, { ownerId: "acct_5150" }),
    "history": request("x", CREATE, null, { history: [{ role: "user", content: "earlier" }] }),
    "request-owned model": request("x", CREATE, null, { model: "jev-9.9.9" }),
    "request-owned data policy": request("x", CREATE, null, { dataPolicy: "cloud_allowed" }),
    "invalid proposal": request("x", { ...CREATE, legs: [{ ...LEG_A, price: 2.1 }] }),
    "model confirm proposal": request("Confirm it", change("confirm", { base: REV_ID }), CONTEXT),
    "invalid context": request("x", REMOVE_B, { ...CONTEXT, ownerId: "acct_5150" }),
    "context with provider leg id": request("x", REMOVE_B, { ...CONTEXT, legs: [{ ...CONTEXT.legs[0], providerEventId: "evt_1" }, ...CONTEXT.legs.slice(1)] }),
    "targeted proposal without context": request("x", REMOVE_B, null),
    "base revision not the context": request("x", change("remove", { base: sid("slr", "SENTINELother"), targets: [LEG_IDS[1]] }), CONTEXT),
    "unknown target leg": request("x", change("remove", { base: REV_ID, targets: [sid("sll", "SENTINELunknown")] }), CONTEXT),
    "replace arity": request("x", change("replace", { base: REV_ID, targets: [LEG_IDS[0], LEG_IDS[1]], legs: [LEG_D] }), CONTEXT),
    "create with existing base": request("x", change("create", { base: REV_ID, legs: [LEG_D] }), CONTEXT),
  };
  for (const [label, body] of Object.entries(bad)) {
    it(`refuses ${label} as invalid_request with zero Jev calls`, async () => {
      const j = jev();
      assertFailure(await run(body, { transport: j.transport }), "invalid_request", label);
      assert.equal(j.calls.length, 0, label);
    });
  }

  it("fixture sanity: the oversize request is only over in total", () => {
    const body = bad["request over 65536 UTF-8 bytes"];
    assert.equal(body.text.length, 4000);
    assert.ok(Buffer.byteLength(JSON.stringify(body.proposal)) <= 65536);
    assert.ok(Buffer.byteLength(JSON.stringify(body)) > 65536);
  });

  it("accepts text of exactly 4000 UTF-16 units without truncation", async () => {
    const text = "😀".repeat(2000);
    const j = jev(plan({ action: "create" }));
    assertSelected(await run(request(text, CREATE), { transport: j.transport }), CREATE);
    assertWire(j.calls, [text]);
  });

  it("does not mutate or retain the caller's request", async () => {
    const body = request("Drop the Lakers leg", REMOVE_B, CONTEXT);
    const before = clone(body);
    const j = jev(plan({ action: "remove", target: LEG_B }));
    const result = await run(body, { transport: j.transport });
    assert.deepEqual(body, before);
    result.decision.change.targetLegIds.push(LEG_IDS[0]);
    assert.deepEqual(body.proposal.targetLegIds, [LEG_IDS[1]]);
  });
});

// ---------------------------------------------------------------------------
// Operator gates and data policy
// ---------------------------------------------------------------------------

describe("slip-decision operator gates", () => {
  const without = (key) => Object.fromEntries(Object.entries(ENV).filter(([k]) => k !== key));
  const disabled = {
    "default env": {},
    "slip flag unset": without("SPORTSCLAW_SLIP_ENABLED"),
    "slip flag TRUE": { ...ENV, SPORTSCLAW_SLIP_ENABLED: "TRUE" },
    "slip data policy unset": without("SPORTSCLAW_SLIP_JEV_DATA_POLICY"),
    "slip data policy local_only": { ...ENV, SPORTSCLAW_SLIP_JEV_DATA_POLICY: "local_only" },
    "watch consent does not cover slips": {
      ...without("SPORTSCLAW_SLIP_JEV_DATA_POLICY"),
      SPORTSCLAW_WATCH_JEV_ENABLED: "true",
      SPORTSCLAW_WATCH_JEV_DATA_POLICY: "cloud_allowed",
      SPORTSCLAW_DECISION_DATA_POLICY: "cloud_allowed",
    },
    "watch native-only route": {
      ...ENV,
      SPORTSCLAW_WATCH_INTENT_NATIVE_CONFIG: JSON.stringify({ route: "nim", model: "synthetic-native-model", baseUrl: "http://127.0.0.1:9/v1" }),
    },
    "slip native-only": { ...ENV, SPORTSCLAW_SLIP_NATIVE_ONLY: "true" },
  };
  for (const [label, env] of Object.entries(disabled)) {
    it(`${label}: disabled with zero Jev calls`, async () => {
      const j = jev();
      assertFailure(await run(request("Drop the Lakers leg", REMOVE_B, CONTEXT), { env, transport: j.transport }), "disabled", label);
      assert.equal(j.calls.length, 0, label);
    });
  }

  it("refuses as disabled before validating the request", async () => {
    const j = jev();
    assertFailure(await run({ junk: true }, { env: {}, transport: j.transport }), "disabled");
  });

  for (const [label, key] of [["missing", undefined], ["blank", "   "]]) {
    it(`a ${label} TYPESAFE_API_KEY is inference_unavailable before egress`, async () => {
      const env = key === undefined ? without("TYPESAFE_API_KEY") : { ...ENV, TYPESAFE_API_KEY: key };
      const j = jev();
      assertFailure(await run(request("Make me a slip", CREATE), { env, transport: j.transport }), "inference_unavailable");
      assert.equal(j.calls.length, 0);
    });
  }

  it("pins jev-1.14.0 regardless of generic provider/model env", async () => {
    const env = { ...ENV, SPORTSCLAW_PROVIDER: "openai", SPORTSCLAW_MODEL: "jev-1.13.0", OPENAI_API_KEY: "x" };
    const j = jev(plan({ action: "create" }));
    assertSelected(await run(request("Make me a slip", CREATE), { env, transport: j.transport }), CREATE);
    for (const call of j.calls) assert.equal(call.wire.model, MODEL);
  });
});

// ---------------------------------------------------------------------------
// Jev failures: typed, one attempt, never a fallback
// ---------------------------------------------------------------------------

describe("slip-decision Jev failures", () => {
  it("emits a bounded slip_decision receipt without private payload fields", async () => {
    const receipts = [];
    const j = jev(plan({ action: "create" }));
    assertSelected(await run(request("Make me a slip", CREATE), { transport: j.transport, onReceipt: (receipt) => receipts.push(receipt) }), CREATE);
    assert.ok(receipts.length > 0);
    assert.equal(receipts[0].purpose, "slip_decision");
    const encoded = JSON.stringify(receipts);
    assert.ok(!encoded.includes("Make me a slip"));
    assert.ok(!encoded.includes(KEY));
    assert.ok(!encoded.includes(JSON.stringify(CREATE)));
  });

  const create = (q) => choice(q, "create", SURE);
  const failures = {
    "401": [() => reply(401, { error: "bad key" }), "inference_unavailable"],
    "429": [() => reply(429, { error: "slow down" }), "inference_unavailable"],
    "500": [() => reply(500, { error: "boom" }), "inference_unavailable"],
    "redirect": [() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example" } }), "inference_unavailable"],
    "malformed JSON": [() => reply(200, "{not json"), "invalid_response"],
    "model mismatch": [(q, wire) =>
      reply(200, { model: "jev-1.13.0", answers: Object.fromEntries(Object.keys(wire.questions).map((id) => [id, create(q)])) }), "invalid_response"],
    "probabilities off": [(q) => ({ ...create(q), probabilities: Object.fromEntries(Object.keys(q.criteria).map((k) => [k, k === "create" ? 0.5 : 0])) }), "invalid_response"],
    "model-authored option": [(q) => ({ ...create(q), choice: "confirm" }), "invalid_response"],
  };
  for (const [label, [respond, reasonCode]] of Object.entries(failures)) {
    it(`${label} -> ${reasonCode} after exactly one call`, async () => {
      const j = jev(respond);
      assertFailure(await run(request("Make me a slip", CREATE), { transport: j.transport }), reasonCode, label);
      assert.equal(j.calls.length, 1, label);
    });
  }

  it("a network error is inference_unavailable", async () => {
    let calls = 0;
    const transport = async () => {
      calls += 1;
      throw new TypeError("fetch failed: synthetic");
    };
    assertFailure(await run(request("Make me a slip", CREATE), { transport }), "inference_unavailable");
    assert.equal(calls, 1);
  });

  it("the client deadline maps to timeout", { timeout: 10_000 }, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = hanging();
    const pending = run(request("Make me a slip", CREATE), { transport: h.transport });
    assert.equal(await Promise.race([h.started.then(() => true), pending.then(() => false)]), true, "request must reach the transport before it settles");
    t.mock.timers.tick(60_000);
    assertFailure(await pending, "timeout");
    assert.equal(h.calls.length, 1);
  });

  it("an already-cancelled caller makes no call", async () => {
    const j = jev();
    assertFailure(await run(request("Make me a slip", CREATE), { transport: j.transport, abortSignal: AbortSignal.abort() }), "aborted");
    assert.equal(j.calls.length, 0);
  });

  it("a mid-flight cancel aborts the Jev request and yields no selected result", { timeout: 10_000 }, async () => {
    const h = hanging();
    const controller = new AbortController();
    const pending = run(request("Drop the Lakers leg", REMOVE_B, CONTEXT), { transport: h.transport, abortSignal: controller.signal });
    assert.equal(await Promise.race([h.started.then(() => true), pending.then(() => false)]), true, "request must reach the transport before it settles");
    controller.abort();
    assertFailure(await pending, "aborted");
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].init.signal.aborted, true, "the transport signal is cancelled");
  });
});
