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
  selectableModels: ProviderModelOption[];
}

export const PROVIDER_MODEL_PROFILES: Record<LLMProvider, ProviderModelProfile> = {
  anthropic: {
    defaultModel: "claude-opus-4-6",
    selectableModels: [
      {
        value: "claude-opus-4-6",
        label: "Claude Opus 4.6",
        hint: "recommended",
      },
      {
        value: "claude-sonnet-4-5-20250514",
        label: "Claude Sonnet 4.5",
        hint: "faster, cheaper",
      },
    ],
  },
  openai: {
    defaultModel: "gpt-5.3-codex",
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
  /** Tool routing mode (default: soft_lock) */
  routingMode?: "soft_lock";
  /** Max sport skills to activate for ambiguous prompts (default: 2) */
  routingMaxSkills?: number;
  /** Additional spillover skills allowed in focused routing (default: 1) */
  routingAllowSpillover?: number;
  /** Enable TTL-based tool result caching (default: true) */
  cacheEnabled?: boolean;
  /** Cache time-to-live in milliseconds (default: 300000 = 5 minutes) */
  cacheTtlMs?: number;
  /** Ask for clarification when confidence is low (default: true) */
  clarifyOnLowConfidence?: boolean;
  /** Confidence threshold for clarification (default: 0.5) */
  clarifyThreshold?: number;
  /** Skip fan profile updates and related instructions (e.g. button follow-ups) */
  skipFanProfile?: boolean;
  /** Allow trading tools (Polymarket orders, balance, etc.). Only enable for CLI. Default: false */
  allowTrading?: boolean;
}

export const DEFAULT_CONFIG: Required<sportsclawConfig> = {
  provider: "anthropic",
  model: DEFAULT_MODELS.anthropic,
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
  cacheEnabled: true,
  cacheTtlMs: 300_000,
  clarifyOnLowConfidence: true,
  clarifyThreshold: 0.5,
  skipFanProfile: false,
  allowTrading: false,
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

/** An image attached to a user message (inbound vision). */
export interface ImageAttachment {
  /** Base64-encoded image data (without data URI prefix) */
  data: string;
  /** MIME type of the image (e.g., "image/png", "image/jpeg", "image/webp") */
  mimeType: string;
  /** Optional filename for display purposes */
  filename?: string;
}

/** An image produced by the generate_image tool (outbound). */
export interface GeneratedImage {
  /** Base64-encoded image data */
  data: string;
  /** MIME type of the generated image */
  mimeType: string;
  /** The prompt used to generate the image */
  prompt: string;
  /** The provider that generated the image */
  provider: "openai" | "google";
}

/** A video produced by the generate_video tool (outbound). */
export interface GeneratedVideo {
  /** Base64-encoded video data */
  data: string;
  /** MIME type of the generated video */
  mimeType: string;
  /** The prompt used to generate the video */
  prompt: string;
  /** The provider that generated the video */
  provider: "openai" | "google";
}

export type ToolProgressEvent =
  | { type: "phase"; label: string }
  | { type: "tool_start"; toolName: string; toolCallId: string; skillName?: string }
  | { type: "tool_finish"; toolName: string; toolCallId: string; durationMs: number; success: boolean; skillName?: string }
  | { type: "synthesizing" };

export interface RunOptions {
  /** User or thread ID for memory isolation. If omitted, memory is disabled. */
  userId?: string;
  /**
   * Session ID for multi-turn conversation continuity.
   * When provided, the engine loads prior message history from the global
   * SessionStore, appends the new turn, and saves back after execution.
   * Format convention: `<platform>-<userId>` (e.g. "discord-123456").
   */
  sessionId?: string;
  /** Structured progress callback for tool execution tracking. */
  onProgress?: (event: ToolProgressEvent) => void;
  /** Abort signal for cancelling an in-flight run. */
  abortSignal?: AbortSignal;
  /** Image attachments from the user (vision input). */
  images?: ImageAttachment[];
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
  modelUsed: string | null;
  llmAttempted: boolean;
  llmSucceeded: boolean;
  llmDurationMs: number;
}

export interface RouteOutcome {
  decision: RouteDecision;
  meta: RouteMeta;
}

// ---------------------------------------------------------------------------
// AskUserQuestion — interactive halting (Sprint 2)
// ---------------------------------------------------------------------------

export interface AskUserOption {
  label: string;
  value: string;
}

export interface AskUserQuestionRequest {
  prompt: string;
  options: AskUserOption[];
  contextKey: string;
}

/** Persisted state when the engine suspends waiting for user input */
export interface SuspendedState {
  /** Platform identifier: "discord" | "telegram" | "cli" */
  platform: string;
  /** Platform-specific user ID */
  userId: string;
  /** The question posed to the user */
  question: AskUserQuestionRequest;
  /** ISO timestamp when the state was saved */
  createdAt: string;
  /** The original user prompt that led to this question */
  originalPrompt: string;
}

// ---------------------------------------------------------------------------
// Async Watcher Bus — condition-action triggers (Sprint 2)
// ---------------------------------------------------------------------------

export interface WatcherTask {
  id: string;
  /** Human-readable condition to check (e.g., "LeBron PTS >= 30") */
  condition: string;
  /** Action to take when condition is met (e.g., "Notify User") */
  action: string;
  /** Extra context for the watcher (game_id, player_id, etc.) */
  context: Record<string, unknown>;
  /** Platform + user ID for notification delivery */
  userId: string;
  /** "active" | "completed" | "expired" */
  status: "active" | "completed" | "expired";
  /** ISO timestamp when the task was created */
  createdAt: string;
  /** ISO timestamp when the task was completed (if applicable) */
  completedAt?: string;
}
