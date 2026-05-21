/**
 * Anthropic OAuth — reuse Claude Code's existing session.
 *
 * Lets sportsclaw call `api.anthropic.com/v1/messages` with the user's Claude
 * Code Max OAuth token instead of an `ANTHROPIC_API_KEY`. We do not run our
 * own browser flow; we read whatever `claude login` already persisted and
 * refresh against `console.anthropic.com/v1/oauth/token` when the access
 * token is about to expire.
 *
 * Three things make this non-trivial and they're all handled here:
 *   1. The wire requires `Authorization: Bearer …` (not `x-api-key`) and
 *      the `anthropic-beta: oauth-2025-04-20` header. We override both via
 *      a custom `fetch` passed into `createAnthropic`.
 *   2. Anthropic rejects OAuth requests whose `system` field doesn't begin
 *      with the literal Claude Code prefix. We rewrite the JSON body to
 *      prepend that prefix and demote the caller's system content.
 *   3. Tokens expire (~1h). Refresh uses Claude Code's well-known
 *      `client_id` and rewrites the same source we read from, so `claude`
 *      itself stays usable.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import { createAnthropic, type AnthropicProvider } from "@ai-sdk/anthropic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Claude Code's public OAuth client id — same one the upstream CLI uses. */
const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/** Beta header gating OAuth access on the Messages API. */
const OAUTH_BETA_HEADER = "oauth-2025-04-20";

/** Required system-prompt prefix; Anthropic 400s without it under OAuth. */
const CLAUDE_CODE_SYSTEM_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude.";

const REFRESH_ENDPOINT = "https://console.anthropic.com/v1/oauth/token";

/** Refresh `expiresAt - LEEWAY_MS` to avoid racing token expiry under load. */
const LEEWAY_MS = 60_000;

/** macOS Keychain service Claude Code writes under. */
const KEYCHAIN_SERVICE = "Claude Code-credentials";

const CLAUDE_DIR = join(homedir(), ".claude");
const CLAUDE_CREDENTIALS_FILE = join(CLAUDE_DIR, ".credentials.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaudeCodeOAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix epoch milliseconds. */
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
}

interface ClaudeCodeCredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
  };
}

export type TokenSource = "file" | "keychain";

export interface LoadedTokens {
  tokens: ClaudeCodeOAuthTokens;
  source: TokenSource;
}

// ---------------------------------------------------------------------------
// Discovery — file and macOS Keychain
// ---------------------------------------------------------------------------

function parseCredentialsBlob(raw: string): ClaudeCodeOAuthTokens | undefined {
  let parsed: ClaudeCodeCredentialsFile;
  try {
    parsed = JSON.parse(raw) as ClaudeCodeCredentialsFile;
  } catch {
    return undefined;
  }
  const oauth = parsed.claudeAiOauth;
  if (!oauth?.accessToken || !oauth.refreshToken || typeof oauth.expiresAt !== "number") {
    return undefined;
  }
  return {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
    scopes: oauth.scopes,
    subscriptionType: oauth.subscriptionType,
  };
}

function readKeychain(): ClaudeCodeOAuthTokens | undefined {
  if (platform() !== "darwin") return undefined;
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 },
    );
    return parseCredentialsBlob(out.toString("utf-8"));
  } catch {
    return undefined;
  }
}

function readCredentialsFile(): ClaudeCodeOAuthTokens | undefined {
  if (!existsSync(CLAUDE_CREDENTIALS_FILE)) return undefined;
  try {
    return parseCredentialsBlob(readFileSync(CLAUDE_CREDENTIALS_FILE, "utf-8"));
  } catch {
    return undefined;
  }
}

/**
 * Synchronously load Claude Code's OAuth tokens. On macOS we try the Keychain
 * first because newer Claude Code installs write only there; on other
 * platforms (and as a fallback) we read the JSON file.
 */
export function loadClaudeCodeTokens(): LoadedTokens | undefined {
  if (platform() === "darwin") {
    const kc = readKeychain();
    if (kc) return { tokens: kc, source: "keychain" };
  }
  const file = readCredentialsFile();
  if (file) return { tokens: file, source: "file" };
  return undefined;
}

// ---------------------------------------------------------------------------
// Persistence — write refreshed tokens back to the same source
// ---------------------------------------------------------------------------

function writeKeychain(tokens: ClaudeCodeOAuthTokens): boolean {
  if (platform() !== "darwin") return false;
  const blob = JSON.stringify({
    claudeAiOauth: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      subscriptionType: tokens.subscriptionType,
    },
  });
  try {
    execFileSync(
      "security",
      [
        "add-generic-password",
        "-U", // update if exists
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        process.env.USER ?? "",
        "-w",
        blob,
      ],
      { stdio: ["ignore", "ignore", "ignore"], timeout: 5_000 },
    );
    return true;
  } catch {
    return false;
  }
}

function writeCredentialsFile(tokens: ClaudeCodeOAuthTokens): boolean {
  try {
    // Preserve any unrelated keys that may be in the file
    let existing: ClaudeCodeCredentialsFile = {};
    if (existsSync(CLAUDE_CREDENTIALS_FILE)) {
      try {
        existing = JSON.parse(
          readFileSync(CLAUDE_CREDENTIALS_FILE, "utf-8"),
        ) as ClaudeCodeCredentialsFile;
      } catch {
        existing = {};
      }
    }
    existing.claudeAiOauth = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      subscriptionType: tokens.subscriptionType,
    };
    writeFileSync(CLAUDE_CREDENTIALS_FILE, JSON.stringify(existing, null, 2) + "\n", "utf-8");
    try { chmodSync(CLAUDE_CREDENTIALS_FILE, 0o600); } catch { /* best effort */ }
    return true;
  } catch {
    return false;
  }
}

