/**
 * SportsClaw Engine — Core Agent Execution Loop
 *
 * A lightweight (~500 line total) agentic loop that:
 *   1. Sends user messages + tool definitions to Claude
 *   2. Intercepts tool_use blocks from the response
 *   3. Executes them via the Python subprocess bridge
 *   4. Feeds tool_result blocks back to Claude
 *   5. Repeats until the model emits end_turn or max turns is reached
 *
 * No heavy frameworks. No LangChain. No CrewAI. Just a clean loop.
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  DEFAULT_CONFIG,
  type SportsClawConfig,
  type Message,
  type ToolUseBlock,
  type ToolResultBlockParam,
  type TurnResult,
} from "./types.js";
import {
  getAllToolSpecs,
  injectSchema,
  clearDynamicTools,
  dispatchToolCall,
  type ToolCallInput,
} from "./tools.js";
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

// ---------------------------------------------------------------------------
// Engine class
// ---------------------------------------------------------------------------

export class SportsClawEngine {
  private client: Anthropic;
  private config: Required<SportsClawConfig>;
  private messages: Message[] = [];

  constructor(config?: Partial<SportsClawConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...filterDefined(config ?? {}) };
    this.client = new Anthropic();
    this.loadDynamicSchemas();
  }

  /**
   * Load all saved sport schemas from disk and inject them into the tool
   * registry so the LLM can call sport-specific tools directly.
   */
  private loadDynamicSchemas(): void {
    clearDynamicTools();
    const schemas = loadAllSchemas();
    for (const schema of schemas) {
      injectSchema(schema);
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
    const allSpecs = getAllToolSpecs();
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

  /** Anthropic tool definitions in the format the API expects */
  private get tools(): Anthropic.Tool[] {
    return getAllToolSpecs().map((spec) => ({
      name: spec.name,
      description: spec.description,
      input_schema: spec.input_schema,
    }));
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
   * Run a single API call → tool execution → result cycle.
   * Returns whether the agent is done and any text produced.
   */
  private async executeTurn(): Promise<TurnResult> {
    const response = await this.client.messages.create({
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      system: this.systemPrompt,
      tools: this.tools,
      messages: this.messages,
    });

    // Collect text and tool_use blocks from the response
    let text = "";
    const toolUseBlocks: ToolUseBlock[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool_use") {
        toolUseBlocks.push(block);
      }
    }

    // Append assistant message to history
    this.messages.push({ role: "assistant", content: response.content });

    // If no tool calls, we're done
    if (toolUseBlocks.length === 0) {
      return { done: true, text, toolCalls: 0 };
    }

    // Execute each tool call and collect results
    const toolResults: ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      if (this.config.verbose) {
        console.error(
          `[sportsclaw] tool_call: ${toolUse.name}(${JSON.stringify(toolUse.input)})`
        );
      }

      const result = await dispatchToolCall(
        toolUse.name,
        toolUse.input as ToolCallInput,
        this.config
      );

      if (this.config.verbose) {
        const preview =
          result.content.length > 200
            ? result.content.slice(0, 200) + "..."
            : result.content;
        console.error(`[sportsclaw] tool_result: ${preview}`);
      }

      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result.content,
        ...(result.isError && { is_error: true }),
      });
    }

    // Append tool results as a user message
    this.messages.push({ role: "user", content: toolResults });

    // Always continue after tool execution so the model can process results
    return { done: false, text, toolCalls: toolUseBlocks.length };
  }

  /**
   * Run the full agent loop for a user prompt.
   *
   * Sends the prompt to the LLM, executes any tool calls, and continues
   * until the model produces a final text response or maxTurns is hit.
   *
   * Returns the final assistant text.
   */
  async run(userPrompt: string): Promise<string> {
    this.messages.push({ role: "user", content: userPrompt });

    let totalText = "";
    let turns = 0;

    while (turns < this.config.maxTurns) {
      turns++;

      if (this.config.verbose) {
        console.error(`[sportsclaw] --- turn ${turns} ---`);
      }

      const result = await this.executeTurn();
      totalText += result.text;

      if (result.done) {
        if (this.config.verbose) {
          console.error(
            `[sportsclaw] done after ${turns} turn(s), ${result.toolCalls} tool call(s) this turn`
          );
        }
        return totalText;
      }
    }

    // Max turns reached — return what we have
    console.error(
      `[sportsclaw] max turns (${this.config.maxTurns}) reached, returning partial result`
    );
    return totalText || "[SportsClaw] Max turns reached without a final response.";
  }

  /**
   * Convenience: run a prompt and print the result to stdout.
   */
  async runAndPrint(userPrompt: string): Promise<void> {
    const result = await this.run(userPrompt);
    console.log(result);
  }
}
