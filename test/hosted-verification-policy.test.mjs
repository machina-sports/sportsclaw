/**
 * Deployment-owned action for the generative evidence check.
 *
 * Main keeps a flagged draft and records the flags (`retain`, the default).
 * A hosted deployment can opt into `correct`: one rewrite through the existing
 * correction pass, then the existing bounded recheck. A correction that cannot
 * be produced or confirmed never ships the draft the checker contradicted.
 * This restores the hosted correction intent; it does not make the checker
 * any more accurate.
 *
 * These tests drive the real compiled validateResponseEvidence with a
 * synthetic SDK model and an injected Jev transport — no live calls.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { sportsclawEngine } from "../dist/engine.js";
import { DEFAULT_JEV_MODEL, EVIDENCE_CRITERIA, resolveEvidenceVerifierSettings } from "../dist/evidence-verifier.js";

const CLEAN = '{"isValid":true,"discrepancies":[]}';
const CONTRADICTED = {
  claim: "Arsenal won 3-1",
  evidence: "Final score was Arsenal 1-1 Chelsea",
  severity: "high",
  kind: "contradicted",
};
const UNSUPPORTED = {
  claim: "Saka scored twice",
  evidence: "No scorer list in the data shown",
  severity: "medium",
  kind: "unsupported",
};
const verdict = (...discrepancies) => JSON.stringify({ isValid: discrepancies.length === 0, discrepancies });
const FLAGGED = verdict(CONTRADICTED);
const CORRECTED = "Arsenal drew 1-1 with Chelsea.";

const input = {
  userPrompt: "How did Arsenal do against Chelsea?",
  draft: "Arsenal won 3-1.",
  toolOutputs: [{ toolName: "mcp__pod__match_summary", output: '{"final":"Arsenal 1-1 Chelsea"}' }],
  callerSystemPrompt: "Answer in English. Never publish content without confirmation.",
};

/**
 * Synthetic SDK model. Each step is the reply text, or a function of the call
 * options that returns it (or throws). Missing steps reply with a clean verdict.
 */
function scripted(steps) {
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      const step = steps.shift();
      const text = typeof step === "function" ? await step(options) : step ?? CLEAN;
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        warnings: [],
      };
    },
  });
}

function fixture({ replies = [], verifier = { env: {} } } = {}) {
  const model = scripted(replies);
  const engine = Object.create(sportsclawEngine.prototype);
  engine.mainModel = model;
  engine.config = { verbose: false, evidenceVerifier: verifier };
  return { engine, model };
}

const system = (call) => call.prompt.find((m) => m.role === "system").content;
const userText = (call) => JSON.stringify(call.prompt.filter((m) => m.role !== "system"));
const CHECKER = /strict sports fact-checker/;
const EDITOR = /expert sports editor/;
const correctMode = (extra = {}) => ({ generativeAction: "correct", env: {}, ...extra });

describe("settings: generativeAction", () => {
  it("defaults to retain", () => {
    const settings = resolveEvidenceVerifierSettings({ env: {} });
    assert.equal(settings.generativeAction, "retain");
    assert.deepEqual(settings.diagnostics, []);
  });

  it("is selected through SPORTSCLAW_EVIDENCE_ACTION", () => {
    assert.equal(
      resolveEvidenceVerifierSettings({ env: { SPORTSCLAW_EVIDENCE_ACTION: "correct" } }).generativeAction,
      "correct"
    );
    assert.equal(
      resolveEvidenceVerifierSettings({ env: { SPORTSCLAW_EVIDENCE_ACTION: " Correct " } }).generativeAction,
      "correct"
    );
  });

  it("explicit config wins over the environment in both directions", () => {
    assert.equal(
      resolveEvidenceVerifierSettings({ generativeAction: "retain", env: { SPORTSCLAW_EVIDENCE_ACTION: "correct" } })
        .generativeAction,
      "retain"
    );
    assert.equal(
      resolveEvidenceVerifierSettings({ generativeAction: "correct", env: { SPORTSCLAW_EVIDENCE_ACTION: "retain" } })
        .generativeAction,
      "correct"
    );
  });

  it("reports an unrecognised action as a diagnostic", () => {
    const fromEnv = resolveEvidenceVerifierSettings({ env: { SPORTSCLAW_EVIDENCE_ACTION: "rewrite" } });
    assert.ok(fromEnv.diagnostics.includes("invalid_generativeAction"));
    const explicit = resolveEvidenceVerifierSettings({ generativeAction: "rewrite", env: {} });
    assert.ok(explicit.diagnostics.includes("invalid_generativeAction"));
  });

  it("does not change the other settings", () => {
    const settings = resolveEvidenceVerifierSettings({ generativeAction: "correct", env: {} });
    assert.equal(settings.provider, "generative");
    assert.equal(settings.dataPolicy, "local_only");
    assert.equal(settings.enabled, false);
  });
});

