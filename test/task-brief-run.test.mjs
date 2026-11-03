// Task brief through the actual engine.run(): with config.taskBrief the engine
// resolves one bounded brief before primary generation, keeps the exact current
// request, may only narrow already-offered venue tools, and never sends the
// brief or history to Jev. Unresolved briefs fall back to the existing path.
// Real engine.run / routing / active-tool narrowing; only the model, registry,
// Jev transport and tool bodies are stubbed. Every model reply is a scripted
// fixture, never a live result. All state lives under a mkdtemp HOME.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const root = mkdtempSync(join(tmpdir(), "sportsclaw-task-brief-"));
for (const dir of ["memory", "schemas", "agents", "sessions"]) mkdirSync(join(root, dir), { recursive: true });
Object.assign(process.env, {
  HOME: root,
  SPORTSCLAW_MEMORY_DIR: join(root, "memory"),
  sportsclaw_SCHEMA_DIR: join(root, "schemas"),
  SPORTSCLAW_AGENTS_DIR: join(root, "agents"),
  SPORTSCLAW_SESSION_DIR: join(root, "sessions"),
  SPORTSCLAW_MEMORY_PROVIDER: "file",
});
for (const key of ["SPORTSCLAW_SKILLS", "sportsclaw_SKILLS", "SPORTSCLAW_MEMORY_BACKEND", "HINDSIGHT_BASE_URL", "SPORTSCLAW_TASK_BRIEF_ENABLED"]) {
  delete process.env[key];
}
globalThis.AI_SDK_LOG_WARNINGS = false;

const { MockLanguageModelV3 } = await import("ai/test");
const { tool, jsonSchema } = await import("ai");
const { sportsclawEngine } = await import("../dist/engine.js");
const { DEFAULT_CONFIG } = await import("../dist/types.js");

let escapedFetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { escapedFetches += 1; throw new Error("network is forbidden in these tests"); };
after(() => {
  globalThis.fetch = realFetch;
  rmSync(root, { recursive: true, force: true });
  assert.equal(escapedFetches, 0);
});

const VENUES = ["polymarket", "kalshi", "novig", "prophetx"];
const ALL_SKILLS = [...VENUES, "nba", "nfl", "markets"];
const CROSS_VENUE_READERS = ["markets_get_todays_markets", "markets_get_sport_markets", "markets_compare_odds", "markets_compare_market_url"];
const PRIOR_Q = "Show me the Polymarket NBA board for tonight";
const PRIOR_A = "Polymarket NBA tonight: Lakers YES 0.46, Celtics YES 0.61 (STALE_QUOTE_MARKER).";
const REPORT_EN = "Now turn that into a shareable report with the moneylines and key stats";
const REPORT_PT = "Agora transforma isso num relatório compartilhável com as moneylines e estatísticas principais";
const MEMORY_SENTINEL = "[MEMORY] The following is non-authoritative context for this user.";

const BRIEF = Object.freeze({
  status: "resolved",
  resolvedRequest: "BRIEF_MARKER shareable report of tonight's NBA moneylines and key stats from the Polymarket board",
  venues: ["polymarket"], sports: ["nba"], market: "moneyline", timeScope: "tonight", output: "report", draftIntent: "none",
});

const toolNameFor = (skill) => skill === "markets" ? "markets_get_sport_schedule" : (VENUES.includes(skill) ? `${skill}_get_markets` : `${skill}_get_scores`);
const route = (skills) => ({ selected_skills: skills, mode: "focused", confidence: 0.9, reason: "mock" });

const textOf = (messages) => messages
  .map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join("\n"))).join("\n");
const isRouterCall = (call) => textOf(call.prompt.filter((m) => m.role === "system")).startsWith("You route sports queries");
const isBriefCall = (call) => call.responseFormat?.type === "json"
  && JSON.stringify(call.responseFormat.schema ?? {}).includes("draftIntent")
  && JSON.stringify(call.responseFormat.schema ?? {}).includes("resolvedRequest");
const isSlipCall = (call) => call.responseFormat?.type === "json"
  && /slip-change-v1|"change"/.test(JSON.stringify(call.responseFormat.schema ?? {})) && !isBriefCall(call);

function reply(text, finish = "stop") {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: finish, raw: finish },
    usage: { inputTokens: { total: 4, noCache: 4 }, outputTokens: { total: 2, text: 2 } },
    warnings: [],
  };
}

/**
 * Real engine with scripted model. state.brief: object → JSON reply, string → raw,
 * function → custom doGenerate for the resolver call.
 */
