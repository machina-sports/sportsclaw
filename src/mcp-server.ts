/**
 * sportsclaw Engine — Client-Facing MCP Server
 *
 * Exposes sportsclaw builtin tools and dynamic sport-specific schemas
 * as a standardized client-facing Model Context Protocol (MCP) server over stdio.
 * This allows external agent frameworks (e.g. Cursor, Claude Desktop, Vercel Eve)
 * to connect to sportsclaw and query live sports intelligence natively.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ToolRegistry, TOOL_SPECS } from "./tools.js";
import { loadAllSchemas } from "./schema.js";
import { resolveConfig } from "./config.js";
import type { ToolCallResult } from "./bridge.js";

/**
 * Runs the client-facing Model Context Protocol (MCP) server.
 * Listens on stdin/stdout for stdio transport.
 */
export async function startMcpServer(options: { verbose?: boolean } = {}): Promise<void> {
  const verbose = options.verbose ?? false;

  if (verbose) {
    console.error("[sportsclaw-mcp] Bootstrapping ToolRegistry...");
  }

  // Initialize ToolRegistry and load all installed sport schemas from disk
  const registry = new ToolRegistry();
  const schemas = loadAllSchemas();
  for (const schema of schemas) {
    if (verbose) {
      console.error(`[sportsclaw-mcp] Injecting schema: ${schema.sport} (${schema.tools.length} tools)`);
    }
    registry.injectSchema(schema);
  }

  // Load configuration for connection/bridge credentials
  const config = resolveConfig();

  // Initialize the MCP Server
  const server = new Server(
    {
      name: "sportsclaw-engine-core",
      version: "0.26.2",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Expose tools
  server.setRequestHandler(
    // Using custom string schema to match raw protocol
    "tools/list" as any,
    async () => {
      const specs = mcpServerGetToolSpecs(registry);

      if (verbose) {
        console.error(`[sportsclaw-mcp] Advertising ${specs.length} tools to client`);
      }

      return {
        tools: specs.map(spec => ({
          name: spec.name,
          description: spec.description,
          inputSchema: spec.input_schema,
        })),
      };
    }
  );

  // Handle tool execution
  server.setRequestHandler(
    "tools/call" as any,
    async (request: any) => {
      const { name, arguments: args } = request.params;

      if (verbose) {
        console.error(`[sportsclaw-mcp] Tool call received: ${name}`, JSON.stringify(args));
      }

      try {
        let result: ToolCallResult;

        // Route call to ToolRegistry
        result = await registry.dispatchToolCall(name, args ?? {}, config);

        if (result.isError) {
          return {
            content: [
              {
                type: "text",
                text: result.content,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: result.content,
            },
          ],
          isError: false,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (verbose) {
          console.error(`[sportsclaw-mcp] Tool execution failed: ${name}`, errorMsg);
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `MCP tool execution failed: ${errorMsg}`,
                error_code: "server_error",
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Setup transport and start listening
  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (verbose) {
    console.error("[sportsclaw-mcp] Server running successfully over stdio.");
  }
}

// Helper to get specs cleanly
function mcpServerGetToolSpecs(registry: ToolRegistry): any[] {
  // Get all registered specs (builtins + dynamic schemas)
  const specs = registry.getAllToolSpecs();
  
  // Ensure builtins (sports_query, sports_intelligence_snapshot) are always included in the MCP server list
  const serverSpecs = [...specs];
  const existingNames = new Set(serverSpecs.map(s => s.name));
  
  for (const builtin of TOOL_SPECS) {
    if (!existingNames.has(builtin.name)) {
      serverSpecs.push(builtin);
    }
  }

  // Filter out other MCP client tools to prevent circular loops
  return serverSpecs.filter(s => !s.name.startsWith("mcp__"));
}
