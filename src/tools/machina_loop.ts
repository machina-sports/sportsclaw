/**
 * sportsclaw built-in tool: `machina_loop`
 *
 * Delegates a long-running, multi-turn task to the Machina **durable agentic
 * loop** (the "harness") running on a connected Machina MCP pod. Where a normal
 * tool call is one-shot and ephemeral, the Machina loop persists every turn as a
 * `harness_session` document and is resumed by the pod's beat — so it survives
 * interruptions, async tools, and waiting on input.
 *
 * This tool is only exposed when a pod exposing the `loop-runner` agent is
 * connected (see ToolRegistry.getAllToolSpecs + McpManager.getMachinaLoopServer).
 * It is a thin bridge over the pod's already-connected MCP tools
 * (`execute_agent`, `search_documents`); sportsclaw never holds loop state itself.
 */

import { randomBytes } from "node:crypto";
import type { sportsclawConfig } from "../types.js";
import type { ToolRegistry } from "../tools.js";
import type { ToolCallInput, ToolCallResult } from "../bridge.js";
import type { BuiltinTool } from "./builtin-tool.js";

const RUNNER_AGENT = "loop-runner";
const SESSION_DOC = "harness_session";
const DEFAULT_PERSONA = "loop-reasoning";

function err(error: string, hint?: string): ToolCallResult {
  return {
    content: JSON.stringify({ error, error_code: "machina_loop", ...(hint ? { hint } : {}) }),
    isError: true,
  };
}

/** Lift the workflow-saved payload (docs nest it under `value`; REST under `content`). */
function payloadOf(doc: Record<string, unknown>): Record<string, unknown> {
  const value = (doc.value ?? doc.content) as Record<string, unknown> | undefined;
  return value && typeof value === "object" ? value : {};
}

export const machinaLoopTool: BuiltinTool = {
  spec: {
    name: "machina_loop",
    description: [
      "Delegate a long, multi-step, or resumable task to the Machina durable agentic loop",
      "(the 'harness') on the connected Machina pod. Unlike a normal tool call, the loop",
      "persists every turn server-side and resumes across interruptions.",
      "",
      "Actions:",
      "- start: begin a new durable session for a task. Returns a session_id.",
      "- continue: add a follow-up message to an existing session (needs session_id).",
      "- read: fetch the current state of a session — latest reply, status, turn count.",
      "",
      "The loop runs asynchronously: after start/continue, call read with the session_id to",
      "get the result. Use this for autonomous/background work; use direct tools for a quick answer.",
    ].join("\n"),
    input_schema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["start", "continue", "read"],
          description: "start a new durable session, continue one, or read its current state",
        },
        prompt: {
          type: "string",
          description: "the task or follow-up message (required for start and continue)",
        },
        session_id: {
          type: "string",
          description: "the session id (required for continue and read; returned by start)",
        },
        persona: {
          type: "string",
          description: `optional reasoning persona prompt the loop uses (default: ${DEFAULT_PERSONA})`,
        },
      },
      required: ["action"],
    },
  },

  async execute(
    input: ToolCallInput,
    _config?: Partial<sportsclawConfig>,
    registry?: ToolRegistry
  ): Promise<ToolCallResult> {
    const mgr = registry?.getMcpManager();
    const server = mgr?.getMachinaLoopServer();
    if (!mgr || !server) {
      return err(
        "No Machina durable loop is connected.",
        "Connect a Machina pod that has the loop-runner agent: `sportsclaw mcp add <pod>/mcp/sse --token <key>`."
      );
    }

    const action = String(input.action ?? "start").toLowerCase();
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    const persona = typeof input.persona === "string" && input.persona.trim() ? input.persona.trim() : DEFAULT_PERSONA;
    let sessionId = typeof input.session_id === "string" ? input.session_id.trim() : "";

    if (action === "read") {
      if (!sessionId) return err("read requires session_id.");
      const res = await mgr.callToolDirect(server, "search_documents", {
        filters: { name: SESSION_DOC, "value.session_id": sessionId },
        page_size: 1,
      });
      if (res.isError) return { content: res.content, isError: true };
      let value: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(res.content) as Record<string, unknown>;
        const list = (parsed.data ?? parsed.results ?? parsed) as unknown;
        const doc = Array.isArray(list) ? (list[0] as Record<string, unknown>) : undefined;
        if (doc) value = payloadOf(doc);
      } catch {
        return err("Could not parse the loop session.", "The pod returned a non-JSON document payload.");
      }
      if (!value.session_id) return err(`No loop session found for "${sessionId}".`);
      const entries = Array.isArray(value.entries) ? (value.entries as Array<Record<string, unknown>>) : [];
      const lastAssistant = [...entries].reverse().find((e) => e.role === "assistant" && e.type === "message");
      return {
        content: JSON.stringify({
          session_id: value.session_id,
          status: value.status ?? "unknown",
          turn: value.turn ?? entries.length,
          latest_reply: lastAssistant?.content ?? null,
          entries: entries.length,
        }),
        isError: false,
      };
    }

    // start | continue
    const op = action === "continue" ? "say" : "start";
    if (!prompt) return err(`${action} requires a prompt.`);
    if (op === "say" && !sessionId) return err("continue requires session_id.");
    if (op === "start" && !sessionId) sessionId = `ses_${randomBytes(12).toString("hex")}`;

    const res = await mgr.callToolDirect(server, "execute_agent", {
      name: RUNNER_AGENT,
      messages: [{ role: "user", content: prompt }],
      context: {
        "context-agent": {
          op,
          session_id: sessionId,
          input_message: prompt,
          persona_agent: persona,
        },
      },
    });
    if (res.isError) return { content: res.content, isError: true };

    return {
      content: JSON.stringify({
        session_id: sessionId,
        status: "running",
        note:
          "Durable loop turn dispatched server-side. Call machina_loop with " +
          `{action:"read", session_id:"${sessionId}"} to get the result; it persists and resumes across interruptions.`,
      }),
      isError: false,
    };
  },
};
