/**
 * `sportsclaw judge-compare`: one question set, several decision providers, one report.
 *
 * The runner is tested with stand-in providers and with the real clients over injected
 * transports. No live calls, no credentials.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JevDecisionClient } from "../dist/decision-client.js";
import { GeminiDecisionClient } from "../dist/gemini-decision-client.js";
import { parseJudgeCases, parseJudgeCompareArgs, runJudgeCompare } from "../dist/judge-compare.js";

const QUESTIONS = {
  route: {
    type: "choice",
    instructions: "Choose a supplied action",
    criteria: { summarize: "Summarize the result", injuries: "Look up injuries", review: "Ask a person" },
  },
  evidence: { type: "score", instructions: "How explicit is the result?", criteria: ["none", "hinted", "stated"] },
  has_injuries: { type: "noul", instructions: "Does the state report an injury?" },
};

const CASE = { id: "falcons", state: "Falcons 2-1 Rovers.", questions: QUESTIONS };

const receipt = (latencyMs = 10) => ({ latencyMs });

/** A stand-in provider that answers every case with the given answers. */
function judge(model, answers, latencyMs = 10) {
  return {
    provider: model.startsWith("jev") ? "jev" : "gemini",
    model,
    dataPolicy: "cloud_allowed",
    decide: async () => ({ ok: true, model, answers, receipt: receipt(latencyMs) }),
  };
}

function failing(model, reasonCode) {
  return {
    provider: "gemini",
    model,
    dataPolicy: "cloud_allowed",
    decide: async () => ({ ok: false, reasonCode, receipt: receipt(0) }),
  };
}

const JEV_ANSWERS = {
  route: { type: "choice", choice: "summarize", confidence: 0.9, probabilities: { summarize: 0.85, injuries: 0.05, review: 0.1 } },
  evidence: { type: "score", score: 1.9, confidence: 0.9, legend: {}, probabilities: { 0: 0, 1: 0.1, 2: 0.9 } },
  has_injuries: { type: "noul", noul: 0.03 },
};

const GEMINI_ANSWERS = {
  route: { type: "choice", choice: "review", confidence: 0.5, probabilities: { summarize: 0.4, injuries: 0.1, review: 0.5 } },
  evidence: { type: "score", score: 1.6, confidence: 0.6, legend: {}, probabilities: { 0: 0, 1: 0.4, 2: 0.6 } },
  has_injuries: { type: "noul", noul: 0.2 },
};

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);

describe("parseJudgeCases", () => {
  it("reads one case per line and skips blank lines", () => {
    const text = `${JSON.stringify(CASE)}\n\n${JSON.stringify({ ...CASE, id: "second" })}\n`;
    assert.deepEqual(parseJudgeCases(text).map((c) => c.id), ["falcons", "second"]);
  });

  it("names the line of a case it cannot use", () => {
    assert.throws(() => parseJudgeCases(`${JSON.stringify(CASE)}\nnot json`), /line 2/);
    assert.throws(() => parseJudgeCases(JSON.stringify({ state: "x", questions: QUESTIONS })), /line 1.*id/);
    assert.throws(() => parseJudgeCases(JSON.stringify({ id: "a", questions: QUESTIONS })), /line 1.*state/);
    assert.throws(() => parseJudgeCases(JSON.stringify({ id: "a", state: "x" })), /line 1.*questions/);
  });

  it("refuses a repeated case id", () => {
    assert.throws(() => parseJudgeCases(`${JSON.stringify(CASE)}\n${JSON.stringify(CASE)}`), /line 2.*falcons/);
  });

  it("refuses an expected answer the question could never give", () => {
    const withExpected = (expected) => JSON.stringify({ ...CASE, expected });
    assert.throws(() => parseJudgeCases(withExpected({ nope: true })), /nope/);
    assert.throws(() => parseJudgeCases(withExpected({ route: "not_offered" })), /route/);
    assert.throws(() => parseJudgeCases(withExpected({ evidence: 3 })), /evidence/);
    assert.throws(() => parseJudgeCases(withExpected({ has_injuries: "no" })), /has_injuries/);
    assert.equal(parseJudgeCases(withExpected({ route: "summarize", evidence: 2, has_injuries: false })).length, 1);
  });
});

describe("parseJudgeCompareArgs", () => {
  it("defaults to both providers on their default models", () => {
    const args = parseJudgeCompareArgs(["cases.jsonl", "--cloud-allowed"]);
    assert.deepEqual(args, {
      casesPath: "cases.jsonl",
      judges: [{ provider: "jev" }, { provider: "gemini" }],
      cloudAllowed: true,
    });
  });

  it("reads judges with models, an output file and a deadline", () => {
    const args = parseJudgeCompareArgs(["cases.jsonl", "--judges", "jev:jev-1.14.0,jev,gemini", "--out=r.json", "--timeout", "5000"]);
    assert.deepEqual(args, {
      casesPath: "cases.jsonl",
      judges: [{ provider: "jev", model: "jev-1.14.0" }, { provider: "jev" }, { provider: "gemini" }],
      cloudAllowed: false,
      out: "r.json",
      timeoutMs: 5000,
    });
  });

  it("refuses a missing file, an unknown provider and an unknown flag", () => {
    assert.throws(() => parseJudgeCompareArgs(["--cloud-allowed"]), /cases/);
    assert.throws(() => parseJudgeCompareArgs(["cases.jsonl", "--judges", "openai"]), /jev, gemini/);
    assert.throws(() => parseJudgeCompareArgs(["cases.jsonl", "--fast"]), /--fast/);
    assert.throws(() => parseJudgeCompareArgs(["cases.jsonl", "--timeout", "soon"]), /--timeout/);
  });
});

