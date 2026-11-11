/**
 * sportsclaw — Model Role Router
 *
 * Routes `eyes/brain/hands/writer` invocations to a configured route
 * (`openshell`, `nim`, or `mock`) and returns typed `InferenceResult`s
 * with timing traces. This is the single stable call surface for TV/pod
 * workflows and operators — callers request a role, never a GPU, an
 * endpoint URL, or a model placement.
 *
 * Routes adapt to the existing harness plumbing:
 *   - `openshell` — OpenShell 0.1.x native endpoint, resolved exactly like
 *     the operator daemon's openshell block (`resolveOpenShellEndpoint`):
 *     explicit `baseUrl`, profile-declared `credentialEnv` (or
 *     `credentialless`), and it refuses to run outside an OpenShell sandbox.
 *   - `nim` — OpenAI-compatible native client pointed at a NIM endpoint
 *     (`baseUrl` in role config, else NIM_BASE_URL / OPENAI_BASE_URL env).
 *     No OpenShell requirement. Nemotron thinking-suppression kwargs are
 *     injected by `resolveModel`'s fetch wrapper. Keyless: for a model server
 *     you run yourself.
 *   - `api` — the same client pointed at a hosted OpenAI-compatible service
 *     that needs a key. The config names the environment variable holding the
 *     key (`credentialEnv`); the key is never in config. HTTPS is required
 *     unless the endpoint is on loopback.
 *   - `mock` — deterministic in-process echo, no network. Used by unit
 *     tests and the moment-to-air benchmark in CI.
 *
 * Extension seam: both real routes go through the OpenAI-compatible
 * chat-completions surface (`runChatRoute`). Media-generation endpoints
 * that are not chat-shaped (e.g. a dedicated Cosmos I2V API for the
 * `hands` role) plug in by branching on the role's route config inside
 * `invokeModelRole` — the envelope/trace contracts stay unchanged.
 */

import { randomUUID } from "node:crypto";

import { resolveModel } from "../llm-providers.js";
import { openShellEndpointIssues, resolveOpenShellEndpoint } from "../openshell-native.js";
import { registerMedia, releaseMedia, validateMedia } from "../media-input.js";
import type { MediaAttachment, NativeApiMode, NativeEndpoint } from "../types.js";
import type { ValidationResult } from "../schema/tv.js";
import { isModelRole, MODEL_ROLES, type ModelRole } from "./model-roles.js";
import { judgeConfigIssue, type JudgeConfig } from "./judge.js";
import { speechConfigIssue, type SpeechRouteConfig } from "./speech.js";
import { ENV_NAME, LOOPBACK_HOSTS, USABLE_KEY } from "./endpoint-rules.js";
import {
  INFERENCE_ROUTES,
  type InferenceResult,
  type InferenceRoute,
  type InferenceTaskEnvelope,
  type InferenceTaskSource,
  type InferenceTrace,
} from "./inference-task.js";
import { generate } from "./run.js";
import type { InferenceContext, InferenceReceipt } from "./receipt.js";

// ---------------------------------------------------------------------------
// Route config — where each role runs. Hardware is metadata, not contract.
// ---------------------------------------------------------------------------

export const ROLE_LOCALITIES = [
  "pod",
  "local",
  "h200",
  "hosted",
  "brev",
  "unknown",
] as const;

export type RoleLocality = (typeof ROLE_LOCALITIES)[number];

export const ROLE_ACCELERATORS = ["h200", "h100", "l40s", "cpu", "unknown"] as const;

export type RoleAccelerator = (typeof ROLE_ACCELERATORS)[number];

