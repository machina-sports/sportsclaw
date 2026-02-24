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

import { spawnSync } from "node:child_process";
import type { ToolSpec, PythonBridgeResult, SportsClawConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Tool catalogue — these are the tools exposed to the LLM
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
      cliArgs.push(`--${key}`, String(value));
    }
  }

  return cliArgs;
}

/**
 * Execute a sports-skills command via a synchronous child process.
 *
 * Returns a structured result with stdout parsed as JSON when possible.
 */
export function executePythonBridge(
  sport: string,
  command: string,
  args?: Record<string, unknown>,
  config?: Partial<SportsClawConfig>
): PythonBridgeResult {
  const pythonPath = config?.pythonPath ?? "python3";
  const cliArgs = buildArgs(sport, command, args);

  if (config?.verbose) {
    console.error(`[sportsclaw] exec: ${pythonPath} ${cliArgs.join(" ")}`);
  }

  const result = spawnSync(pythonPath, cliArgs, {
    encoding: "utf-8",
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024, // 10 MB
    env: { ...process.env, ...config?.env },
  });

  // Process exited with an error
  if (result.error) {
    return {
      success: false,
      error: `Failed to spawn process: ${result.error.message}`,
      stderr: result.stderr ?? undefined,
    };
  }

  if (result.status !== 0) {
    return {
      success: false,
      error: `Process exited with code ${result.status}`,
      stdout: result.stdout ?? undefined,
      stderr: result.stderr ?? undefined,
    };
  }

  // Try to parse stdout as JSON
  const stdout = (result.stdout ?? "").trim();
  try {
    const data = JSON.parse(stdout);
    return { success: true, data };
  } catch {
    // Not JSON — return raw stdout
    return { success: true, data: stdout, stdout };
  }
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

/**
 * Dispatch a tool call by name and return the string result for the LLM.
 */
export function dispatchToolCall(
  toolName: string,
  input: ToolCallInput,
  config?: Partial<SportsClawConfig>
): string {
  if (toolName === "sports_query") {
    if (!input.sport || !input.command) {
      return JSON.stringify({
        error: "Missing required parameters: sport and command",
      });
    }

    const result = executePythonBridge(
      input.sport,
      input.command,
      input.args,
      config
    );

    if (!result.success) {
      // Provide a helpful message so the LLM can tell the user
      return JSON.stringify({
        error: result.error,
        stderr: result.stderr,
        hint: "The sports-skills Python package may not be installed. Install it with: pip install sports-skills",
      });
    }

    return JSON.stringify(result.data);
  }

  return JSON.stringify({ error: `Unknown tool: ${toolName}` });
}
