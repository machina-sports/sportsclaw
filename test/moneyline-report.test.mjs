/**
 * Code-owned moneyline report — the pure module (src/moneyline-report.ts).
 *
 *   - parseMoneylineReport: a closed data schema (games → outcomes) with no
 *     HTML, title, rationale, tactics, fairProbability, edge, confidence or any
 *     other extra key, no coercion, no control/surrogate/nonfinite input, and no
 *     pick on a finished game. Returns a fresh copy or null; never throws;
 *   - impliedFromAmerican / bookmakerBenchmark: pure pricing math. A complete
 *     bookmaker set gives raw implied probabilities, their total and a
 *     proportional benchmark; an incomplete set gives none;
 *   - renderMoneylineReport(report, scope): one escaped, self-contained
 *     artifact-v1 document. Code owns the title, labels and wording; the engine
 *     scope (venue, language, generatedAt) owns everything that is not data, so
 *     the same input renders byte-identically and never reads the clock.
 *
 * The rendered numbers are still unverified data: the existing factual gate
 * checks the document against real sources (see moneyline-artifact.test.mjs).
 * The fixtures below are synthetic.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const ml = await import("../dist/moneyline-report.js");
const wire = await import("../dist/artifact-output.js");

const clone = (value) => structuredClone(value);
const close = (actual, expected, label, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCOPE = Object.freeze({
  venue: "polymarket",
  sports: ["nba"],
  timeScope: "tonight",
  language: "en",
  generatedAt: "2026-11-02T18:00:00.000Z",
});

const CELTICS = Object.freeze({
  name: "Celtics", price: 0.815, americanOdds: -521,
  record: { wins: 10, losses: 2 }, pointsForPerGame: 118.4, pointsAgainstPerGame: 108.1,
});
const LAKERS = Object.freeze({
  name: "Lakers", price: 0.19, americanOdds: 396,
  record: { wins: 5, losses: 7 }, pointsForPerGame: 111.2, pointsAgainstPerGame: 114.9,
});
const GAME = Object.freeze({ event: "Lakers at Celtics", status: "upcoming", outcomes: [CELTICS, LAKERS], pick: 0 });
const KNICKS_HEAT = Object.freeze({
  event: "Knicks at Heat", status: "upcoming",
  outcomes: [{ name: "Knicks", price: 0.655, americanOdds: -214 }, { name: "Heat", price: 0.35, americanOdds: 178 }],
});
const THREE_WAY = Object.freeze({
  event: "Arsenal v Chelsea", status: "upcoming",
  outcomes: [
    { name: "Arsenal", price: 0.39, americanOdds: 150 },
    { name: "Chelsea", price: 0.28, americanOdds: 230 },
    { name: "Draw", price: 0.33, americanOdds: 200 },
  ],
});
const REPORT = Object.freeze({ games: [GAME] });

const withGame = (patch) => ({ games: [{ ...clone(GAME), ...patch }] });
const withOutcome = (patch) => withGame({ outcomes: [{ ...clone(CELTICS), ...patch }, clone(LAKERS)] });

function render(report, scope = SCOPE) {
  const parsed = ml.parseMoneylineReport(clone(report));
  assert.ok(parsed, "a valid report");
  const artifact = ml.renderMoneylineReport(parsed, clone(scope));
  assert.ok(artifact, "a rendered artifact");
  return artifact;
}

/** Runs fn with any clock read (Date.now / new Date()) failing; dated parsing with an argument stays allowed. */
function withoutClock(fn) {
  const RealDate = globalThis.Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) throw new Error("clock read");
      super(...args);
    }
    static now() {
      throw new Error("clock read");
    }
  };
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

// ---------------------------------------------------------------------------
// Pricing math
// ---------------------------------------------------------------------------

