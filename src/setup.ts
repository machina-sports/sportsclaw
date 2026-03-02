/**
 * sportsclaw — AI-Native Setup Wizard (`sportsclaw setup [prompt]`)
 *
 * Two-phase approach:
 *   1. Deterministic bootstrap — ensure an LLM API key is available (no AI needed)
 *   2. Agentic loop — AI guides the user through platform tokens, sport selection,
 *      and daemon startup via conversational tool use
 */

import { createInterface } from "node:readline/promises";
import {
  generateText,
  tool as defineTool,
  jsonSchema,
  stepCountIs,
  type ToolSet,
} from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import pc from "picocolors";

import {
  ENV_PATH,
  PROVIDER_ENV,
  parseEnvFile,
  writeEnvVar,
  loadConfig,
  saveConfig,
  applyConfigToEnv,
  ASCII_LOGO,
} from "./config.js";
import {
  SKILL_DESCRIPTIONS,
  fetchSportSchema,
  saveSchema,
  listSchemas,
} from "./schema.js";
import { daemonStart, isValidPlatform } from "./daemon.js";
import { formatResponse } from "./formatters/index.js";
import { DEFAULT_MODELS, type LLMProvider } from "./types.js";

// ---------------------------------------------------------------------------
// Model resolver (local copy — avoids importing engine.ts dependency chain)
// ---------------------------------------------------------------------------

function resolveModel(provider: LLMProvider, modelId: string) {
  switch (provider) {
    case "anthropic":
      return anthropic(modelId);
    case "openai":
      return openai(modelId);
    case "google":
      return google(modelId);
    default:
      throw new Error(`Unsupported provider: "${provider}".`);
  }
}

// ---------------------------------------------------------------------------
// Phase 1 — Deterministic API key bootstrap
// ---------------------------------------------------------------------------

interface BootstrapResult {
  provider: LLMProvider;
  apiKey: string;
}

