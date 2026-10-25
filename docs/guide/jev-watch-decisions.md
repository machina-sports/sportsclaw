# Jev watch decisions (`watch-decision-v1`)

An opt-in, server-owned alternate contract on the existing `POST /api/watch-intent` route. It classifies a watch request and selects a public target with TypeSafe Jev typed Choice decisions instead of a generative model. The legacy `watch-intent-v1` contract is unchanged.

## Enabling

All of these are operator environment, never request input:

| Variable | Required value |
| --- | --- |
| `SPORTSCLAW_WATCH_INTENT_ENABLED` | `true` (the existing route flag) |
| `SPORTSCLAW_WATCH_JEV_ENABLED` | `true` |
| `SPORTSCLAW_WATCH_JEV_DATA_POLICY` | `cloud_allowed` |
| `TYPESAFE_API_KEY` | the existing TypeSafe credential |

Any other value returns `disabled`. A non-empty `SPORTSCLAW_WATCH_INTENT_NATIVE_CONFIG` (explicit NIM/OpenShell native-only route) also returns `disabled`: there is no Jev egress from a native-only deployment. The generic `SPORTSCLAW_DECISION_DATA_POLICY` does not grant consent here.

This consumer is pinned to `jev-1.14.0`. The generic `JevDecisionClient` default (`jev-1.13.0`) is unchanged. The endpoint, model, deadline (8s) and credential are not configurable per request.

## Wire

Intent:

```json
{"contract":"watch-decision-v1","stage":"intent","text":"Watch the Chelsea game for me","locale":"en"}
{"contract":"watch-decision-v1","ok":true,"stage":"intent","intent":"follow","model":"jev-1.14.0","confidence":0.99,"margin":0.98}
```

`intent` is one of `follow`, `pause`, `resume`, `unfollow`, `list_takes`, `list_following`, `none`, `clarify`.

Target:

```json
{"contract":"watch-decision-v1","stage":"target","text":"follow the Lakers clutch take","locale":"en",
 "candidates":[{"id":"pub_take_lakers_clutch","label":"Lakers clutch moments · NBA"}],"referenceIds":[]}
{"contract":"watch-decision-v1","ok":true,"stage":"target","selection":{"status":"selected","targetId":"pub_take_lakers_clutch"},"model":"jev-1.14.0","confidence":0.93,"margin":0.84}
```

`status` is `selected` (with a candidate ID), `no_match` or `clarify` (both with `targetId: null`).

Errors: `{"contract":"watch-decision-v1","ok":false,"reasonCode":...}` with `invalid_request`, `invalid_response`, `inference_unavailable`, `timeout`, `aborted` or `disabled`. Refusals before the body can be parsed (auth, disabled route, oversize, malformed JSON) keep the legacy `watch-intent-v1` envelope.

## Limits

Exact keys only. Text 1–4,000 characters, locale `en`/`pt`/`es`, 1–100 candidates of exactly `{id, label}` with opaque unique IDs and 1–160 character labels, at most 10 unique `referenceIds` that must be candidate IDs, 32 KiB body. Oversized input is refused, never truncated. Candidate labels are the coordinator's complete, verified public descriptions (teams, competition and, where needed, date/kickoff), not stored display labels or private profile data.

## Data sent to Jev

Only the current request text, its locale, the fixed instructions and the public candidate labels. Candidates are offered under positional option keys (`c1`…`c100`) plus `no_match` and `uncertain`, and are mapped back to the caller's public IDs locally, so a returned ID is never model-authored. Reference IDs are resolved locally to the corresponding verified public labels. Only those descriptions are marked as previously discussed in the model input; raw history and opaque reference IDs are not sent. No history, account, profile, subscription records or private IDs are accepted.

## Policy (`watch-decision-policy-3`)

- Resolve explicit teams, opponents and competition first. Then use the verified public descriptions of previously discussed candidates to resolve implicit references. A reference cannot override an explicit conflict. Remaining ambiguity still requires clarification.

- Sports-information requests, including short requests for live games, fixtures, schedules or scores, are ordinary chat (`none`). Listing games is not asking to list monitoring subscriptions. `list_takes` is reserved for requests about alert/monitoring subscription options.

- An outcome counts only when native confidence ≥ 0.80 **and** the top-two probability margin ≥ 0.15. The two gates are independent; otherwise the result is `clarify`.
- The explicit `uncertain` option is always `clarify`.
- A failure is never `none` and never falls back to another model.

The intent and target instructions come from the public synthetic probes (`jev-public-intent-smoke-v2`, `jev-public-target-smoke`). They are the initial policy, not proof of accuracy; re-evaluate against held-out EN/PT/ES and adversarial cases before changing thresholds.

## Python relay

`docker/relay/watch_intent_api.py` keeps auth before the flag, body read and concurrency slot. It validates both contracts, re-serializes the request in server-owned key order, and checks the worker's decision envelope exactly: the stage matches the request, the model is `jev-1.14.0`, confidence and margin are numbers in [0, 1], decided outcomes meet the policy gates, and a selected ID is one of the forwarded candidates.
