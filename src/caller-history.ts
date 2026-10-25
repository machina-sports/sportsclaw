/**
 * Caller-owned conversation history (history_mode caller) and session ids.
 *
 * One validator for the CLI and engine trust boundaries; the relay applies
 * the same rules in Python (docker/relay/relay_server.py). Lengths count code
 * points so they match Python's len().
 */

import type { CallerHistoryEntry } from "./types.js";

export const CALLER_HISTORY_MAX_ENTRIES = 40;
export const CALLER_HISTORY_MAX_CHARS = 12_000;
export const SESSION_ID_MAX_CHARS = 128;

const codePoints = (value: string): number => [...value].length;

/** Returns the history unchanged when valid; throws otherwise. */
export function validateCallerHistory(value: unknown): CallerHistoryEntry[] {
  if (!Array.isArray(value) || value.length > CALLER_HISTORY_MAX_ENTRIES) {
    throw new Error(`history must be an array of at most ${CALLER_HISTORY_MAX_ENTRIES} entries`);
  }
  let total = 0;
  for (const entry of value) {
    if (
      !entry || typeof entry !== "object" || Array.isArray(entry) ||
      Object.keys(entry).length !== 2 ||
      ((entry as CallerHistoryEntry).role !== "user" && (entry as CallerHistoryEntry).role !== "assistant") ||
      typeof (entry as CallerHistoryEntry).content !== "string" ||
      !(entry as CallerHistoryEntry).content.trim()
    ) {
      throw new Error("history entries must be exactly {role: user|assistant, content: nonempty string}");
    }
    total += codePoints((entry as CallerHistoryEntry).content);
  }
  if (total > CALLER_HISTORY_MAX_CHARS) {
    throw new Error(`history content must total at most ${CALLER_HISTORY_MAX_CHARS} characters`);
  }
  return value as CallerHistoryEntry[];
}

/** Opaque caller session id: 1-128 characters, no control characters, no padding, not flag-like. */
export function validateSessionId(value: unknown): string {
  if (
    typeof value !== "string" || !value || codePoints(value) > SESSION_ID_MAX_CHARS ||
    value !== value.trim() || value.startsWith("-") || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`session id must be 1-${SESSION_ID_MAX_CHARS} printable characters`);
  }
  return value;
}
