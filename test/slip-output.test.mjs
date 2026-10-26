/**
 * Typed slip output — `slip-change-v1` proposals from the answer model.
 *
 *   - `parseSlipChange` / `validateSlipRevision` from dist/slip-output.js
 *     validate the mirrored engine/bridge wire only (no persistence, no ID
 *     generation; slip-contract.md "Exact shapes").
 *   - `createSlipOutputCollector(context)` returns a request-scoped
 *     `submit_slip_change` output tool. A captured change is a proposal only:
 *     the tool answers `saved:false` and the bridge owns validation, apply,
 *     persistence and confirmation.
 *
 * Nothing here parses JSON out of prose, and nothing here may reach the
 * network.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { generateText } from "ai";

globalThis.AI_SDK_LOG_WARNINGS = false;

const slip = await import("../dist/slip-output.js");

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
  assert.equal(escapedFetches, 0, "the slip output tool never touches the network");
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Server-shaped ID: prefix + 22 base64url chars. */
const sid = (prefix, tag) => `${prefix}_${(tag + "0".repeat(22)).slice(0, 22)}`;

const SLIP_ID = sid("slp", "SENTINELslip");
const REV_ID = sid("slr", "SENTINELrev");
const PARENT_ID = sid("slr", "SENTINELparent");
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
  quotedOdds: { value: "+120", format: "american" }, source: "user_image", unresolved: ["kickoff time unreadable"],
};
const LEG_D = {
  event: "Real Madrid vs Barcelona", market: "Both teams to score", selection: "Yes", period: null, line: null,
  quotedOdds: null, source: "user_text", unresolved: [],
};

const clone = (value) => structuredClone(value);

const CONTEXT = Object.freeze({
  contract: "slip-revision-v1",
  slipId: SLIP_ID,
  revisionId: REV_ID,
  parentRevisionId: PARENT_ID,
  status: "proposed",
  legs: [LEG_A, LEG_B, LEG_C].map((leg, i) => ({ ...clone(leg), id: LEG_IDS[i] })),
  unresolved: [],
});

const change = (action, { base = null, targets = [], legs = [], unresolved = [] } = {}) => ({
  contract: "slip-change-v1",
  action,
  baseRevisionId: base,
  targetLegIds: targets,
  legs: legs.map(clone),
  unresolved,
});

const CREATE = change("create", { legs: [LEG_A, LEG_B] });

const CALL = { toolCallId: "call_slip_1", messages: [] };

/** Run one proposal through a collector's tool exactly as the SDK would. */
const submit = (collector, value) => collector.tool.execute(value, CALL);

function assertProposalOnly(result) {
  assert.equal(typeof result, "object");
  assert.notEqual(result, null);
  assert.equal(result.saved, false, "a captured change is never reported as saved");
  const serialized = JSON.stringify(result);
  assert.ok(serialized.length <= 1024, `bounded tool result: ${serialized.length}`);
  for (const id of [SLIP_ID, REV_ID, ...LEG_IDS]) assert.ok(!serialized.includes(id), `tool result must not echo ${id}`);
}

// ---------------------------------------------------------------------------
// parseSlipChange: exact mirrored wire
// ---------------------------------------------------------------------------

describe("slip-output sparse input rejection", () => {
  for (const field of ["legs", "targetLegIds", "unresolved"]) {
    it(`rejects sparse change ${field}`, () => {
      const value = clone(CREATE);
      value[field] = new Array(1);
      assert.equal(slip.parseSlipChange(value), null);
    });
  }
  it("rejects sparse leg unresolved entries", () => {
    const value = clone(CREATE);
    value.legs[0].unresolved = new Array(1);
    assert.equal(slip.parseSlipChange(value), null);
  });
  for (const field of ["legs", "unresolved"]) {
    it(`rejects sparse revision ${field}`, () => {
      const value = clone(CONTEXT);
      value[field] = new Array(1);
      assert.equal(slip.validateSlipRevision(value), false);
    });
  }
  it("refuses a sparse proposal instead of capturing a phantom leg", async () => {
    const collector = slip.createSlipOutputCollector(null);
    const value = clone(CREATE);
    value.legs = new Array(1);
    assert.equal((await submit(collector, value)).accepted, false);
    assert.equal(collector.finish(), undefined);
  });
});

