/**
 * Market cards — `market-turn-v1` on the engine's real path.
 *
 *   - the wire: exact market-card-v1 / turn / result validation (keys, bounds,
 *     controls, surrogates, nonce binding, unique ids, cards XOR reason);
 *   - reading tool results: complete sports-skills Polymarket markets become
 *     cards (alone, nested in an event, in lists); a market missing a price,
 *     an error result and non-JSON yield none; the source's 0.0 for a missing
 *     amount is not shown as a fact; nothing is clipped;
 *   - the collector: only `polymarket_*` results are read, `cite_markets`
 *     selects by id among markets really read in this run, an unknown id is
 *     refused, a later call replaces the choice, reset() forgets the choice
 *     but not what was read, and the read time is the one handed in;
 *   - `ToolRegistry.dispatchToolCall` stamps `fetchedAt` once, so a cache hit
 *     reports the original time;
 *   - `sportsclawEngine.run(prompt, {market, onMarketResult})` with a scripted
 *     AI SDK model: validation before any model work, the tool is offered only
 *     to opted-in runs, an allowlist that omits it denies it, exactly one
 *     result bound to the nonce with cards copied from the tool result, and
 *     legacy runs unchanged.
 *
 * HOME is a fresh temp dir so no real config, schemas, agents or memory load.
 * Any network call fails the run and is counted.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV3 } from "ai/test";

globalThis.AI_SDK_LOG_WARNINGS = false;

const home = mkdtempSync(join(tmpdir(), "sportsclaw-market-"));
const ENV_KEYS = [
  "HOME", "USERPROFILE", "sportsclaw_SCHEMA_DIR", "SPORTSCLAW_SCHEMA_DIR", "SPORTSCLAW_SESSION_DIR",
  "SPORTSCLAW_MEMORY_PROVIDER", "ANTHROPIC_API_KEY", "SPORTSCLAW_AGENTS_DIR", "SPORTSCLAW_SKILLS", "sportsclaw_SKILLS",
  "SPORTSCLAW_ROUTING_PROVIDER", "SPORTSCLAW_ROUTING_DATA_POLICY", "SPORTSCLAW_ROUTING_PUBLIC_DATA_TOOLS", "SPORTSCLAW_SKILL_GUIDES_DIR",
  "SPORTSCLAW_EVIDENCE_VERIFIER", "SPORTSCLAW_EVIDENCE_DATA_POLICY", "SPORTSCLAW_EVIDENCE_PUBLIC_TOOLS",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
for (const key of ENV_KEYS) delete process.env[key];
process.env.HOME = home;
process.env.USERPROFILE = home;
// Placeholder only: the engine's model is replaced by a scripted one below.
process.env.ANTHROPIC_API_KEY = "synthetic-anthropic-placeholder";

const wire = await import("../dist/market-cards.js");
const { sportsclawEngine } = await import("../dist/engine.js");
const { ToolRegistry } = await import("../dist/tools.js");

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
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
  assert.equal(escapedFetches, 0, "no network");
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NONCE = "nonce_0123456789abcdef";
const TURN = Object.freeze({ contract: "market-turn-v1", nonce: NONCE });
const READ_MS = Date.UTC(2026, 10, 21, 23, 49, 12, 345);
const READ_AT = "2026-11-21T23:49:12.345Z";
const clone = (value) => structuredClone(value);

/** One market as sports-skills' Polymarket connector normalizes it. */
const skillMarket = (over = {}) => ({
  id: "540123",
  question: "Josh Hart over 7.5 rebounds?",
  description: "Resolves to Over if...",
  slug: "nba-por-nyk-2026-11-21-hart-rebounds",
  status: "active",
  outcomes: [
    { name: "Over", price: 0.5, clob_token_id: "111" },
    { name: "Under", price: 0.5, clob_token_id: "222" },
  ],
  volume: 2756.0,
  volume_24h: 310.5,
  liquidity: 2104.0,
  competitive: 0.9,
  spread: 0.02,
  start_date: "2026-11-20T00:00:00Z",
  end_date: "2026-11-22T06:00:00Z",
  created_at: "2026-11-20T00:00:00Z",
  updated_at: "2026-11-21T23:40:00Z",
  event_id: "9911",
  sports_market_type: "rebounds",
  game_id: "g1",
  game_start_time: "2026-11-22 00:30:00+00",
  accepting_orders: true,
  enable_order_book: true,
  clob_token_ids: ["111", "222"],
  tags: ["NBA"],
  ...over,
});
const ok = (data) => JSON.stringify({ status: true, data, message: "ok" });

