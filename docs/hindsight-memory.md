# Hindsight memory backend

SportsClaw's persistent memory (`SOUL.md`, `FAN_PROFILE.md`, `CONTEXT.md`,
`REFLECTIONS.md`, `STRATEGY.md`, daily conversation logs, and the thread) sits
behind a single `MemoryStorage` driver interface (`src/memory.ts`). Three
drivers exist:

| Provider    | Where memory lives                                   | Best for |
|-------------|------------------------------------------------------|----------|
| `file`      | local `~/.sportsclaw/memory/<userId>/` (default)     | the open-source CLI, single-user hacking |
| `pod`       | Machina MCP pod documents                            | multi-tenant relay deployments |
| `hindsight` | a [Vectorize Hindsight](https://github.com/vectorize-io/hindsight) server | semantic, long-horizon agent memory that learns over time |

A single run uses **exactly one** driver — they are mutually exclusive at the
class level. At the system level they complement each other: you can keep
structured config/state in `pod` mode for one deployment while routing heavy
conversational text and reflections into `hindsight` for another.

## What Hindsight is

[Hindsight](https://hindsight.vectorize.io) is a standalone agent-memory server
with a `retain` / `recall` / `reflect` HTTP API. On `retain` it extracts facts,
entities, temporal data, and relationships; `recall` runs semantic + keyword +
graph + temporal retrieval fused with reciprocal-rank fusion; `reflect`
synthesizes new observations from existing memories. It runs against OpenAI,
Anthropic, Gemini, Groq, **Ollama**, or **LM Studio** backends.

### How SportsClaw maps onto it

- **One bank per user/agent scope** — `bank_id` combines
  `HINDSIGHT_BANK_PREFIX` with a SHA-256 digest of both IDs. This preserves native
  agent isolation and avoids collisions for arbitrary IDs.
- **One document per file** — each logical memory file maps to a single
  memory addressed by a stable `document_id`, tagged with its source surface
  (`surface:soul`, `surface:strategy`, `surface:daily`, …) and cryptographic scope,
  with `metadata: { userId, agentId?, threadId?, surface, file }`.
- **`retain_extraction_mode: verbatim`** — the per-scope bank is created in
  verbatim mode so its semantic facts preserve the source wording.
- `read` → exact document lookup and its `original_text`; `write` → `retain` with
  `update_mode:"replace"` (upsert); `append` → `retain` with
  `update_mode:"append"`. Hindsight serializes append operations per document,
  so concurrent clients and processes cannot overwrite each other's entries.
- Thread turns are appended as JSON-array fragments. Hindsight merges those
  arrays atomically; reads still expose the same capped `ThreadMessage[]` used by
  the file and pod backends, so existing formats remain compatible.
- Each engine run also performs semantic recall for the sanitized user prompt.
  Recall is capped at 2,048 response tokens, eight results, and 8,000 characters,
  then injected in a user-role block explicitly marked as possibly stale or
  incorrect. It never replaces exact reads and never gains system-prompt
  authority. Explicit native-agent runs recall only from that agent's bank.

Hindsight performs its own long-horizon consolidation, so SportsClaw's
file-style `consolidateOldLogs` is intentionally inert under this backend (the
same as it already is for the `pod` backend).

If Hindsight is unreachable, the engine skips memory loading and drops writes
without failing the turn. A failed exact read remains distinguishable from a
missing document, and replacement/deletion is blocked for that storage instance
after an indeterminate read so transient failures cannot erase structured data.
Append-only writes remain safe because they do not depend on a prior read.
Semantic recall failure is isolated from exact-file loading.

`SOUL.md`'s legacy `Exchanges:` counter is not an authoritative turn counter and
is not guaranteed atomic across processes. Hindsight's cross-process guarantee
applies to append-only logs and thread persistence, not arbitrary read/replace
updates.

## Selecting the provider

```bash
# canonical selector
export SPORTSCLAW_MEMORY_PROVIDER=hindsight   # file | pod | hindsight
```

The legacy `SPORTSCLAW_MEMORY_BACKEND` (`auto | file | pod`) is still honored as
a fallback when `SPORTSCLAW_MEMORY_PROVIDER` is unset, so existing deployments
are unaffected. Hindsight must be selected through the canonical variable. With
neither set, the existing `auto` behavior remains: pod if a Machina server is
connected, otherwise file. A normal local CLI therefore continues to use files.

## Configuration

All Hindsight knobs are optional and have sensible defaults:

| Env var | Default | Notes |
|---|---|---|
| `HINDSIGHT_BASE_URL` | `http://localhost:8888` | Hindsight API base URL |
| `HINDSIGHT_API_KEY` | _(none)_ | Bearer token; omit for local instances |
| `HINDSIGHT_BANK_PREFIX` | `sportsclaw` | safe prefix followed by a SHA-256 scope digest |
| `HINDSIGHT_RETAIN_EXTRACTION_MODE` | `verbatim` | Hindsight fact-extraction mode |
| `HINDSIGHT_RECALL_BUDGET` | `mid` | `low` \| `mid` \| `high` |
| `HINDSIGHT_RECALL_MAX_TOKENS` | `32768` | default manual recall/reflect limit; engine recall is capped at 2,048 |
| `HINDSIGHT_REQUEST_TIMEOUT_MS` | `30000` | per-request timeout |

## Deployment recipes

### Standard / cloud

Run Hindsight anywhere reachable over HTTP and point SportsClaw at it:

```bash
docker run -it --pull always --name hindsight --restart unless-stopped \
  -p 8888:8888 -p 9999:9999 \
  -e HINDSIGHT_API_LLM_API_KEY=$OPENAI_API_KEY \
  -v hindsight-data:/home/hindsight/.pg0 \
  ghcr.io/vectorize-io/hindsight:latest

export SPORTSCLAW_MEMORY_PROVIDER=hindsight
export HINDSIGHT_BASE_URL=http://localhost:8888
sportsclaw chat
```

### Local, no keys (Ollama)

Hindsight can run entirely on a local model — no accounts, no API keys, no data
leaving the machine:

```bash
export HINDSIGHT_API_LLM_PROVIDER=ollama
export HINDSIGHT_API_LLM_MODEL=gpt-oss:20b
export HINDSIGHT_API_LLM_BASE_URL=http://localhost:11434/v1   # your Ollama endpoint
# then start hindsight-api, and on the SportsClaw side:
export SPORTSCLAW_MEMORY_PROVIDER=hindsight
```

`HINDSIGHT_API_*` variables configure the Hindsight **server's** LLM/embeddings.
The listed `HINDSIGHT_*` variables configure the **SportsClaw client**. SportsClaw
uses Hindsight's current `/v1/default/...` API; custom namespaces are not exposed
by the current client contract.

### Sandboxed (NVIDIA OpenShell + local NIMs)

For fully offline, policy-enforced deployments, run Hindsight as a sidecar
**inside** an [OpenShell](https://github.com/NVIDIA/OpenShell) sandbox and route
its LLM calls at the sandbox's Privacy Router (`https://inference.local`) backed
by local NIMs — no traffic leaves the sandbox:

```bash
# Inside the sandbox, configure Hindsight to use the Privacy Router (OpenAI-compatible):
export HINDSIGHT_API_LLM_PROVIDER=openai
export HINDSIGHT_API_LLM_BASE_URL=https://inference.local/v1
export HINDSIGHT_API_LLM_API_KEY=unused        # Privacy Router injects backend creds

# SportsClaw talks to the co-located Hindsight over loopback:
export SPORTSCLAW_MEMORY_PROVIDER=hindsight
export HINDSIGHT_BASE_URL=http://localhost:8888
```

Because the SportsClaw client only needs `HINDSIGHT_BASE_URL` (+ optional
`HINDSIGHT_API_KEY`), no code changes are required to move between local, cloud,
and sandboxed Hindsight instances — it is purely configuration. See
[NVIDIA OpenShell deployment guide](/deployment/openshell) for the runbook.

## Verifying

```bash
# unit tests (fake in-memory Hindsight server — no live instance needed)
npm run test:hindsight-memory

# against a live instance: confirm the selection log, then check a recall round-trip
SPORTSCLAW_MEMORY_PROVIDER=hindsight sportsclaw --user smoke-test "remember that I support Grêmio"
# stderr → [sportsclaw] memory_backend requested=hindsight selected=hindsight base_url=...
SPORTSCLAW_MEMORY_PROVIDER=hindsight sportsclaw --user smoke-test "which club do I support?"
```
