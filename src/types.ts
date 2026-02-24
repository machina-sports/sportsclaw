/**
 * SportsClaw Engine — Type Definitions
 *
 * Shared types for the agent execution loop, tool bridge, and configuration.
 */

import type { ModelMessage } from "ai";

// ---------------------------------------------------------------------------
// Supported LLM providers
// ---------------------------------------------------------------------------

export type LLMProvider = "anthropic" | "openai" | "google";

export const DEFAULT_MODELS: Record<LLMProvider, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
  google: "gemini-2.5-pro",
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SportsClawConfig {
  /** LLM provider to use (default: anthropic) */
  provider?: LLMProvider;
  /** Model ID for the chosen provider (default: depends on provider) */
  model?: string;
  /** Maximum agentic turns before the loop halts (default: 25) */
  maxTurns?: number;
  /** Maximum tokens for model responses (default: 4096) */
  maxTokens?: number;
  /** System prompt prepended to every conversation */
  systemPrompt?: string;
  /** Path to the Python interpreter (default: python3) */
  pythonPath?: string;
  /** Timeout in ms for Python subprocess calls (default: 30000) */
  timeout?: number;
  /** Extra environment variables passed to child processes */
  env?: Record<string, string>;
  /** Enable verbose logging (default: false) */
  verbose?: boolean;
}

export const DEFAULT_CONFIG: Required<SportsClawConfig> = {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  maxTurns: 25,
  maxTokens: 4096,
  systemPrompt: "",
  pythonPath: "python3",
  timeout: 30_000,
  env: {},
  verbose: false,
};

// ---------------------------------------------------------------------------
// Tool definitions exposed to the LLM
// ---------------------------------------------------------------------------

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Python bridge types
// ---------------------------------------------------------------------------

export interface PythonBridgeResult {
  success: boolean;
  data?: unknown;
  error?: string;
  stdout?: string;
  stderr?: string;
}

// ---------------------------------------------------------------------------
// Conversation / Turn types
// ---------------------------------------------------------------------------

export type Message = ModelMessage;

export interface TurnResult {
  /** Whether the agent has finished (no more tool calls pending) */
  done: boolean;
  /** The assistant text produced this turn */
  text: string;
  /** Number of tool calls executed this turn */
  toolCalls: number;
}

// ---------------------------------------------------------------------------
// Schema injection types (Phase 3)
// ---------------------------------------------------------------------------

/** Schema returned by `python3 -m sports_skills <sport> schema` */
export interface SportSchema {
  sport: string;
  version?: string;
  tools: SportToolDef[];
}

/** A single tool definition within a sport schema */
export interface SportToolDef {
  name: string;
  description: string;
  command: string;
  input_schema: Record<string, unknown>;
}
