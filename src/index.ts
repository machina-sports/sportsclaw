#!/usr/bin/env node
/**
 * sportsclaw Engine — CLI Entry Point
 *
 * Subcommands:
 *   sportsclaw add <sport>       — Inject a sport schema from the Python package
 *   sportsclaw remove <sport>    — Remove a previously added sport schema
 *   sportsclaw list              — List all installed sport schemas
 *   sportsclaw init              — Bootstrap all 14 default sport schemas
 *   sportsclaw chat              — Start an interactive conversation (REPL)
 *   sportsclaw listen <platform> — Start a Discord or Telegram listener
 *   sportsclaw "<prompt>"        — Run a one-shot query (default)
 *
 * Or import as a library:
 *   import { sportsclawEngine } from "sportsclaw-engine-core";
 *   const engine = new sportsclawEngine();
 *   const answer = await engine.run("What are today's NBA scores?");
 */

import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { Marked, type MarkedExtension } from "marked";
import { markedTerminal } from "marked-terminal";
import { sportsclawEngine } from "./engine.js";
import { MemoryManager } from "./memory.js";
import {
  fetchSportSchema,
  saveSchema,
  removeSchema,
  listSchemas,
  getSchemaDir,
  bootstrapDefaultSchemas,
  ensureSportsSkills,
  DEFAULT_SKILLS,
} from "./schema.js";
import type { LLMProvider, ToolProgressEvent } from "./types.js";
import {
  loadConfig,
  saveConfig,
  resolveConfig,
  applyConfigToEnv,
  runConfigFlow,
  ASCII_LOGO,
} from "./config.js";

// ---------------------------------------------------------------------------
// Re-exports for library usage
// ---------------------------------------------------------------------------

export { sportsclawEngine } from "./engine.js";
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
  ensureSportsSkills,
  DEFAULT_SKILLS,
} from "./schema.js";
export { MemoryManager, getMemoryDir } from "./memory.js";
export {
  loadConfig,
  saveConfig,
  resolveConfig,
  applyConfigToEnv,
  runConfigFlow,
} from "./config.js";
export type { CLIConfig, ResolvedConfig } from "./config.js";
export type {
  LLMProvider,
  sportsclawConfig,
  RunOptions,
  ToolProgressEvent,
  ToolSpec,
  PythonBridgeResult,
  TurnResult,
  SportSchema,
  SportToolDef,
} from "./types.js";

// ---------------------------------------------------------------------------
// Markdown terminal renderer
// ---------------------------------------------------------------------------

const terminalExt = markedTerminal({
  strong: pc.bold,
  em: pc.italic,
  heading: pc.bold,
  firstHeading: pc.bold,
  codespan: pc.yellow,
  code: pc.yellow,
  del: pc.strikethrough,
  link: pc.cyan,
  href: pc.underline,
}) as MarkedExtension;

// Patch: marked-terminal's `text` renderer doesn't parse inline tokens
// (strong, em, etc.) inside non-loose list items. Override it so bold works
// everywhere, not just in paragraphs.
const origTextRenderer = (terminalExt as { renderer: Record<string, Function> }).renderer.text;
(terminalExt as { renderer: Record<string, Function> }).renderer.text = function (
  this: { parser: { parseInline(tokens: unknown[]): string } },
  token: string | { tokens?: unknown[]; text: string },
) {
  if (typeof token === "object" && token.tokens) {
    return this.parser.parseInline(token.tokens);
  }
  return origTextRenderer.call(this, token);
};

const md = new Marked(terminalExt);

function renderMarkdown(text: string): string {
  const rendered = md.parse(text);
  if (typeof rendered !== "string") return text;
  // marked-terminal adds a trailing newline; trim to avoid double-spacing
  return rendered.replace(/\n+$/, "");
}

// ---------------------------------------------------------------------------
// Tool progress tracker for spinner display
// ---------------------------------------------------------------------------

interface ToolState {
  label: string;
  skillName?: string;
  status: "running" | "done" | "failed";
  durationMs?: number;
}

/** Format a tool name for display: strip the skill prefix for brevity */
function toolLabel(toolName: string, skillName?: string): string {
  if (skillName) {
    // e.g. "football_get_team_schedule" → "get_team_schedule" when skill is "football"
    const prefix = skillName.replace(/-/g, "_") + "_";
    if (toolName.startsWith(prefix)) {
      return toolName.slice(prefix.length);
    }
  }
  return toolName;
}

