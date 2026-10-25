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
 *
 * The raw provider transport lives in `./inference/image-gen.ts` and is
 * re-exported here for compatibility. Execution goes through the unified
 * boundary (`./inference/run.ts` → `image()`).
 */

import { tool as defineTool, jsonSchema } from "ai";
import type { GeneratedImage, LLMProvider } from "./types.js";
import { image } from "./inference/run.js";

export {
  AZURE_FOUNDRY_IMAGE_MODEL_DEFAULT,
  AZURE_FOUNDRY_IMAGE_QUALITY_DEFAULT,
  azureFoundryImageSize,
  generateImageAzureFoundry,
  generateImageForProvider,
  generateImageGoogle,
  generateImageOpenAI,
} from "./inference/image-gen.js";

/** Route label for receipts only; the endpoint itself is never recorded. */
function imageRoute(provider: LLMProvider): "nim" | "direct" {
  return provider === "openai" && process.env.NIM_IMAGE_BASE_URL ? "nim" : "direct";
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
    execute: async (args: Record<string, unknown>, options?: { abortSignal?: AbortSignal }) => {
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
        const generated = await image(
          { purpose: "image", route: imageRoute(opts.provider) },
          opts.provider,
          prompt,
          size,
          aspectRatio,
          model,
          options?.abortSignal,
        );
        await opts.onImage(generated);
        const modelSuffix = generated.model ? ` (${generated.model})` : "";
        return `Image generated successfully with ${generated.provider}${modelSuffix}: "${prompt}"`;
      } catch (error) {
        if (opts.isHalt?.(error)) throw error;
        return `Failed to generate image: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}
