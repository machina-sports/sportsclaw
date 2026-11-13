/**
 * Video, audio and still-image input for one run (RunOptions.media).
 *
 * The AI SDK's OpenAI chat converter has no video part, and it maps audio to
 * OpenAI's `input_audio`. vLLM-served multimodal models (e.g. NVIDIA Nemotron
 * Omni) take `video_url` and `audio_url` parts instead; a still image (a crop of
 * one player, a frame of a broadcast) goes as `image_url`. For the
 * "openai-compatible" provider each attachment therefore travels as a text part
 * holding an unguessable marker, and `mediaFetch` swaps the marker for the
 * real part in the request body. Markers live only for their run; a marker a
 * user types (or one left in an old transcript) matches nothing and stays text.
 */
import { randomUUID } from "node:crypto";
import type { MediaAttachment } from "./types.js";

export const MEDIA_MAX_ATTACHMENTS = 4;
/** Base64 characters across all attachments of one run (about 48 MB decoded). */
export const MEDIA_MAX_BASE64_CHARS = 64 * 1024 * 1024;
const MIME = /^(video|audio|image)\/[a-z0-9.+-]{1,40}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MARKER = /^\[\[sportsclaw-media:([0-9a-f-]{36})\]\]$/;

const pending = new Map<string, MediaAttachment>();

/** The attachments as given, or an error before any model work. */
export function validateMedia(value: unknown): MediaAttachment[] {
  if (!Array.isArray(value) || value.length > MEDIA_MAX_ATTACHMENTS) {
    throw new Error(`media must be an array of at most ${MEDIA_MAX_ATTACHMENTS} attachments`);
  }
  let total = 0;
  return value.map((item) => {
    const keys = item && typeof item === "object" ? Object.keys(item).sort().join(",") : "";
    if (keys !== "data,kind,mimeType") throw new Error("each media attachment must have exactly kind, data and mimeType");
    const { kind, data, mimeType } = item as MediaAttachment;
    if (kind !== "video" && kind !== "audio" && kind !== "image") throw new Error(`invalid media kind: ${String(kind)}`);
    if (typeof mimeType !== "string" || !MIME.test(mimeType) || !mimeType.startsWith(`${kind}/`)) {
      throw new Error(`invalid ${kind} mimeType: ${String(mimeType).slice(0, 60)}`);
    }
    if (typeof data !== "string" || !data || !BASE64.test(data)) throw new Error(`${kind} data must be base64`);
    total += data.length;
    if (total > MEDIA_MAX_BASE64_CHARS) throw new Error("media exceeds the size limit");
    return { kind, data, mimeType };
  });
}

/** Holds the attachment for this run and returns the marker text that stands for it. */
export function registerMedia(media: MediaAttachment): string {
  const id = randomUUID();
  pending.set(id, media);
  return `[[sportsclaw-media:${id}]]`;
}

/** Forgets the attachments behind these markers. */
export function releaseMedia(markers: readonly string[]): void {
  for (const marker of markers) {
    const id = MARKER.exec(marker)?.[1];
    if (id) pending.delete(id);
  }
}

/** The vLLM content part for a marker this process registered, or undefined. */
export function mediaPartFor(text: unknown): Record<string, unknown> | undefined {
  if (typeof text !== "string") return undefined;
  const id = MARKER.exec(text)?.[1];
  const media = id ? pending.get(id) : undefined;
  if (!media) return undefined;
  const url = `data:${media.mimeType};base64,${media.data}`;
  if (media.kind === "video") return { type: "video_url", video_url: { url } };
  if (media.kind === "image") return { type: "image_url", image_url: { url } };
  return { type: "audio_url", audio_url: { url } };
}

/** Rewrites marker text parts in an OpenAI-style chat request into vLLM media parts. */
export function mediaFetch(base?: typeof fetch): typeof fetch {
  return async (input, init) => {
    if (init?.body && typeof init.body === "string" && init.body.includes("[[sportsclaw-media:")) {
      try {
        const parsed = JSON.parse(init.body) as { messages?: Array<{ content?: unknown }> };
        let changed = false;
        for (const message of parsed.messages ?? []) {
          if (!Array.isArray(message.content)) continue;
          message.content = message.content.map((part: { type?: string; text?: unknown }) => {
            const media = part?.type === "text" ? mediaPartFor(part.text) : undefined;
            if (media) changed = true;
            return media ?? part;
          });
        }
        if (changed) init = { ...init, body: JSON.stringify(parsed) };
      } catch {
        // Not JSON: leave the request alone.
      }
    }
    return (base ?? fetch)(input, init);
  };
}
