/**
 * SportsClaw — Discord Listener (Phase 4)
 *
 * A simple Discord bot that pipes messages to the SportsClaw engine.
 * Requires the `discord.js` package (optional dependency).
 *
 * Environment:
 *   DISCORD_BOT_TOKEN    — Your Discord bot token
 *   SPORTSCLAW_PROVIDER  — LLM provider (anthropic, openai, google)
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY
 *   ALLOWED_USERS        — Comma-separated Discord user IDs (optional whitelist)
 *
 * The bot responds to:
 *   - Direct mentions (@SportsClaw <question>)
 *   - Messages starting with `!claw <question>`
 */

import { SportsClawEngine } from "../engine.js";
import type { LLMProvider } from "../types.js";
import { splitMessage } from "../utils.js";

const PREFIX = "!claw";

/** Parse ALLOWED_USERS env var into a Set of user IDs, or null if unset */
function getAllowedUsers(): Set<string> | null {
  const raw = process.env.ALLOWED_USERS;
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null;
}

export async function startDiscordListener(): Promise<void> {
  // Dynamic import — discord.js is an optional dependency
  let Discord: typeof import("discord.js");
  try {
    Discord = await import("discord.js");
  } catch {
    console.error("Error: discord.js is not installed.");
    console.error("Install it with: npm install discord.js");
    process.exit(1);
  }

  const { Client, GatewayIntentBits, Partials } = Discord;

  const allowedUsers = getAllowedUsers();
  if (allowedUsers) {
    console.log(
      `[sportsclaw] User whitelist active: ${allowedUsers.size} user(s) allowed`
    );
  }

  const engineConfig = {
    provider: (process.env.SPORTSCLAW_PROVIDER || "anthropic") as LLMProvider,
    ...(process.env.SPORTSCLAW_MODEL && {
      model: process.env.SPORTSCLAW_MODEL,
    }),
    ...(process.env.PYTHON_PATH && { pythonPath: process.env.PYTHON_PATH }),
  };

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  client.once("ready", () => {
    console.log(`[sportsclaw] Discord bot connected as ${client.user?.tag}`);
    console.log(
      `[sportsclaw] Listening for "${PREFIX}" commands and mentions.`
    );
  });

  client.on("messageCreate", async (message) => {
    // Ignore bots
    if (message.author.bot) return;

    // Check user whitelist
    if (allowedUsers && !allowedUsers.has(message.author.id)) return;

    let prompt: string | null = null;

    // Check for prefix command: !claw <question>
    if (message.content.startsWith(PREFIX)) {
      prompt = message.content.slice(PREFIX.length).trim();
    }

    // Check for direct mention: @SportsClaw <question>
    if (!prompt && client.user && message.mentions.has(client.user)) {
      prompt = message.content
        .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
        .trim();
    }

    if (!prompt) return;

    try {
      // Show typing indicator
      await message.channel.sendTyping();

      // Fresh engine per request — avoids shared-state race conditions
      const engine = new SportsClawEngine(engineConfig);
      const response = await engine.run(prompt);

      // Discord has a 2000 char limit — split if needed
      const chunks = splitMessage(response, 2000);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[sportsclaw] Discord error: ${errMsg}`);
      await message.reply(
        "Sorry, I encountered an error processing your request."
      );
    }
  });

  await client.login(process.env.DISCORD_BOT_TOKEN);
}
