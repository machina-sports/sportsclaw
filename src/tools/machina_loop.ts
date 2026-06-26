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
import { LOOP_RUNNER_AGENT } from "../mcp.js";
import { sanitizeInput } from "../security.js";

const SESSION_DOC = "harness_session";
const DEFAULT_PERSONA = "loop-reasoning";
const ACTIONS = ["start", "continue", "read"] as const;
// Minted ids are `ses_` + 24 lowercase hex (randomBytes(12)). continue/read
// echo a caller-supplied id straight into the pod filter, so enforce the shape.
const SESSION_ID_RE = /^ses_[0-9a-f]{24}$/;

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
      "Do not call start again for a task you already started — reuse its session_id with read,",
      "or continue it. A fresh start mints a new session and leaves the prior loop running.",
    ].join("\n"),
    // start/continue dispatch the pod's mutating execute_agent — gate them like
    // any other mutating tool. read is a side-effect-free document fetch.
    needsApproval: (input) => String(input?.action ?? "start").toLowerCase() !== "read",
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
    if (!(ACTIONS as readonly string[]).includes(action)) {
      return err(`Unknown action "${action}". Use one of: ${ACTIONS.join(", ")}.`);
    }
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    const persona = typeof input.persona === "string" && input.persona.trim() ? input.persona.trim() : DEFAULT_PERSONA;
    let sessionId = typeof input.session_id === "string" ? input.session_id.trim() : "";
    // A caller-supplied id (continue/read) goes verbatim into the pod's document
    // filter — reject anything that isn't a well-formed minted id.
    if (sessionId && !SESSION_ID_RE.test(sessionId)) {
      return err(`Invalid session_id "${sessionId}".`, "Use the session_id returned by a previous `start`.");
    }

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
        let list = (parsed.data ?? parsed.results ?? parsed) as unknown;
        // Machina's MCP wraps as { data: { data: [...] } } — unwrap the inner envelope.
        if (list && !Array.isArray(list) && typeof list === "object") {
          const inner = list as Record<string, unknown>;
          if (Array.isArray(inner.data)) list = inner.data;
          else if (Array.isArray(inner.results)) list = inner.results;
        }
        const doc = Array.isArray(list) ? (list[0] as Record<string, unknown>) : undefined;
        if (doc) value = payloadOf(doc);
      } catch {
        return err("Could not parse the loop session.", "The pod returned a non-JSON document payload.");
      }
      if (!value.session_id) {
        // Distinguish "still spinning up" from a hard failure: a just-started
        // loop hasn't written its document yet. Return a non-error pending state
        // so the model polls again instead of treating it as a dead session.
        return {
          content: JSON.stringify({
            session_id: sessionId,
            status: "pending",
            latest_reply: null,
            entries: 0,
            note: "No session document yet — the loop may still be starting. Retry read shortly.",
          }),
          isError: false,
        };
      }
      const entries = Array.isArray(value.entries) ? (value.entries as Array<Record<string, unknown>>) : [];
      const lastAssistant = [...entries].reverse().find((e) => e.role === "assistant" && e.type === "message");
      // The reply is authored by the pod's own LLM — treat it as untrusted external
      // data and strip injection patterns before it re-enters this agent's context.
      const rawReply = lastAssistant?.content;
      const latestReply = typeof rawReply === "string" ? sanitizeInput(rawReply).sanitized : (rawReply ?? null);
      return {
        content: JSON.stringify({
          session_id: value.session_id,
          status: value.status ?? "unknown",
          turn: value.turn ?? entries.length,
          latest_reply: latestReply,
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
      // The pod's execute_agent requires `agent_id`; a non-ObjectId string is
      // treated as an agent name (documented backward-compat), so this resolves
      // `loop-runner` by name without a separate id lookup.
      agent_id: LOOP_RUNNER_AGENT,
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
    if (res.isError) {
      // Surface the session_id even on failure: the dispatch may have started the
      // loop server-side (e.g. on a response timeout), so the caller can still poll.
      return {
        content: JSON.stringify({
          error: "Loop dispatch failed; the session may still have started server-side.",
          error_code: "machina_loop",
          session_id: sessionId,
          pod_error: res.content,
        }),
        isError: true,
      };
    }

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
