/**
 * Bounded slip extraction — one tool-free structured-output call after the answer.
 *
 *   - `SLIP_EXTRACTION_SCHEMA` / `parseSlipExtractionEnvelope(value, context)`
 *     from dist/slip-output.js: the exact root envelope {status, change} over
 *     the existing change/leg schema. `none` carries change null; a `proposal`
 *     must pass parseSlipChange and slipProposalProblem against the request
 *     context; a model confirm is never a proposal.
 *   - `extractSlipProposal(input, options)` from dist/slip-extraction.js,
 *     driven through the installed SDK's real generateText/Output processing by
 *     a MockLanguageModelV3 (no fake extractor): exactly one call, no tools or
 *     tool choice, native JSON response format, maxOutputTokens 8192, no retry,
 *     repair or fallback. Inputs are bounded before the call and never
 *     truncated; invalid, truncated or refused output never becomes `none`.
 *
 * Total text bound pinned here: UTF-8 bytes of JSON.stringify(turn) plus UTF-8
 * bytes of answerText must be <= 65536.
 *
 * Nothing here may reach the network.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";

globalThis.AI_SDK_LOG_WARNINGS = false;

const slip = await import("../dist/slip-output.js");
const { extractSlipProposal } = await import("../dist/slip-extraction.js");

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
  assert.equal(escapedFetches, 0, "extraction only talks to the supplied model");
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sid = (prefix, tag) => `${prefix}_${(tag + "0".repeat(22)).slice(0, 22)}`;
const clone = (value) => structuredClone(value);

const REV_ID = sid("slr", "SENTINELrev");
const LEG_IDS = [sid("sll", "SENTINELlegA"), sid("sll", "SENTINELlegB")];

const LEG_A = {
  event: "Chelsea vs Arsenal", market: "Match result", selection: "Chelsea", period: null, line: null,
  quotedOdds: { value: "2.10", format: "decimal" }, source: "user_text", unresolved: [],
};
const LEG_B = {
  event: "Flamengo vs Palmeiras", market: "Total goals", selection: "Over", period: null, line: "2.5",
  quotedOdds: { value: "11/10", format: "fractional" }, source: "user_image", unresolved: [],
};
const SUGGESTED = {
  event: "Lakers vs Celtics", market: "Spread", selection: "Lakers", period: null, line: "-3.5",
  quotedOdds: null, source: "agent_suggestion", unresolved: [],
};

const CONTEXT = Object.freeze({
  contract: "slip-revision-v1",
  slipId: sid("slp", "SENTINELslip"),
  revisionId: REV_ID,
  parentRevisionId: null,
  status: "proposed",
  legs: [LEG_A, LEG_B].map((leg, i) => ({ ...clone(leg), id: LEG_IDS[i] })),
  unresolved: [],
});

const change = (action, { base = null, targets = [], legs = [] } = {}) => ({
  contract: "slip-change-v1", action, baseRevisionId: base, targetLegIds: targets, legs: legs.map(clone), unresolved: [],
});
const MIXED = change("create", { legs: [LEG_A, LEG_B, SUGGESTED] });
const REMOVE_B = change("remove", { base: REV_ID, targets: [LEG_IDS[1]] });

const turn = (requestText, context = null) => ({ contract: "slip-turn-v1", requestText, context: context && clone(context) });

const REQUEST = "Make me a slip from this screenshot: Chelsea to beat Arsenal at 2.10, and add something on the Lakers";
const ANSWER =
  "Drafted Chelsea at 2.10 and Flamengo over 2.5 at 11/10 from your screenshot, plus Lakers -3.5 as my own suggestion. Draft only.";

/** 1x1 PNG. */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG = { data: PNG_B64, mimeType: "image/png" };
const MIB = 1024 * 1024;
/** Base64 of exactly `bytes` decoded bytes, starting with the PNG signature. */
function pngOf(bytes) {
  const buffer = Buffer.alloc(bytes);
  Buffer.from(PNG_B64, "base64").subarray(0, Math.min(8, bytes)).copy(buffer);
  return { data: buffer.toString("base64"), mimeType: "image/png" };
}

// ---------------------------------------------------------------------------
// Scripted model through the real SDK
// ---------------------------------------------------------------------------

