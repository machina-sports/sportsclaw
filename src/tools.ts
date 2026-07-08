/**
 * sportsclaw Engine — Tool Definitions & Python Subprocess Bridge
 *
 * This module defines the tools the LLM can call and implements the core
 * "Python bridge" — the mechanism that intercepts tool calls and executes
 * them via `python3 -m sports_skills <sport> <command> [--args ...]`.
 *
 * Design principle: The TypeScript layer ORCHESTRATES; the Python layer EXECUTES.
 * Zero TS-to-Python rewriting is required.
 */

import type {
  ToolSpec,
  sportsclawConfig,
  SportSchema,
} from "./types.js";
import type { McpManager } from "./mcp.js";
import { buildSportsSkillsRepairCommand } from "./python.js";
import { isBlockedTool, logSecurityEvent } from "./security.js";
import { BUILTIN_TOOLS, machinaLoopTool } from "./tools/index.js";
import { classifyFailure } from "./failures/classifier.js";
import { logToolExecution } from "./analytics.js";
import type { ToolExecutionResult } from "./tools/executor.js";

export {
  ToolCallInput,
  ToolCallResult,
  validateIdentifier,
  classifyBridgeError,
  buildSubprocessEnv,
  executePythonBridge,
  bridgeBreaker,
  resolveRetryPlan,
} from "./bridge.js";

import {
  validateIdentifier,
  classifyBridgeError,
  executePythonBridge,
  type ToolCallInput,
  type ToolCallResult,
} from "./bridge.js";



// ---------------------------------------------------------------------------
// Tool catalogue — these are the built-in tools exposed to the LLM
// ---------------------------------------------------------------------------

export const TOOL_SPECS: ToolSpec[] = BUILTIN_TOOLS.map((t) => t.spec);

// ---------------------------------------------------------------------------
// Search-First Middleware — intercept guessed IDs before they hit the bridge
// ---------------------------------------------------------------------------

/**
 * Check if a value looks like a human-readable name rather than a valid ID.
 *
 * Valid IDs are typically: numeric ("258"), dot-codes ("eng.1"), hex ("0x..."),
 * or slugs with digits ("premier-league-2024-2025"). Human names contain
 * spaces, start with uppercase, or are long strings with no digits/dots.
 */
function looksLikeHumanName(value: string): boolean {
  const v = value.trim();
  if (v.length <= 4) return false;              // short codes: "ne", "buf", "nba"
  if (/\d/.test(v)) return false;               // has digits — real ID or slug
  if (v.includes(".")) return false;            // dot notation — code like "eng.1"
  if (v.startsWith("0x")) return false;         // hex address
  if (/\s/.test(v)) return true;                // spaces — definitely a name
  if (/^[A-Z]/.test(v)) return true;            // starts uppercase — proper noun
  // Hyphenated slugs like "premier-league" are valid IDs — only flag single long words
  if (v.length > 10 && /^[a-z]+$/.test(v)) return true; // single long lowercase word (e.g. "liverpool")
  return false;
}

/**
 * Build a helpful suggestion for which lookup tool to call.
 */
function buildLookupSuggestion(sport: string, paramName: string): string {
  if (paramName === "team_id") {
    return `Call ${sport}_search_team(query="<name>") to find the correct team_id.`;
  }
  if (paramName === "player_id" || paramName === "tm_player_id" || paramName === "fpl_id") {
    return `Call ${sport}_search_player(query="<name>") to find the correct ${paramName}.`;
  }
  if (paramName === "season_id") {
    return (
      `Call ${sport}_get_competitions to list competitions, then ` +
      `${sport}_get_competition_seasons to find the correct season_id.`
    );
  }
  if (paramName === "competition_id") {
    return `Call ${sport}_get_competitions to find the correct competition_id.`;
  }
  if (paramName === "event_id") {
    return `Call ${sport}_get_season_schedule or ${sport}_get_daily_schedule to find event IDs.`;
  }
  return `Use a listing or search tool for "${sport}" to discover the correct ${paramName}.`;
}