function makeEngine({ taskBrief, history = [[PRIOR_Q, PRIOR_A]], routed = ["polymarket", "kalshi", "novig", "nba"], realRouting = false } = {}) {
  const state = { route: route(routed), brief: BRIEF, answer: "SCRIPTED_FIXTURE_ANSWER" };
  const model = new MockLanguageModelV3({
    doGenerate: async (call) => {
      if (isRouterCall(call)) return reply(JSON.stringify(state.route));
      if (isBriefCall(call)) {
        if (typeof state.brief === "function") return state.brief(call);
        return reply(typeof state.brief === "string" ? state.brief : JSON.stringify(state.brief));
      }
      if (isSlipCall(call)) return reply(JSON.stringify({ status: "none", change: null }));
      if (state.tryHidden && !call.prompt.some((m) => m.role === "tool")) return {
        ...reply("", "tool-calls"),
        content: [{ type: "tool-call", toolCallId: "hidden-venue-attempt", toolName: state.tryHidden, input: "{}" }],
      };
      return reply(state.answer);
    },
  });
  const engine = new sportsclawEngine({ thinkingBudget: 0, routingMaxSkills: 8, ...(taskBrief === undefined ? {} : { taskBrief }) });
  engine.mainModel = model;
  engine.messages = history.flatMap(([q, a]) => [{ role: "user", content: q }, { role: "assistant", content: a }]);
  const specs = [...ALL_SKILLS.map(toolNameFor), ...CROSS_VENUE_READERS].map((name) => ({ name, description: `${name} data`, input_schema: { type: "object", properties: {} } }));
  engine.registry = {
    getInstalledSkills: () => [...ALL_SKILLS],
    getAllToolSpecs: () => specs,
    getSkillName: (name) => ALL_SKILLS.find((skill) => name.startsWith(`${skill}_`)),
  };
  const executed = [];
  const mk = (name) => tool({ description: name, inputSchema: jsonSchema({ type: "object", properties: {} }),
    execute: async () => { executed.push(name); return "{}"; } });
  engine.buildTools = () => Object.fromEntries(specs.map((s) => [s.name, mk(s.name)]));
  // This suite isolates post-routing narrowing. Real soft-lock helper inference can
  // remove a venue before this feature sees it; router behavior has its own tests.
  if (!realRouting) engine.resolveActiveToolsForPrompt = async () => ({
    activeTools: specs.filter((s) => routed.some((skill) => s.name.startsWith(`${skill}_`))).map((s) => s.name),
    decision: { selectedSkills: routed, mode: "focused", confidence: 0.9, reason: "synthetic routing boundary" },
  });
  const calls = () => model.doGenerateCalls;
  const briefCalls = () => calls().filter(isBriefCall);
  const mainCalls = () => calls().filter((c) => !isRouterCall(c) && !isBriefCall(c) && !isSlipCall(c));
  return { engine, state, model, calls, briefCalls, mainCalls, executed };
}

const offered = (call) => (call?.tools ?? []).map((t) => t.name).sort();
const userTexts = (call) => call.prompt.filter((m) => m.role === "user")
  .flatMap((m) => (Array.isArray(m.content) ? m.content.map((p) => p.text ?? "") : [String(m.content)]));
const systemOf = (call) => textOf(call.prompt.filter((m) => m.role === "system"));

/** Offered tools on the first main call for the same scenario with the flag off. */
async function baselineTools(current, routed) {
  const off = makeEngine({ taskBrief: false, routed });
  await off.engine.run(current);
  assert.equal(off.briefCalls().length, 0);
  return offered(off.mainCalls()[0]);
}

