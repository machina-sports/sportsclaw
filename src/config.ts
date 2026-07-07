/**
 * sportsclaw Engine — Persistent CLI Configuration
 *
 * Reads/writes user config from ~/.sportsclaw/config.json.
 * Environment variables always override config file values.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import pc from "picocolors";
import * as p from "@clack/prompts";
import {
  CUSTOM_MODEL_VALUE,
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
import { loadMcpConfigs, saveMcpConfigs, removeMcpConfig } from "./mcp.js";
import {
  checkPythonVersion,
  findBestPython,
  detectHomebrew,
  detectPlatformPackageManager,
  installHomebrew,
  installPythonViaPackageManager,
  isVenvSetup,
  getVenvPythonPath,
  MIN_PYTHON_VERSION,
} from "./python.js";
import {
  getAuthMethods,
  setAnthropicAuthMethod,
} from "./credentials.js";
import { inspectClaudeCodeSession } from "./anthropic-oauth.js";

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

export const CONFIG_DIR = join(homedir(), ".sportsclaw");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const ENV_PATH = join(CONFIG_DIR, ".env");

// ---------------------------------------------------------------------------
// Provider ↔ API key env var mapping (duplicated here to avoid circular deps)
// ---------------------------------------------------------------------------

export const PROVIDER_ENV: Record<LLMProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  "azure-foundry": "AZURE_FOUNDRY_API_KEY",
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

const parseCommaList = (raw: string): string[] => raw.split(",").map(s => s.trim()).filter(Boolean);

/**
 * Parse all key-value pairs from a dotenv-style file.
 * Returns a record of key → value (empty values are omitted).
 */
