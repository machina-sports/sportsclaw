# Connecting MCP Servers

sportsclaw can pull in tools from external [Model Context Protocol](https://modelcontextprotocol.io)
servers, so your agent can reach workflows and services beyond sports data.

## Add a server

```bash
sportsclaw mcp add <url>     # connect an MCP server
sportsclaw mcp list          # see connected servers
sportsclaw mcp remove <name> # disconnect one
```

Once connected, the tools that server exposes become available to the agent automatically,
alongside the built-in sports tools.

## What you can connect

Any MCP server — including Machina Core "pods," which surface workflows, agents, and connectors
the agent can call as part of answering a question.

::: tip sportsclaw connects *to* MCP servers
sportsclaw is an MCP **client**: it consumes tools from other servers. It does not run as an
MCP server itself.
:::