async function bootstrapApiKey(): Promise<BootstrapResult> {
  // Load ~/.sportsclaw/.env into process.env (existing vars win)
  const envVars = parseEnvFile(ENV_PATH);
  for (const [k, v] of Object.entries(envVars)) {
    if (!process.env[k]) process.env[k] = v;
  }

  // Check if any provider key is already available
  const checks: Array<{ provider: LLMProvider; envVar: string }> = [
    { provider: "anthropic", envVar: "ANTHROPIC_API_KEY" },
    { provider: "openai", envVar: "OPENAI_API_KEY" },
    { provider: "google", envVar: "GOOGLE_GENERATIVE_AI_API_KEY" },
  ];

  for (const { provider, envVar } of checks) {
    const val = process.env[envVar];
    if (val && val.trim().length > 0) {
      return { provider, apiKey: val.trim() };
    }
  }

  // No key found — prompt the user
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(
      pc.dim(
        "No API key detected. Paste an Anthropic, OpenAI, or Gemini key to get started."
      )
    );
    const raw = await rl.question(pc.bold("API Key: "));
    const key = raw.trim();
    if (!key) {
      console.error("No key provided. Exiting.");
      process.exit(1);
    }

    // Detect provider from key prefix
    let provider: LLMProvider;
    if (key.startsWith("sk-")) {
      provider = "openai";
    } else if (key.startsWith("AIza")) {
      provider = "google";
    } else {
      provider = "anthropic";
    }

    const envVar = PROVIDER_ENV[provider];
    writeEnvVar(ENV_PATH, envVar, key);
    writeEnvVar(ENV_PATH, "SPORTSCLAW_PROVIDER", provider);
    process.env[envVar] = key;
    process.env.SPORTSCLAW_PROVIDER = provider;

    console.log(
      pc.green(`Saved ${envVar} to ~/.sportsclaw/.env (provider: ${provider})`)
    );
    return { provider, apiKey: key };
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Setup tools
// ---------------------------------------------------------------------------

function buildSetupTools(): ToolSet {
  const toolMap: ToolSet = {};

  toolMap["write_env_var"] = defineTool({
    description:
      "Write a key=value pair to ~/.sportsclaw/.env. Use for API keys, tokens, and config values.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        key: { type: "string", description: "Environment variable name" },
        value: { type: "string", description: "Value to set" },
      },
      required: ["key", "value"],
    }),
    execute: async (args: Record<string, unknown>) => {
      const key = String(args.key);
      const value = String(args.value);
      writeEnvVar(ENV_PATH, key, value);
      process.env[key] = value;
      return { ok: true, message: `Set ${key} in ~/.sportsclaw/.env` };
    },
  });

  toolMap["validate_telegram_token"] = defineTool({
    description:
      "Validate a Telegram bot token by calling the getMe API. Returns bot username on success.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        token: { type: "string", description: "Telegram bot token from BotFather" },
      },
      required: ["token"],
    }),
    execute: async (args: Record<string, unknown>) => {
      const token = String(args.token);
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${token}/getMe`,
          { signal: AbortSignal.timeout(10_000) }
        );
        const data = (await res.json()) as {
          ok: boolean;
          result?: { username?: string };
        };
        if (data.ok && data.result?.username) {
          return { valid: true, username: data.result.username };
        }
        return { valid: false, error: "Invalid token — Telegram rejected it." };
      } catch (err) {
        return {
          valid: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  toolMap["validate_discord_token"] = defineTool({
    description:
      "Validate a Discord bot token by calling the /users/@me API. Returns bot username on success.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        token: { type: "string", description: "Discord bot token" },
      },
      required: ["token"],
    }),
    execute: async (args: Record<string, unknown>) => {
      const token = String(args.token);
      try {
        const res = await fetch("https://discord.com/api/v10/users/@me", {
          headers: { Authorization: `Bot ${token}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          return { valid: false, error: `Discord API returned ${res.status}` };
        }
        const data = (await res.json()) as { username?: string };
        return { valid: true, username: data.username ?? "unknown" };
      } catch (err) {
        return {
          valid: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  toolMap["get_current_config"] = defineTool({
    description:
      "Get current sportsclaw configuration: which API keys are set, platforms configured, sports installed.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {},
    }),
    execute: async () => {
      const config = loadConfig();
      const envState = parseEnvFile(ENV_PATH);
      const schemas = listSchemas();

      return {
        provider: config.provider ?? process.env.SPORTSCLAW_PROVIDER ?? "not set",
        apiKeys: {
          anthropic: !!(process.env.ANTHROPIC_API_KEY || envState.ANTHROPIC_API_KEY),
          openai: !!(process.env.OPENAI_API_KEY || envState.OPENAI_API_KEY),
          google: !!(
            process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
            envState.GOOGLE_GENERATIVE_AI_API_KEY
          ),
        },
        platforms: {
          discord: !!(
            config.chatIntegrations?.discord?.botToken ||
            process.env.DISCORD_BOT_TOKEN ||
            envState.DISCORD_BOT_TOKEN
          ),
          telegram: !!(
            config.chatIntegrations?.telegram?.botToken ||
            process.env.TELEGRAM_BOT_TOKEN ||
            envState.TELEGRAM_BOT_TOKEN
          ),
        },
        installedSports: schemas,
        selectedSports: config.selectedSports ?? [],
      };
    },
  });

  toolMap["install_sports"] = defineTool({
    description:
      "Install sport schemas (skill packages). Pass an array of sport names to install.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        sports: {
          type: "array",
          items: { type: "string" },
          description:
            "Sport names to install, e.g. ['nfl', 'nba', 'football']",
        },
      },
      required: ["sports"],
    }),
    execute: async (args: Record<string, unknown>) => {
      const sports = args.sports as string[];
      const results: Array<{ sport: string; ok: boolean; error?: string }> = [];
      for (const sport of sports) {
        try {
          const schema = await fetchSportSchema(sport);
          saveSchema(schema);
          results.push({ sport, ok: true });
        } catch (err) {
          results.push({
            sport,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Persist selections
      const config = loadConfig();
      const current = new Set(config.selectedSports ?? []);
      for (const r of results) {
        if (r.ok) current.add(r.sport);
      }
      config.selectedSports = [...current];
      saveConfig(config);

      const ok = results.filter((r) => r.ok).length;
      return { installed: ok, total: sports.length, results };
    },
  });

  toolMap["start_platform"] = defineTool({
    description:
      "Start a platform listener as a background daemon (requires PM2). Platform: 'discord' or 'telegram'.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        platform: {
          type: "string",
          enum: ["discord", "telegram"],
          description: "Platform to start",
        },
      },
      required: ["platform"],
    }),
    execute: async (args: Record<string, unknown>) => {
      const platform = String(args.platform);
      if (!isValidPlatform(platform)) {
        return { ok: false, error: `Invalid platform: ${platform}` };
      }
      try {
        applyConfigToEnv();
        daemonStart(platform);
        return { ok: true, message: `${platform} daemon started.` };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  return toolMap;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  const sportList = Object.entries(SKILL_DESCRIPTIONS)
    .map(([key, desc]) => `  - ${key}: ${desc}`)
    .join("\n");

  return `You are the sportsclaw setup assistant. Your job is to configure sportsclaw quickly and correctly.

RULES:
- Ask ONE question at a time. Never dump a wall of options.
- When you receive a token, validate it IMMEDIATELY using the validation tool. Don't ask permission.
- After validating, save the token to .env using write_env_var.
- Call get_current_config FIRST to see what's already configured. Skip steps that are done.
- Be direct and efficient. No fluff, no AI cheerfulness.
- When everything is configured, say "Setup complete!" to end the wizard.

PLATFORM GUIDES:

Discord:
1. Go to https://discord.com/developers/applications
2. Create a New Application → Bot → Reset Token → copy it
3. Enable MESSAGE CONTENT INTENT under Privileged Gateway Intents
4. Invite URL: Settings → OAuth2 → URL Generator → bot scope → Send Messages + Read Message History

Telegram:
1. Open Telegram, message @BotFather
2. Send /newbot, follow the prompts
3. Copy the token BotFather gives you

AVAILABLE SPORTS:
${sportList}

Default recommendations for new users: nfl, nba, mlb, football, news

FLOW:
1. Check current config
2. If no platform tokens → ask which platform(s) the user wants
3. Collect and validate tokens
4. Ask which sports to install (suggest defaults based on user intent)
5. Install sports
6. Optionally start the daemon
7. Say "Setup complete!"

If the user provided an initial prompt with their intent, use it to skip unnecessary questions.`;
}

// ---------------------------------------------------------------------------
// Agentic loop
// ---------------------------------------------------------------------------

export async function runSetup(initialPrompt?: string): Promise<void> {
  console.log(pc.bold(pc.blue(ASCII_LOGO)));
  console.log(pc.bold("sportsclaw Setup"));
  console.log(pc.dim("AI-guided configuration wizard\n"));

  // Phase 1: deterministic API key bootstrap
  const { provider } = await bootstrapApiKey();

  // Resolve model
  const modelId = DEFAULT_MODELS[provider];
  const model = resolveModel(provider, modelId);

  // Build tools
  const tools = buildSetupTools();
  const system = buildSystemPrompt();

  // Conversation state
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  const firstMessage = initialPrompt || "Help me set up sportsclaw.";
  messages.push({ role: "user", content: firstMessage });

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const MAX_TURNS = 30;

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const result = await generateText({
        model,
        system,
        messages,
        tools,
        stopWhen: stepCountIs(10),
      });

      const text = result.text ?? "";

      if (text) {
        const rendered = formatResponse(text, "cli").text;
        console.log(rendered);
        console.log("");
      }

      messages.push({ role: "assistant", content: text });

      // Check for completion signal
      if (text.toLowerCase().includes("setup complete")) {
        break;
      }

      // If the model only called tools with no text, continue without prompting
      if (!text && result.steps && result.steps.length > 0) {
        continue;
      }

      // Prompt user for next input
      const userInput = await rl.question(pc.bold("> "));
      const trimmed = userInput.trim();

      if (!trimmed || trimmed === "exit" || trimmed === "quit") {
        console.log(pc.dim("Exiting setup."));
        break;
      }

      messages.push({ role: "user", content: trimmed });
    }
  } finally {
    rl.close();
  }
}
