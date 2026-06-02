/**
 * Image generation — provider-agnostic helpers + a tool factory.
 *
 * Used by:
 *   - engine.ts (conversational/chat side; sink pushes into per-run image array)
 *   - operate.ts (operator daemon; sink writes to disk + emits telemetry)
 *
 * Provider routing matches engine's prior behavior:
 *   - google  → Gemini image generation (gemini-3.1-flash-image-preview)
 *   - openai  → DALL-E 3 (direct), OR an OpenAI-compat local image NIM
 *               (Qwen-Image-2512 on the brev H200) when
 *               NIM_IMAGE_BASE_URL is set. This is the path used in the
 *               NVIDIA case-study deployment.
 *   - anthropic → unsupported (tool returns a friendly error string)
 */

import { tool as defineTool, jsonSchema } from "ai";
import type { GeneratedImage, LLMProvider } from "./types.js";

// ---------------------------------------------------------------------------
// Provider helpers
// ---------------------------------------------------------------------------

export async function generateImageForProvider(
  provider: LLMProvider,
  prompt: string,
  size?: string,
  aspectRatio?: string,
): Promise<GeneratedImage> {
  if (provider === "google") return generateImageGoogle(prompt, aspectRatio);
  if (provider === "openai") return generateImageOpenAI(prompt, size);
  throw new Error("Provider does not support image generation.");
}

export async function generateImageGoogle(
  prompt: string,
  aspectRatio?: string,
): Promise<GeneratedImage> {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is not set.");

  const generationConfig: Record<string, unknown> = {
    responseModalities: ["IMAGE", "TEXT"],
  };
  if (typeof aspectRatio === "string" && aspectRatio.length > 0) {
    generationConfig.imageConfig = { aspectRatio };
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${apiKey}`,
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

  const res = await fetch(`${baseUrl}/v1/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      size: size || "1024x1024",
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

  return { data: imageData, mimeType: "image/png", prompt, provider: "openai" };
}

// ---------------------------------------------------------------------------
// Tool factory — same input schema for both call sites; only the sink differs
// ---------------------------------------------------------------------------

export interface CreateGenerateImageToolOpts {
  /** LLM provider routing target. Currently must be "google" or "openai". */
  provider: LLMProvider;
  /** Called with the generated image. Caller decides where it goes (in-memory buffer, disk, telemetry, etc). */
  onImage: (image: GeneratedImage) => void | Promise<void>;
  /** Optional: engine-internal halt-signal detector. Operator daemon doesn't need it. */
  isHalt?: (err: unknown) => boolean;
  /** Optional: override the default tool description. The default is chat-oriented ("sent to the user in their channel"); the operator daemon should pass a broadcaster-oriented description so the LLM knows when to call it. */
  description?: string;
  /**
   * Force a specific aspect ratio for every generated image, regardless of
   * what the LLM passes in `aspectRatio`. Currently only honored by the
   * Google provider (fed into Gemini's `imageConfig`). Use for fixed-canvas
   * operators (e.g. a 1920×1080 16:9 stage). Omit for chat-mode so the LLM
   * may request portrait/landscape via the tool's `aspectRatio` input.
   */
  forceAspectRatio?: string;
}

const DEFAULT_DESCRIPTION =
  "Generate an image from a text prompt. Routes to the appropriate image " +
  "generation API based on the configured provider:\n" +
  "- Google → Gemini image generation\n" +
  "- OpenAI → DALL-E 3\n" +
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
        size: {
          type: "string",
          enum: ["1024x1024", "1024x1792", "1792x1024"],
          description: "Image dimensions (OpenAI/DALL-E only). Default: 1024x1024.",
        },
        aspectRatio: {
          type: "string",
          enum: ["1:1", "16:9", "9:16", "4:3", "3:4"],
          description:
            "Aspect ratio (Google/Gemini only). Default: provider default. " +
            "Ignored by OpenAI — use `size` there instead.",
        },
      },
      required: ["prompt"],
    }),
    execute: async (args: Record<string, unknown>) => {
      const prompt = typeof args.prompt === "string" ? args.prompt : "";
      const size = typeof args.size === "string" ? args.size : undefined;
      const aspectRatio =
        opts.forceAspectRatio ??
        (typeof args.aspectRatio === "string" ? args.aspectRatio : undefined);
      if (!prompt) return "Error: prompt is required.";
      if (opts.provider === "anthropic") {
        return "Anthropic does not support image generation. Please switch to Google or OpenAI.";
      }
      try {
        const image = await generateImageForProvider(opts.provider, prompt, size, aspectRatio);
        await opts.onImage(image);
        return `Image generated successfully with prompt: "${prompt}"`;
      } catch (error) {
        if (opts.isHalt?.(error)) throw error;
        return `Failed to generate image: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}
