/**
 * sportsclaw Engine — Persistent CLI Configuration
 *
 * Reads/writes user config from ~/.sportsclaw/config.json.
 * Environment variables always override config file values.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pc from "picocolors";
import * as p from "@clack/prompts";
import {
  DEFAULT_MODELS,
  PROVIDER_MODEL_PROFILES,
  type LLMProvider,
} from "./types.js";
import {
  SKILL_DESCRIPTIONS,
  DEFAULT_SKILLS,
  fetchSportSchema,
  saveSchema,
  listSchemas,
} from "./schema.js";
import {
  checkPythonVersion,
  findBestPython,
  detectHomebrew,
  detectPlatformPackageManager,
  installHomebrew,
  installPythonViaPackageManager,
  MIN_PYTHON_VERSION,
} from "./python.js";

// ---------------------------------------------------------------------------
// Config shape persisted to disk
// ---------------------------------------------------------------------------

export const SPORTS_SKILLS_DISCLAIMER =
  `sportsclaw uses the open-source sports-skills package for live sports data.\n` +
  `sports-skills is provided "as is" for personal, non-commercial use.\n` +
  `You are solely responsible for how you use the data it provides.`;

/** Feature toggles for Discord-specific capabilities */
export interface DiscordFeaturesConfig {
  polls?: boolean;       // Native Discord polls for "who wins?" questions (default: true)
  embeds?: boolean;      // Rich embeds with team logos from TheSportsDB (default: true)
  buttons?: boolean;     // Action buttons: Box Score, Play-by-Play, Full Stats (default: true)
  reactions?: boolean;   // Emoji reactions on messages (default: false)
  gameThreads?: boolean; // Auto-create threads per live game (default: false)
}

/** Channel routing for Discord alerts and game threads */
export interface DiscordChannelsConfig {
  alerts?: string;      // Channel ID for proactive score alerts
  gameThreads?: string; // Category ID for auto-created game threads
}

/** Per-platform chat integration config */
export interface DiscordIntegrationConfig {
  botToken?: string;
  allowedUsers?: string[];   // Discord user ID strings
  prefix?: string;           // Default: "!sportsclaw"
  features?: DiscordFeaturesConfig;
  channels?: DiscordChannelsConfig;
}

/** Per-platform chat integration config for Telegram */
export interface TelegramIntegrationConfig {
  botToken?: string;
  allowedUsers?: string[];   // Telegram user ID strings
}

export interface ChatIntegrationsConfig {
  discord?: DiscordIntegrationConfig;
  telegram?: TelegramIntegrationConfig;
}

export interface CLIConfig {
  provider?: LLMProvider;
  model?: string;
  apiKey?: string;
  pythonPath?: string;
  routingMode?: "soft_lock";
  routingMaxSkills?: number;
  routingAllowSpillover?: number;
  selectedSports?: string[];
  chatIntegrations?: ChatIntegrationsConfig;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CONFIG_DIR = join(homedir(), ".sportsclaw");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const ENV_TELEGRAM_PATH = join(CONFIG_DIR, ".env.telegram");

// ---------------------------------------------------------------------------
// Provider ↔ API key env var mapping (duplicated here to avoid circular deps)
// ---------------------------------------------------------------------------

const PROVIDER_ENV: Record<LLMProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

export const ASCII_LOGO = `
███████╗██████╗  ██████╗ ██████╗ ████████╗███████╗ ██████╗██╗      █████╗ ██╗    ██╗
██╔════╝██╔══██╗██╔═══██╗██╔══██╗╚══██╔══╝██╔════╝██╔════╝██║     ██╔══██╗██║    ██║
███████╗██████╔╝██║   ██║██████╔╝   ██║   ███████╗██║     ██║     ███████║██║ █╗ ██║
╚════██║██╔═══╝ ██║   ██║██╔══██╗   ██║   ╚════██║██║     ██║     ██╔══██║██║███╗██║
███████║██║     ╚██████╔╝██║  ██║   ██║   ███████║╚██████╗███████╗██║  ██║╚███╔███╔╝
╚══════╝╚═╝      ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝ ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝
`;

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

export function loadConfig(): CLIConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as CLIConfig;
  } catch {
    return {};
  }
}

