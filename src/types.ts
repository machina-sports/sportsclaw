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

export interface ProviderModelOption {
  value: string;
  label: string;
  hint?: string;
}

export interface ProviderModelProfile {
  defaultModel: string;
  fastRouterModel: string;
  selectableModels: ProviderModelOption[];
}

export const PROVIDER_MODEL_PROFILES: Record<LLMProvider, ProviderModelProfile> = {
  anthropic: {
    defaultModel: "claude-sonnet-4-5-20250514",
    fastRouterModel: "claude-sonnet-4-5-20250514",
    selectableModels: [
      {
        value: "claude-sonnet-4-5-20250514",
        label: "Claude Sonnet 4.5",
        hint: "recommended",
      },
      {
        value: "claude-opus-4-6",
        label: "Claude Opus 4.6",
        hint: "most capable",
      },
    ],
  },
  openai: {
    defaultModel: "gpt-5.3-codex",
    fastRouterModel: "gpt-5.3-codex",
    selectableModels: [
      {
        value: "gpt-5.3-codex",
        label: "GPT-5.3 Codex",
        hint: "recommended",
      },
    ],
  },
  google: {
    defaultModel: "gemini-3-flash-preview",
    fastRouterModel: "gemini-3-flash-preview",
    selectableModels: [
      {
        value: "gemini-3-flash-preview",
        label: "Gemini 3 Flash",
        hint: "recommended",
      },
      {
        value: "gemini-3-pro-preview",
        label: "Gemini 3 Pro",
        hint: "advanced reasoning",
      },
      {
        value: "gemini-3.1-pro-preview",
        label: "Gemini 3.1 Pro",
        hint: "most capable",
      },
    ],
  },
};

export const DEFAULT_MODELS: Record<LLMProvider, string> = {
  anthropic: PROVIDER_MODEL_PROFILES.anthropic.defaultModel,
  openai: PROVIDER_MODEL_PROFILES.openai.defaultModel,
  google: PROVIDER_MODEL_PROFILES.google.defaultModel,
};

export const DEFAULT_ROUTER_MODELS: Record<LLMProvider, string> = {
  anthropic: PROVIDER_MODEL_PROFILES.anthropic.fastRouterModel,
  openai: PROVIDER_MODEL_PROFILES.openai.fastRouterModel,
  google: PROVIDER_MODEL_PROFILES.google.fastRouterModel,
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface sportsclawConfig {
  /** LLM provider to use (default: anthropic) */
  provider?: LLMProvider;
  /** Model ID for the chosen provider (default: depends on provider) */
  model?: string;
  /** Router model strategy (default: provider_fast) */
  routerModelStrategy?: "provider_fast" | "same_as_main";
  /** Explicit router model override (default: provider fast model) */
  routerModel?: string;
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
  /** Tool routing mode (default: soft_lock) */
  routingMode?: "soft_lock";
  /** Max sport skills to activate for ambiguous prompts (default: 2) */
  routingMaxSkills?: number;
  /** Additional spillover skills allowed in focused routing (default: 1) */
  routingAllowSpillover?: number;
}

export const DEFAULT_CONFIG: Required<sportsclawConfig> = {
  provider: "anthropic",
  model: DEFAULT_MODELS.anthropic,
  routerModelStrategy: "provider_fast",
  routerModel: DEFAULT_ROUTER_MODELS.anthropic,
  maxTurns: 25,
  maxTokens: 16_384,
  systemPrompt: "",
  pythonPath: "python3",
  timeout: 60_000,
  env: {},
  verbose: false,
  routingMode: "soft_lock",
  routingMaxSkills: 2,
  routingAllowSpillover: 1,
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

export interface RouteDecision {
  selectedSkills: string[];
  mode: "focused" | "ambiguous";
  confidence: number;
  reason: string;
}

export interface RouteMeta {
  primaryModelId: string;
  modelUsed: string | null;
  fallbackUsed: boolean;
  llmAttempted: boolean;
  llmSucceeded: boolean;
  llmDurationMs: number;
}

export interface RouteOutcome {
  decision: RouteDecision;
  meta: RouteMeta;
}
