/**
 * sportsclaw Engine — MCP Client Manager
 *
 * Connects to external MCP servers (e.g. Machina Core) via SSE/HTTP transport,
 * discovers their tools, and converts them to sportsclaw ToolSpec format.
 *
 * Configuration comes from (highest priority first):
 *   - Env var SPORTSCLAW_MCP_SERVERS (JSON)
 *   - mcp.json in the working directory
 *   - ~/.sportsclaw/mcp.json (managed by `sportsclaw mcp add`)
 *
 * Token resolution: if a server config has no auth header, the manager looks
 * for SPORTSCLAW_MCP_TOKEN_<SERVER_NAME_UPPER> in the environment.
 *
 * Resilience features:
 *   - Per-server call timeout (configurable, default 30s)
 *   - Circuit breaker (3 consecutive failures → fast-fail for 60s)
 *   - Error classification with LLM-actionable hints
 *   - Connection retry with 2s backoff on initial connect
 *   - User context propagation via X-SportsClaw-User header
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolSpec, McpServerConfig } from "./types.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Persistent MCP config at ~/.sportsclaw/mcp.json
// ---------------------------------------------------------------------------

const MCP_CONFIG_DIR = join(homedir(), ".sportsclaw");
const MCP_CONFIG_PATH = join(MCP_CONFIG_DIR, "mcp.json");

/** Load the user-managed MCP config from ~/.sportsclaw/mcp.json */
export function loadMcpConfigs(): Record<string, McpServerConfig> {
  if (!existsSync(MCP_CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(MCP_CONFIG_PATH, "utf-8")) as Record<string, McpServerConfig>;
  } catch {
    return {};
  }
}

/** Save MCP server configs to ~/.sportsclaw/mcp.json */
export function saveMcpConfigs(configs: Record<string, McpServerConfig>): void {
  if (!existsSync(MCP_CONFIG_DIR)) {
    mkdirSync(MCP_CONFIG_DIR, { recursive: true });
  }
  writeFileSync(MCP_CONFIG_PATH, JSON.stringify(configs, null, 2) + "\n", "utf-8");
  clearToolCache(); // Invalidate cache on config change
}

/** Remove an MCP server from ~/.sportsclaw/mcp.json. Returns true if found. */
export function removeMcpConfig(name: string): boolean {
  const configs = loadMcpConfigs();
  if (!(name in configs)) return false;
  delete configs[name];
  saveMcpConfigs(configs);
  return true;
}

