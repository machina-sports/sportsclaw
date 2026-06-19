/**
 * sportsclaw Engine — Python Subprocess Bridge Subsystem
 *
 * Implements the core child process spawning, arguments serializations,
 * error classifications, retries, and circuit breaking boundaries.
 *
 * This is isolated from the ToolRegistry to prevent circular dependencies.
 */

import { execFile } from "node:child_process";
import type { PythonBridgeResult, sportsclawConfig } from "./types.js";
import { isVenvSetup, getVenvDir } from "./python.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { ConnectionManager } from "./connections.js";

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

export interface ToolCallInput {
  [key: string]: any;
}

export interface ToolCallResult {
  content: string;
  isError?: boolean;
}

export type BridgeErrorCode =
  | "timeout"
  | "dependency_missing"
  | "network_dns"
  | "rate_limited"
  | "python_version_incompatible"
  | "circuit_open"
  | "tool_execution_failed";

export interface RetryPlan {
  retry: boolean;
  delayMs: number;
}

// ---------------------------------------------------------------------------
// Error Classification & Retry Policy
// ---------------------------------------------------------------------------

export function classifyBridgeError(
  error?: string,
  stderr?: string
): { errorCode: BridgeErrorCode; hint: string } {
  const haystack = `${error ?? ""}\n${stderr ?? ""}`.toLowerCase();

  if (haystack.includes("timed out") || haystack.includes("command timed out")) {
    return {
      errorCode: "timeout",
      hint:
        "The data provider timed out. Retry the same query; if it persists, increase timeout in config.",
    };
  }
  if (
    haystack.includes("modulenotfounderror") ||
    haystack.includes("importerror") ||
    haystack.includes("optional dependency") ||
    haystack.includes("dependency_missing") ||
    haystack.includes("requires extra dependencies")
  ) {
    return {
      errorCode: "dependency_missing",
      hint: "A required dependency is missing in the selected Python environment.",
    };
  }
  if (
    haystack.includes("enotfound") ||
    haystack.includes("name resolution") ||
    haystack.includes("nodename nor servname") ||
    haystack.includes("getaddrinfo")
  ) {
    return {
      errorCode: "network_dns",
      hint: "Network/DNS lookup failed while reaching a data source. Verify internet/DNS and retry.",
    };
  }
  if (
    haystack.includes("429") ||
    haystack.includes("rate limit") ||
    haystack.includes("too many requests")
  ) {
    return {
      errorCode: "rate_limited",
      hint: "The provider rate-limited requests. Wait briefly and retry.",
    };
  }
  if (
    haystack.includes("unsupported operand type(s) for |") ||
    (haystack.includes("typeerror") && haystack.includes("type |")) ||
    (haystack.includes("syntaxerror") && haystack.includes("x | y"))
  ) {
    return {
      errorCode: "python_version_incompatible",
      hint:
        "Python 3.10+ is required. The current interpreter is too old for sports-skills. " +
        "Upgrade Python or run: sportsclaw config",
    };
  }

  if (haystack.includes("circuit breaker open")) {
    return {
      errorCode: "circuit_open",
      hint:
        "This data source is cooling down after repeated failures. " +
        "Try a different question or retry in about a minute.",
    };
  }

  return {
    errorCode: "tool_execution_failed",
    hint: "The command executed but returned a failure exit code or standard error log.",
  };
}

export function resolveRetryPlan(
  errorCode: BridgeErrorCode,
  attempt: number
): RetryPlan {
  const jitter = () => Math.floor(Math.random() * 250);
  switch (errorCode) {
    case "dependency_missing":
    case "python_version_incompatible":
    case "circuit_open":
      return { retry: false, delayMs: 0 };
    case "rate_limited":
      return attempt < 2
        ? { retry: true, delayMs: 1500 * 2 ** attempt + jitter() }
        : { retry: false, delayMs: 0 };
    case "network_dns":
      return attempt < 2
        ? { retry: true, delayMs: 500 * 2 ** attempt + jitter() }
        : { retry: false, delayMs: 0 };
    case "timeout":
      // One retry; executePythonBridge widens the timeout window instead of sleeping.
      return attempt < 1
        ? { retry: true, delayMs: 0 }
        : { retry: false, delayMs: 0 };
    default:
      return attempt < 1
        ? { retry: true, delayMs: 250 + jitter() }
        : { retry: false, delayMs: 0 };
  }
}

// ---------------------------------------------------------------------------
// Identifiers Validation
// ---------------------------------------------------------------------------

const SAFE_IDENTIFIER = /^[a-zA-Z0-9_-]+$/;

