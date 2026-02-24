/**
 * SportsClaw Engine — Core Agent Execution Loop
 *
 * A lightweight agentic loop that:
 *   1. Sends user messages + tool definitions to the LLM
 *   2. Lets the Vercel AI SDK handle tool execution automatically
 *   3. Routes tool calls through the Python subprocess bridge
 *   4. Supports Anthropic, OpenAI, and Google Gemini via a single interface
 *
 * No heavy frameworks. No LangChain. No CrewAI. Just a clean loop.
 */

import {
  generateText,
  tool as defineTool,
  jsonSchema,
  stepCountIs,
  type ToolSet,
} from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";

import {
  DEFAULT_CONFIG,
  DEFAULT_MODELS,
  type LLMProvider,
  type SportsClawConfig,
  type Message,
} from "./types.js";
import { ToolRegistry, type ToolCallInput } from "./tools.js";
import { loadAllSchemas } from "./schema.js";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const BASE_SYSTEM_PROMPT = `You are SportsClaw, a high-performance sports AI agent built by Machina Sports.

Your core directives:
1. ACCURACY FIRST — Never guess or hallucinate scores, stats, or odds. If the tool returns data, report it exactly. If a tool call fails, say so honestly.
2. USE TOOLS — When the user asks about live scores, standings, schedules, odds, or any sports data, ALWAYS use the available tools. Do not make up data from training knowledge when live data is available.
3. BE CONCISE — Sports fans want quick, clear answers. Lead with the data, add context after.
4. CITE THE SOURCE — When reporting data from a tool call, mention it came from live data.`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Filter out undefined values so they don't override defaults during merge */
function filterDefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

/** Create a Vercel AI SDK model instance for the given provider + model ID */
function resolveModel(provider: LLMProvider, modelId: string) {
  switch (provider) {
    case "anthropic":
      return anthropic(modelId);
    case "openai":
      return openai(modelId);
    case "google":
      return google(modelId);
    default:
      throw new Error(
        `Unsupported provider: "${provider}". Use "anthropic", "openai", or "google".`
      );
  }
}

// ---------------------------------------------------------------------------
// Engine class
// ---------------------------------------------------------------------------

export class SportsClawEngine {
  private model: ReturnType<typeof resolveModel>;
  private config: Required<SportsClawConfig>;
  private messages: Message[] = [];
  private registry: ToolRegistry;

  constructor(config?: Partial<SportsClawConfig>) {
    const merged = { ...DEFAULT_CONFIG, ...filterDefined(config ?? {}) };

    // If provider changed but model was not explicitly set, use the provider's default
    if (config?.provider && !config?.model) {
      merged.model = DEFAULT_MODELS[merged.provider] ?? DEFAULT_CONFIG.model;
    }

    this.config = merged;
    this.model = resolveModel(this.config.provider, this.config.model);
    this.registry = new ToolRegistry();
    this.loadDynamicSchemas();
  }

  /**
   * Load all saved sport schemas from disk and inject them into this engine's
   * tool registry so the LLM can call sport-specific tools directly.
   */
  private loadDynamicSchemas(): void {
    const schemas = loadAllSchemas();
    for (const schema of schemas) {
      this.registry.injectSchema(schema);
      if (this.config.verbose) {
        console.error(
          `[sportsclaw] loaded schema: ${schema.sport} (${schema.tools.length} tools)`
        );
      }
    }
  }

  /** Full system prompt (base + dynamic tool info + user-supplied) */
  private get systemPrompt(): string {
    const parts = [BASE_SYSTEM_PROMPT];

    // List available tools for the LLM
    const allSpecs = this.registry.getAllToolSpecs();
    const toolNames = allSpecs.map((s) => s.name);
    if (toolNames.length > 1) {
      parts.push(
        "",
        `Available tools: ${toolNames.join(", ")}`,
        "Use the most specific tool available for each query."
      );
    }

    if (this.config.systemPrompt) {
      parts.push("", this.config.systemPrompt);
    }

    return parts.join("\n");
  }

  /** Build the Vercel AI SDK tool map from our registry */
  private buildTools(): ToolSet {
    const toolMap: ToolSet = {};
    const config = this.config;
    const registry = this.registry;
    const verbose = this.config.verbose;

    for (const spec of registry.getAllToolSpecs()) {
      toolMap[spec.name] = defineTool({
        description: spec.description,
        inputSchema: jsonSchema(spec.input_schema),
        execute: async (args: Record<string, unknown>) => {
          if (verbose) {
            console.error(
              `[sportsclaw] tool_call: ${spec.name}(${JSON.stringify(args)})`
            );
          }

          const result = await registry.dispatchToolCall(
            spec.name,
            args as ToolCallInput,
            config
          );

          if (verbose) {
            const preview =
              result.content.length > 200
                ? result.content.slice(0, 200) + "..."
                : result.content;
            console.error(`[sportsclaw] tool_result: ${preview}`);
          }

          return result.content;
        },
      });
    }

    return toolMap;
  }

  /** Reset conversation history */
  reset(): void {
    this.messages = [];
  }

  /** Get current conversation history (read-only copy) */
  get history(): readonly Message[] {
    return [...this.messages];
  }

  /**
   * Run the full agent loop for a user prompt.
   *
   * Sends the prompt to the LLM, executes any tool calls, and continues
   * until the model produces a final text response or maxSteps is hit.
   *
   * Returns the final assistant text.
   */
  async run(userPrompt: string): Promise<string> {
    this.messages.push({ role: "user", content: userPrompt });

    let stepCount = 0;

    const result = await generateText({
      model: this.model,
      system: this.systemPrompt,
      messages: this.messages,
      tools: this.buildTools(),
      stopWhen: stepCountIs(this.config.maxTurns),
      maxOutputTokens: this.config.maxTokens,
      onStepFinish: ({ toolCalls }) => {
        stepCount++;
        if (this.config.verbose) {
          console.error(
            `[sportsclaw] --- step ${stepCount} --- (${toolCalls.length} tool call(s))`
          );
        }
      },
    });

    // Append the full response messages to our history for multi-turn support
    for (const msg of result.response.messages) {
      this.messages.push(msg as Message);
    }

    if (this.config.verbose) {
      console.error(`[sportsclaw] done after ${stepCount} step(s)`);
    }

    if (stepCount >= this.config.maxTurns && !result.text) {
      console.error(
        `[sportsclaw] max turns (${this.config.maxTurns}) reached, returning partial result`
      );
      return "[SportsClaw] Max turns reached without a final response.";
    }

    return result.text || "[SportsClaw] No response generated.";
  }

  /**
   * Convenience: run a prompt and print the result to stdout.
   */
  async runAndPrint(userPrompt: string): Promise<void> {
    const result = await this.run(userPrompt);
    console.log(result);
  }
}
