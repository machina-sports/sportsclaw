/**
 * SportsClaw Engine — Tool Definitions & Python Subprocess Bridge
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
  SportsClawConfig,
  SportSchema,
} from "./types.js";

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
// Tool Registry — instance-level, not module singletons
// ---------------------------------------------------------------------------

/**
 * Instance-level tool registry. Each SportsClawEngine owns its own registry,
 * preventing shared mutable state when multiple engines run concurrently.
 */
export class ToolRegistry {
  private dynamicSpecs: ToolSpec[] = [];
  private routeMap = new Map<string, { sport: string; command: string }>();

  /**
   * Inject a sport schema's tools into the dynamic registry.
   * Validates sport and command identifiers at injection time.
   */
  injectSchema(schema: SportSchema): void {
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

      const existingIdx = this.dynamicSpecs.findIndex((s) => s.name === tool.name);
      const spec: ToolSpec = {
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema as ToolSpec["input_schema"],
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

  /** Get all tool specs: built-in + dynamically injected */
  getAllToolSpecs(): ToolSpec[] {
    return [...TOOL_SPECS, ...this.dynamicSpecs];
  }

  /** Get the dispatch route for a dynamically injected tool */
  getToolRoute(
    toolName: string
  ): { sport: string; command: string } | undefined {
    return this.routeMap.get(toolName);
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
    config?: Partial<SportsClawConfig>
  ): Promise<ToolCallResult> {
    if (toolName === "sports_query") {
      return this.handleSportsQuery(input, config);
    }

    const route = this.routeMap.get(toolName);
    if (route) {
      return this.handleDynamicTool(route.sport, route.command, input, config);
    }

    return {
      content: JSON.stringify({ error: `Unknown tool: ${toolName}` }),
      isError: true,
    };
  }

  // -------------------------------------------------------------------------
  // Private handlers
  // -------------------------------------------------------------------------

  private async handleSportsQuery(
    input: ToolCallInput,
    config?: Partial<SportsClawConfig>
  ): Promise<ToolCallResult> {
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
      return {
        content: JSON.stringify({
          error: result.error,
          stderr: result.stderr,
          hint: "The sports-skills Python package may not be installed. Install it with: pip install sports-skills",
        }),
        isError: true,
      };
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
    config?: Partial<SportsClawConfig>
  ): Promise<ToolCallResult> {
    // Defense-in-depth: validate even though injectSchema already checks
    const sportError = validateIdentifier(sport, "sport");
    if (sportError) {
      return { content: JSON.stringify({ error: sportError }), isError: true };
    }
    const cmdError = validateIdentifier(command, "command");
    if (cmdError) {
      return { content: JSON.stringify({ error: cmdError }), isError: true };
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
      return {
        content: JSON.stringify({
          error: result.error,
          stderr: result.stderr,
          hint: `Tool "${command}" for sport "${sport}" failed. Ensure sports-skills is installed: pip install sports-skills`,
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

// ---------------------------------------------------------------------------
// Minimal env vars for the subprocess
// ---------------------------------------------------------------------------

export function buildSubprocessEnv(
  extra?: Record<string, string>
): Record<string, string> {
  const env: Record<string, string> = {};
  const passthrough = [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "PYTHONPATH",
    "VIRTUAL_ENV",
  ];
  for (const key of passthrough) {
    if (process.env[key]) {
      env[key] = process.env[key]!;
    }
  }
  if (extra) {
    Object.assign(env, extra);
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
      const strValue =
        typeof value === "object" ? JSON.stringify(value) : String(value);
      cliArgs.push(`--${key}`, strValue);
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
  config?: Partial<SportsClawConfig>
): Promise<PythonBridgeResult> {
  const pythonPath = config?.pythonPath ?? "python3";
  const cliArgs = buildArgs(sport, command, args);
  const timeout = config?.timeout ?? 30_000;

  if (config?.verbose) {
    console.error(`[sportsclaw] exec: ${pythonPath} ${cliArgs.join(" ")}`);
  }

  return new Promise((resolve) => {
    execFile(
      pythonPath,
      cliArgs,
      {
        encoding: "utf-8",
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        env: buildSubprocessEnv(config?.env),
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            success: false,
            error: error.message,
            stdout: stdout || undefined,
            stderr: stderr || undefined,
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
}
