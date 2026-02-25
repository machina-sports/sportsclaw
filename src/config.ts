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
import type { LLMProvider } from "./types.js";

// ---------------------------------------------------------------------------
// Config shape persisted to disk
// ---------------------------------------------------------------------------

export interface CLIConfig {
  provider?: LLMProvider;
  apiKey?: string;
  pythonPath?: string;
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
  apiKey: string | undefined;
  pythonPath: string;
}

export function resolveConfig(): ResolvedConfig {
  const file = loadConfig();

  const provider = (process.env.sportsclaw_PROVIDER || file.provider || "anthropic") as LLMProvider;
  const envVar = PROVIDER_ENV[provider];

  // env var > config-file apiKey (only if provider matches)
  const apiKey = process.env[envVar] || file.apiKey;
  const pythonPath = process.env.PYTHON_PATH || file.pythonPath || "python3";

  return { provider, apiKey, pythonPath };
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
  if (!process.env.sportsclaw_PROVIDER) {
    process.env.sportsclaw_PROVIDER = resolved.provider;
  }
  if (!process.env.PYTHON_PATH && resolved.pythonPath !== "python3") {
    process.env.PYTHON_PATH = resolved.pythonPath;
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Interactive setup via @clack/prompts
// ---------------------------------------------------------------------------

export async function runConfigFlow(): Promise<CLIConfig> {
  
const ASCII_LOGO = `
███████╗██████╗  ██████╗ ██████╗ ████████╗███████╗ ██████╗██╗      █████╗ ██╗    ██╗
██╔════╝██╔══██╗██╔═══██╗██╔══██╗╚══██╔══╝██╔════╝██╔════╝██║     ██╔══██╗██║    ██║
███████╗██████╔╝██║   ██║██████╔╝   ██║   ███████╗██║     ██║     ███████║██║ █╗ ██║
╚════██║██╔═══╝ ██║   ██║██╔══██╗   ██║   ╚════██║██║     ██║     ██╔══██║██║███╗██║
███████║██║     ╚██████╔╝██║  ██║   ██║   ███████║╚██████╗███████╗██║  ██║╚███╔███╔╝
╚══════╝╚═╝      ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝ ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ 
`;

  console.log(pc.bold(pc.blue(ASCII_LOGO)));
  p.intro("🦞 sportsclaw Configuration");

  const provider = await p.select({
    message: "⚡ Which LLM provider would you like to use?",
    options: [
      { value: "anthropic", label: "Anthropic", hint: "Claude" },
      { value: "openai", label: "OpenAI", hint: "GPT-4o" },
      { value: "google", label: "Google", hint: "Gemini" },
    ],
  });

  if (p.isCancel(provider)) {
    p.cancel("🚫 Setup cancelled.");
    process.exit(0);
  }

  const envName = PROVIDER_ENV[provider as LLMProvider];

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

  const pythonPath = await p.text({
    message: "🐍 Path to Python interpreter:",
    placeholder: "python3",
    defaultValue: "python3",
  });

  if (p.isCancel(pythonPath)) {
    p.cancel("🚫 Setup cancelled.");
    process.exit(0);
  }

  const config: CLIConfig = {
    provider: provider as LLMProvider,
    apiKey: (apiKey as string).trim(),
    pythonPath: (pythonPath as string) || "python3",
  };

  saveConfig(config);
  p.outro(`✅ Config saved to ${CONFIG_PATH}`);

  return config;
}