describe("runJudgeCompare", () => {
  it("reports each judge's pick per question and whether the judges agree", async () => {
    const report = await runJudgeCompare([CASE], [judge("jev-1.13.0", JEV_ANSWERS), judge("gemini-decision-1", GEMINI_ANSWERS)]);
    assert.deepEqual(report.judges, [
      { provider: "jev", model: "jev-1.13.0" },
      { provider: "gemini", model: "gemini-decision-1" },
    ]);
    const { questions, calls } = report.cases[0];
    assert.deepEqual(calls["jev-1.13.0"], { ok: true, reasonCode: "answered", latencyMs: 10 });

    assert.equal(questions.route.type, "choice");
    assert.equal(questions.route.answers["jev-1.13.0"].pick, "summarize");
    assert.equal(questions.route.answers["jev-1.13.0"].confidence, 0.9);
    near(questions.route.answers["jev-1.13.0"].margin, 0.75);
    assert.equal(questions.route.answers["gemini-decision-1"].pick, "review");
    near(questions.route.answers["gemini-decision-1"].margin, 0.1);
    assert.equal(questions.route.agree, false);

    // A score's pick is its nearest level.
    assert.deepEqual(questions.evidence.answers["jev-1.13.0"], { pick: 2, score: 1.9, confidence: 0.9 });
    assert.deepEqual(questions.evidence.answers["gemini-decision-1"], { pick: 2, score: 1.6, confidence: 0.6 });
    assert.equal(questions.evidence.agree, true);

    // A true/false pick is the side of one half the probability falls on.
    assert.deepEqual(questions.has_injuries.answers["jev-1.13.0"], { pick: false, probability: 0.03 });
    assert.equal(questions.has_injuries.agree, true);

    assert.deepEqual(report.summary.agreement, { questions: 3, agreed: 2 });
  });

  it("marks picks against the expected answers and counts them per judge", async () => {
    const expected = { route: "summarize", has_injuries: false };
    const report = await runJudgeCompare(
      [{ ...CASE, expected }],
      [judge("jev-1.13.0", JEV_ANSWERS, 20), judge("gemini-decision-1", GEMINI_ANSWERS, 40)]
    );
    const { questions } = report.cases[0];
    assert.equal(questions.route.expected, "summarize");
    assert.equal(questions.route.answers["jev-1.13.0"].correct, true);
    assert.equal(questions.route.answers["gemini-decision-1"].correct, false);
    assert.equal("correct" in questions.evidence.answers["jev-1.13.0"], false);
    assert.deepEqual(report.summary.judges["jev-1.13.0"], { cases: 1, answered: 1, failed: {}, meanLatencyMs: 20, expected: 2, correct: 2 });
    assert.deepEqual(report.summary.judges["gemini-decision-1"], { cases: 1, answered: 1, failed: {}, meanLatencyMs: 40, expected: 2, correct: 1 });
  });

  it("records a failed call by reason and leaves agreement uncounted for that case", async () => {
    const report = await runJudgeCompare([CASE], [judge("jev-1.13.0", JEV_ANSWERS), failing("gemini-decision-1", "content_blocked")]);
    const entry = report.cases[0];
    assert.deepEqual(entry.calls["gemini-decision-1"], { ok: false, reasonCode: "content_blocked", latencyMs: 0 });
    assert.equal("gemini-decision-1" in entry.questions.route.answers, false);
    assert.equal("agree" in entry.questions.route, false);
    assert.deepEqual(report.summary.judges["gemini-decision-1"], { cases: 1, answered: 0, failed: { content_blocked: 1 }, expected: 0, correct: 0 });
    assert.deepEqual(report.summary.agreement, { questions: 0, agreed: 0 });
  });

  it("refuses two judges on the same model", async () => {
    await assert.rejects(runJudgeCompare([CASE], [judge("jev-1.13.0", JEV_ANSWERS), judge("jev-1.13.0", JEV_ANSWERS)]), /jev-1\.13\.0/);
  });

  it("never copies a case's state or question text into the report", async () => {
    const report = await runJudgeCompare([CASE], [judge("jev-1.13.0", JEV_ANSWERS)]);
    const text = JSON.stringify(report);
    assert.ok(!text.includes("Falcons"));
    assert.ok(!text.includes("Choose a supplied action"));
  });

  it("runs the real clients over the same case", async () => {
    const respond = (body) => async () => new Response(JSON.stringify(body), { status: 200 });
    const one = { id: "one", state: "Falcons 2-1 Rovers.", questions: { has_injuries: QUESTIONS.has_injuries }, expected: { has_injuries: false } };
    const jev = new JevDecisionClient({
      dataPolicy: "cloud_allowed",
      env: { TYPESAFE_API_KEY: "test-key" },
      transport: respond({ model: "jev-1.13.0", answers: { has_injuries: { type: "noul", noul: 0.04 } } }),
    });
    const gemini = new GeminiDecisionClient({
      dataPolicy: "cloud_allowed",
      env: {},
      transport: respond({ answers: { has_injuries: { type: "noul", noul: 0.02, confidence: 0.98 } } }),
    });
    const report = await runJudgeCompare([one], [jev, gemini]);
    assert.equal(report.cases[0].questions.has_injuries.answers["jev-1.13.0"].correct, true);
    assert.equal(report.cases[0].calls["gemini-decision-1"].reasonCode, "missing_credential");
  });
});
