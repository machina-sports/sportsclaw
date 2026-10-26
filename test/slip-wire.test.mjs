/**
 * Slip turn wire — the single strict `slip-turn-v1` envelope end to end.
 *
 *   SlipTurnInput  {contract:'slip-turn-v1', requestText, context:SlipRevision|null}
 *   SlipTurnResult {contract:'slip-turn-v1', inputHash, decision:SlipDecisionResult|null}
 *
 *   - parseSlipTurnInput / hashSlipTurnInput / parseSlipTurnResult from
 *     dist/slip-output.js (slip-integration-contract.md §2);
 *   - the one-shot CLI caller-history stdin envelope {history, images?, slip?}
 *     and its NDJSON result line (dist/index.js, §4);
 *   - TypeScript/Python parity against docker/relay/slip_contract.py, and the
 *     relay's own unittest (docker/relay/test_slip_contract.py) so `npm test`
 *     runs it with the local interpreter. No Docker, network or credentials.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const slip = await import("../dist/slip-output.js");
const cli = await import("../dist/index.js");

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const relayDir = join(repoRoot, "docker/relay");
const PYTHON = process.env.PYTHON_PATH || "python3";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const C = "slip-turn-v1";
const MODEL = "jev-1.14.0";
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
  quotedOdds: { value: "+120", format: "american" }, source: "user_image", unresolved: [],
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

const input = (requestText, context = null, extra = {}) => ({ contract: C, requestText, context: context && clone(context), ...extra });

const change = (action, { base = null, targets = [], legs = [] } = {}) => ({
  contract: "slip-change-v1", action, baseRevisionId: base, targetLegIds: targets, legs: legs.map(clone), unresolved: [],
});

const CREATE = change("create", { legs: [LEG_A] });
const REMOVE_B = change("remove", { base: REV_ID, targets: [LEG_IDS[1]] });

const selected = (c) => ({ contract: "slip-decision-v1", ok: true, decision: { status: "selected", change: clone(c), model: MODEL } });
const outcome = (status) => ({ contract: "slip-decision-v1", ok: true, decision: { status, model: MODEL } });
const failure = (reasonCode) => ({ contract: "slip-decision-v1", ok: false, reasonCode });

/** Independent oracle: recursively sorted keys, arrays kept, no ASCII escaping. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const oracleHash = (value) => createHash("sha256").update(canonical(value), "utf8").digest("hex");

const result = (turn, decision, extra = {}) => ({ contract: C, inputHash: oracleHash(turn), decision, ...extra });

/** A valid revision whose own wire is within 64KiB but which overflows with a 4000-char request. */
function nearLimitContext() {
  const big = (n) => ({
    event: "é".repeat(160), market: "é".repeat(160), selection: `Pick ${n}`, period: "é".repeat(160),
    line: "é".repeat(160), quotedOdds: null, source: "user_text", unresolved: Array.from({ length: 16 }, () => "é".repeat(160)),
  });
  const context = { ...clone(CONTEXT), legs: [] };
  for (let n = 0; n < 64; n++) {
    const leg = { ...big(n), id: sid("sll", `SENTINELbig${n}`) };
    const next = { ...context, legs: [...context.legs, leg] };
    if (Buffer.byteLength(JSON.stringify(next)) > 65_536) break;
    context.legs.push(leg);
  }
  return context;
}

// ---------------------------------------------------------------------------
// SlipTurnInput
// ---------------------------------------------------------------------------

