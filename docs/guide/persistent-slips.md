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

A `slip-change-v1` is a delta against `context`, not the slip after the edit.
`legs` holds only new legs (`create`/`append`) or exactly one replacement
(`replace`), and is `[]` for `remove`, `review` and `clarify`; `targetLegIds`
names the existing legs affected (for `remove`, the legs to drop, never the
ones to keep).

## Engine

`engine.run(prompt, { slip, onSlipResult })` returns the answer string as
before and calls `onSlipResult` exactly once per successful run.

- Invalid input, a missing observer or closed gates reject before any model,
  tool or credential work. A throwing observer rejects the run.
- Ordinary answering and research run unchanged. No slip tool is offered to the
  answer model, in the normal path or in parallel agent lanes.
- After the final answer and its evidence checks, and before history, session
  and memory persistence and token accounting, the engine makes **one bounded
  extraction call** (`extractSlipProposal`, receipt purpose `slip_extraction`)
  on the same resolved model, sampling and provider options: native structured
  output (`Output.object`), no tools or tool choice, no retry, repair,
  continuation or fallback. Provider options are copied and restricted for this
  pass only (the caller's map is not mutated): provider-side MCP servers or a
  container in any namespace are refused as `invalid_request` before dispatch;
  Anthropic is pinned to native `output_format` (`structuredOutputMode:
  "outputFormat"`, never the adapter's synthetic json tool) with extended
  thinking disabled, and any namespace carrying those Anthropic settings gets
  the same values, so a custom provider alias cannot override them. A model or
  endpoint that rejects native output fails once as `inference_unavailable`,
  with no fallback. Other namespaces (e.g. Google `thinkingConfig`) pass
  through unchanged. It sees only `requestText`, `context`, the current
  request images and the final answer, as data; the answer contributes only
  `agent_suggestion` legs with `quotedOdds: null`.
- The reply is one envelope `{status:"none"|"proposal", change}`. `none` (with
  `change: null`) gives `decision: null` and keeps the answer. A `proposal`
  must pass the strict change parser and the action/base/target checks against
  `context`; a model `confirm` is refused. Fixed literals and string enums in the
  native schema are typed (`{type:"string", enum:[...]}`); an untyped `const`
  was ignored by a native provider. This is schema representation only — the
  output is never coerced or repaired.
- Malformed, truncated (`length`), refused/filtered or off-contract output,
  provider errors, the deadline and caller aborts become
  `{ok:false, reasonCode}` (`invalid_response`, `inference_unavailable`,
  `timeout`, `aborted`, `invalid_request`) — never `none` — with no Jev call.
- Only a valid proposal goes to Jev (`runSlipDecision`, pinned `jev-1.14.0`),
  with `requestText` and the context. Text or leg descriptions containing
  reserved slip identifiers (`slp_`/`slr_`/`sll_`) are refused as
  `invalid_request` before any credential read or request.
- On a denied, failed or clarifying outcome, the answer is replaced by a fixed
  safe message, and all of the turn's assistant text (including earlier steps)
  is removed before storage, keeping tool calls and results; prior turns are
  unchanged. This follows the typed outcome, even when the answer already
  equals the safe message. The returned text and the stored final assistant
  message are the same.
- An explicit tool allowlist that omits `submit_slip_change` still denies the
  slip capability (no extraction, `{ok:false, reasonCode:"disabled"}`); naming
  it permits extraction without offering any tool. A routing refusal ends the
  turn with no extraction.
- Extraction usage is added once to the run's usage, pass usage, daily token
  ledger and query analytics, including when its output fails to parse.

### Extraction bounds

Initial ceilings, not accuracy or performance claims. Out-of-bound input is
refused as `invalid_request` before the model call, never truncated.

| Bound | Value |
| --- | --- |
| Deadline | 20 s (combined with the caller's abort) |
| Output tokens | 8192 requested (`maxOutputTokens`); with Anthropic thinking disabled, also the wire `max_tokens` |
| Retries | 0 |
| Text | UTF-8 bytes of the turn JSON + the answer ≤ 65536 |
| Images | ≤ 4; PNG/JPEG/WebP/GIF; non-empty strict base64; ≤ 10 MiB each, ≤ 20 MiB total decoded |

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

Proposal extraction quality depends on the primary model; offline tests use a
scripted model and fake Jev transport and say nothing about live accuracy.
