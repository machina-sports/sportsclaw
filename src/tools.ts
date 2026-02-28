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

import { execFile } from "node:child_process";
import type {
  ToolSpec,
  PythonBridgeResult,
  sportsclawConfig,
  SportSchema,
} from "./types.js";
import { buildSportsSkillsRepairCommand, isVenvSetup, getVenvDir } from "./python.js";
import { isBlockedTool, logSecurityEvent } from "./security.js";

type BridgeErrorCode =
  | "timeout"
  | "dependency_missing"
  | "network_dns"
  | "rate_limited"
  | "python_version_incompatible"
  | "tool_execution_failed";

function classifyBridgeError(
  error?: string,
  stderr?: string
): { errorCode: BridgeErrorCode; hint: string } {
  const haystack = `${error ?? ""}\n${stderr ?? ""}`.toLowerCase();

  if (haystack.includes("timed out") || haystack.includes("command timed out")) {
    return {
      errorCode: "timeout",
      hint:
        "The data provider timed out. Retry the same query; if it persists, increase timeout in config.",
    };
  }
  if (
    haystack.includes("modulenotfounderror") ||
    haystack.includes("importerror") ||
    haystack.includes("optional dependency") ||
    haystack.includes("dependency_missing") ||
    haystack.includes("requires extra dependencies")
  ) {
    return {
      errorCode: "dependency_missing",
      hint: "A required dependency is missing in the selected Python environment.",
    };
  }
  if (
    haystack.includes("enotfound") ||
    haystack.includes("name resolution") ||
    haystack.includes("nodename nor servname") ||
    haystack.includes("getaddrinfo")
  ) {
    return {
      errorCode: "network_dns",
      hint: "Network/DNS lookup failed while reaching a data source. Verify internet/DNS and retry.",
    };
  }
  if (
    haystack.includes("429") ||
    haystack.includes("rate limit") ||
    haystack.includes("too many requests")
  ) {
    return {
      errorCode: "rate_limited",
      hint: "The provider rate-limited requests. Wait briefly and retry.",
    };
  }
  if (
    haystack.includes("unsupported operand type(s) for |") ||
    (haystack.includes("typeerror") && haystack.includes("type |")) ||
    (haystack.includes("syntaxerror") && haystack.includes("x | y"))
  ) {
    return {
      errorCode: "python_version_incompatible",
      hint:
        "Python 3.10+ is required. The current interpreter is too old for sports-skills. " +
        "Upgrade Python or run: sportsclaw config",
    };
  }

  return {
    errorCode: "tool_execution_failed",
    hint: "The tool execution failed. Retry and inspect stderr for details.",
  };
}

// ---------------------------------------------------------------------------
// Tool catalogue — these are the built-in tools exposed to the LLM
// ---------------------------------------------------------------------------

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "sports_query",
    description: [
      "Execute a sports data query via the sports-skills Python package.",
      "This tool fetches live and historical sports data including scores,",
      "standings, schedules, odds, play-by-play, stats, and more.",
      "",
      "Supported sports: nfl, nba, mlb, nhl, soccer, f1, mma, tennis, cfb, cbb.",
      "",
      "Examples of sport + command pairs:",
      '  sport="nfl", command="scores"          → current/recent NFL scores',
      '  sport="nfl", command="standings"        → NFL standings',
      '  sport="nba", command="schedule"         → NBA schedule',
      '  sport="soccer", command="standings", args={"league": "premier_league"}',
      '  sport="f1", command="race_results", args={"year": 2025, "round": 1}',
      "",
      "Pass any extra parameters as key-value pairs in the `args` object.",
    ].join("\n"),
    input_schema: {
      type: "object" as const,
      properties: {
        sport: {
          type: "string",
          description: "The sport to query (e.g. nfl, nba, mlb, nhl, soccer, f1).",
        },
        command: {
          type: "string",
          description:
            "The specific command/action to execute (e.g. scores, standings, schedule).",
        },
        args: {
          type: "object",
          description: "Optional key-value arguments passed to the command.",
          additionalProperties: true,
        },
      },
      required: ["sport", "command"],
    },
  },
];

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
  if (v.length > 5 && /^[a-z]+(?:-[a-z]+)*$/.test(v)) return true; // long lowercase word/slug
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

const SAFE_IDENTIFIER = /^[a-zA-Z0-9_-]+$/;