describe("moneyline pricing math", () => {
  it("converts positive and negative American odds to raw implied probability", () => {
    close(ml.impliedFromAmerican(-521), 521 / 621, "-521");
    close(ml.impliedFromAmerican(396), 100 / 496, "+396");
    close(ml.impliedFromAmerican(-214), 214 / 314, "-214");
    close(ml.impliedFromAmerican(178), 100 / 278, "+178");
    close(ml.impliedFromAmerican(100), 0.5, "+100");
    close(ml.impliedFromAmerican(-100), 0.5, "-100");
  });

  it("refuses odds that are not finite American prices, without coercion", () => {
    for (const bad of [0, 99, -99, 50, NaN, Infinity, -Infinity, "-110", "+150", null, undefined, [150], {}]) {
      assert.equal(ml.impliedFromAmerican(bad), null, String(bad));
    }
  });

  it("-521/+396: proportional benchmark ≈80.625%, not the raw 83.9%", () => {
    const b = ml.bookmakerBenchmark([-521, 396]);
    assert.ok(b);
    close(b.raw[0], 521 / 621, "raw favourite");
    close(b.raw[1], 100 / 496, "raw underdog");
    close(b.total, 521 / 621 + 100 / 496, "total");
    assert.ok(b.total > 1, "the raw set carries an overround");
    close(b.normalized[0], 0.80625, "normalized favourite", 1e-4);
    close(b.normalized[1], 0.19375, "normalized underdog", 1e-4);
    assert.ok(Math.abs(b.normalized[0] - 0.839) > 0.03, "never the raw implied probability");
    close(b.normalized[0] + b.normalized[1], 1, "normalized set sums to one");
  });

  it("-214/+178: proportional benchmark from the exact raw set", () => {
    const rawA = 214 / 314;
    const rawB = 100 / 278;
    const b = ml.bookmakerBenchmark([-214, 178]);
    assert.ok(b);
    close(b.total, rawA + rawB, "total");
    close(b.normalized[0], rawA / (rawA + rawB), "normalized favourite");
    close(b.normalized[1], rawB / (rawA + rawB), "normalized underdog");
    close(b.normalized[0], 0.6545, "≈65.45%", 1e-4);
  });

  it("three outcomes normalize together", () => {
    const b = ml.bookmakerBenchmark([150, 230, 200]);
    assert.ok(b);
    const raw = [100 / 250, 100 / 330, 100 / 300];
    const total = raw.reduce((a, c) => a + c, 0);
    close(b.total, total, "total");
    raw.forEach((r, i) => close(b.normalized[i], r / total, `outcome ${i}`));
    close(b.normalized.reduce((a, c) => a + c, 0), 1, "sums to one");
  });

  it("an incomplete or invalid odds set yields no benchmark", () => {
    for (const set of [[-521], [-521, undefined], [undefined, 396], [-521, 396, undefined], [-521, 50], [-521, NaN], [], [-521, "396"]]) {
      assert.equal(ml.bookmakerBenchmark(set), null, JSON.stringify(set));
    }
  });
});

// ---------------------------------------------------------------------------
// The closed data schema
// ---------------------------------------------------------------------------