export interface ModelRoleRouteConfig {
  /** How the role is reached. */
  route: InferenceRoute;
  /** Model id served on that route, e.g. "nvidia/cosmos3-nano-reasoner". */
  model: string;
  /** Where it runs — runtime metadata only, never a contract name. */
  locality?: RoleLocality;
  /** Optional hardware trace metadata. */
  accelerator?: RoleAccelerator;
  /**
   * Endpoint base URL for openshell/nim routes (required for openshell).
   * Never put credentials here.
   */
  baseUrl?: string;
  /**
   * The NAME of the environment variable that holds the credential, never the credential.
   * openshell: the variable the attached provider profile injects. api: required; the
   * service's key is read from it at call time.
   */
  credentialEnv?: string;
  /** openshell only: explicit unauthenticated local endpoint. */
  credentialless?: boolean;
  /** Request shape for openshell/nim/api routes. Default `"chat"`. */
  apiMode?: NativeApiMode;
  /** Per-request timeout for openshell/nim/api routes. */
  timeoutMs?: number;
  /**
   * nim and api only: extra fields added to each chat request body, for server options the
   * model needs (vLLM: `top_k`, `chat_template_kwargs`, `mm_processor_kwargs`).
   * It may not set the request itself (model, messages, stream, tools).
   */
  requestBody?: Record<string, unknown>;
}

export interface ModelRoleRouterConfig {
  roles: Partial<Record<ModelRole, ModelRoleRouteConfig>>;
  /** The decision provider for typed questions. Not a role: see `judge.ts`. */
  judge?: JudgeConfig;
  /** Where text is spoken. Not a role: the `writer` role writes, this speaks. See `speech.ts`. */
  speech?: SpeechRouteConfig;
}

// ---------------------------------------------------------------------------
// validateModelRoleRouterConfig — runtime validation for the config block
// ---------------------------------------------------------------------------

/** Request fields a role's `requestBody` may not set: they are the call, not options for the server. */
const REQUEST_BODY_RESERVED: ReadonlySet<string> = new Set(["model", "messages", "stream", "tools", "tool_choice"]);

