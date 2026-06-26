/**
 * operator-sync — route the operator daemon's published decisions through the
 * durable Machina **harness loop** for independent, persisted verification.
 *
 * The operator tick is synchronous and in-process; the harness loop is async and
 * durable (a `start` dispatches the turn server-side, the verdict lands later).
 * So we bridge across ticks: when a tick PUBLISHES, we start a durable loop
 * session that reviews the decision; on the NEXT tick we read that session's
 * verdict and inject it as a deterministic directive. The loop's own
 * generator/evaluator verification (Cap 8 / 8.2) is a *second* safety lens, on
 * top of the daemon's broadcast-safety gate.
 *
 * This is a decorator over the resolved OperatorSink — zero daemon-core change.
 * Opt in via `cfg.operatorSync.enabled`. When disabled it returns the sink as-is.
 *
 * Mirrors the call shapes of the `machina_loop` tool (src/tools/machina_loop.ts):
 *   start → execute_agent {agent_id: loop-runner, context-agent:{op:"start", …}}
 *   read  → search_documents {filters:{name:"harness_session", value.session_id}}
 */

import { randomBytes } from "node:crypto";
import { LOOP_RUNNER_AGENT, type McpManager } from "./mcp.js";
import { sanitizeInput } from "./security.js";
import type { OperatorJobConfig } from "./operator-config.js";
import type { OperatorSinkPlugin } from "./operator-sink.js";
import type { TickEvent } from "./operator-daemon.js";

const SESSION_DOC = "harness_session";
const SESSION_ID_RE = /^ses_[0-9a-f]{24}$/;
const MAX_DECISION_CHARS = 4000;
const DEFAULT_PERSONA = "loop-reasoning";

export interface LoopVerdict {
  sessionId: string;
  /** harness_session status: idle | needs_review | pending | failed | … */
  status: string;
  /** the loop's verification verdict: pass | fail | skipped | null */
  verdict: string | null;
  /** whether the loop self-repaired the answer before this verdict (Cap 8.2) */
  repaired: boolean;
  reason: string;
  /** the loop's assistant reply, sanitized (the pod LLM is untrusted) */
  reply: string | null;
}

/** Lift the workflow-saved payload (docs nest it under `value`; REST under `content`). */
function payloadOf(doc: Record<string, unknown>): Record<string, unknown> {
  const v = (doc.value ?? doc.content) as Record<string, unknown> | undefined;
  return v && typeof v === "object" ? v : {};
}

/**
 * Start a durable loop session that reviews an operator decision.
 * Returns the (client-minted) session id, or null if no loop is connected / the
 * dispatch failed.
 */
export async function dispatchDecisionToLoop(
  mgr: McpManager,
  decision: string,
  persona: string = DEFAULT_PERSONA,
): Promise<string | null> {
  const server = mgr.getMachinaLoopServer?.();
  if (!server) return null;
  const text = decision.trim().slice(0, MAX_DECISION_CHARS);
  if (!text) return null;
  const sessionId = `ses_${randomBytes(12).toString("hex")}`;
  const prompt =
    "You are an INDEPENDENT reviewer of an automated sports-broadcast operator. " +
    "Assess whether the following published decision is on-topic, internally consistent, " +
    "and safe to broadcast. Call out anything wrong, unsupported, or unsafe; otherwise say it is sound.\n\n" +
    "OPERATOR DECISION:\n" +
    text;
  const res = await mgr.callToolDirect(server, "execute_agent", {
    agent_id: LOOP_RUNNER_AGENT,
    messages: [{ role: "user", content: prompt }],
    context: {
      "context-agent": { op: "start", session_id: sessionId, input_message: prompt, persona_agent: persona },
    },
  });
  if (res.isError) return null;
  // The pod proxies execute_agent to REST; an upstream failure can return a
  // status:error envelope WITHOUT the MCP layer flagging isError.
  try {
    const parsed = JSON.parse(res.content) as Record<string, unknown>;
    if (parsed && parsed.status === "error") return null;
  } catch {
    /* non-JSON content — treat as a successful dispatch */
  }
  return sessionId;
}