describe("parseMoneylineReport", () => {
  it("accepts exact reports and returns a fresh copy", () => {
    const input = clone({ games: [GAME, KNICKS_HEAT, THREE_WAY] });
    const parsed = ml.parseMoneylineReport(input);
    assert.deepEqual(parsed, input);
    input.games[0].outcomes[0].price = 0.5;
    assert.equal(parsed.games[0].outcomes[0].price, 0.815, "no shared state with the input");
  });

  it("accepts zero and boundary values: prices 0 and 1, zero stats, ±100 odds, draws, missing stats", () => {
    const valid = {
      "price 0 and 1": withOutcome({ price: 0 }),
      "price 1": withOutcome({ price: 1 }),
      "zero record": withOutcome({ record: { wins: 0, losses: 0 } }),
      "draws": withOutcome({ record: { wins: 3, losses: 1, draws: 2 } }),
      "zero ppg": withOutcome({ pointsForPerGame: 0, pointsAgainstPerGame: 0 }),
      "+100": withOutcome({ americanOdds: 100 }),
      "-100": withOutcome({ americanOdds: -100 }),
      "no stats or odds": { games: [{ event: "A at B", status: "upcoming", outcomes: [{ name: "A", price: 0.5 }, { name: "B", price: 0.5 }] }] },
      "no pick": { games: [KNICKS_HEAT] },
      "live with pick": withGame({ status: "live" }),
      "finished without pick": { games: [{ ...clone(KNICKS_HEAT), status: "finished" }] },
      "32 games": { games: Array.from({ length: 32 }, (_, i) => ({ ...clone(KNICKS_HEAT), event: `Game ${i}` })) },
    };
    for (const [label, value] of Object.entries(valid)) {
      assert.ok(ml.parseMoneylineReport(clone(value)), label);
    }
  });

  it("refuses HTML, narrative and analysis fields at every level", () => {
    const extras = ["html", "title", "rationale", "notes", "tactics", "fairProbability", "edge", "confidence", "summary", "language", "contract", "mimeType"];
    for (const key of extras) {
      assert.equal(ml.parseMoneylineReport({ ...clone(REPORT), [key]: "x" }), null, `report.${key}`);
      assert.equal(ml.parseMoneylineReport(withGame({ [key]: "x" })), null, `game.${key}`);
      assert.equal(ml.parseMoneylineReport(withOutcome({ [key]: "x" })), null, `outcome.${key}`);
    }
    assert.equal(ml.parseMoneylineReport(withOutcome({ record: { wins: 1, losses: 1, ties: 0 } })), null, "record.ties");
    assert.equal(ml.parseMoneylineReport({ title: "Report", html: "<!doctype html><html><body>x</body></html>" }), null, "a raw artifact");
  });

  it("refuses invalid, nonfinite and coerced values", () => {
    const bad = {
      "negative price": withOutcome({ price: -0.01 }),
      "price above 1": withOutcome({ price: 1.01 }),
      "NaN price": withOutcome({ price: NaN }),
      "Infinity price": withOutcome({ price: Infinity }),
      "string price": withOutcome({ price: "0.815" }),
      "null price": withOutcome({ price: null }),
      "missing price": withGame({ outcomes: [{ name: "Celtics" }, clone(LAKERS)] }),
      "odds below 100": withOutcome({ americanOdds: 99 }),
      "odds above -100": withOutcome({ americanOdds: -99 }),
      "zero odds": withOutcome({ americanOdds: 0 }),
      "NaN odds": withOutcome({ americanOdds: NaN }),
      "string odds": withOutcome({ americanOdds: "-521" }),
      "fractional wins": withOutcome({ record: { wins: 1.5, losses: 2 } }),
      "negative losses": withOutcome({ record: { wins: 1, losses: -1 } }),
      "string wins": withOutcome({ record: { wins: "10", losses: 2 } }),
      "missing losses": withOutcome({ record: { wins: 10 } }),
      "negative ppg": withOutcome({ pointsForPerGame: -0.1 }),
      "NaN ppg": withOutcome({ pointsAgainstPerGame: NaN }),
      "Infinity ppg": withOutcome({ pointsForPerGame: Infinity }),
      "string ppg": withOutcome({ pointsForPerGame: "118.4" }),
      "unknown status": withGame({ status: "stale" }),
      "closed status": withGame({ status: "closed" }),
      "one outcome": withGame({ outcomes: [clone(CELTICS)], pick: undefined }),
      "four outcomes": withGame({ outcomes: [clone(CELTICS), clone(LAKERS), { name: "C", price: 0.1 }, { name: "D", price: 0.1 }] }),
      "duplicate outcome names": withGame({ outcomes: [clone(CELTICS), { ...clone(LAKERS), name: "Celtics" }] }),
      "pick out of range": withGame({ pick: 2 }),
      "negative pick": withGame({ pick: -1 }),
      "fractional pick": withGame({ pick: 0.5 }),
      "string pick": withGame({ pick: "0" }),
      "null pick": withGame({ pick: null }),
      "finished game with a pick": withGame({ status: "finished" }),
      "no games": { games: [] },
      "33 games": { games: Array.from({ length: 33 }, (_, i) => ({ ...clone(KNICKS_HEAT), event: `Game ${i}` })) },
      "control char in name": withOutcome({ name: "Celt\u0007ics" }),
      "newline in event": withGame({ event: "Lakers\nat Celtics" }),
      "lone surrogate in event": withGame({ event: "Lakers \ud800 Celtics" }),
      "blank name": withOutcome({ name: "  " }),
      "oversized event": withGame({ event: "x".repeat(500) }),
      "oversized name": withOutcome({ name: "x".repeat(500) }),
      "non-string event": withGame({ event: 42 }),
    };
    for (const [label, value] of Object.entries(bad)) {
      assert.equal(ml.parseMoneylineReport(value), null, label);
    }
  });

  it("refuses non-plain shapes and never throws", () => {
    class Report { constructor() { this.games = clone(REPORT.games); } }
    for (const value of [null, undefined, "{}", 42, [], [REPORT], new Report(), { games: "[]" }, { games: [null] }, { games: [{ ...clone(GAME), outcomes: [null, null] }] }]) {
      assert.doesNotThrow(() => ml.parseMoneylineReport(value));
      assert.equal(ml.parseMoneylineReport(value), null, String(value));
    }
  });
});

