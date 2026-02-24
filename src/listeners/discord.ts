/**
 * SportsClaw — Discord Listener (Phase 4)
 *
 * A simple Discord bot that pipes messages to the SportsClaw engine.
 * Requires the `discord.js` package (optional dependency).
 *
 * Environment:
 *   DISCORD_BOT_TOKEN    — Your Discord bot token
 *   ANTHROPIC_API_KEY    — Anthropic API key for the engine
 *
 * The bot responds to:
 *   - Direct mentions (@SportsClaw <question>)
 *   - Messages starting with `!claw <question>`
 */

import { SportsClawEngine } from "../engine.js";

const PREFIX = "!claw";

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

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  const engine = new SportsClawEngine({
    ...(process.env.SPORTSCLAW_MODEL && { model: process.env.SPORTSCLAW_MODEL }),
    ...(process.env.PYTHON_PATH && { pythonPath: process.env.PYTHON_PATH }),
  });

  client.once("ready", () => {
    console.log(`[sportsclaw] Discord bot connected as ${client.user?.tag}`);
    console.log(`[sportsclaw] Listening for "${PREFIX}" commands and mentions.`);
  });

  client.on("messageCreate", async (message) => {
    // Ignore bots
    if (message.author.bot) return;

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

      engine.reset();
      const response = await engine.run(prompt);

      // Discord has a 2000 char limit — split if needed
      const chunks = splitMessage(response, 2000);
      for (const chunk of chunks) {
        await message.reply(chunk);
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[sportsclaw] Discord error: ${errMsg}`);
      await message.reply("Sorry, I encountered an error processing your request.");
    }
  });

  await client.login(process.env.DISCORD_BOT_TOKEN);
}

/** Split a message into chunks that fit Discord's character limit */
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx <= 0) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  return chunks;
}