describe("parseSlipChange", () => {
  it("returns an exact, independent copy of a valid change and preserves user-quoted tokens", () => {
    const input = change("append", { base: REV_ID, legs: [LEG_C, LEG_B] });
    const parsed = slip.parseSlipChange(input);
    assert.deepEqual(parsed, input);
    assert.notEqual(parsed, input);
    assert.notEqual(parsed.legs[0], input.legs[0]);
    assert.equal(parsed.legs[0].quotedOdds.value, "+120", "quoted odds are not coerced");
    assert.equal(parsed.legs[1].line, "-3.5", "line tokens are not coerced");
    input.legs[0].selection = "Under";
    assert.equal(parsed.legs[0].selection, "Over");
  });

  it("accepts every field bound exactly at its limit", () => {
    const max = {
      event: "e".repeat(160), market: "m".repeat(160), selection: "s".repeat(160), period: "p".repeat(160),
      line: "l".repeat(160), quotedOdds: { value: "9".repeat(80), format: "unknown" }, source: "user_image",
      unresolved: Array.from({ length: 16 }, (_, i) => `${i}`.padEnd(160, "u")),
    };
    assert.deepEqual(slip.parseSlipChange(change("create", { legs: [max] })), change("create", { legs: [max] }));
    const many = Array.from({ length: 64 }, (_, i) => ({ ...clone(LEG_D), selection: `Pick ${i}` }));
    assert.ok(slip.parseSlipChange(change("create", { legs: many })), "64 legs is the review limit, inclusive");
  });

  const leg = (patch) => ({ ...clone(LEG_A), ...patch });
  const bad = {
    "not an object": "slip",
    "array": [CREATE],
    "wrong contract": { ...CREATE, contract: "slip-change-v2" },
    "unknown action": { ...CREATE, action: "cashout" },
    "missing unresolved": (({ unresolved, ...rest }) => rest)(CREATE),
    "extra top-level slipId": { ...CREATE, slipId: SLIP_ID },
    "extra top-level revisionId": { ...CREATE, revisionId: REV_ID },
    "extra top-level status": { ...CREATE, status: "confirmed" },
    "owner id": { ...CREATE, ownerId: "acct_5150" },
    "targetLegIds not a list": { ...CREATE, targetLegIds: LEG_IDS[0] },
    "65 legs": change("create", { legs: Array.from({ length: 65 }, () => LEG_D) }),
    "leg carries a server leg id": change("create", { legs: [leg({ id: LEG_IDS[0] })] }),
    "leg provider event id": change("create", { legs: [leg({ providerEventId: "evt_991" })] }),
    "leg provider market id": change("create", { legs: [leg({ marketId: "mkt_17" })] }),
    "leg account id": change("create", { legs: [leg({ accountId: "acct_5150" })] }),
    "leg executable price": change("create", { legs: [leg({ price: 2.1 })] }),
    "quotedOdds executable extra": change("create", { legs: [leg({ quotedOdds: { value: "2.10", format: "decimal", executable: true } })] }),
    "quotedOdds unknown format": change("create", { legs: [leg({ quotedOdds: { value: "2.10", format: "hongkong" } })] }),
    "quotedOdds numeric value": change("create", { legs: [leg({ quotedOdds: { value: 2.1, format: "decimal" } })] }),
    "quoted value over 80": change("create", { legs: [leg({ quotedOdds: { value: "1".repeat(81), format: "decimal" } })] }),
    "unknown source": change("create", { legs: [leg({ source: "provider_feed" })] }),
    "event over 160": change("create", { legs: [leg({ event: "e".repeat(161) })] }),
    "empty supplied string": change("create", { legs: [leg({ market: "" })] }),
    "control character": change("create", { legs: [leg({ selection: "Chelsea\u0000" })] }),
    "no event, market or selection": change("create", { legs: [leg({ event: null, market: null, selection: null })] }),
    "17 unresolved": change("create", { legs: [leg({ unresolved: Array.from({ length: 17 }, (_, i) => `u${i}`) })] }),
    "unresolved entry over 160": change("create", { legs: [leg({ unresolved: ["u".repeat(161)] })] }),
    "missing leg field": change("create", { legs: [(({ period, ...rest }) => rest)(clone(LEG_A))] }),
    // Every field within its own bound; only the UTF-8 envelope is over 64KiB.
    "envelope over 65536 bytes": change("create", {
      legs: Array.from({ length: 10 }, () => ({
        event: "é".repeat(160), market: "é".repeat(160), selection: "é".repeat(160), period: "é".repeat(160),
        line: "é".repeat(160), quotedOdds: null, source: "user_text", unresolved: Array.from({ length: 16 }, () => "é".repeat(160)),
      })),
    }),
  };
  for (const [label, value] of Object.entries(bad)) {
    it(`rejects ${label}`, () => {
      assert.equal(slip.parseSlipChange(value), null, label);
    });
  }

  it("fixture sanity: the oversize envelope is only over in total", () => {
    assert.ok(Buffer.byteLength(JSON.stringify(bad["envelope over 65536 bytes"])) > 65536);
  });
});