const CARD = Object.freeze({
  contract: "market-card-v1",
  venue: "polymarket",
  id: "540123",
  question: "Josh Hart over 7.5 rebounds?",
  slug: "nba-por-nyk-2026-11-21-hart-rebounds",
  eventSlug: null,
  status: "active",
  outcomes: [{ name: "Over", price: 0.5 }, { name: "Under", price: 0.5 }],
  volume: 2756,
  liquidity: 2104,
  gameStartTime: "2026-11-22 00:30:00+00",
  readAt: READ_AT,
});
const RESULT = Object.freeze({ contract: "market-turn-v1", nonce: NONCE, markets: [CARD], reasonCode: null });

// ---------------------------------------------------------------------------
// The wire
// ---------------------------------------------------------------------------

describe("market-card-v1 wire", () => {
  it("accepts exact cards and returns fresh copies", () => {
    const input = clone(CARD);
    const parsed = wire.parseMarketCard(input);
    assert.deepEqual(parsed, CARD);
    assert.notEqual(parsed, input);
    assert.notEqual(parsed.outcomes, input.outcomes);
    assert.ok(wire.parseMarketCard({ ...CARD, slug: "", eventSlug: "nba-por-nyk-2026-11-21", volume: null, liquidity: null, gameStartTime: null }));
    assert.ok(wire.parseMarketCard({ ...CARD, outcomes: [{ name: "A", price: 0 }, { name: "Draw", price: 0.25 }, { name: "B", price: 1 }] }));
  });

  it("refuses anything outside the contract", () => {
    const cases = {
      "wrong contract": { ...CARD, contract: "market-card-v2" },
      "another venue": { ...CARD, venue: "kalshi" },
      "extra url": { ...CARD, url: "https://polymarket.com/event/x" },
      "missing readAt": (({ readAt, ...rest }) => rest)(CARD),
      "id with a slash": { ...CARD, id: "54/0123" },
      "empty id": { ...CARD, id: "" },
      "numeric id": { ...CARD, id: 540123 },
      "blank question": { ...CARD, question: "  " },
      "question over 300": { ...CARD, question: "q".repeat(301) },
      "control in question": { ...CARD, question: "a\u0000b" },
      "lone surrogate in question": { ...CARD, question: "a\ud800b" },
      "uppercase slug": { ...CARD, slug: "NBA-game" },
      "empty event slug": { ...CARD, eventSlug: "" },
      "unknown status": { ...CARD, status: "resolved" },
      "one outcome": { ...CARD, outcomes: [{ name: "Over", price: 0.5 }] },
      "five outcomes": { ...CARD, outcomes: Array.from({ length: 5 }, (_, i) => ({ name: `o${i}`, price: 0.2 })) },
      "outcome with a token id": { ...CARD, outcomes: [{ name: "Over", price: 0.5, clob_token_id: "1" }, { name: "Under", price: 0.5 }] },
      "price above one": { ...CARD, outcomes: [{ name: "Over", price: 1.01 }, { name: "Under", price: 0.5 }] },
      "price as a string": { ...CARD, outcomes: [{ name: "Over", price: "0.5" }, { name: "Under", price: 0.5 }] },
      "price NaN": { ...CARD, outcomes: [{ name: "Over", price: Number.NaN }, { name: "Under", price: 0.5 }] },
      "outcome name over 80": { ...CARD, outcomes: [{ name: "n".repeat(81), price: 0.5 }, { name: "Under", price: 0.5 }] },
      "negative volume": { ...CARD, volume: -1 },
      "volume as true": { ...CARD, volume: true },
      "infinite liquidity": { ...CARD, liquidity: Number.POSITIVE_INFINITY },
      "empty game start": { ...CARD, gameStartTime: "" },
      "game start over 40": { ...CARD, gameStartTime: "2".repeat(41) },
      "readAt without milliseconds": { ...CARD, readAt: "2026-11-21T23:49:12Z" },
      "readAt with an offset": { ...CARD, readAt: "2026-11-21T20:49:12.345-03:00" },
    };
    for (const [name, value] of Object.entries(cases)) assert.equal(wire.parseMarketCard(value), null, name);
    for (const value of [null, undefined, "x", 1, [], [CARD]]) assert.equal(wire.parseMarketCard(value), null);
  });
});