export function validateIdentifier(value: string, label: string): string | null {
  if (!SAFE_IDENTIFIER.test(value)) {
    return `Invalid ${label}: must contain only alphanumeric characters, underscores, and hyphens`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Environment Sandbox Assembly
// ---------------------------------------------------------------------------

export function buildSubprocessEnv(
  extra?: Record<string, string>,
  connectionName?: string
): Record<string, string> {
  const manager = new ConnectionManager();
  const env = manager.getSandboxEnv(connectionName, extra);

  // Activate the managed venv for all subprocess calls
  if (isVenvSetup()) {
    const venvDir = getVenvDir();
    env.VIRTUAL_ENV = venvDir;
    const venvBin = venvDir + "/bin";
    env.PATH = env.PATH ? `${venvBin}:${env.PATH}` : venvBin;
  }

  return env;
}

// ---------------------------------------------------------------------------
// CLI Arguments builder
// ---------------------------------------------------------------------------

export function buildArgs(
  sport: string,
  command: string,
  args?: Record<string, unknown>
): string[] {
  const cliArgs = ["-m", "sports_skills", sport, command];

  if (args) {
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined || value === null) continue;
      const keyError = validateIdentifier(key, "argument key");
      if (keyError) continue;
      
      if (typeof value === "boolean") {
        if (value) cliArgs.push(`--${key}`);
      } else {
        const strValue =
          typeof value === "object" ? JSON.stringify(value) : String(value);
        cliArgs.push(`--${key}=${strValue}`);
      }
    }
  }

  return cliArgs;
}

// ---------------------------------------------------------------------------
// Circuit Breaker and Execution Bridge
// ---------------------------------------------------------------------------

export const bridgeBreaker = new CircuitBreaker();

export function executePythonBridge(
  sport: string,
  command: string,
  args?: Record<string, unknown>,
  config?: Partial<sportsclawConfig>,
  connectionName?: string
): Promise<PythonBridgeResult> {
  const pythonPath = config?.pythonPath ?? "python3";
  const cliArgs = buildArgs(sport, command, args);
  const timeout = config?.timeout ?? 60_000;
  const retryTimeout = Math.max(timeout * 2, 90_000);

  if (config?.verbose) {
    console.error(`[sportsclaw] exec: ${pythonPath} ${cliArgs.join(" ")}`);
  }

  const runOnce = (attemptTimeout: number) =>
    new Promise<(PythonBridgeResult & { timedOut?: boolean })>((resolve) => {
      execFile(
        pythonPath,
        cliArgs,
        {
          encoding: "utf-8",
          timeout: attemptTimeout,
          maxBuffer: 25 * 1024 * 1024, // 25 MB for verbose FastF1 stderr on degraded networks
          env: buildSubprocessEnv(config?.env, connectionName),
        },
        (error, stdout, stderr) => {
          if (error) {
            const execErr = error as Error & {
              signal?: NodeJS.Signals | null;
              code?: string | number | null;
            };
            const timedOut =
              /timed out/i.test(error.message) ||
              (execErr.signal === "SIGTERM" && execErr.code === null);
            resolve({
              success: false,
              error: error.message,
              stdout: stdout || undefined,
              stderr: stderr || undefined,
              timedOut,
            });
            return;
          }

          const trimmed = (stdout ?? "").trim();
          if (!trimmed) {
            resolve({
              success: true,
              data: null,
              stdout: "",
            });
            return;
          }

          try {
            const data = JSON.parse(trimmed);
            resolve({ success: true, data });
          } catch {
            // Not JSON — return raw stdout
            resolve({ success: true, data: trimmed, stdout: trimmed });
          }
        }
      );
    });

  return (async () => {
    if (!bridgeBreaker.canProceed(sport)) {
      return {
        success: false,
        error:
          `circuit breaker open for "${sport}": repeated failures reaching the data source. ` +
          `Cooling down before new attempts.`,
      };
    }

    let attempt = 0;
    let lastResult = await runOnce(timeout);
    while (!lastResult.success) {
      const { errorCode } = classifyBridgeError(lastResult.error, lastResult.stderr);
      const plan = resolveRetryPlan(errorCode, attempt);
      if (!plan.retry) break;
      if (plan.delayMs > 0) {
        await new Promise((r) => setTimeout(r, plan.delayMs));
      }
      attempt++;
      // Timeouts get a widened window on retry; other errors keep the original.
      const nextTimeout = errorCode === "timeout" ? retryTimeout : timeout;
      if (config?.verbose) {
        console.error(
          `[sportsclaw] bridge retry attempt=${attempt} code=${errorCode} timeout=${nextTimeout}ms`
        );
      }
      lastResult = await runOnce(nextTimeout);
    }

    if (lastResult.success) {
      bridgeBreaker.recordSuccess(sport);
    } else {
      bridgeBreaker.recordFailure(sport);
    }
    return lastResult;
  })();
}
