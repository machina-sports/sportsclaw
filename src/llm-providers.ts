/**
 * LLM provider resolution — centralized.
 *
 * One place that knows how to map a `(provider, modelId)` pair into a
 * Vercel AI SDK LanguageModel. Previously this switch was duplicated
 * verbatim in engine.ts, operate.ts, and setup.ts. Consolidating here
 * means a future swap of provider package or base-URL handling lives
 * in exactly one file.
 *
 * Two construction paths:
 *   - Default: the provider's default singleton (`anthropic` / `openai` /
 *     `google`), which reads its standard base-URL env var
 *     (`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` /
 *     `GOOGLE_GENERATIVE_AI_BASE_URL`) at construction time.
 *   - Native endpoint: when a `NativeEndpoint` is supplied, the provider's
 *     `create*` factory gets that explicit base URL, key, API mode and
 *     optional timeout. OpenShell endpoints (`isolated`) use a private shared
 *     HTTP pool; bare endpoints keep the ambient fetch. Nothing is read from or
 *     written to the ambient provider env, and no global dispatcher is touched.
 *     Used by OpenShell 0.1.x jobs (see `resolveOpenShellEndpoint`) and by
 *     NIM model roles.
 *
 * OpenShell 0.1 removed the managed inference route. Workloads now
 * call the provider's native API with the credential placeholder injected by
 * the attached provider profile; OpenShell's runtime (policy + proxy) owns
 * enforcement and credential substitution. Google is not wired for this path.
 */

import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { openai, createOpenAI } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";

import {
  createAnthropicOAuthProvider,
  type ClaudeCodeOAuthTokens,
} from "./anthropic-oauth.js";
import { resolveAnthropicAuth } from "./credentials.js";
import { resolveOpenAICompatibleSettings } from "./openai-compatible.js";
import {
  azureFoundryApiStyle,
  azureFoundryOpenAISubmode,
  type AzureFoundryApiMode,
  type AzureFoundryAuthMode,
  type LLMProvider,
  type NativeEndpoint,
} from "./types.js";

/**
 * Fetch wrapper that suppresses Nemotron's chain-of-thought output.
 *
 * Nemotron families have reasoning/thinking ON by default. Different
 * variants use different opt-out mechanisms — there is no single field
 * that works across the family:
 *   - Nemotron-3 (Nano/Super):      `chat_template_kwargs.enable_thinking=false`
 *   - Llama-3.3-Nemotron-Super-v1.5: `/no_think` directive in system message
 *
 * We inject BOTH unconditionally for any `nvidia/*` model. Whichever
 * mechanism the served model honors wins; the other is a silent no-op.
 * Gated on model name so non-Nemotron OpenAI-compat targets aren't
 * affected.
 */
/** Remove <think>…</think> reasoning (closed + unclosed) so it never leaks into parsed content. */
function stripThink(s: string): string {
  return s
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
}

