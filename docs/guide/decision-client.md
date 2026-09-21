# Jev decision client

`JevDecisionClient` is a standalone, typed client for TypeSafe's Jev decision endpoint. Jev is a **decision provider**, not a chat model: it answers bounded questions about a supplied state. The client is a reusable primitive — importing it boots no engine, reads no generative API key, starts no listener, loads no memory and makes no network call.

Nothing in SportsClaw calls this client automatically. The only consumer in the repository is the opt-in [Jev evidence verifier](./jev-evidence-verifier.md), which is itself opt-in.

```ts
import { JevDecisionClient } from "sportsclaw-engine-core";

const client = new JevDecisionClient({ dataPolicy: "cloud_allowed" });
const abortSignal = new AbortController().signal; // Optional caller cancellation.

const result = await client.decide(
  {
    state: "Synthetic match report: Falcons 2-1 Rovers. This example supplies no injury report.",
    questions: {
      route: {
        type: "choice",
        instructions: "Choose a supplied action",
        criteria: {
          summarize_result: "Retrieve and summarize the final result",
          analyze_injuries: "Retrieve injury details",
          review: "Escalate to human review",
        },
      },
      result_evidence: {
        type: "score",
        instructions: "Rate how explicitly the final result is supplied",
        criteria: ["No result mentioned", "Possible result mentioned", "Final result explicitly supplied"],
      },
      has_injuries: { type: "noul", instructions: "Does the state report an injury?" },
    },
  },
  { abortSignal }
);

if (result.ok) {
  for (const [id, answer] of Object.entries(result.answers)) {
    switch (answer.type) {
      case "choice":
        console.log(id, answer.choice, answer.confidence, answer.probabilities);
        break;
      case "score":
        console.log(id, answer.score, answer.legend);
        break;
      case "noul":
        // Noul has a probability and nothing else — no confidence, no boolean.
        console.log(id, answer.noul);
        break;
    }
  }
} else {
  console.warn(result.reasonCode, result.receipt);
}
```

`DecisionAnswer` is a discriminated union on `type`, so each `case` above narrows to exactly the fields that primitive returns. A failed result is typed as carrying no answers at all.

## Questions

Question IDs, option IDs and every description are the caller's. The client validates their shape and sends them verbatim; it never renames, normalizes, truncates or interprets them, and it never thresholds an answer or picks an action for you.

| Primitive | `criteria` | Answer |
| --- | --- | --- |
| `choice` | option ID → description, 2–255 entries | `choice`, `confidence`, `probabilities` keyed by the offered option IDs |
| `score` | ordered array of level descriptions, 2–10 entries | `score`, `confidence`, index-keyed `legend` and `probabilities` |
| `noul` | optional `{ true, false }` descriptions | `noul` probability only |

All three can be mixed freely in one request over one shared state, and they are answered in a single HTTP call.

**Supported subset.** Instructions are strings and criterion descriptions are strings. The native API also accepts structured instructions and structured criteria; those are **not** supported here and are rejected before egress.

A Score is probability-weighted, so it legitimately lands between levels (`1.98` across three levels). The client checks the score against the distribution it arrived with — not against the highest-probability level — using a small rounding tolerance, and requires the returned legend to describe the levels you supplied.

## State

`state` is a string or a finite JSON object/array. Structured state is deep-copied before serialization, with depth, node and text budgets spent during the walk, so cyclic or oversized input is refused before credential lookup or networking. Objects must be plain records (including null-prototype records) or arrays: convert `Date`, `Map`, `Set`, typed arrays and class instances explicitly instead of losing their meaning through coercion. Values JSON cannot represent — `undefined`, functions, `NaN`, array holes — are rejected. The exact serialized-size check also accounts for escaping and punctuation.

Nothing is silently truncated: an oversized state or request is refused as `request_too_large`, because a cut state can drop the very thing under judgement and still come back answered.

## Limits

Exported as `DECISION_LIMITS`, so you can size a request instead of discovering a bound through a refusal.

| Bound | Value |
| --- | --- |
| Questions per request | 1–32 |
| Question ID / Choice option ID | 1–64 characters |
| `instructions` | 1–4,000 characters |
| Each description | 1–1,000 characters |
| State | 32,000 characters (string length, or serialized length) |
| State nesting / nodes | 32 deep, 20,000 nodes |
| Serialized request | 128 KiB |
| Response read | 256 KiB |
| Probability sum tolerance | ±0.02 |
| Score rounding tolerance | ±0.05 |
| Deadline | 250–60,000 ms (default 8,000) |

## Configuration, consent and credentials

```ts
new JevDecisionClient({
  dataPolicy: "cloud_allowed", // default: "local_only"
  model: "jev-1.13.0",         // default; must be a pinned jev-X.Y.Z identifier
  timeoutMs: 8_000,
  transport,                   // optional HTTP seam for embedding and offline tests
  env,                         // optional environment source for the credential lookup
});
```

Credentials, transport, model and deadline are **client configuration**, never request fields. A request carrying anything besides `state` and `questions` is rejected, so a state or a question can never re-point the endpoint, change the model or grant its own consent.

- **Cloud consent is explicit.** The default `local_only` refuses before the request is even read. Only an explicit `cloud_allowed` permits egress.
- **The credential is read late.** `TYPESAFE_API_KEY` is resolved from `env` (or `process.env`) only after the request has validated and been sized — never at import or construction, and never persisted, logged or placed in a receipt.
- **One request, no retries, no fallback.** A fixed HTTPS endpoint, refused redirects, a bounded deadline, a bounded response and body cleanup on every exit. Choosing what to do after a failure is the caller's job.
- **Invalid configuration throws** a `TypeError` from the constructor, where the developer who wrote it can see it.

## Results and receipts

`decide()` never throws. Success means the answers are **schema-valid for the exact snapshot that was sent** — the request is deep-copied before egress, so mutating your objects during the `await` cannot change what is validated. It is not a statement about business correctness or permission.

Every other outcome is a typed non-success result with **no answers**, a sanitized `reasonCode` and a receipt: `local_only`, `aborted`, `invalid_request`, `invalid_state`, `invalid_questions`, `request_too_large`, `missing_credential`, `redirect_refused`, `auth_denied`, `rate_limited`, `upstream_error`, `timeout`, `network_error`, `response_too_large`, `malformed_response`, `model_mismatch`, `question_set_mismatch`, `answer_type_mismatch`, `option_set_mismatch`, `probability_invalid`, `probability_sum_invalid`, `argmax_mismatch`, `confidence_invalid`, `score_invalid`, `score_inconsistent`, `legend_invalid`, `noul_invalid`.

Receipts carry only closed enums and numbers: provider, status (`answered` / `blocked` / `failed`), reason code, requested and validated model, question and per-kind counts, provider-reported usage and latency. They never contain the state, instructions, question IDs, option labels, rubric text, answers, raw provider errors or credentials. Answers legitimately contain your own labels; receipts do not. A value the provider did not supply — an actual model, token usage — stays missing rather than becoming zero.

Enabling `cloud_allowed` authorizes sending your state to TypeSafe. Confirm that everything it contains may leave your environment, and review [TypeSafe's data handling terms](https://docs.typesafe.ai/legal.md).

## Verification

```bash
npm run build
node --test test/decision-client.test.mjs test/jev-evidence-verifier.test.mjs
```

These tests use injected HTTP responses, require no credentials and make no live call.
