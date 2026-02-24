#!/usr/bin/env node
/**
 * SportsClaw Engine — CLI Entry Point
 *
 * Subcommands:
 *   sportsclaw add <sport>       — Inject a sport schema from the Python package
 *   sportsclaw remove <sport>    — Remove a previously added sport schema
 *   sportsclaw list              — List all installed sport schemas
 *   sportsclaw init              — Bootstrap all 14 default sport schemas
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
  bootstrapDefaultSchemas,
  DEFAULT_SKILLS,
} from "./schema.js";
import type { LLMProvider } from "./types.js";

// ---------------------------------------------------------------------------
// Provider ↔ API key env var mapping
// ---------------------------------------------------------------------------

const PROVIDER_API_KEY_ENV: Record<LLMProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

// ---------------------------------------------------------------------------
// Re-exports for library usage
// ---------------------------------------------------------------------------

export { SportsClawEngine } from "./engine.js";
export {
  TOOL_SPECS,
  ToolRegistry,
  executePythonBridge,
} from "./tools.js";
export type { ToolCallInput, ToolCallResult } from "./tools.js";
export {
  fetchSportSchema,
  saveSchema,
  removeSchema,
  listSchemas,
  loadAllSchemas,
  bootstrapDefaultSchemas,
  DEFAULT_SKILLS,
} from "./schema.js";
export { MemoryManager, getMemoryDir } from "./memory.js";
export type {
  LLMProvider,
  SportsClawConfig,
  RunOptions,
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
// CLI: `sportsclaw init`
// ---------------------------------------------------------------------------

async function cmdInit(args: string[]): Promise<void> {
  const verbose = args.includes("--verbose") || args.includes("-v");
  const pythonPath = process.env.PYTHON_PATH || "python3";

  console.log(
    `Bootstrapping ${DEFAULT_SKILLS.length} default sport schemas...`
  );

  const count = await bootstrapDefaultSchemas(
    { pythonPath },
    { verbose, force: true }
  );

  console.log(
    `Done. ${count}/${DEFAULT_SKILLS.length} schemas installed in ${getSchemaDir()}`
  );

  if (count < DEFAULT_SKILLS.length) {
    console.log(
      "Some schemas could not be fetched. Ensure sports-skills is up to date:"
    );
    console.log("  pip install --upgrade sports-skills");
  }
}

// ---------------------------------------------------------------------------
// Auto-bootstrap: ensure default schemas are present on first use
// ---------------------------------------------------------------------------

async function ensureDefaultSchemas(): Promise<void> {
  const installed = listSchemas();
  if (installed.length > 0) return; // schemas already exist

  console.error(
    "[sportsclaw] No sport schemas found. Bootstrapping defaults..."
  );
  const pythonPath = process.env.PYTHON_PATH || "python3";
  const count = await bootstrapDefaultSchemas({ pythonPath });
  console.error(
    `[sportsclaw] Bootstrapped ${count}/${DEFAULT_SKILLS.length} default schemas.`
  );
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

  const provider = (process.env.SPORTSCLAW_PROVIDER || "anthropic") as LLMProvider;
  const envVar = PROVIDER_API_KEY_ENV[provider];
  if (envVar && !process.env[envVar]) {
    console.error(`Error: ${envVar} environment variable is required for provider "${provider}".`);
    process.exit(1);
  }

  await ensureDefaultSchemas();

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

  const provider = (process.env.SPORTSCLAW_PROVIDER || "anthropic") as LLMProvider;
  const envVar = PROVIDER_API_KEY_ENV[provider];
  if (envVar && !process.env[envVar]) {
    console.error(`Error: ${envVar} environment variable is required for provider "${provider}".`);
    console.error(`Set it with: export ${envVar}=<your-key>`);
    process.exit(1);
  }

  await ensureDefaultSchemas();

  const engine = new SportsClawEngine({
    provider,
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
  console.log("SportsClaw Engine v0.4.0");
  console.log("");
  console.log("Usage:");
  console.log('  sportsclaw "<prompt>"              Run a one-shot sports query');
  console.log("  sportsclaw add <sport>             Add a sport schema (e.g. nfl-data, nba-data)");
  console.log("  sportsclaw remove <sport>          Remove a sport schema");
  console.log("  sportsclaw list                    List installed sport schemas");
  console.log("  sportsclaw init                    Bootstrap all 14 default sport schemas");
  console.log("  sportsclaw listen <platform>       Start a chat listener (discord, telegram)");
  console.log("");
  console.log("Default skills (auto-loaded on first use):");
  console.log("  football-data, nfl-data, nba-data, nhl-data, mlb-data, wnba-data,");
  console.log("  tennis-data, cfb-data, cbb-data, golf-data, fastf1, kalshi,");
  console.log("  polymarket, sports-news");
  console.log("  See https://sports-skills.sh for details.");
  console.log("");
  console.log("Options:");
  console.log("  --verbose, -v    Enable verbose logging");
  console.log("  --help, -h       Show this help message");
  console.log("");
  console.log("Environment:");
  console.log("  SPORTSCLAW_PROVIDER     LLM provider: anthropic, openai, or google (default: anthropic)");
  console.log("  SPORTSCLAW_MODEL        Model override (default: depends on provider)");
  console.log("  ANTHROPIC_API_KEY       API key for Anthropic (required when provider=anthropic)");
  console.log("  OPENAI_API_KEY          API key for OpenAI (required when provider=openai)");
  console.log("  GOOGLE_GENERATIVE_AI_API_KEY  API key for Google Gemini (required when provider=google)");
  console.log("  PYTHON_PATH             Path to Python interpreter (default: python3)");
  console.log("  SPORTSCLAW_SCHEMA_DIR   Custom schema storage directory");
  console.log("  DISCORD_BOT_TOKEN       Discord bot token (for listen discord)");
  console.log("  TELEGRAM_BOT_TOKEN      Telegram bot token (for listen telegram)");
  console.log("  ALLOWED_USERS           Comma-separated user IDs for listener whitelist");
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
    case "init":
      return cmdInit(subArgs);
    case "listen":
      return cmdListen(subArgs);
    default:
      // Not a subcommand — treat the entire args as a query prompt
      return cmdQuery(args);
  }
}

import { realpathSync } from "node:fs";

// Run if executed directly
let isMain = false;
try {
  const fileUrlPath = fileURLToPath(import.meta.url);
  const realArgv1 = realpathSync(process.argv[1]);
  const realFileUrlPath = realpathSync(fileUrlPath);
  isMain = realArgv1 === realFileUrlPath;
} catch (e) {
  isMain = process.argv[1] === fileURLToPath(import.meta.url);
}

if (isMain) {
  main();
}
