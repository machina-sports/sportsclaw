/**
 * OpenShell 0.1.x native endpoint — config validation + runtime resolution.
 *
 * OpenShell 0.1 removed the managed `inference.local` route. A sandboxed
 * workload now calls the provider's native API, reads the credential
 * placeholder injected by the attached provider profile, and owns model id,
 * request shape and timeout. OpenShell's runtime (network policy, proxy,
 * credential substitution) owns enforcement — nothing here attests to it.
 *
 * Reads only the env object it is given (ignoring, for `process.env`, values
 * SportsClaw hydrated from saved config), never mutates it, and does nothing
 * at all when the openshell block is absent or disabled.
 */

import {
  DEFAULT_NATIVE_TIMEOUT_MS,
  type LLMProvider,
  type NativeApiMode,
  type NativeEndpoint,
  type OpenShellConfig,
} from "./types.js";
import { workloadEnvValue } from "./env-provenance.js";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NATIVE_API_MODES: readonly NativeApiMode[] = ["chat", "responses"];
const REMOVED_ROUTE_HOST = "inference.local";

/**
 * Validate a native base URL. Never echoes the input: a malformed or
 * credential-bearing URL must not leak through config errors.
 */
export function nativeBaseUrlProblem(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return `is required: set the provider's native API base URL (OpenShell 0.1 removed the managed ${REMOVED_ROUTE_HOST} route)`;
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "is not a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "must be http(s)";
  if (url.username || url.password) return "must not embed credentials";
  if (url.search || url.hash) return "must not include a query string or fragment";
  if (url.hostname.replace(/\.+$/, "").toLowerCase() === REMOVED_ROUTE_HOST) {
    return `must not use ${REMOVED_ROUTE_HOST} — OpenShell 0.1 removed the managed route; call the provider's native endpoint instead`;
  }
  return undefined;
}

/**
 * Field-level problems in an enabled OpenShell endpoint block
 * (`baseUrl`, `credentialEnv` | `credentialless`, `apiMode`, `timeoutMs`).
 * Shared by the operator-config and model-role validators and the resolver.
 */
export function openShellEndpointIssues(
  raw: Record<string, unknown>,
  provider?: unknown,
): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = [];
  const push = (field: string, message: string) => issues.push({ field, message });

  const baseUrlProblem = nativeBaseUrlProblem(raw.baseUrl);
  if (baseUrlProblem) push("baseUrl", baseUrlProblem);

  if (raw.credentialless !== undefined && typeof raw.credentialless !== "boolean") {
    push("credentialless", "must be a boolean");
  }
  const hasEnv = raw.credentialEnv !== undefined;
  if (hasEnv && (typeof raw.credentialEnv !== "string" || !ENV_NAME.test(raw.credentialEnv))) {
    push("credentialEnv", "must be the environment variable name declared by the attached provider profile (e.g. NVIDIA_API_KEY)");
  } else if (hasEnv && raw.credentialless === true) {
    push("credentialEnv", "set credentialEnv or credentialless: true, not both");
  } else if (!hasEnv && raw.credentialless !== true) {
    push(
      "credentialEnv",
      "is required: name the credential env var the attached provider profile injects, or set credentialless: true for an unauthenticated local endpoint",
    );
  }

  if (raw.apiMode !== undefined) {
    if (!NATIVE_API_MODES.includes(raw.apiMode as NativeApiMode)) {
      push("apiMode", `must be one of ${NATIVE_API_MODES.join(", ")}`);
    } else if (provider === "anthropic") {
      push("apiMode", "applies only to OpenAI-style providers; Anthropic uses its native Messages API");
    }
  }

  if (
    raw.timeoutMs !== undefined &&
    (typeof raw.timeoutMs !== "number" || !Number.isInteger(raw.timeoutMs) || raw.timeoutMs <= 0)
  ) {
    push("timeoutMs", "must be a positive integer (milliseconds)");
  }
  return issues;
}

/**
 * Turn an OpenShell config block into a per-job native endpoint, or
 * `undefined` when the block is absent/disabled.
 *
 * Fails closed before any inference when:
 *   - the provider is not anthropic/openai or the block is malformed;
 *   - `OPENSHELL_SANDBOX` is not `"1"` — the marker OpenShell injects into
 *     workload processes. An operational guard against running a
 *     sandbox-only job on a host, not attestation;
 *   - the profile-declared credential env var is empty. There is no fallback
 *     to provider keys or Claude Code OAuth, and values never appear in errors.
 */
export function resolveOpenShellEndpoint(
  provider: LLMProvider,
  openshell: OpenShellConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): NativeEndpoint | undefined {
  if (!openshell || openshell.enabled === false) return undefined;
  if (provider !== "anthropic" && provider !== "openai") {
    throw new Error(
      `OpenShell native mode supports provider "anthropic" or "openai" (got "${provider}"). ` +
        `For a custom OpenAI-compatible host use provider "openai" with openshell.baseUrl and an endpoint-bearing provider profile.`,
    );
  }
  const issues = openShellEndpointIssues(openshell as Record<string, unknown>, provider);
  if (issues.length > 0) {
    throw new Error(`Invalid openshell config: ${issues.map((i) => `openshell.${i.field} ${i.message}`).join("; ")}`);
  }
  // Values SportsClaw hydrated from ~/.sportsclaw/.env or config.json never
  // count: the marker and credential must come from the workload environment.
  if (workloadEnvValue("OPENSHELL_SANDBOX", env) !== "1") {
    throw new Error(
      "OpenShell mode requires running inside an OpenShell sandbox (OPENSHELL_SANDBOX=1 is not set). " +
        "Launch the job with `openshell sandbox create --provider <provider> ...`, or set openshell.enabled=false to run directly.",
    );
  }
  let apiKey: string;
  if (openshell.credentialless) {
    // Documented credentialless local-endpoint mode: clients need some non-empty key.
    apiKey = "unused";
  } else {
    const name = openshell.credentialEnv as string;
    apiKey = (workloadEnvValue(name, env) ?? "").trim();
    if (!apiKey) {
      throw new Error(
        `OpenShell credential env ${name} is not set by the sandbox (values saved in ~/.sportsclaw/.env or config.json are ignored). ` +
          "Attach the provider whose profile declares it (`openshell sandbox provider attach <sandbox> <provider> --wait`) and start a new process.",
      );
    }
  }
  return {
    baseUrl: (openshell.baseUrl as string).trim().replace(/\/+$/, ""),
    apiKey,
    apiMode: provider === "openai" ? (openshell.apiMode ?? "chat") : undefined,
    timeoutMs: openshell.timeoutMs ?? DEFAULT_NATIVE_TIMEOUT_MS,
    isolated: true,
  };
}
