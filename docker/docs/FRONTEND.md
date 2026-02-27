# SportsClaw Relay — Frontend Integration

## Base URL

```
https://<relay-host>:8080
```

## Endpoints

| Method | Path | Response | Use case |
|--------|------|----------|----------|
| `GET` | `/health` | JSON | Health check |
| `GET` | `/api/skills` | JSON | List installed skills |
| `POST` | `/api/query` | NDJSON stream | Real-time progress + result |
| `POST` | `/api/query/sync` | JSON | Simple request/response |

## Request Body (`POST /api/query` and `/api/query/sync`)

```json
{
  "prompt": "Who is top of the Premier League?",
  "user_id": "user-123",
  "stream": true
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | yes | The user's query |
| `user_id` | string | no | Enables per-user memory. Default: `api-anonymous` |
| `provider` | string | no | Override LLM provider (`anthropic`, `openai`, `google`) |
| `model` | string | no | Override model ID |
| `verbose` | boolean | no | Enable debug output |
| `timeout` | number | no | Timeout in seconds (default: 180) |

## Streaming (`POST /api/query`)

Returns `Content-Type: application/x-ndjson`. Each line is a JSON object:

```
{"type":"start","timestamp":"2026-02-27T16:06:55.917Z","user_id":"user-123"}
{"type":"phase","label":"Routing to skills","category":"progress","user_id":"user-123"}
{"type":"phase","label":"The Scoreboard · Reasoning (gemini-3-flash-preview)","category":"progress","user_id":"user-123"}
{"type":"tool_start","toolName":"football_get_standings","toolCallId":"abc123","skillName":"football","category":"progress","user_id":"user-123"}
{"type":"tool_finish","toolName":"football_get_standings","toolCallId":"abc123","durationMs":442,"success":true,"skillName":"football","category":"progress","user_id":"user-123"}
{"type":"synthesizing","category":"progress","user_id":"user-123"}
{"type":"result","text":"Liverpool is top of the Premier League...","user_id":"user-123"}
```

### Event Types

| type | When | Key fields |
|------|------|------------|
| `start` | Query begins | `timestamp` |
| `phase` | Engine stage change | `label` |
| `tool_start` | Tool call begins | `toolName`, `skillName`, `toolCallId` |
| `tool_finish` | Tool call ends | `toolName`, `durationMs`, `success` |
| `synthesizing` | LLM generating text | — |
| `result` | Final answer | `text` |
| `error` | Failure | `error` |
| `debug` | pip install / stderr | `text` |

## Frontend Example (TypeScript)

```typescript
async function queryRelay(prompt: string, onEvent: (event: any) => void) {
  const res = await fetch("/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, user_id: "web-user" }),
  });

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!; // keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      onEvent(event);
    }
  }
}

// Usage
queryRelay("Premier League standings", (event) => {
  switch (event.type) {
    case "phase":
      showSpinner(event.label);
      break;
    case "tool_start":
      showToolChip(event.toolName, "running");
      break;
    case "tool_finish":
      showToolChip(event.toolName, event.success ? "done" : "failed");
      break;
    case "result":
      hideSpinner();
      renderMarkdown(event.text);
      break;
    case "error":
      showError(event.error);
      break;
  }
});
```

## Sync Mode (`POST /api/query/sync`)

For simple integrations that don't need real-time progress:

```typescript
const res = await fetch("/api/query/sync", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "Who won the Super Bowl?" }),
});
const data = await res.json();
// { status: true, text: "The Kansas City Chiefs...", elapsed_ms: 12340 }
```

### Response

**Success (200):**
```json
{ "status": true, "text": "...", "user_id": "api-anonymous", "elapsed_ms": 12340 }
```

**Error (500):**
```json
{ "status": false, "error": "...", "elapsed_ms": 5000 }
```

**Timeout (504):**
```json
{ "status": false, "error": "Query timed out after 180s" }
```

## CORS

The relay does not set CORS headers. If your frontend is on a different origin, proxy through your backend or add CORS middleware.

## Notes

- The `text` in `result` events may contain ANSI escape codes (bold, color). Strip them for web rendering or use a library like `ansi-to-html`.
- `tool_start`/`tool_finish` events with `skillName` come from sports-skills (Python). Events without `skillName` come from MCP tools (e.g. `mcp__adidas-tracker__search_documents`).
- Ignore `debug` events in production — they're pip install output from the Python bridge cold start.