function nimNemotronFetch(base?: typeof fetch): typeof fetch {
  return async (input, init) => {
    let thinkingOn = false;
    if (init?.body && typeof init.body === "string") {
      try {
        const parsed = JSON.parse(init.body) as Record<string, unknown>;
        const model = typeof parsed.model === "string" ? parsed.model : "";
        if (model.startsWith("nvidia/")) {
          // Reasoning ON for the brain (nemotron-3-super-120b) so it can
          // orchestrate the scene + author the commentary; OFF for other nvidia
          // models. We strip the resulting <think> from the RESPONSE below so it
          // never reaches the structured-output / tool-call parser.
          thinkingOn = model.includes("nemotron-3-super-120b");
          parsed.chat_template_kwargs = { enable_thinking: thinkingOn };
          // /no_think still suppresses thinking for Nemotron-3-Nano (it dumps
          // <think> into content and breaks JSON-mode). Super-120b is now allowed
          // to think (response-side strip handles the leakage).
          const needsNoThink = model.includes("nemotron-3-nano");
          if (needsNoThink && Array.isArray(parsed.messages)) {
            const messages = parsed.messages as Array<Record<string, unknown>>;
            const firstSystemIdx = messages.findIndex((m) => m?.role === "system");
            if (firstSystemIdx >= 0) {
              const sys = messages[firstSystemIdx];
              const content = typeof sys.content === "string" ? sys.content : "";
              if (!content.startsWith("/no_think")) {
                messages[firstSystemIdx] = { ...sys, content: `/no_think\n\n${content}` };
              }
            } else {
              messages.unshift({ role: "system", content: "/no_think" });
            }
            parsed.messages = messages;
          }
          init = { ...init, body: JSON.stringify(parsed) };
        }
      } catch {
        // body not JSON — leave alone
      }
    }
    const res = await (base ?? fetch)(input, init);
    // Strip <think> from the (non-streaming) JSON response so reasoning never
    // reaches the tool-call/JSON parser. Best-effort: pass through on any issue.
    if (thinkingOn && res.ok) {
      try {
        const ct = res.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
          const data = (await res.clone().json()) as {
            choices?: Array<{ message?: { content?: unknown } }>;
          };
          let changed = false;
          for (const ch of data?.choices ?? []) {
            const m = ch?.message;
            if (m && typeof m.content === "string" && m.content.includes("<think>")) {
              m.content = stripThink(m.content);
              changed = true;
            }
          }
          if (changed) {
            return new Response(JSON.stringify(data), {
              status: res.status,
              statusText: res.statusText,
              headers: { "content-type": "application/json" },
            });
          }
        }
      } catch {
        // streaming or unparseable — leave the original response untouched
      }
    }
    return res;
  };
}

// OpenShell sandbox guard + credential lookup live in ./openshell-native.ts;
// `resolveModel` only consumes the resulting explicit NativeEndpoint.
export {
  nativeBaseUrlProblem,
  openShellEndpointIssues,
  resolveOpenShellEndpoint,
} from "./openshell-native.js";
export type { NativeApiMode, NativeEndpoint } from "./types.js";
export { DEFAULT_NATIVE_TIMEOUT_MS } from "./types.js";

/**
 * One lazy, module-private undici pool shared by every isolated (OpenShell)
 * client, so an ambient global dispatcher (e.g. a process-wide proxy agent)
 * never carries their traffic and repeated clients reuse sockets instead of
 * leaking per-client pools. Credentials and model stay request-scoped. Idle
 * sockets close after the bounded keep-alive windows. The global dispatcher is
 * never touched. TLS verification stays on with Node's default trust store,
 * which includes `NODE_EXTRA_CA_CERTS` (OpenShell injects its CA there).
 */
let isolatedTransport: Promise<{ fetch: typeof fetch; dispatcher: unknown }> | undefined;

const isolatedFetch: typeof fetch = async (input, init) => {
  isolatedTransport ??= import("undici").then((u) => ({
    fetch: u.fetch as unknown as typeof fetch,
    dispatcher: new u.Agent({ keepAliveTimeout: 10_000, keepAliveMaxTimeout: 60_000 }),
  }));
  const t = await isolatedTransport;
  return t.fetch(input, { ...init, dispatcher: t.dispatcher } as RequestInit);
};

/** Add a per-request timeout to `base` (default: the ambient global fetch). */
function withTimeout(timeoutMs: number, base?: typeof fetch): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return (base ?? fetch)(input, { ...init, signal });
  };
}

/**
 * Transport for an explicit native endpoint: OpenShell endpoints get the
 * isolated pool; bare endpoints (NIM roles) keep the ambient fetch and only
 * add a timeout when one is configured.
 */
function nativeTransport(native: NativeEndpoint): typeof fetch | undefined {
  const base = native.isolated ? isolatedFetch : undefined;
  if (native.timeoutMs !== undefined) return withTimeout(native.timeoutMs, base);
  return base;
}

/**
 * Auth context passed into `resolveModel`. Today only Anthropic OAuth needs
 * special wiring — API-key paths flow transparently through the provider's
 * env-var pickup. `undefined` means "use the SDK default for this provider".
 */
export interface ResolvedModelAuth {
  anthropic?: {
    kind: "oauth_claude_code";
    tokens: ClaudeCodeOAuthTokens;
    tokenSource: "file" | "keychain";
  };
}

// ---------------------------------------------------------------------------
// Azure Foundry (Microsoft Foundry / Azure OpenAI) helpers
// ---------------------------------------------------------------------------