function assertBriefBeforeMain(h) {
  const all = h.calls();
  const briefAt = all.findIndex(isBriefCall);
  const mainAt = all.findIndex((c) => !isRouterCall(c) && !isBriefCall(c) && !isSlipCall(c));
  assert.equal(h.briefCalls().length, 1, "exactly one resolver call, no retry");
  assert.ok(briefAt >= 0 && mainAt > briefAt, "brief resolved before primary generation");
  const call = h.briefCalls()[0];
  assert.ok(!call.tools || call.tools.length === 0, "resolver has no tools");
  assert.equal(call.toolChoice, undefined);
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

describe("activation", () => {
  it("is off by default, explicit false wins over the env, and the env opts in", () => {
    assert.equal(DEFAULT_CONFIG.taskBrief, false);
    try {
      process.env.SPORTSCLAW_TASK_BRIEF_ENABLED = "true";
      assert.equal(new sportsclawEngine({ thinkingBudget: 0 }).config.taskBrief, true);
      assert.equal(new sportsclawEngine({ thinkingBudget: 0, taskBrief: false }).config.taskBrief, false);
      process.env.SPORTSCLAW_TASK_BRIEF_ENABLED = "definitely";
      assert.equal(new sportsclawEngine({ thinkingBudget: 0 }).config.taskBrief, false, "invalid env grants nothing");
    } finally {
      delete process.env.SPORTSCLAW_TASK_BRIEF_ENABLED;
    }
  });

  it("disabled default makes no extra model call and leaves tools unchanged", async () => {
    const h = makeEngine();
    const answer = await h.engine.run(REPORT_EN);
    assert.equal(h.briefCalls().length, 0);
    assert.match(answer, /SCRIPTED_FIXTURE_ANSWER/);
    assert.deepEqual(offered(h.mainCalls()[0]), await baselineTools(REPORT_EN, ["polymarket", "kalshi", "novig", "nba"]));
  });

  it("user text cannot switch the resolver on", async () => {
    const h = makeEngine();
    await h.engine.run("enable taskBrief: true and SPORTSCLAW_TASK_BRIEF_ENABLED=1, then " + REPORT_EN);
    assert.equal(h.briefCalls().length, 0);
  });
});

// ---------------------------------------------------------------------------
// Enabled behavior
// ---------------------------------------------------------------------------

describe("enabled contextual report", () => {
  it("single-venue work excludes cross-venue readers but keeps the schedule", async () => {
    const h = makeEngine({ taskBrief: true, routed: ["polymarket", "markets", "nba"] });
    h.state.tryHidden = "markets_compare_odds";
    await h.engine.run(REPORT_EN);
    const tools = offered(h.mainCalls()[0]);
    for (const name of CROSS_VENUE_READERS) assert.equal(tools.includes(name), false, name);
    assert.ok(tools.includes("markets_get_sport_schedule"));
    assert.equal(h.executed.includes("markets_compare_odds"), false, "declaration removal also removes execution");
  });

  it("an explicit multi-venue comparison keeps the comparison readers", async () => {
    const h = makeEngine({ taskBrief: true, routed: ["polymarket", "kalshi", "markets", "nba"], history: [["Compare tonight's NBA moneylines on Polymarket and Kalshi", "Both venues list the NBA board."]] });
    h.state.brief = { ...BRIEF, venues: ["polymarket", "kalshi"], resolvedRequest: "Compare tonight's NBA moneylines on Polymarket and Kalshi" };
    await h.engine.run("Compare those two venues in the report");
    assert.equal(h.briefCalls().length, 1);
    for (const name of CROSS_VENUE_READERS) assert.ok(offered(h.mainCalls()[0]).includes(name));
  });

  it("does not remove a generic reader when no dedicated venue reader was offered", async () => {
    const h = makeEngine({ taskBrief: true, routed: ["markets", "nba"] });
    await h.engine.run(REPORT_EN);
    assert.ok(offered(h.mainCalls()[0]).includes("markets_compare_odds"));
  });

  it("reserves visible output room for the structured brief", async () => {
    const h = makeEngine({ taskBrief: true });
    h.engine.config.provider = "google";
    h.engine.config.thinkingBudget = 8192;
    await h.engine.run(REPORT_EN);
    const call = h.briefCalls()[0];
    const thinking = call.providerOptions?.google?.thinkingConfig?.thinkingBudget ?? 0;
    assert.ok(thinking < call.maxOutputTokens, "thinking cannot consume the complete JSON output budget");
  });

  it("a venue removed by the brief also loses execution, not just its declaration", async () => {
    const h = makeEngine({ taskBrief: true, routed: ["polymarket", "kalshi", "nba"] });
    h.state.tryHidden = "kalshi_get_markets";
    await h.engine.run(REPORT_EN);
    assert.equal(h.executed.includes("kalshi_get_markets"), false);
  });
  for (const current of [REPORT_EN, REPORT_PT, "Package what we just looked at so I can share it — moneylines plus stats"]) {
    it(`resolves Polymarket/NBA/report before the main call: ${current.slice(0, 32)}`, async () => {
      const routed = ["polymarket", "kalshi", "novig", "nba"];
      const baseline = await baselineTools(current, routed);
      assert.ok(baseline.includes("kalshi_get_markets"), `precondition: the unnarrowed route offers other venues; got ${JSON.stringify(baseline)}`);

      const h = makeEngine({ taskBrief: true, routed });
      await h.engine.run(current);
      assertBriefBeforeMain(h);

      const main = h.mainCalls()[0];
      const tools = offered(main);
      assert.ok(tools.includes("polymarket_get_markets") && tools.includes("nba_get_scores"), "venue and stats retained");
      assert.ok(!tools.includes("kalshi_get_markets") && !tools.includes("novig_get_markets"), "narrowed to the retained venue");
      assert.ok(tools.every((name) => baseline.includes(name)), "never broadens the offered set");

      const texts = userTexts(main);
      assert.ok(texts.some((t) => t === current), "exact current request reaches the main model unaltered");
      assert.ok(texts.some((t) => t.includes("BRIEF_MARKER")), "brief supplied as user-role intent data");
      assert.ok(!systemOf(main).includes("BRIEF_MARKER"), "brief never injected into the system role");
      assert.ok(!h.engine.messages.some((m) => textOf([m]).includes("BRIEF_MARKER")), "canonical history unchanged");
      assert.ok(h.engine.messages.some((m) => m.role === "user" && textOf([m]) === current));
    });
  }

  it("cannot expand to a venue the route did not offer", async () => {
    const routed = ["polymarket", "nba"];
    const baseline = await baselineTools(REPORT_EN, routed);
    const h = makeEngine({ taskBrief: true, routed });
    h.state.brief = { ...BRIEF, venues: ["polymarket", "kalshi", "prophetx"], sports: ["nba", "nfl"] };
    await h.engine.run(REPORT_EN);
    assertBriefBeforeMain(h);
    assert.ok(offered(h.mainCalls()[0]).every((name) => baseline.includes(name)));
    assert.ok(!offered(h.mainCalls()[0]).includes("kalshi_get_markets"));
  });

  it("the latest explicit venue in the current request wins over a conflicting brief", async () => {
    const current = "Same report but use Kalshi instead";
    const routed = ["polymarket", "kalshi", "nba"];
    const h = makeEngine({ taskBrief: true, routed });
    await h.engine.run(current);
    assertBriefBeforeMain(h);
    assert.ok(offered(h.mainCalls()[0]).includes("kalshi_get_markets"), "explicitly named venue is never filtered out");
  });

  it("a topic switch replaces the prior venue scope", async () => {
    const current = "Forget the board — how did the Celtics do last night?";
    const h = makeEngine({ taskBrief: true, routed: ["nba"] });
    h.state.brief = { ...BRIEF, resolvedRequest: "BRIEF_MARKER Celtics result last night", venues: [], market: "unspecified",
      timeScope: "last night", output: "chat" };
    await h.engine.run(current);
    assertBriefBeforeMain(h);
    const tools = offered(h.mainCalls()[0]);
    assert.ok(tools.includes("nba_get_scores"));
    assert.ok(!tools.some((name) => VENUES.some((v) => name.startsWith(`${v}_`))), "no stale venue tools dragged in");
  });

  it("the resolver sees bounded user/assistant text only and the current request whole", async () => {
    const h = makeEngine({ taskBrief: true });
    h.engine.messages = [
      { role: "user", content: `${MEMORY_SENTINEL} MEMORY_MARKER` },
      { role: "user", content: PRIOR_Q },
      { role: "assistant", content: [{ type: "text", text: "Checking." }, { type: "tool-call", toolCallId: "p1", toolName: "polymarket_get_markets", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "p1", toolName: "polymarket_get_markets", output: { type: "text", value: "TOOL_RESULT_MARKER" } }] },
      { role: "assistant", content: PRIOR_A },
    ];
    await h.engine.run(REPORT_EN);
    assertBriefBeforeMain(h);
    const call = h.briefCalls()[0];
    const text = JSON.stringify(call.prompt);
    for (const marker of ["MEMORY_MARKER", "TOOL_RESULT_MARKER"]) assert.ok(!text.includes(marker), marker);
    assert.ok(userTexts(call).some((t) => t.includes(REPORT_EN)));
    assert.ok(!systemOf(call).includes(REPORT_EN));
    assert.ok(Buffer.byteLength(text) <= 128 * 1024);
  });
});

// ---------------------------------------------------------------------------
// Unresolved briefs keep the existing guards
// ---------------------------------------------------------------------------

describe("unresolved brief falls back to the original scoped path", () => {
  const failures = [
    ["malformed", "{status: resolved"],
    ["unknown key", JSON.stringify({ ...BRIEF, approved: true })],
    ["invalid draft intent", JSON.stringify({ ...BRIEF, draftIntent: "approved" })],
    ["oversize", JSON.stringify({ ...BRIEF, resolvedRequest: "x".repeat(5000) })],
    ["refused", () => reply("", "content-filter")],
    ["provider error", () => { throw new Error("synthetic provider failure"); }],
  ];
  for (const [label, brief] of failures) {
    it(label, async () => {
      const routed = ["polymarket", "kalshi", "novig", "nba"];
      const baseline = await baselineTools(REPORT_EN, routed);
      const h = makeEngine({ taskBrief: true, routed });
      h.state.brief = brief;
      const answer = await h.engine.run(REPORT_EN);
      assertBriefBeforeMain(h);
      assert.match(answer, /SCRIPTED_FIXTURE_ANSWER/);
      assert.deepEqual(offered(h.mainCalls()[0]), baseline, "no narrowing and no expansion from a failed brief");
      assert.ok(!JSON.stringify(h.mainCalls()[0].prompt).includes("BRIEF_MARKER"));
      assert.ok(userTexts(h.mainCalls()[0]).some((t) => t === REPORT_EN));
    });
  }

  it("a caller abort during resolution cancels instead of generating", async () => {
    const h = makeEngine({ taskBrief: true });
    const controller = new AbortController();
    h.state.brief = (call) => new Promise((_, reject) => {
      call.abortSignal?.addEventListener("abort", () => reject(call.abortSignal.reason ?? new Error("aborted")));
      setTimeout(() => controller.abort(), 5);
    });
    await h.engine.run(REPORT_EN, { abortSignal: controller.signal });
    assert.equal(h.briefCalls().length, 1);
    assert.equal(h.mainCalls().length, 0, "no primary generation after abort");
    assert.deepEqual(h.executed, []);
  });
});

// ---------------------------------------------------------------------------
// Drafts and Jev
// ---------------------------------------------------------------------------

describe("draft gate and Jev boundary", () => {
  it("a legitimate draft request keeps the existing extraction gate whatever the brief says", async () => {
    const current = "Add the Lakers moneyline to my slip";
    const off = makeEngine({ taskBrief: false, routed: ["polymarket", "nba"] });
    await off.engine.run(current);
    for (const brief of [{ ...BRIEF, draftIntent: "none" }, { ...BRIEF, draftIntent: "requested" }, "{broken"]) {
      const h = makeEngine({ taskBrief: true, routed: ["polymarket", "nba"] });
      h.state.brief = brief;
      await h.engine.run(current);
      assertBriefBeforeMain(h);
      assert.equal(h.calls().filter(isSlipCall).length, off.calls().filter(isSlipCall).length,
        "the brief neither suppresses an explicit draft request nor adds an extraction");
      assert.ok(!h.calls().filter(isSlipCall).some((c) => JSON.stringify(c.prompt).includes("BRIEF_MARKER")),
        "the brief is never draft evidence");
    }
  });

  it("never sends the brief or history to Jev; Jev keeps the original current text", async () => {
    const h = makeEngine({ taskBrief: true, realRouting: true });
    const bodies = [];
    const transport = async (_url, init) => {
      bodies.push(init.body);
      const body = JSON.parse(init.body);
      const answers = {};
      for (const [id, question] of Object.entries(body.questions)) {
        const choice = id === "disposition" ? "no_tools" : "not_required";
        const labels = Object.keys(question.criteria);
        answers[id] = { type: "choice", choice, confidence: 0.97, probabilities: Object.fromEntries(labels.map((l) => [l, l === choice ? 1 : 0])) };
      }
      return new Response(JSON.stringify({ model: body.model, answers }), { status: 200, headers: { "content-type": "application/json" } });
    };
    h.engine.config = { ...h.engine.config, routing: { provider: "jev", dataPolicy: "cloud_allowed", env: { TYPESAFE_API_KEY: "synthetic-key" }, transport } };
    await h.engine.run(REPORT_EN);
    assert.ok(bodies.length >= 1, "Jev was consulted");
    for (const body of bodies) {
      for (const marker of ["BRIEF_MARKER", "STALE_QUOTE_MARKER", PRIOR_Q, "draftIntent", "resolvedRequest"]) {
        assert.ok(!body.includes(marker), `Jev body must not contain ${marker}`);
      }
    }
    assert.ok(bodies.some((body) => body.includes(JSON.stringify(REPORT_EN).slice(1, -1))), "Jev routes the exact current text");
  });
});
