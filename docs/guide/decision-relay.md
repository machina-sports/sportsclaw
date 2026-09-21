# Decision relay (`POST /api/decide`)

`POST /api/decide` exposes the [Jev decision client](./decision-client.md) over the relay: one authenticated HTTP request carrying one `state` and one map of bounded questions, one typed result back.

It is a separate path from `/api/query`. A decision request never starts the SportsClaw CLI, MCP, memory, a listener or a generative model — it spawns a single short-lived Node worker (`dist/decision-relay.js`) that reads the body on stdin and writes exactly one typed result on stdout. The engine is untouched by this endpoint, and nothing here changes how `/api/query` behaves.

The endpoint is **disabled by default**. A default deployment answers `503`.

## Request

```bash
curl -sS https://<relay-host>/api/decide \
  -H "X-Auth-Token: $AGENTS_API_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "state": "Synthetic match report: Falcons 2-1 Rovers. This example supplies no injury report.",
    "questions": {
      "has_injuries": { "type": "noul", "instructions": "Does the state report an injury?" }
    }
  }'
```

The body is a JSON object carrying **exactly** `state` and `questions` — the same shapes the client documents, including `choice`, `score` and `noul` mixed in one request. Anything else in the body is a `400`, not a silently ignored field. The two recognized fields are re-serialized before they reach the worker, so nothing else in your JSON can travel with them.

Everything the caller does not own is server configuration and cannot be set from a request:

| Fixed server side | Value |
| --- | --- |
| Endpoint | the client's fixed HTTPS endpoint |
| Model | the pinned default (`jev-1.13.0`) |
| Decision deadline | 8,000 ms, enforced in the worker |
| Process deadline | 10 s, the relay-side backstop |
| Credential | `TYPESAFE_API_KEY` from the relay environment |
| Cloud consent | `SPORTSCLAW_DECISION_DATA_POLICY` |

A `state` that asks for a different model, endpoint, deadline or data policy is just text: none of them are request fields.

## Authentication and data policy

- **Auth first.** The endpoint uses the same `X-Auth-Token` / `AGENTS_API_TOKEN` gate as the rest of the relay agent API — `503` when no server token is configured, `401` on a missing or mismatched one — and it is checked before the policy, before the body is read and before a concurrency slot is taken. A denied caller learns nothing about any of them.
- **Cloud egress is opt-in.** The endpoint only works when `SPORTSCLAW_DECISION_DATA_POLICY=cloud_allowed`. Unset, empty, `local_only` or any other spelling (including `CLOUD_ALLOWED`) is `local_only`, and the endpoint answers `503 decision API is disabled by data policy`.
- **One credential.** The worker exposes only `TYPESAFE_API_KEY` to the client. No other provider key in the relay environment can be forwarded, and the credential never appears in a response or a log.

Enabling `cloud_allowed` authorizes sending caller-supplied state to TypeSafe. Confirm that everything a caller can put in `state` may leave your environment, and review [TypeSafe's data handling terms](https://docs.typesafe.ai/legal.md).

## Limits

| Bound | Value |
| --- | --- |
| Request body | 32 KiB (`MAX_DECISION_BODY_BYTES`, mirrored by `MAX_RELAY_BODY_BYTES` in the worker) |
| Body read deadline | 5 s |
| Decision deadline | 8 s (`RELAY_TIMEOUT_MS`) |
| Worker process deadline | 10 s |
| Concurrency | shared with the relay's query budget (`RELAY_MAX_QUERY_CONCURRENCY`, default 4) |

The body bound is enforced twice: the relay streams with a hard cap so an oversized body is never buffered, and the worker caps its stdin again. Nothing is truncated — an oversized body is refused.

## Responses

A `200` carries the worker's typed `DecisionResult` verbatim, with `Cache-Control: no-store`.

```json
{
  "ok": true,
  "model": "jev-1.13.0",
  "answers": { "has_injuries": { "type": "noul", "noul": 0.03 } },
  "receipt": { "provider": "jev", "status": "answered", "reasonCode": "answered", "questionCount": 1, "...": "..." }
}
```

**A typed refusal is also a `200`.** A blocked or failed decision is a successful transaction with an unsuccessful outcome, so callers MUST inspect `ok` rather than the HTTP status. `ok: false` carries a sanitized `reasonCode` (`local_only`, `missing_credential`, `auth_denied`, `rate_limited`, `timeout`, `aborted`, `malformed_response`, …) and never any answers. The full list is in the [client guide](./decision-client.md#results-and-receipts).

Non-`200` statuses are transport-level refusals, before or around the decision itself:

| Status | Meaning |
| --- | --- |
| `401` / `503` | auth gate: token missing or mismatched, or no server secret configured |
| `503` | data policy: the endpoint is disabled |
| `400` | the body is not a JSON object carrying exactly `state` and `questions` |
| `408` | the body did not arrive within the read deadline |
| `413` | the body exceeds 32 KiB |
| `429` | concurrency capacity exhausted |
| `502` | the worker failed, exited nonzero or wrote something that is not a typed result |
| `504` | the worker exceeded the process deadline |

Every one of these is a fixed, caller-independent message. A provider error is not a public protocol, so it is never forwarded.

## What is not logged

Nothing about a request, an answer or a child error reaches the relay log or a response: not the `state`, not question IDs, instructions or option labels, not the answers, not the worker's stderr, and not any credential. Receipts carry only closed enums, models, counts, usage and latency. Your own labels appear in `answers`, where they belong, and nowhere else.

## Verification

```bash
npm run build
node --test test/decision-relay.test.mjs
```

These tests drive `runDecision()` with an injected transport and environment, run the compiled worker over a child process's stdin, and exercise the Python handler with a stubbed `aiohttp` module and a patched subprocess call. They require no credential, no aiohttp install and make no live call. Real aiohttp serving and live provider behaviour are verified outside this suite.
