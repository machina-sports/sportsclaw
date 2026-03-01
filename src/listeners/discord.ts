/**
 * sportsclaw — Discord Listener (Sprint 1)
 *
 * Enhanced Discord bot with rich embeds (TheSportsDB logos), interactive
 * buttons (Box Score / Play-by-Play / Full Stats), and native polls.
 *
 * Environment:
 *   DISCORD_BOT_TOKEN    — Your Discord bot token
 *   SPORTSCLAW_PROVIDER  — LLM provider (anthropic, openai, google)
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY
 *   ALLOWED_USERS        — Comma-separated Discord user IDs (optional whitelist)
 *
 * Feature flags (set in ~/.sportsclaw/config.json or env):
 *   DISCORD_FEATURE_EMBEDS=false   — Disable rich embeds
 *   DISCORD_FEATURE_BUTTONS=false  — Disable action buttons
 *   DISCORD_FEATURE_POLLS=false    — Disable native polls
 *
 * The bot responds to:
 *   - Direct mentions (@sportsclaw <question>)
 *   - Messages starting with `!sportsclaw <question>` (configurable via DISCORD_PREFIX)
 */

import { spawn } from "node:child_process";
import { sportsclawEngine } from "../engine.js";
import type { LLMProvider } from "../types.js";
import { splitMessage } from "../utils.js";
import { isGameRelatedResponse } from "../formatters/index.js";
import { detectSport, detectLeague, getFilteredButtons, getFollowUpPrompt } from "../buttons.js";
import type { DetectedSport } from "../buttons.js";
import { loadConfig } from "../config.js";
import type { DiscordFeaturesConfig } from "../config.js";
import {
  AskUserQuestionHalt,
  saveSuspendedState,
  loadSuspendedState,
  clearSuspendedState,
} from "../ask.js";

const PREFIX = process.env.DISCORD_PREFIX || "!sportsclaw";

// ---------------------------------------------------------------------------
// Feature flags — resolved once at startup
// ---------------------------------------------------------------------------

