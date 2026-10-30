// Conversation continuity: engine.run() must answer through the model instead
// of canned clarification menus, follow a restored persistent thread, keep
// every explicitly named venue through routing, and not drag market tools
// into a genuine topic switch. Real engine.run / routePromptToSkills / history
// loading / active-tool narrowing; only the model, registry and tool bodies
// are stubbed. All state lives under a mkdtemp HOME.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const root = mkdtempSync(join(tmpdir(), "sportsclaw-continuity-"));
for (const dir of ["memory", "schemas", "agents", "sessions"]) mkdirSync(join(root, dir), { recursive: true });
Object.assign(process.env, {
  HOME: root,
  SPORTSCLAW_MEMORY_DIR: join(root, "memory"),
  sportsclaw_SCHEMA_DIR: join(root, "schemas"),
  SPORTSCLAW_AGENTS_DIR: join(root, "agents"),
  SPORTSCLAW_SESSION_DIR: join(root, "sessions"),
  SPORTSCLAW_MEMORY_PROVIDER: "file",
});
for (const key of ["SPORTSCLAW_SKILLS", "sportsclaw_SKILLS", "SPORTSCLAW_MEMORY_BACKEND", "HINDSIGHT_BASE_URL"]) {
  delete process.env[key];
}
globalThis.AI_SDK_LOG_WARNINGS = false;

// Imported after the env is set: memory, schema and session paths resolve at import.
const { MockLanguageModelV3 } = await import("ai/test");
const { tool, jsonSchema } = await import("ai");
const { sportsclawEngine, sessionStore } = await import("../dist/engine.js");
const { MemoryManager } = await import("../dist/memory.js");
const { routePromptToSkills } = await import("../dist/router.js");
const { finalizeActiveTools, ProviderToolCeilingError } = await import("../dist/routing/tool-activation.js");
const { DEFAULT_TOKEN_BUDGETS } = await import("../dist/types.js");

after(() => rmSync(root, { recursive: true, force: true }));

const VENUES = ["polymarket", "kalshi", "novig", "prophetx"];
const ALL_SKILLS = [...VENUES, "nba", "nfl", "mlb", "betting"];
const FOLLOW_UP = "Check on Polymarket Kalshi novig and prophetx";
const PRIOR_Q = "Find arbitrage between prediction markets for tonight's NBA games";
const PRIOR_A = "Arbitrage scan: Kalshi Lakers YES 0.46 vs Polymarket Lakers NO 0.51, about 3% gross edge before fees.";
const CANNED = /What would you like to know about|I'm not sure which sport you mean/;
const MEMORY_SENTINEL = "[MEMORY] The following is non-authoritative context for this user.";

const toolNameFor = (skill) =>
  VENUES.includes(skill) ? `${skill}_get_markets` : skill === "betting" ? "betting_find_arbitrage" : `${skill}_get_scores`;
const route = (skills, mode, confidence, extra = {}) =>
  ({ selected_skills: skills, mode, confidence, reason: "mock", ...extra });

function textOf(messages) {
  return messages
    .map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text ?? "").join("\n")))
    .join("\n");
}
const isRouterCall = (call) => textOf(call.prompt.filter((m) => m.role === "system")).startsWith("You route sports queries");

function reply(text) {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: { inputTokens: { total: 4, noCache: 4 }, outputTokens: { total: 2, text: 2 } },
    warnings: [],
  };
}

/** Router replies with `state.route` (object → JSON, string → raw); every other call answers `state.answer`. */
function routerModel(state) {
  return new MockLanguageModelV3({
    doGenerate: async (call) =>
      reply(isRouterCall(call)
        ? typeof state.route === "string" ? state.route : JSON.stringify(state.route)
        : state.answer),
  });
}

function makeEngine(installed = ALL_SKILLS) {
  const state = { route: "NOT_JSON", answer: "unset" };
  const model = routerModel(state);
  const engine = new sportsclawEngine({ thinkingBudget: 0 });
  engine.mainModel = model;
  const specs = installed.map((skill) => ({
    name: toolNameFor(skill),
    description: `${skill} data`,
    input_schema: { type: "object", properties: {} },
  }));
  engine.registry = {
    getInstalledSkills: () => [...installed],
    getAllToolSpecs: () => specs,
    getSkillName: (name) => installed.find((skill) => name.startsWith(`${skill}_`)),
  };
  const mk = (name) => tool({ description: name, inputSchema: jsonSchema({ type: "object", properties: {} }), execute: async () => "{}" });
  engine.buildTools = () => Object.fromEntries([...specs.map((s) => s.name), "get_agent_config"].map((n) => [n, mk(n)]));
  const mainCalls = () => model.doGenerateCalls.filter((call) => !isRouterCall(call));
  return { engine, state, mainCalls };
}

