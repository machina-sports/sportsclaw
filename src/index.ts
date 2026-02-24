#!/usr/bin/env node
/**
 * SportsClaw Engine — CLI Entry Point
 *
 * Subcommands:
 *   sportsclaw add <sport>       — Inject a sport schema from the Python package
 *   sportsclaw remove <sport>    — Remove a previously added sport schema
 *   sportsclaw list              — List all installed sport schemas
 *   sportsclaw listen <platform> — Start a Discord or Telegram listener
 *   sportsclaw "<prompt>"        — Run a one-shot query (default)
 *
 * Or import as a library:
 *   import { SportsClawEngine } from "sportsclaw-engine-core";
 *   const engine = new SportsClawEngine();
 *   const answer = await engine.run("What are today's NBA scores?");
 */

import { fileURLToPath } from "node:url";
import { SportsClawEngine } from "./engine.js";
import {
  fetchSportSchema,
  saveSchema,
  removeSchema,
  listSchemas,
  getSchemaDir,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Re-exports for library usage
// ---------------------------------------------------------------------------

export { SportsClawEngine } from "./engine.js";
export {
  TOOL_SPECS,
  executePythonBridge,
  dispatchToolCall,
  getAllToolSpecs,
  injectSchema,
  clearDynamicTools,
} from "./tools.js";
export {
  fetchSportSchema,
  saveSchema,
  removeSchema,
  listSchemas,
  loadAllSchemas,
} from "./schema.js";
export type {
  SportsClawConfig,
  ToolSpec,
  PythonBridgeResult,
  TurnResult,
  SportSchema,
  SportToolDef,
} from "./types.js";

// ---------------------------------------------------------------------------
// CLI: `sportsclaw add <sport>`
// ---------------------------------------------------------------------------

async function cmdAdd(args: string[]): Promise<void> {
  const sport = args[0];
  if (!sport) {
    console.error("Usage: sportsclaw add <sport>");
    console.error("Example: sportsclaw add nfl");
    process.exit(1);
  }

  const pythonPath = process.env.PYTHON_PATH || "python3";
  console.log(`Fetching schema for "${sport}"...`);

  try {
    const schema = await fetchSportSchema(sport, { pythonPath });
    saveSchema(schema);
    console.log(`Successfully added "${sport}" (${schema.tools.length} tools):`);
    for (const tool of schema.tools) {
      console.log(`  - ${tool.name}: ${tool.description.slice(0, 80)}`);
    }
    console.log(`\nSchema saved to ${getSchemaDir()}/${sport}.json`);
    console.log("The agent will now use these tools automatically.");
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error("Failed to add sport schema:", error);
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// CLI: `sportsclaw remove <sport>`
// ---------------------------------------------------------------------------

function cmdRemove(args: string[]): void {
  const sport = args[0];
  if (!sport) {
    console.error("Usage: sportsclaw remove <sport>");
    process.exit(1);
  }

  if (removeSchema(sport)) {
    console.log(`Removed schema for "${sport}".`);
  } else {
    console.error(`No schema found for "${sport}".`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// CLI: `sportsclaw list`
// ---------------------------------------------------------------------------

function cmdList(): void {
  const schemas = listSchemas();
  if (schemas.length === 0) {
    console.log("No sport schemas installed.");
    console.log('Add one with: sportsclaw add <sport>');
    return;
  }
  console.log(`Installed sport schemas (${schemas.length}):`);
  for (const name of schemas) {
    console.log(`  - ${name}`);
  }
  console.log(`\nSchema directory: ${getSchemaDir()}`);
}

// ---------------------------------------------------------------------------
// CLI: `sportsclaw listen <platform>`
// ---------------------------------------------------------------------------

async function cmdListen(args: string[]): Promise<void> {
  const platform = args[0]?.toLowerCase();
  if (!platform || !["discord", "telegram"].includes(platform)) {
    console.error("Usage: sportsclaw listen <discord|telegram>");
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY environment variable is required.");
    process.exit(1);
  }

  if (platform === "discord") {
    if (!process.env.DISCORD_BOT_TOKEN) {
      console.error("Error: DISCORD_BOT_TOKEN environment variable is required.");
      console.error("Get one at https://discord.com/developers/applications");
      process.exit(1);
    }
    const { startDiscordListener } = await import("./listeners/discord.js");
    await startDiscordListener();
  } else if (platform === "telegram") {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      console.error("Error: TELEGRAM_BOT_TOKEN environment variable is required.");
      console.error("Get one from @BotFather on Telegram.");
      process.exit(1);
    }
    const { startTelegramListener } = await import("./listeners/telegram.js");
    await startTelegramListener();
  }
}

// ---------------------------------------------------------------------------
// CLI: default — run a one-shot query
// ---------------------------------------------------------------------------

async function cmdQuery(args: string[]): Promise<void> {
  const verbose = args.includes("--verbose") || args.includes("-v");
  const filteredArgs = args.filter((a) => a !== "--verbose" && a !== "-v");
  const prompt = filteredArgs.join(" ");

  if (!prompt) {
    printHelp();
    process.exit(0);
  }

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

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log("SportsClaw Engine v0.2.0");
  console.log("");
  console.log("Usage:");
  console.log('  sportsclaw "<prompt>"              Run a one-shot sports query');
  console.log("  sportsclaw add <sport>             Add a sport schema (e.g. nfl, nba)");
  console.log("  sportsclaw remove <sport>          Remove a sport schema");
  console.log("  sportsclaw list                    List installed sport schemas");
  console.log("  sportsclaw listen <platform>       Start a chat listener (discord, telegram)");
  console.log("");
  console.log("Options:");
  console.log("  --verbose, -v    Enable verbose logging");
  console.log("  --help, -h       Show this help message");
  console.log("");
  console.log("Environment:");
  console.log("  ANTHROPIC_API_KEY       Your Anthropic API key (required for queries)");
  console.log("  SPORTSCLAW_MODEL        Model override (default: claude-sonnet-4-20250514)");
  console.log("  PYTHON_PATH             Path to Python interpreter (default: python3)");
  console.log("  SPORTSCLAW_SCHEMA_DIR   Custom schema storage directory");
  console.log("  DISCORD_BOT_TOKEN       Discord bot token (for listen discord)");
  console.log("  TELEGRAM_BOT_TOKEN      Telegram bot token (for listen telegram)");
}

// ---------------------------------------------------------------------------
// Main — route subcommands
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case "add":
      return cmdAdd(subArgs);
    case "remove":
      return cmdRemove(subArgs);
    case "list":
      return cmdList();
    case "listen":
      return cmdListen(subArgs);
    default:
      // Not a subcommand — treat the entire args as a query prompt
      return cmdQuery(args);
  }
}

// Run if executed directly
const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  main();
}
