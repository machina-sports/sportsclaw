/**
 * Native image-generation transport (raw provider backends).
 *
 * Extracted from `src/image-gen.ts` so the unified boundary (`./run.ts`) can
 * wrap the dispatcher without an import cycle. Runtime callers never call this
 * module directly: `run.image()` is the only caller of the dispatcher, and the
 * backends are only reached through the dispatcher. `src/image-gen.ts`
 * re-exports these for public compatibility.
 *
 * Provider routing:
 *   - google        → Gemini image generation (gemini-3.1-flash-image-preview)
 *   - openai        → DALL-E 3 (direct), OR an OpenAI-compatible local image NIM
 *                     (Qwen-Image-2512 on the brev H200) when NIM_IMAGE_BASE_URL is set.
 *   - azure-foundry → Microsoft Foundry / Azure OpenAI image generation via the
 *                     OpenAI-compatible /openai/v1 Images API. Defaults to gpt-image-2.
 *   - anthropic     → unsupported
 */

import type { GeneratedImage, LLMProvider } from "../types.js";

export const AZURE_FOUNDRY_IMAGE_MODEL_DEFAULT = "gpt-image-2";
export const AZURE_FOUNDRY_IMAGE_QUALITY_DEFAULT = "medium";

const OPENAI_DALLE_SIZES = new Set(["1024x1024", "1024x1792", "1792x1024"]);

export async function generateImageForProvider(
  provider: LLMProvider,
  prompt: string,
  size?: string,
  aspectRatio?: string,
  model?: string,
  signal?: AbortSignal,
): Promise<GeneratedImage> {
  if (provider === "google") return generateImageGoogle(prompt, aspectRatio, signal);
  if (provider === "openai") return generateImageOpenAI(prompt, size, signal);
  if (provider === "azure-foundry") return generateImageAzureFoundry(prompt, size, aspectRatio, model, signal);
  throw new Error("Provider does not support image generation.");
}

