# SportsClaw Relay

HTTP bridge that exposes the SportsClaw AI engine over a simple REST API. Any client (web app, mobile, bot, script) can send natural language sports queries and receive structured, real-time responses.

```
Client (HTTP) → relay_server.py (aiohttp) → sportsclaw engine (Node.js) → LLM API
                                                    ├→ Python bridge → sports-skills (live data)
                                                    ├→ MCP client → external APIs (SSE/HTTP)
                                                    └→ Skill guides → behavioral workflows (SKILL.md)
```

Version: **v0.9.4** | Image: `machinasports/sportsclaw-relay`

---

## Endpoints

| Method | Path | Content-Type | Description |
|--------|------|-------------|-------------|
| `GET` | `/health` | `application/json` | Health check + installed tools count |
| `GET` | `/api/skills` | `application/json` | List installed sport schemas |
| `POST` | `/api/query` | `application/x-ndjson` | **Streaming** — real-time progress events |
| `POST` | `/api/query/sync` | `application/json` | **Buffered** — single JSON response |

### `GET /health`

```json
{"status": "ok", "service": "sportsclaw-relay", "skills_installed": 17}
```

`skills_installed` counts all registered tools (sports-skills + MCP + internal).

### `GET /api/skills`

```json
{"status": true, "skills": ["football", "nfl", "nba", "betting", "mcp__adidas-tracker__search_documents", ...]}
```

---

## Query Request

Both `/api/query` and `/api/query/sync` accept the same JSON body:

```json
{
  "prompt": "Who is top of the Premier League?",
  "user_id": "dashboard-user-42",
  "timeout": 180,
  "provider": "google",
  "model": "gemini-3-flash-preview",
  "verbose": false,
  "format": "markdown"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `prompt` | string | **yes** | — | Natural language query |
| `user_id` | string | no | `api-anonymous` | Enables per-user persistent memory |
| `timeout` | number | no | `180` | Max seconds before timeout |
| `provider` | string | no | env default | Override LLM provider (`anthropic`, `openai`, `google`) |
| `model` | string | no | provider default | Override model ID |
| `api_key` | string | no | env default | Override API key for the provider |
| `verbose` | boolean | no | `false` | Include debug events in output |
| `format` | string | no | — | Output format hint |

---

## Streaming Mode (`POST /api/query`)

Returns `Content-Type: application/x-ndjson` with `X-Accel-Buffering: no`. Each line is a self-contained JSON object terminated by `\n`.

```
{"type":"start","timestamp":"2026-02-27T16:06:55.917Z","user_id":"user-123"}
{"type":"phase","label":"Routing to skills","category":"progress","user_id":"user-123"}
{"type":"tool_start","toolName":"football_get_standings","toolCallId":"toolu_abc","skillName":"football","category":"progress","user_id":"user-123"}
{"type":"tool_finish","toolName":"football_get_standings","toolCallId":"toolu_abc","durationMs":442,"success":true,"skillName":"football","category":"progress","user_id":"user-123"}
{"type":"tool_start","toolName":"mcp__adidas-tracker__search_documents","toolCallId":"toolu_def","category":"progress","user_id":"user-123"}
{"type":"tool_finish","toolName":"mcp__adidas-tracker__search_documents","toolCallId":"toolu_def","durationMs":1200,"success":true,"category":"progress","user_id":"user-123"}
{"type":"synthesizing","category":"progress","user_id":"user-123"}
{"type":"result","text":"# Premier League Standings\n\nLiverpool leads...","user_id":"user-123"}
```

### Event Types

| type | Emitted when | Key fields |
|------|-------------|------------|
| `start` | Query begins | `timestamp` |
| `phase` | Engine stage changes | `label` (e.g. "Routing to skills", "The Scoreboard · Reasoning") |
| `tool_start` | Tool call begins | `toolName`, `toolCallId`, `skillName` (if sports-skill) |
| `tool_finish` | Tool call ends | `toolName`, `toolCallId`, `durationMs`, `success`, `skillName` |
| `synthesizing` | LLM generating final text | — |
| `result` | Final answer ready | `text` (markdown) |
| `error` | Failure | `error` (string), optionally `returncode` |
| `debug` | pip install or stderr | `text` (ignore in production) |

**Notes on events:**
- Events with `skillName` come from sports-skills (Python bridge). Events without `skillName` are MCP tools (prefixed `mcp__<server>__<tool>`).
- Multiple `tool_start`/`tool_finish` pairs can appear — the engine calls tools in parallel when possible.
- `phase` events track the engine's internal stages: routing, reasoning, tool execution.
- The `user_id` field is echoed back in every event for client-side correlation.

### Reading the Stream

```typescript
async function queryStream(
  url: string,
  prompt: string,
  onEvent: (event: Record<string, unknown>) => void
) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, user_id: "web-user" }),
  })

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop()!
    for (const line of lines) {
      if (!line.trim()) continue
      onEvent(JSON.parse(line))
    }
  }
}
```

---

## Sync Mode (`POST /api/query/sync`)

Waits for the full engine execution and returns a single JSON response.

**Success (200):**
```json
{"status": true, "text": "Liverpool leads the Premier League...", "user_id": "api-anonymous", "elapsed_ms": 12340}
```

**Error (500):**
```json
{"status": false, "error": "Tool call failed: connection refused", "elapsed_ms": 5000}
```

**Timeout (504):**
```json
{"status": false, "error": "Query timed out after 180s"}
```

Use sync mode for simple integrations that don't need real-time progress (scripts, Slack bots, etc.). Use streaming for any interactive UI.

---

## Response Format

The `text` field in `result` events contains **Markdown** formatted by the LLM. This typically includes:

- Headers (`#`, `##`)
- Tables (`| col | col |`)
- Bold/italic for emphasis
- Source citations at the bottom (e.g. `*Source: ESPN, Transfermarkt (2026-02-27)*`)