describe("retain (default) keeps main's flag-and-keep behavior", () => {
  it("keeps a flagged draft with no correction when no action is configured", async () => {
    const { engine, model } = fixture({ replies: [FLAGGED] });
    assert.equal(await engine.validateResponseEvidence(input), input.draft);
    assert.equal(model.doGenerateCalls.length, 1);
  });

  it("explicit retain wins over SPORTSCLAW_EVIDENCE_ACTION=correct", async () => {
    const { engine, model } = fixture({
      replies: [FLAGGED, CORRECTED],
      verifier: { generativeAction: "retain", env: { SPORTSCLAW_EVIDENCE_ACTION: "correct" } },
    });
    assert.equal(await engine.validateResponseEvidence(input), input.draft);
    assert.equal(model.doGenerateCalls.length, 1);
  });

  it("records the flags in the run trace", async () => {
    const { engine } = fixture({ replies: [FLAGGED] });
    engine._lastRunTrace = {};
    assert.equal(await engine.verifyWithTrace(input), input.draft);
    assert.equal(engine._lastRunTrace.verification.outcome, "flagged");
    assert.deepEqual(engine._lastRunTrace.verification.flaggedClaims, [CONTRADICTED.claim]);
  });
});

describe("invalid action refuses before any model call", () => {
  for (const [label, verifier] of [
    ["config", { generativeAction: "rewrite", env: {} }],
    ["env", { env: { SPORTSCLAW_EVIDENCE_ACTION: "rewrite" } }],
  ]) {
    it(`refuses an invalid action from ${label} instead of silently retaining`, async () => {
      const { engine, model } = fixture({ replies: [FLAGGED, CORRECTED], verifier });
      const out = await engine.validateResponseEvidence(input);
      assert.match(out, /could not verify/i);
      assert.notEqual(out, input.draft);
      assert.equal(model.doGenerateCalls.length, 0);
    });
  }
});

describe("correct: one correction, then the bounded recheck", () => {
  for (const [label, verifier] of [
    ["config", correctMode()],
    ["env", { env: { SPORTSCLAW_EVIDENCE_ACTION: "correct" } }],
  ]) {
    it(`returns the rechecked correction when selected by ${label}`, async () => {
      const { engine, model } = fixture({ replies: [FLAGGED, CORRECTED, CLEAN], verifier });
      assert.equal(await engine.validateResponseEvidence(input), CORRECTED);
      assert.equal(model.doGenerateCalls.length, 3);
    });
  }

  it("keeps the verification, correction and recheck passes distinct and policy-bound", async () => {
    const { engine, model } = fixture({ replies: [FLAGGED, CORRECTED, CLEAN], verifier: correctMode() });
    await engine.validateResponseEvidence(input);
    const [check, correction, recheck] = model.doGenerateCalls;
    assert.match(system(check), CHECKER);
    assert.match(system(correction), EDITOR);
    assert.doesNotMatch(system(correction), CHECKER);
    assert.match(system(recheck), CHECKER);
    // The corrector gets the checker's finding and the caller policy.
    assert.match(userText(correction), /Arsenal won 3-1/);
    assert.match(system(correction), /Never publish content without confirmation/);
    // The recheck judges the correction, not the original draft.
    assert.match(userText(recheck), /Arsenal drew 1-1 with Chelsea/);
    assert.match(system(recheck), /Never publish content without confirmation/);
  });

  it("returns a clean draft untouched with no correction", async () => {
    const { engine, model } = fixture({ replies: [CLEAN], verifier: correctMode() });
    assert.equal(await engine.validateResponseEvidence(input), input.draft);
    assert.equal(model.doGenerateCalls.length, 1);
  });

  it("traces the correction with the draft from before it", async () => {
    const { engine } = fixture({ replies: [FLAGGED, CORRECTED, CLEAN], verifier: correctMode() });
    engine._lastRunTrace = {};
    assert.equal(await engine.verifyWithTrace(input), CORRECTED);
    assert.equal(engine._lastRunTrace.verification.outcome, "corrected");
    assert.equal(engine._lastRunTrace.verification.draftBeforeCorrection, input.draft);
  });

  it("never starts a second correction on an already-corrected draft", async () => {
    const { engine, model } = fixture({ replies: [FLAGGED, CORRECTED], verifier: correctMode() });
    const out = await engine.validateResponseEvidence({ ...input, correctionAttempted: true });
    assert.match(out, /could not verify/i);
    assert.equal(model.doGenerateCalls.length, 1);
  });
});

