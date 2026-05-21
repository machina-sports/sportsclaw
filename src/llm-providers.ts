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
 *   - OpenShell: when an `OpenShellRoute` is supplied, the provider's
 *     `create*` factory is invoked with an explicit `baseURL`, routing
 *     calls through the Privacy Router. The apiKey is a placeholder —
 *     the router strips client credentials and injects backend ones.
 *
 * Google is unsupported under OpenShell because the Privacy Router
 * speaks OpenAI-compatible and Anthropic-compatible HTTP only.
 * `operator-config`'s validator rejects that combination at load time.
 */

import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { openai, createOpenAI } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";

import {
  createAnthropicOAuthProvider,
  type ClaudeCodeOAuthTokens,
} from "./anthropic-oauth.js";
import { resolveAnthropicAuth } from "./credentials.js";
import type { LLMProvider } from "./types.js";

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
function nimNemotronFetch(): typeof fetch {
  return async (input, init) => {
    if (init?.body && typeof init.body === "string") {
      try {
        const parsed = JSON.parse(init.body) as Record<string, unknown>;
        const model = typeof parsed.model === "string" ? parsed.model : "";
        if (model.startsWith("nvidia/")) {
          // Chat template flag for Nemotron-3 family (Nano, Super-3, etc.).
          // Llama-3.3-Nemotron-Super-49B-v1.5 ignores this — harmless when ignored.
          parsed.chat_template_kwargs = { enable_thinking: false };
          // /no_think system directive: only inject for Nemotron-3-Nano family,
          // which dumps `<think>...</think>` blocks into `content` instead of
          // the `reasoning` field, breaking JSON-mode outputs.
          //
          // Llama-3.3-Nemotron-Super-49B-v1.5 is deliberately allowed to think:
          // its tool-calling reliability drops sharply without deliberation,
          // and the custom llama_nemotron_json parser correctly extracts tool
          // calls even when thinking is on.
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
    return fetch(input, init);
  };
}

/** Resolved OpenShell routing decision passed into `resolveModel`. */
export interface OpenShellRoute {
  /** Base URL handed to the AI SDK provider factory. */
  baseUrl: string;
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

/**
 * Provider-specific default base URL for OpenShell's `inference.local`.
 * Each SDK has its own path convention — Anthropic appends
 * `/v1/messages`, OpenAI clients expect the `/v1` prefix already in
 * the base URL.
 */
export function defaultOpenShellBaseUrl(provider: LLMProvider): string {
  switch (provider) {
    case "anthropic":
      return "https://inference.local";
    case "openai":
      return "https://inference.local/v1";
    case "google":
      throw new Error(
        "OpenShell does not support Google's API protocol. Drop the openshell block or pick provider \"anthropic\" / \"openai\".",
      );
  }
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
  openshell?: OpenShellRoute,
  auth?: ResolvedModelAuth,
) {
  if (openshell) {
    if (auth?.anthropic?.kind === "oauth_claude_code") {
      throw new Error(
        "OpenShell mode is incompatible with Claude Code OAuth — the Privacy " +
        "Router injects its own credentials. Either drop the openshell block " +
        "or run `sportsclaw logout claude` to fall back to the API key.",
      );
    }
    switch (provider) {
      case "anthropic":
        return createAnthropic({
          baseURL: openshell.baseUrl,
          apiKey: "openshell-unused",
        })(modelId);
      case "openai":
        // .chat (not the default factory) targets POST /v1/chat/completions.
        // The default uses /v1/responses, which the OpenShell Privacy Router
        // proxies through to the upstream — but most OpenAI-compatible
        // upstreams (NVIDIA API Catalog, Nemotron-on-vLLM, etc.) only serve
        // /v1/chat/completions and 404 on /v1/responses. Forcing chat keeps
        // OpenShell mode working across every supported provider.
        return createOpenAI({
          baseURL: openshell.baseUrl,
          apiKey: "openshell-unused",
          fetch: nimNemotronFetch(),
        }).chat(modelId);
      case "google":
        throw new Error(
          `OpenShell mode does not support provider "${provider}".`,
        );
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
      const customBase = process.env.OPENAI_BASE_URL;
      if (customBase) {
        return createOpenAI({
          baseURL: customBase,
          apiKey: process.env.OPENAI_API_KEY ?? undefined,
          fetch: nimNemotronFetch(),
        }).chat(modelId);
      }
      return openai(modelId);
    }
    case "google":
      return google(modelId);
    default:
      throw new Error(
        `Unsupported provider: "${provider}". Use "anthropic", "openai", or "google".`,
      );
  }
}
