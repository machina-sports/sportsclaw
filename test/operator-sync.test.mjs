import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dispatchDecisionToLoop,
  readLoopVerdict,
  formatVerdictDirective,
  decisionTextFrom,
  withOperatorSync,
} from "../dist/operator-sync.js";

const SID = "ses_0123456789abcdef01234567"; // ses_ + 24 hex

// Fake McpManager: `server` defaults to a connected loop ("machina"); pass
// server:null to simulate no loop. `tools` maps toolName -> result|fn(args).
function fakeMgr({ server = "machina", tools = {} } = {}) {
  const calls = [];
  return {
    _calls: calls,
    getMachinaLoopServer: () => server,
    callToolDirect: async (srv, tool, args) => {
      calls.push({ tool, args });
      const h = tools[tool];
      const r = typeof h === "function" ? h(args) : h;
      return r ?? { content: "{}", isError: false };
    },
  };
}

const ok = (obj) => ({ content: JSON.stringify(obj), isError: false });
// Machina's MCP double envelope { data: { data: [...] } }
const docEnvelope = (value) => ok({ status: "success", data: { data: value ? [{ value }] : [] } });

describe("dispatchDecisionToLoop", () => {
  it("mints a ses_ id and calls execute_agent on success", async () => {
    const mgr = fakeMgr({ tools: { execute_agent: ok({ status: true }) } });
    const sid = await dispatchDecisionToLoop(mgr, "publish block A");
    assert.match(sid, /^ses_[0-9a-f]{24}$/);
    assert.equal(mgr._calls[0].tool, "execute_agent");
    assert.equal(mgr._calls[0].args.agent_id, "loop-runner");
    assert.equal(mgr._calls[0].args.context["context-agent"].op, "start");
  });

  it("returns null when no loop server is connected", async () => {
    const mgr = fakeMgr({ server: null });
    assert.equal(await dispatchDecisionToLoop(mgr, "x"), null);
    assert.equal(mgr._calls.length, 0);
  });

  it("returns null on an empty decision", async () => {
    const mgr = fakeMgr({ tools: { execute_agent: ok({ status: true }) } });
    assert.equal(await dispatchDecisionToLoop(mgr, "   "), null);
  });

  it("returns null when execute_agent flags isError", async () => {
    const mgr = fakeMgr({ tools: { execute_agent: { content: "boom", isError: true } } });
    assert.equal(await dispatchDecisionToLoop(mgr, "x"), null);
  });

  it("returns null on a status:error envelope (no isError flag)", async () => {
    const mgr = fakeMgr({ tools: { execute_agent: ok({ status: "error", message: "stale MCP" }) } });
    assert.equal(await dispatchDecisionToLoop(mgr, "x"), null);
  });
});

describe("readLoopVerdict", () => {
  it("parses the double envelope and surfaces the verdict + sanitized reply", async () => {
    const value = {
      session_id: SID,
      status: "idle",
      verification: { verdict: "pass", repaired: false, reason: "sound" },
      entries: [{ role: "assistant", type: "message", content: "Looks sound." }],
    };
    const mgr = fakeMgr({ tools: { search_documents: docEnvelope(value) } });
    const v = await readLoopVerdict(mgr, SID);
    assert.equal(v.status, "idle");
    assert.equal(v.verdict, "pass");
    assert.equal(v.repaired, false);
    assert.equal(v.reply, "Looks sound.");
  });

  it("reports repaired=true when the loop self-repaired (Cap 8.2)", async () => {
    const value = { session_id: SID, status: "idle", verification: { verdict: "pass", repaired: true, reason: "" }, entries: [] };
    const mgr = fakeMgr({ tools: { search_documents: docEnvelope(value) } });
    const v = await readLoopVerdict(mgr, SID);
    assert.equal(v.repaired, true);
  });

  it("returns pending when the session doc does not exist yet", async () => {
    const mgr = fakeMgr({ tools: { search_documents: docEnvelope(null) } });
    const v = await readLoopVerdict(mgr, SID);
    assert.equal(v.status, "pending");
    assert.equal(v.verdict, null);
  });

  it("rejects a malformed session_id without hitting the pod", async () => {
    const mgr = fakeMgr({ tools: { search_documents: docEnvelope(null) } });
    assert.equal(await readLoopVerdict(mgr, "not-a-session"), null);
    assert.equal(mgr._calls.length, 0);
  });

  it("returns null when search flags isError", async () => {
    const mgr = fakeMgr({ tools: { search_documents: { content: "err", isError: true } } });
    assert.equal(await readLoopVerdict(mgr, SID), null);
  });
});