describe("market-turn-v1 wire", () => {
  it("validates the input exactly", () => {
    assert.deepEqual(wire.parseMarketTurnInput(clone(TURN)), TURN);
    for (const value of [
      { ...TURN, contract: "artifact-turn-v1" }, { ...TURN, nonce: "short" }, { ...TURN, nonce: "x".repeat(65) },
      { ...TURN, nonce: "has spaces 0123456789" }, { ...TURN, extra: 1 }, { contract: "market-turn-v1" }, null, "x",
    ]) assert.equal(wire.parseMarketTurnInput(value), null);
  });

  it("binds the result to its input and keeps cards and a reason apart", () => {
    assert.deepEqual(wire.parseMarketTurnResult(clone(RESULT), TURN), RESULT);
    assert.deepEqual(wire.parseMarketTurnResult({ ...RESULT, markets: [] }, TURN), { ...RESULT, markets: [] });
    assert.deepEqual(wire.parseMarketTurnResult({ ...RESULT, markets: [], reasonCode: "denied" }, TURN), { ...RESULT, markets: [], reasonCode: "denied" });
    const second = { ...CARD, id: "540124" };
    const cases = {
      "another nonce": { ...RESULT, nonce: "nonce_fedcba9876543210" },
      "cards with a reason": { ...RESULT, reasonCode: "denied" },
      "unknown reason": { ...RESULT, markets: [], reasonCode: "invalid" },
      "four cards": { ...RESULT, markets: [CARD, second, { ...CARD, id: "3" }, { ...CARD, id: "4" }] },
      "the same market twice": { ...RESULT, markets: [CARD, clone(CARD)] },
      "an invalid card": { ...RESULT, markets: [{ ...CARD, venue: "kalshi" }] },
      "markets not a list": { ...RESULT, markets: CARD },
      "extra text": { ...RESULT, text: "x" },
    };
    for (const [name, value] of Object.entries(cases)) assert.equal(wire.parseMarketTurnResult(value, TURN), null, name);
    assert.equal(wire.parseMarketTurnResult(clone(RESULT), { ...TURN, nonce: "bad" }), null, "an invalid input answers nothing");
  });
});

// ---------------------------------------------------------------------------
// Reading tool results
// ---------------------------------------------------------------------------