describe("parseSlipTurnInput", () => {
  it("returns an exact independent copy of a valid input with and without context", () => {
    for (const value of [input("Make me a slip: Chelsea at 2.10"), input("Drop the Flamengo leg", CONTEXT)]) {
      const parsed = slip.parseSlipTurnInput(value);
      assert.deepEqual(parsed, value);
      assert.notEqual(parsed, value);
      value.requestText = "tampered";
      assert.notEqual(parsed.requestText, "tampered");
    }
  });

  it("accepts exactly 4000 UTF-16 units of astral text without truncation", () => {
    const text = "😀".repeat(2000);
    const parsed = slip.parseSlipTurnInput(input(text));
    assert.notEqual(parsed, null, "an exactly bounded input must parse");
    assert.equal(parsed.requestText, text);
  });

  const bad = {
    "not an object": "Make me a slip",
    "wrong contract": input("x", null, { contract: "slip-turn-v2" }),
    "missing context": (({ context, ...rest }) => rest)(input("x")),
    "history key": input("x", null, { history: [{ role: "user", content: "earlier" }] }),
    "owner id": input("x", null, { ownerId: "acct_5150" }),
    "composed prompt": input("x", null, { prompt: "system + profile + transcript" }),
    "blank request": input("   "),
    "non-string request": { ...input("x"), requestText: 42 },
    "request over 4000 UTF-16 units": input("😀".repeat(2001)),
    "unpaired surrogate": input("Chelsea \ud800 to win"),
    "invalid context": input("x", { ...clone(CONTEXT), ownerId: "acct_5150" }),
    "model-produced context": input("x", { ...clone(CONTEXT), revisionId: "slr_from_the_model" }),
    "envelope over 65536 UTF-8 bytes": input("é".repeat(4000), nearLimitContext()),
  };
  for (const [label, value] of Object.entries(bad)) {
    it(`rejects ${label}`, () => {
      assert.equal(slip.parseSlipTurnInput(value), null, label);
    });
  }

  it("fixture sanity: the oversize input has a valid context and is over only in total", () => {
    const value = bad["envelope over 65536 UTF-8 bytes"];
    assert.equal(slip.validateSlipRevision(value.context), true);
    assert.equal(value.requestText.length, 4000);
    assert.ok(Buffer.byteLength(JSON.stringify(value)) > 65_536);
  });
});

// ---------------------------------------------------------------------------
// hashSlipTurnInput
// ---------------------------------------------------------------------------

describe("hashSlipTurnInput", () => {
  it("is SHA-256 hex of canonical sorted-key JSON, Unicode unescaped", () => {
    const turn = input("Faz um bilhete: Flamengo é favorito 😀", CONTEXT);
    const hash = slip.hashSlipTurnInput(turn);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hash, oracleHash(turn));
  });

  it("does not depend on object key order", () => {
    const turn = input("Drop the Flamengo leg", CONTEXT);
    const reordered = { context: clone(CONTEXT), requestText: turn.requestText, contract: C };
    assert.equal(slip.hashSlipTurnInput(reordered), slip.hashSlipTurnInput(turn));
  });

  it("binds both the exact request and the base revision", () => {
    const base = slip.hashSlipTurnInput(input("Drop the Flamengo leg", CONTEXT));
    assert.notEqual(slip.hashSlipTurnInput(input("Drop the Flamengo leg ", CONTEXT)), base);
    assert.notEqual(slip.hashSlipTurnInput(input("Drop the Flamengo leg", null)), base);
    const otherRevision = { ...clone(CONTEXT), revisionId: sid("slr", "SENTINELother") };
    assert.notEqual(slip.hashSlipTurnInput(input("Drop the Flamengo leg", otherRevision)), base);
    const reordered = { ...clone(CONTEXT), legs: [...clone(CONTEXT).legs].reverse() };
    assert.notEqual(slip.hashSlipTurnInput(input("Drop the Flamengo leg", reordered)), base, "leg order is preserved");
  });
});

// ---------------------------------------------------------------------------
// SlipTurnResult
// ---------------------------------------------------------------------------