const USAGE = { inputTokens: { total: 100 }, outputTokens: { total: 7 }, totalTokens: { total: 107 }, reasoningTokens: { total: undefined } };
const reply = (text, finish = "stop") => ({ content: [{ type: "text", text }], finishReason: { unified: finish, raw: undefined }, usage: USAGE, warnings: [] });
const envelope = (status, value = null) => reply(JSON.stringify({ status, change: value }));

function fake(respond) {
  return new MockLanguageModelV3({ provider: "fake", modelId: "fake-extraction-model", doGenerate: async (options) => respond(options) });
}

/** Run the real helper against a scripted model; returns the result, the model calls and receipts. */
async function extract({ context = null, input, answerText = ANSWER, images, respond = () => envelope("none"), ...options } = {}) {
  const model = fake(respond);
  const receipts = [];
  const result = await extractSlipProposal(
    input ?? { turn: turn(REQUEST, context), answerText, ...(images ? { images } : {}) },
    { model, onReceipt: (r) => receipts.push(r), ...options },
  );
  return { result, calls: model.doGenerateCalls, receipts };
}

const filesOf = (call) => call.prompt.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p) => p.type === "file");

function assertUsage(usage, label) {
  assert.equal(usage?.inputTokens, 100, label);
  assert.equal(usage.outputTokens, 7, label);
  assert.equal(usage.totalTokens, 107, label);
}

function assertFailed(result, reasonCode, label) {
  assert.equal(result.status, "failed", label);
  assert.equal(result.reasonCode, reasonCode, label);
  assert.equal(Object.hasOwn(result, "change"), false, `${label}: a failure carries no change`);
}

/** Resolves true once `signal` aborts, false after `ms`. */
const abortedWithin = (signal, ms) => new Promise((resolve) => {
  if (signal?.aborted) return resolve(true);
  const timer = setTimeout(() => resolve(false), ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    resolve(true);
  }, { once: true });
});

// ---------------------------------------------------------------------------
// Envelope schema and parser
// ---------------------------------------------------------------------------

/** The `enum` of the first `properties[key]` found anywhere under `node`. */
function enumOf(node, key) {
  if (!node || typeof node !== "object") return undefined;
  if (node.properties?.[key]?.enum) return node.properties[key].enum;
  for (const child of Object.values(node)) {
    const found = enumOf(child, key);
    if (found) return found;
  }
  return undefined;
}

describe("SLIP_EXTRACTION_SCHEMA", () => {
  it("does not accept a late valid result from a model that ignores abort", async () => {
    const m = fake(async () => { await new Promise(r => setTimeout(r, 15)); return envelope("none"); });
    const r = await extractSlipProposal({ turn: turn("Ordinary question"), answerText: "Ordinary answer" }, { model: m, timeoutMs: 1 });
    assertFailed(r, "timeout");
  });

  it("is a closed {status, change} root over the existing change schema, without confirm", () => {
    const schema = slip.SLIP_EXTRACTION_SCHEMA;
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties).sort(), ["change", "status"]);
    assert.deepEqual([...schema.required].sort(), ["change", "status"]);
    assert.deepEqual([...schema.properties.status.enum].sort(), ["none", "proposal"]);
    const changeSchema = schema.properties.change;
    assert.match(JSON.stringify(changeSchema), /"null"/, "change is nullable");
    assert.match(JSON.stringify(changeSchema), /"slip-change-v1"/);
    assert.deepEqual([...enumOf(changeSchema, "action")].sort(), ["append", "clarify", "create", "remove", "replace", "review"]);
    assert.deepEqual([...enumOf(changeSchema, "source")].sort(), ["agent_suggestion", "user_image", "user_text"]);
  });

  it("types every fixed and enumerated string for native structured-output providers", () => {
    const nodes = [];
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (!Array.isArray(node) && (Object.hasOwn(node, "enum") || Object.hasOwn(node, "const"))) nodes.push(node);
      for (const child of Object.values(node)) walk(child);
    };
    walk(slip.SLIP_EXTRACTION_SCHEMA);
    assert.ok(nodes.length >= 5, "status, contract, action, format and source are constrained");
    for (const node of nodes) {
      assert.equal(node.type, "string", `typed string constraint: ${JSON.stringify(node)}`);
      assert.ok(Array.isArray(node.enum) && node.enum.every((v) => typeof v === "string"), "a string enum, not an untyped const alone");
    }
    const contract = nodes.find((node) => node.enum.includes("slip-change-v1"));
    assert.deepEqual(contract?.enum, ["slip-change-v1"]);
  });
});