export async function generateImageGoogle(
  prompt: string,
  aspectRatio?: string,
  signal?: AbortSignal,
): Promise<GeneratedImage> {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is not set.");

  const model = "gemini-3.1-flash-image-preview";
  const generationConfig: Record<string, unknown> = {
    responseModalities: ["IMAGE", "TEXT"],
  };
  if (typeof aspectRatio === "string" && aspectRatio.length > 0) {
    generationConfig.imageConfig = { aspectRatio };
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig,
      }),
      signal,
    },
  );

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Google image generation failed (${res.status}): ${errBody}`);
  }

  const data = (await res.json()) as any;
  const parts = data.candidates?.[0]?.content?.parts;
  if (!parts) throw new Error("Google image generation returned no content.");

  const imagePart = parts.find((p: any) => p.inlineData);
  if (!imagePart?.inlineData?.data) throw new Error("No image data in response.");

  return {
    data: imagePart.inlineData.data,
    mimeType: imagePart.inlineData.mimeType || "image/jpeg",
    prompt,
    provider: "google",
    model,
  };
}

export async function generateImageOpenAI(
  prompt: string,
  size?: string,
  signal?: AbortSignal,
): Promise<GeneratedImage> {
  // When NIM_IMAGE_BASE_URL is set, route to a self-hosted OpenAI-compat
  // image NIM (Qwen-Image-2512 on the brev H200) instead of DALL-E.
  // The NIM's served-model-name comes from NIM_IMAGE_MODEL.
  const nimBase = process.env.NIM_IMAGE_BASE_URL;
  const nimModel = process.env.NIM_IMAGE_MODEL;
  const useNim = !!nimBase;
  const baseUrl = useNim ? nimBase : "https://api.openai.com";
  const model = useNim ? (nimModel ?? "qwen/qwen-image-2512") : "dall-e-3";
  const apiKey = useNim ? "nim-unused" : process.env.OPENAI_API_KEY;
  if (!useNim && !apiKey) throw new Error("OPENAI_API_KEY is not set.");

  const resolvedSize = size && (useNim || OPENAI_DALLE_SIZES.has(size)) ? size : "1024x1024";
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      size: resolvedSize,
      response_format: "b64_json",
    }),
    signal,
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`${useNim ? "NIM" : "OpenAI"} image generation failed (${res.status}): ${errBody}`);
  }

  const data = (await res.json()) as any;
  const imageData = data.data?.[0]?.b64_json;
  if (!imageData) throw new Error("Image generation returned no image data.");

  return { data: imageData, mimeType: "image/png", prompt, provider: "openai", model };
}

export function azureFoundryImageSize(size?: string, aspectRatio?: string): string {
  if (size && ["1024x1024", "1536x1024", "1024x1536"].includes(size)) {
    return size;
  }
  switch (aspectRatio) {
    case "16:9":
    case "4:3":
      return "1536x1024";
    case "9:16":
    case "3:4":
      return "1024x1536";
    case "1:1":
    default:
      return "1024x1024";
  }
}

function azureFoundryImageBaseUrl(): string {
  const base = process.env.AZURE_FOUNDRY_IMAGE_BASE_URL || process.env.AZURE_FOUNDRY_BASE_URL;
  if (!base) {
    throw new Error(
      "AZURE_FOUNDRY_IMAGE_BASE_URL or AZURE_FOUNDRY_BASE_URL is required for Azure Foundry image generation.",
    );
  }
  if (base.toLowerCase().includes("/anthropic")) {
    throw new Error(
      "Azure Foundry image generation needs an OpenAI-style /openai/v1 endpoint. " +
        "Set AZURE_FOUNDRY_IMAGE_BASE_URL to your Foundry /openai/v1 endpoint.",
    );
  }
  return base;
}

function azureFoundryImagesUrl(baseUrl: string): string {
  const u = new URL(baseUrl);
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/images/generations`;
  const apiVersion = process.env.AZURE_FOUNDRY_API_VERSION;
  if (apiVersion && !u.searchParams.has("api-version")) {
    u.searchParams.set("api-version", apiVersion);
  }
  return u.toString();
}

async function imageUrlToBase64(
  url: string,
  signal?: AbortSignal,
): Promise<{ data: string; mimeType: string }> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`Image URL download failed (${res.status}): ${await res.text()}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  return {
    data: bytes.toString("base64"),
    mimeType: res.headers.get("content-type") || "image/png",
  };
}

export async function generateImageAzureFoundry(
  prompt: string,
  size?: string,
  aspectRatio?: string,
  model?: string,
  signal?: AbortSignal,
): Promise<GeneratedImage> {
  const apiKey = process.env.AZURE_FOUNDRY_API_KEY;
  if (!apiKey) throw new Error("AZURE_FOUNDRY_API_KEY is not set.");

  const imageModel = model || process.env.AZURE_FOUNDRY_IMAGE_MODEL || AZURE_FOUNDRY_IMAGE_MODEL_DEFAULT;
  const quality = process.env.AZURE_FOUNDRY_IMAGE_QUALITY || AZURE_FOUNDRY_IMAGE_QUALITY_DEFAULT;
  const resolvedSize = azureFoundryImageSize(size, aspectRatio);
  const url = azureFoundryImagesUrl(azureFoundryImageBaseUrl());

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: imageModel,
      prompt,
      n: 1,
      size: resolvedSize,
      quality,
    }),
    signal,
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Azure Foundry image generation failed (${res.status}): ${errBody}`);
  }

  const data = (await res.json()) as any;
  const first = data.data?.[0];
  if (first?.b64_json) {
    return { data: first.b64_json, mimeType: "image/png", prompt, provider: "azure-foundry", model: imageModel };
  }
  if (first?.url) {
    const downloaded = await imageUrlToBase64(first.url, signal);
    return { ...downloaded, prompt, provider: "azure-foundry", model: imageModel };
  }
  throw new Error("Azure Foundry image generation returned no image data.");
}
