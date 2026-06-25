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

Once connected, the tools that server exposes become available to the agent automatically,
alongside the built-in sports tools.

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