export function saveConfig(config: CLIConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Merge: config file + env vars (env wins)
// ---------------------------------------------------------------------------

export interface ResolvedConfig {
  provider: LLMProvider;
  model: string | undefined;
  apiKey: string | undefined;
  pythonPath: string;
  routingMode: "soft_lock";
  routingMaxSkills: number;
  routingAllowSpillover: number;
  discordBotToken: string | undefined;
  discordAllowedUsers: string[] | undefined;
  discordPrefix: string;
  telegramBotToken: string | undefined;
  telegramAllowedUsers: string[] | undefined;
}

function firstEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number
): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Read a token value from a dotenv-style file (KEY=VALUE format).
 * Returns the value for the given key, or undefined if not found.
 */
function readEnvFile(filePath: string, key: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const content = readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;
      const k = trimmed.slice(0, eqIdx).trim();
      let v = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (k === key) return v || undefined;
    }
  } catch {
    // Ignore read errors
  }
  return undefined;
}

export function resolveConfig(): ResolvedConfig {
  const file = loadConfig();

  const provider = (
    firstEnv("SPORTSCLAW_PROVIDER", "sportsclaw_PROVIDER") ||
    file.provider ||
    "anthropic"
  ) as LLMProvider;
  const envVar = PROVIDER_ENV[provider];

  const model =
    firstEnv("SPORTSCLAW_MODEL", "sportsclaw_MODEL") ||
    file.model ||
    DEFAULT_MODELS[provider];

  // env var > config-file apiKey (only if provider matches)
  const apiKey = process.env[envVar] || file.apiKey;
  const defaultPythonPath = existsSync("/opt/homebrew/bin/python3")
    ? "/opt/homebrew/bin/python3"
    : "python3";
  const configuredPython = firstEnv("PYTHON_PATH") || file.pythonPath;
  // Migrate generic "python3" configs to Homebrew Python automatically when present.
  const pythonPath =
    configuredPython && configuredPython !== "python3"
      ? configuredPython
      : defaultPythonPath;

  const routingMode = "soft_lock";
  const routingMaxSkills = parsePositiveInt(
    firstEnv("SPORTSCLAW_ROUTING_MAX_SKILLS", "sportsclaw_ROUTING_MAX_SKILLS") ??
      (typeof file.routingMaxSkills === "number"
        ? String(file.routingMaxSkills)
        : undefined),
    2
  );
  const routingAllowSpillover = parsePositiveInt(
    firstEnv(
      "SPORTSCLAW_ROUTING_ALLOW_SPILLOVER",
      "sportsclaw_ROUTING_ALLOW_SPILLOVER"
    ) ??
      (typeof file.routingAllowSpillover === "number"
        ? String(file.routingAllowSpillover)
        : undefined),
    1
  );

  const discordBotToken =
    firstEnv("DISCORD_BOT_TOKEN") || file.chatIntegrations?.discord?.botToken;
  const discordAllowedUsersRaw = firstEnv("ALLOWED_USERS");
  const discordAllowedUsers = discordAllowedUsersRaw
    ? discordAllowedUsersRaw.split(",").map(id => id.trim()).filter(Boolean)
    : file.chatIntegrations?.discord?.allowedUsers;
  const discordPrefix =
    firstEnv("DISCORD_PREFIX") || file.chatIntegrations?.discord?.prefix || "!sportsclaw";

  // Telegram: env var > config file > .env.telegram file
  const telegramBotToken =
    firstEnv("TELEGRAM_BOT_TOKEN") ||
    file.chatIntegrations?.telegram?.botToken ||
    readEnvFile(ENV_TELEGRAM_PATH, "TELEGRAM_BOT_TOKEN");
  const telegramAllowedUsersRaw = firstEnv("TELEGRAM_ALLOWED_USERS");
  const telegramAllowedUsers = telegramAllowedUsersRaw
    ? telegramAllowedUsersRaw.split(",").map(id => id.trim()).filter(Boolean)
    : file.chatIntegrations?.telegram?.allowedUsers;

  return {
    provider,
    model,
    apiKey,
    pythonPath,
    routingMode,
    routingMaxSkills,
    routingAllowSpillover,
    discordBotToken,
    discordAllowedUsers,
    discordPrefix,
    telegramBotToken,
    telegramAllowedUsers,
  };
}

