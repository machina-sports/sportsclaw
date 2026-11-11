# Decision providers

A decision provider answers bounded questions about a supplied state — pick one option, rate on a scale, true or false — and returns probabilities, not prose. SportsClaw has one request and answer shape for this and two providers behind it:

| Provider | Client | Default model | Key read from |
| --- | --- | --- | --- |
| TypeSafe Jev | `JevDecisionClient` | `jev-1.13.0` | `TYPESAFE_API_KEY` |
| Google Gemini | `GeminiDecisionClient` | `gemini-decision-1` | `GEMINI_API_KEY` |

Both implement `DecisionProvider`, take the request described in [Jev decision client](./decision-client.md) and return the same `DecisionResult`. Consent, limits, the deadline, the answer checks and the receipts are one shared implementation; a provider supplies only its wire format.

```ts
import { createDecisionProvider } from "sportsclaw-engine-core";

const judge = createDecisionProvider({ provider: "gemini", dataPolicy: "cloud_allowed" });
const result = await judge.decide({ state, questions });
```

Code written against `DecisionProvider` does not change when the provider does.

## Not a model role

The model roles (`eyes`, `brain`, `hands`, `voice`) write: they go through `invokeModelRole` and return text or media. A judge returns checked probabilities over options the caller supplied, so it is not a fifth role and never goes through a chat route. It is configured in the same block:

```json
{
  "inference": {
    "roles": { "brain": { "route": "nim", "model": "..." } },
    "judge": { "provider": "gemini", "dataPolicy": "cloud_allowed" }
  }
}
```

| Field | Meaning |
| --- | --- |
| `provider` | `jev` or `gemini` |
| `model` | Optional. A pinned `jev-X.Y.Z`, or a `gemini-decision-*` model |
| `dataPolicy` | `local_only` (default, sends nothing) or `cloud_allowed` |
| `timeoutMs` | Optional deadline, 250–60,000 ms |

The key is never in config; any other field is refused. `createDecisionProvider(config.inference.judge)` builds the provider.

The built-in Jev consumers — the [evidence verifier](./jev-evidence-verifier.md), [capability routing](./capability-routing.md), [watch decisions](./jev-watch-decisions.md) and slips — keep their own Jev settings and do not read `judge`. Their thresholds were set against Jev; moving one to another provider is a change to measure first.

## What differs on Gemini

- **State.** A string is sent as it is; a structured state is sent as its JSON text. An empty state is refused (`invalid_state`).
- **Question keys** may contain letters, digits, `_` and `-` only; anything else is refused before egress (`invalid_questions`).
- **Limits.** `DECISION_LIMITS` applies unchanged, although the service accepts more, so a request valid for one provider is valid for both.
- **True/false answers.** The service returns a confidence with the probability; the shared answer carries the probability only, as for Jev.
- **Model.** The service does not report which model answered: `result.model` is the model asked for and the receipt's `model` stays unset.
- **Blocked input.** Input the service's safety filters block is the reason code `content_blocked`, with no answers and none of the provider's message.
- **Media.** The service also accepts images, audio, video and PDFs. This client sends text only.

The Gemini wire format follows Google's published guide and is covered by tests against responses of that shape. It has not been run against the live service from this repository.

## Comparing providers

Which provider to trust for a job, and above what confidence, is a measurement. `judge-compare` runs one question set through several judges and writes one report:

```bash
sportsclaw judge-compare cases.jsonl --cloud-allowed --out report.json
sportsclaw judge-compare cases.jsonl --cloud-allowed --judges jev:jev-1.14.0,jev,gemini
```

`--cloud-allowed` is required: the command sends each case's state to the judges' hosted services. A judge whose key is not set is reported as `missing_credential` and nothing is sent to it.

A case file is JSONL, one case per line. `expected` is optional and per question: an option id, a level number, or `true`/`false`.

```json
{"id": "final-score", "state": "Falcons 2-1 Rovers, full time.", "questions": {"next": {"type": "choice", "instructions": "Pick the next action", "criteria": {"summarize": "Summarize the result", "clarify": "Ask which game is meant"}}}, "expected": {"next": "summarize"}}
```

The report holds, per case and question, each judge's pick (keyed by model), the numbers behind it, whether the judges agree and whether each pick matches `expected`:

- **choice** — `pick` (the option), `confidence`, and `margin`: the top probability minus the runner-up's.
- **score** — `pick` (the nearest level), `score`, `confidence`.
- **true/false** — `pick` (which side of one half the probability falls on) and `probability`.

`summary` counts, per judge, cases answered, failures by reason code, mean latency, and correct picks out of those with an expected answer; and across judges, the questions all of them answered and those where every pick was the same. The report never contains a case's state or a question's wording.

## Verification

```bash
npm run build
node --test test/decision-client.test.mjs test/gemini-decision-client.test.mjs test/judge.test.mjs test/judge-compare.test.mjs
```

These tests use injected HTTP responses, require no credentials and make no live call.
