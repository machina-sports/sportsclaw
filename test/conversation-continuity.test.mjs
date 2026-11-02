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
    const state = { evidence: [], checks: [], corrections: [], mains: [], executed: [], mainReads, greedy };
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