/** Default Entra ID token scope for Azure AI / Foundry. */
export const AZURE_FOUNDRY_DEFAULT_SCOPE = "https://ai.azure.com/.default";

const AZURE_API_MODES: ReadonlySet<AzureFoundryApiMode> = new Set<AzureFoundryApiMode>([
  "auto",
  "chat_completions",
  "responses",
  "codex_responses",
  "anthropic_messages",
]);

const AZURE_AUTH_MODES: ReadonlySet<AzureFoundryAuthMode> = new Set<AzureFoundryAuthMode>([
  "api_key",
  "entra_id",
]);

/** Fully-resolved Azure Foundry configuration, derived from `AZURE_FOUNDRY_*`. */
export interface AzureFoundryResolved {
  apiKey?: string;
  baseUrl: string;
  apiMode: AzureFoundryApiMode;
  authMode: AzureFoundryAuthMode;
  scope: string;
  apiVersion?: string;
  /** Derived wire protocol: OpenAI-style or Anthropic-style. */
  style: "openai" | "anthropic";
}

/**
 * Resolve the Azure Foundry config from environment variables. Pure w.r.t. the
 * passed `env` object (defaults to `process.env`) so it is unit-testable
 * without touching the real environment. Throws with actionable messages on
 * missing base URL / invalid modes / missing api-key.
 */
export function resolveAzureFoundryConfig(
  env: NodeJS.ProcessEnv = process.env,
): AzureFoundryResolved {
  const baseUrl = (env.AZURE_FOUNDRY_BASE_URL ?? "").trim();
  if (!baseUrl) {
    throw new Error(
      "AZURE_FOUNDRY_BASE_URL is not set. Set it to your Foundry endpoint, e.g. " +
        "https://<resource>.openai.azure.com/openai/v1 (OpenAI-style) or " +
        "https://<resource>.services.ai.azure.com/anthropic (Anthropic-style).",
    );
  }

  const rawApiMode = (env.AZURE_FOUNDRY_API_MODE ?? "").trim();
  if (rawApiMode && !AZURE_API_MODES.has(rawApiMode as AzureFoundryApiMode)) {
    throw new Error(
      `AZURE_FOUNDRY_API_MODE "${rawApiMode}" is invalid. Use one of: ${[...AZURE_API_MODES].join(", ")}.`,
    );
  }
  const apiMode = (rawApiMode || "auto") as AzureFoundryApiMode;

  const rawAuthMode = (env.AZURE_FOUNDRY_AUTH_MODE ?? "").trim();
  if (rawAuthMode && !AZURE_AUTH_MODES.has(rawAuthMode as AzureFoundryAuthMode)) {
    throw new Error(
      `AZURE_FOUNDRY_AUTH_MODE "${rawAuthMode}" is invalid. Use one of: ${[...AZURE_AUTH_MODES].join(", ")}.`,
    );
  }
  const authMode = (rawAuthMode || "api_key") as AzureFoundryAuthMode;

  const scope = (env.AZURE_FOUNDRY_SCOPE ?? "").trim() || AZURE_FOUNDRY_DEFAULT_SCOPE;
  const apiVersion = (env.AZURE_FOUNDRY_API_VERSION ?? "").trim() || undefined;
  const apiKey = (env.AZURE_FOUNDRY_API_KEY ?? "").trim() || undefined;

  if (authMode === "api_key" && !apiKey) {
    throw new Error(
      "AZURE_FOUNDRY_API_KEY is not set (auth mode: api_key). Set the key, or set " +
        "AZURE_FOUNDRY_AUTH_MODE=entra_id to authenticate with DefaultAzureCredential.",
    );
  }

  const style = azureFoundryApiStyle({ baseUrl, apiMode });
  return { apiKey, baseUrl, apiMode, authMode, scope, apiVersion, style };
}

/**
 * Strip a trailing `/v1` (and any trailing slashes) from an Azure Anthropic
 * base URL. The AI SDK's Anthropic client appends `/v1/messages` itself, so a
 * base of `.../anthropic/v1` would double the `/v1`.
 */