/**
 * Apply saved config into process.env so downstream code (engine, listeners)
 * picks it up transparently. Env vars already set take precedence.
 */
export function applyConfigToEnv(): ResolvedConfig {
  const resolved = resolveConfig();

  const envVar = PROVIDER_ENV[resolved.provider];
  if (resolved.apiKey && !process.env[envVar]) {
    process.env[envVar] = resolved.apiKey;
  }
  if (resolved.model && !process.env.sportsclaw_MODEL) {
    process.env.sportsclaw_MODEL = resolved.model;
  }
  if (resolved.model && !process.env.SPORTSCLAW_MODEL) {
    process.env.SPORTSCLAW_MODEL = resolved.model;
  }
  if (!process.env.sportsclaw_PROVIDER) {
    process.env.sportsclaw_PROVIDER = resolved.provider;
  }
  if (!process.env.SPORTSCLAW_PROVIDER) {
    process.env.SPORTSCLAW_PROVIDER = resolved.provider;
  }
  if (!process.env.SPORTSCLAW_ROUTING_MODE) {
    process.env.SPORTSCLAW_ROUTING_MODE = resolved.routingMode;
  }
  if (!process.env.PYTHON_PATH && resolved.pythonPath !== "python3") {
    process.env.PYTHON_PATH = resolved.pythonPath;
  }
  if (!process.env.SPORTSCLAW_ROUTING_MAX_SKILLS) {
    process.env.SPORTSCLAW_ROUTING_MAX_SKILLS = String(resolved.routingMaxSkills);
  }
  if (!process.env.sportsclaw_ROUTING_MAX_SKILLS) {
    process.env.sportsclaw_ROUTING_MAX_SKILLS = String(resolved.routingMaxSkills);
  }
  if (!process.env.SPORTSCLAW_ROUTING_ALLOW_SPILLOVER) {
    process.env.SPORTSCLAW_ROUTING_ALLOW_SPILLOVER = String(
      resolved.routingAllowSpillover
    );
  }
  if (!process.env.sportsclaw_ROUTING_ALLOW_SPILLOVER) {
    process.env.sportsclaw_ROUTING_ALLOW_SPILLOVER = String(
      resolved.routingAllowSpillover
    );
  }

  if (resolved.discordBotToken && !process.env.DISCORD_BOT_TOKEN)
    process.env.DISCORD_BOT_TOKEN = resolved.discordBotToken;
  if (resolved.discordAllowedUsers?.length && !process.env.ALLOWED_USERS)
    process.env.ALLOWED_USERS = resolved.discordAllowedUsers.join(",");
  if (resolved.discordPrefix && !process.env.DISCORD_PREFIX)
    process.env.DISCORD_PREFIX = resolved.discordPrefix;

  if (resolved.telegramBotToken && !process.env.TELEGRAM_BOT_TOKEN)
    process.env.TELEGRAM_BOT_TOKEN = resolved.telegramBotToken;
  if (resolved.telegramAllowedUsers?.length && !process.env.TELEGRAM_ALLOWED_USERS)
    process.env.TELEGRAM_ALLOWED_USERS = resolved.telegramAllowedUsers.join(",");

  return resolved;
}

// ---------------------------------------------------------------------------
// Interactive setup via @clack/prompts
// ---------------------------------------------------------------------------

