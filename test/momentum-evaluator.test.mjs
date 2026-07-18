/**
 * Momentum & Price Explainer — generator + semantic-evaluator loop tests.
 *
 * The sibling suite (momentum-explainer.test.mjs) covers the deterministic
 * surface with no model. THIS suite closes the gap that surface leaves: it
 * drives the real `produceCard` loop — generate → judge → regenerate → emit or
 * hold — with BOTH LLM calls served by injected `ai/test` mock models. No
 * network, no credentials, no token spend, fully deterministic in CI.
 *
 * These are the behaviors that previously could only be checked by a live run:
 *   - a clean card passes the skeptic and reaches the card sink;
 *   - a card the skeptic rejects is held for review, never emitted;
 *   - the retry budget regenerates and can pass on a later attempt;
 *   - an unparseable verdict fails CLOSED (the checker can't wave a card through
 *     by being unintelligible).
 *
 * node:test + assert, importing from dist/ per the project's convention.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockLanguageModelV3 } from "ai/test";

import { MomentumExplainer } from "../dist/intelligence/momentum-explainer.js";

// ---------------------------------------------------------------------------
// Mock-model helpers
// ---------------------------------------------------------------------------

/**
 * A language model whose text output is produced by `nextText(callIndex)`.
 * `calls` counts invocations so a test can assert the retry budget was spent.
 */
function textModel(nextText) {
  const state = { calls: 0 };
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      const text = nextText(state.calls);
      state.calls += 1;
      return {
        content: [{ type: "text", text }],
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        warnings: [],
      };
    },
  });
  return { model, state };
}

/** Constant-text model (the generator: its exact wording is not under test). */
const constModel = (text) => textModel(() => text);

/** A checker verdict as the JSON the skeptic is prompted to emit. */
const verdictJson = ({ claim = true, noHall = true, dir = true, reasons = [] }) =>
  JSON.stringify({
    claimSupported: claim,
    noHallucination: noHall,
    directionCoherent: dir,
    reasons,
  });

// ---------------------------------------------------------------------------
// A mock-mode WatchEvent carrying one embedded scoring play (no ESPN call).
// ---------------------------------------------------------------------------

function makeEvent({ before = 42, after = 68 } = {}) {
  return {
    timestamp: "2026-07-01T18:08:00Z",
    changesSummary: `polymarket_home_price_cents ${before}→${after}`,
    changes: [
      {
        path: "data.polymarket_home_price_cents",
        type: "modified",
        before,
        after,
      },
    ],
    snapshot: {
      data: {
        sport: "nfl",
        game_id: "mock-jax-hou-2026",
        timestamp: "2026-07-01T18:08:00Z",
        teams: { home: { abbrev: "JAX" }, away: { abbrev: "HOU" } },
        game_clock: "11:30 2nd Qtr",
        polymarket_home_price_cents: after,
        play_by_play: [
          {
            id: "p-td",
            sequence: "2",
            wallclock: "2026-07-01T18:07:00Z",
            text: "C.Lawrence pass complete deep right to B.Thomas for 45 yards, TOUCHDOWN.",
            type: "Passing Touchdown",
            homeScore: 7,
            awayScore: 3,
            scoringPlay: true,
            team: { id: "jax" },
          },
        ],
      },
    },
  };
}

/** Build an explainer with injected models and capturing sinks. */
function makeExplainer({ gen, checker, maxAttempts = 2 }) {
  const emitted = [];
  const rejected = [];
  const explainer = new MomentumExplainer({
    mode: "mock",
    direction: "up",
    thresholdCents: 10,
    evaluate: true,
    maxAttempts,
    modelInstance: gen.model,
    evaluatorModelInstance: checker.model,
    evaluatorModel: "mock-checker",
    onCard: (c) => emitted.push(c),
    onRejected: (c) => rejected.push(c),
  });
  return { explainer, emitted, rejected };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("produceCard loop (injected generator + semantic checker)", () => {
  it("emits a card the skeptic approves, stamped with the checker's verdict", async () => {
    const gen = constModel(
      "C.Lawrence's 45-yard TD to B.Thomas flipped the home price up 26 points.",
    );
    const checker = constModel(verdictJson({ claim: true, noHall: true, dir: true }));
    const { explainer, emitted, rejected } = makeExplainer({ gen, checker });

    await explainer.injectEvent(makeEvent());

    assert.equal(emitted.length, 1, "one PASS card reaches onCard");
    assert.equal(rejected.length, 0, "nothing held for review");
    const card = emitted[0];
    assert.equal(card.verdict.verdict, "pass");
    assert.equal(card.verdict.checks.claimSupported, true);
    assert.equal(card.verdict.checks.noHallucination, true);
    assert.equal(card.verdict.checks.directionCoherent, true);
    assert.equal(card.verdict.evaluatorModel, "mock-checker", "maker != checker is recorded");
    assert.equal(card.verdict.attempts, 1);
    assert.equal(explainer.cardsEmitted, 1);
    assert.equal(gen.state.calls, 1, "one generation on a first-try pass");
    assert.equal(checker.state.calls, 1, "the skeptic was actually consulted");
  });

  it("holds a card the skeptic rejects — never emits it — after exhausting attempts", async () => {
    const gen = constModel("A late pitching change swung the home price up 26 points.");
    // Skeptic rejects: the claim is not supported by the (TD) play in the window.
    const checker = constModel(
      verdictJson({ claim: false, reasons: ["No pitching change appears in the window."] }),
    );
    const { explainer, emitted, rejected } = makeExplainer({ gen, checker, maxAttempts: 2 });

    await explainer.injectEvent(makeEvent());

    assert.equal(emitted.length, 0, "a rejected card is NEVER emitted as good");
    assert.equal(rejected.length, 1, "it is routed to the human inbox");
    assert.equal(rejected[0].verdict.verdict, "reject");
    assert.equal(rejected[0].verdict.checks.claimSupported, false);
    assert.equal(explainer.cardsRejected, 1);
    assert.equal(gen.state.calls, 2, "regenerated up to the attempt cap");
    assert.equal(checker.state.calls, 2, "checked on every attempt");
  });

  it("regenerates and passes on a later attempt (retry budget works)", async () => {
    const gen = constModel("C.Lawrence's 45-yard TD to B.Thomas moved the home price up 26 points.");
    // Reject the first attempt, approve the second.
    const checker = textModel((i) =>
      i === 0
        ? verdictJson({ claim: false, reasons: ["Needs the exact play cited."] })
        : verdictJson({ claim: true, noHall: true, dir: true }),
    );
    const { explainer, emitted, rejected } = makeExplainer({ gen, checker, maxAttempts: 3 });

    await explainer.injectEvent(makeEvent());

    assert.equal(rejected.length, 0);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].verdict.verdict, "pass");
    assert.equal(emitted[0].verdict.attempts, 2, "passed on the second attempt");
    assert.equal(checker.state.calls, 2);
  });

  it("fails CLOSED when the checker returns an unparseable verdict", async () => {
    const gen = constModel("C.Lawrence's 45-yard TD to B.Thomas moved the home price up 26 points.");
    const checker = constModel("Sure! I think this card looks basically fine to me.");
    const { explainer, emitted, rejected } = makeExplainer({ gen, checker, maxAttempts: 1 });

    await explainer.injectEvent(makeEvent());

    assert.equal(emitted.length, 0, "an unintelligible checker cannot wave a card through");
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].verdict.verdict, "reject");
    assert.match(
      rejected[0].verdict.reasons.join(" "),
      /no parseable verdict/i,
      "the fail-closed reason is recorded for diagnosis",
    );
  });
});
