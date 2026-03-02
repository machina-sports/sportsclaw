/**
 * sportsclaw — Subagent Spawning System
 *
 * Async fire-and-forget background tasks that run independently from the main
 * agent loop. Inspired by nanobot's spawn() primitive but adapted for our
 * TypeScript/Vercel AI SDK architecture.
 *
 * Key differences from parallelAgents:
 *   - parallelAgents: synchronous — all lanes complete before response
 *   - subagents: async — main agent responds immediately, subagent reports later
 *
 * Safety constraints:
 *   - Subagents CANNOT spawn other subagents (prevents infinite loops)
 *   - Subagents CANNOT use messaging tools (no ask_user_question)
 *   - Subagents have a lower turn limit (default: 10)
 *   - Maximum concurrent subagents per user (default: 3)
 *
 * Results are delivered via a configurable callback (onResult). Channel
 * implementations (Discord, Telegram, CLI) register their own handlers
 * to deliver results to the user.
 */

import { generateText, tool as defineTool, jsonSchema, stepCountIs, type ToolSet } from "ai";
import type { sportsclawConfig, LLMProvider } from "./types.js";
import { buildProviderOptions, DEFAULT_TOKEN_BUDGETS } from "./types.js";
import { ToolRegistry, type ToolCallInput } from "./tools.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubagentTask {
  /** Unique identifier for this subagent run */
  id: string;
  /** The research prompt given to the subagent */
  prompt: string;
  /** Optional system prompt override */
  systemPrompt?: string;
  /** Who spawned this subagent */
  userId: string;
  /** Current status */
  status: "running" | "completed" | "failed";
  /** Result text (set on completion) */
  result?: string;
  /** Error message (set on failure) */
  error?: string;
  /** When the task was spawned */
  createdAt: string;
  /** When the task finished */
  completedAt?: string;
}

export interface SubagentResult {
  id: string;
  prompt: string;
  userId: string;
  status: "completed" | "failed";
  result?: string;
  error?: string;
  durationMs: number;
}

export type SubagentResultHandler = (result: SubagentResult) => void;

export interface SubagentManagerOptions {
  /** Maximum concurrent subagents per user (default: 3) */
  maxPerUser?: number;
  /** Maximum agentic turns per subagent (default: 10) */
  maxTurns?: number;
  /** Maximum output tokens per subagent (default: 4096) */
  maxTokens?: number;
  /** Callback invoked when a subagent completes or fails */
  onResult?: SubagentResultHandler;
}

// ---------------------------------------------------------------------------
// Restricted tool list — subagents cannot use these
// ---------------------------------------------------------------------------

const RESTRICTED_TOOLS = new Set([
  "spawn_subagent",        // no recursive spawning
  "ask_user_question",     // no interactive halting
  "update_soul",           // no personality mutation from background
  "evolve_strategy",       // no strategy mutation from background
  "update_agent_config",   // no config changes
  "install_sport",         // no schema changes
  "remove_sport",          // no schema removal
  "upgrade_sports_skills", // no pip upgrades
  "create_task",           // no task creation (use main agent)
  "generate_image",        // no image generation from background
  "generate_video",        // no video generation from background
]);

// ---------------------------------------------------------------------------
// SubagentManager
// ---------------------------------------------------------------------------

export class SubagentManager {
  private activeTasks = new Map<string, SubagentTask>();
  private maxPerUser: number;
  private maxTurns: number;
  private maxTokens: number;
  private onResult?: SubagentResultHandler;

  constructor(options?: SubagentManagerOptions) {
    this.maxPerUser = options?.maxPerUser ?? 3;
    this.maxTurns = options?.maxTurns ?? 10;
    this.maxTokens = options?.maxTokens ?? 4096;
    this.onResult = options?.onResult;
  }

  /** Register or replace the result callback */
  setResultHandler(handler: SubagentResultHandler): void {
    this.onResult = handler;
  }

  /** Get all active (running) tasks for a user */
  getActiveTasks(userId: string): SubagentTask[] {
    return Array.from(this.activeTasks.values()).filter(
      (t) => t.userId === userId && t.status === "running"
    );
  }

  /** Get a task by ID */
  getTask(taskId: string): SubagentTask | undefined {
    return this.activeTasks.get(taskId);
  }

  /** List all tasks (active + recent completed) */
  getAllTasks(): SubagentTask[] {
    return Array.from(this.activeTasks.values());
  }

