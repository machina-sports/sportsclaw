/**
 * stdin → stdout watch-intent worker for POST /api/watch-intent.
 *
 * One process, one bounded interpretation: read a `watch-intent-v1` body on
 * stdin, run the fixed-purpose interpreter through unified inference, write
 * exactly one typed envelope on stdout. No engine, CLI, MCP, tools, memory,
 * history or listener is imported.
 *
 * Off unless SPORTSCLAW_WATCH_INTENT_ENABLED is exactly "true". Provider and
 * model come from server configuration only: SPORTSCLAW_WATCH_INTENT_NATIVE_CONFIG
 * (NIM / OpenShell route, fail-closed) or else SPORTSCLAW_PROVIDER /
 * SPORTSCLAW_MODEL via the existing provider resolver. The request can carry
 * none of them. Nothing is ever written to stderr.
 */

import { pathToFileURL } from "node:url";

import { resolveNativeRouteModel } from "./inference/model-role-router.js";
import { resolveAuthForModel, resolveModel } from "./llm-providers.js";
import { DEFAULT_MODELS, type LLMProvider } from "./types.js";
import {
  interpretWatchIntent,
  parseWatchIntentRequest,
  watchIntentFailure,
  type InterpretWatchIntentOptions,
  type WatchIntentResult,
} from "./watch-intent.js";

export const WATCH_INTENT_ENABLED_ENV = "SPORTSCLAW_WATCH_INTENT_ENABLED";
export const MAX_WATCH_INTENT_BODY_BYTES = 32 * 1024;
/** Fixed model deadline; below the relay's process backstop. */
export const WATCH_INTENT_TIMEOUT_MS = 8_000;

type Env = Record<string, string | undefined>;
type Model = InterpretWatchIntentOptions["model"];

/**
 * Server-owned native route for interpretation: the existing
 * `ModelRoleRouteConfig` JSON shape, route `nim` or `openshell`, model required.
 */
export const WATCH_INTENT_NATIVE_CONFIG_ENV = "SPORTSCLAW_WATCH_INTENT_NATIVE_CONFIG";

const PROVIDERS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_MODELS));

function resolveServerModel(env: Env): { model: Model; route?: "nim" | "openshell" } {
  const native = env[WATCH_INTENT_NATIVE_CONFIG_ENV];
  if (native !== undefined && native !== "") {
    // Set means native-only: invalid JSON, config, sandbox or credential all
    // throw here, and nothing below (the direct/cloud client) is reached.
    const { model, route } = resolveNativeRouteModel(JSON.parse(native), env);
    return { model: model as Model, route };
  }
  const provider = (env.SPORTSCLAW_PROVIDER || "anthropic") as LLMProvider;
  if (!PROVIDERS.has(provider)) throw new Error("unsupported provider");
  const modelId = env.SPORTSCLAW_MODEL || DEFAULT_MODELS[provider];
  if (!modelId) throw new Error("no model configured");
  return { model: resolveModel(provider, modelId, undefined, resolveAuthForModel()) as Model };
}

/**
 * Server-owned model selection from the given environment object only
 * (`runWatchIntent` passes `process.env` unless a test injects one).
 * SPORTSCLAW_WATCH_INTENT_NATIVE_CONFIG, when set, selects a NIM/OpenShell
 * route and fails closed; unset keeps SPORTSCLAW_PROVIDER / SPORTSCLAW_MODEL.
 */
export function createServerModel(env: Env): Model {
  return resolveServerModel(env).model;
}

export interface WatchIntentWorkerOptions {
  /** Environment source. Defaults to `process.env`. Never mutated. */
  env?: Env;
  /** Injected for offline tests; production uses `createServerModel`. */
  createModel?: (env: Env) => Model;
  abortSignal?: AbortSignal;
}

/** Run one interpretation over an already-read body. Never throws. */
export async function runWatchIntent(
  body: string,
  options: WatchIntentWorkerOptions = {},
): Promise<WatchIntentResult> {
  const env = options.env ?? process.env;
  if (env[WATCH_INTENT_ENABLED_ENV] !== "true") return watchIntentFailure("disabled");
  if (options.abortSignal?.aborted) return watchIntentFailure("aborted");
  if (typeof body !== "string" || !body || Buffer.byteLength(body, "utf8") > MAX_WATCH_INTENT_BODY_BYTES) {
    return watchIntentFailure("invalid_request");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return watchIntentFailure("invalid_request");
  }
  // Validate before any model is built, so a refused request costs nothing.
  if (!parseWatchIntentRequest(parsed)) return watchIntentFailure("invalid_request");

  let model: Model;
  let route: "nim" | "openshell" | undefined;
  try {
    if (options.createModel) model = options.createModel(env);
    else ({ model, route } = resolveServerModel(env));
  } catch {
    return watchIntentFailure("inference_unavailable");
  }
  return interpretWatchIntent(parsed, {
    model,
    route,
    abortSignal: options.abortSignal,
    timeoutMs: WATCH_INTENT_TIMEOUT_MS,
  });
}

async function readStdin(): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > MAX_WATCH_INTENT_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  (globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;
  let result: WatchIntentResult;
  try {
    // Always drain stdin so the parent's write never hits a closed pipe.
    const body = await readStdin();
    if (process.env[WATCH_INTENT_ENABLED_ENV] !== "true") result = watchIntentFailure("disabled");
    else result = body === undefined ? watchIntentFailure("invalid_request") : await runWatchIntent(body);
  } catch {
    result = watchIntentFailure("inference_unavailable");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// Importing this module for tests must not consume stdin or emit a result.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