/** Read a durable loop session's current verdict. Returns null if unreadable. */
export async function readLoopVerdict(mgr: McpManager, sessionId: string): Promise<LoopVerdict | null> {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  const server = mgr.getMachinaLoopServer?.();
  if (!server) return null;
  const res = await mgr.callToolDirect(server, "search_documents", {
    filters: { name: SESSION_DOC, "value.session_id": sessionId },
    page_size: 1,
  });
  if (res.isError) return null;
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
    return null;
  }
  // No document yet → the loop is still spinning up this session.
  if (!value.session_id) {
    return { sessionId, status: "pending", verdict: null, repaired: false, reason: "", reply: null };
  }
  const verification = (value.verification ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(value.entries) ? (value.entries as Array<Record<string, unknown>>) : [];
  const lastAssistant = [...entries].reverse().find((e) => e.role === "assistant" && e.type === "message");
  const rawReply = lastAssistant?.content;
  const reply = typeof rawReply === "string" ? sanitizeInput(rawReply).sanitized : null;
  return {
    sessionId,
    status: String(value.status ?? "unknown"),
    verdict: verification.verdict != null ? String(verification.verdict) : null,
    repaired: verification.repaired === true,
    reason: typeof verification.reason === "string" ? verification.reason : "",
    reply,
  };
}

/**
 * Render a loop verdict as a deterministic directive to prepend to the next tick.
 * Returns null when there's nothing actionable yet (e.g. still pending).
 *
 * The verdict (`pass`/`needs_review`) judges whether the loop's *review* is sound —
 * NOT whether the decision is safe. So when the review is trustworthy (`pass`) we
 * surface the loop's actual ASSESSMENT (`reply`), which may itself flag a problem
 * with the broadcast; a bare "verified" stamp would hide that. When the review is
 * unreliable (`needs_review`) we caution rather than trust its content.
 */
export function formatVerdictDirective(v: LoopVerdict): string | null {
  if (v.status === "pending") return null;
  if (v.status === "needs_review") {
    return (
      "[loop-verification] The independent review of the previous broadcast was inconclusive" +
      (v.reason ? ` (${v.reason})` : "") +
      " — double-check that decision before continuing."
    );
  }
  if (v.verdict === "pass") {
    const reply = v.reply?.trim();
    return reply
      ? `[loop-review] An independent reviewer assessed the previous broadcast: ${reply}`
      : "[loop-verification] The previous broadcast passed independent review; no concerns raised.";
  }
  return null;
}

/** Extract a textual decision from a published TickEvent (prefers free text, falls back to structured output). */
export function decisionTextFrom(evt: TickEvent): string {
  if (typeof evt.text === "string" && evt.text.trim()) return evt.text;
  if (evt.output != null) {
    try {
      return JSON.stringify(evt.output);
    } catch {
      /* unserializable — fall through */
    }
  }
  return "";
}

/**
 * Decorate a resolved sink with operator-sync. On a `tick_published`, start a
 * durable loop verification session; on the next tick, read its verdict and
 * inject it as a directive. The wrapped sink's own hooks still run.
 *
 * Returns the sink unchanged when `cfg.operatorSync` is disabled.
 */
export function withOperatorSync(sink: OperatorSinkPlugin, cfg: OperatorJobConfig): OperatorSinkPlugin {
  if (!cfg.operatorSync?.enabled) return sink;
  const persona = cfg.operatorSync.persona ?? DEFAULT_PERSONA;
  // Cross-tick state: the session_id awaiting a verdict (start-now / read-next-tick).
  let pendingSessionId: string | null = null;

  return {
    ...sink,
    name: sink.name === "noop" ? "operator-sync" : `${sink.name}+operator-sync`,

    async composeTickContext(args) {
      const base = sink.composeTickContext ? await sink.composeTickContext(args) : null;
      let directive: string | null = null;
      if (pendingSessionId && args.mcpManager) {
        const verdict = await readLoopVerdict(args.mcpManager, pendingSessionId).catch(() => null);
        if (verdict) directive = formatVerdictDirective(verdict);
        // Consume the link only once the loop has actually produced a verdict;
        // keep polling it on subsequent ticks while it's still pending.
        if (verdict && verdict.status !== "pending") pendingSessionId = null;
      }
      const parts = [base, directive].filter((s): s is string => Boolean(s));
      return parts.length ? parts.join("\n\n") : null;
    },

    async onTickEvent(evt, ctx) {
      if (sink.onTickEvent) await sink.onTickEvent(evt, ctx);
      if (evt.type === "tick_published" && ctx.mcpManager) {
        const decision = decisionTextFrom(evt);
        if (decision) {
          const sid = await dispatchDecisionToLoop(ctx.mcpManager, decision, persona).catch(() => null);
          if (sid) pendingSessionId = sid;
        }
      }
    },
  };
}