describe("formatVerdictDirective", () => {
  it("pass → a 'verified' directive", () => {
    const d = formatVerdictDirective({ sessionId: SID, status: "idle", verdict: "pass", repaired: false, reason: "", reply: null });
    assert.match(d, /verified/i);
  });
  it("pass + repaired → notes the self-repair", () => {
    const d = formatVerdictDirective({ sessionId: SID, status: "idle", verdict: "pass", repaired: true, reason: "", reply: null });
    assert.match(d, /self-repair/i);
  });
  it("needs_review → a review directive carrying the reason", () => {
    const d = formatVerdictDirective({ sessionId: SID, status: "needs_review", verdict: "fail", repaired: false, reason: "off-topic", reply: null });
    assert.match(d, /review/i);
    assert.match(d, /off-topic/);
  });
  it("pending → null (nothing to inject yet)", () => {
    assert.equal(formatVerdictDirective({ sessionId: SID, status: "pending", verdict: null, repaired: false, reason: "", reply: null }), null);
  });
});

describe("decisionTextFrom", () => {
  it("prefers free text", () => {
    assert.equal(decisionTextFrom({ type: "tick_published", text: "hello" }), "hello");
  });
  it("falls back to structured output as JSON", () => {
    assert.equal(decisionTextFrom({ type: "tick_published", output: { a: 1 } }), '{"a":1}');
  });
  it("returns empty string when there is nothing", () => {
    assert.equal(decisionTextFrom({ type: "tick_silent" }), "");
  });
});

describe("withOperatorSync — sink decorator", () => {
  it("returns the sink unchanged when disabled", () => {
    const sink = { name: "noop" };
    assert.equal(withOperatorSync(sink, { operatorSync: { enabled: false } }), sink);
    assert.equal(withOperatorSync(sink, {}), sink);
  });

  it("start-now / read-next-tick: dispatches on publish, injects the verdict next tick, and keeps base hooks", async () => {
    const log = [];
    const base = {
      name: "noop",
      composeTickContext: () => "BASE-DIRECTIVE",
      onTickEvent: (evt) => { log.push(`base:${evt.type}`); },
    };
    const value = { session_id: SID, status: "idle", verification: { verdict: "pass", repaired: false, reason: "" }, entries: [] };
    const mgr = fakeMgr({ tools: { execute_agent: ok({ status: true }), search_documents: docEnvelope(value) } });
    const ctx = { jobId: "j", mcpManager: mgr, cfg: {} };

    const wrapped = withOperatorSync(base, { operatorSync: { enabled: true } });
    assert.match(wrapped.name, /operator-sync/);

    // Tick N publishes → base hook fires + a loop session is dispatched.
    await wrapped.onTickEvent({ type: "tick_published", text: "publish block A" }, ctx);
    assert.deepEqual(log, ["base:tick_published"]);
    assert.ok(mgr._calls.some((c) => c.tool === "execute_agent"));

    // Tick N+1 composes → base directive AND the loop verdict are both injected.
    const directive = await wrapped.composeTickContext({ jobId: "j", tickId: "t2", timestamp: "now", cfg: {}, mcpManager: mgr });
    assert.match(directive, /BASE-DIRECTIVE/);
    assert.match(directive, /loop-verification/);
    assert.match(directive, /verified/i);
    assert.ok(mgr._calls.some((c) => c.tool === "search_documents"));
  });

  it("does not dispatch on a non-published tick", async () => {
    const mgr = fakeMgr({ tools: { execute_agent: ok({ status: true }) } });
    const wrapped = withOperatorSync({ name: "noop" }, { operatorSync: { enabled: true } });
    await wrapped.onTickEvent({ type: "tick_silent" }, { jobId: "j", mcpManager: mgr, cfg: {} });
    assert.equal(mgr._calls.length, 0);
  });
});
