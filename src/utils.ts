/**
 * sportsclaw — Shared Utilities
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Split a message into chunks that fit a platform's character limit.
 * Tries to split at newlines for clean breaks, falls back to hard breaks.
 */
export function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline within the limit
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < 1) splitIdx = maxLen;

    chunks.push(remaining.slice(0, splitIdx));
    const next = remaining.slice(splitIdx).trimStart();

    // Guard: if no progress was made, force a hard break to prevent infinite loop
    if (next.length >= remaining.length) {
      chunks.push(remaining.slice(maxLen));
      break;
    }
    remaining = next;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Media persistence — save generated images/videos to ~/.sportsclaw/media/
// ---------------------------------------------------------------------------

/** Resolve the media directory for a given type (images or videos). */
export function getMediaDir(type: "images" | "videos"): string {
  return join(homedir(), ".sportsclaw", "media", type);
}

/** Save a base64-encoded image to disk. Returns the file path. */
export async function saveImageToDisk(
  data: string,
  mimeType: string
): Promise<string> {
  const dir = getMediaDir("images");
  await mkdir(dir, { recursive: true });
  const ext = mimeType === "image/jpeg" ? "jpg" : "png";
  const filePath = join(dir, `generated_${Date.now()}.${ext}`);
  await writeFile(filePath, Buffer.from(data, "base64"));
  return filePath;
}

/** Save a base64-encoded video to disk. Returns the file path. */
export async function saveVideoToDisk(data: string): Promise<string> {
  const dir = getMediaDir("videos");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `generated_${Date.now()}.mp4`);
  await writeFile(filePath, Buffer.from(data, "base64"));
  return filePath;
}