/**
 * Scan tool call input for _id parameters that look like guessed human names.
 * Returns an error message if a guessed ID is detected, null otherwise.
 */
function detectGuessedId(sport: string, input: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(input)) {
    if (!key.endsWith("_id") && !key.endsWith("_ids")) continue;

    const values: unknown[] = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (typeof v !== "string") continue;
      if (!looksLikeHumanName(v)) continue;

      const suggestion = buildLookupSuggestion(sport, key.replace(/_ids$/, "_id"));
      return (
        `"${v}" looks like a name, not a valid ${key}. ` +
        `IDs are typically numeric (e.g. "258") or code-formatted (e.g. "eng.1"). ` +
        suggestion
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------



/**
 * Sanitize bare year values to fully qualified ESPN / League slugs
 * (e.g., season_id="2026" -> "espn.mlb.2026")
 */
export function sanitizeToolInput(toolName: string, input: ToolCallInput): void {
  let sport = "";
  let targetObj = input;

  if (toolName === "sports_query" && typeof input.sport === "string") {
    sport = input.sport.toLowerCase();
    if (input.args && typeof input.args === "object" && !Array.isArray(input.args)) {
      targetObj = input.args as Record<string, unknown>;
    }
  } else {
    const sportMatch = toolName.match(/^([a-z0-9_-]+?)_/i);
    if (!sportMatch) return;
    sport = sportMatch[1].toLowerCase();
  }

  const seasonKeys = ["season", "season_id", "season_year"];
  for (const key of seasonKeys) {
    if (targetObj[key] !== undefined && targetObj[key] !== null) {
      const originalValue = String(targetObj[key]).trim();
      
      const isBareYear = /^\d{4}$/.test(originalValue) || /^\d{4}-\d{2,4}$/.test(originalValue);
      if (isBareYear) {
        let mappedValue: string | null = null;
        
        switch (sport) {
          case "mlb":
            mappedValue = `espn.mlb.${originalValue}`;
            break;
          case "nfl":
            mappedValue = `espn.nfl.${originalValue}`;
            break;
          case "nba":
            mappedValue = `espn.nba.${originalValue}`;
            break;
          case "nhl":
            mappedValue = `espn.nhl.${originalValue}`;
            break;
          case "wnba":
            mappedValue = `espn.wnba.${originalValue}`;
            break;
          case "cfb":
            mappedValue = `espn.cfb.${originalValue}`;
            break;
          case "cbb":
            mappedValue = `espn.cbb.${originalValue}`;
            break;
          case "football":
            if (/^\d{4}$/.test(originalValue)) {
              mappedValue = `premier-league-${originalValue}`;
            }
            break;
        }

        if (mappedValue) {
          console.error(`[sportsclaw] Sanitized bare year for ${toolName}: ${key}="${originalValue}" -> "${mappedValue}"`);
          targetObj[key] = mappedValue;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tool dispatch types
// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// Tool Result Cache — TTL-based in-memory caching
// ---------------------------------------------------------------------------

interface CacheEntry {
  result: ToolCallResult;
  timestamp: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}

// ---------------------------------------------------------------------------
// Tool Registry — instance-level, not module singletons
// ---------------------------------------------------------------------------

/**
 * Instance-level tool registry. Each sportsclawEngine owns its own registry,
 * preventing shared mutable state when multiple engines run concurrently.
 */
export class ToolRegistry {
  private dynamicSpecs: ToolSpec[] = [];
  private routeMap = new Map<string, { sport: string; command: string }>();
  private mcpSpecs: ToolSpec[] = [];
  private mcpRouteMap = new Map<string, { serverName: string; toolName: string }>();
  private mcpManager: McpManager | null = null;
  private cache = new Map<string, CacheEntry>();
  private cacheHits = 0;
  private cacheMisses = 0;
  private cacheEnabled = true;
  private cacheTtlMs = 300_000; // 5 minutes default

  /**
   * Configure cache settings. Must be called before any tool calls to take effect.
   */
  configureCaching(options: { enabled?: boolean; ttlMs?: number }): void {
    if (options.enabled !== undefined) {
      this.cacheEnabled = options.enabled;
    }
    if (options.ttlMs !== undefined && options.ttlMs > 0) {
      this.cacheTtlMs = options.ttlMs;
    }
  }

  /**
   * Inject MCP tools into the registry. Called after McpManager.connectAll().
   */
  injectMcpTools(manager: McpManager): void {
    this.mcpManager = manager;
    this.mcpSpecs = manager.getToolSpecs();
    this.mcpRouteMap = manager.getRouteMap();
  }

  /** The connected MCP manager, if any. Used by built-in tools that bridge to MCP. */
  getMcpManager(): McpManager | null {
    return this.mcpManager;
  }

  /**
   * Get cache statistics for debugging.
   */
  getCacheStats(): CacheStats {
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      size: this.cache.size,
    };
  }

  /**
   * Generate a cache key from tool name and sorted arguments.
   */
  private generateCacheKey(
    toolName: string,
    input: ToolCallInput
  ): string {
    // Sort keys for consistent hashing
    const sortedArgs = Object.keys(input)
      .sort()
      .reduce((acc, key) => {
        acc[key] = input[key];
        return acc;
      }, {} as Record<string, unknown>);
    return `${toolName}:${JSON.stringify(sortedArgs)}`;
  }

  /**
   * Check if a tool is an internal (non-sport) tool.
   */
  private isInternalTool(toolName: string): boolean {
    return (
      toolName.startsWith("update_") ||
      toolName === "reflect" ||
      toolName === "evolve_strategy" ||
      toolName === "get_agent_config" ||
      toolName === "run_selftest" ||
      toolName === "install_sport" ||
      toolName === "remove_sport" ||
      toolName === "upgrade_sports_skills" ||
      toolName === machinaLoopTool.spec.name
    );
  }

  /**
   * Internal tools should skip caching.
   */
  private shouldSkipCache(toolName: string): boolean {
    return this.isInternalTool(toolName) || toolName.startsWith("mcp__");
  }

  /**
   * Inject a sport schema's tools into the dynamic registry.
   * Validates sport and command identifiers at injection time.
   */
  injectSchema(schema: SportSchema, allowTrading?: boolean): void {
    const sportError = validateIdentifier(schema.sport, "sport");
    if (sportError) {
      console.error(`[sportsclaw] skipping schema "${schema.sport}": ${sportError}`);
      return;
    }

    for (const tool of schema.tools) {
      const cmdError = validateIdentifier(tool.command, "command");
      if (cmdError) {
        console.error(`[sportsclaw] skipping tool "${tool.name}": ${cmdError}`);
        continue;
      }

      // Security: Skip blocked tools entirely — don't even expose them to the LLM
      const blockReason = isBlockedTool(tool.name, allowTrading);
      if (blockReason) {
        console.error(`[sportsclaw] blocking tool "${tool.name}": trading operation`);
        continue;
      }

      const existingIdx = this.dynamicSpecs.findIndex((s) => s.name === tool.name);
      // Support both Vercel-compatible `parameters` and legacy `input_schema`
      const schemaObj = tool.parameters ?? tool.input_schema ?? {};
      const spec: ToolSpec = {
        name: tool.name,
        description: tool.description,
        input_schema: schemaObj as ToolSpec["input_schema"],
        needsApproval: tool.needsApproval,
        connection: tool.connection,
      };

      if (existingIdx >= 0) {
        this.dynamicSpecs[existingIdx] = spec;
      } else {
        this.dynamicSpecs.push(spec);
      }

      this.routeMap.set(tool.name, { sport: schema.sport, command: tool.command });
    }
  }

  /** Clear all dynamically injected tools */
  clearDynamicTools(): void {
    this.dynamicSpecs.length = 0;
    this.routeMap.clear();
  }

  /**
   * Remove all tools belonging to a specific sport from the registry.
   * Used by the `remove_sport` internal tool for immediate unload.
   */
  removeSchemaTools(sport: string): number {
    let removed = 0;
    const toRemove: string[] = [];
    for (const [toolName, route] of this.routeMap.entries()) {
      if (route.sport === sport) {
        toRemove.push(toolName);
      }
    }
    for (const toolName of toRemove) {
      this.routeMap.delete(toolName);
      const idx = this.dynamicSpecs.findIndex((s) => s.name === toolName);
      if (idx >= 0) {
        this.dynamicSpecs.splice(idx, 1);
      }
      removed++;
    }
    return removed;
  }

  /**
   * Get all tool specs.
   *
   * When dynamic schemas are loaded, prefer those sport-specific tools and
   * hide the legacy generic `sports_query` tool to reduce ambiguous routing.
   */
  getAllToolSpecs(): ToolSpec[] {
    let base =
      this.dynamicSpecs.length > 0 ? [...this.dynamicSpecs] : [...TOOL_SPECS];
    // `machina_loop` is a conditional capability: expose it only when a Machina
    // pod running the durable loop (`loop-runner`) is connected — regardless of
    // whether sport schemas are loaded. Strip any default copy, then re-add.
    base = base.filter((s) => s.name !== machinaLoopTool.spec.name);
    if (this.mcpManager?.getMachinaLoopServer()) {
      base.push(machinaLoopTool.spec);
    }
    // Append MCP tools after Python bridge tools
    if (this.mcpSpecs.length > 0) {
      base.push(...this.mcpSpecs);
    }
    return base;
  }

  /** Get the dispatch route for a dynamically injected tool */
  getToolRoute(
    toolName: string
  ): { sport: string; command: string } | undefined {
    return this.routeMap.get(toolName);
  }

  /** Get the skill (sport) name that owns a tool, if any */
  getSkillName(toolName: string): string | undefined {
    return this.routeMap.get(toolName)?.sport;
  }

  /** List installed dynamic skills (sports) currently available to the engine */
  getInstalledSkills(): string[] {
    const skills = new Set<string>();
    for (const route of this.routeMap.values()) {
      skills.add(route.sport);
    }
    return Array.from(skills);
  }

  /**
   * Emit a redacted `tool_execution` analytics event for a dispatch result.
   * Skips internal (non-sport) tools and MCP tools, which are not part of
   * the sports-skills reliability surface this event tracks.
   */
  private logDispatchResult(
    toolName: string,
    input: ToolCallInput,
    result: ToolCallResult,
    started: number
  ): void {
    if (this.isInternalTool(toolName) || toolName.startsWith("mcp__")) return;
    const execResult: ToolExecutionResult = {
      ok: !result.isError,
      toolName,
      args: input as Record<string, unknown>,
      warnings: [],
      normalized: false,
      failure: result.isError ? classifyFailure(result.content, toolName) : undefined,
      latencyMs: Date.now() - started,
    };
    logToolExecution(execResult);
  }

  /**
   * Dispatch a tool call by name and return the structured result for the LLM.
   *
   * Handles both the built-in `sports_query` tool and any dynamically injected
   * tools from sport schemas.
   */
  async dispatchToolCall(
    toolName: string,
    input: ToolCallInput,
    config?: Partial<sportsclawConfig>
  ): Promise<ToolCallResult> {
    const started = Date.now();

    // Sanitize input bare years
    sanitizeToolInput(toolName, input);

    // Security: Check blocklist FIRST, before any other processing
    const blockReason = isBlockedTool(toolName, config?.allowTrading);
    if (blockReason) {
      logSecurityEvent("blocked_tool", { toolName, input });
      const blockedResult: ToolCallResult = {
        content: JSON.stringify({
          error: blockReason,
          error_code: "blocked_tool",
          hint: "This tool is disabled for security reasons. sportsclaw is a read-only sports data agent.",
        }),
        isError: true,
      };
      this.logDispatchResult(toolName, input, blockedResult, started);
      return blockedResult;
    }


    // Check cache if enabled and tool is cacheable
    if (this.cacheEnabled && !this.shouldSkipCache(toolName)) {
      const cacheKey = this.generateCacheKey(toolName, input);
      const cached = this.cache.get(cacheKey);

      if (cached) {
        const age = Date.now() - cached.timestamp;
        if (age < this.cacheTtlMs) {
          this.cacheHits++;
          if (config?.verbose) {
            console.error(
              `[sportsclaw] cache hit for ${toolName} (age: ${Math.round(age / 1000)}s)`
            );
          }
          this.logDispatchResult(toolName, input, cached.result, started);
          return cached.result;
        }
        // Expired entry — remove it
        this.cache.delete(cacheKey);
      }
      this.cacheMisses++;
    }

    // Execute the tool
    let result: ToolCallResult;
    const builtin = BUILTIN_TOOLS.find((t) => t.spec.name === toolName);
    if (builtin) {
      result = await builtin.execute(input, config, this);
    } else if (this.mcpRouteMap.has(toolName) && this.mcpManager) {
      // MCP tool — dispatch via MCP client
      result = await this.mcpManager.callTool(toolName, input as Record<string, unknown>);
    } else {
      const route = this.routeMap.get(toolName);
      if (route) {
        const spec = this.dynamicSpecs.find((s) => s.name === toolName);
        const connectionName = spec?.connection || route.sport;
        result = await this.handleDynamicTool(route.sport, route.command, input, config, connectionName, toolName);
      } else {
        result = {
          content: JSON.stringify({ error: `Unknown tool: ${toolName}` }),
          isError: true,
        };
      }
    }

    // Store successful results in cache
    if (this.cacheEnabled && !this.shouldSkipCache(toolName) && !result.isError) {
      const cacheKey = this.generateCacheKey(toolName, input);
      this.cache.set(cacheKey, {
        result,
        timestamp: Date.now(),
      });
    }

    this.logDispatchResult(toolName, input, result, started);
    return result;
  }



  private async handleDynamicTool(
    sport: string,
    command: string,
    input: ToolCallInput,
    config?: Partial<sportsclawConfig>,
    connectionName?: string,
    dispatchedToolName?: string
): Promise<ToolCallResult> {
    const pythonPath = config?.pythonPath ?? "python3";
    const repairCmd = buildSportsSkillsRepairCommand(pythonPath);

    // Search-first middleware: reject guessed human names in _id parameters.
    // Forces the LLM to call a search/listing tool first to discover real IDs.
    const idIssue = detectGuessedId(sport, input as Record<string, unknown>);
    if (idIssue) {
      return { content: JSON.stringify({ error: idIssue }), isError: true };
    }

    // All input fields are args for the Python bridge
    const args: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined && value !== null) {
        args[key] = value;
      }
    }

    const result = await executePythonBridge(sport, command, args, config, connectionName);

    if (!result.success) {
      const classified = classifyBridgeError(result.error, result.stderr);
      let hint: string;
      if (classified.errorCode === "dependency_missing") {
        hint = sport === "f1"
          ? `F1 support is unavailable. Repair with: ${repairCmd}`
          : `The sports-skills Python package may be missing. Install/repair with: ${repairCmd}`;
      } else {
        const toolName = dispatchedToolName ?? `${sport}_${command}`;
        const combined = `${result.error ?? ""}\n${result.stderr ?? ""}`.trim();
        const failure = classifyFailure(combined, toolName);
        hint = failure.userMessage || result.error || classified.hint;
      }
      return {
        content: JSON.stringify({
          error: result.error,
          error_code: classified.errorCode,
          stderr: result.stderr,
          hint,
        }),
        isError: true,
      };
    }

    return {
      content: JSON.stringify(result.data),
      isError: false,
    };
  }
}


