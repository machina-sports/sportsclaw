# Optional Jev evidence verification

SportsClaw can use TypeSafe Jev for its final evidence-verification pass. Jev is a **decision provider**, not a chat model: the configured generative model still writes answers and corrections. Existing generative verification remains the default.

This integration sends one text state to the pinned `jev-1.13.0` model with four fixed Choice questions: factual support, qualitative premises, coverage/freshness, and caller constraints. It chooses those criteria, thresholds them and drives corrections; it does not own the wire.

Transport, request/response validation and generic receipts live in the reusable [`JevDecisionClient`](./decision-client.md), which this verifier calls like any other consumer. Use that client directly for arbitrary Choice/Score/Noul questions; this page is only about the fixed evidence check. Nothing here runs unless you opt in below.

## Enable explicitly

Supply `TYPESAFE_API_KEY` through your normal secret manager or process environment. Then opt in to both the provider and its data transfer:

```bash
export SPORTSCLAW_EVIDENCE_VERIFIER=jev
export SPORTSCLAW_EVIDENCE_DATA_POLICY=cloud_allowed
# Exact tool IDs you verified as public. Without them, any tool evidence refuses the check.
export SPORTSCLAW_EVIDENCE_PUBLIC_TOOLS='["nba_get_scoreboard"]'
# Optional: use the existing verifier for inconclusive or eligible failed calls.
export SPORTSCLAW_EVIDENCE_FALLBACK=generative
sportsclaw "Summarize the supplied match evidence"
```

For an embedded engine:

```ts
import { sportsclawEngine } from "sportsclaw-engine-core";

const engine = new sportsclawEngine({
  // Keep your existing generative-provider configuration.
  evidenceVerifier: {
    provider: "jev",
    dataPolicy: "cloud_allowed",
    publicToolNames: ["nba_get_scoreboard"],
    fallbackToGenerative: true,
  },
});

const answer = await engine.run("Summarize the available match evidence");
// Internal measurement only; do not append receipts to the user-facing answer.
const receipts = engine.evidenceReceipts;
```

Explicit programmatic settings take precedence over environment settings. `env` and `transport` are optional trusted embedding/test seams; neither is a model-controlled input. The default transport uses a fixed HTTPS endpoint and refuses redirects.

## Configuration

| Environment | Programmatic field | Default |
| --- | --- | --- |
| `SPORTSCLAW_EVIDENCE_VERIFIER` | `provider` | `generative` |
| `SPORTSCLAW_EVIDENCE_DATA_POLICY` | `dataPolicy` | `local_only` |
| `SPORTSCLAW_EVIDENCE_MODEL` | `model` | `jev-1.13.0` |
| `SPORTSCLAW_EVIDENCE_TIMEOUT_MS` | `timeoutMs` | `8000` |
| `SPORTSCLAW_EVIDENCE_CONFIDENCE` | `confidenceThreshold` | `0.9` |
| `SPORTSCLAW_EVIDENCE_FALLBACK` | `fallbackToGenerative` | disabled |
| `SPORTSCLAW_EVIDENCE_ACTION` | `generativeAction` | `retain` |
| `SPORTSCLAW_EVIDENCE_PUBLIC_TOOLS` (JSON array) | `publicToolNames` | none |

Models must use a pinned `jev-X.Y.Z` identifier. Timeout accepts 250–60000 milliseconds and confidence accepts 0.5–1. Invalid settings resolve to conservative defaults and are reported by `resolveEvidenceVerifierSettings().diagnostics`. No key is stored by the settings resolver.

### Public evidence admission

`publicToolNames` lists the exact tool IDs whose outputs and failures you have verified as public. Nothing is inferred from a tool's name or topic. If even one source (successful or failed) in a turn is not on the list, the whole check is refused (`blocked`, `unapproved_evidence`) before any credential read or request; the approved remainder is never certified alone. An invalid value (not a JSON array of non-empty, exact strings) refuses verification and never falls back to the environment.

### Generative action

`generativeAction` decides what happens when the **generative** checker flags a draft. `retain` (the default) keeps the draft and records the flags in the run trace. `correct` is a deployment opt-in that preserves the earlier hosted intent of correcting actionable discrepancies: the main model makes one correction through the existing correction pass, and the existing bounded recheck must confirm it. If the correction can't be produced, the recheck still finds a problem, or the recheck can't return a verdict, the answer is refused. The contradicted draft and an unchecked correction are never shipped. With a partial evidence view, flags that only mark a claim as not visible still don't trigger a rewrite.

This isn't the legacy correction algorithm, it adds no provider route or vendor redirection, and it doesn't make the checker more accurate. An unrecognised value refuses verification before any verifier or model call instead of silently falling back to `retain`. Jev decisions, consent, fallback and abort rules are unchanged.

**`local_only` applies to this optional verifier, not to the whole engine.** Main answer generation and other tools retain their existing provider/data policies. With Jev selected and cloud consent withheld, neither Jev nor a generative verification fallback runs.

## Decision behavior