// ---------------------------------------------------------------------------
// The code-owned renderer
// ---------------------------------------------------------------------------

describe("renderMoneylineReport", () => {
  it("keeps comparison labels visible without relying on bar colors or clipped headers", () => {
    const { html } = render(REPORT);
    assert.match(html, /th\{[^}]*white-space:normal/);
    assert.match(html, /class="legend"/);
    assert.match(html, /data-series="market"/);
    assert.match(html, /data-series="benchmark"/);
  });

  it("does not mislabel American-odds venues as fraction-priced contracts", () => {
    for (const venue of ["novig", "prophetx"]) assert.equal(ml.renderMoneylineReport(REPORT, { ...SCOPE, venue }), null);
  });

  it("does not assert common bookmaker provenance that the input does not establish", () => {
    const { html } = render(REPORT);
    assert.doesNotMatch(html, /comes from a single bookmaker|inclu(?:de|des) the bookmaker margin/i);
    assert.match(html, /supplied American odds|supplied odds/i);
  });
  it("returns one canonical artifact-v1 document with a code-owned title", () => {
    const artifact = render(REPORT);
    assert.deepEqual(wire.parseArtifactOutput(clone(artifact)), artifact, "the unchanged canonical wire accepts it");
    assert.match(artifact.title, /Moneyline report/);
    assert.match(artifact.title, /Polymarket/);
    assert.ok(!artifact.title.includes(GAME.event), "the title states no model text");
    assert.match(artifact.html, /^<!doctype html>/i);
    assert.match(artifact.html, /<html[^>]*\blang="en"/);
    assert.match(artifact.html, /name="viewport"/);
  });

  it("-521/+396 at 0.815: market price, raw implied, total and proportional benchmark are labelled apart", () => {
    const { html } = render(REPORT);
    assert.ok(html.includes("81.5c"), "price in cents");
    assert.ok(html.includes("81.5%"), "market-implied price");
    assert.match(html, /market[- ]implied price/i);
    assert.ok(html.includes("83.9%") && html.includes("20.2%"), "raw implied probabilities");
    assert.match(html, /raw implied/i);
    assert.ok(html.includes("104.1%"), "raw total / overround");
    assert.match(html, /Sum of raw implied probabilities \(supplied odds\)/);
    assert.ok(html.includes("80.6%") && html.includes("19.4%"), "proportional benchmark");
    assert.match(html, /proportional/i);
    assert.match(html, /proportional odds benchmark/i);
    assert.match(html, /benchmark difference/i);
    assert.match(html, /\+?0\.9\s*(pp|percentage[- ]points?)/i, "the difference in percentage points");
    assert.doesNotMatch(html, /fair[^<]{0,60}83\.9|83\.9%[^<]{0,60}fair/i, "the raw probability is never a fair benchmark");
  });

  it("-214/+178 at 0.655", () => {
    const { html } = render({ games: [KNICKS_HEAT] });
    assert.ok(html.includes("65.5c") && html.includes("65.5%"), "price");
    assert.ok(html.includes("68.2%") && html.includes("36.0%"), "raw implied");
    assert.ok(html.includes("65.5%") && html.includes("34.5%"), "proportional benchmark");
  });

  it("three outcomes render every outcome and its benchmark", () => {
    const { html } = render({ games: [THREE_WAY] });
    for (const text of ["Arsenal", "Chelsea", "Draw", "40.0%", "30.3%", "33.3%", "103.6%", "38.6%", "29.2%", "32.2%"]) {
      assert.ok(html.includes(text), text);
    }
  });

  it("an incomplete bookmaker pair renders prices but no benchmark", () => {
    const incomplete = { games: [{ ...clone(GAME), outcomes: [clone(CELTICS), { ...clone(LAKERS), americanOdds: undefined }] }] };
    delete incomplete.games[0].outcomes[1].americanOdds;
    const { html } = render(incomplete);
    assert.ok(html.includes("81.5c"), "the market price stays");
    for (const derived of ["80.6%", "19.4%", "104.1%"]) assert.ok(!html.includes(derived), `no ${derived}`);
    assert.doesNotMatch(html, /\+?0\.9\s*(pp|percentage[- ]points?)/i, "no benchmark difference");
  });

  it("states the limits: no independent model, fees or slippage; picks are leans", () => {
    const { html } = render(REPORT);
    assert.match(html, /no independent win[- ]probability model/i);
    assert.match(html, /fees/i);
    assert.match(html, /slippage/i);
    assert.match(html, /lean/i);
  });

  it("shows records and per-game points as exact labelled facts, with no tactics or edge language", () => {
    const { html } = render(REPORT);
    assert.match(html, /10[-–]2/);
    assert.match(html, /5[-–]7/);
    for (const n of ["118.4", "108.1", "111.2", "114.9"]) assert.ok(html.includes(n), n);
    assert.match(html, /per game/i);
    assert.doesNotMatch(html, /rebound|interior|perimeter|tactic/i, "no tactical claims");
    assert.doesNotMatch(html, /\+EV|\bedge\b|consensus|fair benchmark|value bet|\block\b|guarantee/i, "no edge or consensus labels");
  });

  it("missing stats render without invented values", () => {
    const { html } = render({ games: [KNICKS_HEAT] });
    assert.doesNotMatch(html, /undefined|NaN|null/);
    assert.doesNotMatch(html, /per game/i);
  });

  it("escapes every label; no script, handler or external resource survives", () => {
    const xss = {
      games: [{
        event: '</title><script>alert(1)</script>',
        status: "upcoming",
        outcomes: [
          { name: '"><img src=x onerror=alert(1)>', price: 0.5, americanOdds: -110 },
          { name: "<svg onload=alert(1)>&amp;", price: 0.5, americanOdds: -110 },
        ],
      }],
    };
    const { html, title } = render(xss);
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(html.includes("&amp;amp;"), "ampersands are escaped too");
    assert.doesNotMatch(html, /<script|<img|<iframe|<object|<embed|<link|<form|<base/i);
    assert.doesNotMatch(html, /<[^>]*\son\w+\s*=/i, "no event handler attributes");
    assert.doesNotMatch(html, /<[^>]*\s(?:src|href|srcset)\s*=|url\(|@import/i, "no external resources (escaped label text is not markup)");
    assert.ok(!title.includes("<"), "the title carries no label");
  });

  it("is deterministic: identical input renders byte-identically and never reads the clock", () => {
    const a = withoutClock(() => render(REPORT));
    const b = withoutClock(() => render(clone(REPORT)));
    assert.equal(a.html, b.html);
    assert.equal(a.title, b.title);
    assert.ok(a.html.includes("2026-11-02"), "the engine-supplied generated date");
    const later = render(REPORT, { ...SCOPE, generatedAt: "2026-11-03T09:30:00.000Z" });
    assert.notEqual(later.html, a.html, "the date comes from the scope");
  });

  it("language comes from the engine scope", () => {
    const en = render(REPORT);
    for (const language of ["pt", "es"]) {
      const other = render(REPORT, { ...SCOPE, language });
      assert.match(other.html, new RegExp(`<html[^>]*\\blang="${language}"`));
      assert.notEqual(other.html, en.html, language);
      assert.ok(other.html.includes("81.5"), `${language}: same numbers`);
    }
  });

  it("refuses an invalid scope or an unparsed report", () => {
    const parsed = ml.parseMoneylineReport(clone(REPORT));
    for (const scope of [
      { ...SCOPE, venue: "draftkings" },
      { ...SCOPE, language: "fr" },
      { ...SCOPE, generatedAt: "not a date" },
      { ...SCOPE, generatedAt: undefined },
      { ...SCOPE, title: "Edge report" },
      null,
    ]) {
      assert.equal(ml.renderMoneylineReport(parsed, scope), null, JSON.stringify(scope));
    }
    assert.equal(ml.renderMoneylineReport({ ...clone(REPORT), rationale: "edge" }, clone(SCOPE)), null, "re-validates its input");
    assert.equal(ml.renderMoneylineReport(withGame({ status: "finished" }), clone(SCOPE)), null, "finished pick");
  });
});
