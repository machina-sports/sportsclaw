/**
 * sportsclaw Engine — Connection Manager (Connection-Brokered Auth)
 *
 * Implements the security posture inspired by Vercel's `eve`:
 * The LLM model never sees the URL, raw tokens, or credentials.
 * Credentials are resolved and injected securely by the harness at runtime,
 * isolating the prompt/reasoning layer from critical secrets.
 *
 * Highly sensitive process secrets (like Anthropic/OpenAI API keys,
 * Discord/Telegram bot tokens) are stripped from the environment before
 * spawning subprocesses (sandboxed environment).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CONNECTIONS_DIR = join(homedir(), ".sportsclaw");
const CONNECTIONS_CONFIG_PATH = join(CONNECTIONS_DIR, "connections.json");

// ---------------------------------------------------------------------------
// Types & Defaults
// ---------------------------------------------------------------------------

export interface ConnectionConfig {
  /** Connection type: "http" | "mcp" | "python-env" */
  type: "http" | "mcp" | "python-env";
  /** Optional base API URL */
  url?: string;
  /**
   * Environment variable mapping (target_key -> source_env_key or literal value).
   * E.g. { "POLYMARKET_API_KEY": "env:POLYMARKET_API_KEY" }
   */
  envMapping?: Record<string, string>;
  /** Optional headers mapping for HTTP connections */
  headersMapping?: Record<string, string>;
}

/** Standard keys to always strip from the sandboxed child process environment */
export const SENSITIVE_PROCESS_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "DISCORD_BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "ALLOWED_USERS",
  "TELEGRAM_ALLOWED_USERS",
  "SPORTSCLAW_API_KEY",
  "CLAUDE_OAUTH_TOKEN",
  "CLAUDE_CODE_TOKEN",
];

/** Standard allowed keys to copy into the clean sandbox env */
export const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "PWD",
  "TERM",
  "VIRTUAL_ENV",
  "PYTHONPATH",
  "PYTHONIOENCODING",
  "NODE_ENV",
  "XDG_CACHE_HOME", // sports_skills cricket cache dir (falls back to ~/.cache)
];

/**
 * Standard platform credentials map.
 *
 * Only providers whose credentials `sports_skills` actually reads belong here.
 * Polymarket trading (`polymarket/_cli.py`) reads `POLYMARKET_PRIVATE_KEY`; its
 * public read endpoints, Kalshi (public API), and the ESPN-backed sports need no
 * credentials. Betfair/Sportradar/api-football have no integration in the data
 * layer, so they are intentionally absent — a mapping here would only broker env
 * vars nothing reads.
 */
const STANDARD_CONNECTION_DEFAULTS: Record<string, ConnectionConfig> = {
  polymarket: {
    type: "python-env",
    envMapping: {
      POLYMARKET_PRIVATE_KEY: "env:POLYMARKET_PRIVATE_KEY",
    },
  },
};

// ---------------------------------------------------------------------------
// Connections Manager
// ---------------------------------------------------------------------------

export class ConnectionManager {
  private configs: Record<string, ConnectionConfig> = {};
  private verbose: boolean;

  constructor(verbose = false) {
    this.verbose = verbose;
    this.configs = this.loadConfigs();
  }