describe("parseSlipExtractionEnvelope", () => {
  it("returns exact independent copies of none and of a valid proposal", () => {
    assert.deepEqual(slip.parseSlipExtractionEnvelope({ status: "none", change: null }, null), { status: "none", change: null });

    const created = { status: "proposal", change: clone(MIXED) };
    const parsed = slip.parseSlipExtractionEnvelope(created, null);
    assert.deepEqual(parsed, created);
    assert.notEqual(parsed.change, created.change);
    assert.equal(parsed.change.legs[0].quotedOdds.value, "2.10", "user text odds kept exactly");
    assert.equal(parsed.change.legs[1].quotedOdds.value, "11/10", "user image odds kept exactly");
    assert.equal(parsed.change.legs[2].quotedOdds, null, "an agent suggestion has no price");
    created.change.legs[0].selection = "Arsenal";
    assert.equal(parsed.change.legs[0].selection, "Chelsea");

    const targeted = { status: "proposal", change: clone(REMOVE_B) };
    assert.deepEqual(slip.parseSlipExtractionEnvelope(targeted, clone(CONTEXT)), targeted);
  });

  it("rejects every envelope outside the exact contract", () => {
    const bad = {
      "none carrying a change": [null, { status: "none", change: clone(MIXED) }],
      "proposal without a change": [null, { status: "proposal", change: null }],
      "missing change": [null, { status: "none" }],
      "extra root key": [null, { status: "none", change: null, saved: true }],
      "unknown status": [null, { status: "saved", change: clone(MIXED) }],
      "action as status": [CONTEXT, { status: "clarify", change: null }],
      "not an object": [null, JSON.stringify({ status: "none", change: null })],
      "array": [null, [{ status: "none", change: null }]],
      "model-authored confirm": [CONTEXT, { status: "proposal", change: change("confirm", { base: REV_ID }) }],
      "priced agent suggestion": [null, { status: "proposal", change: change("create", { legs: [{ ...SUGGESTED, quotedOdds: { value: "1.91", format: "decimal" } }] }) }],
      "remove carrying retained legs": [CONTEXT, { status: "proposal", change: change("remove", { base: REV_ID, targets: [LEG_IDS[0]], legs: [LEG_B] }) }],
      "replace with two legs": [CONTEXT, { status: "proposal", change: change("replace", { base: REV_ID, targets: [LEG_IDS[0]], legs: [LEG_B, SUGGESTED] }) }],
      "wrong base revision": [CONTEXT, { status: "proposal", change: change("remove", { base: sid("slr", "SENTINELother"), targets: [LEG_IDS[1]] }) }],
      "unknown target": [CONTEXT, { status: "proposal", change: change("remove", { base: REV_ID, targets: [sid("sll", "SENTINELunknown")] }) }],
      "targeted change without context": [null, { status: "proposal", change: clone(REMOVE_B) }],
      "lone surrogate": [null, { status: "proposal", change: change("create", { legs: [{ ...LEG_A, selection: "Chelsea \ud800" }] }) }],
      "server leg id on a new leg": [null, { status: "proposal", change: change("create", { legs: [{ ...LEG_A, id: LEG_IDS[0] }] }) }],
    };
    for (const [label, [context, value]] of Object.entries(bad)) {
      assert.equal(slip.parseSlipExtractionEnvelope(value, context && clone(context)), null, label);
    }
  });
});

// ---------------------------------------------------------------------------
// extractSlipProposal through the real SDK
// ---------------------------------------------------------------------------