export function validateModelRoleRouterConfig(config: unknown): ValidationResult {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { ok: false, error: "Inference config must be a non-null object." };
  }

  const c = config as Record<string, unknown>;

  if (!c.roles || typeof c.roles !== "object" || Array.isArray(c.roles)) {
    return { ok: false, error: "Inference config must have a roles object." };
  }

  if (c.judge !== undefined) {
    const issue = judgeConfigIssue(c.judge);
    if (issue) return { ok: false, error: issue };
  }

  if (c.speech !== undefined) {
    const issue = speechConfigIssue(c.speech);
    if (issue) return { ok: false, error: issue };
  }

  for (const [key, value] of Object.entries(c.roles as Record<string, unknown>)) {
    if (!isModelRole(key)) {
      return {
        ok: false,
        error: `Unknown role "${key}" — roles must be one of ${MODEL_ROLES.join(", ")}.`,
      };
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: `Role "${key}" config must be a non-null object.` };
    }

    const r = value as Record<string, unknown>;

    if (!(INFERENCE_ROUTES as readonly string[]).includes(r.route as string)) {
      return {
        ok: false,
        error: `Role "${key}" route must be one of ${INFERENCE_ROUTES.join(", ")}.`,
      };
    }

    if (r.requestBody !== undefined) {
      if (!r.requestBody || typeof r.requestBody !== "object" || Array.isArray(r.requestBody)) {
        return { ok: false, error: `Role "${key}" requestBody must be an object of extra request fields.` };
      }
      if (r.route !== "nim" && r.route !== "api") {
        return { ok: false, error: `Role "${key}" requestBody is sent on nim and api routes only.` };
      }
      const reserved = Object.keys(r.requestBody).filter((field) => REQUEST_BODY_RESERVED.has(field));
      if (reserved.length > 0) {
        return { ok: false, error: `Role "${key}" requestBody may not set ${reserved.join(", ")}: those are the request itself.` };
      }
    }

    if (typeof r.model !== "string" || r.model === "") {
      return { ok: false, error: `Role "${key}" must have a non-empty model.` };
    }

    if (
      r.locality !== undefined &&
      !(ROLE_LOCALITIES as readonly string[]).includes(r.locality as string)
    ) {
      return {
        ok: false,
        error: `Role "${key}" locality must be one of ${ROLE_LOCALITIES.join(", ")}.`,
      };
    }

    if (
      r.accelerator !== undefined &&
      !(ROLE_ACCELERATORS as readonly string[]).includes(r.accelerator as string)
    ) {
      return {
        ok: false,
        error: `Role "${key}" accelerator must be one of ${ROLE_ACCELERATORS.join(", ")}.`,
      };
    }

    if (r.route === "openshell") {
      const [issue] = openShellEndpointIssues(r, "openai");
      if (issue) return { ok: false, error: `Role "${key}" ${issue.field} ${issue.message}.` };
      continue;
    }

    if (r.credentialless !== undefined) {
      return { ok: false, error: `Role "${key}" credentialless applies only to route "openshell".` };
    }
    if (r.route === "api") {
      if (typeof r.credentialEnv !== "string" || !ENV_NAME.test(r.credentialEnv)) {
        return {
          ok: false,
          error: `Role "${key}" credentialEnv must be the name of an environment variable that holds the key (for example NVIDIA_API_KEY), never the key itself.`,
        };
      }
      if (typeof r.baseUrl !== "string" || r.baseUrl === "") {
        return { ok: false, error: `Role "${key}" route "api" needs a baseUrl.` };
      }
    } else if (r.credentialEnv !== undefined) {
      return { ok: false, error: `Role "${key}" credentialEnv applies only to routes "openshell" and "api".` };
    }
    if (r.apiMode !== undefined && r.apiMode !== "chat" && r.apiMode !== "responses") {
      return { ok: false, error: `Role "${key}" apiMode must be one of chat, responses.` };
    }
    if (
      r.timeoutMs !== undefined &&
      (typeof r.timeoutMs !== "number" || !Number.isInteger(r.timeoutMs) || r.timeoutMs <= 0)
    ) {
      return { ok: false, error: `Role "${key}" timeoutMs must be a positive integer.` };
    }

    if (r.baseUrl !== undefined) {
      if (typeof r.baseUrl !== "string") {
        return { ok: false, error: `Role "${key}" baseUrl must be a string URL.` };
      }
      try {
        const url = new URL(r.baseUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return { ok: false, error: `Role "${key}" baseUrl must be http(s).` };
        }
        // A key travels with every request on this route: plain HTTP only to this machine.
        if (r.route === "api" && url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
          return { ok: false, error: `Role "${key}" route "api" baseUrl must be https, except on loopback.` };
        }
      } catch {
        return { ok: false, error: `Role "${key}" baseUrl is not a valid URL.` };
      }
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// InferenceRouteError — route failures always name role + model + trace
// ---------------------------------------------------------------------------

export class InferenceRouteError extends Error {
  readonly role: ModelRole;
  readonly model: string;
  readonly trace: InferenceTrace;

  constructor(message: string, trace: InferenceTrace) {
    super(message);
    this.name = "InferenceRouteError";
    this.role = trace.role;
    this.model = trace.model;
    this.trace = trace;
  }
}

// ---------------------------------------------------------------------------
// invokeModelRole — the one stable call surface
// ---------------------------------------------------------------------------

export interface InvokeModelRoleArgs<TInput = unknown> {
  role: ModelRole;
  input: TInput;
  source: InferenceTaskSource;
  config: ModelRoleRouterConfig;
  /** Caller-supplied task id; defaults to a fresh UUID. */
  taskId?: string;
  /** Free-form metadata attached to the task envelope. */
  meta?: Record<string, unknown>;
  /** Cancels the in-flight native request (not only the caller's wait). */
  abortSignal?: AbortSignal;
  /** Per-call sanitized receipt observer (no endpoint, prompt or output). */
  onReceipt?: (receipt: InferenceReceipt) => void;
  /**
   * Video and audio for a chat-shaped openshell/nim route (same rules as RunOptions.media).
   * They are sent as one user message: the media parts in the order given, then the
   * input as text. The mock route ignores them.
   */
  media?: MediaAttachment[];
  /** Output limit and sampling for this call. Unset fields are left to the server's defaults. */
  sampling?: { maxOutputTokens?: number; temperature?: number; topP?: number };
}

/**
 * Resolve the native endpoint for an already-validated `openshell` / `nim`
 * route. The single place the role security rules live:
 *   - openshell: `resolveOpenShellEndpoint` (OPENSHELL_SANDBOX=1, profile
 *     credential from the workload env only, isolated transport);
 *   - nim: explicit `baseUrl`, else NIM_BASE_URL / OPENAI_BASE_URL from `env`.
 * Throws (never falls back to a cloud client) when a route cannot be resolved.
 * `env` is explicit; it defaults to `process.env`.
 */
export function resolveNativeRoleEndpoint(
  routeConfig: ModelRoleRouteConfig,
  env: NodeJS.ProcessEnv = process.env,
): NativeEndpoint {
  if (routeConfig.route === "openshell") {
    return resolveOpenShellEndpoint(
      "openai",
      {
        baseUrl: routeConfig.baseUrl,
        credentialEnv: routeConfig.credentialEnv,
        credentialless: routeConfig.credentialless,
        apiMode: routeConfig.apiMode,
        timeoutMs: routeConfig.timeoutMs,
      },
      env,
    ) as NativeEndpoint;
  }
  if (routeConfig.route === "nim") {
    const baseUrl = routeConfig.baseUrl ?? env.NIM_BASE_URL ?? env.OPENAI_BASE_URL;
    if (!baseUrl) {
      throw new Error(
        "no NIM endpoint configured — set baseUrl in the role config or NIM_BASE_URL / OPENAI_BASE_URL in the environment.",
      );
    }
    // NIM endpoints are keyless here; the client just needs a non-empty key.
    return {
      baseUrl, apiKey: "unused", apiMode: routeConfig.apiMode, timeoutMs: routeConfig.timeoutMs,
      ...(routeConfig.requestBody ? { requestBody: routeConfig.requestBody } : {}),
    };
  }
  if (routeConfig.route === "api") {
    // The key is read here, at call time, from the variable the config names. No fallback to any other key.
    const name = routeConfig.credentialEnv as string;
    const key = env[name];
    if (!key) throw new Error(`${name} is not set — export the key for this route's service; there is no fallback.`);
    if (!USABLE_KEY.test(key)) throw new Error(`${name} does not hold a usable key (printable characters, no spaces).`);
    return {
      baseUrl: routeConfig.baseUrl as string, apiKey: key, apiMode: routeConfig.apiMode, timeoutMs: routeConfig.timeoutMs,
      ...(routeConfig.requestBody ? { requestBody: routeConfig.requestBody } : {}),
    };
  }
  throw new Error(`route "${routeConfig.route}" has no native endpoint`);
}

const NATIVE_ROUTE_KEYS: ReadonlySet<string> = new Set([
  "route", "model", "locality", "accelerator", "baseUrl", "credentialEnv", "credentialless", "apiMode", "timeoutMs",
  "requestBody",
]);

/**
 * Build a model for a server-owned native route config (`nim` / `openshell`
 * only, `model` required, existing route validation + resolver). Throws on
 * anything invalid or unresolvable — callers must not fall back to a cloud
 * client. Returns the route label for receipts.
 */
export function resolveNativeRouteModel(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): { model: ReturnType<typeof resolveModel>; route: "nim" | "openshell" } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("native route config must be an object");
  const config = raw as Record<string, unknown>;
  if (Object.keys(config).some((key) => !NATIVE_ROUTE_KEYS.has(key))) {
    throw new Error("native route config has unsupported keys");
  }
  if (config.route !== "nim" && config.route !== "openshell") {
    throw new Error("native route must be nim or openshell");
  }
  const check = validateModelRoleRouterConfig({ roles: { brain: config } });
  if (!check.ok) throw new Error(`invalid native route config: ${check.error}`);
  const routeConfig = config as unknown as ModelRoleRouteConfig;
  const endpoint = resolveNativeRoleEndpoint(routeConfig, env);
  return {
    model: resolveModel("openai", routeConfig.model, endpoint),
    route: routeConfig.route as "nim" | "openshell",
  };
}