function validateIdentifier(value: string, label: string): string | null {
  if (!SAFE_IDENTIFIER.test(value)) {
    return `Invalid ${label}: must contain only alphanumeric characters, underscores, and hyphens`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tool dispatch types
// ---------------------------------------------------------------------------

export interface ToolCallInput {
  sport?: string;
  command?: string;
  args?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ToolCallResult {
  content: string;
  isError: boolean;
}

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
      toolName === "install_sport" ||
      toolName === "remove_sport" ||
      toolName === "upgrade_sports_skills"
    );
  }

  /**
   * Internal tools should skip caching.
   */
  private shouldSkipCache(toolName: string): boolean {
    return this.isInternalTool(toolName);
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
    if (this.dynamicSpecs.length > 0) {
      return [...this.dynamicSpecs];
    }
    return [...TOOL_SPECS];
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
    // Security: Check blocklist FIRST, before any other processing
    const blockReason = isBlockedTool(toolName, config?.allowTrading);
    if (blockReason) {
      logSecurityEvent("blocked_tool", { toolName, input });
      return {
        content: JSON.stringify({
          error: blockReason,
          error_code: "blocked_tool",
          hint: "This tool is disabled for security reasons. SportsClaw is a read-only sports data agent.",
        }),
        isError: true,
      };
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
          return cached.result;
        }
        // Expired entry — remove it
        this.cache.delete(cacheKey);
      }
      this.cacheMisses++;
    }

    // Execute the tool
    let result: ToolCallResult;
    if (toolName === "sports_query") {
      result = await this.handleSportsQuery(input, config);
    } else {
      const route = this.routeMap.get(toolName);
      if (route) {
        result = await this.handleDynamicTool(route.sport, route.command, input, config);
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

    return result;
  }

  // -------------------------------------------------------------------------
  // Private handlers
  // -------------------------------------------------------------------------

  private buildBridgeErrorResult(
    result: { error?: string; stderr?: string },
    sport: string,
    repairCmd: string
  ): ToolCallResult {
    const classified = classifyBridgeError(result.error, result.stderr);
    let hint: string;
    if (classified.errorCode === "dependency_missing") {
      hint = sport === "f1"
        ? `F1 support is unavailable. Repair with: ${repairCmd}`
        : `The sports-skills Python package may be missing. Install/repair with: ${repairCmd}`;
    } else {
      hint = classified.hint;
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

  private async handleSportsQuery(
    input: ToolCallInput,
    config?: Partial<sportsclawConfig>
  ): Promise<ToolCallResult> {
    const pythonPath = config?.pythonPath ?? "python3";
    const repairCmd = buildSportsSkillsRepairCommand(pythonPath);

    if (!input.sport || !input.command) {
      return {
        content: JSON.stringify({
          error: "Missing required parameters: sport and command",
        }),
        isError: true,
      };
    }

    const sportError = validateIdentifier(input.sport, "sport");
    if (sportError) {
      return {
        content: JSON.stringify({ error: sportError }),
        isError: true,
      };
    }

    const cmdError = validateIdentifier(input.command, "command");
    if (cmdError) {
      return {
        content: JSON.stringify({ error: cmdError }),
        isError: true,
      };
    }

    const result = await executePythonBridge(
      input.sport,
      input.command,
      input.args,
      config
    );

    if (!result.success) {
      return this.buildBridgeErrorResult(result, input.sport, repairCmd);
    }

    return {
      content: JSON.stringify(result.data),
      isError: false,
    };
  }

  private async handleDynamicTool(
    sport: string,
    command: string,
    input: ToolCallInput,
    config?: Partial<sportsclawConfig>
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

    const result = await executePythonBridge(sport, command, args, config);

    if (!result.success) {
      return this.buildBridgeErrorResult(result, sport, repairCmd);
    }

    return {
      content: JSON.stringify(result.data),
      isError: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Minimal env vars for the subprocess
// ---------------------------------------------------------------------------

export function buildSubprocessEnv(
  extra?: Record<string, string>
): Record<string, string> {
  // Inherit the full parent env — process.env already has ~/.sportsclaw/.env
  // loaded by applyConfigToEnv(), so all service credentials (POLYMARKET_*,
  // KALSHI_*, etc.) are available without hardcoding prefixes.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }

  if (extra) {
    Object.assign(env, extra);
  }

  // Activate the managed venv for all subprocess calls
  if (isVenvSetup()) {
    const venvDir = getVenvDir();
    env.VIRTUAL_ENV = venvDir;
    const venvBin = venvDir + "/bin";
    env.PATH = env.PATH ? `${venvBin}:${env.PATH}` : venvBin;
  }

  return env;
}

// ---------------------------------------------------------------------------
// Python Subprocess Bridge
// ---------------------------------------------------------------------------

/**
 * Build the CLI arguments for invoking sports-skills.
 *
 * Invocation pattern:
 *   python3 -m sports_skills <sport> <command> [--key value ...]
 */
function buildArgs(
  sport: string,
  command: string,
  args?: Record<string, unknown>
): string[] {
  const cliArgs = ["-m", "sports_skills", sport, command];

  if (args) {
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined || value === null) continue;
      const keyError = validateIdentifier(key, "argument key");
      if (keyError) continue;
      
      if (typeof value === "boolean") {
        if (value) cliArgs.push(`--${key}`);
      } else {
        const strValue =
          typeof value === "object" ? JSON.stringify(value) : String(value);
        cliArgs.push(`--${key}=${strValue}`);
      }
    }
  }

  return cliArgs;
}

/**
 * Execute a sports-skills command via an async child process.
 *
 * Returns a structured result with stdout parsed as JSON when possible.
 */
export function executePythonBridge(
  sport: string,
  command: string,
  args?: Record<string, unknown>,
  config?: Partial<sportsclawConfig>
): Promise<PythonBridgeResult> {
  const pythonPath = config?.pythonPath ?? "python3";
  const cliArgs = buildArgs(sport, command, args);
  const timeout = config?.timeout ?? 60_000;
  const retryTimeout = Math.max(timeout * 2, 90_000);

  if (config?.verbose) {
    console.error(`[sportsclaw] exec: ${pythonPath} ${cliArgs.join(" ")}`);
  }

  const runOnce = (attemptTimeout: number) =>
    new Promise<(PythonBridgeResult & { timedOut?: boolean })>((resolve) => {
      execFile(
        pythonPath,
        cliArgs,
        {
          encoding: "utf-8",
          timeout: attemptTimeout,
          maxBuffer: 25 * 1024 * 1024, // 25 MB for verbose FastF1 stderr on degraded networks
          env: buildSubprocessEnv(config?.env),
        },
        (error, stdout, stderr) => {
          if (error) {
            const execErr = error as Error & {
              signal?: NodeJS.Signals | null;
              code?: string | number | null;
            };
            const timedOut =
              /timed out/i.test(error.message) ||
              (execErr.signal === "SIGTERM" && execErr.code === null);
            resolve({
              success: false,
              error: error.message,
              stdout: stdout || undefined,
              stderr: stderr || undefined,
              timedOut,
            });
            return;
          }

          const trimmed = (stdout ?? "").trim();
          if (!trimmed) {
            resolve({
              success: true,
              data: null,
              stdout: "",
            });
            return;
          }

          try {
            const data = JSON.parse(trimmed);
            resolve({ success: true, data });
          } catch {
            // Not JSON — return raw stdout
            resolve({ success: true, data: trimmed, stdout: trimmed });
          }
        }
      );
    });

  return (async () => {
    const firstAttempt = await runOnce(timeout);
    if (firstAttempt.success) {
      return firstAttempt;
    }

    // Retry once on any failure (timeout gets a longer window; transient
    // errors like network blips / RSS parse failures get a second chance).
    if (firstAttempt.timedOut) {
      if (config?.verbose) {
        console.error(
          `[sportsclaw] exec timeout after ${timeout}ms; retrying with ${retryTimeout}ms`
        );
      }
    } else if (config?.verbose) {
      console.error(
        `[sportsclaw] exec failed; retrying once: ${firstAttempt.error?.slice(0, 120)}`
      );
    }

    const secondTimeout = firstAttempt.timedOut ? retryTimeout : timeout;
    const secondAttempt = await runOnce(secondTimeout);
    if (secondAttempt.success) {
      return secondAttempt;
    }

    // Preserve first error context so callers can surface the true cause.
    return {
      ...secondAttempt,
      error: firstAttempt.timedOut
        ? `Command timed out after ${timeout}ms and retry after ${retryTimeout}ms failed. ` +
          `${secondAttempt.error ?? firstAttempt.error ?? ""}`.trim()
        : secondAttempt.error ?? firstAttempt.error,
    };
  })();
}
