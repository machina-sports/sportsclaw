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

it("pick guidance keeps the established market and permits evidence-based uncertainty", async () => {
  const { buildTemplatePrompt } = await import("../dist/response-templates.js");
  const hint = buildTemplatePrompt("best_bets");
  assert.doesNotMatch(hint, /no hedging/i);
  assert.match(hint, /venue.*market.*conversation/i);
  assert.match(hint, /qualified lean/i);
  assert.match(hint, /edge.*evidence/i);
});

it("live and schedule templates preserve complete scores without unsolicited betting metadata", async () => {
  const { buildTemplatePrompt } = await import("../dist/response-templates.js");
  for (const intent of ["live_scores", "schedule"]) {
    const hint = buildTemplatePrompt(intent);
    assert.match(hint, /observation/i);
    assert.match(hint, /requested scope/i);
    assert.match(hint, /odds.*only.*asked/i);
    assert.doesNotMatch(hint, /under 5 lines/i);
  }
});

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

describe("live, results and schedule answers", () => {
  // Each rule must be one line of the composed system prompt carrying every listed term; wording may differ.
  const RULES = {
    "a brief conversational lead": [/\b(short|brief)\b/i, /\b(lead|open|start)\w*\b/i, /\b(scores?|results?|schedules?|updates?)\b/i],
    "score and status for each game when provided": [/\bscores?\b/i, /\bstatus\b/i, /\b(each|every|per)\b[^\n]*\bgames?\b/i],
    "a W-L record is not a score": [/\brecords?\b/i, /\b(not|never)\b/i, /\b(scores?|points)\b/i],
    "no silently omitted requested game": [/\b(omit|drop|skip)\w*\b/i, /\b(requested|asked)\b/i, /\bgames?\b/i],
    "no global coverage from a partial scope": [/\bpartial\b/i, /\b(all|every|complete|global)\b/i, /\b(coverage|games|scope)\b/i, /\b(claim|imply|say|present)\w*\b/i],
    "no unsolicited odds": [/\b(odds|betting lines?)\b/i, /\b(unless|only when|only if|unsolicited|unrequested|not asked)\b/i],
  };
  const lineWith = (system, terms) => system.split("\n").some((line) => terms.every((term) => term.test(line)));

  // The same rules hold for any wording or language: they are not keyed on the user's words.
  for (const prompt of ["How’s playing today", "Como estão os jogos de hoje?", "Resultados de anoche"]) {
    it(`${JSON.stringify(prompt)}: the composed main prompt states the score-answer rules`, async () => {
      const { engine, state, mainCalls } = makeEngine();
      state.route = route(["nba", "nfl"], "focused", 0.9, { intent: "live_scores" });
      state.answer = "Busy night: Lakers 112-104 Celtics (Final); Chiefs 21-17 Bills (Q3 4:12).";
      await engine.run(prompt);
      const system = textOf(mainCalls().at(-1).prompt.filter((m) => m.role === "system"));
      for (const [label, terms] of Object.entries(RULES)) assert.ok(lineWith(system, terms), label);
    });
  }
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

describe("main prompt: refresh the retained scope before calling it missing", () => {
  it("one generic line tells the model to read the earlier board or scope again before reporting its data unavailable", async () => {
    const { engine, state, mainCalls } = makeEngine();
    state.route = route(["polymarket"], "focused", 0.9, { intent: "odds" });
    state.answer = "Lakers on Polymarket at 0.57.";
    await engine.run("Which of them should I choose?", {
      historyMode: "caller",
      history: [
        { role: "user", content: "Show me tonight's Polymarket NBA board" },
        { role: "assistant", content: "Polymarket NBA tonight: Lakers 0.55, Celtics 0.48." },
      ],
    });
    const lines = textOf(mainCalls().at(-1).prompt.filter((m) => m.role === "system")).split("\n");
    assert.ok(
      lines.some((line) =>
        /\b(refresh|re-?read|re-?fetch|read again|fetch again)\w*\b/i.test(line) &&
        /\b(earlier|prior|previous|history)\b/i.test(line) &&
        /\b(missing|unavailable|absent)\b/i.test(line)),
      "no generic instruction to refresh the retained board/scope before claiming its data is missing"
    );
  });
});

// Public-data mode (Jev routing advice + operator pool, Jev evidence checks).
// Mirrors the native probe: the main model reads only nba_get_scoreboard, then
// picks from the earlier Polymarket board plus the new DraftKings spread. Only
// the model (SDK mock), the Jev HTTP transport, the registry and tool bodies are
// stubbed; routing, pool authority, verification and correction are real.
describe("public-data correction refreshes the retained board through approved readers", () => {
  const POLY_READERS = ["polymarket_get_sports_events", "polymarket_get_todays_events"];
  // Fixture-only names: a same-skill write tool and a private pod tool, never in the pool.
  const WRITE_TOOL = "polymarket_place_order";
  const PRIVATE_TOOL = "mcp__pod__search_documents";
  const OTHER_SPORT = "nfl_get_scoreboard";
  const SPECS = ["nba_get_scoreboard", OTHER_SPORT, ...POLY_READERS, WRITE_TOOL, PRIVATE_TOOL];
  const FORBIDDEN = [WRITE_TOOL, PRIVATE_TOOL, OTHER_SPORT];
  const POLY_MARKER = "POLY_FRESH_ROW";
  const HISTORY = [
    { role: "user", content: "PRIOR_REQUEST_MARKER Show me tonight's Polymarket NBA board" },
    { role: "assistant", content: "PRIOR_BOARD_MARKER Polymarket NBA tonight: Lakers 0.55, Celtics 0.48." },
  ];
  const SCOREBOARD = JSON.stringify({ events: [{ name: "Lakers at Celtics", odds: { provider: "DraftKings", spread: "LAL -4.5" } }] });
  const POLY_ROWS = JSON.stringify({ events: [{ title: `${POLY_MARKER} Lakers vs Celtics`, outcomes: [{ name: "Lakers", price: 0.57 }] }] });
  const STALE_DRAFT = "Take the Lakers on Polymarket at 0.55 from the earlier board; DraftKings has them -4.5.";
  const FRESH_PICK = "Take the Lakers on Polymarket at 0.57; DraftKings has them -4.5.";
  // What the probe's pure correction produced: the DraftKings pick plus an unchecked Polymarket absence.
  const OLD_REFUSAL = "Take the DraftKings spread, Lakers -4.5. Polymarket is unavailable right now.";
  const FAILED_PICK = "The Polymarket read failed this turn, so its prices could not be checked; DraftKings has the Lakers -4.5.";
  const ABSENCE = /\bno (polymarket )?markets?\b|\bpolymarket (has|had) no\b/i;

  const systemOf = (call) => textOf(call.prompt.filter((m) => m.role === "system"));
  const toolResultsOf = (call) =>
    call.prompt
      .filter((m) => m.role === "tool" && Array.isArray(m.content))
      .flatMap((m) => m.content)
      .filter((p) => p?.type === "tool-result")
      .map((p) => ({
        toolName: p.toolName,
        failed: String(p.output?.type ?? "").startsWith("error"),
        text: JSON.stringify(p.output ?? ""),
      }));
  let seq = 0;
  const callTools = (names, input = {}) => ({
    content: names.map((toolName) => ({ type: "tool-call", toolCallId: `call-${++seq}`, toolName, input: JSON.stringify(input) })),
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage: { inputTokens: { total: 4, noCache: 4 }, outputTokens: { total: 2, text: 2 } },
    warnings: [],
  });
  /** Same rule for Jev and the generative checker: a Polymarket claim needs fresh Polymarket rows or a recorded Polymarket failure. */
  const needsFreshPoly = (raw, draft, status) =>
    /polymarket/i.test(draft) && !raw.includes(POLY_MARKER) && !/failed this turn[^\n]*polymarket_/i.test(status);

  function scenarioModel(state) {
    return new MockLanguageModelV3({
      doGenerate: async (call) => {
        const system = systemOf(call);
        const offered = offeredTools(call);
        const results = toolResultsOf(call);
        if (system.startsWith("You route sports queries")) {
          return reply(JSON.stringify(route(["nba", "polymarket"], "focused", 0.9, { intent: "odds" })));
        }
        if (system.startsWith("You are a task-completion reviewer")) {
          // The focused task review after factual support: no raw batches here; this suite's
          // venue rule is factual (fresh rows), so the review accepts.
          const body = textOf(call.prompt.filter((m) => m.role !== "system"));
          state.scopes.push({ body });
          return reply(JSON.stringify({ isValid: true, discrepancies: [] }));
        }
        if (system.startsWith("You are a strict sports fact-checker")) {
          const body = textOf(call.prompt.filter((m) => m.role !== "system"));
          const rawAt = body.indexOf("Raw source data");
          const draftAt = body.indexOf("Draft response to check:");
          state.checks.push({ body, raw: body.slice(rawAt, draftAt) });
          const bad = needsFreshPoly(body.slice(rawAt, draftAt), body.slice(draftAt), system);
          return reply(JSON.stringify(bad
            ? { isValid: false, discrepancies: [{ claim: "Polymarket pick", evidence: "no current Polymarket rows", severity: "high", kind: "unsupported" }] }
            : { isValid: true, discrepancies: [] }));
        }
        if (system.startsWith("You are an expert sports editor")) {
          state.corrections.push({ offered, prompt: textOf(call.prompt.filter((m) => m.role !== "system")) });
          // Observational: ask for every interesting tool actually offered; with none, emit the probe's old refusal.
          const wanted = offered.filter((name) => [...POLY_READERS, ...FORBIDDEN].includes(name));
          if (wanted.length > 0 && (state.greedy || results.length === 0)) {
            return callTools(wanted, state.greedy ? { page: state.corrections.length } : {});
          }
          if (results.some((r) => !r.failed && r.text.includes(POLY_MARKER))) return reply(FRESH_PICK);
          if (results.some((r) => r.failed && r.toolName.startsWith("polymarket_"))) return reply(FAILED_PICK);
          return reply(OLD_REFUSAL);
        }
        state.mains.push({ offered });
        if (results.length === 0) {
          const reads = state.mainReads.filter((name) => offered.includes(name));
          if (reads.length > 0) return callTools(reads);
        }
        return reply(results.some((r) => r.text.includes(POLY_MARKER)) ? FRESH_PICK : STALE_DRAFT);
      },
    });
  }

  /** Jev decision endpoint stub: routing advises nba only; evidence applies needsFreshPoly to coverage_freshness. */
  function jevTransport(state) {
    const choice = (criteria, picked) => {
      const keys = Object.keys(criteria);
      const rest = 0.03 / (keys.length - 1);
      return { type: "choice", choice: picked, confidence: 0.99, probabilities: Object.fromEntries(keys.map((k) => [k, k === picked ? 0.97 : rest])) };
    };
    return async (_url, init) => {
      const body = JSON.parse(init.body);
      const answers = {};
      if ("disposition" in body.questions) {
        const described = new Map(body.state.capabilities.map((c) => [c.ref, c.description]));
        for (const [id, q] of Object.entries(body.questions)) {
          answers[id] = choice(q.criteria, id === "disposition" ? "select" : described.get(id).includes('"nba"') ? "required" : "not_required");
        }
      } else {
        const s = body.state;
        const rawAt = s.indexOf("Raw source data (");
        const draftAt = s.indexOf("Draft response to judge:");
        const entry = { state: s, status: s.slice(0, rawAt), raw: s.slice(rawAt, draftAt), draft: s.slice(draftAt) };
        state.evidence.push(entry);
        const bad = needsFreshPoly(entry.raw, entry.draft, entry.status);
        for (const [id, q] of Object.entries(body.questions)) {
          answers[id] = choice(q.criteria, bad && id === "coverage_freshness" ? "contradicted" : "supported");
        }
      }
      return new Response(JSON.stringify({ model: body.model, answers }), { status: 200, headers: { "content-type": "application/json" } });
    };
  }

  function makePublicEngine({ pool = POLY_READERS, allowlist, publicData = true, mainReads = ["nba_get_scoreboard"], failPoly = false, greedy = false } = {}) {
    const state = { evidence: [], checks: [], scopes: [], corrections: [], mains: [], executed: [], mainReads, greedy };
    const env = { TYPESAFE_API_KEY: "test-only" };
    const transport = jevTransport(state);
    const engine = new sportsclawEngine({
      thinkingBudget: 0,
      ...(publicData
        ? {
            routing: { provider: "jev", dataPolicy: "cloud_allowed", publicDataTools: pool, transport, env },
            evidenceVerifier: { provider: "jev", dataPolicy: "cloud_allowed", publicToolNames: ["nba_get_scoreboard", ...POLY_READERS], transport, env },
          }
        : { evidenceVerifier: { provider: "generative", generativeAction: "correct" } }),
    });
    engine.mainModel = scenarioModel(state);
    const installed = ["nba", "nfl", "polymarket"];
    const specs = SPECS.map((name) => ({ name, description: `${name} data`, input_schema: { type: "object", properties: {} } }));
    engine.registry = {
      getInstalledSkills: () => [...installed],
      getAllToolSpecs: () => specs,
      getSkillName: (name) => (name.startsWith("mcp__") ? undefined : installed.find((skill) => name.startsWith(`${skill}_`))),
    };
    engine.buildTools = () => Object.fromEntries([...SPECS, "get_agent_config"].map((name) => [name, tool({
      description: name,
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      execute: async () => {
        state.executed.push({ name, phase: state.corrections.length > 0 ? "correction" : "main" });
        if (name === "nba_get_scoreboard") return SCOREBOARD;
        if (POLY_READERS.includes(name)) {
          if (failPoly) throw new Error("upstream 503");
          return POLY_ROWS;
        }
        return "{}";
      },
    })]));
    if (allowlist) engine.setToolAllowlist(allowlist);
    return { engine, state };
  }
  const run = (engine, prompt = "Which of them should I choose?") => engine.run(prompt, { historyMode: "caller", history: HISTORY });
  const correctionReads = (state) => state.executed.filter((e) => e.phase === "correction").map((e) => e.name);
  const correctionOffered = (state) => new Set(state.corrections.flatMap((c) => c.offered));

  // Any wording or language: nothing here is keyed on the user's phrasing.
  for (const prompt of ["Which of them should I choose?", "Qual delas devo escolher?"]) {
    it(`${JSON.stringify(prompt)}: wrong-source board -> coverage fault -> correction reads an approved Polymarket reader -> recheck judges fresh rows`, async () => {
      const { engine, state } = makePublicEngine();
      const answer = await run(engine, prompt);

      // Fixture fidelity with the probe: pool offered the readers, main read only the scoreboard.
      assert.ok(POLY_READERS.every((name) => state.mains[0]?.offered.includes(name)), `pool readers not offered to main: ${state.mains[0]?.offered}`);
      assert.deepEqual(state.executed.filter((e) => e.phase === "main").map((e) => e.name), ["nba_get_scoreboard"]);
      assert.ok(state.evidence[0]?.draft.includes(STALE_DRAFT), "the first check judges the stale-board draft");

      // The correction keeps the user's intent from user turns only.
      assert.ok(state.corrections[0]?.prompt.includes("PRIOR_REQUEST_MARKER"), "prior user request missing from correction context");
      const firstRaw = state.corrections[0].prompt.slice(
        state.corrections[0].prompt.indexOf("Raw source data"), state.corrections[0].prompt.indexOf("Original draft response"));
      assert.ok(!firstRaw.includes("PRIOR_BOARD_MARKER"), "stale assistant board entered the correction's source data");

      const offered = correctionOffered(state);
      assert.ok(POLY_READERS.some((name) => offered.has(name)), `no approved Polymarket reader offered to the correction: [${[...offered]}]`);
      for (const name of FORBIDDEN) assert.ok(!offered.has(name), `${name} offered to the correction`);
      const reads = correctionReads(state);
      assert.ok(reads.length > 0 && reads.every((name) => POLY_READERS.includes(name)), `correction reads: [${reads}]`);
      assert.ok(state.corrections.length <= 3, `correction steps: ${state.corrections.length}`);

      // One check plus one bounded recheck, and the recheck sees the fresh source.
      assert.equal(state.evidence.length, 2, "exactly one check and one recheck");
      assert.ok(state.evidence[1].raw.includes(POLY_MARKER), "the recheck did not receive the fresh Polymarket output");
      for (const e of state.evidence) {
        assert.ok(!e.state.includes("PRIOR_BOARD_MARKER"), "stale assistant board reached Jev");
        assert.ok(!e.raw.includes("0.55"), "a stale assistant price was counted as raw source data");
      }
      // Jev supported only the recheck: exactly one focused task review, then, with no raw batch or prior board.
      assert.equal(state.checks.length, 0, "no duplicate primary factual check after Jev");
      assert.equal(state.scopes.length, 1, "one task review after the supported recheck");
      for (const s of state.scopes) {
        assert.ok(s.body.includes(FRESH_PICK), "the task review judges the corrected pick");
        assert.ok(s.body.includes("PRIOR_REQUEST_MARKER"), "with the prior user request");
        assert.ok(!s.body.includes("PRIOR_BOARD_MARKER") && !s.body.includes(POLY_MARKER) && !s.body.includes("Raw source data"), "no prior board or raw batch");
      }
      assert.equal(answer, FRESH_PICK, "the corrected pick keeps the Polymarket venue with the fresh price");
    });
  }

  it("an already supported draft is not corrected", async () => {
    const { engine, state } = makePublicEngine({ mainReads: ["nba_get_scoreboard", "polymarket_get_sports_events"] });
    const answer = await run(engine);
    assert.equal(answer, FRESH_PICK);
    assert.equal(state.corrections.length, 0, "a supported draft must not be corrected");
    assert.equal(state.evidence.length, 1);
    assert.deepEqual(correctionReads(state), []);
  });

  it("a failed correction lookup stays a failure: the recheck gets the updated failures and the answer claims no absence", async () => {
    const { engine, state } = makePublicEngine({ failPoly: true });
    const answer = await run(engine);
    const reads = correctionReads(state);
    assert.ok(reads.some((name) => POLY_READERS.includes(name)), `the approved reader was never attempted: [${reads}]`);
    assert.equal(state.evidence.length, 2);
    assert.match(state.evidence[1].status, /failed this turn[^\n]*polymarket_/i, "the recheck did not receive the correction's failed reads");
    assert.doesNotMatch(answer, ABSENCE);
    assert.equal(answer, FAILED_PICK);
  });

  it("bounded: a correction that keeps asking for reads stops within 3 steps, one recheck, no scope creep", async () => {
    const { engine, state } = makePublicEngine({ greedy: true });
    const answer = await run(engine);
    assert.ok(state.corrections.length <= 3, `correction steps: ${state.corrections.length}`);
    assert.ok(state.evidence.length <= 2, `checks: ${state.evidence.length}`);
    const reads = correctionReads(state);
    assert.ok(reads.length > 0, "the correction executed no approved read");
    assert.ok(reads.every((name) => POLY_READERS.includes(name)), `scope creep: [${reads}]`);
    assert.ok(!state.executed.some((e) => FORBIDDEN.includes(e.name)), "forbidden tool executed");
    assert.doesNotMatch(answer, ABSENCE);
  });

  it("an unapproved reader stays out of the correction even when another reader is approved", async () => {
    const { engine, state } = makePublicEngine({ pool: ["polymarket_get_todays_events"] });
    await run(engine);
    const offered = correctionOffered(state);
    assert.ok(!offered.has("polymarket_get_sports_events"), "unapproved reader offered to the correction");
    assert.ok(!state.executed.some((e) => e.name === "polymarket_get_sports_events"), "unapproved reader executed");
    assert.ok(correctionReads(state).includes("polymarket_get_todays_events"), "the approved reader was not used by the correction");
  });

  it("caller-denied readers are never executed by the correction", async () => {
    const allowlist = [...SPECS, "get_agent_config"].filter((name) => !POLY_READERS.includes(name));
    const { engine, state } = makePublicEngine({ allowlist });
    const answer = await run(engine);
    for (const name of POLY_READERS) assert.ok(!correctionOffered(state).has(name), `${name} offered despite the caller allowlist`);
    assert.ok(!state.executed.some((e) => POLY_READERS.includes(e.name)), "a caller-denied reader executed");
    assert.ok(!state.executed.some((e) => FORBIDDEN.includes(e.name)));
    assert.ok(state.evidence.length <= 2);
    assert.doesNotMatch(answer, ABSENCE);
  });

  it("outside public-data mode the correction stays a pure rewrite: no tools offered or executed", async () => {
    const { engine, state } = makePublicEngine({ publicData: false });
    await run(engine);
    assert.ok(state.checks.length >= 1, "the generative checker ran");
    assert.ok(state.corrections.length >= 1, "the opt-in correction ran");
    assert.deepEqual([...correctionOffered(state)], [], "tools offered to a non-public-data correction");
    assert.deepEqual(correctionReads(state), []);
    for (const check of state.checks) assert.ok(!check.raw.includes("PRIOR_BOARD_MARKER"), "stale assistant board counted as checker source data");
  });
});

// Truth is not fulfilment. The prior user turn asked for the Polymarket NBA
// moneyline board; the current turn asks for a shareable report with picks and
// team stats. The main model reads only true DraftKings odds and standings and
// writes an honestly disclaimed DraftKings report. Jev supports every fact
// (it judges facts and gets no history), so the existing primary checker, with
// the user context already approved for the main model, is the bounded task
// fidelity gate: one correction that may read the approved same venue, one
// recheck, otherwise withhold. The latest explicit instruction still wins.
// Only the model, the Jev transport, the registry and tool bodies are stubbed.
describe("contextual report fidelity: a true substitute venue is not the requested one", () => {
  const POLY_READERS = ["polymarket_get_sports_events", "polymarket_get_todays_events"];
  const NBA_READS = ["nba_get_scoreboard", "nba_get_standings"];
  const SPECS = [...NBA_READS, ...POLY_READERS];
  const POLY_MARKER = "POLY_FIDELITY_ROW";
  const PRIOR_REQUEST = "PRIOR_FIDELITY_REQUEST Show me tonight's Polymarket NBA moneyline board";
  const PRIOR_BOARD = "PRIOR_FIDELITY_BOARD Polymarket NBA moneylines tonight: Lakers 0.55, Celtics 0.48.";
  const HISTORY = [
    { role: "user", content: PRIOR_REQUEST },
    { role: "assistant", content: PRIOR_BOARD },
  ];
  const PROFILE_MARKER = "PRIVATE_FIDELITY_PROFILE";
  const REPORT_ASK = "Make me a shareable report with picks and team stats";
  const SWITCHED_ASK = "Make me a shareable report with picks and team stats, using DraftKings odds this time";
  const STANDALONE_ASK = "Make me a shareable report with DraftKings NBA moneyline picks and team stats";
  const SCOREBOARD = JSON.stringify({ events: [{ name: "Lakers at Celtics", odds: { provider: "DraftKings", moneyline: { LAL: -150, BOS: 130 } } }] });
  const STANDINGS = JSON.stringify({ standings: [{ team: "Lakers", wins: 30, losses: 10 }, { team: "Celtics", wins: 28, losses: 12 }] });
  const POLY_ROWS = JSON.stringify({ events: [{ title: `${POLY_MARKER} Lakers vs Celtics`, market: "moneyline", outcomes: [{ name: "Lakers", price: 0.57 }] }] });
  // True, Jev-supportable and honestly disclaimed, and still not what the conversation asked for.
  const SUBSTITUTED = "Report: Polymarket prices were not available here, so these picks use DraftKings: Lakers moneyline -150. Standings: Lakers 30-10, Celtics 28-12.";
  const SUBSTITUTED_PICK = "Pick the Lakers: DraftKings has them at -150. Polymarket prices were not available here.";
  const FAITHFUL = "Report: Polymarket moneyline picks: Lakers at 0.57. Standings: Lakers 30-10, Celtics 28-12.";
  const SWITCHED = "Report: DraftKings moneyline picks: Lakers -150. Standings: Lakers 30-10, Celtics 28-12.";
  const reportHtml = (lead) =>
    "<!doctype html><html><head><title>NBA picks</title><style>table{border-collapse:collapse}td{padding:.3rem}</style></head>" +
    `<body><h1>Shareable NBA report</h1>${lead}<table><tr><td>Lakers</td><td>30-10</td></tr><tr><td>Celtics</td><td>28-12</td></tr></table></body></html>`;
  const SUBSTITUTED_HTML = reportHtml("<p>Polymarket prices were not available here; DraftKings picks: Lakers moneyline -150.</p>");
  const FAITHFUL_HTML = reportHtml("<p>Polymarket moneyline picks: Lakers at 0.57.</p>");
  const NONCE = "nonce_fidelity0123456789";
  // One line of the corrector's instructions; wording may differ, the rule may not.
  const FULL_HTML_DIRECTIVE = /\b(complete|full|whole|entire)\b[^\n]*\bHTML\b[^\n]*\bdocument\b|\bHTML\b[^\n]*\bdocument\b[^\n]*\b(complete|full|whole|entire)\b/i;
  const WITHHELD_TEXT = /could not verify/i;

  const systemOf = (call) => textOf(call.prompt.filter((m) => m.role === "system"));
  const toolResultsOf = (call) =>
    call.prompt
      .filter((m) => m.role === "tool" && Array.isArray(m.content))
      .flatMap((m) => m.content)
      .filter((p) => p?.type === "tool-result")
      .map((p) => ({ toolName: p.toolName, failed: String(p.output?.type ?? "").startsWith("error"), text: JSON.stringify(p.output ?? "") }));
  let seq = 0;
  const step = (content) => ({
    content,
    finishReason: { unified: "tool-calls", raw: "tool_calls" },
    usage: { inputTokens: { total: 4, noCache: 4 }, outputTokens: { total: 2, text: 2 } },
    warnings: [],
  });
  const callTools = (names) =>
    step(names.map((toolName) => ({ type: "tool-call", toolCallId: `fid-${++seq}`, toolName, input: "{}" })));
  const submitReport = (html) =>
    step([{ type: "tool-call", toolCallId: `fid-${++seq}`, toolName: "submit_artifact", input: JSON.stringify({ title: "Shareable NBA report", html }) }]);

  /**
   * The primary checker's semantic judgment, fixture-side: the retained user
   * context asked for Polymarket, the current request names no other venue, and
   * the answer does not carry a fresh Polymarket price. Facts alone never pass it.
   */
  // The factual checker and the task-completion reviewer are separate primary calls:
  // facts are true here, so only the scope reviewer can object, and it sees no raw source batches.
  const scopeParts = (body) => {
    const requestAt = body.indexOf("User request:");
    const request = requestAt >= 0 ? body.slice(requestAt).split("\n")[0] : "";
    return {
      context: requestAt >= 0 ? body.slice(0, requestAt) : "",
      request,
      answer: requestAt >= 0 ? body.slice(requestAt + request.length) : body,
    };
  };
  const scopeFault = (body) => {
    const { context, request, answer } = scopeParts(body);
    return /polymarket/i.test(context) && !/draftkings/i.test(request) && !answer.includes("0.57");
  };
  /** Raw factual-source batches and labels: the fact prompt keeps them, the scope prompt never carries them. */
  const RAW_BATCH = /"wins":30|"provider":"DraftKings"|POLY_FIDELITY_ROW|Raw source data|\[Internal source/;
  const isScopeSystem = (system) => system.startsWith("You are a task-completion reviewer");

  function fidelityModel(state) {
    return new MockLanguageModelV3({
      doGenerate: async (call) => {
        const system = systemOf(call);
        const offered = offeredTools(call);
        const results = toolResultsOf(call);
        if (system.startsWith("You route sports queries")) {
          return reply(JSON.stringify(route(["nba", "polymarket"], "focused", 0.9, { intent: "odds" })));
        }
        if (isScopeSystem(system)) {
          const body = textOf(call.prompt.filter((m) => m.role !== "system"));
          state.scopes.push({ body, system });
          state.order.push("scope");
          if (state.scope === "garbage") return reply("not json");
          return reply(JSON.stringify(scopeFault(body)
            ? { isValid: false, discrepancies: [{ claim: "DraftKings picks in the report", evidence: "the user asked for the Polymarket moneyline board", severity: "high", kind: "scope" }] }
            : { isValid: true, discrepancies: [] }));
        }
        if (system.startsWith("You are a strict sports fact-checker")) {
          const body = textOf(call.prompt.filter((m) => m.role !== "system"));
          state.checks.push({ body, system });
          state.order.push("fact");
          if (state.checker === "garbage") return reply("not json");
          // Every fact in every draft here is true: the factual checker accepts it.
          return reply(JSON.stringify({ isValid: true, discrepancies: [] }));
        }
        if (system.startsWith("You are an expert sports editor")) {
          const prompt = textOf(call.prompt.filter((m) => m.role !== "system"));
          state.corrections.push({ offered, system, prompt });
          // "stubborn": keeps the substitute and its disclaimer, never reads.
          if (state.editor === "stubborn") return reply(state.artifact ? SUBSTITUTED_HTML : SUBSTITUTED);
          const wanted = offered.filter((name) => POLY_READERS.includes(name));
          if (wanted.length > 0 && results.length === 0) return callTools(wanted);
          if (results.some((r) => !r.failed && r.text.includes(POLY_MARKER))) {
            return reply(FULL_HTML_DIRECTIVE.test(system) ? FAITHFUL_HTML : FAITHFUL);
          }
          return reply(SUBSTITUTED);
        }
        state.mains.push({ offered });
        if (results.length === 0) {
          const reads = state.mainReads.filter((name) => offered.includes(name));
          if (reads.length > 0) return callTools(reads);
        }
        if (state.artifact && offered.includes("submit_artifact") && !results.some((r) => r.toolName === "submit_artifact")) {
          return submitReport(state.artifactHtml);
        }
        return reply(state.draft);
      },
    });
  }

  /** Jev: routing advises nba; every evidence question is supported, unless told to refuse. */
  function fidelityJev(state) {
    const json = { "content-type": "application/json" };
    const choice = (criteria, picked) => {
      const keys = Object.keys(criteria);
      const rest = 0.03 / (keys.length - 1);
      return { type: "choice", choice: picked, confidence: 0.99, probabilities: Object.fromEntries(keys.map((k) => [k, k === picked ? 0.97 : rest])) };
    };
    return async (_url, init) => {
      const body = JSON.parse(init.body);
      const answers = {};
      if ("disposition" in body.questions) {
        const described = new Map(body.state.capabilities.map((c) => [c.ref, c.description]));
        for (const [id, q] of Object.entries(body.questions)) {
          answers[id] = choice(q.criteria, id === "disposition" ? "select" : described.get(id).includes('"nba"') ? "required" : "not_required");
        }
      } else {
        const s = body.state;
        state.evidence.push({ state: s, draft: s.slice(s.indexOf("Draft response to judge:")) });
        if (state.jev === "unauthorized") return new Response(JSON.stringify({ error: "denied" }), { status: 401, headers: json });
        if (state.jev === "hostile") return new Response("{not json", { status: 200, headers: json });
        for (const [id, q] of Object.entries(body.questions)) answers[id] = choice(q.criteria, "supported");
      }
      return new Response(JSON.stringify({ model: body.model, answers }), { status: 200, headers: json });
    };
  }

  function makeFidelityEngine({ draft = SUBSTITUTED, editor = "read", checker = "judge", scope = "judge", jev = "supported", evidence = {}, artifact = false } = {}) {
    const state = {
      evidence: [], checks: [], scopes: [], order: [], corrections: [], mains: [], executed: [],
      mainReads: NBA_READS, draft, editor, checker, scope, jev, artifact, artifactHtml: SUBSTITUTED_HTML,
    };
    const env = { TYPESAFE_API_KEY: "test-only" };
    const transport = fidelityJev(state);
    const engine = new sportsclawEngine({
      thinkingBudget: 0,
      routing: { provider: "jev", dataPolicy: "cloud_allowed", publicDataTools: POLY_READERS, transport, env },
      evidenceVerifier: { provider: "jev", dataPolicy: "cloud_allowed", publicToolNames: SPECS, transport, env, ...evidence },
    });
    engine.mainModel = fidelityModel(state);
    const installed = ["nba", "polymarket"];
    const specs = SPECS.map((name) => ({ name, description: `${name} data`, input_schema: { type: "object", properties: {} } }));
    engine.registry = {
      getInstalledSkills: () => [...installed],
      getAllToolSpecs: () => specs,
      getSkillName: (name) => installed.find((skill) => name.startsWith(`${skill}_`)),
    };
    const bodies = { nba_get_scoreboard: SCOREBOARD, nba_get_standings: STANDINGS };
    engine.buildTools = () => Object.fromEntries([...SPECS, "get_agent_config"].map((name) => [name, tool({
      description: name,
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      execute: async () => {
        state.executed.push({ name, phase: state.corrections.length > 0 ? "correction" : "main" });
        return bodies[name] ?? (POLY_READERS.includes(name) ? POLY_ROWS : "{}");
      },
    })]));
    return { engine, state };
  }

  async function runReport(engine, { prompt = REPORT_ASK, history = HISTORY, userId, artifact = false } = {}) {
    const results = [];
    const text = await engine.run(prompt, {
      historyMode: "caller",
      history: structuredClone(history),
      ...(userId ? { userId } : {}),
      ...(artifact
        ? { artifact: { contract: "artifact-turn-v1", nonce: NONCE }, onArtifactResult: (r) => results.push(structuredClone(r)) }
        : {}),
    });
    return { text, results };
  }
  const correctionReads = (state) => state.executed.filter((e) => e.phase === "correction").map((e) => e.name);
  const assertNoHistoryAtJev = (state) => {
    for (const e of state.evidence) {
      for (const marker of ["PRIOR_FIDELITY_REQUEST", "PRIOR_FIDELITY_BOARD", PROFILE_MARKER]) {
        assert.ok(!e.state.includes(marker), `${marker} reached Jev`);
      }
    }
  };
  const assertBounded = (state) => {
    assert.ok(state.corrections.length <= 3, `one correction pass of at most 3 steps, got ${state.corrections.length}`);
    assert.ok(state.checks.length <= 2, `one primary check and at most one recheck, got ${state.checks.length}`);
    assert.ok(state.scopes.length <= 2, `one scope check and at most one scope recheck, got ${state.scopes.length}`);
    assert.ok(state.evidence.length <= 2, `one Jev judgment and at most one recheck, got ${state.evidence.length}`);
  };
  /** Jev judged the facts: the primary model adds only the scope check, never a duplicate factual check. */
  const assertNoPrimaryFactCheck = (state) => assert.equal(state.checks.length, 0, "no duplicate primary factual check after Jev");
  /** Scope prompts: current request, prior user context, the answer; no raw factual batches, no prior assistant claim. */
  const assertScopePrompt = (scope, { request = REPORT_ASK, answer } = {}) => {
    const { context, request: line } = scopeParts(scope.body);
    assert.ok(line.includes(request), `the scope check sees the current request: ${line}`);
    assert.ok(context.includes("PRIOR_FIDELITY_REQUEST"), "the scope check sees the prior user request");
    if (answer) assert.ok(scope.body.includes(answer), "the scope check sees the answer or report");
    assert.ok(!scope.body.includes("PRIOR_FIDELITY_BOARD"), "a prior assistant claim is not scope context");
    assert.doesNotMatch(scope.body, RAW_BATCH, "no raw factual-source batch in the scope prompt");
  };

  it("a Jev-supported wrong-venue report gets the primary fidelity gate; the one correction reads the approved Polymarket reader and the recheck passes the fresh report", async () => {
    const { engine, state } = makeFidelityEngine();
    const { text } = await runReport(engine);

    // Fixture fidelity: the main pass read only true DraftKings odds and standings, and Jev supported them.
    assert.deepEqual(state.executed.filter((e) => e.phase === "main").map((e) => e.name).sort(), [...NBA_READS].sort());
    assert.ok(state.evidence[0]?.draft.includes(SUBSTITUTED), "Jev judged the substituted report first");

    // Jev supported every fact, so the primary model goes directly to the scope check.
    assertNoPrimaryFactCheck(state);
    assert.ok(state.scopes.length >= 1, "the primary scope checker ran as the fidelity gate even though Jev supported every fact");
    assertScopePrompt(state.scopes[0], { answer: SUBSTITUTED });

    const reads = correctionReads(state);
    assert.ok(reads.length > 0 && reads.every((name) => POLY_READERS.includes(name)), `correction reads: [${reads}]`);
    assertBounded(state);
    assert.equal(state.evidence.length, 2, "one Jev check and one Jev recheck");
    assert.ok(state.evidence.at(-1).state.includes(POLY_MARKER), "the factual recheck saw the fresh Polymarket rows");
    assert.equal(state.scopes.length, 2, "one scope check and one scope recheck");
    assertScopePrompt(state.scopes[1], { answer: FAITHFUL });
    assert.equal(text, FAITHFUL, "the same requested venue, refreshed, not the disclaimed substitute");
    assertNoHistoryAtJev(state);
  });

  it("withholds when the one correction still substitutes the venue: an honest disclaimer is not fulfilment", async () => {
    const { engine, state } = makeFidelityEngine({ editor: "stubborn" });
    const { text } = await runReport(engine);
    assertNoPrimaryFactCheck(state);
    assert.ok(state.scopes.length >= 1, "the scope gate ran");
    assert.equal(state.corrections.length, 1, "exactly one correction");
    assertBounded(state);
    assert.notEqual(text, SUBSTITUTED);
    assert.match(text, WITHHELD_TEXT);
    assertNoHistoryAtJev(state);
  });

  it("an ordinary contextual follow-up with a Jev-supported wrong venue gets the same fidelity check", async () => {
    const { engine, state } = makeFidelityEngine({ draft: SUBSTITUTED_PICK });
    const { text } = await runReport(engine, { prompt: "Which one should I pick?" });
    assertNoPrimaryFactCheck(state);
    assert.ok(state.scopes.length >= 1, "the scope gate ran on a plain follow-up");
    assertScopePrompt(state.scopes[0], { request: "Which one should I pick?", answer: SUBSTITUTED_PICK });
    assertBounded(state);
    assert.notEqual(text, SUBSTITUTED_PICK, "the substituted pick never ships");
    assert.ok(text === FAITHFUL || WITHHELD_TEXT.test(text), `refreshed or withheld, got ${text}`);
    assertNoHistoryAtJev(state);
  });

  it("the latest explicit venue change wins: a DraftKings report requested now is not corrected back", async () => {
    const { engine, state } = makeFidelityEngine({ draft: SWITCHED });
    const { text } = await runReport(engine, { prompt: SWITCHED_ASK });
    assert.equal(text, SWITCHED);
    assert.equal(state.corrections.length, 0, "no correction");
    assertNoPrimaryFactCheck(state);
    assert.equal(state.scopes.length, 1, "the one scope check, which accepts the latest explicit venue");
    assert.ok(!state.executed.some((e) => POLY_READERS.includes(e.name)), "no Polymarket refetch against the user's latest instruction");
    assert.equal(state.evidence.length, 1);
  });

  it("a new standalone valid answer Jev supports gets no extra task check", async () => {
    const { engine, state } = makeFidelityEngine({ draft: SWITCHED });
    const { text } = await runReport(engine, { prompt: STANDALONE_ASK, history: [] });
    assert.equal(text, SWITCHED);
    assert.equal(state.checks.length, 0, "no primary fidelity check without retained context");
    assert.equal(state.scopes.length, 0, "no scope check without retained context");
    assert.equal(state.corrections.length, 0);
    assert.equal(state.evidence.length, 1, "the one Jev judgment");
  });

  it("private profile and history reach only the primary gate, never Jev", async () => {
    const userId = "fidelity-profile-user";
    await new MemoryManager(userId).writeFanProfile(`${PROFILE_MARKER} follows NBA (Lakers); prefers Polymarket boards`);
    const { engine, state } = makeFidelityEngine();
    await runReport(engine, { userId });
    assert.ok(state.evidence.length >= 1, "Jev was asked");
    assertNoHistoryAtJev(state);
    assertNoPrimaryFactCheck(state);
    assert.ok(state.scopes.length >= 1 && state.scopes[0].body.includes("PRIOR_FIDELITY_REQUEST"), "the approved context reached the primary scope gate");
  });

  it("a hostile or unusable primary fidelity verdict never ships the substitute", async () => {
    const { engine, state } = makeFidelityEngine({ scope: "garbage" });
    const { text } = await runReport(engine);
    assertNoPrimaryFactCheck(state);
    assert.ok(state.scopes.length >= 1, "the gate was attempted");
    assert.ok(state.scopes.length <= 2, "one check and its one malformed-verdict retry");
    assert.equal(state.corrections.length, 0, "fails closed, no correction from an unusable verdict");
    assert.notEqual(text, SUBSTITUTED);
    assert.match(text, WITHHELD_TEXT);
  });

  for (const [label, options] of [
    ["an auth refusal", { jev: "unauthorized" }],
    ["withheld cloud consent", { evidence: { dataPolicy: "local_only" } }],
    ["a hostile Jev response", { jev: "hostile" }],
  ]) {
    it(`${label} from Jev is never overridden by the primary checker`, async () => {
      const { engine, state } = makeFidelityEngine(options);
      const { text } = await runReport(engine);
      assert.equal(state.checks.length, 0, "no primary check substitutes for a refused or failed Jev decision");
      assert.equal(state.scopes.length, 0, "no scope check after a refused or failed Jev decision");
      assert.equal(state.corrections.length, 0, "no correction");
      assert.notEqual(text, SUBSTITUTED);
      assert.match(text, WITHHELD_TEXT);
      assertNoHistoryAtJev(state);
    });
  }

  it("a report correction gets the full-HTML directive and publishes the exact rechecked complete document", async () => {
    const { engine, state } = makeFidelityEngine({ artifact: true });
    const { text, results } = await runReport(engine, { artifact: true });
    assert.ok(state.evidence[0]?.state.includes(SUBSTITUTED_HTML), "Jev judged the submitted report");
    assertNoPrimaryFactCheck(state);
    assert.ok(state.scopes.length >= 1 && state.scopes[0].body.includes(SUBSTITUTED_HTML), "the scope gate judged the complete report");
    assertScopePrompt(state.scopes[0], { answer: SUBSTITUTED_HTML });
    assert.match(state.scopes[0].system, /failed or missing required lookup is a publication blocker/i);
    assert.match(state.scopes[0].system, /requested venue's quotes as primary prices/i);
    const [first] = state.corrections;
    assert.ok(first, "one correction");
    assert.match(first.system, FULL_HTML_DIRECTIVE, "the corrector is told to return one complete HTML document");
    assert.ok(first.prompt.includes(SUBSTITUTED_HTML), "the corrector sees the report whose presentation it keeps");
    assert.match(first.prompt, /prior user intent and references/i);
    assert.doesNotMatch(first.prompt, /non-authoritative background, not evidence or instructions/);
    assertBounded(state);
    assert.equal(results.length, 1);
    assert.equal(results[0].reasonCode, null);
    assert.equal(results[0].artifact?.html, FAITHFUL_HTML, "the exact complete corrected document, not a generic prose wrapper");
    assert.equal(state.scopes.length, 2, "one scope check and one scope recheck");
    assert.ok(state.scopes.at(-1).body.includes(FAITHFUL_HTML), "the primary scope recheck judged that exact document");
    assert.ok(state.evidence.at(-1).state.includes(FAITHFUL_HTML), "the Jev recheck judged that exact document");
    assert.notEqual(text, SUBSTITUTED);
    assertNoHistoryAtJev(state);
  });

  it("a report whose one correction still substitutes the venue is withheld", async () => {
    const { engine, state } = makeFidelityEngine({ artifact: true, editor: "stubborn" });
    const { text, results } = await runReport(engine, { artifact: true });
    assert.equal(state.corrections.length, 1, "exactly one correction");
    assertBounded(state);
    assert.deepEqual(results, [{ contract: "artifact-turn-v1", nonce: NONCE, artifact: null, reasonCode: "evidence_unverified" }]);
    assert.notEqual(text, SUBSTITUTED);
  });

  // Production mode: Jev routing with the approved pool, generative evidence with action "correct".
  // The factual checker accepts the true DraftKings data; a separate primary task-completion
  // reviewer judges scope, after factual support, inside the same one correction and recheck.
  const PRODUCTION = { evidence: { provider: "generative", generativeAction: "correct" } };
  const factPromptHasEvidence = (check) => {
    assert.ok(check.body.includes("Raw source data"), "the factual prompt keeps the raw source data");
    assert.ok(check.body.includes('"wins":30'), "the factual prompt keeps the full standings batch");
    assert.match(check.system, /one-sided.*raw implied probability.*not.*de-vigged/i);
  };

  it("production: true DraftKings facts pass, the scope reviewer flags the substitute, the one correction refreshes Polymarket, both rechecks pass", async () => {
    const { engine, state } = makeFidelityEngine(PRODUCTION);
    const { text } = await runReport(engine);
    assert.equal(state.evidence.length, 0, "no Jev evidence call in production mode");
    assert.equal(state.checks.length, 2, "one factual check and one factual recheck");
    assert.equal(state.scopes.length, 2, "one scope check and one scope recheck");
    assert.deepEqual(state.order.slice(0, 2), ["fact", "scope"], "scope is judged after factual support");
    factPromptHasEvidence(state.checks[0]);
    assert.ok(state.checks[0].body.includes(SUBSTITUTED));
    assertScopePrompt(state.scopes[0], { answer: SUBSTITUTED });
    assert.equal(state.scopes[0].body.match(/PRIOR_FIDELITY_REQUEST/g)?.length, 1);
    const reads = correctionReads(state);
    assert.ok(reads.length > 0 && reads.every((name) => POLY_READERS.includes(name)), `correction reads: [${reads}]`);
    assertBounded(state);
    assert.ok(state.checks[1].body.includes(POLY_MARKER), "the factual recheck sees the fresh Polymarket rows");
    assert.ok(state.checks[1].body.includes(FAITHFUL), "the factual recheck judges the corrected answer");
    assertScopePrompt(state.scopes[1], { answer: FAITHFUL });
    assert.equal(text, FAITHFUL);
  });

  it("production: withholds when the one correction still substitutes the venue", async () => {
    const { engine, state } = makeFidelityEngine({ ...PRODUCTION, editor: "stubborn" });
    const { text } = await runReport(engine);
    assert.equal(state.corrections.length, 1, "exactly one correction");
    assert.ok(state.scopes.length >= 1, "the scope reviewer ran");
    assertBounded(state);
    assert.notEqual(text, SUBSTITUTED);
    assert.match(text, WITHHELD_TEXT);
  });

  it("production: an ordinary contextual follow-up with a true wrong-venue pick gets the scope check", async () => {
    const { engine, state } = makeFidelityEngine({ ...PRODUCTION, draft: SUBSTITUTED_PICK });
    const { text } = await runReport(engine, { prompt: "Which one should I pick?" });
    assert.ok(state.checks.length >= 1, "the factual check ran");
    assert.ok(state.scopes.length >= 1, "the scope check ran on a plain follow-up");
    assertScopePrompt(state.scopes[0], { request: "Which one should I pick?", answer: SUBSTITUTED_PICK });
    assertBounded(state);
    assert.notEqual(text, SUBSTITUTED_PICK);
    assert.ok(text === FAITHFUL || WITHHELD_TEXT.test(text), `refreshed or withheld, got ${text}`);
  });

  it("production: the latest explicit venue override is permitted, with no correction or Polymarket refetch", async () => {
    const { engine, state } = makeFidelityEngine({ ...PRODUCTION, draft: SWITCHED });
    const { text } = await runReport(engine, { prompt: SWITCHED_ASK });
    assert.equal(text, SWITCHED);
    assert.equal(state.checks.length, 1, "one factual check");
    assert.equal(state.scopes.length, 1, "one scope check, which accepts the latest instruction");
    assertScopePrompt(state.scopes[0], { request: SWITCHED_ASK, answer: SWITCHED });
    assert.equal(state.corrections.length, 0);
    assert.ok(!state.executed.some((e) => POLY_READERS.includes(e.name)));
  });

  it("production: a standalone ordinary answer adds no scope check", async () => {
    const { engine, state } = makeFidelityEngine({ ...PRODUCTION, draft: SWITCHED });
    const { text } = await runReport(engine, { prompt: STANDALONE_ASK, history: [] });
    assert.equal(text, SWITCHED);
    assert.equal(state.checks.length, 1, "the existing factual check only");
    factPromptHasEvidence(state.checks[0]);
    assert.equal(state.scopes.length, 0, "no scope check without retained context or a report");
    assert.equal(state.corrections.length, 0);
  });

  it("production: a malformed scope verdict fails closed and never falls back to the already-valid facts", async () => {
    const { engine, state } = makeFidelityEngine({ ...PRODUCTION, scope: "garbage" });
    const { text } = await runReport(engine);
    assert.equal(state.checks.length, 1, "the facts were checked and valid");
    assert.ok(state.scopes.length >= 1 && state.scopes.length <= 2, "one scope check and its one malformed-verdict retry");
    assert.equal(state.corrections.length, 0, "no correction from an unusable verdict");
    assert.notEqual(text, SUBSTITUTED);
    assert.match(text, WITHHELD_TEXT);
  });

  it("production: a report correction keeps the full-HTML directive, and both rechecks judge the exact published document", async () => {
    const { engine, state } = makeFidelityEngine({ ...PRODUCTION, artifact: true });
    const { results } = await runReport(engine, { artifact: true });
    factPromptHasEvidence(state.checks[0]);
    assert.ok(state.checks[0].body.includes(SUBSTITUTED_HTML), "the factual check judged the complete report");
    assertScopePrompt(state.scopes[0], { answer: SUBSTITUTED_HTML });
    const [first] = state.corrections;
    assert.ok(first, "one correction");
    assert.match(first.system, FULL_HTML_DIRECTIVE);
    assertBounded(state);
    assert.equal(results.length, 1);
    assert.equal(results[0].reasonCode, null);
    assert.equal(results[0].artifact?.html, FAITHFUL_HTML);
    assert.ok(state.checks.at(-1).body.includes(FAITHFUL_HTML), "the factual recheck judged that exact document");
    assert.ok(state.scopes.at(-1).body.includes(FAITHFUL_HTML), "the scope recheck judged that exact document");
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
