# Hosted-history relay overlay (0.29.4 baseline)

This is a narrow hosted backport, not an upgrade to development main. Build an immutable overlay on the verified production digest and replace only the compiled files from the changed engine/CLI/prompt/type sources, the new caller-history module, and `relay_server.py`. Preserve the inherited SDK, Novig error guard, ProphetX catalog, dependencies, entrypoint and all unrelated runtime modules.

## Authentication

`GET /api/capabilities`, `POST /api/query` and `POST /api/query/sync` require `X-Auth-Token`, compared with server-held `AGENTS_API_TOKEN` using constant-time comparison. Missing server configuration returns 503; a missing/wrong header returns 401. The token is removed from the engine subprocess environment. Health and skill catalog remain available without this credential.

Use a dedicated Kubernetes Secret shared only with the bridge and relay. Do not put the token in source, images, arguments, logs or reports. Existing provider and channel credentials are unchanged.

## Caller-owned conversation

The bridge owns history. A synchronous body contains the unchanged latest `prompt`, `user_id`, `session_id`, `history_mode: "caller"`, and `history: [{role, content}]`. The bridge derives both IDs from a server-held namespace plus platform, user, chat and topic. The relay does not infer chat identity from user ID or read cross-chat history.

- Prompt: at most 20,000 characters.
- Session: opaque printable nonempty string, at most 128 characters; no leading dash or surrounding whitespace.
- History: at most 40 nonempty user/assistant text entries and 12,000 aggregate Unicode code points. Extra entry fields and elevated roles are rejected.
- Timeout: integer from 1 through the advertised `query.max_timeout_seconds` (default maximum 300). The client must use the actual advertised limit.
- Transport: history and optional images use subprocess stdin JSON; the current prompt stays unchanged and separate. CLI receives `--history-mode caller`, `--history-stdin` and `--session-id` independently of `--user`.

History is validated at relay, CLI and engine boundaries, restored as native turns before routing and never elevated into the answer system prompt. Caller mode clears prior in-process turns and skips engine transcript/session reads and writes, while retaining scoped durable memory. Ordinary engine-mode behavior remains unchanged. The main model handles needed clarification; canned menus do not terminate the request.

A successful synchronous caller-history response includes `history_contract: "structured-v1"` and the exact requested `session_id`. The bridge must check both on every answer: a capability request may reach a different replica. The capability response advertises `history_modes`, `structured_history`, `session_id` and `query.max_timeout_seconds`. Structured caller history is explicitly rejected on the streaming endpoint rather than silently discarded.

## Verification and rollout

Run the baseline TypeScript build, all `test/*.test.mjs` tests and `python -m unittest discover -s docker/relay -p test_hosted_history.py`. Fixtures must use an isolated HOME without provider secrets. The hosted regression files adapt to the baseline's existing session and CLI interfaces; they do not import later main-only helpers. Python annotations are postponed to preserve the baseline test driver's supported Python environment.

Use an isolated relay canary and the exact frozen bridge image. Verify authenticated history across fresh bridge/store instances against real Pod storage and a real model, plus scope isolation and refusal cases. Synthetic transport tests are not evidence of live model or channel delivery. Preserve the old relay until all production bridge replicas use compatible authenticated history. Promote only immutable digests. Keep rollback image references and configuration, then remove only the release's own canary resources and fixture documents.
