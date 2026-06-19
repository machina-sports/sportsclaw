import type { sportsclawConfig } from "../types.js";
import { 
  executePythonBridge, 
  validateIdentifier, 
  classifyBridgeError,
  type ToolCallInput, 
  type ToolCallResult 
} from "../bridge.js";
import { buildSportsSkillsRepairCommand } from "../python.js";
import type { BuiltinTool } from "./builtin-tool.js";

function buildBridgeErrorResult(
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

export const sportsQueryTool: BuiltinTool = {
  spec: {
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

  async execute(
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
      config,
      input.sport
    );

    if (!result.success) {
      return buildBridgeErrorResult(result, input.sport, repairCmd);
    }

    return {
      content: JSON.stringify(result.data),
      isError: false,
    };
  }
};