  /**
   * Load configurations from different sources (ordered by priority):
   * 1. Env var SPORTSCLAW_CONNECTIONS (JSON string)
   * 2. Local connections.json file in current working directory
   * 3. Global ~/.sportsclaw/connections.json file
   * 4. Standard platform connection defaults
   */
  private loadConfigs(): Record<string, ConnectionConfig> {
    const base = { ...STANDARD_CONNECTION_DEFAULTS };

    // 1. Global user config (~/.sportsclaw/connections.json)
    if (existsSync(CONNECTIONS_CONFIG_PATH)) {
      try {
        const globalConfigs = JSON.parse(readFileSync(CONNECTIONS_CONFIG_PATH, "utf-8"));
        Object.assign(base, globalConfigs);
      } catch (err) {
        console.error(`[sportsclaw] Failed to parse global connections config: ${err}`);
      }
    }

    // 2. Working directory connections.json
    if (existsSync("connections.json")) {
      try {
        const localConfigs = JSON.parse(readFileSync("connections.json", "utf-8"));
        Object.assign(base, localConfigs);
        if (this.verbose) {
          console.error(`[sportsclaw] connections: loaded ${Object.keys(localConfigs).length} connection(s) from ./connections.json`);
        }
      } catch {
        // No local connections.json — that's fine
      }
    }

    // 3. Environment variable full override
    const envJson = process.env.SPORTSCLAW_CONNECTIONS;
    if (envJson) {
      try {
        const envConfigs = JSON.parse(envJson) as Record<string, ConnectionConfig>;
        Object.assign(base, envConfigs);
        if (this.verbose) {
          console.error(`[sportsclaw] connections: loaded ${Object.keys(envConfigs).length} connection(s) from SPORTSCLAW_CONNECTIONS`);
        }
      } catch (err) {
        console.error(`[sportsclaw] connections: invalid SPORTSCLAW_CONNECTIONS JSON: ${err}`);
      }
    }

    return base;
  }

  /** Save connection configs to ~/.sportsclaw/connections.json */
  saveGlobalConfigs(configs: Record<string, ConnectionConfig>): void {
    if (!existsSync(CONNECTIONS_DIR)) {
      mkdirSync(CONNECTIONS_DIR, { recursive: true });
    }
    writeFileSync(CONNECTIONS_CONFIG_PATH, JSON.stringify(configs, null, 2) + "\n", "utf-8");
  }

  /**
   * Safe clean sandboxed child process environment.
   * Strips all highly sensitive process credentials to prevent any leak or prompt injection attacks.
   */
  getSandboxEnv(connectionName?: string, extraEnv?: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};

    // 1. Copy only safe/non-sensitive process env keys
    for (const key of SAFE_ENV_KEYS) {
      if (process.env[key] !== undefined) {
        env[key] = process.env[key]!;
      }
    }

    // 2. Filter base env to ensure we don't accidentally copy any known sensitive keys (whitelist only)

    // 3. Add extra env keys passed explicitly
    if (extraEnv) {
      for (const [key, value] of Object.entries(extraEnv)) {
        if (value !== undefined && !SENSITIVE_PROCESS_KEYS.includes(key)) {
          env[key] = value;
        }
      }
    }

    // 4. Resolve and inject Connection-brokered credentials
    if (connectionName) {
      const conn = this.configs[connectionName.toLowerCase()];
      if (conn) {
        if (this.verbose) {
          console.error(`[sportsclaw] connections: resolving and brokering auth for connection "${connectionName}"`);
        }

        if (conn.envMapping) {
          for (const [targetKey, sourceMapping] of Object.entries(conn.envMapping)) {
            let resolvedValue: string | undefined = undefined;

            if (sourceMapping.startsWith("env:")) {
              const envVarName = sourceMapping.slice(4);
              resolvedValue = process.env[envVarName];
            } else {
              resolvedValue = sourceMapping; // Literal value
            }

            if (resolvedValue !== undefined) {
              env[targetKey] = resolvedValue;
            }
          }
        }
      } else {
        if (this.verbose) {
          console.error(`[sportsclaw] connections: no explicit connection definition found for "${connectionName}", attempting standard fallback lookup`);
        }
        // Fallback: If no explicit connection found, check if it's a standard one or fallback directly to env lookup
        const fallbackConn = STANDARD_CONNECTION_DEFAULTS[connectionName.toLowerCase()];
        if (fallbackConn && fallbackConn.envMapping) {
          for (const [targetKey, sourceMapping] of Object.entries(fallbackConn.envMapping)) {
            const envVarName = sourceMapping.startsWith("env:") ? sourceMapping.slice(4) : sourceMapping;
            if (process.env[envVarName] !== undefined) {
              env[targetKey] = process.env[envVarName]!;
            }
          }
        }
      }
    }

    return env;
  }

  /** Check if a connection exists in the registry */
  hasConnection(name: string): boolean {
    return this.configs[name.toLowerCase()] !== undefined;
  }

  /** Get a connection configuration */
  getConnection(name: string): ConnectionConfig | undefined {
    return this.configs[name.toLowerCase()];
  }
}