export async function runConfigFlow(): Promise<CLIConfig> {
  console.log(pc.bold(pc.blue(ASCII_LOGO)));
  p.intro("🦞 sportsclaw Configuration");

  const savedConfig = loadConfig();

  function hasApiKey(prov: LLMProvider): boolean {
    if (process.env[PROVIDER_ENV[prov]]) return true;
    if (savedConfig.provider === prov && savedConfig.apiKey) return true;
    return false;
  }

  const provider = await p.select({
    message: "⚡ Which LLM provider would you like to use?",
    options: [
      { value: "anthropic", label: "Anthropic", hint: hasApiKey("anthropic") ? "Claude · authenticated" : "Claude" },
      { value: "openai", label: "OpenAI", hint: hasApiKey("openai") ? "GPT · authenticated" : "GPT" },
      { value: "google", label: "Google", hint: hasApiKey("google") ? "Gemini · authenticated" : "Gemini" },
    ],
  });

  if (p.isCancel(provider)) {
    p.cancel("🚫 Setup cancelled.");
    process.exit(0);
  }

  const model = await p.select({
    message: "🧠 Which model?",
    options:
      PROVIDER_MODEL_PROFILES[provider as LLMProvider]?.selectableModels ?? [],
  });

  if (p.isCancel(model)) {
    p.cancel("🚫 Setup cancelled.");
    process.exit(0);
  }

  const selectedProvider = provider as LLMProvider;
  const envName = PROVIDER_ENV[selectedProvider];
  const existingKey = process.env[PROVIDER_ENV[selectedProvider]]
    || (savedConfig.provider === selectedProvider ? savedConfig.apiKey : undefined);

  let finalApiKey: string;

  if (existingKey && existingKey.trim().length > 0) {
    p.log.info(`Using existing ${envName} (already configured).`);
    finalApiKey = existingKey.trim();
  } else {
    const apiKey = await p.password({
      message: `🔑 Paste your ${envName}:`,
      validate: (val) => {
        if (!val || val.trim().length === 0) return "API key is required.";
      },
    });

    if (p.isCancel(apiKey)) {
      p.cancel("🚫 Setup cancelled.");
      process.exit(0);
    }
    finalApiKey = (apiKey as string).trim();
  }

  // --- Smart Python prerequisite detection & guided install ---
  let detectedPython = findBestPython();

  if (detectedPython) {
    p.log.success(
      `Python ${detectedPython.version.version} detected at ${detectedPython.path}`
    );
  } else {
    p.log.warn(
      `Python ${MIN_PYTHON_VERSION.major}.${MIN_PYTHON_VERSION.minor}+ not detected on this system.`
    );

    const os = (await import("node:os")).platform();

    if (os === "darwin") {
      // macOS: check Homebrew first
      const hb = detectHomebrew();
      if (!hb.installed) {
        const installHb = await p.confirm({
          message:
            "Homebrew is not installed. Install it now? (needed for Python)",
          initialValue: true,
        });
        if (p.isCancel(installHb)) {
          p.cancel("🚫 Setup cancelled.");
          process.exit(0);
        }
        if (installHb) {
          const s = p.spinner();
          s.start("Installing Homebrew...");
          const hbResult = installHomebrew();
          if (hbResult.ok) {
            s.stop("Homebrew installed.");
          } else {
            s.stop("Homebrew installation failed.");
            p.log.error(hbResult.error ?? "Unknown error");
            p.log.info(
              'Install manually: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
            );
          }
        } else {
          p.log.info(
            'Install Homebrew manually: /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
          );
        }
      }

      // Check again after potential Homebrew install
      detectedPython = findBestPython();
      if (!detectedPython) {
        const mgr = detectPlatformPackageManager();
        if (mgr === "brew") {
          const installPy = await p.confirm({
            message:
              "Python 3.10+ not found. Install Python 3.12 via Homebrew?",
            initialValue: true,
          });
          if (p.isCancel(installPy)) {
            p.cancel("🚫 Setup cancelled.");
            process.exit(0);
          }
          if (installPy) {
            const s = p.spinner();
            s.start("Installing Python 3.12 via Homebrew...");
            const pyResult = installPythonViaPackageManager("brew");
            if (pyResult.ok) {
              s.stop("Python installed via Homebrew.");
            } else {
              s.stop("Python installation failed.");
              p.log.error(pyResult.error ?? "Unknown error");
              p.log.info("Install manually: brew install python@3.12");
            }
          } else {
            p.log.info("Install manually: brew install python@3.12");
          }
        } else {
          p.log.info(
            "Install Python 3.10+ manually (e.g. brew install python@3.12) and re-run config."
          );
        }
      }
    } else {
      // Linux: detect package manager and offer install
      const mgr = detectPlatformPackageManager();
      if (mgr) {
        const installPy = await p.confirm({
          message: `Python 3.10+ not found. Install via ${mgr}?`,
          initialValue: true,
        });
        if (p.isCancel(installPy)) {
          p.cancel("🚫 Setup cancelled.");
          process.exit(0);
        }
        if (installPy) {
          const s = p.spinner();
          s.start(`Installing Python via ${mgr}...`);
          const pyResult = installPythonViaPackageManager(mgr);
          if (pyResult.ok) {
            s.stop(`Python installed via ${mgr}.`);
          } else {
            s.stop("Python installation failed.");
            p.log.error(pyResult.error ?? "Unknown error");
          }
        }
      } else {
        p.log.info(
          "Install Python 3.10+ using your system package manager and re-run config."
        );
      }
    }

    // Re-detect after install attempts
    detectedPython = findBestPython();
    if (detectedPython) {
      p.log.success(
        `Python ${detectedPython.version.version} installed at ${detectedPython.path}`
      );
    }
  }

  const pythonDefault = detectedPython?.path
    ?? (existsSync("/opt/homebrew/bin/python3") ? "/opt/homebrew/bin/python3" : "python3");

  const pythonPath = await p.text({
    message: "🐍 Path to Python interpreter:",
    placeholder: "python3",
    defaultValue: pythonDefault,
  });

  if (p.isCancel(pythonPath)) {
    p.cancel("🚫 Setup cancelled.");
    process.exit(0);
  }

  // Validate the chosen Python version
  const pyCheck = checkPythonVersion((pythonPath as string) || "python3");
  if (pyCheck.ok) {
    p.log.success(`Python ${pyCheck.version} OK`);
  } else if (pyCheck.version) {
    p.log.error(
      `Python ${pyCheck.version} is too old. v${MIN_PYTHON_VERSION.major}.${MIN_PYTHON_VERSION.minor}+ is required.`
    );
    p.log.info("Install a newer Python and re-run: sportsclaw config");
    process.exit(1);
  } else {
    p.log.warn(
      `Could not verify Python version at "${(pythonPath as string) || "python3"}". Proceeding anyway.`
    );
  }

  // --- Sport selection (skip if schemas already installed) ---
  const existingSchemas = listSchemas();
  let sportSelections: string[] | undefined;

  if (existingSchemas.length > 0) {
    p.log.info(`${existingSchemas.length} sport schema(s) already installed: ${existingSchemas.join(", ")}`);
    const reconfigure = await p.confirm({
      message: "Reconfigure installed sports?",
      initialValue: false,
    });
    if (p.isCancel(reconfigure)) {
      p.cancel("🚫 Setup cancelled.");
      process.exit(0);
    }
    if (reconfigure) {
      p.log.warn(SPORTS_SKILLS_DISCLAIMER);
      const selections = await promptSportSelection();
      if (p.isCancel(selections)) {
        p.cancel("🚫 Setup cancelled.");
        process.exit(0);
      }
      sportSelections = selections as string[];
    }
  } else {
    p.log.warn(SPORTS_SKILLS_DISCLAIMER);
    const selections = await promptSportSelection();
    if (p.isCancel(selections)) {
      p.cancel("🚫 Setup cancelled.");
      process.exit(0);
    }
    sportSelections = selections as string[];
  }

  // --- Optional Discord bot integration ---
  let discordConfig: DiscordIntegrationConfig | undefined;

  const configureDiscord = await p.confirm({
    message: "🤖 Configure Discord bot integration? (optional)",
    initialValue: false,
  });

  if (!p.isCancel(configureDiscord) && configureDiscord) {
    const existingDiscordToken = savedConfig.chatIntegrations?.discord?.botToken;

    let discordToken: string;
    if (existingDiscordToken && existingDiscordToken.trim().length > 0) {
      p.log.info("Using existing Discord bot token (already configured).");
      discordToken = existingDiscordToken.trim();
    } else {
      const tokenInput = await p.password({
        message: "🔑 Paste your Discord bot token:",
        validate: (val) => {
          if (!val || val.trim().length === 0) return "Bot token is required.";
        },
      });
      if (p.isCancel(tokenInput)) {
        p.cancel("🚫 Setup cancelled.");
        process.exit(0);
      }
      discordToken = (tokenInput as string).trim();
    }

    const existingAllowed = savedConfig.chatIntegrations?.discord?.allowedUsers;
    const allowedUsersInput = await p.text({
      message: "👥 Allowed Discord user IDs (comma-separated, or blank to let anyone chat):",
      placeholder: "Leave blank for public access",
      defaultValue: existingAllowed?.join(",") ?? "",
    });
    if (p.isCancel(allowedUsersInput)) {
      p.cancel("🚫 Setup cancelled.");
      process.exit(0);
    }
    const allowedUsers = (allowedUsersInput as string)
      .split(",")
      .map(id => id.trim())
      .filter(Boolean);

    const existingPrefix = savedConfig.chatIntegrations?.discord?.prefix;
    const prefixInput = await p.text({
      message: "💬 Command prefix:",
      placeholder: "!sportsclaw",
      defaultValue: existingPrefix || "!sportsclaw",
    });
    if (p.isCancel(prefixInput)) {
      p.cancel("🚫 Setup cancelled.");
      process.exit(0);
    }

    discordConfig = {
      botToken: discordToken,
      ...(allowedUsers.length > 0 && { allowedUsers }),
      prefix: (prefixInput as string) || "!sportsclaw",
    };
  }

  // Preserve existing Telegram config when saving from the main config flow
  const existingTelegram = savedConfig.chatIntegrations?.telegram;

  const chatIntegrations: ChatIntegrationsConfig = {
    ...(discordConfig && { discord: discordConfig }),
    ...(existingTelegram && { telegram: existingTelegram }),
  };

  const config: CLIConfig = {
    provider: selectedProvider,
    model: model as string,
    apiKey: finalApiKey,
    pythonPath: (pythonPath as string) || "python3",
    ...(sportSelections && { selectedSports: sportSelections }),
    ...(Object.keys(chatIntegrations).length > 0 && { chatIntegrations }),
  };

  saveConfig(config);
  p.outro(`✅ Config saved to ${CONFIG_PATH}`);

  // Install selected sport schemas (only if user made a new selection)
  if (sportSelections) {
    const resolvedPython = config.pythonPath || "python3";
    await installSelectedSports(sportSelections, resolvedPython);
  }

  // Post-config usage guide
  console.log("");
  console.log(pc.bold("You're all set! Here's how to get started:"));
  console.log("");
  console.log(`  ${pc.cyan("sportsclaw chat")}              Start an interactive session`);
  console.log(`  ${pc.cyan('sportsclaw "your question"')}   One-shot query`);
  console.log(`  ${pc.cyan("sportsclaw add <sport>")}       Install more sports`);
  console.log(`  ${pc.cyan("sportsclaw list")}              See installed sports`);
  console.log(`  ${pc.cyan("sportsclaw agents")}            See installed agents`);
  console.log(`  ${pc.cyan("sportsclaw config")}            Reconfigure anytime`);
  console.log(`  ${pc.cyan("sportsclaw channels")}          Set up Discord & Telegram tokens`);
  if (discordConfig?.botToken) {
    console.log(`  ${pc.cyan("sportsclaw listen discord")}    Start Discord bot`);
  }
  if (existingTelegram?.botToken) {
    console.log(`  ${pc.cyan("sportsclaw listen telegram")}   Start Telegram bot`);
  }
  console.log("");

  return config;
}