describe("extractSlipProposal", () => {
  it("makes one tool-free native structured-output call with the caller's model options", async () => {
    const providerOptions = { anthropic: { thinking: { type: "disabled" } } };
    const { result, calls } = await extract({ context: CONTEXT, sampling: { temperature: 0.2, seed: 7 }, providerOptions });

    const { usage, ...rest } = result;
    assert.deepEqual(rest, { status: "none" });
    assertUsage(usage);
    assert.equal(calls.length, 1, "exactly one generate");
    const [call] = calls;
    assert.equal(call.tools?.length ?? 0, 0, "no tools");
    assert.equal(call.toolChoice, undefined, "no tool choice");
    assert.equal(call.responseFormat?.type, "json");
    assert.deepEqual(call.responseFormat.schema, slip.SLIP_EXTRACTION_SCHEMA, "native schema");
    assert.equal(call.maxOutputTokens, 8192);
    assert.equal(call.temperature, 0.2);
    assert.equal(call.seed, 7);
    assert.deepEqual(call.providerOptions, providerOptions);
    assert.ok(call.abortSignal, "the call always carries the bounded deadline");
    assert.ok(call.prompt.every((m) => m.role === "system" || m.role === "user"), "a fresh data prompt, no continuation");
    const seen = JSON.stringify(call.prompt);
    for (const material of [REQUEST, ANSWER, REV_ID, LEG_IDS[1]]) assert.ok(seen.includes(material), `prompt carries ${material}`);
  });

  it("returns one mixed-provenance proposal with request images, exact odds and a sanitized receipt", async () => {
    const images = [PNG, { ...PNG }];
    const { result, calls, receipts } = await extract({ images, respond: () => envelope("proposal", MIXED) });

    const { usage, ...rest } = result;
    assert.deepEqual(rest, { status: "proposal", change: MIXED });
    assertUsage(usage);
    assert.equal(calls.length, 1);
    const files = filesOf(calls[0]);
    assert.equal(files.length, 2, "every current request image reaches the model");
    for (const file of files) assert.equal(file.mediaType, "image/png");

    assert.equal(receipts.length, 1);
    const [receipt] = receipts;
    assert.equal(receipt.purpose, "slip_extraction");
    assert.equal(receipt.kind, "generate");
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.modelId, "fake-extraction-model");
    const serialized = JSON.stringify(receipts);
    for (const leak of [REQUEST, ANSWER, "Chelsea", "2.10", PNG_B64, REV_ID, LEG_IDS[0]]) {
      assert.ok(!serialized.includes(leak), `receipt must not carry ${leak}`);
    }
  });

  it("fails closed on invalid, truncated or refused output after exactly one call, keeping usage", async () => {
    const NONE_TEXT = JSON.stringify({ status: "none", change: null });
    const failing = {
      "malformed JSON": [null, reply("{not json")],
      "empty output": [null, reply("")],
      "truncated at the length limit": [null, reply('{"status":"proposal","change":{"contract":"slip-change-v1"', "length")],
      "complete none at the length limit": [null, reply(NONE_TEXT, "length")],
      "refused by a content filter": [null, reply(NONE_TEXT, "content-filter")],
      "a tool call instead of output": [null, {
        content: [{ type: "tool-call", toolCallId: "call_1", toolName: "submit_slip_change", input: JSON.stringify(MIXED) }],
        finishReason: { unified: "tool-calls", raw: undefined }, usage: USAGE, warnings: [],
      }],
      "extra root key": [null, reply(JSON.stringify({ status: "none", change: null, saved: true }))],
      "none carrying a change": [null, envelope("none", MIXED)],
      "proposal without a change": [null, envelope("proposal", null)],
      "model-authored confirm": [CONTEXT, envelope("proposal", change("confirm", { base: REV_ID }))],
      "priced agent suggestion": [null, envelope("proposal", change("create", { legs: [{ ...SUGGESTED, quotedOdds: { value: "1.91", format: "decimal" } }] }))],
      "remove carrying retained legs": [CONTEXT, envelope("proposal", change("remove", { base: REV_ID, targets: [LEG_IDS[0]], legs: [LEG_B] }))],
      "targeted change without context": [null, envelope("proposal", REMOVE_B)],
      "lone surrogate": [null, envelope("proposal", change("create", { legs: [{ ...LEG_A, selection: "Chelsea \ud800" }] }))],
    };
    for (const [label, [context, output]] of Object.entries(failing)) {
      const { result, calls, receipts } = await extract({ context, respond: () => structuredClone(output) });
      assertFailed(result, "invalid_response", label);
      assert.equal(calls.length, 1, `${label}: no repair, retry or fallback call`);
      assertUsage(result.usage, `${label}: usage of the call is not lost`);
      assert.equal(receipts.length, 1, label);
      assert.equal(receipts[0].purpose, "slip_extraction", label);
    }
  });

  it("maps provider errors, including unsupported structured output, to one unretried failure", async () => {
    const apiError = (statusCode) => new APICallError({
      message: "provider refused the request", url: "https://provider.invalid/v1/generate", requestBodyValues: {},
      statusCode, isRetryable: statusCode >= 500,
    });
    for (const statusCode of [400, 500, 503]) {
      const { result, calls } = await extract({ respond: () => { throw apiError(statusCode); } });
      assertFailed(result, "inference_unavailable", `HTTP ${statusCode}`);
      assert.equal(calls.length, 1, `HTTP ${statusCode}: maxRetries 0`);
    }
  });

  it("refuses out-of-bound input before any model call, never truncating", async () => {
    const base = Buffer.byteLength(JSON.stringify(turn(REQUEST)), "utf8");
    const remaining = 65_536 - base;
    const refused = {
      "invalid turn": { input: { turn: { ...turn(REQUEST), ownerId: "acct_5150" }, answerText: ANSWER } },
      "request over 4000 chars": { input: { turn: turn("x".repeat(4_001)), answerText: ANSWER } },
      "answer not a string": { input: { turn: turn(REQUEST), answerText: null } },
      "answer with a lone surrogate": { answerText: "Chelsea \ud800 at 2.10" },
      "total text one byte over": { answerText: "a".repeat(remaining + 1) },
      "total counted in UTF-8 bytes": { answerText: "é".repeat(Math.ceil((remaining + 1) / 2)) },
      "five images": { images: Array.from({ length: 5 }, () => ({ ...PNG })) },
      "images not a list": { input: { turn: turn(REQUEST), answerText: ANSWER, images: PNG } },
      "unsupported image type": { images: [{ data: PNG_B64, mimeType: "image/svg+xml" }] },
      "non-image type": { images: [{ data: PNG_B64, mimeType: "application/pdf" }] },
      "invalid base64": { images: [{ data: "not base64 !!", mimeType: "image/png" }] },
      "empty image": { images: [{ data: "", mimeType: "image/png" }] },
      "image over 10 MiB": { images: [pngOf(10 * MIB + 1)] },
      "images over 20 MiB in total": { images: [pngOf(10 * MIB), pngOf(10 * MIB), pngOf(1)] },
    };
    for (const [label, args] of Object.entries(refused)) {
      const { result, calls, receipts } = await extract(args);
      assertFailed(result, "invalid_request", label);
      assert.equal(calls.length, 0, `${label}: refused before the model`);
      assert.equal(receipts.length, 0, label);
    }
  });

  it("accepts every bound exactly at its limit", async () => {
    const base = Buffer.byteLength(JSON.stringify(turn(REQUEST)), "utf8");
    const accepted = {
      "total text exactly 65536 bytes": { answerText: "a".repeat(65_536 - base) },
      "four images": { images: Array.from({ length: 4 }, () => ({ ...PNG })) },
      "one image of exactly 10 MiB": { images: [pngOf(10 * MIB)] },
      "images of exactly 20 MiB in total": { images: [pngOf(10 * MIB), pngOf(10 * MIB)] },
    };
    for (const [label, args] of Object.entries(accepted)) {
      const { result, calls } = await extract(args);
      assert.equal(result.status, "none", label);
      assert.equal(calls.length, 1, label);
      if (args.images) assert.equal(filesOf(calls[0]).length, args.images.length, label);
    }
  });

  it("honors a caller abort and a shortened deadline, never as none", async () => {
    const pre = new AbortController();
    pre.abort();
    const early = await extract({ abortSignal: pre.signal });
    assertFailed(early.result, "aborted", "already aborted");
    assert.equal(early.calls.length, 0, "no call after an abort");

    const hang = (onStart) => async (options) => {
      onStart?.();
      if (await abortedWithin(options.abortSignal, 2_000)) throw options.abortSignal.reason ?? new Error("aborted");
      return envelope("proposal", MIXED);
    };

    const caller = new AbortController();
    const midCall = await extract({ abortSignal: caller.signal, respond: hang(() => caller.abort()) });
    assertFailed(midCall.result, "aborted", "aborted during the call");
    assert.equal(midCall.calls.length, 1);
    assert.equal(midCall.calls[0].abortSignal.aborted, true, "the caller abort reaches the model call");

    const deadline = await extract({ timeoutMs: 50, respond: hang() });
    assertFailed(deadline.result, "timeout", "deadline");
    assert.equal(deadline.calls.length, 1, "a timed-out provider is not called again");
    assert.equal(deadline.calls[0].abortSignal.aborted, true, "the deadline reaches the model call");
  });
});