describe("reading Polymarket tool results", () => {
  it("copies a complete market, with the read time it was given", () => {
    assert.deepEqual(wire.harvestPolymarketMarkets(ok(skillMarket()), READ_MS), [CARD]);
    // A numeric id from the provider is the same market.
    assert.deepEqual(wire.harvestPolymarketMarkets(ok(skillMarket({ id: 540123 })), READ_MS), [CARD]);
  });

  it("keeps the event's slug for markets nested in it, alone or in a list", () => {
    const event = { id: "9911", title: "Trail Blazers vs. Knicks", slug: "nba-por-nyk-2026-11-21", markets: [skillMarket(), skillMarket({ id: "540124", question: "Knicks to win?", slug: "nba-por-nyk-2026-11-21" })] };
    const one = wire.harvestPolymarketMarkets(ok(event), READ_MS);
    assert.deepEqual(one.map((c) => [c.id, c.eventSlug]), [["540123", "nba-por-nyk-2026-11-21"], ["540124", "nba-por-nyk-2026-11-21"]]);
    const listed = wire.harvestPolymarketMarkets(ok({ events: [event], count: 1 }), READ_MS);
    assert.equal(listed.length, 2);
    assert.equal(listed[0].eventSlug, "nba-por-nyk-2026-11-21");
    assert.deepEqual(wire.harvestPolymarketMarkets(ok({ markets: [skillMarket()], count: 1 }), READ_MS), [CARD], "a bare list of markets has no event");
  });

  it("shows no amount the source did not really report", () => {
    const [card] = wire.harvestPolymarketMarkets(ok(skillMarket({ volume: 0.0, liquidity: 0.0, game_start_time: "" })), READ_MS);
    assert.equal(card.volume, null, "0.0 is also what the source writes for a missing volume");
    assert.equal(card.liquidity, null);
    assert.equal(card.gameStartTime, null);
  });

  it("skips what it cannot copy whole, and never clips", () => {
    const none = (data, why) => assert.deepEqual(wire.harvestPolymarketMarkets(typeof data === "string" ? data : ok(data), READ_MS), [], why);
    none(skillMarket({ outcomes: [{ name: "Over", clob_token_id: "1" }, { name: "Under", price: 0.5 }] }), "an outcome without a price");
    none(skillMarket({ outcomes: [{ name: "Yes", price: 1 }] }), "one outcome");
    none(skillMarket({ question: "q".repeat(301) }), "a question over the bound is not cut to fit");
    none(skillMarket({ status: "resolved" }), "an unknown status");
    none(skillMarket({ id: "" }), "no id");
    none({ id: "1", question: "compact row", slug: "x", status: "active" }, "a compact row without outcomes");
    none(JSON.stringify({ status: false, data: skillMarket(), message: "API error (500)" }), "an error result");
    none("not json", "non-JSON");
    none("[]", "an empty list");
    assert.deepEqual(wire.harvestPolymarketMarkets(ok(skillMarket()), Number.NaN), [], "no read time, no card");
    // An odd slug is dropped, not the market: the slug only builds a link.
    assert.equal(wire.harvestPolymarketMarkets(ok(skillMarket({ slug: "Bad Slug" })), READ_MS)[0].slug, "");
  });
});

// ---------------------------------------------------------------------------
// The collector
// ---------------------------------------------------------------------------

