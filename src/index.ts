#!/usr/bin/env node
/**
 * SportsClaw Engine — Entry Point
 *
 * Usage:
 *   npx sportsclaw "What is the score of the last NFL game?"
 *   ANTHROPIC_API_KEY=sk-... node dist/index.js "Who leads the Premier League?"
 *
 * Or import as a library:
 *   import { SportsClawEngine } from "sportsclaw-engine-core";
 *   const engine = new SportsClawEngine();
 *   const answer = await engine.run("What are today's NBA scores?");
 */

import { fileURLToPath } from "node:url";
import { SportsClawEngine } from "./engine.js";

// ---------------------------------------------------------------------------
// Re-exports for library usage
// ---------------------------------------------------------------------------

export { SportsClawEngine } from "./engine.js";
export { TOOL_SPECS, executePythonBridge, dispatchToolCall } from "./tools.js";
export type {
  SportsClawConfig,
  ToolSpec,
  PythonBridgeResult,
  TurnResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Parse flags
  const verbose = args.includes("--verbose") || args.includes("-v");
  const filteredArgs = args.filter((a) => a !== "--verbose" && a !== "-v");
  const prompt = filteredArgs.join(" ");

  if (!prompt) {
    console.log("SportsClaw Engine v0.1.0");
    console.log("");
    console.log("Usage:");
    console.log('  npx sportsclaw "What is the score of the last NFL game?"');
    console.log('  node dist/index.js "Who leads the Premier League?"');
    console.log("");
    console.log("Options:");
    console.log("  --verbose, -v    Enable verbose logging");
    console.log("");
    console.log("Environment:");
    console.log("  ANTHROPIC_API_KEY    Your Anthropic API key (required)");
    console.log("  SPORTSCLAW_MODEL     Model override (default: claude-sonnet-4-20250514)");
    console.log("  PYTHON_PATH          Path to Python interpreter (default: python3)");
    process.exit(0);
  }

  // Check for API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY environment variable is required.");
    console.error("Set it with: export ANTHROPIC_API_KEY=sk-...");
    process.exit(1);
  }

  const engine = new SportsClawEngine({
    ...(process.env.SPORTSCLAW_MODEL && { model: process.env.SPORTSCLAW_MODEL }),
    ...(process.env.PYTHON_PATH && { pythonPath: process.env.PYTHON_PATH }),
    verbose,
  });

  try {
    await engine.runAndPrint(prompt);
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
      if (verbose) {
        console.error(error.stack);
      }
    } else {
      console.error("An unknown error occurred:", error);
    }
    process.exit(1);
  }
}

// Run if executed directly
const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  main();
}
