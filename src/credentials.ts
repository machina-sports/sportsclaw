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

import {
  loadClaudeCodeTokens,
  inspectClaudeCodeSession,
  type ClaudeCodeOAuthTokens,
} from "./anthropic-oauth.js";

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

/** Per-provider authentication method. Forward-compatible with future
 * `oauth_chatgpt` for OpenAI/Codex; right now only Anthropic OAuth is wired. */
export type AnthropicAuthMethod = "api_key" | "oauth_claude_code";

export interface AuthMethodMap {
  anthropic?: AnthropicAuthMethod;
}

/**
 * On-disk credential store. API-key fields live at the top level keyed by
 * their env-var name (so legacy reads keep working); `authMethod` is the
 * one structured exception. The string index signature only types the
 * key fields — callers that touch `authMethod` go through the helpers below.
 */
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
  source: "env" | "keychain" | "oauth" | "none";
  /** Free-text detail for the OAuth source ("Claude Code Max, expires in 42 min"). */
  detail?: string;
}

/** Resolved authentication for an LLM provider. Discriminated by `kind`. */
export type ResolvedAuth =
  | { kind: "api_key"; value: string; source: "env" | "keychain" }
  | { kind: "oauth_claude_code"; tokens: ClaudeCodeOAuthTokens; tokenSource: "file" | "keychain" };

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

function ensureDir(): void {
  if (!existsSync(CRED_DIR)) mkdirSync(CRED_DIR, { recursive: true });
}

/** Raw, untyped view of the JSON file. Holds string fields *and* authMethod. */
function readRawStore(): Record<string, unknown> {
  if (!existsSync(CRED_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(CRED_FILE, "utf-8"));
    return (parsed && typeof parsed === "object") ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeRawStore(raw: Record<string, unknown>): void {
  ensureDir();
  writeFileSync(CRED_FILE, JSON.stringify(raw, null, 2) + "\n", "utf-8");
  try { chmodSync(CRED_FILE, 0o600); } catch { /* chmod best-effort */ }
}

export function getCredentials(): CredentialStore {
  const raw = readRawStore();
  const out: CredentialStore = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === "authMethod") continue;
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export function saveCredentials(creds: Partial<CredentialStore>): void {
  const raw = readRawStore();
  for (const [k, v] of Object.entries(creds)) {
    if (k === "authMethod") continue;
    if (v === undefined) delete raw[k]; else raw[k] = v;
  }
  writeRawStore(raw);
}

export function deleteCredential(field: string): void {
  const raw = readRawStore();
  delete raw[field];
  writeRawStore(raw);
}

// ---------------------------------------------------------------------------
// Auth-method accessor (typed view of the `authMethod` JSON field)
// ---------------------------------------------------------------------------

export function getAuthMethods(): AuthMethodMap {
  const raw = readRawStore();
  const am = raw.authMethod;
  if (!am || typeof am !== "object") return {};
  return am as AuthMethodMap;
}

export function setAnthropicAuthMethod(method: AnthropicAuthMethod | undefined): void {
  const raw = readRawStore();
  const current = (raw.authMethod && typeof raw.authMethod === "object")
    ? { ...(raw.authMethod as AuthMethodMap) }
    : {};
  if (method === undefined) {
    delete current.anthropic;
  } else {
    current.anthropic = method;
  }
  if (Object.keys(current).length === 0) {
    delete raw.authMethod;
  } else {
    raw.authMethod = current;
  }
  writeRawStore(raw);
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
 *
 * Note: this only looks at API-key sources. Anthropic OAuth is handled
 * separately via `resolveAnthropicAuth`, because OAuth callers need the
 * full token object, not a string.
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
// Anthropic auth — API key OR Claude Code OAuth
// ---------------------------------------------------------------------------

/**
 * Resolve which authentication path Anthropic calls should use.
 *
 * Precedence:
 *   1. `ANTHROPIC_API_KEY` in the process env (explicit override always wins)
 *   2. `ANTHROPIC_API_KEY` in the keychain JSON
 *   3. Claude Code OAuth — only if the user opted in via
 *      `authMethod.anthropic === "oauth_claude_code"` AND a session is loadable
 *
 * The opt-in flag matters: having Claude Code installed must not silently
 * change which credentials we use. The user enables OAuth via
 * `sportsclaw login claude` (or the config wizard).
 */
export function resolveAnthropicAuth(): ResolvedAuth | undefined {
  migrateLegacyConfig();

  const envVal = process.env.ANTHROPIC_API_KEY;
  if (envVal && envVal.trim().length > 0) {
    return { kind: "api_key", value: envVal.trim(), source: "env" };
  }

  const creds = getCredentials();
  const stored = creds.ANTHROPIC_API_KEY;
  if (stored && stored.trim().length > 0) {
    return { kind: "api_key", value: stored.trim(), source: "keychain" };
  }

  if (getAuthMethods().anthropic === "oauth_claude_code") {
    const loaded = loadClaudeCodeTokens();
    if (loaded) {
      return {
        kind: "oauth_claude_code",
        tokens: loaded.tokens,
        tokenSource: loaded.source,
      };
    }
  }

  return undefined;
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

      // OAuth path is opt-in and Anthropic-only.
      if (provider === "anthropic" && getAuthMethods().anthropic === "oauth_claude_code") {
        const session = inspectClaudeCodeSession();
        if (session.available) {
          const minLeft = Math.max(0, Math.floor((session.expiresInMs ?? 0) / 60_000));
          const sub = session.subscriptionType ? `Claude Code ${session.subscriptionType}` : "Claude Code";
          return {
            provider,
            label: info.label,
            authenticated: true,
            source: "oauth" as const,
            detail: `${sub}, expires in ${minLeft} min`,
          };
        }
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
    const sourceHint =
      s.source === "env" ? " (env)" :
      s.source === "keychain" ? " (keychain)" :
      s.source === "oauth" ? ` (oauth · ${s.detail ?? "Claude Code"})` :
      "";
    const status = s.authenticated ? `authenticated${sourceHint}` : "not configured";
    p.log.info(`[${icon}] ${s.label}: ${status}`);
  }
}