function persistTokens(tokens: ClaudeCodeOAuthTokens, source: TokenSource): void {
  if (source === "keychain") {
    if (writeKeychain(tokens)) return;
    // Fallback to file if Keychain write failed
    writeCredentialsFile(tokens);
    return;
  }
  writeCredentialsFile(tokens);
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

interface RefreshResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

async function refreshTokens(
  current: ClaudeCodeOAuthTokens,
): Promise<ClaudeCodeOAuthTokens> {
  const res = await fetch(REFRESH_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
      client_id: CLAUDE_CODE_CLIENT_ID,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Claude OAuth refresh failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`,
    );
  }
  const data = (await res.json()) as RefreshResponse;
  if (!data.access_token || !data.refresh_token || typeof data.expires_in !== "number") {
    throw new Error("Claude OAuth refresh response missing required fields.");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scopes: data.scope ? data.scope.split(" ").filter(Boolean) : current.scopes,
    subscriptionType: current.subscriptionType,
  };
}

function isExpired(tokens: ClaudeCodeOAuthTokens): boolean {
  return Date.now() >= tokens.expiresAt - LEEWAY_MS;
}

/**
 * Return a token guaranteed to be valid for at least LEEWAY_MS more.
 * Refreshes and persists if necessary.
 */
export async function refreshIfNeeded(
  loaded: LoadedTokens,
): Promise<ClaudeCodeOAuthTokens> {
  if (!isExpired(loaded.tokens)) return loaded.tokens;
  const fresh = await refreshTokens(loaded.tokens);
  persistTokens(fresh, loaded.source);
  return fresh;
}

// ---------------------------------------------------------------------------
// System-prompt rewriting
// ---------------------------------------------------------------------------

/** Body shapes the AI SDK sends to `/v1/messages`. We only touch `system`. */
interface MessagesRequestBody {
  system?:
    | string
    | Array<{ type: "text"; text: string; cache_control?: unknown }>;
  [key: string]: unknown;
}

/** @internal — exported for tests. */
export function injectSystemPrefix(body: MessagesRequestBody): MessagesRequestBody {
  const prefixBlock = { type: "text" as const, text: CLAUDE_CODE_SYSTEM_PREFIX };
  if (!body.system) {
    return { ...body, system: [prefixBlock] };
  }
  if (typeof body.system === "string") {
    if (body.system.startsWith(CLAUDE_CODE_SYSTEM_PREFIX)) return body;
    return { ...body, system: [prefixBlock, { type: "text", text: body.system }] };
  }
  // Already an array
  const first = body.system[0];
  if (first && first.type === "text" && first.text.startsWith(CLAUDE_CODE_SYSTEM_PREFIX)) {
    return body;
  }
  return { ...body, system: [prefixBlock, ...body.system] };
}

// ---------------------------------------------------------------------------
// Custom fetch — strip x-api-key, inject Bearer + beta, rewrite system
// ---------------------------------------------------------------------------

interface TokenHolder {
  loaded: LoadedTokens;
}

function buildOAuthFetch(holder: TokenHolder): typeof fetch {
  return async (input, init) => {
    const tokens = await refreshIfNeeded(holder.loaded);
    // Persist the in-memory snapshot so subsequent requests see the fresh expiry
    holder.loaded = { tokens, source: holder.loaded.source };

    const headers = new Headers(init?.headers ?? {});
    headers.delete("x-api-key");
    headers.set("authorization", `Bearer ${tokens.accessToken}`);

    const existingBeta = headers.get("anthropic-beta");
    headers.set(
      "anthropic-beta",
      existingBeta && !existingBeta.includes(OAUTH_BETA_HEADER)
        ? `${existingBeta},${OAUTH_BETA_HEADER}`
        : OAUTH_BETA_HEADER,
    );

    let body = init?.body;
    if (typeof body === "string") {
      try {
        const parsed = JSON.parse(body) as MessagesRequestBody;
        body = JSON.stringify(injectSystemPrefix(parsed));
      } catch {
        // Non-JSON body — pass through untouched. Should not happen for /v1/messages.
      }
    }

    return fetch(input, { ...init, headers, body });
  };
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

/**
 * Build an `@ai-sdk/anthropic` provider that authenticates via the supplied
 * Claude Code OAuth session. The returned provider is callable the same way
 * as the SDK's default singleton — `provider(modelId)` yields a LanguageModel.
 *
 * `loaded` is captured by reference so refresh-on-the-fly survives across
 * requests on the same provider instance.
 */
export function createAnthropicOAuthProvider(
  loaded: LoadedTokens,
): AnthropicProvider {
  const holder: TokenHolder = { loaded };
  return createAnthropic({
    // The custom fetch overrides the auth header before the request leaves;
    // this placeholder just satisfies the SDK's apiKey-required check.
    apiKey: "oauth-placeholder",
    fetch: buildOAuthFetch(holder),
  });
}

// ---------------------------------------------------------------------------
// Helpers for callers (login command, doctor, status)
// ---------------------------------------------------------------------------

export interface OAuthAvailability {
  available: boolean;
  source?: TokenSource;
  /** Milliseconds until the *access* token expires; negative if already expired. */
  expiresInMs?: number;
  subscriptionType?: string;
  reason?: string;
}

/** Inspect the current Claude Code session without refreshing. */
export function inspectClaudeCodeSession(): OAuthAvailability {
  const loaded = loadClaudeCodeTokens();
  if (!loaded) {
    return {
      available: false,
      reason:
        "No Claude Code session found. Run `claude login` to sign in to Claude Code first.",
    };
  }
  return {
    available: true,
    source: loaded.source,
    expiresInMs: loaded.tokens.expiresAt - Date.now(),
    subscriptionType: loaded.tokens.subscriptionType,
  };
}