function createToolTracker(spinner: { message(msg?: string): void }) {
  const tools = new Map<string, ToolState>();

  // @clack spinner renders: `${frame}  ${message}` (icon + 2 spaces)
  // Subsequent lines in a multi-line message need 3 chars to align.
  const PAD = "   ";

  function formatLine(t: ToolState, isFirst: boolean): string {
    const skill = t.skillName ? `sports-skills/${t.skillName}` : "agent";
    const prefix = isFirst ? "" : PAD;
    if (t.status === "running") {
      return `${prefix}${pc.dim("\u25CB")} ${skill}: ${t.label}...`;
    }
    const sec = t.durationMs != null ? ` ${(t.durationMs / 1000).toFixed(1)}s` : "";
    const icon = t.status === "done" ? pc.green("\u2713") : pc.red("\u2717");
    return `${prefix}${icon} ${skill}: ${t.label}${sec}`;
  }

  function render() {
    const entries = Array.from(tools.values());
    const done = entries.filter(t => t.status !== "running");
    const running = entries.filter(t => t.status === "running");

    const lines: string[] = [];
    const all = [...done, ...running];
    for (let i = 0; i < all.length; i++) {
      lines.push(formatLine(all[i], i === 0));
    }

    spinner.message(lines.join("\n"));
  }

  /** Summary of all tools used — for the spinner stop message */
  function summary(): string {
    const entries = Array.from(tools.values());
    if (entries.length === 0) return "Done.";

    const lines: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      const t = entries[i];
      const sec = t.durationMs != null ? ` ${(t.durationMs / 1000).toFixed(1)}s` : "";
      const icon = t.status === "done" ? pc.green("\u2713") : t.status === "failed" ? pc.red("\u2717") : "\u2026";
      const skill = t.skillName ? `sports-skills/${t.skillName}` : "agent";
      const prefix = i === 0 ? "" : PAD;
      lines.push(`${prefix}${icon} ${skill}: ${t.label}${sec}`);
    }
    return lines.join("\n");
  }

  const handler = (event: ToolProgressEvent) => {
    switch (event.type) {
      case "tool_start":
        tools.set(event.toolCallId, {
          label: toolLabel(event.toolName, event.skillName),
          skillName: event.skillName,
          status: "running",
        });
        render();
        break;
      case "tool_finish":
        tools.set(event.toolCallId, {
          label: toolLabel(event.toolName, event.skillName),
          skillName: event.skillName,
          status: event.success ? "done" : "failed",
          durationMs: event.durationMs,
        });
        render();
        break;
      case "synthesizing":
        spinner.message(tools.size > 0 ? `${tools.size} tools done \u00b7 Synthesizing...` : "Synthesizing...");
        break;
    }
  };

  return { handler, summary };
}

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

  const { pythonPath } = resolveConfig();
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
  const { pythonPath } = resolveConfig();

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
  // Always preflight sports-skills (including F1) even when schemas already exist.
  const { pythonPath } = resolveConfig();
  await ensureSportsSkills({ pythonPath });

  const installed = listSchemas();
  if (installed.length > 0) return; // schemas already exist

  console.error(
    "[sportsclaw] No sport schemas found. Bootstrapping defaults..."
  );
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

  const resolved = applyConfigToEnv();
  if (!resolved.apiKey) {
    await runConfigFlow();
    applyConfigToEnv();
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
// CLI: `sportsclaw chat` — persistent REPL conversation
// ---------------------------------------------------------------------------

async function cmdChat(args: string[]): Promise<void> {
  const verbose = args.includes("--verbose") || args.includes("-v");
  const userId = "cli-chat";

  // Merge config file + env vars, push into process.env
  let resolved = applyConfigToEnv();

  // No API key → interactive setup
  if (!resolved.apiKey) {
    await runConfigFlow();
    resolved = applyConfigToEnv();
  }

  await ensureDefaultSchemas();

  const engine = new sportsclawEngine({
    provider: resolved.provider,
    ...(resolved.model && { model: resolved.model }),
    pythonPath: resolved.pythonPath,
    verbose,
  });

  // Clear screen for a fresh start
  process.stdout.write("\x1B[2J\x1B[H");

  console.log(pc.bold(pc.blue(ASCII_LOGO)));
  p.intro("sportsclaw chat — type 'exit' or 'quit' to leave");

  // Welcome message — evolves with the relationship
  const memory = new MemoryManager(userId);
  const soulRaw = await memory.readSoul();
  const soul = memory.parseSoulHeader(soulRaw);

  if (soul.exchanges >= 20) {
    console.log("\nWhat's good. Let's get into it.\n");
  } else if (soul.exchanges >= 6) {
    console.log(
      "\nWelcome back. I know what you're into by now — ask me anything " +
      "or just say \"what's new\" and I'll catch you up.\n"
    );
  } else if (soul.exchanges >= 1) {
    console.log(
      "\nGood to see you again. Still getting to know your taste — " +
      "keep talking to me and I'll get sharper.\n"
    );
  } else {
    console.log(
      "\nHey! Ask me anything about sports — scores, standings, news, odds, " +
      "you name it. The more we talk, the more I learn what you care about " +
      "and how you like it delivered.\n"
    );
  }

  // REPL loop — each turn feeds history back through the same engine instance
  while (true) {
    const input = await p.text({
      message: "You",
      placeholder: "Ask about any sport...",
    });

    if (p.isCancel(input)) {
      p.outro("See you.");
      break;
    }

    const prompt = (input as string).trim();
    if (!prompt) continue;
    if (prompt === "exit" || prompt === "quit") {
      p.outro("See you.");
      break;
    }

    if (verbose) {
      try {
        const result = await engine.run(prompt, { userId });
        console.log(`\n${renderMarkdown(result)}\n`);
      } catch (error: unknown) {
        if (error instanceof Error) {
          console.error(`Error: ${error.message}`);
        } else {
          console.error("An unknown error occurred:", error);
        }
      }
    } else {
      const s = p.spinner();
      s.start("Thinking...");
      const tracker = createToolTracker(s);
      try {
        const result = await engine.run(prompt, {
          userId,
          onProgress: tracker.handler,
        });
        s.stop(tracker.summary());
        console.log(`\n${renderMarkdown(result)}\n`);
      } catch (error: unknown) {
        s.stop(tracker.summary() || "Error.");
        if (error instanceof Error) {
          console.error(`Error: ${error.message}`);
        } else {
          console.error("An unknown error occurred:", error);
        }
      }
    }
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

  // Merge config file + env vars (env wins), push into process.env
  let resolved = applyConfigToEnv();

  // No API key anywhere → interactive setup
  if (!resolved.apiKey) {
    await runConfigFlow();
    resolved = applyConfigToEnv();
  }

  await ensureDefaultSchemas();

  const engine = new sportsclawEngine({
    provider: resolved.provider,
    ...(resolved.model && { model: resolved.model }),
    pythonPath: resolved.pythonPath,
    verbose,
  });

  if (verbose) {
    // Verbose mode: no spinner, raw console.error logs
    try {
      const result = await engine.run(prompt);
      console.log(renderMarkdown(result));
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
        console.error(error.stack);
      } else {
        console.error("An unknown error occurred:", error);
      }
      process.exit(1);
    }
  } else {
    // Normal mode: show a reasoning spinner
    const s = p.spinner();
    s.start("Thinking...");
    const tracker = createToolTracker(s);
    try {
      const result = await engine.run(prompt, {
        onProgress: tracker.handler,
      });
      s.stop(tracker.summary());
      console.log(renderMarkdown(result));
    } catch (error: unknown) {
      s.stop(tracker.summary() || "Error.");
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
      } else {
        console.error("An unknown error occurred:", error);
      }
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log("sportsclaw Engine v0.4.1");
  console.log("");
  console.log("Usage:");
  console.log('  sportsclaw "<prompt>"              Run a one-shot sports query');
  console.log("  sportsclaw chat                    Start an interactive conversation (REPL)");
  console.log("  sportsclaw config                  Run interactive configuration wizard");
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
  console.log("Configuration:");
  console.log("  Config file: ~/.sportsclaw/config.json (created by `sportsclaw config`)");
  console.log("  Environment variables override config file values.");
  console.log("");
  console.log("Environment:");
  console.log("  sportsclaw_PROVIDER     LLM provider: anthropic, openai, or google (default: anthropic)");
  console.log("  sportsclaw_MODEL        Model override (default: depends on provider)");
  console.log("  ANTHROPIC_API_KEY       API key for Anthropic (required when provider=anthropic)");
  console.log("  OPENAI_API_KEY          API key for OpenAI (required when provider=openai)");
  console.log("  GOOGLE_GENERATIVE_AI_API_KEY  API key for Google Gemini (required when provider=google)");
  console.log("  PYTHON_PATH             Path to Python interpreter (default: python3)");
  console.log("  sportsclaw_SCHEMA_DIR   Custom schema storage directory");
  console.log("  DISCORD_BOT_TOKEN       Discord bot token (for listen discord)");
  console.log("  TELEGRAM_BOT_TOKEN      Telegram bot token (for listen telegram)");
  console.log("  ALLOWED_USERS           Comma-separated user IDs for listener whitelist");
}

// ---------------------------------------------------------------------------
// CLI: `sportsclaw config` — interactive configuration wizard
// ---------------------------------------------------------------------------

async function cmdConfig(): Promise<void> {
  await runConfigFlow();
}

// ---------------------------------------------------------------------------
// Main — route subcommands
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  // No arguments: show help, or trigger config if no API key configured
  if (args.length === 0) {
    const resolved = resolveConfig();
    if (!resolved.apiKey) {
      await runConfigFlow();
      applyConfigToEnv();
    }
    printHelp();
    process.exit(0);
  }

  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case "config":
      return cmdConfig();
    case "chat":
      return cmdChat(subArgs);
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
