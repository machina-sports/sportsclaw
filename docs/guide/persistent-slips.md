# Persistent slips (engine contract)

Opt-in, off by default. The engine **proposes** bet-slip changes; it never saves,
confirms or places anything. The caller (the bridge) owns identity, storage,
apply, confirmation and delivery.

## Enabling

Server environment only — never a request field:

| Variable | Required value |
| --- | --- |
| `SPORTSCLAW_SLIP_ENABLED` | `true` |
| `SPORTSCLAW_SLIP_JEV_DATA_POLICY` | `cloud_allowed` |
| `SPORTSCLAW_SLIP_NATIVE_ONLY` | unset, empty or `false` |
| `SPORTSCLAW_WATCH_INTENT_NATIVE_CONFIG` | unset |
| `TYPESAFE_API_KEY` | Jev decision credential |

A native-only route refuses cloud decisions; there is no silent fallback.

## `slip-turn-v1`

```text
SlipTurnInput  = { contract: "slip-turn-v1", requestText: string, context: SlipRevision | null }
SlipTurnResult = { contract: "slip-turn-v1", inputHash: string, decision: SlipDecisionResult | null }
```

- `requestText` is the exact original user message (1–4000 UTF-16 units, no
  unpaired surrogates), never the composed prompt, profile or history.
- `context` is the caller's stored `slip-revision-v1`, or `null`.
- The whole input is at most 65536 UTF-8 bytes; nothing is truncated.
- `inputHash` is SHA-256 hex of canonical JSON (keys sorted recursively,
  arrays and strings preserved, non-ASCII unescaped) — Python:
  `json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.
- `decision` is `null` when the turn proposed nothing, otherwise the
  `slip-decision-v1` union:
  `{ok:true, decision:{status:"selected", change, model}}`,
  `{ok:true, decision:{status:"none"|"clarify", model}}` or
  `{ok:false, reasonCode}`. A selected change is still only a proposal.

Leg `source` is `user_text`/`user_image` (quoted odds kept exactly as the user
wrote them) or `agent_suggestion` (the assistant's own pick; `quotedOdds` must
be `null`). None of these is a verified venue market or price.

## Engine

`engine.run(prompt, { slip, onSlipResult })` returns the answer string as
before and calls `onSlipResult` exactly once per successful run.

- Invalid input, a missing observer or closed gates reject before any model,
  tool or credential work. A throwing observer rejects the run.
- The request-scoped `submit_slip_change` tool is added to the normal
  generate/tool path only. An explicit tool allowlist or agent restriction that
  omits it is honored, and the result is `{ok:false, reasonCode:"disabled"}`.
- Any SDK dispatch failure in the run (malformed arguments, unknown tool,
  refused proposal) yields `invalid_response` with no Jev call. An error payload
  returned by a successfully dispatched tool does not.
- Only a clean captured proposal goes to Jev (`runSlipDecision`, pinned
  `jev-1.14.0`), with `requestText` and the context. Text or leg descriptions
  containing reserved slip identifiers (`slp_`/`slr_`/`sll_`) are refused as
  `invalid_request` before any credential read or request.

## CLI and relay

- `--history-mode caller --history-stdin` accepts
  `{history, images?, slip?}` on stdin; the slip never travels in argv or env.
  The headless result line becomes `{type:"result", text, slip}` when a slip
  was requested.
- `POST /api/query/sync` accepts `slip` only with `history_mode: "caller"` and
  `history`, validates it and the server gates before spawning, and returns
  `slip` only after verifying exactly one result whose `inputHash` matches.
  Missing, malformed, duplicate, conflicting or unrequested results fail with
  502 and no answer text. `/api/query` (stream) refuses `slip`.
- `GET /api/capabilities` reports `slip_contract: "slip-turn-v1"` only when the
  gates permit it.
- Slip requests log metadata only: no request text, context, IDs or answer.

## Limits

Proposal extraction quality depends on the answer model; offline tests use a
scripted model and fake Jev transport and say nothing about live accuracy.
