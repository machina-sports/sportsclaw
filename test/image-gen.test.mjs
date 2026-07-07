/**
 * Image generation helpers — no-network tests.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  AZURE_FOUNDRY_IMAGE_MODEL_DEFAULT,
  azureFoundryImageSize,
  generateImageAzureFoundry,
  generateImageForProvider,
  generateImageOpenAI,
} from "../dist/image-gen.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("azureFoundryImageSize", () => {
  it("maps aspect ratios to gpt-image-2 sizes", () => {
    assert.strictEqual(azureFoundryImageSize(undefined, "1:1"), "1024x1024");
    assert.strictEqual(azureFoundryImageSize(undefined, "16:9"), "1536x1024");
    assert.strictEqual(azureFoundryImageSize(undefined, "4:3"), "1536x1024");
    assert.strictEqual(azureFoundryImageSize(undefined, "9:16"), "1024x1536");
    assert.strictEqual(azureFoundryImageSize(undefined, "3:4"), "1024x1536");
  });

  it("honors supported explicit Azure sizes", () => {
    assert.strictEqual(azureFoundryImageSize("1536x1024", "1:1"), "1536x1024");
    assert.strictEqual(azureFoundryImageSize("1024x1536", "16:9"), "1024x1536");
  });

  it("falls back to square for unsupported explicit sizes", () => {
    assert.strictEqual(azureFoundryImageSize("1792x1024", undefined), "1024x1024");
  });
});

describe("generateImageAzureFoundry", () => {
  it("posts gpt-image-2 requests to the Foundry /images/generations endpoint", async () => {
    process.env.AZURE_FOUNDRY_BASE_URL = "https://example.openai.azure.com/openai/v1";
    process.env.AZURE_FOUNDRY_API_KEY = "x";

    let captured;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init };
      return new Response(
        JSON.stringify({ data: [{ b64_json: Buffer.from("fake-image").toString("base64") }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const image = await generateImageAzureFoundry("World Cup poster", undefined, "16:9");

    assert.strictEqual(captured.url, "https://example.openai.azure.com/openai/v1/images/generations");
    assert.strictEqual(captured.init.method, "POST");
    assert.strictEqual(captured.init.headers.Authorization, "Bearer x");
    const body = JSON.parse(captured.init.body);
    assert.strictEqual(body.model, AZURE_FOUNDRY_IMAGE_MODEL_DEFAULT);
    assert.strictEqual(body.prompt, "World Cup poster");
    assert.strictEqual(body.size, "1536x1024");
    assert.strictEqual(body.quality, "medium");
    assert.strictEqual(body.response_format, "b64_json");
    assert.strictEqual(image.provider, "azure-foundry");
    assert.strictEqual(image.model, "gpt-image-2");
    assert.strictEqual(Buffer.from(image.data, "base64").toString("utf8"), "fake-image");
  });

  it("supports an image-specific base URL, model override, quality, and api-version", async () => {
    process.env.AZURE_FOUNDRY_BASE_URL = "https://wrong.example/anthropic";
    process.env.AZURE_FOUNDRY_IMAGE_BASE_URL = "https://example.services.ai.azure.com/openai/v1";
    process.env.AZURE_FOUNDRY_API_KEY = "x";
    process.env.AZURE_FOUNDRY_IMAGE_QUALITY = "high";
    process.env.AZURE_FOUNDRY_API_VERSION = "2026-01-01-preview";

    let captured;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ data: [{ b64_json: "ZmFrZQ==" }] }), { status: 200 });
    };

    await generateImageAzureFoundry("poster", "1024x1536", undefined, "gpt-image-2");

    assert.strictEqual(
      captured.url,
      "https://example.services.ai.azure.com/openai/v1/images/generations?api-version=2026-01-01-preview",
    );
    assert.strictEqual(captured.body.model, "gpt-image-2");
    assert.strictEqual(captured.body.quality, "high");
    assert.strictEqual(captured.body.size, "1024x1536");
  });

  it("downloads URL responses into the GeneratedImage base64 contract", async () => {
    process.env.AZURE_FOUNDRY_BASE_URL = "https://example.openai.azure.com/openai/v1";
    process.env.AZURE_FOUNDRY_API_KEY = "x";

    globalThis.fetch = async (url) => {
      if (String(url).endsWith("/images/generations")) {
        return new Response(JSON.stringify({ data: [{ url: "https://cdn.example/image.png" }] }), { status: 200 });
      }
      return new Response(Buffer.from("downloaded-image"), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    };

    const image = await generateImageAzureFoundry("poster");
    assert.strictEqual(image.mimeType, "image/png");
    assert.strictEqual(Buffer.from(image.data, "base64").toString("utf8"), "downloaded-image");
  });

  it("fails clearly without Azure image credentials", async () => {
    process.env.AZURE_FOUNDRY_BASE_URL = "https://example.openai.azure.com/openai/v1";
    delete process.env.AZURE_FOUNDRY_API_KEY;
    await assert.rejects(() => generateImageAzureFoundry("poster"), /AZURE_FOUNDRY_API_KEY is not set/);
  });

  it("rejects Anthropic-style Foundry endpoints for image generation", async () => {
    process.env.AZURE_FOUNDRY_BASE_URL = "https://example.services.ai.azure.com/anthropic";
    process.env.AZURE_FOUNDRY_API_KEY = "x";
    await assert.rejects(() => generateImageAzureFoundry("poster"), /OpenAI-style \/openai\/v1 endpoint/);
  });
});

describe("generateImageForProvider", () => {
  it("routes azure-foundry to the Azure image generator", async () => {
    process.env.AZURE_FOUNDRY_BASE_URL = "https://example.openai.azure.com/openai/v1";
    process.env.AZURE_FOUNDRY_API_KEY = "x";
    globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ b64_json: "ZmFrZQ==" }] }), { status: 200 });

    const image = await generateImageForProvider("azure-foundry", "poster", undefined, "1:1", "gpt-image-2");
    assert.strictEqual(image.provider, "azure-foundry");
    assert.strictEqual(image.model, "gpt-image-2");
  });

  it("clamps unsupported DALL-E sizes to 1024x1024", async () => {
    process.env.OPENAI_API_KEY = "x";
    let capturedBody;
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ data: [{ b64_json: "ZmFrZQ==" }] }), { status: 200 });
    };

    await generateImageOpenAI("poster", "1536x1024");
    assert.strictEqual(capturedBody.size, "1024x1024");
  });
});