/** Serialize arbitrary role input into a prompt for chat-shaped routes. */
function toPrompt(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input);
}

/**
 * Run a role through an OpenAI-compatible native endpoint (chat completions
 * by default, Responses when `apiMode: "responses"`).
 */
async function runChatRoute(
  envelope: InferenceTaskEnvelope,
  endpoint: NativeEndpoint,
  ctx: InferenceContext,
  abortSignal?: AbortSignal,
  media?: MediaAttachment[],
  sampling?: InvokeModelRoleArgs["sampling"],
): Promise<string> {
  const model = resolveModel("openai", envelope.model, endpoint);
  const limits = {
    ...(sampling?.maxOutputTokens !== undefined ? { maxOutputTokens: sampling.maxOutputTokens } : {}),
    ...(sampling?.temperature !== undefined ? { temperature: sampling.temperature } : {}),
    ...(sampling?.topP !== undefined ? { topP: sampling.topP } : {}),
  };
  if (!media || media.length === 0) {
    const res = await generate(ctx, { model, prompt: toPrompt(envelope.input), ...limits, abortSignal });
    return res.text;
  }
  if (endpoint.apiMode === "responses") throw new Error("media needs a chat-shaped route (apiMode chat)");
  // Each attachment travels as a marker text part; the endpoint's fetch swaps it for the real media part.
  const markers = media.map(registerMedia);
  try {
    const res = await generate(ctx, {
      model,
      messages: [{
        role: "user",
        content: [...markers.map((text) => ({ type: "text" as const, text })), { type: "text" as const, text: toPrompt(envelope.input) }],
      }],
      ...limits,
      abortSignal,
    });
    return res.text;
  } finally {
    releaseMedia(markers);
  }
}