describe("parseSlipTurnResult", () => {
  const withContext = input("Drop the Flamengo leg", CONTEXT);
  const fresh = input("Make me a slip: Chelsea at 2.10");

  const good = {
    "ordinary turn (null decision)": [fresh, result(fresh, null)],
    "selected create": [fresh, result(fresh, selected(CREATE))],
    "selected targeted remove": [withContext, result(withContext, selected(REMOVE_B))],
    "clarify": [withContext, result(withContext, outcome("clarify"))],
    "none": [withContext, result(withContext, outcome("none"))],
    "closed failure": [fresh, result(fresh, failure("invalid_response"))],
  };
  for (const [label, [turn, value]] of Object.entries(good)) {
    it(`accepts ${label} as an exact independent copy`, () => {
      const parsed = slip.parseSlipTurnResult(value, turn);
      assert.deepEqual(parsed, value);
      assert.notEqual(parsed, value);
    });
  }

  const bad = {
    "hash of a different request": [fresh, result(input("Make me a slip"), selected(CREATE))],
    "hash of a different base revision": [withContext, result(input(withContext.requestText), outcome("none"))],
    "missing hash": [fresh, (({ inputHash, ...rest }) => rest)(result(fresh, null))],
    "wrong contract": [fresh, result(fresh, null, { contract: "slip-turn-v2" })],
    "saved claim": [fresh, result(fresh, selected(CREATE), { saved: true })],
    "owner override": [fresh, result(fresh, selected(CREATE), { ownerId: "acct_5150" })],
    "destination override": [fresh, result(fresh, { ...selected(CREATE), destination: "telegram:999" })],
    "raw error": [fresh, result(fresh, { ...failure("inference_unavailable"), error: "ECONNRESET at 10.0.0.7" })],
    "unknown reason": [fresh, result(fresh, failure("rate_limited"))],
    "model confirm": [withContext, result(withContext, selected(change("confirm", { base: REV_ID })))],
    "change outside the supplied context": [withContext,
      result(withContext, selected(change("remove", { base: REV_ID, targets: [sid("sll", "SENTINELunknown")] })))],
    "targeted change without context": [fresh, result(fresh, selected(REMOVE_B))],
    "invalid change": [fresh, result(fresh, selected({ ...CREATE, legs: [{ ...LEG_A, price: 2.1 }] }))],
    "none carrying a change": [fresh, result(fresh, { ...outcome("none"), decision: { status: "none", model: MODEL, change: CREATE } })],
    "provider override in decision": [fresh, result(fresh, { ...selected(CREATE), provider: "openai" })],
  };
  for (const [label, [turn, value]] of Object.entries(bad)) {
    it(`rejects ${label}`, () => {
      assert.equal(slip.parseSlipTurnResult(value, turn), null, label);
    });
  }
});

// ---------------------------------------------------------------------------
// One-shot CLI: stdin envelope and NDJSON result
// ---------------------------------------------------------------------------

describe("one-shot caller-history stdin with slip", () => {
  const HISTORY = [{ role: "user", content: "Earlier question" }, { role: "assistant", content: "Earlier answer" }];
  const take = (args, stdin) => cli.takeOneShotConversation([...args], () => JSON.stringify(stdin));
  const CALLER = ["--history-mode", "caller", "--history-stdin", "make a slip"];

  it("accepts a strict optional slip in caller mode", () => {
    const turn = input("Drop the Flamengo leg", CONTEXT);
    const out = take(CALLER, { history: HISTORY, slip: turn });
    assert.deepEqual(out.slip, turn);
    assert.deepEqual(out.history, HISTORY);
    assert.equal(out.historyMode, "caller");
  });

  it("keeps the legacy envelope byte-for-byte unchanged when no slip is sent", () => {
    const out = take(CALLER, { history: HISTORY });
    assert.deepEqual(out, { historyMode: "caller", history: HISTORY });
    assert.equal(Object.hasOwn(out, "slip"), false);
  });

  const refused = {
    "invalid slip": { history: HISTORY, slip: input("   ") },
    "slip with an extra key": { history: HISTORY, slip: input("x", null, { ownerId: "acct_5150" }) },
    "slip without history": { slip: input("Make me a slip") },
    "unknown top-level key": { history: HISTORY, slip: input("x"), profile: "fan of Chelsea" },
  };
  for (const [label, stdin] of Object.entries(refused)) {
    it(`refuses ${label}`, () => {
      assert.throws(() => take(CALLER, stdin));
    });
  }

  it("never reads a slip outside caller mode", () => {
    let read = false;
    assert.throws(() => cli.takeOneShotConversation(["--history-stdin", "make a slip"], () => {
      read = true;
      return JSON.stringify({ history: HISTORY, slip: input("x") });
    }));
    assert.equal(read, false);
  });

  it("forwards slip and its observer into the run options only when supplied", () => {
    const base = { userId: "u1", systemPrompt: undefined, agentIds: [], delegated: false };
    const legacy = cli.buildOneShotRunOptions(base);
    assert.equal(Object.hasOwn(legacy, "slip"), false);
    assert.equal(Object.hasOwn(legacy, "onSlipResult"), false);
    const turn = input("Make me a slip");
    const onSlipResult = () => {};
    const options = cli.buildOneShotRunOptions({ ...base, historyMode: "caller", slip: turn, onSlipResult });
    assert.deepEqual(options.slip, turn);
    assert.equal(options.onSlipResult, onSlipResult);
  });

  it("carries the typed envelope on the result line, never inside prose", () => {
    assert.equal(JSON.stringify(cli.oneShotResultEvent("Final answer")), JSON.stringify({ type: "result", text: "Final answer" }));
    const turn = input("Make me a slip");
    const typed = result(turn, selected(CREATE));
    const event = cli.oneShotResultEvent("Drafted, no bet placed.", typed);
    assert.deepEqual(event, { type: "result", text: "Drafted, no bet placed.", slip: typed });
    assert.ok(!event.text.includes("slip-turn-v1"));
  });
});

