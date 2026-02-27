/**
 * sportsclaw — AskUserQuestion (Sprint 2: Interactive Halting)
 *
 * When the agent's confidence is low, it calls `ask_user_question` to present
 * the user with a set of options. The engine suspends execution and persists
 * state to disk. Platform listeners render the options as native UI (Discord
 * buttons / Telegram inline keyboards). When the user taps an option, the
 * listener resumes the engine with the selected value.
 *
 * State file: ~/.sportsclaw/memory/<platform>-<user_id>/state.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SuspendedState, AskUserQuestionRequest } from "./types.js";

// ---------------------------------------------------------------------------
// State directory
// ---------------------------------------------------------------------------

function getMemoryDir(platform: string, userId: string): string {
  const sanitizedId = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = join(homedir(), ".sportsclaw", "memory", `${platform}-${sanitizedId}`);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getStatePath(platform: string, userId: string): string {
  return join(getMemoryDir(platform, userId), "state.json");
}

// ---------------------------------------------------------------------------
// Save / Load / Clear suspended state
// ---------------------------------------------------------------------------

/**
 * Persist the engine's suspended state to disk so the listener can
 * resume execution when the user responds.
 */
export function saveSuspendedState(state: SuspendedState): void {
  const path = getStatePath(state.platform, state.userId);
  writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Load a suspended state for a given platform + user, or null if none exists.
 */
export function loadSuspendedState(
  platform: string,
  userId: string
): SuspendedState | null {
  const path = getStatePath(platform, userId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as SuspendedState;
  } catch {
    return null;
  }
}

/**
 * Clear (delete) a suspended state after the user has responded.
 */
export function clearSuspendedState(platform: string, userId: string): void {
  const path = getStatePath(platform, userId);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // Best effort — non-critical
    }
  }
}

// ---------------------------------------------------------------------------
// Sentinel error class — used to signal that the engine should suspend
// ---------------------------------------------------------------------------

/**
 * Thrown by the ask_user_question tool to halt the engine loop.
 * The listener catches this, persists state, and renders options.
 */
export class AskUserQuestionHalt extends Error {
  public readonly question: AskUserQuestionRequest;

  constructor(question: AskUserQuestionRequest) {
    super(`[AskUserQuestion] ${question.prompt}`);
    this.name = "AskUserQuestionHalt";
    this.question = question;
  }
}