// ---------------------------------------------------------------------------
// CLI: `sportsclaw channels` — channel token wizard
// ---------------------------------------------------------------------------

/**
 * Interactive wizard to configure Discord and Telegram tokens.
 * Saves tokens into ~/.sportsclaw/config.json under chatIntegrations.
 */
export async function runChannelsFlow(): Promise<void> {
  console.log(pc.bold(pc.blue(ASCII_LOGO)));
  p.intro("Channel Configuration");

  const savedConfig = loadConfig();
  const existingDiscord = savedConfig.chatIntegrations?.discord;
  const existingTelegram = savedConfig.chatIntegrations?.telegram;

  // Show current status
  const discordStatus = existingDiscord?.botToken
    ? pc.green("configured")
    : firstEnv("DISCORD_BOT_TOKEN")
      ? pc.green("set via env")
      : pc.dim("not configured");
  const telegramStatus = existingTelegram?.botToken
    ? pc.green("configured")
    : (firstEnv("TELEGRAM_BOT_TOKEN") || readEnvFile(ENV_TELEGRAM_PATH, "TELEGRAM_BOT_TOKEN"))
      ? pc.green("set via env/.env.telegram")
      : pc.dim("not configured");

  p.log.info(`Discord:  ${discordStatus}`);
  p.log.info(`Telegram: ${telegramStatus}`);

  // --- Discord ---
  const configureDiscord = await p.confirm({
    message: "Configure Discord bot token?",
    initialValue: !existingDiscord?.botToken,
  });

  let discordConfig: DiscordIntegrationConfig | undefined = existingDiscord;

  if (!p.isCancel(configureDiscord) && configureDiscord) {
    if (existingDiscord?.botToken) {
      const masked = existingDiscord.botToken.slice(0, 8) + "..." + existingDiscord.botToken.slice(-4);
      p.log.info(`Current token: ${pc.dim(masked)}`);
    }

    const tokenInput = await p.password({
      message: "Paste your Discord bot token:",
      validate: (val) => {
        if (!val || val.trim().length === 0) return "Bot token is required.";
      },
    });
    if (p.isCancel(tokenInput)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    const allowedUsersInput = await p.text({
      message: "Allowed Discord user IDs (comma-separated, blank for public):",
      placeholder: "Leave blank for public access",
      defaultValue: existingDiscord?.allowedUsers?.join(",") ?? "",
    });
    if (p.isCancel(allowedUsersInput)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
    const allowedUsers = (allowedUsersInput as string)
      .split(",")
      .map(id => id.trim())
      .filter(Boolean);

    const prefixInput = await p.text({
      message: "Command prefix:",
      placeholder: "!sportsclaw",
      defaultValue: existingDiscord?.prefix || "!sportsclaw",
    });
    if (p.isCancel(prefixInput)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    discordConfig = {
      botToken: (tokenInput as string).trim(),
      ...(allowedUsers.length > 0 && { allowedUsers }),
      prefix: (prefixInput as string) || "!sportsclaw",
      // Preserve existing feature flags and channels
      ...(existingDiscord?.features && { features: existingDiscord.features }),
      ...(existingDiscord?.channels && { channels: existingDiscord.channels }),
    };
  }

  // --- Telegram ---
  const configureTelegram = await p.confirm({
    message: "Configure Telegram bot token?",
    initialValue: !existingTelegram?.botToken,
  });

  let telegramConfig: TelegramIntegrationConfig | undefined = existingTelegram;

  if (!p.isCancel(configureTelegram) && configureTelegram) {
    if (existingTelegram?.botToken) {
      const masked = existingTelegram.botToken.slice(0, 8) + "..." + existingTelegram.botToken.slice(-4);
      p.log.info(`Current token: ${pc.dim(masked)}`);
    }

    p.log.info(
      `Get a token from ${pc.cyan("@BotFather")} on Telegram.\n` +
      `  The token will be saved to ~/.sportsclaw/config.json.\n` +
      `  You can also set TELEGRAM_BOT_TOKEN in env or ~/.sportsclaw/.env.telegram.`
    );

    const tokenInput = await p.password({
      message: "Paste your Telegram bot token:",
      validate: (val) => {
        if (!val || val.trim().length === 0) return "Bot token is required.";
      },
    });
    if (p.isCancel(tokenInput)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    const allowedUsersInput = await p.text({
      message: "Allowed Telegram user IDs (comma-separated, blank for public):",
      placeholder: "Leave blank for public access",
      defaultValue: existingTelegram?.allowedUsers?.join(",") ?? "",
    });
    if (p.isCancel(allowedUsersInput)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
    const allowedUsers = (allowedUsersInput as string)
      .split(",")
      .map(id => id.trim())
      .filter(Boolean);

    telegramConfig = {
      botToken: (tokenInput as string).trim(),
      ...(allowedUsers.length > 0 && { allowedUsers }),
    };
  }

  // --- Save ---
  const chatIntegrations: ChatIntegrationsConfig = {
    ...(discordConfig && { discord: discordConfig }),
    ...(telegramConfig && { telegram: telegramConfig }),
  };

  const updatedConfig: CLIConfig = {
    ...savedConfig,
    ...(Object.keys(chatIntegrations).length > 0 && { chatIntegrations }),
  };

  saveConfig(updatedConfig);

  p.outro(`Config saved to ${CONFIG_PATH}`);

  // Quick next-steps guide
  console.log("");
  if (discordConfig?.botToken) {
    console.log(`  ${pc.cyan("sportsclaw listen discord")}    Start Discord bot`);
  }
  if (telegramConfig?.botToken) {
    console.log(`  ${pc.cyan("sportsclaw listen telegram")}   Start Telegram bot`);
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Sport multi-select prompt (reusable)
// ---------------------------------------------------------------------------

function desc(sport: string): string {
  return SKILL_DESCRIPTIONS[sport] ?? sport;
}

async function promptSportSelection(): Promise<string[] | symbol> {
  const selections = await p.groupMultiselect({
    message: "🏟️  Which sports do you want to install?",
    options: {
      "US Pro": [
        { value: "nfl", label: "NFL", hint: desc("nfl") },
        { value: "nba", label: "NBA", hint: desc("nba") },
        { value: "nhl", label: "NHL", hint: desc("nhl") },
        { value: "mlb", label: "MLB", hint: desc("mlb") },
        { value: "wnba", label: "WNBA", hint: desc("wnba") },
      ],
      "College": [
        { value: "cfb", label: "College Football", hint: desc("cfb") },
        { value: "cbb", label: "College Basketball", hint: desc("cbb") },
      ],
      "Global": [
        { value: "football", label: "Football (Soccer)", hint: desc("football") },
        { value: "tennis", label: "Tennis", hint: desc("tennis") },
        { value: "golf", label: "Golf", hint: desc("golf") },
        { value: "f1", label: "Formula 1", hint: desc("f1") },
      ],
      "Markets & News": [
        { value: "kalshi", label: "Kalshi", hint: desc("kalshi") },
        { value: "polymarket", label: "Polymarket", hint: desc("polymarket") },
        { value: "news", label: "Sports News", hint: desc("news") },
      ],
    },
  });

  return selections;
}

async function installSelectedSports(
  sports: string[],
  pythonPath: string
): Promise<number> {
  if (sports.length === 0) return 0;

  const s = p.spinner();
  s.start(`Installing ${sports.length} sport schema(s)...`);

  let installed = 0;
  for (const sport of sports) {
    try {
      const schema = await fetchSportSchema(sport, { pythonPath });
      saveSchema(schema);
      installed++;
    } catch {
      // Log but continue
      console.error(`[sportsclaw] warning: could not fetch schema for "${sport}"`);
    }
  }

  s.stop(`Installed ${installed}/${sports.length} sport schema(s).`);
  return installed;
}

/**
 * Standalone sport selection flow — usable from ensureDefaultSchemas()
 * when a first-time user hasn't run `sportsclaw config` yet.
 */
export async function runSportSelectionFlow(
  pythonPath?: string
): Promise<string[]> {
  p.log.warn(SPORTS_SKILLS_DISCLAIMER);

  const sportSelections = await promptSportSelection();
  if (p.isCancel(sportSelections)) {
    // User cancelled — install all defaults as a safe fallback
    p.log.info("No selection made — installing all default sports.");
    return [...DEFAULT_SKILLS];
  }

  const selected = sportSelections as string[];
  if (selected.length === 0) {
    p.log.info("No sports selected — installing all defaults.");
    return [...DEFAULT_SKILLS];
  }

  const resolvedPython = pythonPath || "python3";
  await installSelectedSports(selected, resolvedPython);

  // Persist selections to config
  const config = loadConfig();
  config.selectedSports = selected;
  saveConfig(config);

  return selected;
}
