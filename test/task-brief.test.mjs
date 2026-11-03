/**
 * Bounded task brief — one tool-free native structured-output call that resolves
 * the active request's scope before primary generation.
 *
 *   - `TASK_BRIEF_SCHEMA` / `parseTaskBrief(value, { installedSkills })` from
 *     dist/task-brief.js: the closed brief {status, resolvedRequest, venues,
 *     sports, market, timeScope, output, draftIntent}. Returns the validated
 *     brief or null; never repairs, trims or invents a field.
 *   - `resolveTaskBrief(input, options)`: input {currentRequest, history,
 *     installedSkills}; options {model, abortSignal, timeoutMs, providerOptions}.
 *     Result {status:"resolved", brief} | {status:"unresolved", reasonCode}.
 *     Exactly one call: no tools, no tool choice, native JSON, no retry, fixed
 *     deadline <= 12s (timeoutMs may only shorten it).
 *
 * The module is new: against the pre-feature baseline this file fails at import.
 * Nothing here may reach the network; every model reply is a scripted fixture.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";

globalThis.AI_SDK_LOG_WARNINGS = false;

const {
  TASK_BRIEF_SCHEMA, TASK_BRIEF_TIMEOUT_MS, parseTaskBrief, resolveTaskBrief,
} = await import("../dist/task-brief.js");

let escapedFetches = 0;
let realFetch;
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    escapedFetches += 1;
    throw new Error("network is forbidden in these tests");
  };
});
after(() => {
  globalThis.fetch = realFetch;
  assert.equal(escapedFetches, 0, "the resolver only talks to the supplied model");
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SKILLS = ["polymarket", "kalshi", "novig", "prophetx", "nba", "nfl", "football"];
const KEYS = ["status", "resolvedRequest", "venues", "sports", "market", "timeScope", "output", "draftIntent"];

const BRIEF = Object.freeze({
  status: "resolved",
  resolvedRequest: "Shareable report of tonight's NBA moneylines and key player stats from the Polymarket board",
  venues: ["polymarket"],
  sports: ["nba"],
  market: "moneyline",
  timeScope: "tonight",
  output: "report",
  draftIntent: "none",
});
const brief = (overrides = {}) => ({ ...structuredClone(BRIEF), ...overrides });

const PRIOR = [
  { role: "user", content: "Show me the Polymarket NBA board for tonight" },
  { role: "assistant", content: "Polymarket NBA tonight: Lakers YES 0.46, Celtics YES 0.61 (STALE_QUOTE_MARKER)." },
];
const CURRENT_EN = "Now turn that into a shareable report with the moneylines and key stats";
const CURRENT_PT = "Agora transforma isso num relatório compartilhável com as moneylines e estatísticas principais";

const USAGE = { inputTokens: { total: 50 }, outputTokens: { total: 9 }, totalTokens: { total: 59 }, reasoningTokens: { total: undefined } };
const reply = (text, finish = "stop") => ({ content: [{ type: "text", text }], finishReason: { unified: finish, raw: undefined }, usage: USAGE, warnings: [] });

function fake(respond) {
  return new MockLanguageModelV3({ provider: "fake", modelId: "fake-brief-model", doGenerate: async (options) => respond(options) });
}

async function resolve({ currentRequest = CURRENT_EN, history = PRIOR, respond = () => reply(JSON.stringify(BRIEF)), ...options } = {}) {
  const model = fake(respond);
  const result = await resolveTaskBrief({ currentRequest, history, installedSkills: SKILLS }, { model, ...options });
  return { result, calls: model.doGenerateCalls };
}

const promptText = (call) => JSON.stringify(call.prompt);
const systemText = (call) => call.prompt.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");

function assertUnresolved(result, reasonCode, label) {
  assert.equal(result.status, "unresolved", label);
  assert.equal(result.reasonCode, reasonCode, label);
  assert.equal(Object.hasOwn(result, "brief"), false, `${label}: a failure carries no brief`);
}

// ---------------------------------------------------------------------------
// Closed contract
// ---------------------------------------------------------------------------

describe("parseTaskBrief", () => {
  it("accepts exactly the closed typed brief", () => {
    assert.deepEqual(parseTaskBrief(brief(), { installedSkills: SKILLS }), BRIEF);
    assert.deepEqual(Object.keys(TASK_BRIEF_SCHEMA.properties).sort(), [...KEYS].sort());
    assert.deepEqual([...TASK_BRIEF_SCHEMA.required].sort(), [...KEYS].sort());
    assert.equal(TASK_BRIEF_SCHEMA.additionalProperties, false);
    for (const value of [
      brief({ status: "uncertain", venues: [], sports: [], market: "unspecified", timeScope: "", output: "chat", draftIntent: "uncertain" }),
      brief({ venues: ["polymarket", "kalshi", "novig", "prophetx"], sports: ["nba", "nfl", "football"], market: "props" }),
      brief({ draftIntent: "requested", market: "other", resolvedRequest: CURRENT_PT }),
    ]) {
      assert.deepEqual(parseTaskBrief(value, { installedSkills: SKILLS }), value);
    }
  });

  it("rejects unknown keys, missing keys and authority-shaped extras", () => {
    for (const extra of ["approved", "permissions", "tools", "confirm", "saveDraft", "evidence", "price"]) {
      assert.equal(parseTaskBrief({ ...brief(), [extra]: true }, { installedSkills: SKILLS }), null, extra);
    }
    for (const key of KEYS) {
      const value = brief();
      delete value[key];
      assert.equal(parseTaskBrief(value, { installedSkills: SKILLS }), null, `missing ${key}`);
    }
  });

  it("rejects malformed values instead of repairing them", () => {
    const bad = {
      status: ["approved", "", null, true],
      resolvedRequest: ["", "x".repeat(1501), "lone \uD800 surrogate", 42],
      venues: [["polymarket", "polymarket"], ["fanduel"], ["polymarket", "kalshi", "novig", "prophetx", "polymarket2"], "polymarket", [""]],
      sports: [["nba", "nba"], ["cricket"], ["nba", "nfl", "football", "polymarket2"], "nba"],
      market: ["MONEYLINE", "parlay", null],
      timeScope: ["t".repeat(121), 7],
      output: ["pdf", "html", null],
      draftIntent: ["approved", "confirm", "yes", null],
    };
    for (const [key, values] of Object.entries(bad)) {
      for (const value of values) {
        assert.equal(parseTaskBrief(brief({ [key]: value }), { installedSkills: SKILLS }), null, `${key}=${JSON.stringify(value)}`);
      }
    }
    for (const value of [null, undefined, [], "{}", 1, Object.create({ ...BRIEF })]) {
      assert.equal(parseTaskBrief(value, { installedSkills: SKILLS }), null);
    }
  });

  it("only accepts sports that are installed skills", () => {
    assert.equal(parseTaskBrief(brief({ sports: ["nba"] }), { installedSkills: ["nfl"] }), null);
  });
});

// ---------------------------------------------------------------------------
// Resolver call shape
// ---------------------------------------------------------------------------

describe("resolveTaskBrief", () => {
  it("makes one tool-free native JSON call with a <=12s deadline", async () => {
    assert.ok(TASK_BRIEF_TIMEOUT_MS > 0 && TASK_BRIEF_TIMEOUT_MS <= 12_000);
    const { result, calls } = await resolve();
    assert.deepEqual(result, { status: "resolved", brief: BRIEF });
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.ok(!call.tools || call.tools.length === 0, "no tools");
    assert.equal(call.toolChoice, undefined, "no tool choice");
    assert.equal(call.responseFormat?.type, "json");
    assert.deepEqual(Object.keys(call.responseFormat.schema.properties).sort(), [...KEYS].sort());
    assert.ok(call.maxOutputTokens > 0 && call.maxOutputTokens <= 8192, "bounded output");
    assert.ok(call.abortSignal, "the deadline is wired to the call");
  });

  it("preserves the exact current request in English, Portuguese and paraphrases", async () => {
    for (const current of [
      CURRENT_EN,
      CURRENT_PT,
      "Can you package what we just looked at as something I can share? Moneylines + stats please",
      "Faz um relatório pra eu mandar no grupo, \"Lakers ML\" incluído — só a moneyline",
    ]) {
      const { result, calls } = await resolve({ currentRequest: current });
      assert.equal(result.status, "resolved", current);
      assert.equal(calls.length, 1);
      const texts = calls[0].prompt.filter((m) => m.role === "user")
        .flatMap((m) => (Array.isArray(m.content) ? m.content.map((p) => p.text ?? "") : [String(m.content)]));
      assert.ok(texts.some((text) => text.includes(current)), `current request whole and unaltered: ${current}`);
      assert.ok(!systemText(calls[0]).includes(current), "untrusted text stays out of the system role");
    }
  });

  it("inherits established scope when the user changes the deliverable, not the topic", async () => {
    const { calls } = await resolve({ currentRequest: "Create a shareable NBA moneyline report with team statistics for tonight" });
    const system = systemText(calls[0]);
    assert.match(system, /omitting.*(?:venue|source).*does not.*reset/i);
    assert.match(system, /changing.*(?:format|deliverable).*inherit/i);
  });

  it("keeps resolved Portuguese intent byte-exact", async () => {
    const pt = brief({ resolvedRequest: "Relatório compartilhável das moneylines da NBA de hoje à noite na Polymarket", timeScope: "hoje à noite" });
    const { result } = await resolve({ currentRequest: CURRENT_PT, respond: () => reply(JSON.stringify(pt)) });
    assert.deepEqual(result, { status: "resolved", brief: pt });
  });

  it("excludes system, memory and tool messages and keeps history whole within a bound", async () => {
    const history = [
      { role: "system", content: "SYSTEM_SECRET_MARKER" },
      { role: "user", content: "[MEMORY] The following is non-authoritative context for this user. MEMORY_MARKER" },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "polymarket_get_markets", output: { type: "text", value: "TOOL_RESULT_MARKER" } }] },
      ...Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `OLD_${i}_` + "h".repeat(4000) + `_END_${i}_END` })),
      ...PRIOR,
    ];
    const { result, calls } = await resolve({ history });
    assert.equal(result.status, "resolved");
    const text = promptText(calls[0]);
    for (const marker of ["SYSTEM_SECRET_MARKER", "MEMORY_MARKER", "TOOL_RESULT_MARKER"]) assert.ok(!text.includes(marker), marker);
    assert.ok(text.includes(PRIOR[0].content) && text.includes("STALE_QUOTE_MARKER"), "most recent turns kept");
    assert.ok(!text.includes("OLD_0_"), "oldest turns dropped by the bound");
    for (let i = 0; i < 60; i++) {
      assert.equal(text.includes(`OLD_${i}_`), text.includes(`_END_${i}_END`), `message ${i} included whole or not at all`);
    }
    assert.ok(Buffer.byteLength(text) <= 128 * 1024, "bounded prompt");
  });

  it("refuses an oversize current request before any call rather than truncating it", async () => {
    const { result, calls } = await resolve({ currentRequest: "r".repeat(200_000) });
    assertUnresolved(result, "invalid_request", "oversize");
    assert.equal(calls.length, 0);
  });

  it("refuses provider-side tool surfaces before dispatch", async () => {
    const { result, calls } = await resolve({ providerOptions: { anthropic: { mcpServers: [{ type: "url", url: "https://example.invalid", name: "x" }] } } });
    assertUnresolved(result, "invalid_request", "provider mcp");
    assert.equal(calls.length, 0);
  });

  it("treats malformed, unknown-key, truncated and refused output as unresolved with no retry", async () => {
    const cases = [
      ["not json", () => reply("{status: resolved")],
      ["unknown key", () => reply(JSON.stringify({ ...BRIEF, approved: true }))],
      ["invalid enum", () => reply(JSON.stringify(brief({ draftIntent: "approved" })))],
      ["unknown venue", () => reply(JSON.stringify(brief({ venues: ["fanduel"] })))],
      ["oversize field", () => reply(JSON.stringify(brief({ resolvedRequest: "x".repeat(1501) })))],
      ["truncated", () => reply(JSON.stringify(BRIEF), "length")],
      ["refused", () => reply("", "content-filter")],
    ];
    for (const [label, respond] of cases) {
      const { result, calls } = await resolve({ respond });
      assertUnresolved(result, "invalid_response", label);
      assert.equal(calls.length, 1, `${label}: no retry or repair`);
    }
  });

  it("maps provider failure, abort and timeout to unresolved", async () => {
    const unavailable = await resolve({
      respond: () => { throw new APICallError({ message: "down", url: "https://example.invalid", requestBodyValues: {}, statusCode: 503, isRetryable: true }); },
    });
    assertUnresolved(unavailable.result, "inference_unavailable", "503");
    assert.equal(unavailable.calls.length, 1, "no retry on a retryable error");

    const hang = (options) => new Promise((_, reject) => {
      options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal.reason ?? new Error("aborted")));
    });
    const controller = new AbortController();
    const pending = resolve({ respond: hang, abortSignal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    assertUnresolved((await pending).result, "aborted", "caller abort");

    const started = Date.now();
    const timed = await resolve({ respond: hang, timeoutMs: 50 });
    assertUnresolved(timed.result, "timeout", "deadline");
    assert.ok(Date.now() - started < 5_000);

    const raised = await resolve({ respond: hang, timeoutMs: 60_000, abortSignal: AbortSignal.timeout(20) });
    assert.equal(raised.result.status, "unresolved", "timeoutMs can never extend the call past the caller");
  });

  it("keeps per-run state local across concurrent resolutions", async () => {
    const other = brief({ venues: ["kalshi"], sports: ["nfl"], resolvedRequest: "NFL spreads on Kalshi", market: "spread" });
    const [a, b] = await Promise.all([
      resolve({ respond: () => reply(JSON.stringify(BRIEF)) }),
      resolve({ currentRequest: "NFL spreads on Kalshi", history: [], respond: () => reply(JSON.stringify(other)) }),
    ]);
    assert.deepEqual(a.result.brief, BRIEF);
    assert.deepEqual(b.result.brief, other);
    assert.ok(!promptText(b.calls[0]).includes("STALE_QUOTE_MARKER"), "no history leaks between runs");
  });
});