// ---------------------------------------------------------------------------
// validateSlipRevision
// ---------------------------------------------------------------------------

describe("validateSlipRevision", () => {
  it("accepts exact proposed, root and confirmed revisions", () => {
    assert.equal(slip.validateSlipRevision(clone(CONTEXT)), true);
    assert.equal(slip.validateSlipRevision({ ...clone(CONTEXT), parentRevisionId: null }), true);
    assert.equal(slip.validateSlipRevision({ ...clone(CONTEXT), status: "confirmed" }), true);
  });

  const legs = (patch) => CONTEXT.legs.map((l, i) => (i === 1 ? { ...clone(l), ...patch } : clone(l)));
  const bad = {
    "wrong contract": { ...clone(CONTEXT), contract: "slip-revision-v2" },
    "unknown status": { ...clone(CONTEXT), status: "final" },
    "slip id wrong prefix": { ...clone(CONTEXT), slipId: sid("slr", "x") },
    "revision id too short": { ...clone(CONTEXT), revisionId: "slr_short" },
    "parent id not base64url": { ...clone(CONTEXT), parentRevisionId: "slr_" + "!".repeat(22) },
    "owner id key": { ...clone(CONTEXT), ownerId: "acct_5150" },
    "leg missing id": { ...clone(CONTEXT), legs: [CONTEXT.legs[0], (({ id, ...rest }) => rest)(clone(CONTEXT.legs[1]))] },
    "leg ephemeral label id": { ...clone(CONTEXT), legs: legs({ id: "leg_2" }) },
    "duplicate leg ids": { ...clone(CONTEXT), legs: legs({ id: LEG_IDS[0] }) },
    "leg provider id": { ...clone(CONTEXT), legs: legs({ providerEventId: "evt_991" }) },
  };
  for (const [label, value] of Object.entries(bad)) {
    it(`rejects ${label}`, () => {
      assert.equal(slip.validateSlipRevision(value), false, label);
    });
  }
});

// ---------------------------------------------------------------------------
// createSlipOutputCollector: request-scoped proposal capture
// ---------------------------------------------------------------------------

