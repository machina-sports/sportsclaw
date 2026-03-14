/**
 * sportsclaw — OS-Aware Credential Proxy
 *
 * A lightweight HTTP server that securely injects API keys from the host
 * into sandboxed Docker containers at runtime. Keys never touch the
 * container filesystem — they are served over an authenticated HTTP channel.
 *
 * Bind strategy:
 *   - macOS / WSL:  127.0.0.1 (loopback) — Docker Desktop routes host.docker.internal
 *   - Linux native: docker0 bridge IP (typically 172.17.0.1) so containers can reach the host
 *
 * Auth: A per-session bearer token is generated on startup and passed to the
 * container via the CRED_PROXY_TOKEN environment variable.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { platform as osPlatform } from "node:os";
import { resolveCredential, type CredentialProvider } from "./credentials.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HostEnvironment = "macos" | "wsl" | "linux";

export interface CredProxyConfig {
  /** Override the bind address (default: auto-detected from OS) */
  bindAddress?: string;
  /** Override the port (default: 0 = OS-assigned) */
  port?: number;
  /** Override the bearer token (default: random 32-byte hex) */
  token?: string;
  /** Allowed credential providers (default: all) */
  allowedProviders?: CredentialProvider[];
}

export interface CredProxyInfo {
  /** The address the proxy is listening on */
  host: string;
  /** The port the proxy is listening on */
  port: number;
  /** The bearer token for authenticating requests */
  token: string;
  /** The full base URL containers should use */
  url: string;
  /** The detected host environment */
  environment: HostEnvironment;
}

// ---------------------------------------------------------------------------
// OS / Environment Detection
// ---------------------------------------------------------------------------

/**
 * Detect whether we're running on macOS, WSL, or native Linux.
 */
export function detectHostEnvironment(): HostEnvironment {
  const p = osPlatform();

  if (p === "darwin") return "macos";

  if (p === "linux") {
    // WSL detection: /proc/version contains "microsoft" or "WSL"
    try {
      const procVersion = readFileSync("/proc/version", "utf-8");
      if (/microsoft|wsl/i.test(procVersion)) return "wsl";
    } catch {
      // Not available — assume native Linux
    }
    return "linux";
  }

  // Fallback for other platforms — treat as Linux for bind logic
  return "linux";
}

/**
 * Determine the correct bind address for the credential proxy based on the
 * host environment.
 *
 * - macOS/WSL: bind to 127.0.0.1 — Docker Desktop exposes host.docker.internal
 * - Linux native: bind to the docker0 bridge IP so containers on the default
 *   bridge network can reach the host
 */
export function resolveBindAddress(env: HostEnvironment): string {
  if (env === "macos" || env === "wsl") {
    return "127.0.0.1";
  }

  // Linux: try to read the docker0 bridge IP
  return getDockerBridgeIP() ?? "172.17.0.1";
}

/**
 * Read the docker0 bridge IP address from the system.
 * Falls back to 172.17.0.1 (Docker default) if detection fails.
 */
function getDockerBridgeIP(): string | null {
  try {
    const output = execFileSync(
      "ip",
      ["-4", "-o", "addr", "show", "docker0"],
      { timeout: 5_000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    // Output format: "3: docker0    inet 172.17.0.1/16 ..."
    const match = output.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Determine the hostname that containers should use to reach the proxy.
 *
 * - macOS/WSL: "host.docker.internal" (Docker Desktop built-in DNS)
 * - Linux: the docker0 bridge IP directly
 */
export function resolveContainerHost(env: HostEnvironment, bindAddress: string): string {
  if (env === "macos" || env === "wsl") {
    return "host.docker.internal";
  }
  return bindAddress;
}

// ---------------------------------------------------------------------------
// Proxy Server
// ---------------------------------------------------------------------------

const VALID_PROVIDERS: ReadonlySet<string> = new Set<string>([
  "anthropic", "openai", "gemini", "discord", "telegram",
]);

/**
 * Create and start the credential proxy server.
 * Returns connection info needed to configure the sandbox container.
 */
export async function startCredProxy(config?: CredProxyConfig): Promise<{
  info: CredProxyInfo;
  server: Server;
  stop: () => Promise<void>;
}> {
  const env = detectHostEnvironment();
  const bindAddress = config?.bindAddress ?? resolveBindAddress(env);
  const port = config?.port ?? 0;
  const token = config?.token ?? randomBytes(32).toString("hex");
  const allowedProviders = config?.allowedProviders
    ? new Set<string>(config.allowedProviders)
    : VALID_PROVIDERS;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handleRequest(req, res, token, allowedProviders);
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);

    server.listen(port, bindAddress, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get server address"));
        return;
      }

      const actualPort = addr.port;
      const containerHost = resolveContainerHost(env, bindAddress);
      const url = `http://${containerHost}:${actualPort}`;

      const info: CredProxyInfo = {
        host: bindAddress,
        port: actualPort,
        token,
        url,
        environment: env,
      };

      const stop = (): Promise<void> =>
        new Promise((resolveStop, rejectStop) => {
          server.close((err) => (err ? rejectStop(err) : resolveStop()));
        });

      resolve({ info, server, stop });
    });
  });
}

// ---------------------------------------------------------------------------
// Request Handler
// ---------------------------------------------------------------------------

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  allowedProviders: ReadonlySet<string>
): void {
  // CORS headers for container requests
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url ?? "/";

  // Health check (no auth required)
  if (url === "/health") {
    sendJSON(res, 200, { status: "ok" });
    return;
  }

  // All other routes require auth
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${token}`) {
    sendJSON(res, 401, { error: "unauthorized" });
    return;
  }

  // GET /credentials/:provider
  const credMatch = url.match(/^\/credentials\/([a-z]+)$/);
  if (req.method === "GET" && credMatch) {
    const provider = credMatch[1];

    if (!VALID_PROVIDERS.has(provider)) {
      sendJSON(res, 400, { error: `unknown provider: ${provider}` });
      return;
    }

    if (!allowedProviders.has(provider)) {
      sendJSON(res, 403, { error: `provider not allowed: ${provider}` });
      return;
    }

    const key = resolveCredential(provider as CredentialProvider);
    if (!key) {
      sendJSON(res, 404, { error: `no credential found for ${provider}` });
      return;
    }

    sendJSON(res, 200, { provider, key });
    return;
  }

  // GET /credentials — list which providers have keys (no values)
  if (req.method === "GET" && url === "/credentials") {
    const available: string[] = [];
    for (const p of allowedProviders) {
      if (resolveCredential(p as CredentialProvider)) {
        available.push(p);
      }
    }
    sendJSON(res, 200, { providers: available });
    return;
  }

  sendJSON(res, 404, { error: "not found" });
}

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Docker Environment Variables
// ---------------------------------------------------------------------------

/**
 * Build environment variables to pass to a Docker container so it can
 * reach the credential proxy.
 */
export function buildContainerEnv(info: CredProxyInfo): Record<string, string> {
  return {
    CRED_PROXY_URL: info.url,
    CRED_PROXY_TOKEN: info.token,
  };
}

/**
 * Build `docker run` flags for proxy access.
 * On macOS/WSL this is a no-op (host.docker.internal is automatic).
 * On Linux, adds `--add-host=host.docker.internal:host-gateway` for parity.
 */
export function buildDockerNetworkFlags(env: HostEnvironment): string[] {
  if (env === "linux") {
    return ["--add-host=host.docker.internal:host-gateway"];
  }
  return [];
}