export async function invokeModelRole<TInput = unknown, TOutput = unknown>(
  args: InvokeModelRoleArgs<TInput>,
): Promise<InferenceResult<TOutput>> {
  const { role, input, source, config } = args;

  if (!isModelRole(role)) {
    throw new Error(
      `Unknown model role ${JSON.stringify(role)} — must be one of ${MODEL_ROLES.join(", ")}.`,
    );
  }

  const routeConfig = config?.roles?.[role];
  if (!routeConfig) {
    throw new Error(
      `No route configured for role "${role}" — add inference.roles.${role} to the router config.`,
    );
  }

  const configCheck = validateModelRoleRouterConfig({ roles: { [role]: routeConfig } });
  if (!configCheck.ok) {
    throw new Error(`Invalid route config for role "${role}": ${configCheck.error}`);
  }

  const envelope: InferenceTaskEnvelope<TInput> = {
    taskId: args.taskId ?? randomUUID(),
    role,
    model: routeConfig.model,
    input,
    requestedAt: new Date().toISOString(),
    source,
    meta: args.meta,
  };

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  const buildTrace = (
    status: InferenceTrace["status"],
    error?: string,
  ): InferenceTrace => {
    const endedAtMs = Date.now();
    return {
      taskId: envelope.taskId,
      role,
      model: routeConfig.model,
      startedAt,
      endedAt: new Date(endedAtMs).toISOString(),
      latencyMs: endedAtMs - startedAtMs,
      route: routeConfig.route,
      status,
      ...(error !== undefined ? { error } : {}),
    };
  };

  const fail = (message: string): never => {
    throw new InferenceRouteError(
      `Role "${role}" (model "${routeConfig.model}", route "${routeConfig.route}") failed: ${message}`,
      buildTrace("failed", message),
    );
  };

  let output: unknown;
  try {
    switch (routeConfig.route) {
      case "mock":
        output = { mock: true, role, model: routeConfig.model, echo: input };
        break;
      case "openshell":
      case "nim":
      case "api": {
        // Guard + credential lookup happen here, before any request.
        const endpoint = resolveNativeRoleEndpoint(routeConfig);
        const media = args.media !== undefined ? validateMedia(args.media) : undefined;
        output = await runChatRoute(
          envelope,
          endpoint,
          { purpose: "model_role", route: routeConfig.route, onReceipt: args.onReceipt },
          args.abortSignal,
          media,
          args.sampling,
        );
        break;
      }
    }
  } catch (err) {
    if (err instanceof InferenceRouteError) throw err;
    return fail(err instanceof Error ? err.message : String(err));
  }

  return {
    taskId: envelope.taskId,
    role,
    output: output as TOutput,
    trace: buildTrace("completed"),
  };
}