describe("correct: an unresolved correction never ships the contradicted draft", () => {
  const refuses = (out) => {
    assert.match(out, /could not verify/i);
    assert.notEqual(out, input.draft);
    assert.notEqual(out, CORRECTED);
  };

  it("refuses when the recheck still finds a contradiction, after one correction", async () => {
    const { engine, model } = fixture({ replies: [FLAGGED, "Arsenal still won 3-1.", FLAGGED, CORRECTED], verifier: correctMode() });
    refuses(await engine.validateResponseEvidence(input));
    assert.equal(model.doGenerateCalls.length, 3);
    assert.equal(model.doGenerateCalls.filter((call) => EDITOR.test(system(call))).length, 1);
  });

  it("refuses when the correction comes back empty", async () => {
    const { engine, model } = fixture({ replies: [FLAGGED, "   "], verifier: correctMode() });
    refuses(await engine.validateResponseEvidence(input));
    assert.equal(model.doGenerateCalls.length, 2);
  });

  it("refuses when the correction call throws", async () => {
    const { engine, model } = fixture({
      replies: [FLAGGED, () => { throw new Error("upstream 503"); }],
      verifier: correctMode(),
    });
    refuses(await engine.validateResponseEvidence(input));
    assert.equal(model.doGenerateCalls.length, 2);
  });

  it("refuses rather than shipping an unchecked correction when the recheck verdict is malformed", async () => {
    const { engine } = fixture({ replies: [FLAGGED, CORRECTED, "not json", "still not json"], verifier: correctMode() });
    refuses(await engine.validateResponseEvidence(input));
  });

  it("refuses rather than shipping an unchecked correction when the recheck throws", async () => {
    const { engine } = fixture({
      replies: [FLAGGED, CORRECTED, () => { throw new Error("upstream 503"); }],
      verifier: correctMode(),
    });
    refuses(await engine.validateResponseEvidence(input));
  });
});

describe("correct: caller cancellation", () => {
  it("makes no model call after the caller has already aborted", async () => {
    const { engine, model } = fixture({ replies: [FLAGGED, CORRECTED], verifier: correctMode() });
    const out = await engine.validateResponseEvidence({ ...input, abortSignal: AbortSignal.abort() });
    assert.match(out, /could not verify/i);
    assert.equal(model.doGenerateCalls.length, 0);
  });

  it("refuses without a recheck when the caller aborts after the flag", async () => {
    const controller = new AbortController();
    const { engine, model } = fixture({
      replies: [() => { controller.abort(); return FLAGGED; }, CORRECTED, CLEAN],
      verifier: correctMode(),
    });
    const out = await engine.validateResponseEvidence({ ...input, abortSignal: controller.signal });
    assert.match(out, /could not verify/i);
    assert.notEqual(out, input.draft);
    assert.equal(model.doGenerateCalls.filter((call) => CHECKER.test(system(call))).length, 1);
  });
});

