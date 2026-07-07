/**
 * LLM provider resolution — Azure Foundry pure-helper tests.
 *
 * These exercise the pure config/style helpers only. No network calls and no
 * real AI SDK model construction (that would need live credentials / an
 * endpoint). `resolveAzureFoundryConfig` takes an explicit `env` object so we
 * never touch the real process environment.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CUSTOM_MODEL_VALUE,
  DEFAULT_MODELS,
  PROVIDER_MODEL_PROFILES,
  azureFoundryApiStyle,
  azureFoundryOpenAISubmode,
} from "../dist/types.js";
import {
  AZURE_FOUNDRY_DEFAULT_SCOPE,
  resolveAzureFoundryConfig,
  stripTrailingV1,
} from "../dist/llm-providers.js";

// ---------------------------------------------------------------------------
// provider model profiles
// ---------------------------------------------------------------------------

describe("PROVIDER_MODEL_PROFILES", () => {
  it("ships curated current defaults for every provider", () => {
    for (const provider of ["anthropic", "openai", "google", "azure-foundry"]) {
      assert.ok(DEFAULT_MODELS[provider], `missing default for ${provider}`);
      assert.ok(PROVIDER_MODEL_PROFILES[provider].selectableModels.length >= 2, provider);
    }
    assert.ok(PROVIDER_MODEL_PROFILES.anthropic.selectableModels.some((m) => m.value === "claude-sonnet-4-6"));
    assert.ok(PROVIDER_MODEL_PROFILES.openai.selectableModels.some((m) => m.value === "gpt-5.4-mini"));
    assert.ok(PROVIDER_MODEL_PROFILES.google.selectableModels.some((m) => m.value === "gemini-3.5-flash"));
    assert.ok(PROVIDER_MODEL_PROFILES["azure-foundry"].selectableModels.some((m) => m.value === "gpt-5.4"));
  });

  it("reserves a custom model sentinel for the config wizard", () => {
    assert.strictEqual(CUSTOM_MODEL_VALUE, "__custom_model__");
  });
});

// ---------------------------------------------------------------------------
// azureFoundryApiStyle
// ---------------------------------------------------------------------------

describe("azureFoundryApiStyle", () => {
  it("honours an explicit anthropic_messages mode regardless of URL", () => {
    assert.strictEqual(
      azureFoundryApiStyle({
        baseUrl: "https://x.openai.azure.com/openai/v1",
        apiMode: "anthropic_messages",
      }),
      "anthropic",
    );
  });

  it("honours explicit OpenAI-style modes", () => {
    for (const apiMode of ["chat_completions", "responses", "codex_responses"]) {
      assert.strictEqual(
        azureFoundryApiStyle({
          baseUrl: "https://x.services.ai.azure.com/anthropic",
          apiMode,
        }),
        "openai",
        `apiMode=${apiMode}`,
      );
    }
  });

  it("auto-detects Anthropic from a /anthropic base URL", () => {
    assert.strictEqual(
      azureFoundryApiStyle({
        baseUrl: "https://x.services.ai.azure.com/anthropic",
        apiMode: "auto",
      }),
      "anthropic",
    );
  });

  it("auto-detects OpenAI from an openai.azure.com base URL", () => {
    assert.strictEqual(
      azureFoundryApiStyle({
        baseUrl: "https://x.openai.azure.com/openai/v1",
        apiMode: "auto",
      }),
      "openai",
    );
  });

  it("defaults to OpenAI when nothing is known", () => {
    assert.strictEqual(azureFoundryApiStyle({}), "openai");
  });
});

// ---------------------------------------------------------------------------
// azureFoundryOpenAISubmode
// ---------------------------------------------------------------------------

describe("azureFoundryOpenAISubmode", () => {
  it("honours explicit responses/codex_responses modes", () => {
    for (const apiMode of ["responses", "codex_responses"]) {
      assert.strictEqual(
        azureFoundryOpenAISubmode({ modelId: "gpt-4o", apiMode }),
        "responses",
        `apiMode=${apiMode}`,
      );
    }
  });

  it("honours explicit chat_completions mode even for a reasoning model", () => {
    assert.strictEqual(
      azureFoundryOpenAISubmode({ modelId: "gpt-5.2", apiMode: "chat_completions" }),
      "chat",
    );
  });

  it("auto-routes reasoning families to the Responses API", () => {
    for (const modelId of ["gpt-5.2", "o1-preview", "o3-mini", "o4-mini", "codex-mini"]) {
      assert.strictEqual(
        azureFoundryOpenAISubmode({ modelId, apiMode: "auto" }),
        "responses",
        `model=${modelId}`,
      );
    }
  });

  it("auto-routes non-reasoning models to Chat Completions", () => {
    for (const modelId of ["gpt-4o", "gpt-4.1", "gpt-4-turbo"]) {
      assert.strictEqual(
        azureFoundryOpenAISubmode({ modelId, apiMode: "auto" }),
        "chat",
        `model=${modelId}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// stripTrailingV1
// ---------------------------------------------------------------------------

describe("stripTrailingV1", () => {
  it("removes a trailing /v1", () => {
    assert.strictEqual(
      stripTrailingV1("https://x.services.ai.azure.com/anthropic/v1"),
      "https://x.services.ai.azure.com/anthropic",
    );
  });

  it("removes a trailing /v1 with a trailing slash", () => {
    assert.strictEqual(
      stripTrailingV1("https://x.services.ai.azure.com/anthropic/v1/"),
      "https://x.services.ai.azure.com/anthropic",
    );
  });

  it("is case-insensitive on the /v1 segment", () => {
    assert.strictEqual(
      stripTrailingV1("https://x.services.ai.azure.com/anthropic/V1"),
      "https://x.services.ai.azure.com/anthropic",
    );
  });

  it("leaves a URL without a trailing /v1 unchanged (bar trailing slashes)", () => {
    assert.strictEqual(
      stripTrailingV1("https://x.services.ai.azure.com/anthropic"),
      "https://x.services.ai.azure.com/anthropic",
    );
  });
});

// ---------------------------------------------------------------------------
// resolveAzureFoundryConfig
// ---------------------------------------------------------------------------

describe("resolveAzureFoundryConfig", () => {
  it("throws when the base URL is missing", () => {
    assert.throws(
      () => resolveAzureFoundryConfig({}),
      /AZURE_FOUNDRY_BASE_URL is not set/,
    );
  });

  it("applies defaults (auto mode, api_key auth, default scope, no api-version)", () => {
    const c = resolveAzureFoundryConfig({
      AZURE_FOUNDRY_BASE_URL: "https://x.openai.azure.com/openai/v1",
      AZURE_FOUNDRY_API_KEY: "k-123456",
    });
    assert.strictEqual(c.apiMode, "auto");
    assert.strictEqual(c.authMode, "api_key");
    assert.strictEqual(c.scope, AZURE_FOUNDRY_DEFAULT_SCOPE);
    assert.strictEqual(c.apiVersion, undefined);
    assert.strictEqual(c.apiKey, "k-123456");
    assert.strictEqual(c.style, "openai");
  });

  it("throws under api_key auth when no key is set", () => {
    assert.throws(
      () =>
        resolveAzureFoundryConfig({
          AZURE_FOUNDRY_BASE_URL: "https://x.openai.azure.com/openai/v1",
        }),
      /AZURE_FOUNDRY_API_KEY is not set/,
    );
  });

  it("accepts entra_id auth with no API key", () => {
    const c = resolveAzureFoundryConfig({
      AZURE_FOUNDRY_BASE_URL: "https://x.openai.azure.com/openai/v1",
      AZURE_FOUNDRY_AUTH_MODE: "entra_id",
    });
    assert.strictEqual(c.authMode, "entra_id");
    assert.strictEqual(c.apiKey, undefined);
  });

  it("resolves an Anthropic-style endpoint", () => {
    const c = resolveAzureFoundryConfig({
      AZURE_FOUNDRY_BASE_URL: "https://x.services.ai.azure.com/anthropic",
      AZURE_FOUNDRY_API_KEY: "k",
    });
    assert.strictEqual(c.style, "anthropic");
  });

  it("carries scope + api-version overrides through", () => {
    const c = resolveAzureFoundryConfig({
      AZURE_FOUNDRY_BASE_URL: "https://x.openai.azure.com/openai/v1",
      AZURE_FOUNDRY_API_KEY: "k",
      AZURE_FOUNDRY_SCOPE: "https://custom.scope/.default",
      AZURE_FOUNDRY_API_VERSION: "2025-01-01-preview",
    });
    assert.strictEqual(c.scope, "https://custom.scope/.default");
    assert.strictEqual(c.apiVersion, "2025-01-01-preview");
  });

  it("rejects an invalid api mode", () => {
    assert.throws(
      () =>
        resolveAzureFoundryConfig({
          AZURE_FOUNDRY_BASE_URL: "https://x.openai.azure.com/openai/v1",
          AZURE_FOUNDRY_API_KEY: "k",
          AZURE_FOUNDRY_API_MODE: "bananas",
        }),
      /AZURE_FOUNDRY_API_MODE .* is invalid/,
    );
  });

  it("rejects an invalid auth mode", () => {
    assert.throws(
      () =>
        resolveAzureFoundryConfig({
          AZURE_FOUNDRY_BASE_URL: "https://x.openai.azure.com/openai/v1",
          AZURE_FOUNDRY_API_KEY: "k",
          AZURE_FOUNDRY_AUTH_MODE: "oauth",
        }),
      /AZURE_FOUNDRY_AUTH_MODE .* is invalid/,
    );
  });
});