/** Non-system turns the answer model saw, flattened to { role, text }. */
const turnsOf = (call) =>
  call.prompt.filter((m) => m.role !== "system").map((m) => ({ role: m.role, text: textOf([m]) }));
const offeredTools = (call) => (call.tools ?? []).map((t) => t.name).sort();

function assertPriorThenCurrent(call, current) {
  const turns = turnsOf(call);
  const q = turns.findIndex((t) => t.role === "user" && t.text === PRIOR_Q);
  const a = turns.findIndex((t) => t.role === "assistant" && t.text === PRIOR_A);
  assert.ok(q >= 0 && a > q, `prior arbitrage turns must reach the answer model: ${JSON.stringify(turns)}`);
  assert.deepEqual(turns.at(-1), { role: "user", text: current });
  assert.equal(turns.filter((t) => t.role === "user" && t.text === current).length, 1, "current message duplicated");
  assert.equal(turns.filter((t) => t.text === PRIOR_Q).length, 1, "prior message duplicated");
}

async function seedThread(userId) {
  const memory = new MemoryManager(userId);
  await memory.appendToThread(PRIOR_Q, PRIOR_A);
  await memory.appendExchange(PRIOR_Q, PRIOR_A);
}

describe("first-turn clarification goes through the answer model", () => {
  it("router needs_clarification on bare 'NBA' returns the model's tailored question, not the canned menu", async () => {
    const { engine, state, mainCalls } = makeEngine();
    state.route = route(["nba"], "focused", 0.9, { intent: "ambiguous", needs_clarification: true });
    state.answer = "Which NBA team or game should I check: Lakers, Celtics, or the full slate tonight?";

    const answer = await engine.run("NBA");

    assert.equal(mainCalls().length, 1, "the answer model must be invoked");
    assert.equal(answer, state.answer, "a needed, tailored clarification from the model is allowed through");
    assert.doesNotMatch(answer, CANNED);
  });

  it("low-confidence ambiguous route still answers through the model", async () => {
    const { engine, state, mainCalls } = makeEngine();
    state.route = route(["nba", "nfl"], "ambiguous", 0.3);
    state.answer = "Last night the Lakers beat the Celtics 112-104 in the NBA.";

    const answer = await engine.run("who won last night?");

    assert.equal(mainCalls().length, 1);
    assert.equal(answer, state.answer);
  });
});

describe("restored persistent thread", () => {
  it("a fresh engine follows the prior arbitrage task on the four-venue follow-up", async () => {
    await seedThread("arb-user");
    const { engine, state, mainCalls } = makeEngine();
    // Exactly the deployed failure: router picks one venue, low confidence, asks to clarify.
    state.route = route(["novig"], "focused", 0.3, { intent: "odds", needs_clarification: true });
    state.answer = "Arbitrage check across Polymarket, Kalshi, Novig and ProphetX for the Lakers line: no edge above fees.";

    const answer = await engine.run(FOLLOW_UP, { userId: "arb-user" });

    assert.doesNotMatch(answer, CANNED);
    assert.equal(answer, state.answer);
    const call = mainCalls().at(-1);
    assertPriorThenCurrent(call, FOLLOW_UP);

    // Memory stays non-authoritative user context, never system. (The memory
    // docs legitimately mention the `[MEMORY]` marker, so check the payload.)
    const system = textOf(call.prompt.filter((m) => m.role === "system"));
    assert.ok(!system.includes(MEMORY_SENTINEL), "the memory message must not be promoted to the system prompt");
    assert.ok(!system.includes(PRIOR_A), "prior assistant content must not be promoted to the system prompt");
    // Assert the composed prompt delivered to the answer model, not just the mock reply.
    assert.doesNotMatch(system, /Show the spread\/line, moneyline, and over\/under/);
    assert.match(system, /every requested venue/);
    assert.match(system, /prior conversation specifies a market/);
    assert.match(system, /current request.*retained conversation scope.*available evidence/);
    assert.ok(
      turnsOf(call).some((t) => t.role === "user" && t.text.startsWith(MEMORY_SENTINEL)),
      "memory is injected as a user-role message"
    );

    // Follow-up semantics: a low-confidence follow-up drops the routed filter
    // so the model can reach every venue from conversation context.
    const offered = offeredTools(call);
    for (const venue of VENUES) assert.ok(offered.includes(toolNameFor(venue)), `${venue} missing: ${offered}`);
  });

  it("a generic follow-up after restore counts as a follow-up: low confidence widens to every venue", async () => {
    // No venue is named, so routing alone yields only Novig. Every venue tool
    // is offered only if isFollowUp saw the restored thread.
    await seedThread("generic-user");
    const { engine, state, mainCalls } = makeEngine();
    state.route = route(["novig"], "focused", 0.3, { intent: "odds" });
    state.answer = "Novig, ProphetX, Polymarket and Kalshi checked for the Lakers line: no edge above fees.";

    const answer = await engine.run("And the other venues?", { userId: "generic-user" });

    assert.equal(answer, state.answer);
    const call = mainCalls().at(-1);
    assertPriorThenCurrent(call, "And the other venues?");
    const offered = offeredTools(call);
    for (const venue of VENUES) assert.ok(offered.includes(toolNameFor(venue)), `${venue} missing: ${offered}`);
  });

  it("a genuine topic switch to 'Lakers score' does not drag market tools from the prior arbitrage turn", async () => {
    await seedThread("switch-user");
    const { engine, state, mainCalls } = makeEngine();
    state.route = route(["nba"], "focused", 0.95, { intent: "live_scores" });
    state.answer = "Lakers lead the Celtics 88-80 late in the third quarter.";

    const answer = await engine.run("Lakers score", { userId: "switch-user" });

    assert.equal(answer, state.answer);
    const call = mainCalls().at(-1);
    assertPriorThenCurrent(call, "Lakers score");
    const offered = offeredTools(call);
    assert.ok(offered.includes("nba_get_scores"), `nba tools missing: ${offered}`);
    const market = offered.filter((name) => [...VENUES, "betting"].some((s) => name.startsWith(`${s}_`)));
    assert.deepEqual(market, [], "market tools leaked into a topic switch");
  });
});