export function parseEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  try {
    const result: Record<string, string> = {};
    const content = readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 0) continue;
      const k = trimmed.slice(0, eqIdx).trim();
      let v = trimmed.slice(eqIdx + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (v) result[k] = v;
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Write or update a single key=value pair in a dotenv-style file.
 * Creates the file (and parent dirs) if it doesn't exist.
 * Replaces the line if the key already exists, appends otherwise.
 */
export function writeEnvVar(filePath: string, key: string, value: string): void {
  const dir = filePath.replace(/\/[^/]+$/, "");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let lines: string[] = [];
  if (existsSync(filePath)) {
    lines = readFileSync(filePath, "utf-8").split("\n");
  }

  const prefix = `${key}=`;
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith(prefix)) {
      lines[i] = `${key}=${value}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    // Remove trailing empty lines before appending
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }
    lines.push(`${key}=${value}`);
  }

  // Atomic write (same-dir temp + rename) so a crash mid-write can't tear the
  // .env and lose other keys. Matches token-ledger.ts / saveMcpConfigs.
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(tmp, lines.join("\n") + "\n", "utf-8");
    renameSync(tmp, filePath);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* tmp may not exist */ }
    throw e;
  }
  // .env holds bearer tokens — restrict to owner like credentials.ts. The
  // create-temp-then-rename above resets mode to the umask default, so set it
  // explicitly after the rename. Best-effort (no-op on platforms without chmod).
  try { chmodSync(filePath, 0o600); } catch { /* chmod best-effort */ }
}

/**
 * Sync a token saved by a wizard back into `~/.sportsclaw/.env` when that file
 * already contains the same key with a stale value. Without this, a stale `.env`
 * silently shadows the wizard's update because `firstEnv()` wins over config.json.
 *
 * Returns:
 *   "updated" — `.env` had a different value and was rewritten to match.
 *   "matched" — `.env` already had this exact value (no change).
 *   "absent"  — `.env` does not set this key (no conflict possible from .env).
 */
export type EnvSyncResult = "updated" | "matched" | "absent";

export function syncTokenToEnvFile(
  envKey: string,
  newValue: string
): EnvSyncResult {
  const existing = parseEnvFile(ENV_PATH)[envKey];
  if (existing === undefined) return "absent";
  if (existing === newValue) return "matched";
  writeEnvVar(ENV_PATH, envKey, newValue);
  return "updated";
}

/**
 * Check whether a different value for `envKey` is already set in the running
 * shell's environment. If yes, that value will win at runtime (firstEnv wins
 * over config.json) and the wizard's saved token will not take effect until
 * the variable is unset.
 *
 * Note: this can return `true` after `applyConfigToEnv()` populates the
 * variable from `.env`. Callers that have already run `syncTokenToEnvFile`
 * for this key can safely treat that match as "we just updated .env, the
 * shell will pick it up on next launch" rather than a real shell-level conflict.
 */
export function shellEnvConflict(
  envKey: string,
  newValue: string
): boolean {
  const v = process.env[envKey];
  return Boolean(v && v !== newValue);
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
    (file.provider === provider ? file.model : undefined) ||
    DEFAULT_MODELS[provider];

  // env var > config-file apiKey, but only reuse the persisted key when the
  // persisted provider matches the resolved provider. This prevents a provider
  // override (e.g. SPORTSCLAW_PROVIDER=azure-foundry) from accidentally reusing
  // a key saved for a different provider.
  const apiKey = process.env[envVar] || (file.provider === provider ? file.apiKey : undefined);
  const defaultPythonPath = existsSync("/opt/homebrew/bin/python3")
    ? "/opt/homebrew/bin/python3"
    : "python3";
  const configuredPython = firstEnv("PYTHON_PATH") || file.pythonPath;
  // Resolution order: env/config > managed venv > Homebrew auto-detect > "python3"
  const pythonPath =
    configuredPython && configuredPython !== "python3"
      ? configuredPython
      : isVenvSetup()
        ? getVenvPythonPath()
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
    ? parseCommaList(discordAllowedUsersRaw)
    : file.chatIntegrations?.discord?.allowedUsers;
  const discordPrefix =
    firstEnv("DISCORD_PREFIX") || file.chatIntegrations?.discord?.prefix || "!sportsclaw";

  // Telegram: env var (incl. ~/.sportsclaw/.env) > config file
  const telegramBotToken =
    firstEnv("TELEGRAM_BOT_TOKEN") ||
    file.chatIntegrations?.telegram?.botToken;
  const telegramAllowedUsersRaw = firstEnv("TELEGRAM_ALLOWED_USERS");
  const telegramAllowedUsers = telegramAllowedUsersRaw
    ? parseCommaList(telegramAllowedUsersRaw)
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
 * Load all key-value pairs from a dotenv-style file into process.env.
 * Existing env vars are NOT overwritten (env always wins).
 */
function loadEnvFile(filePath: string): void {
  for (const [k, v] of Object.entries(parseEnvFile(filePath))) {
    if (!process.env[k]) process.env[k] = v;
  }
}

/**
 * Apply saved config into process.env so downstream code (engine, listeners)
 * picks it up transparently. Env vars already set take precedence.
 */
export function applyConfigToEnv(): ResolvedConfig {
  // Load ~/.sportsclaw/.env first (user secrets, wallet addresses, etc.)
  loadEnvFile(ENV_PATH);

  const resolved = resolveConfig();

  const envVar = PROVIDER_ENV[resolved.provider];
  if (resolved.apiKey && !process.env[envVar]) {
    process.env[envVar] = resolved.apiKey;
  }

  const envMap: Record<string, string | undefined> = {
    SPORTSCLAW_MODEL: resolved.model,
    SPORTSCLAW_PROVIDER: resolved.provider,
    SPORTSCLAW_ROUTING_MODE: resolved.routingMode,
    SPORTSCLAW_ROUTING_MAX_SKILLS: String(resolved.routingMaxSkills),
    SPORTSCLAW_ROUTING_ALLOW_SPILLOVER: String(resolved.routingAllowSpillover),
  };
  for (const [key, value] of Object.entries(envMap)) {
    if (value && !process.env[key]) process.env[key] = value;
  }

  if (!process.env.PYTHON_PATH && resolved.pythonPath !== "python3") {
    process.env.PYTHON_PATH = resolved.pythonPath;
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
  p.intro("sportsclaw Configuration");

  const savedConfig = loadConfig();
  const isFirstRun = !savedConfig.provider;

  // -----------------------------------------------------------------------
  // Returning user — show summary and let them pick what to change
  // -----------------------------------------------------------------------
  if (!isFirstRun) {
    const existingSchemas = listSchemas();
    const mcpConfigs = loadMcpConfigs();
    const mcpCount = Object.keys(mcpConfigs).length;
    const discord = savedConfig.chatIntegrations?.discord;
    const telegram = savedConfig.chatIntegrations?.telegram;

    const anthroAuthMethod = getAuthMethods().anthropic;
    const oauthActive = anthroAuthMethod === "oauth_claude_code" && inspectClaudeCodeSession().available;

    console.log("");
    console.log(pc.bold("  Current Configuration"));
    console.log("");
    console.log(`  ${pc.dim("Provider")}     ${savedConfig.provider}${savedConfig.model ? ` (${savedConfig.model})` : ""}`);
    const authLabel = oauthActive
      ? pc.green("Claude Code OAuth")
      : savedConfig.apiKey
        ? pc.green("API key configured")
        : pc.yellow("missing");
    console.log(`  ${pc.dim("Auth")}         ${authLabel}`);
    console.log(`  ${pc.dim("Python")}       ${savedConfig.pythonPath || "python3"}`);
    console.log(`  ${pc.dim("Sports")}       ${existingSchemas.length > 0 ? existingSchemas.join(", ") : pc.yellow("none installed")}`);
    console.log(`  ${pc.dim("Machina MCP")}  ${mcpCount > 0 ? Object.keys(mcpConfigs).join(", ") : pc.dim("none")}`);
    console.log(`  ${pc.dim("Discord")}      ${discord?.botToken ? pc.green("configured") : pc.dim("not set")}`);
    console.log(`  ${pc.dim("Telegram")}     ${telegram?.botToken ? pc.green("configured") : pc.dim("not set")}`);
    console.log("");

    const sections = await p.multiselect({
      message: "What would you like to reconfigure?",
      options: [
        { value: "provider", label: "LLM Provider & Model", hint: `currently ${savedConfig.provider}` },
        { value: "python", label: "Python Path", hint: savedConfig.pythonPath || "python3" },
        { value: "sports", label: "Installed Sports", hint: `${existingSchemas.length} installed` },
        { value: "mcp", label: "Machina MCP", hint: `${mcpCount} configured` },
        { value: "discord", label: "Discord Integration", hint: discord?.botToken ? "configured" : "not set" },
        { value: "telegram", label: "Telegram Integration", hint: telegram?.botToken ? "configured" : "not set" },
      ],
    });

    if (p.isCancel(sections)) {
      p.cancel("No changes made.");
      process.exit(0);
    }

    const selected = new Set(sections as string[]);
    let updatedConfig = { ...savedConfig };

    // --- Provider & Model ---
    if (selected.has("provider")) {
      const result = await configureProvider(savedConfig);
      updatedConfig = { ...updatedConfig, ...result };
    }

    // --- Python ---
    if (selected.has("python")) {
      const result = await configurePython(savedConfig);
      updatedConfig.pythonPath = result;
    }

    // --- Sports ---
    if (selected.has("sports")) {
      p.log.warn(SPORTS_SKILLS_DISCLAIMER);
      const selections = await promptSportSelection();
      if (!p.isCancel(selections)) {
        updatedConfig.selectedSports = selections as string[];
      }
    }

    // --- MCP Pods ---
    if (selected.has("mcp")) {
      await configureMcpInteractive();
    }

    // --- Discord ---
    if (selected.has("discord")) {
      const result = await configureDiscordIntegration(savedConfig);
      if (result) {
        updatedConfig.chatIntegrations = {
          ...updatedConfig.chatIntegrations,
          discord: result,
        };
      }
    }

    // --- Telegram ---
    if (selected.has("telegram")) {
      const result = await configureTelegramIntegration(savedConfig);
      if (result) {
        updatedConfig.chatIntegrations = {
          ...updatedConfig.chatIntegrations,
          telegram: result,
        };
      }
    }

    saveConfig(updatedConfig);
    p.outro(`Config saved to ${CONFIG_PATH}`);

    // Install sport schemas if changed
    if (selected.has("sports") && updatedConfig.selectedSports) {
      const resolvedPython = updatedConfig.pythonPath || "python3";
      await installSelectedSports(updatedConfig.selectedSports, resolvedPython);
    }

    return updatedConfig;
  }

  // -----------------------------------------------------------------------
  // First-time setup — full linear wizard
  // -----------------------------------------------------------------------
  const { provider: selectedProvider, model: selectedModel, apiKey: finalApiKey } =
    await configureProvider(savedConfig);
  const pythonPath = await configurePython(savedConfig);

  // --- Sport selection ---
  p.log.warn(SPORTS_SKILLS_DISCLAIMER);
  const sportSelectionsRaw = await promptSportSelection();
  if (p.isCancel(sportSelectionsRaw)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
  const sportSelections = sportSelectionsRaw as string[];

  // --- Optional Discord bot integration ---
  const configureDiscordPrompt = await p.confirm({
    message: "Configure Discord bot integration? (optional)",
    initialValue: false,
  });
  let discordConfig: DiscordIntegrationConfig | undefined;
  if (!p.isCancel(configureDiscordPrompt) && configureDiscordPrompt) {
    discordConfig = await configureDiscordIntegration(savedConfig) ?? undefined;
  }

  // Preserve existing Telegram config when saving from the main config flow
  const existingTelegram = savedConfig.chatIntegrations?.telegram;

  const chatIntegrations: ChatIntegrationsConfig = {
    ...(discordConfig && { discord: discordConfig }),
    ...(existingTelegram && { telegram: existingTelegram }),
  };

  const config: CLIConfig = {
    provider: selectedProvider,
    model: selectedModel,
    apiKey: finalApiKey,
    pythonPath: pythonPath || "python3",
    selectedSports: sportSelections,
    ...(Object.keys(chatIntegrations).length > 0 && { chatIntegrations }),
  };

  saveConfig(config);
  p.outro(`Config saved to ${CONFIG_PATH}`);

  // Install selected sport schemas
  if (sportSelections.length > 0) {
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
    : firstEnv("TELEGRAM_BOT_TOKEN")
      ? pc.green("set via env/.env")
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
        return undefined;
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
    const allowedUsers = parseCommaList(allowedUsersInput as string);

    const prefixInput = await p.text({
      message: "Command prefix:",
      placeholder: "!sportsclaw",
      defaultValue: existingDiscord?.prefix || "!sportsclaw",
    });
    if (p.isCancel(prefixInput)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    const newDiscordToken = (tokenInput as string).trim();
    discordConfig = {
      botToken: newDiscordToken,
      ...(allowedUsers.length > 0 && { allowedUsers }),
      prefix: (prefixInput as string) || "!sportsclaw",
      // Preserve existing feature flags and channels
      ...(existingDiscord?.features && { features: existingDiscord.features }),
      ...(existingDiscord?.channels && { channels: existingDiscord.channels }),
    };

    const discordSync = syncTokenToEnvFile("DISCORD_BOT_TOKEN", newDiscordToken);
    if (discordSync === "updated") {
      p.log.warn(
        `Rewrote stale DISCORD_BOT_TOKEN in ~/.sportsclaw/.env to match the new token.`
      );
    }
    if (shellEnvConflict("DISCORD_BOT_TOKEN", newDiscordToken)) {
      p.log.warn(
        `Your shell already exports a different DISCORD_BOT_TOKEN. It will\n` +
        `  override this saved token until you run: ${pc.cyan("unset DISCORD_BOT_TOKEN")}`
      );
    }
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
      `  Resolution order at runtime: shell env > ~/.sportsclaw/.env > ~/.sportsclaw/config.json.\n` +
      `  This wizard saves to config.json and will rewrite a stale TELEGRAM_BOT_TOKEN\n` +
      `  in ~/.sportsclaw/.env so the new token actually takes effect.`
    );

    const tokenInput = await p.password({
      message: "Paste your Telegram bot token:",
      validate: (val) => {
        if (!val || val.trim().length === 0) return "Bot token is required.";
        return undefined;
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
    const allowedUsers = parseCommaList(allowedUsersInput as string);

    const newToken = (tokenInput as string).trim();
    telegramConfig = {
      botToken: newToken,
      ...(allowedUsers.length > 0 && { allowedUsers }),
    };

    const sync = syncTokenToEnvFile("TELEGRAM_BOT_TOKEN", newToken);
    if (sync === "updated") {
      p.log.warn(
        `Rewrote stale TELEGRAM_BOT_TOKEN in ~/.sportsclaw/.env to match the new token.`
      );
    }
    if (shellEnvConflict("TELEGRAM_BOT_TOKEN", newToken)) {
      p.log.warn(
        `Your shell already exports a different TELEGRAM_BOT_TOKEN. It will\n` +
        `  override this saved token until you run: ${pc.cyan("unset TELEGRAM_BOT_TOKEN")}`
      );
    }
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

// ---------------------------------------------------------------------------
// Extracted config section helpers (used by both first-run and reconfigure)
// ---------------------------------------------------------------------------

function hasApiKey(savedConfig: CLIConfig, prov: LLMProvider): boolean {
  if (process.env[PROVIDER_ENV[prov]]) return true;
  if (savedConfig.provider === prov && savedConfig.apiKey) return true;
  // Azure Foundry can run keyless through Microsoft Entra ID.
  if (prov === "azure-foundry") {
    const env = parseEnvFile(ENV_PATH);
    const authMode = process.env.AZURE_FOUNDRY_AUTH_MODE || env.AZURE_FOUNDRY_AUTH_MODE;
    const baseUrl = process.env.AZURE_FOUNDRY_BASE_URL || env.AZURE_FOUNDRY_BASE_URL;
    if (authMode === "entra_id" && baseUrl) return true;
  }
  // For Anthropic, an active Claude Code OAuth opt-in counts as authenticated.
  if (prov === "anthropic" && getAuthMethods().anthropic === "oauth_claude_code") {
    if (inspectClaudeCodeSession().available) return true;
  }
  return false;
}

async function promptModelSelection(
  provider: LLMProvider,
  savedConfig: CLIConfig,
  opts: { message?: string; placeholder?: string } = {},
): Promise<string> {
  const profile = PROVIDER_MODEL_PROFILES[provider];
  const customOption = {
    value: CUSTOM_MODEL_VALUE,
    label: "Custom model / deployment name",
    hint: "type a provider-specific model id",
  };

  const choice = await p.select({
    message: opts.message ?? "Which model?",
    options: [...(profile?.selectableModels ?? []), customOption],
    initialValue: savedConfig.model || profile?.defaultModel || undefined,
  });

  if (p.isCancel(choice)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  if (choice !== CUSTOM_MODEL_VALUE) {
    return choice as string;
  }

  const customModel = await p.text({
    message: "Model / deployment name:",
    placeholder: opts.placeholder || profile?.defaultModel || "model-id",
    defaultValue: savedConfig.model || profile?.defaultModel || "",
    validate: (val) => (!val?.trim() ? "Model ID is required." : undefined),
  });

  if (p.isCancel(customModel)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  return (customModel as string).trim();
}

async function configureProvider(savedConfig: CLIConfig): Promise<{
  provider: LLMProvider;
  model: string;
  apiKey: string;
}> {
  const provider = await p.select({
    message: "Which LLM provider?",
    options: [
      { value: "anthropic", label: "Anthropic", hint: hasApiKey(savedConfig, "anthropic") ? "Claude · authenticated" : "Claude" },
      { value: "openai", label: "OpenAI", hint: hasApiKey(savedConfig, "openai") ? "GPT · authenticated" : "GPT" },
      { value: "google", label: "Google", hint: hasApiKey(savedConfig, "google") ? "Gemini · authenticated" : "Gemini" },
      { value: "azure-foundry", label: "Azure Foundry", hint: hasApiKey(savedConfig, "azure-foundry") ? "Microsoft Foundry / Azure OpenAI · authenticated" : "Microsoft Foundry / Azure OpenAI" },
    ],
    initialValue: savedConfig.provider || undefined,
  });

  if (p.isCancel(provider)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  // Azure Foundry has its own endpoint/auth/api-mode wizard and a free-text
  // deployment name (deployments are user-defined, not a fixed model list).
  if (provider === "azure-foundry") {
    return configureAzureFoundry(savedConfig);
  }

  const model = await promptModelSelection(provider as LLMProvider, savedConfig);

  const selectedProvider = provider as LLMProvider;
  const envName = PROVIDER_ENV[selectedProvider];

  // Anthropic-only: offer "Sign in with Claude" as a sibling to the API-key flow.
  if (selectedProvider === "anthropic") {
    const session = inspectClaudeCodeSession();
    const oauthCurrentlyActive = getAuthMethods().anthropic === "oauth_claude_code";

    const authChoiceOptions: Array<{ value: "api_key" | "oauth"; label: string; hint?: string }> = [];
    if (session.available) {
      const sub = session.subscriptionType ? `Claude Code ${session.subscriptionType}` : "Claude Code";
      authChoiceOptions.push({
        value: "oauth",
        label: `Sign in with Claude (${sub})`,
        hint: oauthCurrentlyActive ? "currently active" : "use existing Claude Code session",
      });
    }
    authChoiceOptions.push({
      value: "api_key",
      label: "Use an Anthropic API key",
      hint: oauthCurrentlyActive ? "switch back to API-key auth" : "default",
    });

    const initialAuthChoice: "api_key" | "oauth" =
      oauthCurrentlyActive && session.available ? "oauth" : "api_key";

    const authChoice = authChoiceOptions.length > 1
      ? await p.select({
          message: "How do you want to authenticate with Anthropic?",
          options: authChoiceOptions,
          initialValue: initialAuthChoice,
        })
      : "api_key";
    if (p.isCancel(authChoice)) { p.cancel("Cancelled."); process.exit(0); }

    if (authChoice === "oauth") {
      setAnthropicAuthMethod("oauth_claude_code");
      const minLeft = Math.max(0, Math.floor((session.expiresInMs ?? 0) / 60_000));
      p.log.success(`Signed in via Claude Code (token expires in ${minLeft} min).`);
      // No API key needed; return an empty string so the saved config doesn't claim a key.
      return { provider: selectedProvider, model: model as string, apiKey: "" };
    }

    // User explicitly chose API key — ensure any prior OAuth opt-in is cleared.
    if (oauthCurrentlyActive) {
      setAnthropicAuthMethod(undefined);
      p.log.info("Switched off Claude Code OAuth — will use Anthropic API key from here on.");
    }
  }

  const existingKey = process.env[PROVIDER_ENV[selectedProvider]]
    || (savedConfig.provider === selectedProvider ? savedConfig.apiKey : undefined);

  let apiKey: string;
  if (existingKey && existingKey.trim().length > 0) {
    const keepExisting = await p.confirm({
      message: `${envName} is already set. Keep it?`,
      initialValue: true,
    });
    if (p.isCancel(keepExisting)) { p.cancel("Cancelled."); process.exit(0); }
    if (keepExisting) {
      apiKey = existingKey.trim();
    } else {
      const newKey = await p.password({
        message: `Paste your ${envName}:`,
        validate: (val) => (!val || !val.trim() ? "API key is required." : undefined),
      });
      if (p.isCancel(newKey)) { p.cancel("Cancelled."); process.exit(0); }
      apiKey = (newKey as string).trim();
    }
  } else {
    const newKey = await p.password({
      message: `Paste your ${envName}:`,
      validate: (val) => (!val || !val.trim() ? "API key is required." : undefined),
    });
    if (p.isCancel(newKey)) { p.cancel("Cancelled."); process.exit(0); }
    apiKey = (newKey as string).trim();
  }

  return { provider: selectedProvider, model: model as string, apiKey };
}

/**
 * Azure Foundry (Microsoft Foundry / Azure OpenAI) setup. Collects the
 * endpoint, API mode, auth mode, and deployment name, and persists the
 * `AZURE_FOUNDRY_*` env vars to `~/.sportsclaw/.env`. The API key (when the
 * auth mode is `api_key`) is returned to be saved in config.json like other
 * providers; under Entra ID no key is stored.
 */
async function configureAzureFoundry(savedConfig: CLIConfig): Promise<{
  provider: LLMProvider;
  model: string;
  apiKey: string;
}> {
  const baseUrlInput = await p.text({
    message: "Azure Foundry endpoint base URL:",
    placeholder: "https://<resource>.openai.azure.com/openai/v1",
    initialValue: process.env.AZURE_FOUNDRY_BASE_URL || parseEnvFile(ENV_PATH).AZURE_FOUNDRY_BASE_URL || "",
    validate: (val) => {
      if (!val?.trim()) return "Base URL is required.";
      try {
        const u = new URL(val.trim());
        if (u.protocol !== "http:" && u.protocol !== "https:") return "Must be an http(s) URL.";
      } catch {
        return "Not a valid URL.";
      }
      return undefined;
    },
  });
  if (p.isCancel(baseUrlInput)) { p.cancel("Cancelled."); process.exit(0); }
  const baseUrl = (baseUrlInput as string).trim();

  const apiMode = await p.select({
    message: "API mode:",
    options: [
      { value: "auto", label: "Auto-detect", hint: "recommended — infer from URL + model" },
      { value: "chat_completions", label: "Chat Completions", hint: "OpenAI /chat/completions" },
      { value: "responses", label: "Responses", hint: "OpenAI /responses (gpt-5*, o-series)" },
      { value: "codex_responses", label: "Codex Responses", hint: "OpenAI /responses for codex" },
      { value: "anthropic_messages", label: "Anthropic Messages", hint: "Azure services.ai /anthropic" },
    ],
    initialValue: "auto",
  });
  if (p.isCancel(apiMode)) { p.cancel("Cancelled."); process.exit(0); }

  const authMode = await p.select({
    message: "Authentication mode:",
    options: [
      { value: "api_key", label: "API key", hint: "AZURE_FOUNDRY_API_KEY (default)" },
      { value: "entra_id", label: "Entra ID", hint: "DefaultAzureCredential (@azure/identity)" },
    ],
    initialValue: "api_key",
  });
  if (p.isCancel(authMode)) { p.cancel("Cancelled."); process.exit(0); }

  const model = await promptModelSelection("azure-foundry", savedConfig, {
    message: "Deployment / model name:",
    placeholder: "gpt-5.2",
  });

  const apiVersionInput = await p.text({
    message: "API version (optional — blank to omit):",
    placeholder: "preview",
    defaultValue: process.env.AZURE_FOUNDRY_API_VERSION || parseEnvFile(ENV_PATH).AZURE_FOUNDRY_API_VERSION || "",
  });
  if (p.isCancel(apiVersionInput)) { p.cancel("Cancelled."); process.exit(0); }
  const apiVersion = (apiVersionInput as string).trim();

  // Persist non-secret Foundry settings to ~/.sportsclaw/.env so the runtime
  // resolver (resolveAzureFoundryConfig) picks them up.
  writeEnvVar(ENV_PATH, "AZURE_FOUNDRY_BASE_URL", baseUrl);
  writeEnvVar(ENV_PATH, "AZURE_FOUNDRY_API_MODE", apiMode as string);
  writeEnvVar(ENV_PATH, "AZURE_FOUNDRY_AUTH_MODE", authMode as string);
  if (apiVersion) writeEnvVar(ENV_PATH, "AZURE_FOUNDRY_API_VERSION", apiVersion);

  if (authMode === "entra_id") {
    const scopeInput = await p.text({
      message: "Entra ID token scope:",
      placeholder: "https://ai.azure.com/.default",
      defaultValue:
        process.env.AZURE_FOUNDRY_SCOPE ||
        parseEnvFile(ENV_PATH).AZURE_FOUNDRY_SCOPE ||
        "https://ai.azure.com/.default",
    });
    if (p.isCancel(scopeInput)) { p.cancel("Cancelled."); process.exit(0); }
    const scope = (scopeInput as string).trim();
    if (scope) writeEnvVar(ENV_PATH, "AZURE_FOUNDRY_SCOPE", scope);
    p.log.info(
      "Entra ID auth uses DefaultAzureCredential. Ensure @azure/identity is installed " +
        "(npm install @azure/identity) and your environment is logged in (az login / managed identity).",
    );
    // No API key stored under Entra ID.
    return { provider: "azure-foundry", model, apiKey: "" };
  }

  const existingKey =
    process.env.AZURE_FOUNDRY_API_KEY ||
    (savedConfig.provider === "azure-foundry" ? savedConfig.apiKey : undefined);

  let apiKey: string;
  if (existingKey && existingKey.trim().length > 0) {
    const keep = await p.confirm({ message: "AZURE_FOUNDRY_API_KEY is already set. Keep it?", initialValue: true });
    if (p.isCancel(keep)) { p.cancel("Cancelled."); process.exit(0); }
    if (keep) {
      apiKey = existingKey.trim();
    } else {
      const newKey = await p.password({
        message: "Paste your AZURE_FOUNDRY_API_KEY:",
        validate: (val) => (!val?.trim() ? "API key is required." : undefined),
      });
      if (p.isCancel(newKey)) { p.cancel("Cancelled."); process.exit(0); }
      apiKey = (newKey as string).trim();
    }
  } else {
    const newKey = await p.password({
      message: "Paste your AZURE_FOUNDRY_API_KEY:",
      validate: (val) => (!val?.trim() ? "API key is required." : undefined),
    });
    if (p.isCancel(newKey)) { p.cancel("Cancelled."); process.exit(0); }
    apiKey = (newKey as string).trim();
  }

  // Keep .env in sync so a stale AZURE_FOUNDRY_API_KEY doesn't shadow the wizard.
  const sync = syncTokenToEnvFile("AZURE_FOUNDRY_API_KEY", apiKey);
  if (sync === "updated") {
    p.log.warn("Rewrote stale AZURE_FOUNDRY_API_KEY in ~/.sportsclaw/.env to match the new key.");
  }

  return { provider: "azure-foundry", model, apiKey };
}

async function configurePython(_savedConfig: CLIConfig): Promise<string> {
  let detectedPython = findBestPython();

  if (detectedPython) {
    p.log.success(`Python ${detectedPython.version.version} detected at ${detectedPython.path}`);
  } else {
    p.log.warn(`Python ${MIN_PYTHON_VERSION.major}.${MIN_PYTHON_VERSION.minor}+ not detected.`);

    const os = (await import("node:os")).platform();
    const mgr = detectPlatformPackageManager();

    if (os === "darwin" && !detectHomebrew().installed) {
      const installHb = await p.confirm({
        message: "Homebrew is not installed. Install it now?",
        initialValue: true,
      });
      if (!p.isCancel(installHb) && installHb) {
        const s = p.spinner();
        s.start("Installing Homebrew...");
        const hbResult = installHomebrew();
        s.stop(hbResult.ok ? "Homebrew installed." : "Homebrew installation failed.");
      }
    }

    detectedPython = findBestPython();
    if (!detectedPython && mgr) {
      const installPy = await p.confirm({
        message: `Python 3.10+ not found. Install via ${mgr}?`,
        initialValue: true,
      });
      if (!p.isCancel(installPy) && installPy) {
        const s = p.spinner();
        s.start(`Installing Python via ${mgr}...`);
        const pyResult = installPythonViaPackageManager(mgr);
        s.stop(pyResult.ok ? `Python installed via ${mgr}.` : "Python installation failed.");
      }
    }

    detectedPython = findBestPython();
    if (detectedPython) {
      p.log.success(`Python ${detectedPython.version.version} installed at ${detectedPython.path}`);
    }
  }

  const pythonDefault = detectedPython?.path
    ?? (existsSync("/opt/homebrew/bin/python3") ? "/opt/homebrew/bin/python3" : "python3");

  const pythonPath = await p.text({
    message: "Path to Python interpreter:",
    placeholder: "python3",
    defaultValue: pythonDefault,
  });

  if (p.isCancel(pythonPath)) { p.cancel("Cancelled."); process.exit(0); }

  const pyCheck = checkPythonVersion((pythonPath as string) || "python3");
  if (pyCheck.ok) {
    p.log.success(`Python ${pyCheck.version} OK`);
  } else if (pyCheck.version) {
    p.log.error(`Python ${pyCheck.version} is too old. v${MIN_PYTHON_VERSION.major}.${MIN_PYTHON_VERSION.minor}+ required.`);
    p.log.info("Install a newer Python and re-run: sportsclaw config");
    process.exit(1);
  } else {
    p.log.warn(`Could not verify Python at "${(pythonPath as string) || "python3"}". Proceeding anyway.`);
  }

  return (pythonPath as string) || "python3";
}

async function configureDiscordIntegration(savedConfig: CLIConfig): Promise<DiscordIntegrationConfig | null> {
  const existingToken = savedConfig.chatIntegrations?.discord?.botToken;

  let token: string;
  if (existingToken && existingToken.trim().length > 0) {
    const keep = await p.confirm({ message: "Discord bot token already set. Keep it?", initialValue: true });
    if (p.isCancel(keep)) return null;
    if (keep) {
      token = existingToken.trim();
    } else {
      const input = await p.password({
        message: "Paste your Discord bot token:",
        validate: (val) => (!val?.trim() ? "Bot token is required." : undefined),
      });
      if (p.isCancel(input)) return null;
      token = (input as string).trim();
    }
  } else {
    const input = await p.password({
      message: "Paste your Discord bot token:",
      validate: (val) => (!val?.trim() ? "Bot token is required." : undefined),
    });
    if (p.isCancel(input)) return null;
    token = (input as string).trim();
  }

  const existingAllowed = savedConfig.chatIntegrations?.discord?.allowedUsers;
  const allowedInput = await p.text({
    message: "Allowed Discord user IDs (comma-separated, or blank for public):",
    defaultValue: existingAllowed?.join(",") ?? "",
  });
  if (p.isCancel(allowedInput)) return null;
  const allowedUsers = parseCommaList(allowedInput as string);

  const existingPrefix = savedConfig.chatIntegrations?.discord?.prefix;
  const prefixInput = await p.text({
    message: "Command prefix:",
    defaultValue: existingPrefix || "!sportsclaw",
  });
  if (p.isCancel(prefixInput)) return null;

  const sync = syncTokenToEnvFile("DISCORD_BOT_TOKEN", token);
  if (sync === "updated") {
    p.log.warn(
      `Rewrote stale DISCORD_BOT_TOKEN in ~/.sportsclaw/.env to match the new token.`
    );
  }
  if (shellEnvConflict("DISCORD_BOT_TOKEN", token)) {
    p.log.warn(
      `Your shell already exports a different DISCORD_BOT_TOKEN. It will\n` +
      `  override this saved token until you run: ${pc.cyan("unset DISCORD_BOT_TOKEN")}`
    );
  }

  return {
    botToken: token,
    ...(allowedUsers.length > 0 && { allowedUsers }),
    prefix: (prefixInput as string) || "!sportsclaw",
  };
}

async function configureTelegramIntegration(savedConfig: CLIConfig): Promise<TelegramIntegrationConfig | null> {
  const existingToken = savedConfig.chatIntegrations?.telegram?.botToken;

  let token: string;
  if (existingToken && existingToken.trim().length > 0) {
    const keep = await p.confirm({ message: "Telegram bot token already set. Keep it?", initialValue: true });
    if (p.isCancel(keep)) return null;
    if (keep) {
      token = existingToken.trim();
    } else {
      const input = await p.password({
        message: "Paste your Telegram bot token:",
        validate: (val) => (!val?.trim() ? "Bot token is required." : undefined),
      });
      if (p.isCancel(input)) return null;
      token = (input as string).trim();
    }
  } else {
    const input = await p.password({
      message: "Paste your Telegram bot token:",
      validate: (val) => (!val?.trim() ? "Bot token is required." : undefined),
    });
    if (p.isCancel(input)) return null;
    token = (input as string).trim();
  }

  const existingAllowed = savedConfig.chatIntegrations?.telegram?.allowedUsers;
  const allowedInput = await p.text({
    message: "Allowed Telegram user IDs (comma-separated, or blank for public):",
    defaultValue: existingAllowed?.join(",") ?? "",
  });
  if (p.isCancel(allowedInput)) return null;
  const allowedUsers = parseCommaList(allowedInput as string);

  const sync = syncTokenToEnvFile("TELEGRAM_BOT_TOKEN", token);
  if (sync === "updated") {
    p.log.warn(
      `Rewrote stale TELEGRAM_BOT_TOKEN in ~/.sportsclaw/.env to match the new token.`
    );
  }
  if (shellEnvConflict("TELEGRAM_BOT_TOKEN", token)) {
    p.log.warn(
      `Your shell already exports a different TELEGRAM_BOT_TOKEN. It will\n` +
      `  override this saved token until you run: ${pc.cyan("unset TELEGRAM_BOT_TOKEN")}`
    );
  }

  return {
    botToken: token,
    ...(allowedUsers.length > 0 && { allowedUsers }),
  };
}

async function configureMcpInteractive(): Promise<void> {
  const configs = loadMcpConfigs();
  const names = Object.keys(configs);

  if (names.length > 0) {
    console.log("");
    console.log(pc.bold(`  Machina MCP (${names.length})`));
    for (const [name, config] of Object.entries(configs)) {
      const desc = config.description ? pc.dim(` — ${config.description}`) : "";
      console.log(`    ${pc.cyan(name)} ${pc.dim(config.url)}${desc}`);
    }
    console.log("");
  }

  const action = await p.select({
    message: "Machina MCP action:",
    options: [
      { value: "add", label: "Add a new MCP server" },
      ...(names.length > 0 ? [{ value: "remove", label: "Remove an MCP server" }] : []),
      { value: "done", label: "Done" },
    ],
  });

  if (p.isCancel(action) || action === "done") return;

  if (action === "add") {
    const url = await p.text({
      message: "MCP server URL:",
      placeholder: "https://your-pod.machina.gg/mcp/sse",
      validate: (val) => (!val?.trim() ? "URL is required." : undefined),
    });
    if (p.isCancel(url)) return;

    const name = await p.text({
      message: "Server name:",
      placeholder: "my-pod",
      validate: (val) => {
        if (!val?.trim()) return "Name is required.";
        if (!/^[a-zA-Z0-9_-]+$/.test(val.trim())) return "Only alphanumeric, hyphens, underscores.";
        return undefined;
      },
    });
    if (p.isCancel(name)) return;

    const token = await p.password({ message: "API token (or leave blank):" });
    if (p.isCancel(token)) return;

    const desc = await p.text({
      message: "Description (optional):",
      placeholder: "What this pod does",
      defaultValue: "",
    });
    if (p.isCancel(desc)) return;

    const updated = loadMcpConfigs();
    updated[(name as string).trim()] = {
      url: (url as string).trim(),
      ...(desc && (desc as string).trim() ? { description: (desc as string).trim() } : {}),
    };
    saveMcpConfigs(updated);

    // Save token to .env if provided
    if (token && (token as string).trim()) {
      const envKey = `SPORTSCLAW_MCP_TOKEN_${(name as string).trim().replace(/-/g, "_").toUpperCase()}`;
      const envPath = join(homedir(), ".sportsclaw", ".env");
      writeEnvVar(envPath, envKey, (token as string).trim());
      p.log.info(`Token saved as ${envKey}`);
    }

    p.log.success(`Added Machina MCP server "${(name as string).trim()}"`);
  } else if (action === "remove") {
    const toRemove = await p.select({
      message: "Which pod to remove?",
      options: names.map((n) => ({ value: n, label: n, hint: configs[n].url })),
    });
    if (p.isCancel(toRemove)) return;

    removeMcpConfig(toRemove as string);
    p.log.success(`Removed Machina MCP server "${toRemove}"`);
  }
}

// ---------------------------------------------------------------------------
// Sport selection UI
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