describe("submit_slip_change collector", () => {
  it("describes per-action delta arity in the model-visible schema", () => {
    const schema = slip.createSlipOutputCollector(null).tool.inputSchema?.jsonSchema;
    assert.ok(schema?.properties?.action && schema?.properties?.legs);
    const action = schema.properties.action.description ?? "";
    for (const name of ["remove", "review", "clarify"]) {
      assert.match(action, new RegExp(`${name}[^;\\n]*legs\\s*=\\s*\\[\\]`, "i"));
    }
    assert.match(action, /replace[^;\n]*(exactly one|1)[^;\n]*leg/i);
    assert.match(schema.properties.legs.description ?? "", /not[^.]*remaining|never[^.]*unchanged/i);
  });

  it("describes target IDs as the affected existing legs, not the retained ones", () => {
    const schema = slip.createSlipOutputCollector(null).tool.inputSchema.jsonSchema;
    const text = schema.properties.targetLegIds.description ?? "";
    assert.match(text, /remove/i);
    assert.match(text, /IDs to remove|legs to remove/i);
    assert.match(text, /replace/i);
    assert.match(text, /review/i);
  });

  it("tells the model to finish reasoning and count visible rows before one final proposal", () => {
    const text = slip.createSlipOutputCollector(null).tool.description;
    assert.match(text, /one final|exactly one complete/i);
    assert.match(text, /conflicting|different.*invalid/i);
    assert.match(text, /count[^.]*rows|each visible[^.]*once/i);
    assert.match(text, /intermediate|incremental/i);
  });

  it("still rejects a remove carrying retained legs and any later in-turn repair", async () => {
    const collector = slip.createSlipOutputCollector(clone(CONTEXT));
    const { id, ...retainedLeg } = clone(CONTEXT.legs[1]);
    const malformed = change("remove", { base: REV_ID, targets: [LEG_IDS[0]], legs: [retainedLeg] });
    const bad = await submit(collector, malformed);
    assert.equal(bad.accepted, false);
    assert.equal(bad.reasonCode, "invalid_change");
    const repair = await submit(collector, change("remove", { base: REV_ID, targets: [LEG_IDS[0]] }));
    assert.equal(repair.accepted, false);
    assert.equal(collector.invalid(), true);
    assert.equal(collector.finish(), undefined);
  });

  it("captures nothing on an ordinary turn that never calls the tool", () => {
    const collector = slip.createSlipOutputCollector(null);
    assert.equal(typeof collector.tool.execute, "function");
    assert.ok(collector.tool.inputSchema, "an SDK tool with an input schema");
    assert.equal(collector.finish(), undefined);
    assert.equal(collector.invalid(), false);
  });

  it("captures a valid create as a proposal-only artifact", async () => {
    const collector = slip.createSlipOutputCollector(null);
    assertProposalOnly(await submit(collector, clone(CREATE)));
    assert.deepEqual(collector.finish(), CREATE);
    assert.equal(collector.invalid(), false);
  });

  const targeted = {
    append: change("append", { base: REV_ID, legs: [LEG_D] }),
    remove: change("remove", { base: REV_ID, targets: [LEG_IDS[1]] }),
    "remove group": change("remove", { base: REV_ID, targets: [LEG_IDS[0], LEG_IDS[2]] }),
    replace: change("replace", { base: REV_ID, targets: [LEG_IDS[2]], legs: [LEG_D] }),
    review: change("review", { base: REV_ID, targets: [LEG_IDS[0]] }),
  };
  for (const [label, value] of Object.entries(targeted)) {
    it(`captures a valid ${label} against the exact request context`, async () => {
      const collector = slip.createSlipOutputCollector(clone(CONTEXT));
      assertProposalOnly(await submit(collector, clone(value)));
      assert.deepEqual(collector.finish(), value);
      assert.equal(collector.invalid(), false);
    });
  }

  it("isolates the captured artifact from caller mutation of input and output", async () => {
    const collector = slip.createSlipOutputCollector(null);
    const input = clone(CREATE);
    await submit(collector, input);
    input.legs[0].selection = "Arsenal";
    input.action = "confirm";
    const first = collector.finish();
    assert.deepEqual(first, CREATE);
    first.legs.push(clone(LEG_D));
    first.legs[0].event = "Tampered";
    assert.deepEqual(collector.finish(), CREATE);
  });

  it("snapshots its context: later mutation of the caller's revision changes nothing", async () => {
    const legD = sid("sll", "SENTINELlegD");
    const open = () => {
      const context = clone(CONTEXT);
      const collector = slip.createSlipOutputCollector(context);
      context.revisionId = sid("slr", "SENTINELswapped");
      context.legs.push({ ...clone(LEG_D), id: legD });
      return collector;
    };
    const original = open();
    const value = change("remove", { base: REV_ID, targets: [LEG_IDS[1]] });
    await submit(original, clone(value));
    assert.deepEqual(original.finish(), value);
    const smuggled = open();
    await submit(smuggled, change("remove", { base: REV_ID, targets: [legD] }));
    assert.equal(smuggled.finish(), undefined, "a leg added after creation is not a member");
  });

  it("keeps independent collectors independent", async () => {
    const withContext = slip.createSlipOutputCollector(clone(CONTEXT));
    const without = slip.createSlipOutputCollector(null);
    const remove = change("remove", { base: REV_ID, targets: [LEG_IDS[0]] });
    await submit(withContext, clone(remove));
    await submit(without, clone(remove));
    assert.deepEqual(withContext.finish(), remove);
    assert.equal(without.finish(), undefined, "one request's context cannot validate another request's proposal");
    assert.equal(without.invalid(), true);
    assert.equal(withContext.invalid(), false);
  });

  it("treats an identical duplicate proposal as idempotent", async () => {
    const collector = slip.createSlipOutputCollector(null);
    assertProposalOnly(await submit(collector, clone(CREATE)));
    assertProposalOnly(await submit(collector, clone(CREATE)));
    assert.deepEqual(collector.finish(), CREATE);
    assert.equal(collector.invalid(), false);
  });

  it("withholds output after a conflicting second proposal, even if the first is repeated", async () => {
    const collector = slip.createSlipOutputCollector(null);
    await submit(collector, clone(CREATE));
    assertProposalOnly(await submit(collector, change("create", { legs: [LEG_D] })));
    assert.equal(collector.finish(), undefined);
    assert.equal(collector.invalid(), true);
    await submit(collector, clone(CREATE));
    assert.equal(collector.finish(), undefined, "invalidation is sticky");
    assert.equal(collector.invalid(), true);
  });

  it("an invalid candidate after a valid one does not leave the earlier artifact looking accepted", async () => {
    const collector = slip.createSlipOutputCollector(clone(CONTEXT));
    await submit(collector, change("remove", { base: REV_ID, targets: [LEG_IDS[1]] }));
    assertProposalOnly(await submit(collector, change("remove", { base: REV_ID, targets: [sid("sll", "SENTINELunknown")] })));
    assert.equal(collector.finish(), undefined);
    assert.equal(collector.invalid(), true);
  });

  const confirm = change("confirm", { base: REV_ID });
  it("fixture sanity: confirm is a valid general wire shape", () => {
    assert.deepEqual(slip.parseSlipChange(clone(confirm)), confirm);
  });

  const rejected = {
    "model-authored confirm": [CONTEXT, confirm],
    "schema-invalid candidate": [null, { ...clone(CREATE), ownerId: "acct_5150" }],
    "wrong base revision": [CONTEXT, change("remove", { base: sid("slr", "SENTINELother"), targets: [LEG_IDS[1]] })],
    "missing base with context": [CONTEXT, change("remove", { targets: [LEG_IDS[1]] })],
    "unknown target": [CONTEXT, change("remove", { base: REV_ID, targets: [sid("sll", "SENTINELunknown")] })],
    "duplicate target": [CONTEXT, change("remove", { base: REV_ID, targets: [LEG_IDS[1], LEG_IDS[1]] })],
    "remove with supplied legs": [CONTEXT, change("remove", { base: REV_ID, targets: [LEG_IDS[1]], legs: [LEG_D] })],
    "remove without targets": [CONTEXT, change("remove", { base: REV_ID })],
    "replace two targets": [CONTEXT, change("replace", { base: REV_ID, targets: [LEG_IDS[0], LEG_IDS[1]], legs: [LEG_D] })],
    "replace without a leg": [CONTEXT, change("replace", { base: REV_ID, targets: [LEG_IDS[0]] })],
    "replace two legs": [CONTEXT, change("replace", { base: REV_ID, targets: [LEG_IDS[0]], legs: [LEG_D, LEG_B] })],
    "append with target": [CONTEXT, change("append", { base: REV_ID, targets: [LEG_IDS[0]], legs: [LEG_D] })],
    "append without legs": [CONTEXT, change("append", { base: REV_ID })],
    "review with supplied legs": [CONTEXT, change("review", { base: REV_ID, targets: [LEG_IDS[0]], legs: [LEG_D] })],
    "create with base": [CONTEXT, change("create", { base: REV_ID, legs: [LEG_D] })],
    "create with targets": [null, change("create", { targets: [LEG_IDS[0]], legs: [LEG_D] })],
    "create without legs": [null, change("create")],
    "append without context": [null, change("append", { base: REV_ID, legs: [LEG_D] })],
    "remove without context": [null, change("remove", { base: REV_ID, targets: [LEG_IDS[0]] })],
  };
  for (const [label, [context, value]] of Object.entries(rejected)) {
    it(`rejects ${label} before capture`, async () => {
      const collector = slip.createSlipOutputCollector(context && clone(context));
      assertProposalOnly(await submit(collector, clone(value)));
      assert.equal(collector.finish(), undefined, label);
      assert.equal(collector.invalid(), true, label);
    });
  }
});

