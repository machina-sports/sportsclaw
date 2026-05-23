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

import type { LLMProvider } from "./types.js";

/** Resolved OpenShell routing decision passed into `resolveModel`. */
export interface OpenShellRoute {
  /** Base URL handed to the AI SDK provider factory. */
  baseUrl: string;
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

/** Create a Vercel AI SDK model instance for the given provider + model ID. */
export function resolveModel(
  provider: LLMProvider,
  modelId: string,
  openshell?: OpenShellRoute,
) {
  if (openshell) {
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
        }).chat(modelId);
      case "google":
        throw new Error(
          `OpenShell mode does not support provider "${provider}".`,
        );
    }
  }
  switch (provider) {
    case "anthropic":
      return anthropic(modelId);
    case "openai":
      return openai(modelId);
    case "google":
      return google(modelId);
    default:
      throw new Error(
        `Unsupported provider: "${provider}". Use "anthropic", "openai", or "google".`,
      );
  }
}