- **Supported:** every check passes its confidence threshold. Return the draft without an additional generative verification call.
- **Contradicted:** at least one check confidently identifies a problem. The main model receives fixed descriptions of the failed checks and the supplied evidence, makes one correction, and the correction is checked again. Jev does not invent quoted claims or explanations.
- **Inconclusive:** unknown or low-confidence results are not support. Use the generative verifier only when explicitly configured; otherwise preserve the drafted answer as unverified.
- **Unavailable:** transport, schema or model failures are not support. Eligible failures may use an explicitly configured generative fallback. There is no same-request Jev retry.
- **Missing key or HTTP 401/403:** do not retry or switch verification providers.
- **Caller abort:** do not start a new request or fallback; do not return a completed verification.
- **Oversized state/request:** refuse the check before reading credentials or opening a connection; do not truncate it into a successful decision or evade the bound with fallback.
- **Private or binary content:** a slip ID or a reserved `rpt_` report reference (any letter case, also when percent-encoded, well-formed or not), the caller's artifact nonce, a signed link or a credential field anywhere in the state refuses as `private_content`; a data-URI or inline image refuses as `unsupported_content`. Both happen before credentials or connections, never fall back, and never cut the value out to certify the rest. Percent-decoding is one bounded pass used only to refuse; nothing is normalized for lookup or logged.
- **Failure-only turns:** when the enabled Jev verifier covers the turn, it also judges turns whose only evidence is a failed public source; no separate generative evidence gate runs first.
- **Artifact turns:** a captured HTML report is judged even when no tool ran; values the user explicitly supplied in the request are premises, not verified sports facts, and a question that merely mentions a value does not establish it. Plain chat with no tool evidence and no report makes no verification call.
- **Source-free reports:** Jev judges external evidence. A report with no tool output and no failed source is a faithful transformation of the user's own input, so the existing primary generative checker takes the same single check slot: it judges the prose and the complete HTML against the explicitly supplied premises. All refusals above (invalid settings, `local_only`, unapproved evidence, private or binary content, the 32,000-character state limit) run first, and a refused report never reaches either checker. The route is chosen before any key read or request; it is not a fallback, so `fallbackToGenerative` plays no part. Only a passing verdict publishes the exact HTML it judged. `generativeAction` and the correction limits are unchanged, and the recheck of a correction stays on the primary checker. Turns with source data or a failed source stay on Jev.
- **Known-bad correction chain:** if the correction cannot be verified, return the existing refusal rather than shipping a known unsupported draft or unchecked correction.

`fallbackToGenerative` governs fallback verification, not correction generation. A confirmed contradiction still needs the configured main generative model to rewrite the answer.

The state includes only the current request, a fixed public answer policy (which forbids claiming that this application saved, published, placed or confirmed anything; a sourced report that a league confirmed something or an outlet published something is an ordinary factual claim), the public partial-view, failed-source and supplied-input status, the supplied evidence window, the draft (with any personalization it shows the user) and, in artifact mode, the complete HTML report as part of the answer, never as a source. The caller's system prompt, profile and history are never sent; the correction pass on the main model still receives the caller policy. The final state limit is 32,000 characters; the encoded request and response are also bounded. This verifier introduces no additional state truncation. Upstream evidence collection retains its existing bounded-window behavior.

These are fixed checks over a complete supplied draft, **not exhaustive atomic-claim extraction or an independent truth oracle**. A supported decision only concerns the supplied evidence. Scores alone do not establish tactics or causation; absent optional coverage does not invalidate unrelated supported reporting.

## Receipts and privacy

`engine.evidenceReceipts` contains metadata for the last `run()`:

- requested model, and actual model only after a validated matching response;
- status, sanitized reason code, elapsed request time and question count;
- validated per-check choices, confidences and probability distributions;
- nonnegative provider-reported token counts when available;
- whether fallback was selected and whether this was a correction recheck.

A source-free report records provider `generative` with reason code `source_free`, the main model's ID and the primary checker's verdict as its status. It never claims a Jev decision.

Receipts contain no API key, draft, source text, caller policy or raw provider error. They are not written to disk by this feature and are not appended to answers. A confidence value is distribution-derived; it is not the winning probability and is not a correctness guarantee.

Enabling `cloud_allowed` authorizes sending the verification state to TypeSafe. Confirm that every tool in `publicToolNames`, and the answers derived from them, may leave your environment. No-training terms are not equivalent to zero retention; review [TypeSafe's data handling terms](https://docs.typesafe.ai/legal.md).

## Verification and rollout

```bash
npm run build
node --test test/jev-evidence-verifier.test.mjs test/decision-client.test.mjs test/research-evidence-policy.test.mjs test/evidence-artifact-cleanup.test.mjs
```

These tests use injected HTTP responses and mock language models, require no credentials, and cover opt-in behavior, refusal gates, malformed answers, distinct probability/confidence values, correction rechecks and receipt sanitization. They do not measure live accuracy or latency.

Before changing a deployment's default, evaluate the same adjudicated cases through the existing verifier and Jev. Count missed errors, unnecessary corrections, abstentions, fallback rate and full answer latency, including correction calls. Keep the generative provider/model and evidence window explicit. The default threshold is a policy setting, not a calibrated sports benchmark; test each language and workload separately.
