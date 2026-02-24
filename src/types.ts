/**
 * SportsClaw Engine — Type Definitions
 *
 * Shared types for the agent execution loop, tool bridge, and configuration.
 */

import type Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SportsClawConfig {
  /** Anthropic model to use (default: claude-sonnet-4-20250514) */
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
  input_schema: Anthropic.Tool["input_schema"];
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

export type Message = Anthropic.MessageParam;
export type ContentBlock = Anthropic.ContentBlock;
export type ToolUseBlock = Anthropic.ToolUseBlock;
export type ToolResultBlockParam = Anthropic.ToolResultBlockParam;

export interface TurnResult {
  /** Whether the agent has finished (no more tool calls pending) */
  done: boolean;
  /** The assistant text produced this turn */
  text: string;
  /** Number of tool calls executed this turn */
  toolCalls: number;
}
