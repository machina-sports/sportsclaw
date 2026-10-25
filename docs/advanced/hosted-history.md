# Hosted caller history

The relay advertises `history_modes: ["engine", "caller"]`. In caller mode the hosted bridge owns the conversation and sends it with every synchronous query. This page describes that contract as shipped in the hosted relay.

## Request

`POST /api/query/sync` with `X-Auth-Token` (compared with the server-held `AGENTS_API_TOKEN`; 503 when unset, 401 when missing or wrong):

```json
{
  "prompt": "Check on Polymarket Kalshi novig and prophetx",
  "user_id": "scope-hash",
  "session_id": "scope-hash",
  "history_mode": "caller",
  "history": [
    {"role": "user", "content": "Compare NBA on ProphetX and Novig"},
    {"role": "assistant", "content": "NBA on ProphetX vs Novig: ..."}
  ]
}
```

- `prompt`: the unchanged latest message, 1-20,000 characters.
- `session_id`: opaque, 1-128 printable characters, no surrounding whitespace, no leading dash. Independent of `user_id`.
- `history`: at most 40 entries of exactly `{role: "user" | "assistant", content: nonempty string}`, at most 12,000 Unicode code points in total. Other roles, other keys and content parts are rejected. `history` requires `history_mode: "caller"`.
- `timeout`: integer from 1 through `query.max_timeout_seconds`.

Invalid requests are rejected with 400 before any subprocess starts. `POST /api/query` (streaming) rejects `history` with 400 instead of silently dropping it, because a stream carries no per-response acknowledgement.

## Response acknowledgement

A successful caller-history response carries `"history_contract": "structured-v1"` and the exact requested `session_id` (or `null`). The bridge must check both on every answer: a capabilities request may reach a different replica. Failures carry no acknowledgement. Requests without `history` get the same response shape as before.

`GET /api/capabilities` adds `history_contract`, `structured_history: true`, `session_id: true` and `query.max_history_entries`, `query.max_history_characters`, `query.max_session_id_characters` to the existing fields.

## Transport to the engine

The relay passes `--session-id`, `--history-mode caller` and `--history-stdin` to the CLI and writes `{"history": [...], "images"?: [...]}` to the child's stdin. History never travels in argv, the environment or logs; when history is present, images ride on stdin instead of `SPORTSCLAW_INBOUND_IMAGES`. The relay token is removed from the child environment.

The CLI reads stdin to EOF before parsing, so large payloads delivered in fragments are parsed whole; truncated JSON is rejected. Stdin is read only with `--history-stdin` in caller mode; `--history-stdin` without caller mode fails without touching stdin.

## Engine behavior

`engine.run(prompt, { historyMode: "caller", history, sessionId, userId })`:

- Validates `history` with the same rules (`src/caller-history.ts`) before any model call; `history` outside caller mode is an error.
- Clears in-process turns and skips the engine thread, session store and daily conversation log (reads and writes). Durable user memory still loads.
- Restores history as native user/assistant turns, sanitized like the prompt, before follow-up classification and routing. It is never copied into the system prompt. A trailing copy of the current message is dropped so the current turn is sent once.
- Separate chats share nothing: each caller-mode run starts from only what the caller sends.

Requests without caller history behave as before. The answer model handles any needed clarification; the engine no longer returns canned clarification menus.
