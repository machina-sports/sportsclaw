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
  model?: string;
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

const PROVIDER_MODELS: Record<LLMProvider, Array<{ value: string; label: string; hint?: string }>> = {
  anthropic: [
    { value: "claude-sonnet-4-5-20250514", label: "Claude Sonnet 4.5", hint: "recommended" },
    { value: "claude-opus-4-6", label: "Claude Opus 4.6", hint: "most capable" },
  ],
  openai: [
    { value: "gpt-5.3-codex", label: "GPT-5.3 Codex", hint: "recommended" },
  ],
  google: [
    { value: "gemini-3-flash-preview", label: "Gemini 3 Flash", hint: "recommended" },
    { value: "gemini-3-pro-preview", label: "Gemini 3 Pro", hint: "advanced reasoning" },
    { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", hint: "most capable" },
  ],
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
}

export function resolveConfig(): ResolvedConfig {
  const file = loadConfig();

  const provider = (process.env.sportsclaw_PROVIDER || file.provider || "anthropic") as LLMProvider;
  const envVar = PROVIDER_ENV[provider];

  const model = process.env.sportsclaw_MODEL || file.model;

  // env var > config-file apiKey (only if provider matches)
  const apiKey = process.env[envVar] || file.apiKey;
  const defaultPythonPath = existsSync("/opt/homebrew/bin/python3")
    ? "/opt/homebrew/bin/python3"
    : "python3";
  const pythonPath = process.env.PYTHON_PATH || file.pythonPath || defaultPythonPath;

  return { provider, model, apiKey, pythonPath };
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
    options: PROVIDER_MODELS[provider as LLMProvider],
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
    apiKey: finalApiKey,
    pythonPath: (pythonPath as string) || "python3",
  };

  saveConfig(config);
  p.outro(`✅ Config saved to ${CONFIG_PATH}`);

  return config;
}
