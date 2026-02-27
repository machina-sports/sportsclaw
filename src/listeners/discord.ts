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

import { sportsclawEngine } from "../engine.js";
import type { LLMProvider } from "../types.js";
import { splitMessage } from "../utils.js";
import { formatResponse } from "../formatters.js";
import { executePythonBridge } from "../tools.js";
import { loadConfig } from "../config.js";
import type { DiscordFeaturesConfig } from "../config.js";

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
// Team logo fetching via sports-skills metadata
// ---------------------------------------------------------------------------

/**
 * Fetch a team logo URL from TheSportsDB via the metadata skill.
 * Returns null on failure — callers should degrade gracefully.
 */
async function fetchTeamLogo(teamName: string, pythonPath: string): Promise<string | null> {
  try {
    const result = await executePythonBridge(
      "metadata",
      "get_team_logo",
      { team_name: teamName },
      { pythonPath, timeout: 10_000 }
    );
    if (result.success && result.data && typeof result.data === "object") {
      const d = result.data as { data?: { logo_url?: string }; status?: boolean };
      return d.data?.logo_url ?? null;
    }
  } catch {
    // Non-critical — silently ignore
  }
  return null;
}

/**
 * Extract the most likely primary team name from the user's prompt.
 * Looks for patterns like "Lakers vs Suns", "How are the Lakers doing", etc.
 */
function extractPrimaryTeamFromPrompt(prompt: string): string | null {
  // "X vs Y" — take the first team
  const vsMatch = prompt.match(
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\s+(?:vs\.?|versus)\s+/i
  );
  if (vsMatch) return vsMatch[1].trim();

  // "the Lakers", "how did Arsenal", "what about the 49ers"
  const theMatch = prompt.match(
    /\b(?:the|how(?:'s|\s+are|\s+did|\s+is)?(?:\s+the)?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/i
  );
  if (theMatch) return theMatch[1].trim();

  return null;
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
}

const buttonContexts = new Map<string, ButtonContext>();
const MAX_BUTTON_CONTEXTS = 200;

function storeButtonContext(prompt: string, userId: string): string {
  const key = Math.random().toString(36).slice(2, 9);
  buttonContexts.set(key, { prompt, userId });
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
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ComponentType,
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
  // Build a Discord embed from the formatted response + optional logo
  // ---------------------------------------------------------------------------

  async function buildEmbed(
    response: string,
    prompt: string
  ): Promise<import("discord.js").EmbedBuilder> {
    const formatted = formatResponse(response, "discord");
    const embed = new EmbedBuilder();

    if (formatted.discord?.title) embed.setTitle(formatted.discord.title);
    if (formatted.discord?.description) embed.setDescription(formatted.discord.description);
    if (formatted.discord?.fields) embed.addFields(formatted.discord.fields);
    if (formatted.discord?.footer) embed.setFooter(formatted.discord.footer);
    if (formatted.discord?.color) embed.setColor(formatted.discord.color);

    // Fetch team logo from TheSportsDB
    if (features.embeds) {
      const teamName = extractPrimaryTeamFromPrompt(prompt);
      if (teamName) {
        const logoUrl = await fetchTeamLogo(teamName, pythonPath);
        if (logoUrl) {
          embed.setThumbnail(logoUrl);
        }
      }
    }

    return embed;
  }

  // ---------------------------------------------------------------------------
  // Build action row with Box Score / Play-by-Play / Full Stats buttons
  // ---------------------------------------------------------------------------

  function buildActionRow(contextKey: string): import("discord.js").ActionRowBuilder<import("discord.js").ButtonBuilder> {
    return new ActionRowBuilder<import("discord.js").ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`sc_boxscore_${contextKey}`)
        .setLabel("Box Score")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`sc_pbp_${contextKey}`)
        .setLabel("Play-by-Play")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`sc_stats_${contextKey}`)
        .setLabel("Full Stats")
        .setStyle(ButtonStyle.Secondary)
    );
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

    const actionPrompts: Record<string, string> = {
      boxscore: `Show the box score for: ${ctx.prompt}`,
      pbp: `Show the play-by-play for: ${ctx.prompt}`,
      stats: `Show full stats for: ${ctx.prompt}`,
    };

    const followUpPrompt = actionPrompts[action];
    if (!followUpPrompt) return;

    await interaction.deferReply();

    try {
      const engine = new sportsclawEngine(engineConfig);
      const response = await engine.run(followUpPrompt, { userId: ctx.userId });

      const formatted = formatResponse(response, "discord");

      if (formatted.discord) {
        const embed = new EmbedBuilder();
        if (formatted.discord.title) embed.setTitle(formatted.discord.title);
        if (formatted.discord.description) embed.setDescription(formatted.discord.description);
        if (formatted.discord.fields) embed.addFields(formatted.discord.fields);
        if (formatted.discord.footer) embed.setFooter(formatted.discord.footer);
        if (formatted.discord.color) embed.setColor(formatted.discord.color);

        await interaction.editReply({ embeds: [embed] });
      } else {
        const chunks = splitMessage(formatted.text, 2000);
        await interaction.editReply(chunks[0] ?? "No data available.");
        for (const chunk of chunks.slice(1)) {
          await interaction.followUp(chunk);
        }
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
          const [response] = await Promise.all([
            new sportsclawEngine(engineConfig).run(prompt, { userId }),
            sendPoll(message, pollTeams.team1, pollTeams.team2),
          ]);

          await sendGameResponse(response, prompt, userId, message);
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
      const response = await engine.run(prompt, { userId });

      await sendGameResponse(response, prompt, userId, message);
    } catch (error: unknown) {
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
    const formatted = formatResponse(response, "discord");

    if (formatted.discord && features.embeds) {
      const embed = await buildEmbed(response, prompt);

      const messageOptions: import("discord.js").MessageCreateOptions = {
        embeds: [embed],
      };

      // Attach action buttons to game/score responses
      if (features.buttons) {
        const contextKey = storeButtonContext(prompt, userId);
        messageOptions.components = [buildActionRow(contextKey)];
      }

      await safeSend(message, messageOptions);
    } else {
      // Fallback to plain text with 2000-char limit
      const chunks = splitMessage(formatted.text, 2000);
      for (const chunk of chunks) {
        await safeSend(message, chunk);
      }
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