describe("caller history and in-memory follow-ups stay supported", () => {
  it("same engine instance: second turn sees the first and answers through the model", async () => {
    const { engine, state, mainCalls } = makeEngine();
    state.route = route(["nba", "betting"], "focused", 0.9, { intent: "odds" });
    state.answer = PRIOR_A;
    await engine.run(PRIOR_Q);

    state.route = route(["novig"], "focused", 0.3, { needs_clarification: true });
    state.answer = "Polymarket, Kalshi, Novig and ProphetX checked for the Lakers line.";
    const answer = await engine.run(FOLLOW_UP);

    assert.equal(answer, state.answer);
    assertPriorThenCurrent(mainCalls().at(-1), FOLLOW_UP);
  });

  it("session history restored by sessionId is followed on a fresh engine", async () => {
    await sessionStore.save("continuity-session", [
      { role: "user", content: PRIOR_Q },
      { role: "assistant", content: [{ type: "text", text: PRIOR_A }] },
    ]);
    const { engine, state, mainCalls } = makeEngine();
    state.route = route(["novig"], "focused", 0.3, { needs_clarification: true });
    state.answer = "Polymarket, Kalshi, Novig and ProphetX checked for the Lakers line.";

    const answer = await engine.run(FOLLOW_UP, { sessionId: "continuity-session" });

    assert.equal(answer, state.answer);
    assertPriorThenCurrent(mainCalls().at(-1), FOLLOW_UP);
  });

  it("memory-only injection is not a prior conversation: routing stays narrowed", async () => {
    // Daily log only, no thread: the [MEMORY] block is injected but there is
    // no real prior turn, so low confidence must not widen to the registry.
    await new MemoryManager("memory-only-user").appendExchange(PRIOR_Q, PRIOR_A);
    const { engine, state, mainCalls } = makeEngine();
    state.route = route(["nba"], "focused", 0.3, { intent: "live_scores" });
    state.answer = "Lakers lead the Celtics 88-80 late in the third quarter.";

    await engine.run("Lakers score", { userId: "memory-only-user" });

    const call = mainCalls().at(-1);
    assert.deepEqual(turnsOf(call).filter((t) => t.role === "assistant"), [], "memory became a fake assistant turn");
    const offered = offeredTools(call);
    assert.ok(offered.includes("nba_get_scores"));
    assert.ok(!offered.some((name) => VENUES.some((v) => name.startsWith(`${v}_`))), `widened: ${offered}`);
  });
});

