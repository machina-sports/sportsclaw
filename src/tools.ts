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
          description: "The specific command/action to execute (e.g. scores, standings, schedule).",
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
// Dynamic tool registry (Phase 3 — schema injection)
// ---------------------------------------------------------------------------

/** Tools injected from sport schemas (via `sportsclaw add <sport>`) */
const dynamicSpecs: ToolSpec[] = [];

/** Maps dynamic tool names → { sport, command } for dispatch routing */
const routeMap = new Map<string, { sport: string; command: string }>();

/**
 * Inject a sport schema's tools into the dynamic registry.
 * Each tool in the schema becomes a first-class tool the LLM can call directly.
 */
export function injectSchema(schema: SportSchema): void {
  for (const tool of schema.tools) {
    // Avoid duplicates — overwrite if same name exists
    const existingIdx = dynamicSpecs.findIndex((s) => s.name === tool.name);
    const spec: ToolSpec = {
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as ToolSpec["input_schema"],
    };

    if (existingIdx >= 0) {
      dynamicSpecs[existingIdx] = spec;
    } else {
      dynamicSpecs.push(spec);
    }

    routeMap.set(tool.name, { sport: schema.sport, command: tool.command });
  }
}

/** Clear all dynamically injected tools (useful for testing) */
export function clearDynamicTools(): void {
  dynamicSpecs.length = 0;
  routeMap.clear();
}

/** Get all tool specs: built-in + dynamically injected */
export function getAllToolSpecs(): ToolSpec[] {
  return [...TOOL_SPECS, ...dynamicSpecs];
}

/** Get the dispatch route for a dynamically injected tool */
export function getToolRoute(
  toolName: string
): { sport: string; command: string } | undefined {
  return routeMap.get(toolName);
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const VALID_SPORTS = new Set([
  "nfl", "nba", "mlb", "nhl", "soccer", "f1", "mma", "tennis", "cfb", "cbb",
]);

const SAFE_IDENTIFIER = /^[a-zA-Z0-9_]+$/;

function validateIdentifier(value: string, label: string): string | null {
  if (!SAFE_IDENTIFIER.test(value)) {
    return `Invalid ${label}: must contain only alphanumeric characters and underscores`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Minimal env vars for the subprocess
// ---------------------------------------------------------------------------

export function buildSubprocessEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  const passthrough = ["PATH", "HOME", "LANG", "LC_ALL", "PYTHONPATH", "VIRTUAL_ENV"];
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
      const strValue = typeof value === "object" ? JSON.stringify(value) : String(value);
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
          // execFile error covers spawn failures and non-zero exits
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

// ---------------------------------------------------------------------------
// Tool dispatcher — routes tool calls to the right handler
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

/**
 * Dispatch a tool call by name and return the structured result for the LLM.
 *
 * Handles both the built-in `sports_query` tool and any dynamically injected
 * tools from sport schemas.
 */
export async function dispatchToolCall(
  toolName: string,
  input: ToolCallInput,
  config?: Partial<SportsClawConfig>
): Promise<ToolCallResult> {
  // --- Built-in: generic sports_query tool ---
  if (toolName === "sports_query") {
    return handleSportsQuery(input, config);
  }

  // --- Dynamic: schema-injected tools ---
  const route = routeMap.get(toolName);
  if (route) {
    return handleDynamicTool(route.sport, route.command, input, config);
  }

  return {
    content: JSON.stringify({ error: `Unknown tool: ${toolName}` }),
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Handler: built-in sports_query
// ---------------------------------------------------------------------------

async function handleSportsQuery(
  input: ToolCallInput,
  config?: Partial<SportsClawConfig>
): Promise<ToolCallResult> {
  if (!input.sport || !input.command) {
    return {
      content: JSON.stringify({ error: "Missing required parameters: sport and command" }),
      isError: true,
    };
  }

  if (!VALID_SPORTS.has(input.sport)) {
    return {
      content: JSON.stringify({
        error: `Unsupported sport: ${input.sport}. Valid: ${[...VALID_SPORTS].join(", ")}`,
      }),
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

// ---------------------------------------------------------------------------
// Handler: dynamically injected tools
// ---------------------------------------------------------------------------

async function handleDynamicTool(
  sport: string,
  command: string,
  input: ToolCallInput,
  config?: Partial<SportsClawConfig>
): Promise<ToolCallResult> {
  // All input fields (except sport/command which come from the route) are args
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
