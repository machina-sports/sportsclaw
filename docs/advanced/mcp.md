# Connecting MCP Servers

sportsclaw can pull in tools from external [Model Context Protocol](https://modelcontextprotocol.io)
servers, so your agent can reach workflows and services beyond sports data.

## Add a server

```bash
sportsclaw mcp add <url> --name <name> --token <token>   # connect an MCP server
sportsclaw mcp list                                      # see connected servers
sportsclaw mcp remove <name>                             # disconnect one
```

`mcp add` accepts:

- `--name <name>` — a short name for the server (auto-derived from the URL if omitted).
- `--token <token>` — a bearer token, if the server needs auth.
- `--description <text>` and `--timeout <ms>` — optional metadata and per-call timeout.

Once connected, **every** tool that server exposes becomes available to the agent,
alongside the built-in sports tools. There is no read/write classification: if the server
offers `delete_document` or `execute_workflow`, the agent can call them.

### Restricting a server to specific tools

Set `tools` on the server entry to register only the ones you name. Anything the server
advertises that is not on the list is never given to the model:

`~/.sportsclaw/mcp.json` — the server name is the top-level key:

```json
{
  "my-pod": {
    "url": "https://my-pod.org.machina.gg/mcp/sse",
    "tools": ["search_documents", "get_document", "health_check"]
  }
}
```

`SPORTSCLAW_MCP_SERVERS` takes the same object as a JSON string, so the relay is configured
the same way. Run with `--verbose` to confirm what registered — the log reads
`mcp: "my-pod" has 3 tool(s) (filtered from 41)`.

::: warning Prompt rules are not enforcement
Telling the agent in its instructions not to call a write tool is not a control: the tool is
still registered and the model can still call it. `tools` is the enforcement point.

The approval gate does not help here either. It is declarative — it fires when a tool spec
defines `needsApproval` — and MCP tool specs are built from the server's advertised schema
with no such field, so an MCP write runs without a confirmation prompt. The gate is also
interactive-only: outside a TTY it fails closed, which is not what you want for a relay.

If a server exposes writes you do want, one workable shape is to allowlist only its read tools
and have your own application perform the writes after a user confirms them — the agent
proposes, your app executes.
:::

::: tip Pod memory needs write tools
`SPORTSCLAW_MEMORY_PROVIDER=pod` stores memory through the pod's own `create_document` and
`update_document`. A read-only allowlist denies those: leave the provider at `auto` (it falls
back to file memory) rather than `pod`, or the run throws.
:::

### Where tokens live

Tokens are kept out of the config file. `mcp add --token …` writes the value to
`~/.sportsclaw/.env` as `SPORTSCLAW_MCP_TOKEN_<NAME>` (the name uppercased, hyphens to
underscores), while `~/.sportsclaw/mcp.json` holds only the URL and metadata. At connect time
the engine injects the token as an `X-Api-Token` header. You can also set the env var yourself
instead of passing `--token`.

## What you can connect

Any MCP server — including Machina "pods," which surface workflows, agents, and connectors
the agent can call as part of answering a question.

::: tip Connecting a Machina pod? Use `machina connect`
For Machina pods, prefer **[`sportsclaw machina connect`](../sports-data/machina#connecting-machina-to-sportsclaw)** —
it signs you in, mints a durable key, and registers the pod automatically (no URL to copy).
Pods it registers are tagged `provider: "machina"`, which is how `doctor` and the agent's
`get_agent_config` recognize them. Use `mcp add` for arbitrary, non-Machina MCP servers.
:::

::: tip sportsclaw connects *to* MCP servers
sportsclaw is an MCP **client**: it consumes tools from other servers. It does not run as an
MCP server itself.
:::
