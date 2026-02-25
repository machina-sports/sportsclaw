/**
 * sportsclaw — Shared Utilities
 */

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