**ANSI escape codes**: The engine uses `marked-terminal` for CLI rendering, which may embed ANSI color codes in the text. Strip them for web rendering:

```typescript
const clean = text.replace(/\x1b\[[0-9;]*m/g, "")
```

Or use a library like `ansi-to-html` if you want to preserve formatting.

---

## Capabilities

### 1. Sports Data (sports-skills)

Live data via Python `sports-skills` package. Each sport is a separate skill with its own set of tools.

**Available skills:** `football`, `nfl`, `nba`, `nhl`, `mlb`, `wnba`, `tennis`, `cfb`, `cbb`, `golf`, `f1`, `kalshi`, `polymarket`, `news`, `betting`, `markets`

Each skill provides tools like:
- `<sport>_get_standings` — league tables
- `<sport>_get_schedule` — upcoming fixtures
- `<sport>_get_scores` — live/recent scores
- `<sport>_get_player_stats` — player statistics
- `<sport>_get_news` — sport-specific news

Skills are configured via `SPORTSCLAW_SKILLS` env var. Set to empty (`SPORTSCLAW_SKILLS=`) to disable all sports-skills (MCP-only mode).

### 2. MCP Tools (external APIs)

Connect to external MCP servers for additional tools beyond sports data. The engine connects via SSE or StreamableHTTP transport at startup, discovers tools via `listTools()`, and registers them with prefix `mcp__<server>__<tool>`.

Config via `SPORTSCLAW_MCP_SERVERS` env var (JSON):

```json
{
  "adidas-tracker": {
    "url": "https://example.com/mcp/sse",
    "tools": ["search_documents", "get_document", "execute_agent", "get_agent_execution"]
  }
}
```

- `url` — MCP server endpoint (SSE or HTTP)
- `headers` — custom headers (optional; token auto-resolved from env)
- `tools` — whitelist of tool names to register (optional; if omitted, all tools are registered)

Auth token resolution: if no auth header is set, the engine looks for `SPORTSCLAW_MCP_TOKEN_<SERVER_NAME_UPPER>` in environment. Hyphens in server name become underscores (`adidas-tracker` → `SPORTSCLAW_MCP_TOKEN_ADIDAS_TRACKER`).

### 3. Skill Guides (SKILL.md workflows)

Behavioral guides injected into the LLM's system prompt. Each guide teaches the LLM a specific workflow — which tools to call, in what order, and how to format the output.

A skill guide is a directory with:
```
skills/<skill-id>/
├── skill.yml    ← metadata (name, description)
└── SKILL.md     ← step-by-step instructions for the LLM
```

SKILL.md contains:
- **When to Use** — trigger phrases that activate the skill
- **Steps** — ordered tool call instructions with exact parameters
- **Output Format** — markdown template for the response

Guides are loaded from `SPORTSCLAW_SKILL_GUIDES_DIR` env var. The loader recursively scans for `skill.yml` + `SKILL.md` pairs. If the env var is unset or the directory doesn't exist, guides are silently skipped.

### 4. Persistent Memory

Per-user memory stored on disk (PVC-backed in K8s). Enabled when `user_id` is provided in the request.

Each user gets a memory directory containing:
- `CONTEXT.md` — current conversational state
- `FAN_PROFILE.md` — tracked teams, leagues, players, preferences
- `SOUL.md` — communication style, tone, memorable moments
- `REFLECTIONS.md` — lessons learned from past interactions
- `STRATEGY.md` — evolved behavioral rules

