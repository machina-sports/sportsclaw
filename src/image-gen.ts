/**
 * Image generation — provider-agnostic helpers + a tool factory.
 *
 * Used by:
 *   - engine.ts (conversational/chat side; sink pushes into per-run image array)
 *   - operate.ts (operator daemon; sink writes to disk + emits telemetry)
 *
 * Provider routing matches engine's prior behavior:
 *   - google  → Gemini image generation (gemini-3.1-flash-image-preview)
 *   - openai  → DALL-E 3
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
): Promise<GeneratedImage> {
  if (provider === "google") return generateImageGoogle(prompt);
  if (provider === "openai") return generateImageOpenAI(prompt, size);
  throw new Error("Provider does not support image generation.");
}

export async function generateImageGoogle(prompt: string): Promise<GeneratedImage> {
  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is not set.");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
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
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set.");

  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "dall-e-3",
      prompt,
      n: 1,
      size: size || "1024x1024",
      response_format: "b64_json",
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`OpenAI image generation failed (${res.status}): ${errBody}`);
  }

  const data = (await res.json()) as any;
  const imageData = data.data?.[0]?.b64_json;
  if (!imageData) throw new Error("OpenAI image generation returned no image data.");

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
}

export function createGenerateImageTool(opts: CreateGenerateImageToolOpts) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (defineTool as any)({
    description:
      "Generate an image from a text prompt. Routes to the appropriate image " +
      "generation API based on the configured provider:\n" +
      "- Google → Gemini image generation\n" +
      "- OpenAI → DALL-E 3\n" +
      "- Anthropic → Not supported (will return an error)\n" +
      "The generated image is automatically sent to the user in their channel.",
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
          description: "Image dimensions. Default: 1024x1024.",
        },
      },
      required: ["prompt"],
    }),
    execute: async (args: Record<string, unknown>) => {
      const prompt = typeof args.prompt === "string" ? args.prompt : "";
      const size = typeof args.size === "string" ? args.size : undefined;
      if (!prompt) return "Error: prompt is required.";
      if (opts.provider === "anthropic") {
        return "Anthropic does not support image generation. Please switch to Google or OpenAI.";
      }
      try {
        const image = await generateImageForProvider(opts.provider, prompt, size);
        await opts.onImage(image);
        return `Image generated successfully with prompt: "${prompt}"`;
      } catch (error) {
        if (opts.isHalt?.(error)) throw error;
        return `Failed to generate image: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}