// ---------------------------------------------------------------------------
// TypeScript / Python parity and the relay's own unittest
// ---------------------------------------------------------------------------

function python(code, stdin) {
  const run = spawnSync(PYTHON, ["-c", code, relayDir], {
    input: stdin,
    encoding: "utf-8",
    timeout: 60_000,
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(run.status, 0, `python helper failed:\n${run.stdout}\n${run.stderr}`);
  return JSON.parse(run.stdout.trim().split("\n").at(-1));
}

const PY_PRELUDE = "import json, sys; sys.path.insert(0, sys.argv[1]); import slip_contract as s; cases = json.loads(sys.stdin.read()); ";

describe("TypeScript/Python slip wire parity", () => {
  it("hashes identical inputs identically, Unicode included", () => {
    const cases = [input("Make me a slip"), input("Faz um bilhete: Flamengo é favorito 😀", CONTEXT), input("😀".repeat(2000))];
    const hashes = python(PY_PRELUDE + "print(json.dumps([s.hash_slip_turn_input(c) for c in cases]))", JSON.stringify(cases));
    assert.deepEqual(hashes, cases.map((c) => slip.hashSlipTurnInput(c)));
  });

  it("accepts and rejects the same inputs", () => {
    const cases = [
      input("Make me a slip"), input("Drop the Flamengo leg", CONTEXT), input("😀".repeat(2000)),
      input("😀".repeat(2001)), input("   "), input("Chelsea \ud800"), input("x", null, { ownerId: "a" }),
      input("x", { ...clone(CONTEXT), ownerId: "a" }), input("é".repeat(4000), nearLimitContext()),
    ];
    const py = python(PY_PRELUDE + "print(json.dumps([s.parse_slip_turn_input(c) is not None for c in cases]))", JSON.stringify(cases));
    assert.deepEqual(py, cases.map((c) => slip.parseSlipTurnInput(c) !== null));
  });

  it("accepts and rejects the same results", () => {
    const turn = input("Drop the Flamengo leg", CONTEXT);
    const cases = [
      result(turn, null), result(turn, selected(REMOVE_B)), result(turn, outcome("clarify")), result(turn, failure("timeout")),
      result(input("other"), null), result(turn, null, { saved: true }), result(turn, failure("rate_limited")),
      result(turn, selected(change("confirm", { base: REV_ID }))),
      result(turn, selected(change("remove", { base: REV_ID, targets: [sid("sll", "SENTINELunknown")] }))),
    ];
    const py = python(
      PY_PRELUDE + "turn = cases.pop(0); print(json.dumps([s.parse_slip_turn_result(c, turn) is not None for c in cases]))",
      JSON.stringify([turn, ...cases]),
    );
    assert.deepEqual(py, cases.map((c) => slip.parseSlipTurnResult(c, turn) !== null));
  });

  it("runs docker/relay/test_slip_contract.py with the local interpreter", () => {
    const run = spawnSync(PYTHON, ["-m", "unittest", "-v", "test_slip_contract"], {
      cwd: relayDir,
      encoding: "utf-8",
      timeout: 120_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    assert.equal(run.status, 0, `relay slip unittest failed:\n${run.stdout}\n${run.stderr}`);
  });
});
