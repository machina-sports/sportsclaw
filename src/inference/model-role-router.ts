/**
 * sportsclaw — Model Role Router
 *
 * Routes `eyes/brain/hands/voice` invocations to a configured route
 * (`openshell`, `nim`, or `mock`) and returns typed `InferenceResult`s
 * with timing traces. This is the single stable call surface for TV/pod
 * workflows and operators — callers request a role, never a GPU, an
 * endpoint URL, or a model placement.
 *
 * Routes adapt to the existing harness plumbing:
 *   - `openshell` — AI SDK provider pointed at the OpenShell Privacy
 *     Router (OpenAI-compatible), same construction as the operator
 *     daemon's openshell block.
 *   - `nim` — AI SDK OpenAI-compatible provider pointed at a NIM
 *     endpoint (`baseUrl` in role config, else NIM_BASE_URL /
 *     OPENAI_BASE_URL env). Nemotron thinking-suppression kwargs are
 *     injected by `resolveModel`'s fetch wrapper.
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

import { generateText } from "ai";

import { defaultOpenShellBaseUrl, resolveModel } from "../llm-providers.js";
import type { ValidationResult } from "../schema/tv.js";
import { isModelRole, MODEL_ROLES, type ModelRole } from "./model-roles.js";
import {
  INFERENCE_ROUTES,
  type InferenceResult,
  type InferenceRoute,
  type InferenceTaskEnvelope,
  type InferenceTaskSource,
  type InferenceTrace,
} from "./inference-task.js";

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
   * Endpoint base URL for openshell/nim routes. Never put credentials
   * here — auth flows through env/credential stores, same as every
   * other harness route.
   */
  baseUrl?: string;
}

export interface ModelRoleRouterConfig {
  roles: Partial<Record<ModelRole, ModelRoleRouteConfig>>;
}

// ---------------------------------------------------------------------------
// validateModelRoleRouterConfig — runtime validation for the config block
// ---------------------------------------------------------------------------

export function validateModelRoleRouterConfig(config: unknown): ValidationResult {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { ok: false, error: "Inference config must be a non-null object." };
  }

  const c = config as Record<string, unknown>;

  if (!c.roles || typeof c.roles !== "object" || Array.isArray(c.roles)) {
    return { ok: false, error: "Inference config must have a roles object." };
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

    if (r.baseUrl !== undefined) {
      if (typeof r.baseUrl !== "string") {
        return { ok: false, error: `Role "${key}" baseUrl must be a string URL.` };
      }
      try {
        const url = new URL(r.baseUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return { ok: false, error: `Role "${key}" baseUrl must be http(s).` };
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
}

/** Serialize arbitrary role input into a prompt for chat-shaped routes. */
function toPrompt(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input);
}

/**
 * Run a role through the OpenAI-compatible chat-completions surface —
 * the shape both OpenShell and NIM serve today.
 */
async function runChatRoute(
  envelope: InferenceTaskEnvelope,
  baseUrl: string,
): Promise<string> {
  const model = resolveModel("openai", envelope.model, { baseUrl });
  const res = await generateText({ model, prompt: toPrompt(envelope.input) });
  return res.text;
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
        output = await runChatRoute(
          envelope,
          routeConfig.baseUrl ?? defaultOpenShellBaseUrl("openai"),
        );
        break;
      case "nim": {
        const baseUrl =
          routeConfig.baseUrl ??
          process.env.NIM_BASE_URL ??
          process.env.OPENAI_BASE_URL;
        if (!baseUrl) {
          return fail(
            "no NIM endpoint configured — set baseUrl in the role config or NIM_BASE_URL / OPENAI_BASE_URL in the environment.",
          );
        }
        output = await runChatRoute(envelope, baseUrl);
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