describe("correct: partial-evidence filtering survives", () => {
  const partial = { ...input, toolOutputs: [{ ...input.toolOutputs[0], truncated: true }] };

  it("does not rewrite a partial-view draft flagged only as unsupported", async () => {
    const { engine, model } = fixture({ replies: [verdict(UNSUPPORTED), CORRECTED], verifier: correctMode() });
    assert.equal(await engine.validateResponseEvidence(partial), partial.draft);
    assert.equal(model.doGenerateCalls.length, 1);
  });

  it("hands only the actionable contradiction to the corrector", async () => {
    const { engine, model } = fixture({
      replies: [verdict(CONTRADICTED, UNSUPPORTED), CORRECTED, CLEAN],
      verifier: correctMode(),
    });
    assert.equal(await engine.validateResponseEvidence(partial), CORRECTED);
    const correction = model.doGenerateCalls[1];
    assert.match(system(correction), EDITOR);
    assert.match(userText(correction), /Arsenal won 3-1/);
    assert.doesNotMatch(userText(correction), /Saka scored twice/);
    // The corrector sees the same partial-view rule the checker did.
    assert.match(system(correction), /merely not visible in that partial data is NOT a discrepancy/);
  });

  it("still acts on an unsupported value when a tool failed", async () => {
    const { engine, model } = fixture({ replies: [verdict(UNSUPPORTED), CORRECTED, CLEAN], verifier: correctMode() });
    const out = await engine.validateResponseEvidence({ ...partial, failedTools: ["mcp__pod__scorers"] });
    assert.equal(out, CORRECTED);
    assert.equal(model.doGenerateCalls.length, 3);
  });
});

describe("correct does not bypass Jev refusals", () => {
  function recorder(handler) {
    const calls = [];
    return {
      calls,
      transport: async (url, init) => {
        calls.push({ url, init });
        return handler(calls.length);
      },
    };
  }
  const jsonResponse = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("local_only still stops verification with no generative call", async () => {
    const { transport, calls } = recorder(() => { throw new Error("must not fetch"); });
    const { engine, model } = fixture({
      replies: [FLAGGED, CORRECTED],
      verifier: correctMode({ provider: "jev", dataPolicy: "local_only", fallbackToGenerative: true, transport, env: { TYPESAFE_API_KEY: "test-key" } }),
    });
    assert.equal(await engine.validateResponseEvidence(input), input.draft);
    assert.equal(calls.length, 0);
    assert.equal(model.doGenerateCalls.length, 0);
    assert.equal(engine.evidenceReceipts[0].reasonCode, "local_only");
    assert.equal(engine.evidenceReceipts[0].requestedModel, DEFAULT_JEV_MODEL);
  });

  for (const status of [401, 403]) {
    it(`an auth refusal (${status}) neither falls back nor corrects`, async () => {
      const { transport, calls } = recorder(() => jsonResponse({ error: "denied" }, status));
      const { engine, model } = fixture({
        replies: [FLAGGED, CORRECTED],
        verifier: correctMode({ provider: "jev", dataPolicy: "cloud_allowed", publicToolNames: ["mcp__pod__match_summary"], fallbackToGenerative: true, transport, env: { TYPESAFE_API_KEY: "test-key" } }),
      });
      assert.equal(await engine.validateResponseEvidence(input), input.draft);
      assert.equal(calls.length, 1);
      assert.equal(model.doGenerateCalls.length, 0);
      assert.equal(engine.evidenceReceipts[0].reasonCode, "auth_denied");
    });
  }

  it("a Jev contradiction still uses its own correct-and-recheck path under retain", async () => {
    const answers = (choice) =>
      Object.fromEntries(EVIDENCE_CRITERIA.map((key) => [key, {
        type: "choice",
        choice,
        confidence: 1,
        probabilities: { supported: choice === "supported" ? 1 : 0, contradicted: choice === "contradicted" ? 1 : 0, unknown: 0 },
      }]));
    const body = (choice) => ({ model: DEFAULT_JEV_MODEL, answers: answers(choice), usage: { input_tokens: 1, output_tokens: 1 } });
    const { transport, calls } = recorder((n) => jsonResponse(body(n === 1 ? "contradicted" : "supported")));
    const { engine, model } = fixture({
      replies: [CORRECTED],
      verifier: { provider: "jev", dataPolicy: "cloud_allowed", publicToolNames: ["mcp__pod__match_summary"], generativeAction: "retain", transport, env: { TYPESAFE_API_KEY: "test-key" } },
    });
    assert.equal(await engine.validateResponseEvidence(input), CORRECTED);
    assert.equal(calls.length, 2);
    assert.equal(model.doGenerateCalls.length, 1);
  });
});