// ---------------------------------------------------------------------------
// Through the installed SDK's real tool dispatch
// ---------------------------------------------------------------------------

/** Minimal fake language model: one scripted step. */
function scripted(content, finishReason = "stop") {
  return {
    specificationVersion: "v2",
    provider: "fake",
    modelId: "fake-answer-model",
    supportedUrls: {},
    async doGenerate() {
      return { content, finishReason, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
    },
    async doStream() {
      throw new Error("no streaming");
    },
  };
}

const toolCall = (input) => ({ type: "tool-call", toolCallId: "call_slip_1", toolName: "submit_slip_change", input });

describe("submit_slip_change through generateText", () => {
  it("captures the typed proposal the model submits through the tool", async () => {
    const collector = slip.createSlipOutputCollector(null);
    const result = await generateText({
      model: scripted([toolCall(JSON.stringify(CREATE))], "tool-calls"),
      prompt: "Make a slip: Chelsea to win at 2.10 and Lakers -3.5",
      tools: { submit_slip_change: collector.tool },
    });
    assert.deepEqual(collector.finish(), CREATE);
    const [toolResult] = result.toolResults;
    assert.equal(toolResult.toolName, "submit_slip_change");
    assertProposalOnly(toolResult.output);
  });

  it("never scrapes a change out of prose", async () => {
    const collector = slip.createSlipOutputCollector(null);
    await generateText({
      model: scripted([{ type: "text", text: `Here is your slip:\n\`\`\`json\n${JSON.stringify(CREATE)}\n\`\`\`` }]),
      prompt: "Make a slip: Chelsea to win",
      tools: { submit_slip_change: collector.tool },
    });
    assert.equal(collector.finish(), undefined);
    assert.equal(collector.invalid(), false);
  });

  it("captures nothing from malformed tool-call arguments", async () => {
    const collector = slip.createSlipOutputCollector(null);
    try {
      await generateText({
        model: scripted([toolCall("{not json")], "tool-calls"),
        prompt: "Make a slip",
        tools: { submit_slip_change: collector.tool },
      });
    } catch {
      // The SDK may surface the bad call as an error; either way nothing is captured.
    }
    assert.equal(collector.finish(), undefined);
  });
});
