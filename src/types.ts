/**
 * sportsclaw Engine — Type Definitions
 *
 * Shared types for the agent execution loop, tool bridge, and configuration.
 */

import type { ModelMessage } from "ai";

// ---------------------------------------------------------------------------
// Supported LLM providers
// ---------------------------------------------------------------------------

export type LLMProvider = "anthropic" | "openai" | "google";

export const DEFAULT_MODELS: Record<LLMProvider, string> = {
  anthropic: "claude-sonnet-4-5-20250514",
  openai: "gpt-5.3-codex",
  google: "gemini-3-flash-preview",
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface sportsclawConfig {
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
  /** Timeout in ms for Python subprocess calls (default: 60000) */
  timeout?: number;
  /** Extra environment variables passed to child processes */
  env?: Record<string, string>;
  /** Enable verbose logging (default: false) */
  verbose?: boolean;
}

export const DEFAULT_CONFIG: Required<sportsclawConfig> = {
  provider: "anthropic",
  model: "claude-sonnet-4-5-20250514",
  maxTurns: 25,
  maxTokens: 16_384,
  systemPrompt: "",
  pythonPath: "python3",
  timeout: 60_000,
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

/** A single tool definition within a sport schema (Vercel AI SDK compatible) */
export interface SportToolDef {
  name: string;
  description: string;
  command: string;
  /** Vercel-compatible JSON Schema parameters (output by sports-skills v0.8+) */
  parameters: Record<string, unknown>;
  /** @deprecated Legacy field from sports-skills v0.7 — use `parameters` */
  input_schema?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Memory options passed to engine.run()
// ---------------------------------------------------------------------------

export type ToolProgressEvent =
  | { type: "tool_start"; toolName: string; toolCallId: string; skillName?: string }
  | { type: "tool_finish"; toolName: string; toolCallId: string; durationMs: number; success: boolean; skillName?: string }
  | { type: "synthesizing" };

export interface RunOptions {
  /** User or thread ID for memory isolation. If omitted, memory is disabled. */
  userId?: string;
  /** Structured progress callback for tool execution tracking. */
  onProgress?: (event: ToolProgressEvent) => void;
  /** Abort signal for cancelling an in-flight run. */
  abortSignal?: AbortSignal;
  /** @deprecated Use onProgress instead */
  onSpinnerUpdate?: (msg: string) => void;
}
