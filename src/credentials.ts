/**
 * sportsclaw Engine — Multi-LLM Credential Manager (Keychain)
 *
 * Securely stores and retrieves API keys for multiple LLM providers
 * (Anthropic, OpenAI, Gemini) concurrently in ~/.sportsclaw/credentials.json.
 *
 * Resolution order per provider:
 *   1. Environment variable (always wins)
 *   2. credentials.json keychain
 *   3. Legacy config.json migration (one-time)
 *   4. Interactive prompt (if TTY)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CRED_DIR = join(homedir(), ".sportsclaw");
const CRED_FILE = join(CRED_DIR, "credentials.json");
const CONFIG_FILE = join(CRED_DIR, "config.json");

// ---------------------------------------------------------------------------
// Provider ↔ credential key mapping
// ---------------------------------------------------------------------------

export type CredentialProvider = "anthropic" | "openai" | "gemini";

/** Map provider name → keychain field + env var */
const PROVIDER_MAP: Record<CredentialProvider, { field: string; envVar: string; label: string }> = {
  anthropic: { field: "ANTHROPIC_API_KEY", envVar: "ANTHROPIC_API_KEY", label: "Anthropic (Claude)" },
  openai: { field: "OPENAI_API_KEY", envVar: "OPENAI_API_KEY", label: "OpenAI (GPT)" },
  gemini: { field: "GEMINI_API_KEY", envVar: "GEMINI_API_KEY", label: "Google (Gemini)" },
};

/** All recognized credential fields */
export const ALL_CREDENTIAL_FIELDS = Object.values(PROVIDER_MAP).map((v) => v.field);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CredentialStore {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  [key: string]: string | undefined;
}

export interface ProviderStatus {
  provider: CredentialProvider;
  label: string;
  authenticated: boolean;
  source: "env" | "keychain" | "none";
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

function ensureDir(): void {
  if (!existsSync(CRED_DIR)) mkdirSync(CRED_DIR, { recursive: true });
}

export function getCredentials(): CredentialStore {
  if (!existsSync(CRED_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CRED_FILE, "utf-8")) as CredentialStore;
  } catch {
    return {};
  }
}

export function saveCredentials(creds: Partial<CredentialStore>): void {
  ensureDir();
  const existing = getCredentials();
  const merged = { ...existing, ...creds };
  writeFileSync(CRED_FILE, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  try {
    chmodSync(CRED_FILE, 0o600);
  } catch {
    // chmod may not be supported on all platforms
  }
}

export function deleteCredential(field: string): void {
  const existing = getCredentials();
  delete existing[field];
  ensureDir();
  writeFileSync(CRED_FILE, JSON.stringify(existing, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Legacy migration (config.json → credentials.json)
// ---------------------------------------------------------------------------

let migrationDone = false;

export function migrateLegacyConfig(): void {
  if (migrationDone) return;
  migrationDone = true;

  if (!existsSync(CONFIG_FILE)) return;
  try {
    const legacy = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    if (legacy.apiKey && legacy.provider) {
      const providerToField: Record<string, string> = {
        google: "GEMINI_API_KEY",
        anthropic: "ANTHROPIC_API_KEY",
        openai: "OPENAI_API_KEY",
      };
      const field = providerToField[legacy.provider];
      if (field) {
        const existing = getCredentials();
        if (!existing[field]) {
          saveCredentials({ [field]: legacy.apiKey });
          p.log.info(`Migrated legacy ${legacy.provider} API key to the multi-LLM keychain.`);
        }
      }
    }
  } catch {
    // Ignore parse errors in legacy config
  }
}

// ---------------------------------------------------------------------------
// Resolution: env → keychain → undefined
// ---------------------------------------------------------------------------

/**
 * Resolve a provider's API key without prompting.
 * Returns the key string or undefined if not found anywhere.
 */
export function resolveCredential(provider: CredentialProvider): string | undefined {
  migrateLegacyConfig();
  const info = PROVIDER_MAP[provider];

  // 1. Environment variable
  const envVal = process.env[info.envVar];
  if (envVal && envVal.trim().length > 0) return envVal.trim();

  // 2. Keychain file
  const creds = getCredentials();
  const stored = creds[info.field];
  if (stored && stored.trim().length > 0) return stored.trim();

  return undefined;
}

/**
 * Check whether a provider has a valid credential available (env or keychain).
 */
export function hasCredential(provider: CredentialProvider): boolean {
  return resolveCredential(provider) !== undefined;
}

// ---------------------------------------------------------------------------
// Interactive credential prompting
// ---------------------------------------------------------------------------

/**
 * Ensure a provider credential is available.
 * If missing, interactively prompts the user (unless nonInteractive is true).
 * Returns the API key or exits if the user cancels.
 */
export async function ensureCredential(
  provider: CredentialProvider,
  opts?: { nonInteractive?: boolean; reason?: string }
): Promise<string> {
  const existing = resolveCredential(provider);
  if (existing) return existing;

  const info = PROVIDER_MAP[provider];

  if (opts?.nonInteractive) {
    p.log.error(
      `${info.label} API key is required but not found.\n` +
      `  Set ${info.envVar} in your environment or run: sportsclaw config`
    );
    process.exit(1);
  }

  if (opts?.reason) {
    p.log.warn(opts.reason);
  }

  const key = await p.text({
    message: `Enter your ${info.label} API key:`,
    placeholder: provider === "gemini" ? "AIzaSy..." : "sk-...",
    validate: (val) => (!val || val.trim().length === 0 ? "API key is required." : undefined),
  });

  if (p.isCancel(key)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  const trimmed = (key as string).trim();
  saveCredentials({ [info.field]: trimmed });
  p.log.success(`${info.label} API key saved to keychain.`);
  return trimmed;
}

// ---------------------------------------------------------------------------
// Status / listing
// ---------------------------------------------------------------------------

/**
 * Get the authentication status of all supported providers.
 */
export function listProviderStatus(): ProviderStatus[] {
  migrateLegacyConfig();

  return (Object.entries(PROVIDER_MAP) as [CredentialProvider, typeof PROVIDER_MAP[CredentialProvider]][]).map(
    ([provider, info]) => {
      const envVal = process.env[info.envVar];
      if (envVal && envVal.trim().length > 0) {
        return { provider, label: info.label, authenticated: true, source: "env" as const };
      }

      const creds = getCredentials();
      const stored = creds[info.field];
      if (stored && stored.trim().length > 0) {
        return { provider, label: info.label, authenticated: true, source: "keychain" as const };
      }

      return { provider, label: info.label, authenticated: false, source: "none" as const };
    }
  );
}

/**
 * Print a formatted status table of all provider credentials.
 */
export function printCredentialStatus(): void {
  const statuses = listProviderStatus();
  for (const s of statuses) {
    const icon = s.authenticated ? "+" : "-";
    const sourceHint = s.source === "env" ? " (env)" : s.source === "keychain" ? " (keychain)" : "";
    const status = s.authenticated ? `authenticated${sourceHint}` : "not configured";
    p.log.info(`[${icon}] ${s.label}: ${status}`);
  }
}