describe("market card collector", () => {
  const cite = (collector, ids) => collector.tool.execute({ market_ids: ids }, { toolCallId: "c", messages: [] }).then(JSON.parse);

  it("shows only markets a polymarket tool really returned in this run", async () => {
    const collector = wire.createMarketCardCollector();
    collector.record("polymarket_get_market_details", ok(skillMarket()), READ_MS);
    collector.record("kalshi_get_market", ok(skillMarket({ id: "777" })), READ_MS);
    collector.record("nba_get_scores", ok(skillMarket({ id: "888" })), READ_MS);
    assert.deepEqual(collector.finish(), [], "nothing is shown until cited");

    const reply = await cite(collector, ["540123", "777", "does-not-exist"]);
    assert.deepEqual(reply.shown, ["540123"]);
    assert.deepEqual(reply.not_fetched_this_turn, ["777", "does-not-exist"]);
    assert.deepEqual(collector.finish(), [CARD]);
    // The caller gets copies.
    collector.finish()[0].outcomes[0].price = 0.99;
    assert.deepEqual(collector.finish(), [CARD]);
  });

  it("keeps the order cited, at most three, and lets a later call replace the choice", async () => {
    const collector = wire.createMarketCardCollector();
    for (const id of ["1", "2", "3", "4"]) collector.record("polymarket_search_markets", ok(skillMarket({ id })), READ_MS);
    assert.deepEqual((await cite(collector, ["4", "2", "4", "1", "3"])).shown, ["4", "2", "1"]);
    assert.deepEqual(collector.finish().map((c) => c.id), ["4", "2", "1"]);
    await cite(collector, ["3"]);
    assert.deepEqual(collector.finish().map((c) => c.id), ["3"]);
    await cite(collector, ["nope"]);
    assert.deepEqual(collector.finish(), [], "a call naming nothing fetched shows nothing");
  });

  it("uses the latest read of a market, and keeps an event slug a later read lacks", async () => {
    const collector = wire.createMarketCardCollector();
    collector.record("polymarket_get_event_details", ok({ id: "9911", slug: "nba-por-nyk-2026-11-21", markets: [skillMarket()] }), READ_MS);
    const moved = skillMarket({ outcomes: [{ name: "Over", price: 0.62 }, { name: "Under", price: 0.38 }] });
    collector.record("polymarket_get_market_details", ok(moved), READ_MS + 60_000);
    await cite(collector, ["540123"]);
    const [card] = collector.finish();
    assert.deepEqual(card.outcomes, [{ name: "Over", price: 0.62 }, { name: "Under", price: 0.38 }]);
    assert.equal(card.readAt, "2026-11-21T23:50:12.345Z");
    assert.equal(card.eventSlug, "nba-por-nyk-2026-11-21");
  });

  it("reset forgets the choice, not what was read; a checkpoint restores a choice", async () => {
    const collector = wire.createMarketCardCollector();
    collector.record("polymarket_get_market_details", ok(skillMarket()), READ_MS);
    await cite(collector, ["540123"]);
    const restore = collector.checkpoint();
    collector.reset();
    assert.deepEqual(collector.finish(), []);
    assert.deepEqual((await cite(collector, ["540123"])).shown, ["540123"], "still known after reset");
    collector.reset();
    restore();
    assert.deepEqual(collector.finish(), [CARD]);
  });
});

// ---------------------------------------------------------------------------
// The registry's read time
// ---------------------------------------------------------------------------

describe("tool results carry the time they were fetched", () => {
  it("stamps a result once, so a cache hit reports the original time", async () => {
    const registry = new ToolRegistry();
    const first = await registry.dispatchToolCall("no_such_tool_for_this_test", {});
    assert.equal(first.isError, true);
    assert.equal(first.fetchedAt, undefined, "an error is not a read");
  });
});

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

const USAGE = {
  inputTokens: { total: 10 }, outputTokens: { total: 5 }, totalTokens: { total: 15 }, reasoningTokens: { total: undefined },
};
const VERDICT_OK = JSON.stringify({ isValid: true, discrepancies: [] });
const FINAL = "Hart over 7.5 rebounds is 50¢ on Polymarket (read 23:49 UTC).";
const HISTORY = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
const REQUEST = "What is the Josh Hart rebounds line on Polymarket?";

let callSeq = 0;
const toolCall = (toolName, input) => ({ type: "tool-call", toolCallId: `call_${++callSeq}`, toolName, input: JSON.stringify(input) });
const say = (text) => ({ type: "text", text });
const generated = (content) => ({
  content,
  finishReason: { unified: content.some((p) => p.type === "tool-call") ? "tool-calls" : "stop", raw: undefined },
  usage: USAGE,
  warnings: [],
});

/** One scripted step per tool-bearing call; tool-less calls (router, fact-check) get a clean verdict. */
function scripted(steps) {
  const chat = [];
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      if (!options.tools || options.tools.length === 0 || /isValid/.test(JSON.stringify(options.prompt))) return generated([say(VERDICT_OK)]);
      chat.push(options);
      return generated(steps[chat.length - 1] ?? [say(FINAL)]);
    },
  });
  return { model, chat };
}
const offeredNames = (options) => (options.tools ?? []).map((t) => t.name);

