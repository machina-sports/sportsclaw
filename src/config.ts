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
  DEFAULT_ROUTER_MODELS,
  PROVIDER_MODEL_PROFILES,
  type LLMProvider,
  type sportsclawConfig,
} from "./types.js";

// ---------------------------------------------------------------------------
// Config shape persisted to disk
// ---------------------------------------------------------------------------

export interface CLIConfig {
  provider?: LLMProvider;
  model?: string;
  routerModelStrategy?: "provider_fast" | "same_as_main";
  routerModel?: string;
  apiKey?: string;
  pythonPath?: string;
  routingMode?: "soft_lock";
  routingMaxSkills?: number;
  routingAllowSpillover?: number;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CONFIG_DIR = join(homedir(), ".sportsclaw");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

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
  routerModelStrategy: NonNullable<sportsclawConfig["routerModelStrategy"]>;
  routerModel: string;
  apiKey: string | undefined;
  pythonPath: string;
  routingMode: "soft_lock";
  routingMaxSkills: number;
  routingAllowSpillover: number;
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

function parseRouterModelStrategy(
  value: string | undefined
): NonNullable<sportsclawConfig["routerModelStrategy"]> {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "same_as_main") return "same_as_main";
  return "provider_fast";
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

  const routerModelStrategy = parseRouterModelStrategy(
    firstEnv("SPORTSCLAW_ROUTER_STRATEGY", "sportsclaw_ROUTER_STRATEGY") ||
      file.routerModelStrategy
  );
  const configuredRouterModel =
    firstEnv("SPORTSCLAW_ROUTER_MODEL", "sportsclaw_ROUTER_MODEL") ||
    file.routerModel;
  const routerModel =
    configuredRouterModel ||
    (routerModelStrategy === "same_as_main"
      ? model
      : DEFAULT_ROUTER_MODELS[provider]);

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

  return {
    provider,
    model,
    routerModelStrategy,
    routerModel,
    apiKey,
    pythonPath,
    routingMode,
    routingMaxSkills,
    routingAllowSpillover,
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
  if (!process.env.SPORTSCLAW_ROUTER_STRATEGY) {
    process.env.SPORTSCLAW_ROUTER_STRATEGY = resolved.routerModelStrategy;
  }
  if (!process.env.sportsclaw_ROUTER_STRATEGY) {
    process.env.sportsclaw_ROUTER_STRATEGY = resolved.routerModelStrategy;
  }
  if (!process.env.SPORTSCLAW_ROUTER_MODEL) {
    process.env.SPORTSCLAW_ROUTER_MODEL = resolved.routerModel;
  }
  if (!process.env.sportsclaw_ROUTER_MODEL) {
    process.env.sportsclaw_ROUTER_MODEL = resolved.routerModel;
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

  const pythonPath = await p.text({
    message: "🐍 Path to Python interpreter:",
    placeholder: "python3",
    defaultValue: existsSync("/opt/homebrew/bin/python3")
      ? "/opt/homebrew/bin/python3"
      : "python3",
  });

  if (p.isCancel(pythonPath)) {
    p.cancel("🚫 Setup cancelled.");
    process.exit(0);
  }

  const config: CLIConfig = {
    provider: selectedProvider,
    model: model as string,
    routerModelStrategy: "provider_fast",
    routerModel: DEFAULT_ROUTER_MODELS[selectedProvider],
    apiKey: finalApiKey,
    pythonPath: (pythonPath as string) || "python3",
  };

  saveConfig(config);
  p.outro(`✅ Config saved to ${CONFIG_PATH}`);

  return config;
}