function resolveFeatures(): Required<DiscordFeaturesConfig> {
  const config = loadConfig();
  const saved = config.chatIntegrations?.discord?.features ?? {};

  const flag = (envKey: string, configVal: boolean | undefined, defaultVal: boolean): boolean => {
    const env = process.env[envKey];
    if (env !== undefined) return env !== "false" && env !== "0";
    return configVal ?? defaultVal;
  };

  return {
    polls: flag("DISCORD_FEATURE_POLLS", saved.polls, true),
    embeds: flag("DISCORD_FEATURE_EMBEDS", saved.embeds, true),
    buttons: flag("DISCORD_FEATURE_BUTTONS", saved.buttons, true),
    reactions: flag("DISCORD_FEATURE_REACTIONS", saved.reactions, false),
    gameThreads: flag("DISCORD_FEATURE_GAME_THREADS", saved.gameThreads, false),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

// ---------------------------------------------------------------------------
// Poll detection
// ---------------------------------------------------------------------------

/**
 * Detect if the prompt is a "who wins?" style question.
 * Returns the two team names if found, null otherwise.
 */
function detectPollTeams(prompt: string): { team1: string; team2: string } | null {
  const isPollIntent = /who(?:'s gonna| will| do you think)?\s+win|predict|who\s+takes\s+it/i.test(prompt);
  if (!isPollIntent) return null;

  const vsMatch = prompt.match(
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\s+(?:vs\.?|versus|or)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/i
  );
  if (vsMatch) {
    return {
      team1: vsMatch[1].trim(),
      team2: vsMatch[2].trim(),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Button context store (ephemeral in-process map)
// ---------------------------------------------------------------------------

interface ButtonContext {
  prompt: string;
  userId: string;
  sport: DetectedSport;
}

const buttonContexts = new Map<string, ButtonContext>();
const MAX_BUTTON_CONTEXTS = 200;

function storeButtonContext(prompt: string, userId: string, sport: DetectedSport): string {
  const key = Math.random().toString(36).slice(2, 9);
  buttonContexts.set(key, { prompt, userId, sport });
  // Evict oldest entries beyond cap
  if (buttonContexts.size > MAX_BUTTON_CONTEXTS) {
    const firstKey = buttonContexts.keys().next().value;
    if (firstKey) buttonContexts.delete(firstKey);
  }
  return key;
}

// ---------------------------------------------------------------------------
// Main listener
// ---------------------------------------------------------------------------

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

  const {
    Client,
    GatewayIntentBits,
    Partials,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
  } = Discord;

  const features = resolveFeatures();
  const allowedUsers = getAllowedUsers();

  if (allowedUsers) {
    console.log(
      `[sportsclaw] User whitelist active: ${allowedUsers.size} user(s) allowed`
    );
  }

  console.log(
    `[sportsclaw] Discord features: embeds=${features.embeds}, buttons=${features.buttons}, polls=${features.polls}`
  );

  const pythonPath = process.env.PYTHON_PATH || "python3";

  const engineConfig = {
    provider: (
      process.env.SPORTSCLAW_PROVIDER ||
      process.env.sportsclaw_PROVIDER ||
      "anthropic"
    ) as LLMProvider,
    ...((process.env.SPORTSCLAW_MODEL || process.env.sportsclaw_MODEL) && {
      model: process.env.SPORTSCLAW_MODEL || process.env.sportsclaw_MODEL,
    }),
    ...(process.env.PYTHON_PATH && { pythonPath: process.env.PYTHON_PATH }),
    routingMode: "soft_lock" as const,
    routingMaxSkills: parsePositiveInt(
      process.env.SPORTSCLAW_ROUTING_MAX_SKILLS,
      2
    ),
    routingAllowSpillover: parsePositiveInt(
      process.env.SPORTSCLAW_ROUTING_ALLOW_SPILLOVER,
      1
    ),
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

  // ---------------------------------------------------------------------------
  // Safe send helpers
  // ---------------------------------------------------------------------------

  /** Send a reply, falling back to channel.send() if the original message is gone */
  async function safeSend(
    message: import("discord.js").Message,
    content: import("discord.js").MessageCreateOptions | string
  ): Promise<import("discord.js").Message | null> {
    try {
      return await message.reply(
        typeof content === "string" ? { content } : content
      );
    } catch {
      try {
        if ("send" in message.channel) {
          return await message.channel.send(
            typeof content === "string" ? { content } : content
          );
        }
      } catch (sendErr) {
        console.error(
          `[sportsclaw] Failed to send to channel: ${sendErr instanceof Error ? sendErr.message : sendErr}`
        );
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Send generated images/videos as Discord file attachments
  // ---------------------------------------------------------------------------

  async function sendGeneratedVideos(
    engine: sportsclawEngine,
    message: import("discord.js").Message
  ): Promise<void> {
    const { AttachmentBuilder } = Discord;
    for (const vid of engine.generatedVideos) {
      const buffer = Buffer.from(vid.data, "base64");
      const attachment = new AttachmentBuilder(buffer, {
        name: `sportsclaw_generated.mp4`,
      });
      await safeSend(message, { files: [attachment] });
    }
  }

  async function sendGeneratedImages(
    engine: sportsclawEngine,
    message: import("discord.js").Message
  ): Promise<void> {
    const { AttachmentBuilder } = Discord;
    for (const img of engine.generatedImages) {
      const buffer = Buffer.from(img.data, "base64");
      const ext = img.mimeType === "image/jpeg" ? "jpg" : "png";
      const attachment = new AttachmentBuilder(buffer, {
        name: `sportsclaw_generated.${ext}`,
      });
      await safeSend(message, { files: [attachment] });
    }
  }

  // ---------------------------------------------------------------------------
  // Build sport-aware action row from detected sport
  // ---------------------------------------------------------------------------

  function buildActionRow(contextKey: string, sport: DetectedSport, response: string, prompt: string): import("discord.js").ActionRowBuilder<import("discord.js").ButtonBuilder> | null {
    const league = detectLeague(response, prompt);
    const buttons = getFilteredButtons(sport, league);
    if (buttons.length === 0) return null;
    const row = new ActionRowBuilder<import("discord.js").ButtonBuilder>();
    for (let i = 0; i < buttons.length; i++) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`sc_${buttons[i].action}_${contextKey}`)
          .setLabel(buttons[i].label)
          .setStyle(i === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary)
      );
    }
    return row;
  }

  // ---------------------------------------------------------------------------
  // Poll creation for "who wins?" questions
  // ---------------------------------------------------------------------------

  async function sendPoll(
    message: import("discord.js").Message,
    team1: string,
    team2: string
  ): Promise<void> {
    try {
      if ("send" in message.channel) {
        await message.channel.send({
          poll: {
            question: { text: `Who wins? ${team1} vs ${team2}` },
            answers: [
              { text: team1 },
              { text: team2 },
            ],
            duration: 24,
            allowMultiselect: false,
          },
        } as Parameters<typeof message.channel.send>[0]);
      }
    } catch (err) {
      // Polls require the SEND_POLLS permission — degrade silently
      if (process.env.SPORTSCLAW_VERBOSE) {
        console.error(`[sportsclaw] Poll creation failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Button interaction handler
  // ---------------------------------------------------------------------------

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isButton()) return;

    const { customId } = interaction;
    if (!customId.startsWith("sc_")) return;

    // --- Sprint 2: AskUserQuestion response handling ---
    if (customId.startsWith("sc_ask_")) {
      const parts = customId.split("_");
      // Format: sc_ask_<stateKey>_<optionIndex>
      const stateKey = parts[2];
      const optionIdx = parseInt(parts[3], 10);

      const userId = `discord-${interaction.user.id}`;
      const suspended = await loadSuspendedState("discord", userId, stateKey);

      if (!suspended) {
        await interaction.reply({
          content: "This question has expired. Please ask again.",
          ephemeral: true,
        });
        return;
      }

      const selectedOption = suspended.question.options[optionIdx];
      if (!selectedOption) {
        await interaction.reply({
          content: "Invalid option. Please try again.",
          ephemeral: true,
        });
        return;
      }

      await clearSuspendedState("discord", userId, stateKey);
      await interaction.deferReply();

      try {
        // Resume the engine with the selected value injected as context
        const resumePrompt = `${suspended.originalPrompt}\n\n[User selected: ${selectedOption.value}]`;
        const engine = new sportsclawEngine(engineConfig);
        const response = await engine.run(resumePrompt, { userId, sessionId: userId });

        await sendGameResponse(response, suspended.originalPrompt, userId, interaction as unknown as import("discord.js").Message);
      } catch (error: unknown) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`[sportsclaw] AskUserQuestion resume error: ${errMsg}`);
        await interaction.editReply(
          "Sorry, I encountered an error processing your selection."
        );
      }
      return;
    }

    const parts = customId.split("_");
    const action = parts[1]; // boxscore | pbp | stats
    const contextKey = parts[2];

    const ctx = buttonContexts.get(contextKey);
    if (!ctx) {
      await interaction.reply({
        content: "This button has expired. Please ask your question again.",
        ephemeral: true,
      });
      return;
    }

    const followUpPrompt = getFollowUpPrompt(action, ctx.sport, ctx.prompt);
    if (!followUpPrompt) return;

    await interaction.deferReply();

    try {
      // Skip fan profile updates for button follow-ups — these are
      // data-only requests, not conversational turns.
      const engine = new sportsclawEngine({ ...engineConfig, skipFanProfile: true });
      const response = await engine.run(followUpPrompt, { userId: ctx.userId, sessionId: ctx.userId });

      const chunks = splitMessage(response, 2000);
      await interaction.editReply(chunks[0] ?? "No data available.");
      for (const chunk of chunks.slice(1)) {
        await interaction.followUp(chunk);
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[sportsclaw] Button handler error: ${errMsg}`);
      await interaction.editReply(
        "Sorry, I encountered an error processing that request."
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Message handler
  // ---------------------------------------------------------------------------

  client.on("error", (err) => {
    console.error(`[sportsclaw] Discord client error: ${err.message}`);
  });

  client.once(Discord.Events.ClientReady, () => {
    console.log(`[sportsclaw] Discord bot connected as ${client.user?.tag}`);
    console.log(
      `[sportsclaw] Listening for "${PREFIX}" commands and mentions.`
    );

    if (process.env.SPORTSCLAW_RESTART_CHANNEL_ID) {
      const channel = client.channels.cache.get(process.env.SPORTSCLAW_RESTART_CHANNEL_ID);
      if (channel && "send" in channel && typeof channel.send === "function") {
        channel.send("✅ I'm back. New configs loaded.").catch((e) => console.error("[sportsclaw] Failed to send discord restart confirmation:", e));
      }
      delete process.env.SPORTSCLAW_RESTART_CHANNEL_ID;
    }
  });

  client.on("messageCreate", async (message) => {
    // Ignore bots
    if (message.author.bot) return;

    // Check user whitelist
    if (allowedUsers && !allowedUsers.has(message.author.id)) return;

    let prompt: string | null = null;

    // Check for prefix command
    if (message.content.startsWith(PREFIX)) {
      prompt = message.content.slice(PREFIX.length).trim();
    }

    // Check for direct mention: @sportsclaw <question>
    if (!prompt && client.user && message.mentions.has(client.user)) {
      let extracted = message.content
        .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
        .trim();
      if (extracted.startsWith(PREFIX)) {
        extracted = extracted.slice(PREFIX.length).trim();
      }
      prompt = extracted;
    }

    if (!prompt) return;

    if (prompt.toLowerCase() === "restart" || prompt.toLowerCase() === "restart" || prompt.toLowerCase() === "/restart" || prompt.toLowerCase() === "claw restart") {
      await message.reply("🔄 Restarting Discord daemon to apply new configurations...");
      console.log("[sportsclaw] Restart triggered via Discord chat.");
      const child = spawn(process.execPath, [process.argv[1], "restart", "discord"], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, SPORTSCLAW_RESTART_CHANNEL_ID: message.channel.id }
      });
      child.unref();
      setTimeout(() => process.exit(0), 100);
      return;
    }

    const userId = `discord-${message.author.id}`;

    // Check for poll intent before running the engine
    if (features.polls) {
      const pollTeams = detectPollTeams(prompt);
      if (pollTeams) {
        // Run engine for analysis and also create a poll in parallel
        const typingInterval = setInterval(() => {
          message.channel.sendTyping().catch(() => {});
        }, 5_000);

        try {
          await message.channel.sendTyping();
          const pollEngine = new sportsclawEngine(engineConfig);
          const [response] = await Promise.all([
            pollEngine.run(prompt, { userId, sessionId: userId }),
            sendPoll(message, pollTeams.team1, pollTeams.team2),
          ]);

          await sendGameResponse(response, prompt, userId, message);
          await sendGeneratedImages(pollEngine, message);
          await sendGeneratedVideos(pollEngine, message);
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(`[sportsclaw] Discord error: ${errMsg}`);
          await safeSend(message, "Sorry, I encountered an error processing your request.");
        } finally {
          clearInterval(typingInterval);
        }
        return;
      }
    }

    // Standard message handling
    const typingInterval = setInterval(() => {
      message.channel.sendTyping().catch(() => {});
    }, 5_000);

    try {
      await message.channel.sendTyping();
      const engine = new sportsclawEngine(engineConfig);
      const response = await engine.run(prompt, { userId, sessionId: userId });

      await sendGameResponse(response, prompt, userId, message);
      await sendGeneratedImages(engine, message);
      await sendGeneratedVideos(engine, message);
    } catch (error: unknown) {
      // Sprint 2: AskUserQuestion — render options as Discord buttons
      if (error instanceof AskUserQuestionHalt) {
        const q = error.question;

        // Build a button row from the question options
        const stateKey = Math.random().toString(36).slice(2, 9);
        const askRow = new ActionRowBuilder<import("discord.js").ButtonBuilder>();
        for (let i = 0; i < q.options.length; i++) {
          askRow.addComponents(
            new ButtonBuilder()
              .setCustomId(`sc_ask_${stateKey}_${i}`)
              .setLabel(q.options[i].label)
              .setStyle(i === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary)
          );
        }

        // Persist state keyed by stateKey so concurrent questions don't collide
        await saveSuspendedState(
          {
            platform: "discord",
            userId,
            question: q,
            createdAt: new Date().toISOString(),
            originalPrompt: prompt,
          },
          stateKey
        );

        await safeSend(message, {
          content: q.prompt,
          components: [askRow],
        });
        return;
      }

      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[sportsclaw] Discord error: ${errMsg}`);
      await safeSend(
        message,
        "Sorry, I encountered an error processing your request."
      );
    } finally {
      clearInterval(typingInterval);
    }
  });

  // ---------------------------------------------------------------------------
  // Unified response sender (embed + optional buttons)
  // ---------------------------------------------------------------------------

  async function sendGameResponse(
    response: string,
    prompt: string,
    userId: string,
    message: import("discord.js").Message
  ): Promise<void> {
    const chunks = splitMessage(response, 2000);

    // Build action buttons for game-related responses
    let actionRow: import("discord.js").ActionRowBuilder<import("discord.js").ButtonBuilder> | null = null;
    if (features.buttons && isGameRelatedResponse(response, prompt)) {
      const sport = detectSport(response, prompt);
      const contextKey = storeButtonContext(prompt, userId, sport);
      actionRow = buildActionRow(contextKey, sport, response, prompt);
    }

    // Send all chunks; attach buttons to the last one
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const options: import("discord.js").MessageCreateOptions = {
        content: chunks[i],
      };
      if (isLast && actionRow) {
        options.components = [actionRow];
      }
      await safeSend(message, options);
    }
  }

  // ---------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------

  try {
    await client.login(process.env.DISCORD_BOT_TOKEN);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("disallowed intents")) {
      console.error("[sportsclaw] Error: Discord rejected the connection due to disallowed intents.");
      console.error("");
      console.error("The Message Content Intent must be enabled in the Discord Developer Portal:");
      console.error("  1. Go to https://discord.com/developers/applications");
      console.error("  2. Select your bot → Bot tab");
      console.error("  3. Enable 'Message Content Intent' under Privileged Gateway Intents");
      console.error("  4. Save and retry: sportsclaw listen discord");
      process.exit(1);
    }
    if (msg.includes("TOKEN_INVALID") || msg.includes("invalid token")) {
      console.error("[sportsclaw] Error: Invalid Discord bot token.");
      console.error("Update it with: sportsclaw config");
      console.error("Or set the DISCORD_BOT_TOKEN environment variable.");
      process.exit(1);
    }
    throw err;
  }
}
