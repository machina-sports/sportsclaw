# Relay integration contract

Queries (`POST /api/query`, `POST /api/query/sync`) and `GET /api/capabilities`
require `X-Auth-Token` matching `AGENTS_API_TOKEN`, including automatic agent
selection. Missing server configuration returns 503; missing/invalid caller
credentials return 401. Health remains public. Configure caller credentials
before upgrading an older deployment that accepted anonymous queries.

`history_mode` accepts `engine` (default) or `caller`. Caller mode means the
caller supplies the transcript with its prompt. The engine does not restore or
append its thread/session transcript or daily conversation log, and starts each
run with a fresh conversation. Durable context, editorial strategy, profile,
reflections and consolidated knowledge remain available. `user_id` still scopes
that durable memory. The CLI equivalent is `--history-mode caller`.

Queries accept a nonempty prompt of at most 20,000 characters. `timeout` must be
an integer from 1 through `RELAY_MAX_QUERY_TIMEOUT` (default 300 seconds).
`RELAY_TIMEOUT` defaults to 180 seconds. `RELAY_MAX_QUERY_CONCURRENCY` defaults
to 4; excess requests return 429 immediately without launching a child. Limits
are per relay instance, not distributed quotas. Responses are bounded to 32 MiB;
stderr is concurrently drained with only 64 KiB retained internally. Cancellation
or timeout kills the isolated subprocess group and reaps its leader. Remote work
already accepted by another service is not undone by local process termination.

`GET /api/capabilities` reports protocol version `1.0`, package engine version,
build revision, installed skill names, configured per-server MCP allowlists,
supported history modes, and query limits. A null `allowed_tools` with policy
`all_discovered` denotes unrestricted discovery, not an empty tool list. This is
configured policy, not a claim that every downstream server is healthy. Discovery
failure returns 503. Tokens, headers, URLs and other credentials are excluded.
Container builds should set `SPORTSCLAW_BUILD_REVISION`; release CI supplies its
commit automatically.