  /**
   * Spawn a subagent that runs in the background.
   *
   * Returns immediately with the task ID. The subagent runs independently
   * and delivers results via the onResult callback when finished.
   */
  spawn(params: {
    prompt: string;
    systemPrompt?: string;
    userId: string;
    model: ReturnType<typeof import("@ai-sdk/anthropic").anthropic>;
    provider: LLMProvider;
    config: sportsclawConfig;
    registry: ToolRegistry;
    thinkingBudget?: number;
  }): SubagentTask {
    const activeForUser = this.getActiveTasks(params.userId);
    if (activeForUser.length >= this.maxPerUser) {
      throw new Error(
        `Subagent limit reached: ${activeForUser.length}/${this.maxPerUser} running. ` +
          "Wait for existing subagents to complete."
      );
    }

    const id = generateId();
    const task: SubagentTask = {
      id,
      prompt: params.prompt,
      systemPrompt: params.systemPrompt,
      userId: params.userId,
      status: "running",
      createdAt: new Date().toISOString(),
    };

    this.activeTasks.set(id, task);

    // Fire and forget — run in background
    this.executeSubagent(task, params).catch((err) => {
      console.error(
        `[sportsclaw:subagent] Fatal error in ${id}: ${err instanceof Error ? err.message : err}`
      );
    });

    return task;
  }

  /** Clean up completed tasks older than maxAgeMs (default: 1 hour) */
  cleanup(maxAgeMs: number = 60 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, task] of this.activeTasks) {
      if (task.status === "running") continue;
      const completedAt = task.completedAt ? new Date(task.completedAt).getTime() : 0;
      if (now - completedAt > maxAgeMs) {
        this.activeTasks.delete(id);
        cleaned++;
      }
    }
    return cleaned;
  }

  // -------------------------------------------------------------------------
  // Internal execution
  // -------------------------------------------------------------------------

  private async executeSubagent(
    task: SubagentTask,
    params: {
      prompt: string;
      systemPrompt?: string;
      model: unknown;
      provider: LLMProvider;
      config: sportsclawConfig;
      registry: ToolRegistry;
      thinkingBudget?: number;
    }
  ): Promise<void> {
    const startTime = Date.now();

    try {
      // Build restricted tool set
      const tools = this.buildRestrictedTools(params.registry, params.config);

      const systemPrompt = params.systemPrompt || buildSubagentSystemPrompt(task.prompt);
      const providerOpts = buildProviderOptions(
        params.provider,
        params.thinkingBudget ?? 4096
      );

      const result = await generateText({
        model: params.model as Parameters<typeof generateText>[0]["model"],
        system: systemPrompt,
        prompt: task.prompt,
        tools,
        stopWhen: stepCountIs(this.maxTurns),
        maxOutputTokens: this.maxTokens,
        ...(providerOpts ? { providerOptions: providerOpts } : {}),
      });

      const text = result.text?.trim() || "[No response generated]";

      task.status = "completed";
      task.result = text;
      task.completedAt = new Date().toISOString();

      this.deliverResult(task, startTime);
    } catch (err) {
      task.status = "failed";
      task.error = err instanceof Error ? err.message : String(err);
      task.completedAt = new Date().toISOString();

      this.deliverResult(task, startTime);
    }
  }

  private deliverResult(task: SubagentTask, startTime: number): void {
    const result: SubagentResult = {
      id: task.id,
      prompt: task.prompt,
      userId: task.userId,
      status: task.status as "completed" | "failed",
      result: task.result,
      error: task.error,
      durationMs: Date.now() - startTime,
    };

    try {
      this.onResult?.(result);
    } catch (err) {
      console.error(
        `[sportsclaw:subagent] Result handler error for ${task.id}: ` +
          (err instanceof Error ? err.message : err)
      );
    }
  }

  private buildRestrictedTools(
    registry: ToolRegistry,
    config: sportsclawConfig
  ): ToolSet {
    const toolMap: ToolSet = {};

    for (const spec of registry.getAllToolSpecs()) {
      // Skip restricted tools
      if (RESTRICTED_TOOLS.has(spec.name)) continue;

      toolMap[spec.name] = defineTool({
        description: spec.description,
        inputSchema: jsonSchema(spec.input_schema),
        execute: async (args: Record<string, unknown>) => {
          const result = await registry.dispatchToolCall(
            spec.name,
            args as ToolCallInput,
            config as Required<sportsclawConfig>
          );

          if (result.isError) {
            throw new Error(result.content || `Tool "${spec.name}" failed.`);
          }

          // Cap output
          const MAX_CHARS = 30_000;
          if (result.content.length > MAX_CHARS) {
            return result.content.slice(0, MAX_CHARS) +
              "\n\n[... output truncated]";
          }
          return result.content;
        },
      });
    }

    return toolMap;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  return `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildSubagentSystemPrompt(taskPrompt: string): string {
  return [
    "You are a sportsclaw background research subagent.",
    "",
    "Your job is to complete a specific research task using the available tools,",
    "then provide a clear, data-backed summary of your findings.",
    "",
    "Rules:",
    "- Focus solely on the task at hand",
    "- Use tools to gather real data — do not guess or hallucinate",
    "- Be concise and factual in your response",
    "- If a tool fails, note it and work with what you have",
    "- You are running in the background — the user has already been told",
    "  you're working on this, so just deliver the findings",
    "",
    "Deliver your response as a complete, self-contained answer.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Default singleton
// ---------------------------------------------------------------------------

export const subagentManager = new SubagentManager();
