/**
 * sportsclaw — AskUserQuestion (Sprint 2: Interactive Halting)
 *
 * When the agent's confidence is low, it calls `ask_user_question` to present
 * the user with a set of options. The engine suspends execution and persists
 * state to disk. Platform listeners render the options as native UI (Discord
 * buttons / Telegram inline keyboards). When the user taps an option, the
 * listener resumes the engine with the selected value.
 *
 * Backed by the unified DurableStateStore substrate.
 */

import { DurableStateStore } from "./durability.js";
import type { SuspendedState, AskUserQuestionRequest } from "./types.js";

// ---------------------------------------------------------------------------
// Save / Load / Clear suspended state
// ---------------------------------------------------------------------------

/**
 * Persist the engine's suspended state to disk so the listener can
 * resume execution when the user responds.
 *
 * @param stateKey Unique key for this question instance (used in filename
 *   to prevent concurrent questions from overwriting each other).
 */
export async function saveSuspendedState(
  state: SuspendedState,
  stateKey?: string
): Promise<void> {
  const store = DurableStateStore.getInstance();
  const subPath = `${state.platform}-${state.userId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const filename = stateKey ? `state_${stateKey}` : "state";
  await store.save<SuspendedState>("memory", filename, state, { subPath });
}

/**
 * Load a suspended state for a given platform + user, or null if none exists.
 */
export async function loadSuspendedState(
  platform: string,
  userId: string,
  contextKey?: string
): Promise<SuspendedState | null> {
  const store = DurableStateStore.getInstance();
  const subPath = `${platform}-${userId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const filename = contextKey ? `state_${contextKey}` : "state";
  return store.load<SuspendedState>("memory", filename, { subPath });
}

/**
 * Clear (delete) a suspended state after the user has responded.
 */
export async function clearSuspendedState(
  platform: string,
  userId: string,
  contextKey?: string
): Promise<void> {
  const store = DurableStateStore.getInstance();
  const subPath = `${platform}-${userId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const filename = contextKey ? `state_${contextKey}` : "state";
  await store.delete("memory", filename, { subPath });
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