/** Get the path to the MCP config file */
export function getMcpConfigPath(): string {
  return MCP_CONFIG_PATH;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface McpConnection {
  client: Client;
  serverName: string;
  /** Circuit breaker: consecutive failure count */
  failures: number;
  /** Circuit breaker: timestamp of last failure (ms since epoch) */
  lastFailureAt: number;
}

export interface PodCapabilities {
  workflows: Array<{ name: string; description?: string }>;
  agents: Array<{ name: string; description?: string }>;
  connectors: Array<{ name: string; description?: string }>;
  discoveredAt: number;
}

interface ToolCacheEntry {
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  capabilities?: PodCapabilities;
  cachedAt: number;
  configHash: string;
}

export type McpErrorCode =
  | "timeout"
  | "auth_failed"
  | "rate_limited"
  | "server_error"
  | "connection_failed"
  | "not_found"
  | "circuit_open"
  | "unknown";

// ---------------------------------------------------------------------------
// MCP Manager
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tool Discovery Cache
// ---------------------------------------------------------------------------

const TOOL_CACHE_DIR = join(MCP_CONFIG_DIR, "mcp-cache");
const TOOL_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function configHash(config: McpServerConfig): string {
  // Simple hash: JSON of url + tools whitelist. Changes when config changes.
  return Buffer.from(JSON.stringify({ url: config.url, tools: config.tools ?? [] })).toString("base64url");
}

/** Clear the MCP tool discovery cache. Called on config change or --refresh-mcp. */
export function clearToolCache(): void {
  try {
    if (!existsSync(TOOL_CACHE_DIR)) return;
    for (const file of readdirSync(TOOL_CACHE_DIR)) {
      if (file.endsWith(".json")) {
        unlinkSync(join(TOOL_CACHE_DIR, file));
      }
    }
  } catch {
    // Best-effort
  }
}

export class McpManager {
  private static readonly DEFAULT_CALL_TIMEOUT_MS = 30_000;
  private static readonly CIRCUIT_BREAKER_THRESHOLD = 3;
  private static readonly CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;
  private static readonly CONNECT_RETRY_DELAY_MS = 2_000;

  private configs: Record<string, McpServerConfig> = {};
  private connections = new Map<string, McpConnection>();
  private toolSpecs: ToolSpec[] = [];
  /** Maps prefixed tool name → { serverName, originalToolName } */
  private routeMap = new Map<string, { serverName: string; toolName: string }>();
  private podCaps = new Map<string, PodCapabilities>();
  private verbose: boolean;
  private userId?: string;
  private forceRefresh: boolean;

  constructor(verbose = false, forceRefresh = false) {
    this.verbose = verbose;
    this.forceRefresh = forceRefresh;
    this.configs = this.loadConfigs();
  }

  /** Number of configured MCP servers */
  get serverCount(): number {
    return Object.keys(this.configs).length;
  }

  /** Set the user ID for MCP request context propagation */
  setUserId(id: string | undefined): void {
    this.userId = id;
  }

  // -------------------------------------------------------------------------
  // Config loading
  // -------------------------------------------------------------------------

  private loadConfigs(): Record<string, McpServerConfig> {
    // Start with persistent user config (~/.sportsclaw/mcp.json)
    const base = loadMcpConfigs();

    // Layer on working-directory mcp.json (overrides user config per-server)
    try {
      const raw = readFileSync("mcp.json", "utf-8");
      const local = JSON.parse(raw) as Record<string, McpServerConfig>;
      Object.assign(base, local);
      if (this.verbose) {
        console.error(
          `[sportsclaw] mcp: loaded ${Object.keys(local).length} server(s) from ./mcp.json`
        );
      }
    } catch {
      // No local mcp.json — that's fine
    }

    // Env var wins over everything (full override)
    const envJson = process.env.SPORTSCLAW_MCP_SERVERS;
    if (envJson) {
      try {
        const envConfigs = JSON.parse(envJson) as Record<string, McpServerConfig>;
        Object.assign(base, envConfigs);
        if (this.verbose) {
          console.error(
            `[sportsclaw] mcp: loaded ${Object.keys(envConfigs).length} server(s) from env`
          );
        }
      } catch (err) {
        console.error(
          `[sportsclaw] mcp: invalid SPORTSCLAW_MCP_SERVERS JSON: ${err instanceof Error ? err.message : err}`
        );
      }
    }

    if (Object.keys(base).length > 0 && this.verbose) {
      console.error(
        `[sportsclaw] mcp: ${Object.keys(base).length} server(s) configured total`
      );
    }

    return Object.keys(base).length > 0 ? this.resolveTokens(base) : {};
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

  /** Connect with one retry and 2s backoff on failure */
  private async connectOne(name: string, config: McpServerConfig): Promise<void> {
    try {
      await this.connectOneAttempt(name, config);
    } catch (firstErr) {
      if (this.verbose) {
        console.error(
          `[sportsclaw] mcp: "${name}" connect failed, retrying in ${McpManager.CONNECT_RETRY_DELAY_MS}ms: ${firstErr}`
        );
      }
      await new Promise((r) => setTimeout(r, McpManager.CONNECT_RETRY_DELAY_MS));
      await this.connectOneAttempt(name, config);
    }
  }

  private async connectOneAttempt(name: string, config: McpServerConfig): Promise<void> {
    const url = new URL(config.url);
    const headers: Record<string, string> = {
      ...(config.headers ?? {}),
      ...(this.userId ? { "X-SportsClaw-User": this.userId } : {}),
    };

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

    this.connections.set(name, { client, serverName: name, failures: 0, lastFailureAt: 0 });

    // Check tool discovery cache
    const cached = this.forceRefresh ? null : this.loadToolCache(name, config);
    let tools: Array<{ name: string; description?: string; inputSchema?: unknown }>;

    if (cached) {
      tools = cached.tools;
      if (this.verbose) {
        console.error(
          `[sportsclaw] mcp: "${name}" loaded ${tools.length} tool(s) from cache`
        );
      }
      // Restore cached pod capabilities
      if (cached.capabilities) {
        this.podCaps.set(name, cached.capabilities);
      }
    } else {
      // Discover tools from server
      const { tools: allTools } = await client.listTools();
      const allowSet = config.tools?.length
        ? new Set(config.tools.map((t) => t.trim()))
        : null;
      tools = allowSet
        ? allTools.filter((t) => allowSet.has(t.name))
        : allTools;
      if (this.verbose) {
        const filtered = allowSet ? ` (filtered from ${allTools.length})` : "";
        console.error(
          `[sportsclaw] mcp: "${name}" has ${tools.length} tool(s)${filtered}: ${tools.map((t) => t.name).join(", ")}`
        );
      }
    }

    for (const tool of tools) {
      const prefixedName = `mcp__${name}__${tool.name}`;
      const spec: ToolSpec = {
        name: prefixedName,
        description: (tool.description ?? `MCP tool: ${tool.name} (${name})`) as string,
        input_schema: (tool.inputSchema as ToolSpec["input_schema"]) ?? {
          type: "object",
          properties: {},
        },
      };
      this.toolSpecs.push(spec);
      this.routeMap.set(prefixedName, { serverName: name, toolName: tool.name });
    }

    // Discover pod capabilities (workflows, agents, connectors)
    if (!cached) {
      await this.discoverCapabilities(name);
      // Save to cache (tools + capabilities)
      this.saveToolCache(name, config, tools);
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

  /** Get server name → description map for system prompt context */
  getServerDescriptions(): Map<string, string> {
    const result = new Map<string, string>();
    for (const [name, config] of Object.entries(this.configs)) {
      if (config.description) {
        result.set(name, config.description);
      }
    }
    return result;
  }

  /** Get discovered pod capabilities for all connected servers */
  getPodCapabilities(): Map<string, PodCapabilities> {
    return new Map(this.podCaps);
  }

  // -------------------------------------------------------------------------
  // Pod capability discovery
  // -------------------------------------------------------------------------

  /** Discover installed workflows, agents, and connectors on a pod. Non-fatal. */
  private async discoverCapabilities(serverName: string): Promise<void> {
    // Only attempt if the server has the standard discovery tools
    const hasSearch = (toolName: string) =>
      this.routeMap.has(`mcp__${serverName}__${toolName}`);

    if (!hasSearch("search_workflows") && !hasSearch("search_agents") && !hasSearch("connector_search")) {
      return; // Not a Machina pod — skip discovery
    }

    try {
      const [wfResult, agResult, cnResult] = await Promise.allSettled([
        hasSearch("search_workflows")
          ? this.callTool(`mcp__${serverName}__search_workflows`, {})
          : Promise.resolve(null),
        hasSearch("search_agents")
          ? this.callTool(`mcp__${serverName}__search_agents`, {})
          : Promise.resolve(null),
        hasSearch("connector_search")
          ? this.callTool(`mcp__${serverName}__connector_search`, {})
          : Promise.resolve(null),
      ]);

      const caps: PodCapabilities = {
        workflows: this.extractEntityNames(wfResult),
        agents: this.extractEntityNames(agResult),
        connectors: this.extractEntityNames(cnResult),
        discoveredAt: Date.now(),
      };

      this.podCaps.set(serverName, caps);

      if (this.verbose) {
        console.error(
          `[sportsclaw] mcp: "${serverName}" pod inventory: ` +
            `${caps.workflows.length} workflows, ${caps.agents.length} agents, ${caps.connectors.length} connectors`
        );
      }
    } catch {
      // Non-fatal — discovery failure shouldn't block engine startup
    }
  }

  private extractEntityNames(
    result: PromiseSettledResult<{ content: string; isError: boolean; errorCode?: McpErrorCode } | null>
  ): Array<{ name: string; description?: string }> {
    if (result.status !== "fulfilled" || !result.value || result.value.isError) return [];
    try {
      const data = JSON.parse(result.value.content);
      const items = data?.data ?? data?.results ?? (Array.isArray(data) ? data : []);
      if (!Array.isArray(items)) return [];
      return items
        .filter((item: Record<string, unknown>) => item.name)
        .map((item: Record<string, unknown>) => ({
          name: item.name as string,
          ...(item.description ? { description: item.description as string } : {}),
        }))
        .slice(0, 30);
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Tool discovery cache
  // -------------------------------------------------------------------------

  private loadToolCache(serverName: string, config: McpServerConfig): ToolCacheEntry | null {
    try {
      const cachePath = join(TOOL_CACHE_DIR, `${serverName}.json`);
      if (!existsSync(cachePath)) return null;

      const raw = readFileSync(cachePath, "utf-8");
      const cached = JSON.parse(raw) as ToolCacheEntry;

      if (Date.now() - cached.cachedAt > TOOL_CACHE_TTL_MS) return null;
      if (cached.configHash !== configHash(config)) return null;

      return cached;
    } catch {
      return null;
    }
  }

  private saveToolCache(
    serverName: string,
    config: McpServerConfig,
    tools: Array<{ name: string; description?: string; inputSchema?: unknown }>
  ): void {
    try {
      mkdirSync(TOOL_CACHE_DIR, { recursive: true });
      const entry: ToolCacheEntry = {
        tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        capabilities: this.podCaps.get(serverName),
        cachedAt: Date.now(),
        configHash: configHash(config),
      };
      writeFileSync(join(TOOL_CACHE_DIR, `${serverName}.json`), JSON.stringify(entry), "utf-8");
    } catch {
      // Non-fatal — caching is an optimization
    }
  }

  /** Call an MCP tool by its prefixed name */
  async callTool(
    prefixedName: string,
    args: Record<string, unknown>
  ): Promise<{ content: string; isError: boolean; errorCode?: McpErrorCode }> {
    const route = this.routeMap.get(prefixedName);
    if (!route) {
      return {
        content: JSON.stringify({ error: `Unknown MCP tool: ${prefixedName}` }),
        isError: true,
        errorCode: "not_found",
      };
    }

    const connection = this.connections.get(route.serverName);
    if (!connection) {
      return {
        content: JSON.stringify({
          error: `MCP server "${route.serverName}" is not connected`,
          error_code: "connection_failed",
          hint: "The MCP server was not reachable during startup. It may be down or misconfigured.",
        }),
        isError: true,
        errorCode: "connection_failed",
      };
    }

    // Circuit breaker: fast-fail if too many consecutive failures
    if (connection.failures >= McpManager.CIRCUIT_BREAKER_THRESHOLD) {
      const elapsed = Date.now() - connection.lastFailureAt;
      if (elapsed < McpManager.CIRCUIT_BREAKER_COOLDOWN_MS) {
        return {
          content: JSON.stringify({
            error: `MCP server "${route.serverName}" is temporarily unavailable (${connection.failures} consecutive failures). Will retry after cooldown.`,
            error_code: "circuit_open",
            hint: "This server has failed multiple times in a row. Use alternative tools or try again later.",
          }),
          isError: true,
          errorCode: "circuit_open",
        };
      }
      // Cooldown expired — allow one probe call
      connection.failures = 0;
    }

    const serverConfig = this.configs[route.serverName];
    const timeoutMs = serverConfig?.timeoutMs ?? McpManager.DEFAULT_CALL_TIMEOUT_MS;

    try {
      const result = await Promise.race([
        connection.client.callTool({ name: route.toolName, arguments: args }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("MCP_TIMEOUT")), timeoutMs)
        ),
      ]);

      // Success — reset circuit breaker
      connection.failures = 0;

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
      // Increment circuit breaker
      connection.failures++;
      connection.lastFailureAt = Date.now();

      const message = err instanceof Error ? err.message : String(err);
      const errorCode = McpManager.classifyError(message);

      return {
        content: JSON.stringify({
          error: `MCP tool call failed: ${message}`,
          error_code: errorCode,
          hint: McpManager.errorHint(errorCode),
        }),
        isError: true,
        errorCode,
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

  // -------------------------------------------------------------------------
  // Error classification
  // -------------------------------------------------------------------------

  private static classifyError(message: string): McpErrorCode {
    const msg = message.toLowerCase();
    if (msg === "mcp_timeout" || msg.includes("timeout") || msg.includes("aborted")) return "timeout";
    if (msg.includes("401") || msg.includes("403") || msg.includes("unauthorized") || msg.includes("forbidden")) return "auth_failed";
    if (msg.includes("404") || msg.includes("not found")) return "not_found";
    if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests")) return "rate_limited";
    if (/\b5\d{2}\b/.test(msg) || msg.includes("internal server error")) return "server_error";
    if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("fetch failed") || msg.includes("network")) return "connection_failed";
    return "unknown";
  }

  private static errorHint(code: McpErrorCode): string {
    switch (code) {
      case "timeout": return "The MCP server did not respond in time. Try a simpler query or check if the server is overloaded.";
      case "auth_failed": return "Authentication failed. Do not retry — the API token may be invalid or expired.";
      case "rate_limited": return "The server is rate-limiting requests. Wait briefly before retrying.";
      case "server_error": return "The MCP server returned an internal error. Try again shortly.";
      case "connection_failed": return "Cannot reach the MCP server. It may be down or restarting.";
      case "not_found": return "The requested resource was not found on the MCP server.";
      case "circuit_open": return "This server has failed repeatedly. Use alternative tools or try again later.";
      default: return "An unexpected error occurred with the MCP server.";
    }
  }
}
