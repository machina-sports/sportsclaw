# Internal-only MCP servers

Hosted deployments often connect a project's private Machina Pod so the engine
can store per-user memory in Pod documents. That Pod's raw MCP tools
(`create_document`, `execute_agent`, …) should not be callable by the model.
Mark the server `internalOnly` in its MCP config:

```json
{
  "project-pod": {
    "url": "https://pod.example.com/mcp/sse",
    "internalOnly": true
  },
  "worldcup": {
    "url": "https://worldcup.example.com/mcp/sse"
  }
}
```

## What changes for an internal-only server

The engine still connects, discovers tools and Pod capabilities, and keeps full
internal routes, so:

- `getMachinaServerName()` still selects it, and `PodMemoryStorage` and the
  decision ledger keep working through the trusted in-process
  `McpManager.callToolDirect`.

Nothing about it reaches the model:

- Its tools are left out of `getToolSpecs()` / `getRouteMap()`, so
  `ToolRegistry` never injects them.
- Its `description` and Pod inventory (workflows, agents, connectors) are
  hidden from `getServerDescriptions()` / `getPodCapabilities()`.
- It is never returned by `getMachinaLoopServer()`, so `machina_loop` cannot
  drive it.
- `McpManager.callTool` (model-facing dispatch) refuses any of its prefixed tool
  names as `Unknown MCP tool` before calling the SDK. Tool arguments
  (`_context`, server/tool fields, flags) cannot change this.
- The tool-discovery cache includes the policy in its identity, and the policy is
  re-applied on every getter and dispatch, so a cached inventory can't
  bring the tools back.

Other servers are unaffected and their cache identity is unchanged.

## Policy values (fail closed)

| `internalOnly`            | Result        |
|---------------------------|---------------|
| absent                    | public        |
| `false`                   | public        |
| `true`                    | internal-only |
| anything else (`"false"`, `0`, `null`, `"yes"`, `{}`, …) | internal-only |

## Limits

This is a model-facing tool boundary only. It is not OS sandboxing or general
agent authorization: shell/file approval controls, auth, and memory/history
scoping are unchanged. `summarizeMcpServers()` (used by `get_agent_config`)
still lists the server's name, URL and whether a token is set.
