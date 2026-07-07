/**
 * Image generation — provider-agnostic helpers + a tool factory.
 *
 * Used by:
 *   - engine.ts (conversational/chat side; sink pushes into per-run image array)
 *   - operate.ts (operator daemon; sink writes to disk + emits telemetry)
 *
 * Provider routing:
 *   - google        → Gemini image generation (gemini-3.1-flash-image-preview)
 *   - openai        → DALL-E 3 (direct), OR an OpenAI-compatible local image NIM
 *                     (Qwen-Image-2512 on the brev H200) when NIM_IMAGE_BASE_URL is set.
 *   - azure-foundry → Microsoft Foundry / Azure OpenAI image generation via the
 *                     OpenAI-compatible /openai/v1 Images API. Defaults to gpt-image-2.
 *   - anthropic     → unsupported (tool returns a friendly error string)
 */

import { tool as defineTool, jsonSchema } from "ai";
import type { GeneratedImage, LLMProvider } from "./types.js";

// ---------------------------------------------------------------------------
// Provider helpers
// ---------------------------------------------------------------------------

export const AZURE_FOUNDRY_IMAGE_MODEL_DEFAULT = "gpt-image-2";
export const AZURE_FOUNDRY_IMAGE_QUALITY_DEFAULT = "medium";

const OPENAI_DALLE_SIZES = new Set(["1024x1024", "1024x1792", "1792x1024"]);

export async function generateImageForProvider(
  provider: LLMProvider,
  prompt: string,
  size?: string,
  aspectRatio?: string,
  model?: string,
): Promise<GeneratedImage> {
  if (provider === "google") return generateImageGoogle(prompt, aspectRatio);
  if (provider === "openai") return generateImageOpenAI(prompt, size);
  if (provider === "azure-foundry") return generateImageAzureFoundry(prompt, size, aspectRatio, model);
  throw new Error("Provider does not support image generation.");
}

export async function generateImageGoogle(
  prompt: string,
  aspectRatio?: string,
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

export async function generateImageOpenAI(prompt: string, size?: string): Promise<GeneratedImage> {
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

async function imageUrlToBase64(url: string): Promise<{ data: string; mimeType: string }> {
  const res = await fetch(url);
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
      response_format: "b64_json",
    }),
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
    const downloaded = await imageUrlToBase64(first.url);
    return { ...downloaded, prompt, provider: "azure-foundry", model: imageModel };
  }
  throw new Error("Azure Foundry image generation returned no image data.");
}

// ---------------------------------------------------------------------------
// Tool factory — same input schema for both call sites; only the sink differs
// ---------------------------------------------------------------------------

export interface CreateGenerateImageToolOpts {
  /** LLM provider routing target. Currently must be "google", "openai", or "azure-foundry". */
  provider: LLMProvider;
  /** Called with the generated image. Caller decides where it goes (in-memory buffer, disk, telemetry, etc). */
  onImage: (image: GeneratedImage) => void | Promise<void>;
  /** Optional: engine-internal halt-signal detector. Operator daemon doesn't need it. */
  isHalt?: (err: unknown) => boolean;
  /** Optional: override the default tool description. The default is chat-oriented ("sent to the user in their channel"); the operator daemon should pass a broadcaster-oriented description so the LLM knows when to call it. */
  description?: string;
  /**
   * Force a specific aspect ratio for every generated image, regardless of
   * what the LLM passes in `aspectRatio`. Honored by Google and Azure Foundry.
   * Use for fixed-canvas operators (e.g. a 1920×1080 16:9 stage). Omit for
   * chat-mode so the LLM may request portrait/landscape via the tool input.
   */
  forceAspectRatio?: string;
}

const DEFAULT_DESCRIPTION =
  "Generate an image from a text prompt. Routes to the appropriate image " +
  "generation API based on the configured provider:\n" +
  "- Google → Gemini image generation\n" +
  "- OpenAI → DALL-E 3 or an OpenAI-compatible image endpoint\n" +
  "- Azure Foundry → gpt-image-2 through a Foundry /openai/v1 endpoint\n" +
  "- Anthropic → Not supported (will return an error)\n" +
  "The generated image is automatically sent to the user in their channel.";

export function createGenerateImageTool(opts: CreateGenerateImageToolOpts) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (defineTool as any)({
    description: opts.description ?? DEFAULT_DESCRIPTION,
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Detailed text description of the image to generate. Be specific " +
            "about style, composition, colors, and subject matter.",
        },
        model: {
          type: "string",
          enum: ["gpt-image-2"],
          description:
            "Azure Foundry image model. Currently supports gpt-image-2. " +
            "Ignored by Google/OpenAI providers.",
        },
        size: {
          type: "string",
          enum: ["1024x1024", "1024x1792", "1792x1024", "1536x1024", "1024x1536"],
          description:
            "Image dimensions. OpenAI/DALL-E supports 1024x1024, 1024x1792, 1792x1024. " +
            "Azure Foundry gpt-image-2 supports 1024x1024, 1536x1024, 1024x1536.",
        },
        aspectRatio: {
          type: "string",
          enum: ["1:1", "16:9", "9:16", "4:3", "3:4"],
          description:
            "Aspect ratio. Google uses this directly. Azure Foundry maps it to the closest " +
            "gpt-image-2 size. Ignored by OpenAI/DALL-E — use `size` there instead.",
        },
      },
      required: ["prompt"],
    }),
    execute: async (args: Record<string, unknown>) => {
      const prompt = typeof args.prompt === "string" ? args.prompt : "";
      const model = typeof args.model === "string" ? args.model : undefined;
      const size = typeof args.size === "string" ? args.size : undefined;
      const aspectRatio =
        opts.forceAspectRatio ??
        (typeof args.aspectRatio === "string" ? args.aspectRatio : undefined);
      if (!prompt) return "Error: prompt is required.";
      if (opts.provider === "anthropic") {
        return "Anthropic does not support image generation. Please switch to Google, OpenAI, or Azure Foundry.";
      }
      try {
        const image = await generateImageForProvider(opts.provider, prompt, size, aspectRatio, model);
        await opts.onImage(image);
        const modelSuffix = image.model ? ` (${image.model})` : "";
        return `Image generated successfully with ${image.provider}${modelSuffix}: "${prompt}"`;
      } catch (error) {
        if (opts.isHalt?.(error)) throw error;
        return `Failed to generate image: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}