export function stripTrailingV1(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

/** Append `api-version=<v>` to a URL if not already present. */
function withApiVersion(rawUrl: string, apiVersion: string): string {
  try {
    const u = new URL(rawUrl);
    if (!u.searchParams.has("api-version")) {
      u.searchParams.set("api-version", apiVersion);
    }
    return u.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Build a token getter backed by `@azure/identity`'s DefaultAzureCredential.
 * The package is imported dynamically so API-key users never need it installed.
 * Tokens are cached until ~1 min before expiry.
 */
function makeEntraTokenGetter(scope: string): () => Promise<string> {
  let cached: { token: string; expiresAt: number } | undefined;
  let credentialPromise: Promise<{ getToken(scope: string): Promise<{ token: string; expiresOnTimestamp?: number } | null> }> | undefined;

  return async () => {
    const now = Date.now();
    if (cached && cached.expiresAt - now > 60_000) return cached.token;

    if (!credentialPromise) {
      credentialPromise = import("@azure/identity")
        .then((m) => new m.DefaultAzureCredential())
        .catch(() => {
          throw new Error(
            "Azure Entra ID auth (AZURE_FOUNDRY_AUTH_MODE=entra_id) requires the " +
              "'@azure/identity' package. Install it with `npm install @azure/identity`, " +
              "or switch to AZURE_FOUNDRY_AUTH_MODE=api_key.",
          );
        });
    }
    const credential = await credentialPromise;
    const tok = await credential.getToken(scope);
    if (!tok?.token) {
      throw new Error(`DefaultAzureCredential returned no token for scope "${scope}".`);
    }
    cached = {
      token: tok.token,
      expiresAt: tok.expiresOnTimestamp ?? now + 300_000,
    };
    return cached.token;
  };
}

/**
 * Fetch wrapper for Azure Foundry. Optionally (a) appends the `api-version`
 * query param and (b) overrides the Authorization header with a freshly-minted
 * Entra bearer token. Returns `undefined` when neither is needed so the SDK
 * uses its own fetch.
 */
function makeAzureFetch(opts: {
  apiVersion?: string;
  getToken?: () => Promise<string>;
}): typeof fetch | undefined {
  if (!opts.apiVersion && !opts.getToken) return undefined;
  const base = globalThis.fetch;
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    if (opts.getToken) {
      headers.set("Authorization", `Bearer ${await opts.getToken()}`);
    }
    if (opts.apiVersion) {
      if (input instanceof Request) {
        const rewritten = new Request(withApiVersion(input.url, opts.apiVersion), input);
        return base(rewritten, { ...init, headers });
      }
      const urlStr = input instanceof URL ? input.toString() : String(input);
      return base(withApiVersion(urlStr, opts.apiVersion), { ...init, headers });
    }
    return base(input, { ...init, headers });
  };
}

/**
 * Build an AI SDK model for an Azure Foundry deployment. Routes to the
 * OpenAI-style (`createOpenAI`) or Anthropic-style (`createAnthropic`) provider
 * based on the resolved wire protocol. Bearer auth throughout — Azure Anthropic
 * wants `Authorization: Bearer`, not `x-api-key`.
 */
function resolveAzureFoundryModel(modelId: string) {
  const az = resolveAzureFoundryConfig();
  const useEntra = az.authMode === "entra_id";
  const getToken = useEntra ? makeEntraTokenGetter(az.scope) : undefined;
  const fetchImpl = makeAzureFetch({ apiVersion: az.apiVersion, getToken });

  if (az.style === "anthropic") {
    // The AI SDK appends `/v1/messages`; strip a trailing `/v1` so it isn't
    // doubled. Preserve `api-version` via the fetch wrapper, not the base URL.
    return createAnthropic({
      baseURL: stripTrailingV1(az.baseUrl),
      // Placeholder token under Entra — the fetch wrapper overrides the header.
      authToken: useEntra ? "entra-managed" : az.apiKey,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    })(modelId);
  }

  const provider = createOpenAI({
    baseURL: az.baseUrl,
    // Placeholder key under Entra — the fetch wrapper overrides the header.
    apiKey: useEntra ? "entra-managed" : az.apiKey,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  const submode = azureFoundryOpenAISubmode({ modelId, apiMode: az.apiMode });
  return submode === "responses" ? provider.responses(modelId) : provider.chat(modelId);
}

/**
 * Build a `ResolvedModelAuth` from the persisted credential store. Returns
 * `undefined` (i.e. "use SDK defaults") if no OAuth opt-in is recorded —
 * the API-key path doesn't need a value here because the AI SDK reads the
 * env var directly.
 */
export function resolveAuthForModel(): ResolvedModelAuth | undefined {
  const auth = resolveAnthropicAuth();
  if (auth?.kind === "oauth_claude_code") {
    return {
      anthropic: {
        kind: "oauth_claude_code",
        tokens: auth.tokens,
        tokenSource: auth.tokenSource,
      },
    };
  }
  return undefined;
}

/** Create a Vercel AI SDK model instance for the given provider + model ID. */
export function resolveModel(
  provider: LLMProvider,
  modelId: string,
  native?: NativeEndpoint,
  auth?: ResolvedModelAuth,
) {
  if (native) {
    // The explicit endpoint carries its own credential; ambient auth (incl.
    // Claude Code OAuth) is deliberately not used here and not disturbed.
    const fetchImpl = nativeTransport(native);
    switch (provider) {
      case "anthropic":
        return createAnthropic({
          baseURL: native.baseUrl,
          apiKey: native.apiKey,
          ...(fetchImpl ? { fetch: fetchImpl } : {}),
        })(modelId);
      case "openai": {
        // Chat completions by default: NIM/vLLM-style upstreams commonly serve
        // only /chat/completions. Hosts that serve /responses opt in.
        const p = createOpenAI({
          baseURL: native.baseUrl,
          apiKey: native.apiKey,
          fetch: nimNemotronFetch(fetchImpl),
        });
        return native.apiMode === "responses" ? p.responses(modelId) : p.chat(modelId);
      }
      default:
        throw new Error(`Native endpoint mode does not support provider "${provider}".`);
    }
  }
  switch (provider) {
    case "anthropic":
      if (auth?.anthropic?.kind === "oauth_claude_code") {
        return createAnthropicOAuthProvider({
          tokens: auth.anthropic.tokens,
          source: auth.anthropic.tokenSource,
        })(modelId);
      }
      return anthropic(modelId);
    case "openai": {
      // When OPENAI_BASE_URL points at a self-hosted endpoint (NIM, vLLM,
      // etc.), force POST /v1/chat/completions and inject Nemotron-specific
      // body kwargs. Most self-hosted endpoints only serve /v1/chat/completions
      // and 404 on /v1/responses. Real OpenAI keeps the default factory so
      // o1/o3/gpt-5 reasoning features (reasoningEffort, web_search, etc.)
      // continue to work via /v1/responses.
      //
      // Exception: reasoning models (gpt-5*, o1*, o3*) reject function tools +
      // reasoning_effort on /chat/completions ("Please use /v1/responses
      // instead") — true for OpenAI-compatible gateways like Azure AI Foundry
      // (`…/openai/v1/responses`). For those, use the Responses API even with a
      // custom base; self-hosted (NIM/vLLM) chat targets keep `.chat()`.
      const customBase = process.env.OPENAI_BASE_URL;
      if (customBase) {
        const provider = createOpenAI({
          baseURL: customBase,
          apiKey: process.env.OPENAI_API_KEY ?? undefined,
          fetch: nimNemotronFetch(),
        });
        const isReasoningModel = /^(gpt-5|o1|o3)/i.test(modelId);
        return isReasoningModel ? provider.responses(modelId) : provider.chat(modelId);
      }
      return openai(modelId);
    }
    case "google":
      return google(modelId);
    case "azure-foundry":
      return resolveAzureFoundryModel(modelId);
    case "openai-compatible": {
      // Own env vars (never OPENAI_*), always /chat/completions.
      const settings = resolveOpenAICompatibleSettings(modelId);
      return createOpenAI({
        baseURL: settings.baseURL,
        apiKey: settings.apiKey,
        name: "openai-compatible",
      }).chat(settings.modelId);
    }
    default:
      throw new Error(
        `Unsupported provider: "${provider}". Use "anthropic", "openai", "google", "azure-foundry", or "openai-compatible".`,
      );
  }
}