Memory is injected into the conversation as a `[MEMORY]` block. The LLM reads it for context and updates it via internal tools (`update_fan_profile`, `update_soul`, `reflect`, `evolve_strategy`).

Memory path configured via `SPORTSCLAW_MEMORY_DIR` (default: `/data/memory`).

### 5. Smart Routing

The engine doesn't activate all tools for every query. It uses an LLM-based router to detect which skills are relevant:

- `SPORTSCLAW_SKILLS=football,nba,betting` + query "Premier League standings" → only `football` tools activated
- Ambiguous queries activate up to `routingMaxSkills` (default: 2) skills
- MCP tools and internal tools (memory, config) are always available

### 6. Multi-Provider LLM

Supports three LLM providers via Vercel AI SDK:

| Provider | Default Model | Env var for API key |
|----------|--------------|---------------------|
| `anthropic` | `claude-sonnet-4-5-20250514` | `ANTHROPIC_API_KEY` |
| `openai` | `gpt-5.3-codex` | `OPENAI_API_KEY` |
| `google` | `gemini-3-flash-preview` | `GOOGLE_GENERATIVE_AI_API_KEY` |

Provider and model can be overridden per-request via the query body.

---

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SPORTSCLAW_SKILLS` | no | all | Comma-separated active skills. Empty = none. Unset = all. |
| `SPORTSCLAW_PROVIDER` | no | `anthropic` | LLM provider |
| `SPORTSCLAW_MODEL` | no | provider default | Model override |
| `SPORTSCLAW_MEMORY_DIR` | no | `/data/memory` | Persistent memory path |
| `SPORTSCLAW_MCP_SERVERS` | no | — | MCP server config (JSON) |
| `SPORTSCLAW_SKILL_GUIDES_DIR` | no | — | Path to skill guides directory |
| `RELAY_PORT` | no | `8080` | HTTP listen port |
| `RELAY_TIMEOUT` | no | `180` | Max query duration (seconds) |
| `PYTHON_PATH` | no | `python3` | Python interpreter path |

### API Keys (secrets)

| Variable | When needed |
|----------|-------------|
| `GOOGLE_GENERATIVE_AI_API_KEY` | provider = `google` |
| `ANTHROPIC_API_KEY` | provider = `anthropic` |
| `OPENAI_API_KEY` | provider = `openai` |
| `SPORTSCLAW_MCP_TOKEN_<SERVER>` | One per MCP server |
| `GITHUB_PAT` | Private repo for skill guides (initContainer) |

---

## Operations

### Deploy (Kustomize)

```bash
kubectl apply -k path/to/overlay/
```

### Check status

```bash
# Pod status
kubectl get pods -n <namespace> -l sportsclaw-user=<tenant>

# Logs
kubectl logs -n <namespace> -l sportsclaw-user=<tenant> -f

# Health check
kubectl exec -n <namespace> deploy/<tenant>-sportsclaw-relay -- curl -s http://localhost:8080/health
```

### Restart (re-pull image)

```bash
kubectl rollout restart deployment/<tenant>-sportsclaw-relay -n <namespace>
```

### Port-forward for local testing

```bash
kubectl port-forward -n <namespace> svc/<tenant>-sportsclaw-relay 8080:80
curl -s http://localhost:8080/health
curl -s -X POST http://localhost:8080/api/query/sync \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Premier League standings"}'
```

### Delete tenant

```bash
kubectl delete -k path/to/overlay/
```

---

## Container Modes

The entrypoint (`entrypoint.sh`) supports multiple modes via the Deployment `args`:

| Args | Mode | Description |
|------|------|-------------|
| `["relay"]` | HTTP API | aiohttp server on `RELAY_PORT` (default) |
| `["cli", "query here"]` | One-shot | Run a single query, print result, exit |
| `["listen", "discord"]` | Discord bot | Long-running Discord listener |
| `["listen", "telegram"]` | Telegram bot | Long-running Telegram listener |

Startup sequence (all modes):
1. Verify Python + sports-skills
2. Verify SportsClaw engine
3. Refresh sport schemas (`init --all`)
4. Start the selected mode

---

## CORS

The relay does not set CORS headers. If the frontend is on a different origin:
- **Recommended**: proxy through a backend (e.g. Next.js API route or Organization API resource proxy)
- **Alternative**: add CORS middleware to the relay

---

## Network Access

The Service is `ClusterIP` (cluster-internal only). Options for external access:

1. **Resource Proxy** — route through Organization API (`/api/v1/resource/<id>/proxy/<path>`) — recommended, uses existing auth
2. **Ingress** — add a K8s Ingress resource per tenant
3. **Port-forward** — for local dev/testing only

Internal DNS: `http://<tenant>-sportsclaw-relay.<namespace>.svc:80`
