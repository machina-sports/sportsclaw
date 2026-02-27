/**
 * sportsclaw Engine — MCP Client Manager
 *
 * Connects to external MCP servers (e.g. Machina Core) via SSE/HTTP transport,
 * discovers their tools, and converts them to SportsClaw ToolSpec format.
 *
 * Configuration comes from:
 *   - Env var SPORTSCLAW_MCP_SERVERS (JSON)
 *   - Or a mcp.json file in the working directory
 *
 * Token resolution: if a server config has no auth header, the manager looks
 * for SPORTSCLAW_MCP_TOKEN_<SERVER_NAME_UPPER> in the environment.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolSpec, McpServerConfig } from "./types.js";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface McpConnection {
  client: Client;
  serverName: string;
}

// ---------------------------------------------------------------------------
// MCP Manager
// ---------------------------------------------------------------------------

export class McpManager {
  private configs: Record<string, McpServerConfig> = {};
  private connections = new Map<string, McpConnection>();
  private toolSpecs: ToolSpec[] = [];
  /** Maps prefixed tool name → { serverName, originalToolName } */
  private routeMap = new Map<string, { serverName: string; toolName: string }>();
  private verbose: boolean;

  constructor(verbose = false) {
    this.verbose = verbose;
    this.configs = this.loadConfigs();
  }

  /** Number of configured MCP servers */
  get serverCount(): number {
    return Object.keys(this.configs).length;
  }

  // -------------------------------------------------------------------------
  // Config loading
  // -------------------------------------------------------------------------

  private loadConfigs(): Record<string, McpServerConfig> {
    // 1. Try env var first
    const envJson = process.env.SPORTSCLAW_MCP_SERVERS;
    if (envJson) {
      try {
        const parsed = JSON.parse(envJson) as Record<string, McpServerConfig>;
        if (this.verbose) {
          console.error(
            `[sportsclaw] mcp: loaded ${Object.keys(parsed).length} server(s) from env`
          );
        }
        return this.resolveTokens(parsed);
      } catch (err) {
        console.error(
          `[sportsclaw] mcp: invalid SPORTSCLAW_MCP_SERVERS JSON: ${err instanceof Error ? err.message : err}`
        );
        return {};
      }
    }

    // 2. Try mcp.json file
    try {
      const raw = readFileSync("mcp.json", "utf-8");
      const parsed = JSON.parse(raw) as Record<string, McpServerConfig>;
      if (this.verbose) {
        console.error(
          `[sportsclaw] mcp: loaded ${Object.keys(parsed).length} server(s) from mcp.json`
        );
      }
      return this.resolveTokens(parsed);
    } catch {
      // No mcp.json — that's fine
    }

    return {};
  }

  /**
   * For each server, if no auth headers are set, look for
   * SPORTSCLAW_MCP_TOKEN_<SERVER_NAME_UPPER> in env.
   */
  private resolveTokens(
    configs: Record<string, McpServerConfig>
  ): Record<string, McpServerConfig> {
    for (const [name, config] of Object.entries(configs)) {
      const hasAuth =
        config.headers &&
        Object.keys(config.headers).some(
          (h) => h.toLowerCase() === "authorization" || h.toLowerCase() === "x-api-token"
        );

      if (!hasAuth) {
        const envKey = `SPORTSCLAW_MCP_TOKEN_${name.replace(/-/g, "_").toUpperCase()}`;
        const token = process.env[envKey];
        if (token) {
          config.headers = { ...config.headers, "X-Api-Token": token };
          if (this.verbose) {
            console.error(`[sportsclaw] mcp: resolved token for "${name}" from ${envKey}`);
          }
        }
      }
    }
    return configs;
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  /** Connect to all configured MCP servers. Non-fatal: logs and skips failures. */
  async connectAll(): Promise<void> {
    const entries = Object.entries(this.configs);
    if (entries.length === 0) return;

    const results = await Promise.allSettled(
      entries.map(([name, config]) => this.connectOne(name, config))
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const name = entries[i][0];
      if (result.status === "rejected") {
        console.error(
          `[sportsclaw] mcp: failed to connect to "${name}": ${result.reason}`
        );
      }
    }
  }

  private async connectOne(name: string, config: McpServerConfig): Promise<void> {
    const url = new URL(config.url);
    const headers = config.headers ?? {};

    // Detect transport from URL path: /sse or /mcp/sse → SSE, otherwise try HTTP first
    const isSseEndpoint = /\/sse\b/i.test(url.pathname);
    let client: Client;

    if (isSseEndpoint) {
      // Skip StreamableHTTP entirely for known SSE endpoints
      client = new Client({ name: `sportsclaw-${name}`, version: "1.0.0" });
      const sseTransport = new SSEClientTransport(url, {
        requestInit: { headers },
        eventSourceInit: {
          fetch: (input: string | URL | Request, init?: RequestInit) =>
            fetch(input, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string>) } }),
        },
      });
      await client.connect(sseTransport);
      if (this.verbose) {
        console.error(`[sportsclaw] mcp: "${name}" connected via SSE`);
      }
    } else {
      // Try StreamableHTTP with a tight timeout, fall back to SSE
      let connected = false;
      client = new Client({ name: `sportsclaw-${name}`, version: "1.0.0" });
      try {
        const transport = new StreamableHTTPClientTransport(url, {
          requestInit: { headers, signal: AbortSignal.timeout(5_000) },
        });
        await client.connect(transport);
        connected = true;
        if (this.verbose) {
          console.error(`[sportsclaw] mcp: "${name}" connected via StreamableHTTP`);
        }
      } catch {
        // Fall back to SSE — need a fresh client after failed connect
        client = new Client({ name: `sportsclaw-${name}`, version: "1.0.0" });
      }

      if (!connected) {
        const sseTransport = new SSEClientTransport(url, {
          requestInit: { headers },
          eventSourceInit: {
            fetch: (input: string | URL | Request, init?: RequestInit) =>
              fetch(input, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string>) } }),
          },
        });
        await client.connect(sseTransport);
        if (this.verbose) {
          console.error(`[sportsclaw] mcp: "${name}" connected via SSE`);
        }
      }
    }

    this.connections.set(name, { client, serverName: name });

    // Discover tools
    const { tools } = await client.listTools();
    if (this.verbose) {
      console.error(
        `[sportsclaw] mcp: "${name}" has ${tools.length} tool(s): ${tools.map((t) => t.name).join(", ")}`
      );
    }

    for (const tool of tools) {
      const prefixedName = `mcp__${name}__${tool.name}`;
      const spec: ToolSpec = {
        name: prefixedName,
        description: tool.description ?? `MCP tool: ${tool.name} (${name})`,
        input_schema: (tool.inputSchema as ToolSpec["input_schema"]) ?? {
          type: "object",
          properties: {},
        },
      };
      this.toolSpecs.push(spec);
      this.routeMap.set(prefixedName, { serverName: name, toolName: tool.name });
    }
  }

  // -------------------------------------------------------------------------
  // Tool access
  // -------------------------------------------------------------------------

  /** Get all discovered MCP tool specs (already prefixed with mcp__<server>__) */
  getToolSpecs(): ToolSpec[] {
    return [...this.toolSpecs];
  }

  /** Get the MCP route map for injection into ToolRegistry */
  getRouteMap(): Map<string, { serverName: string; toolName: string }> {
    return new Map(this.routeMap);
  }

  /** Call an MCP tool by its prefixed name */
  async callTool(
    prefixedName: string,
    args: Record<string, unknown>
  ): Promise<{ content: string; isError: boolean }> {
    const route = this.routeMap.get(prefixedName);
    if (!route) {
      return {
        content: JSON.stringify({ error: `Unknown MCP tool: ${prefixedName}` }),
        isError: true,
      };
    }

    const connection = this.connections.get(route.serverName);
    if (!connection) {
      return {
        content: JSON.stringify({
          error: `MCP server "${route.serverName}" is not connected`,
        }),
        isError: true,
      };
    }

    try {
      const result = await connection.client.callTool({
        name: route.toolName,
        arguments: args,
      });

      // MCP tool results are an array of content blocks
      const contentBlocks = result.content as Array<{
        type: string;
        text?: string;
      }>;
      const text = contentBlocks
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("\n");

      return {
        content: text || JSON.stringify(result.content),
        isError: result.isError === true,
      };
    } catch (err) {
      return {
        content: JSON.stringify({
          error: `MCP tool call failed: ${err instanceof Error ? err.message : String(err)}`,
        }),
        isError: true,
      };
    }
  }

  /** Disconnect all MCP clients */
  async disconnectAll(): Promise<void> {
    for (const [name, conn] of this.connections) {
      try {
        await conn.client.close();
        if (this.verbose) {
          console.error(`[sportsclaw] mcp: disconnected "${name}"`);
        }
      } catch {
        // best-effort
      }
    }
    this.connections.clear();
  }
}