describe("market follow-ups keep venue, date and saved context", () => {
  // One line of the composed system prompt each; wording may differ, the rule may not.
  const CONTRACTS = {
    "a follow-up keeps the named venue and the date": /\bvenues?\b[^\n]*\bdates?\b|\bdates?\b[^\n]*\bvenues?\b/i,
    "the latest explicit correction beats older saved preferences":
      /\blatest\b[^\n]*\b(correction|instruction)s?\b[^\n]*\b(memory|preferences?|profile)\b|\b(memory|preferences?|profile)\b[^\n]*\blatest\b[^\n]*\b(correction|instruction)s?\b/i,
    "relevant interests across several sports stay in scope":
      /\binterests?\b[^\n]*\b(every|each|all|several|multiple)\b[^\n]*\b(sports?|leagues?)\b|\b(every|each|all|several|multiple)\b[^\n]*\b(sports?|leagues?)\b[^\n]*\binterests?\b/i,
    "an empty result covers only the scope that was read": /\bempty\b[^\n]*\b(only|just)\b[^\n]*\b(scope|source|venue)\b/i,
    "a failed or partial read is not an empty one": /\b(fail\w*|partial)\b[^\n]*\b(not|never)\b[^\n]*\bempty\b|\bempty\b[^\n]*\b(not|never)\b[^\n]*\b(fail\w*|partial)\b/i,
    "no invented internal cause": /\b(never|do not|don't)\b[^\n]*\b(invent|guess|speculate)\b[^\n]*\bcauses?\b/i,
    "no product or rollout promises": /\b(never|do not|don't)\b[^\n]*\b(promise|rollout)s?\b/i,
  };

  it("a four-turn Polymarket conversation keeps owned context as user turns and states the scope contracts", async () => {
    const userId = "market-scope-user";
    await new MemoryManager(userId).writeFanProfile(
      "PRIVATE_PROFILE_MARKER follows NBA (Lakers) and NFL (Chiefs); older venue preference: Kalshi"
    );
    const history = [
      { role: "user", content: "PRIVATE_HISTORY_MARKER Show my Polymarket markets for my teams tonight" },
      { role: "assistant", content: "Polymarket tonight: Lakers moneyline 0.55. NFL markets were not shown." },
      { role: "user", content: "Only Polymarket, not Kalshi. What about the NBA ones?" },
      { role: "assistant", content: "Polymarket NBA tonight: Lakers 0.55, Celtics 0.48." },
      { role: "user", content: "Why did you omit the NFL ones?" },
      { role: "assistant", content: "The NFL read did not return data, so I left it out." },
    ];
    const { engine, state, mainCalls } = makeEngine();
    state.route = route(["polymarket"], "focused", 0.9, { intent: "odds" });
    state.answer = "Tomorrow on Polymarket: Lakers 0.55. The NFL read failed, so NFL markets are unavailable here.";

    await engine.run("And tomorrow?", { userId, historyMode: "caller", history });

    const call = mainCalls().at(-1);
    const turns = turnsOf(call);
    let at = -1;
    for (const turn of history) {
      const next = turns.findIndex((t, i) => i > at && t.role === turn.role && t.text === turn.content);
      assert.ok(next > at, `history turn missing or out of order: ${turn.content}`);
      at = next;
    }
    assert.deepEqual(turns.at(-1), { role: "user", text: "And tomorrow?" });
    assert.ok(
      turns.some((t) => t.role === "user" && t.text.startsWith(MEMORY_SENTINEL) && t.text.includes("PRIVATE_PROFILE_MARKER")),
      "saved profile is injected as user-role memory"
    );
    const system = textOf(call.prompt.filter((m) => m.role === "system"));
    for (const marker of ["PRIVATE_PROFILE_MARKER", "PRIVATE_HISTORY_MARKER", "Why did you omit the NFL ones?"]) {
      assert.ok(!system.includes(marker), `${marker} must not be promoted to the system prompt`);
    }
    for (const [label, contract] of Object.entries(CONTRACTS)) assert.match(system, contract, label);
  });

  it("calendar-date lookups pass the user's latest explicit IANA timezone, never a UTC default, as a generic instruction", async () => {
    const history = [
      { role: "user", content: "I'm in America/Los_Angeles. Polymarket NBA markets tonight?" },
      { role: "assistant", content: "Polymarket NBA tonight: Synthetic Home 0.55." },
      { role: "user", content: "Use America/Sao_Paulo from now on." },
      { role: "assistant", content: "Noted: America/Sao_Paulo." },
    ];
    const { engine, state, mainCalls } = makeEngine();
    state.route = route(["polymarket", "nba"], "focused", 0.9, { intent: "odds" });
    state.answer = "Polymarket NBA tomorrow: Synthetic Home 0.55.";

    await engine.run("And tomorrow?", { historyMode: "caller", history });

    const call = mainCalls().at(-1);
    const system = textOf(call.prompt.filter((m) => m.role === "system"));
    // One line each; wording may differ, the rule may not.
    const TIMEZONE = {
      "the user's IANA timezone is passed when the tool offers one": /\bIANA\b[^\n]*\btime ?zones?\b|\btime ?zones?\b[^\n]*\bIANA\b/i,
      "for calendar-date queries": /\bdates?\b[^\n]*\btime ?zones?\b|\btime ?zones?\b[^\n]*\bdates?\b/i,
      "not a UTC default for a non-UTC user": /\b(never|not|don't|do not|instead of)\b[^\n]*\bUTC\b/i,
      "the latest explicit timezone wins": /\blatest\b[^\n]*\btime ?zones?\b|\btime ?zones?\b[^\n]*\blatest\b/i,
    };
    for (const [label, contract] of Object.entries(TIMEZONE)) assert.match(system, contract, label);
    assert.ok(!system.includes("America/Sao_Paulo"), "the user's timezone stays user content, never system text");
    assert.ok(turnsOf(call).some((t) => t.role === "user" && t.text.includes("America/Sao_Paulo")));
  });
});

describe("routePromptToSkills keeps every explicitly requested venue", () => {
  const baseConfig = {
    routingMode: "soft_lock",
    routingMaxSkills: 2,
    routingAllowSpillover: 1,
    thinkingBudget: 0,
    tokenBudgets: DEFAULT_TOKEN_BUDGETS,
  };
  const specsFor = (installed) =>
    installed.map((s) => ({ name: toolNameFor(s), description: s, input_schema: { type: "object", properties: {} } }));
  const routeWith = (llmReply, installed = ALL_SKILLS, prompt = FOLLOW_UP) =>
    routePromptToSkills({
      prompt,
      installedSkills: installed,
      toolSpecs: specsFor(installed),
      recentContext: `${PRIOR_Q} | ${prompt}`,
      model: routerModel({ route: llmReply }),
      modelId: "mock-model",
      provider: "anthropic",
      config: baseConfig,
    });

  for (const [label, llmReply] of [
    ["LLM wrongly selects only Novig (focused)", route(["novig"], "focused", 0.9)],
    ["router returns NOT_JSON", "NOT_JSON"],
  ]) {
    it(`${label}: all four venues survive the cap, no unrelated sport`, async () => {
      const { decision } = await routeWith(llmReply);
      for (const venue of VENUES) assert.ok(decision.selectedSkills.includes(venue), `${venue} dropped: ${decision.selectedSkills}`);
      assert.ok(!decision.selectedSkills.includes("nfl") && !decision.selectedSkills.includes("mlb"), `${decision.selectedSkills}`);
    });
  }

  it("with only three venues installed it never invents the fourth", async () => {
    const installed = ALL_SKILLS.filter((s) => s !== "prophetx");
    for (const llmReply of [route(["novig", "prophetx"], "focused", 0.9), "NOT_JSON"]) {
      const { decision } = await routeWith(llmReply, installed);
      assert.ok(decision.selectedSkills.every((s) => installed.includes(s)), `${decision.selectedSkills}`);
      for (const venue of ["polymarket", "kalshi", "novig"]) assert.ok(decision.selectedSkills.includes(venue));
    }
  });

  it("'NBA score' after an arbitrage turn routes no market skills", async () => {
    const { decision } = await routeWith("NOT_JSON", ALL_SKILLS, "NBA score");
    assert.ok(decision.selectedSkills.includes("nba"));
    assert.ok(!decision.selectedSkills.some((s) => [...VENUES, "betting"].includes(s)), `${decision.selectedSkills}`);
  });
});

describe("provider tool ceiling is not weakened by follow-up widening", () => {
  it("an oversized registry keeps the routed filter on a low-confidence follow-up and never truncates", () => {
    const routed = ["nba_get_scores"];
    assert.deepEqual(
      finalizeActiveTools({ routedActiveTools: routed, isFollowUp: true, lowConfidence: true, historyToolNames: [], totalToolCount: 291, ceiling: 128 }),
      routed
    );
    assert.throws(
      () => finalizeActiveTools({
        routedActiveTools: Array.from({ length: 129 }, (_, i) => `t${i}`),
        isFollowUp: true, lowConfidence: false, historyToolNames: [], totalToolCount: 291, ceiling: 128,
      }),
      ProviderToolCeilingError
    );
  });
});