function newEngine(model, config = {}) {
  const engine = new sportsclawEngine({ provider: "anthropic", model: "fake-answer-model", thinkingBudget: 0, maxTurns: 6, ...config });
  engine.mainModel = model;
  // One installed Polymarket reader whose result is a fixture, stamped as fetched at READ_MS.
  engine.registry.injectSchema({
    sport: "polymarket",
    tools: [{
      name: "polymarket_get_market_details", command: "get_market_details", description: "One Polymarket market",
      parameters: { type: "object", properties: { market_id: { type: "string" } } },
    }],
  });
  engine.registry.dispatchToolCall = async () => ({ content: ok(skillMarket()), fetchedAt: READ_MS });
  return engine;
}

async function runMarket(engine, extra = {}) {
  const results = [];
  const text = await engine.run(REQUEST, {
    historyMode: "caller",
    history: clone(HISTORY),
    market: clone(TURN),
    onMarketResult: (r) => results.push(clone(r)),
    ...extra,
  });
  return { text, results };
}

describe("engine.run with market", () => {
  it("validates before any model work", async () => {
    const { model } = scripted([]);
    const engine = newEngine(model);
    await assert.rejects(engine.run(REQUEST, { historyMode: "caller", history: clone(HISTORY), market: clone(TURN) }), /onMarketResult/);
    await assert.rejects(runMarket(engine, { market: { ...TURN, nonce: "x" } }), /invalid market turn input/);
    assert.equal(model.doGenerateCalls.length, 0);
  });

  it("offers cite_markets only to an opted-in run and returns the cited market copied from the tool result", async () => {
    const { model, chat } = scripted([
      [toolCall("polymarket_get_market_details", { market_id: "540123" })],
      [toolCall("cite_markets", { market_ids: ["540123", "999"] })],
      [say(FINAL)],
    ]);
    const { text, results } = await runMarket(newEngine(model));
    assert.ok(offeredNames(chat[0]).includes("cite_markets"), "offered");
    assert.match(JSON.stringify(chat[0].prompt), /## Market cards/, "the opted-in run is told how to use it");
    assert.equal(text, FINAL);
    assert.deepEqual(results, [RESULT], "one result, bound to the nonce, with the price and the read time of the tool result");
  });

  it("returns no cards when the model cites nothing, or cites before reading", async () => {
    const quiet = scripted([[toolCall("polymarket_get_market_details", { market_id: "540123" })], [say(FINAL)]]);
    assert.deepEqual((await runMarket(newEngine(quiet.model))).results, [{ ...RESULT, markets: [] }]);
    const early = scripted([[toolCall("cite_markets", { market_ids: ["540123"] })], [say(FINAL)]]);
    assert.deepEqual((await runMarket(newEngine(early.model))).results, [{ ...RESULT, markets: [] }]);
  });

  it("is denied by an allowlist that omits it", async () => {
    const { model, chat } = scripted([[toolCall("polymarket_get_market_details", { market_id: "540123" })], [say(FINAL)]]);
    const { results } = await runMarket(newEngine(model, { toolAllowlist: ["polymarket_get_market_details"] }));
    assert.equal(offeredNames(chat[0]).includes("cite_markets"), false);
    assert.doesNotMatch(JSON.stringify(chat[0].prompt), /## Market cards/);
    assert.deepEqual(results, [{ ...RESULT, markets: [], reasonCode: "denied" }]);
  });

  it("leaves a run without the envelope unchanged", async () => {
    const { model, chat } = scripted([[toolCall("polymarket_get_market_details", { market_id: "540123" })], [say(FINAL)]]);
    const text = await newEngine(model).run(REQUEST, { historyMode: "caller", history: clone(HISTORY) });
    assert.equal(text, FINAL);
    assert.equal(offeredNames(chat[0]).includes("cite_markets"), false);
    assert.doesNotMatch(JSON.stringify(chat[0].prompt), /## Market cards/);
  });
});
