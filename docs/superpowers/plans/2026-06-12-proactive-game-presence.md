# Proactive Game Presence v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent proactively messages a user on a live-game event (start, score, lead change, final) for a team they subscribed to, with templated alerts for routine events and fan-aware `engine.run()` reasoning for headline events.

**Architecture:** A pure detector turns scoreboard snapshots into typed `GameEvent`s, published to a new `game-events` relay channel. A `GameAlertService` polls scoreboards for sports with active subscriptions, dedups events, resolves subscribers from a disk-backed `GameSubscriptionStore`, and delivers via Telegram (templated, or `engine.run()` for headline events with a budget-exhausted fallback). Users opt in via `subscribe_team_alerts` engine tools.

**Tech Stack:** TypeScript/ESM, Node `node:test` + `assert/strict` (test files `test/*.test.mjs` importing from `../dist/*.js`, run `npm run build && node --test test/<file>`). Reuses the existing `Watcher` (`src/watch.ts`), `relayManager` (`src/relay.ts`), Telegram `sendMessage`, the P1 atomic-write pattern, and the P2 `dailyTokenBudget` gate. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-12-proactive-game-presence-design.md`

**Conventions (apply to every task):**
- Build: `npm run build` (tsc; success = no emit errors). Tests import from `dist/`, never `src/`.
- Each new test file gets a `test:<name>` script in `package.json` matching the existing pattern.
- Local imports use explicit `.js` extensions (ESM).
- Engine tools use `defineTool({...})` + `jsonSchema({...})` (imported as `tool as defineTool` and `jsonSchema` in engine.ts:15-16); `execute` returns a string; `watcherUserId` (engine.ts:1569 = `runUserId ?? "anonymous"`) is the current user.
- Logging: `console.error("[sportsclaw] ...")`, verbose chatter gated on config.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/types.ts` | Modify | Add `GameSubscription`, `GameState`, `GameEventType`, `GameEvent` |
| `src/game-events.ts` | Create | Pure: `normalizeScoreboard`, `detectGameEvents` |
| `src/game-subscriptions.ts` | Create | Disk-backed team subscriptions (atomic writes) |
| `src/relay.ts` | Modify | Add `game-events` channel to `SportsClawChannels` + singleton |
| `src/game-alerts.ts` | Create | `GameAlertService` orchestrator (injectable deps) + `renderAlert` |
| `src/engine.ts` | Modify | `subscribe_team_alerts`/`unsubscribe_team_alerts` tools; capture run platform/chatId |
| `src/listeners/telegram.ts` | Modify | Pass platform/chatId to `run()`; start `GameAlertService` at boot |
| `test/game-events.test.mjs` | Create | Detector + normalizer unit tests |
| `test/game-subscriptions.test.mjs` | Create | Store persistence/resolution tests |
| `test/game-alerts.test.mjs` | Create | Service dedup/routing/fallback tests (fakes) |
| `test/fixtures/scoreboard-soccer.json` | Create | Real captured `scores` payload |

---

## Task 1: Semantic event detector (`game-events.ts`)

**Files:**
- Modify: `src/types.ts` (add `GameState`, `GameEventType`, `GameEvent` near the existing `WatchEvent` block ~line 504)
- Create: `src/game-events.ts`
- Create: `test/fixtures/scoreboard-soccer.json`
- Test: `test/game-events.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Capture a real scoreboard fixture (pins field paths)**

Run (if the Python bridge is available):
```bash
npm run build && node -e "import('./dist/tools.js').then(async m => { const r = await m.executePythonBridge('soccer','scores',{}); require('fs').writeFileSync('test/fixtures/scoreboard-soccer.json', JSON.stringify(r.data, null, 2)); console.log(Array.isArray(r.data) ? r.data.length + ' games' : typeof r.data); })"
```
Inspect the file. Confirm each game has: an id field (`@id` or `id`), a competitors array (`sport:competitor`, a `[home, away]` tuple per the IPTC convention) where each competitor has a name (`sport:name`) and a score, and a status field. Note the EXACT field names for score and status — they drive Step 3.

**If the bridge is not runnable in this environment**, create the fixture by hand with this shape (matches the `sport:competitor` convention evidenced in `src/tools.ts:667-676`), and treat the score/status field names below as the contract:
```json
[
  {
    "@id": "soccer:match:1",
    "sport:eventStatus": "in_progress",
    "sport:competitor": [
      { "sport:name": "Brazil", "sport:score": 1 },
      { "sport:name": "Argentina", "sport:score": 0 }
    ]
  },
  {
    "@id": "soccer:match:2",
    "sport:eventStatus": "scheduled",
    "sport:competitor": [
      { "sport:name": "France", "sport:score": 0 },
      { "sport:name": "Spain", "sport:score": 0 }
    ]
  }
]
```

- [ ] **Step 2: Write the failing test**

Create `test/game-events.test.mjs`:
```js
/**
 * game-events — pure scoreboard normalization + semantic event detection.
 * normalizeScoreboard turns a raw `scores` payload into GameState[].
 * detectGameEvents diffs two GameStates for one game into typed events.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { normalizeScoreboard, detectGameEvents } from "../dist/game-events.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(HERE, "fixtures", "scoreboard-soccer.json"), "utf-8"));

const state = (over = {}) => ({
  gameId: "g1", sport: "soccer", home: "Brazil", away: "Argentina",
  homeScore: 0, awayScore: 0, status: "in_progress", leader: "tie", ...over,
});

describe("normalizeScoreboard", () => {
  it("extracts GameState[] from a real scores payload", () => {
    const states = normalizeScoreboard("soccer", FIXTURE);
    assert.ok(states.length >= 1);
    const g = states[0];
    assert.equal(g.sport, "soccer");
    assert.equal(typeof g.gameId, "string");
    assert.equal(typeof g.homeScore, "number");
    assert.ok(["home", "away", "tie"].includes(g.leader));
    assert.ok(["scheduled", "in_progress", "final", "other"].includes(g.status));
  });

  it("returns [] for malformed input", () => {
    assert.deepEqual(normalizeScoreboard("soccer", null), []);
    assert.deepEqual(normalizeScoreboard("soccer", { nope: true }), []);
    assert.deepEqual(normalizeScoreboard("soccer", [{ garbage: 1 }]), []);
  });
});

describe("detectGameEvents", () => {
  it("first sighting of an in-progress game emits game_start", () => {
    const events = detectGameEvents(undefined, state({ status: "in_progress" }));
    assert.deepEqual(events.map((e) => e.type), ["game_start"]);
  });

  it("first sighting of a scheduled game emits nothing", () => {
    assert.deepEqual(detectGameEvents(undefined, state({ status: "scheduled" })), []);
  });

  it("scheduled -> in_progress emits game_start", () => {
    const prev = state({ status: "scheduled" });
    const curr = state({ status: "in_progress" });
    assert.deepEqual(detectGameEvents(prev, curr).map((e) => e.type), ["game_start"]);
  });

  it("a score increase emits score_change", () => {
    const prev = state({ homeScore: 0, awayScore: 0, leader: "tie" });
    const curr = state({ homeScore: 1, awayScore: 0, leader: "home" });
    const types = detectGameEvents(prev, curr).map((e) => e.type);
    assert.ok(types.includes("score_change"));
  });

  it("going ahead from a tie emits lead_change", () => {
    const prev = state({ homeScore: 1, awayScore: 1, leader: "tie" });
    const curr = state({ homeScore: 2, awayScore: 1, leader: "home" });
    const types = detectGameEvents(prev, curr).map((e) => e.type);
    assert.ok(types.includes("lead_change"));
    assert.ok(types.includes("score_change"));
  });

  it("lead flipping away->home emits lead_change", () => {
    const prev = state({ homeScore: 1, awayScore: 2, leader: "away" });
    const curr = state({ homeScore: 3, awayScore: 2, leader: "home" });
    assert.ok(detectGameEvents(prev, curr).map((e) => e.type).includes("lead_change"));
  });

  it("transition to final emits final", () => {
    const prev = state({ status: "in_progress" });
    const curr = state({ status: "final" });
    assert.ok(detectGameEvents(prev, curr).map((e) => e.type).includes("final"));
  });

  it("no change emits nothing", () => {
    assert.deepEqual(detectGameEvents(state(), state()), []);
  });

  it("sets scoreSignature for dedup", () => {
    const events = detectGameEvents(state({ homeScore: 0 }), state({ homeScore: 1, leader: "home" }));
    assert.equal(events[0].scoreSignature, "1-0");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run build && node --test test/game-events.test.mjs`
Expected: FAIL — `dist/game-events.js` does not exist.

- [ ] **Step 4: Add types to `src/types.ts`**

After the `WatchEvent` interface block (~line 516):
```typescript
// ---------------------------------------------------------------------------
// Proactive game presence — subscriptions & semantic events
// ---------------------------------------------------------------------------

export interface GameSubscription {
  userId: string;
  platform: "telegram" | "discord" | "cli";
  chatId: string;
  sport: string;
  team: string;
  createdAt: string;
}

export interface GameState {
  gameId: string;
  sport: string;
  home: string;
  away: string;
  homeScore: number;
  awayScore: number;
  status: "scheduled" | "in_progress" | "final" | "other";
  leader: "home" | "away" | "tie";
}

export type GameEventType = "game_start" | "score_change" | "lead_change" | "final";

export interface GameEvent {
  type: GameEventType;
  gameId: string;
  sport: string;
  state: GameState;
  scoreSignature: string;
  timestamp: string;
}
```

- [ ] **Step 5: Implement `src/game-events.ts`**

```typescript
/**
 * sportsclaw — Semantic Game Event Detection (pure)
 *
 * normalizeScoreboard: raw sports-skills `scores` payload → GameState[].
 * detectGameEvents: diff two GameStates for one game → typed GameEvent[].
 *
 * Pure and deterministic except for the timestamp, which is passed in so
 * callers (and tests) control it. No I/O.
 */

import type { GameState, GameEvent, GameEventType } from "./types.js";

function toNumber(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function toStatus(raw: unknown): GameState["status"] {
  const s = String(raw ?? "").toLowerCase();
  if (s.includes("progress") || s.includes("live") || s.includes("in-progress")) return "in_progress";
  if (s.includes("final") || s.includes("complete") || s === "ft") return "final";
  if (s.includes("schedul") || s.includes("pre") || s.includes("upcoming")) return "scheduled";
  return "other";
}

function leaderOf(homeScore: number, awayScore: number): GameState["leader"] {
  if (homeScore > awayScore) return "home";
  if (awayScore > homeScore) return "away";
  return "tie";
}

/** Extract GameState[] from a raw `scores` payload. Tolerant: skips bad games, never throws. */
export function normalizeScoreboard(sport: string, snapshot: unknown): GameState[] {
  const games = Array.isArray(snapshot) ? snapshot : [];
  const out: GameState[] = [];
  for (const raw of games) {
    if (!raw || typeof raw !== "object") continue;
    const g = raw as Record<string, unknown>;
    const competitors = g["sport:competitor"];
    if (!Array.isArray(competitors) || competitors.length < 2) continue;
    const homeC = competitors[0] as Record<string, unknown> | undefined;
    const awayC = competitors[1] as Record<string, unknown> | undefined;
    if (!homeC || !awayC) continue;
    const home = String(homeC["sport:name"] ?? "").trim();
    const away = String(awayC["sport:name"] ?? "").trim();
    if (!home || !away) continue;
    const gameId = String(g["@id"] ?? g["id"] ?? `${sport}:${home}-${away}`);
    const homeScore = toNumber(homeC["sport:score"] ?? homeC["score"]);
    const awayScore = toNumber(awayC["sport:score"] ?? awayC["score"]);
    const status = toStatus(g["sport:eventStatus"] ?? g["status"] ?? g["sport:status"]);
    out.push({
      gameId, sport, home, away, homeScore, awayScore, status,
      leader: leaderOf(homeScore, awayScore),
    });
  }
  return out;
}

/** Diff two states for one game into typed events. `now` defaults to a fixed-free value via Date. */
export function detectGameEvents(
  prev: GameState | undefined,
  curr: GameState,
  now: string = new Date().toISOString()
): GameEvent[] {
  const types: GameEventType[] = [];

  if (!prev) {
    // First sighting: only announce a clear status milestone, never a phantom score.
    if (curr.status === "in_progress") types.push("game_start");
    if (curr.status === "final") types.push("final");
  } else {
    if (prev.status !== "in_progress" && curr.status === "in_progress") types.push("game_start");
    if (curr.homeScore > prev.homeScore || curr.awayScore > prev.awayScore) types.push("score_change");
    if (curr.leader !== prev.leader && curr.leader !== "tie") types.push("lead_change");
    if (prev.status !== "final" && curr.status === "final") types.push("final");
  }

  const scoreSignature = `${curr.homeScore}-${curr.awayScore}`;
  return types.map((type) => ({
    type, gameId: curr.gameId, sport: curr.sport, state: curr, scoreSignature, timestamp: now,
  }));
}
```

If Step 1 revealed different score/status field names, adjust the `homeC["sport:score"]` / `g["sport:eventStatus"]` lookups (and the fixture) to match — the test asserts behavior, not field names, so it stays valid.

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run build && node --test test/game-events.test.mjs`
Expected: PASS (11 tests).

- [ ] **Step 7: Add package.json script and commit**

```json
"test:game-events": "npm run build && node --test test/game-events.test.mjs",
```
```bash
git add src/types.ts src/game-events.ts test/game-events.test.mjs test/fixtures/scoreboard-soccer.json package.json
git commit -m "feat(alerts): pure scoreboard normalizer + semantic game-event detector

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Subscription store (`game-subscriptions.ts`)

**Files:**
- Create: `src/game-subscriptions.ts`
- Test: `test/game-subscriptions.test.mjs`
- Modify: `package.json`

(`GameSubscription` type already added in Task 1.)

- [ ] **Step 1: Write the failing test**

Create `test/game-subscriptions.test.mjs`:
```js
/**
 * GameSubscriptionStore — disk-backed team alert subscriptions.
 * Round-trips across instances (restart-safe), resolves subscribers by team,
 * lists distinct active sports, atomic writes, sanitized filenames.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GameSubscriptionStore } from "../dist/game-subscriptions.js";

const sub = (over = {}) => ({
  userId: "u1", platform: "telegram", chatId: "555",
  sport: "soccer", team: "Brazil", createdAt: "2026-06-12T00:00:00.000Z", ...over,
});

let dir;

describe("GameSubscriptionStore", () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sc-subs-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("round-trips a subscription across instances", async () => {
    const a = new GameSubscriptionStore(dir);
    await a.add(sub());
    const b = new GameSubscriptionStore(dir);
    const list = await b.listForUser("u1", "telegram");
    assert.equal(list.length, 1);
    assert.equal(list[0].team, "Brazil");
  });

  it("findSubscribers matches by sport+team (case-insensitive)", async () => {
    const store = new GameSubscriptionStore(dir);
    await store.add(sub({ userId: "u1", chatId: "1" }));
    await store.add(sub({ userId: "u2", chatId: "2", team: "brazil" }));
    await store.add(sub({ userId: "u3", chatId: "3", team: "France" }));
    const subs = await store.findSubscribers("soccer", "BRAZIL");
    assert.deepEqual(subs.map((s) => s.userId).sort(), ["u1", "u2"]);
  });

  it("activeSports lists distinct sports", async () => {
    const store = new GameSubscriptionStore(dir);
    await store.add(sub({ sport: "soccer" }));
    await store.add(sub({ userId: "u2", chatId: "2", sport: "nba", team: "Lakers" }));
    await store.add(sub({ userId: "u3", chatId: "3", sport: "soccer", team: "France" }));
    assert.deepEqual((await store.activeSports()).sort(), ["nba", "soccer"]);
  });

  it("remove deletes a single subscription", async () => {
    const store = new GameSubscriptionStore(dir);
    await store.add(sub({ team: "Brazil" }));
    await store.add(sub({ team: "France" }));
    assert.equal(await store.remove("u1", "telegram", "soccer", "Brazil"), true);
    const list = await store.listForUser("u1", "telegram");
    assert.deepEqual(list.map((s) => s.team), ["France"]);
  });

  it("add is idempotent on (user, platform, sport, team)", async () => {
    const store = new GameSubscriptionStore(dir);
    await store.add(sub());
    await store.add(sub({ chatId: "999" }));
    const list = await store.listForUser("u1", "telegram");
    assert.equal(list.length, 1);
    assert.equal(list[0].chatId, "999", "re-add updates chatId");
  });

  it("leaves no temp files behind", async () => {
    const store = new GameSubscriptionStore(dir);
    await store.add(sub());
    for (const f of readdirSync(dir)) assert.ok(!f.endsWith(".tmp"), `temp leaked: ${f}`);
  });

  it("sanitizes hostile userIds into safe filenames", async () => {
    const store = new GameSubscriptionStore(dir);
    await store.add(sub({ userId: "../../etc/passwd" }));
    for (const f of readdirSync(dir)) {
      assert.ok(!f.includes("..") && !f.includes("/"), `unsafe: ${f}`);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/game-subscriptions.test.mjs`
Expected: FAIL — `dist/game-subscriptions.js` does not exist.

- [ ] **Step 3: Implement `src/game-subscriptions.ts`**

```typescript
/**
 * sportsclaw — Game Alert Subscription Store
 *
 * Team-level alert subscriptions persisted one JSON file per (userId, platform).
 * Atomic temp+rename writes (same pattern as SessionStore/FileMemoryStorage).
 * Default dir ~/.sportsclaw/game-subscriptions (override: SPORTSCLAW_SUBS_DIR).
 */

import { mkdirSync } from "node:fs";
import { readFile, writeFile, rename, readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GameSubscription } from "./types.js";

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 160);
}

export class GameSubscriptionStore {
  private dir: string;
  private dirReady = false;

  constructor(dir?: string) {
    this.dir = dir ?? process.env.SPORTSCLAW_SUBS_DIR ?? join(homedir(), ".sportsclaw", "game-subscriptions");
  }

  private filePath(userId: string, platform: string): string {
    return join(this.dir, `${sanitize(platform)}__${sanitize(userId)}.json`);
  }

  private async ensureDir(): Promise<void> {
    if (!this.dirReady) { mkdirSync(this.dir, { recursive: true }); this.dirReady = true; }
  }

  private async readFileSubs(path: string): Promise<GameSubscription[]> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf-8"));
      return Array.isArray(parsed) ? (parsed as GameSubscription[]) : [];
    } catch {
      return [];
    }
  }

  private async writeFileSubs(path: string, subs: GameSubscription[]): Promise<void> {
    await this.ensureDir();
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await writeFile(tmp, JSON.stringify(subs), "utf-8");
    await rename(tmp, path);
  }

  private key(s: { sport: string; team: string }): string {
    return `${s.sport.toLowerCase()}:${s.team.toLowerCase()}`;
  }

  /** Add or update a subscription (idempotent on user/platform/sport/team). */
  async add(sub: GameSubscription): Promise<void> {
    const path = this.filePath(sub.userId, sub.platform);
    const subs = await this.readFileSubs(path);
    const idx = subs.findIndex((s) => this.key(s) === this.key(sub));
    if (idx >= 0) subs[idx] = sub; else subs.push(sub);
    await this.writeFileSubs(path, subs);
  }

  /** Remove one subscription. Returns true if something was removed. */
  async remove(userId: string, platform: string, sport: string, team: string): Promise<boolean> {
    const path = this.filePath(userId, platform);
    const subs = await this.readFileSubs(path);
    const target = `${sport.toLowerCase()}:${team.toLowerCase()}`;
    const next = subs.filter((s) => this.key(s) !== target);
    if (next.length === subs.length) return false;
    await this.writeFileSubs(path, next);
    return true;
  }

  async listForUser(userId: string, platform: string): Promise<GameSubscription[]> {
    return this.readFileSubs(this.filePath(userId, platform));
  }

  private async allSubs(): Promise<GameSubscription[]> {
    let files: string[];
    try { files = await readdir(this.dir); } catch { return []; }
    const all: GameSubscription[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      all.push(...(await this.readFileSubs(join(this.dir, f))));
    }
    return all;
  }

  /** All subscriptions for a given sport+team, across all users. */
  async findSubscribers(sport: string, team: string): Promise<GameSubscription[]> {
    const target = `${sport.toLowerCase()}:${team.toLowerCase()}`;
    return (await this.allSubs()).filter((s) => this.key(s) === target);
  }

  /** Distinct sports across all subscriptions (drives which scoreboards to poll). */
  async activeSports(): Promise<string[]> {
    return [...new Set((await this.allSubs()).map((s) => s.sport.toLowerCase()))];
  }
}

/** Shared default-location store. */
export const gameSubscriptionStore = new GameSubscriptionStore();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/game-subscriptions.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Add package.json script and commit**

```json
"test:game-subscriptions": "npm run build && node --test test/game-subscriptions.test.mjs",
```
```bash
git add src/game-subscriptions.ts test/game-subscriptions.test.mjs package.json
git commit -m "feat(alerts): disk-backed team subscription store with atomic writes

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: `game-events` relay channel

**Files:**
- Modify: `src/relay.ts` (`SportsClawChannels` type ~line 99-105; singleton channel list ~line 225-231)

- [ ] **Step 1: Add the channel type**

In `src/relay.ts`, add the `GameEvent` import next to the other type imports (~line 83):
```typescript
import type { GameEvent } from "./types.js";
```
Add to `SportsClawChannels` (after `"watch": WatchEvent;`):
```typescript
  "game-events": GameEvent;
```

- [ ] **Step 2: Register the channel on the singleton**

In the `relayManager` constructor array (~line 225), add `"game-events"`:
```typescript
export const relayManager = new RelayManager<SportsClawChannels>([
  "live-games",
  "odds",
  "predictions",
  "intel",
  "watch",
  "game-events",
]);
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: clean (no emit errors). The typed channel map now accepts `relayManager.publish("game-events", event)` and `relayManager.on("game-events", handler)`.

- [ ] **Step 4: Commit**

```bash
git add src/relay.ts
git commit -m "feat(alerts): add typed game-events relay channel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: `GameAlertService` orchestrator (`game-alerts.ts`)

**Files:**
- Create: `src/game-alerts.ts`
- Test: `test/game-alerts.test.mjs`
- Modify: `package.json`

Design for testability: the service takes injected collaborators so tests drive it with fakes (no real polling/relay/Telegram/LLM). The constructor accepts `{ store, deliver, runEngine, now }`. `deliver(target, text)` sends; `runEngine(prompt, sub)` returns the headline message text (or throws to simulate budget exhaustion). Production wiring (Task 5) supplies real implementations.

- [ ] **Step 1: Write the failing test**

Create `test/game-alerts.test.mjs`:
```js
/**
 * GameAlertService — given a GameEvent, resolve subscribers, dedup, and route
 * routine events to templated delivery / headline events to the engine, with a
 * budget-exhausted fallback to templated. Driven with fakes (no real I/O).
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GameSubscriptionStore } from "../dist/game-subscriptions.js";
import { GameAlertService } from "../dist/game-alerts.js";

const evt = (over = {}) => ({
  type: "score_change", gameId: "g1", sport: "soccer",
  state: { gameId: "g1", sport: "soccer", home: "Brazil", away: "Argentina",
           homeScore: 1, awayScore: 0, status: "in_progress", leader: "home" },
  scoreSignature: "1-0", timestamp: "2026-06-12T00:00:00.000Z", ...over,
});

let dir, store, sent, engineCalls;

function makeService(opts = {}) {
  sent = []; engineCalls = 0;
  return new GameAlertService({
    store,
    deliver: async (target, text) => { sent.push({ target, text }); return true; },
    runEngine: async () => { engineCalls++; return "ENGINE: late drama in São Paulo"; },
    ...opts,
  });
}

describe("GameAlertService", () => {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "sc-alertsvc-"));
    store = new GameSubscriptionStore(dir);
    await store.add({ userId: "u1", platform: "telegram", chatId: "555",
      sport: "soccer", team: "Brazil", createdAt: "2026-06-12T00:00:00.000Z" });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("delivers a routine event to subscribers via template (no engine call)", async () => {
    const svc = makeService();
    await svc.handleEvent(evt());
    assert.equal(sent.length, 1);
    assert.equal(sent[0].target.chatId, "555");
    assert.match(sent[0].text, /Brazil/);
    assert.equal(engineCalls, 0, "routine events do not call the engine");
  });

  it("does not deliver to non-subscribers", async () => {
    const svc = makeService();
    await svc.handleEvent(evt({ state: { ...evt().state, home: "France", away: "Spain" },
      // a game with no subscribed team
    }));
    assert.equal(sent.length, 0);
  });

  it("dedups identical events", async () => {
    const svc = makeService();
    await svc.handleEvent(evt());
    await svc.handleEvent(evt());
    assert.equal(sent.length, 1, "second identical event suppressed");
  });

  it("routes headline events (final) through the engine", async () => {
    const svc = makeService();
    await svc.handleEvent(evt({ type: "final", scoreSignature: "2-1" }));
    assert.equal(engineCalls, 1);
    assert.match(sent[0].text, /ENGINE:/);
  });

  it("falls back to template when the engine throws (budget exhausted)", async () => {
    const svc = makeService({
      runEngine: async () => { throw new Error("Daily token budget exhausted"); },
    });
    await svc.handleEvent(evt({ type: "final", scoreSignature: "2-1" }));
    assert.equal(sent.length, 1, "still delivered");
    assert.doesNotMatch(sent[0].text, /ENGINE:/);
    assert.match(sent[0].text, /Brazil/);
  });

  it("isolates delivery failures (one bad target does not stop others)", async () => {
    await store.add({ userId: "u2", platform: "telegram", chatId: "777",
      sport: "soccer", team: "Brazil", createdAt: "2026-06-12T00:00:00.000Z" });
    let calls = 0;
    const svc = makeService({
      deliver: async (target, text) => {
        calls++;
        if (target.chatId === "555") throw new Error("telegram 400");
        sent.push({ target, text });
        return true;
      },
    });
    await svc.handleEvent(evt());
    assert.equal(calls, 2, "attempted both");
    assert.equal(sent.length, 1, "the healthy target still received it");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/game-alerts.test.mjs`
Expected: FAIL — `dist/game-alerts.js` does not exist.

- [ ] **Step 3: Implement `src/game-alerts.ts`**

```typescript
/**
 * sportsclaw — Game Alert Service
 *
 * Receives semantic GameEvents, resolves subscribers, dedups, and routes:
 *   routine (game_start, score_change) → templated delivery (no LLM)
 *   headline (lead_change, final)      → engine.run() reasoning, with a
 *                                        templated fallback if the engine
 *                                        throws (e.g. daily budget exhausted)
 *
 * Collaborators are injected so the orchestration is unit-testable with fakes.
 * Production wiring lives in the Telegram listener (see plan Task 5).
 */

import type { GameEvent, GameState, GameSubscription, GameEventType } from "./types.js";
import type { GameSubscriptionStore } from "./game-subscriptions.js";

const HEADLINE: ReadonlySet<GameEventType> = new Set(["lead_change", "final"]);
const DEDUP_TTL_MS = 30 * 60 * 1000; // 30 min

export interface DeliveryTarget {
  platform: GameSubscription["platform"];
  chatId: string;
}

export interface GameAlertServiceDeps {
  store: GameSubscriptionStore;
  /** Send a message to a target. Returns true on success. */
  deliver: (target: DeliveryTarget, text: string) => Promise<boolean>;
  /** Produce a fan-aware headline message via the engine. May throw (budget). */
  runEngine: (prompt: string, sub: GameSubscription) => Promise<string>;
  /** Clock injection for dedup TTL (default Date.now). */
  now?: () => number;
}

/** Render a deterministic, zero-LLM alert line for an event. */
export function renderAlert(event: GameEvent, sub: GameSubscription): string {
  const { state } = event;
  const score = `${state.home} ${state.homeScore}–${state.awayScore} ${state.away}`;
  switch (event.type) {
    case "game_start": return `🟢 Kickoff: ${score}`;
    case "score_change": return `⚽ Score: ${score}`;
    case "lead_change": {
      const leader = state.leader === "home" ? state.home : state.away;
      return `🔄 ${leader} take the lead — ${score}`;
    }
    case "final": return `✅ Final: ${score}`;
    default: return score;
  }
}

/** Build the constrained engine prompt for a headline event. */
export function headlinePrompt(event: GameEvent, sub: GameSubscription): string {
  const { state } = event;
  return [
    `A game you are following just had a ${event.type.replace("_", " ")}.`,
    `Game: ${state.home} ${state.homeScore}–${state.awayScore} ${state.away} (${state.status}).`,
    `The user follows ${sub.team}.`,
    `Write a single short, punchy alert message (1–2 sentences) for the user,`,
    `using anything you know about ${sub.team} and this matchup from memory.`,
    `Do not ask questions. Do not call tools. Just the message.`,
  ].join(" ");
}

export class GameAlertService {
  private deps: GameAlertServiceDeps;
  private now: () => number;
  private seen = new Map<string, number>(); // dedup key → timestamp

  constructor(deps: GameAlertServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  private dedupKey(event: GameEvent): string {
    return `${event.gameId}:${event.type}:${event.scoreSignature}`;
  }

  private firstSeen(event: GameEvent): boolean {
    const key = this.dedupKey(event);
    const ts = this.now();
    const prev = this.seen.get(key);
    if (prev !== undefined && ts - prev < DEDUP_TTL_MS) return false;
    this.seen.set(key, ts);
    // Opportunistic prune
    if (this.seen.size > 5000) {
      for (const [k, t] of this.seen) if (ts - t >= DEDUP_TTL_MS) this.seen.delete(k);
    }
    return true;
  }

  /** Subscribers interested in either team of the event's game. */
  private async resolveSubscribers(state: GameState): Promise<GameSubscription[]> {
    const [home, away] = await Promise.all([
      this.deps.store.findSubscribers(state.sport, state.home),
      this.deps.store.findSubscribers(state.sport, state.away),
    ]);
    const byTarget = new Map<string, GameSubscription>();
    for (const s of [...home, ...away]) byTarget.set(`${s.platform}:${s.chatId}`, s);
    return [...byTarget.values()];
  }

  /** Process one semantic event: dedup, resolve, route, deliver. */
  async handleEvent(event: GameEvent): Promise<void> {
    if (!this.firstSeen(event)) return;
    const subs = await this.resolveSubscribers(event.state);
    if (subs.length === 0) return;

    for (const sub of subs) {
      let text: string;
      if (HEADLINE.has(event.type)) {
        try {
          text = (await this.deps.runEngine(headlinePrompt(event, sub), sub)).trim()
            || renderAlert(event, sub);
        } catch (err) {
          console.error(
            `[sportsclaw] alert engine fallback (${event.type}): ${err instanceof Error ? err.message : err}`
          );
          text = renderAlert(event, sub);
        }
      } else {
        text = renderAlert(event, sub);
      }

      try {
        await this.deps.deliver({ platform: sub.platform, chatId: sub.chatId }, text);
      } catch (err) {
        console.error(
          `[sportsclaw] alert delivery failed (${sub.platform}:${sub.chatId}): ${err instanceof Error ? err.message : err}`
        );
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/game-alerts.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Add package.json script and commit**

```json
"test:game-alerts": "npm run build && node --test test/game-alerts.test.mjs",
```
```bash
git add src/game-alerts.ts test/game-alerts.test.mjs package.json
git commit -m "feat(alerts): GameAlertService — dedup, subscriber resolution, hybrid delivery

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: Engine tools + Telegram wiring (end-to-end)

This task connects the units: the subscribe/unsubscribe tools let a user opt in via chat, and the Telegram listener threads the delivery target through `run()` and runs the polling→detect→deliver loop. Because the loop and tools need a live process, the automated tests here cover the tools' `execute` against a temp store; the full poll loop is verified manually (Step 9).

**Files:**
- Modify: `src/types.ts` (`RunOptions`: add `platform`, `chatId`)
- Modify: `src/engine.ts` (capture platform/chatId; register two tools)
- Modify: `src/listeners/telegram.ts` (pass platform/chatId to `run()`; boot the alert loop)
- Test: `test/game-alert-tools.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add delivery context to `RunOptions`**

In `src/types.ts` `RunOptions` (~line 357), after `systemPrompt?`:
```typescript
  /** Platform the request arrived on (used by alert-subscription tools). */
  platform?: "telegram" | "discord" | "cli";
  /** Delivery target id for proactive alerts (e.g. Telegram chat_id). */
  chatId?: string;
```

- [ ] **Step 2: Capture platform/chatId in the engine run**

In `src/engine.ts`, find where `runUserId` is derived for the tool closures (near `const watcherUserId = runUserId ?? "anonymous";`, line ~1569). Add alongside it:
```typescript
    const watcherPlatform = options?.platform ?? "cli";
    const watcherChatId = options?.chatId ?? runUserId ?? "";
```
(`options` is the `RunOptions` argument to `run()`; confirm the parameter name in scope — it is the same object whose `userId` produced `runUserId`. If `runUserId` was destructured earlier, read `options?.platform` from the same source.)

- [ ] **Step 3: Write the failing test for the tools**

Create `test/game-alert-tools.test.mjs`:
```js
/**
 * subscribe_team_alerts / unsubscribe_team_alerts — engine tool behavior,
 * tested at the store boundary the tools write through.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GameSubscriptionStore } from "../dist/game-subscriptions.js";
import { applyAlertSubscription, removeAlertSubscription } from "../dist/game-alerts.js";

let dir, store;

describe("alert subscription tool helpers", () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sc-alerttools-")); store = new GameSubscriptionStore(dir); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("applyAlertSubscription persists a subscription", async () => {
    const res = await applyAlertSubscription(store, {
      userId: "u1", platform: "telegram", chatId: "555", sport: "soccer", team: "Brazil",
      now: "2026-06-12T00:00:00.000Z",
    });
    assert.match(res, /Brazil/);
    const list = await store.listForUser("u1", "telegram");
    assert.equal(list.length, 1);
    assert.equal(list[0].sport, "soccer");
  });

  it("rejects a missing sport or team", async () => {
    const res = await applyAlertSubscription(store, {
      userId: "u1", platform: "telegram", chatId: "555", sport: "", team: "Brazil",
      now: "2026-06-12T00:00:00.000Z",
    });
    assert.match(res, /Error/i);
    assert.equal((await store.listForUser("u1", "telegram")).length, 0);
  });

  it("removeAlertSubscription deletes it", async () => {
    await applyAlertSubscription(store, {
      userId: "u1", platform: "telegram", chatId: "555", sport: "soccer", team: "Brazil",
      now: "2026-06-12T00:00:00.000Z",
    });
    const res = await removeAlertSubscription(store, {
      userId: "u1", platform: "telegram", sport: "soccer", team: "Brazil",
    });
    assert.match(res, /removed|unsubscribed/i);
    assert.equal((await store.listForUser("u1", "telegram")).length, 0);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm run build && node --test test/game-alert-tools.test.mjs`
Expected: FAIL — `applyAlertSubscription` not exported from `dist/game-alerts.js`.

- [ ] **Step 5: Add the tool helpers to `src/game-alerts.ts`**

These pure helpers hold the tool logic so it is testable without constructing an engine. Add to `src/game-alerts.ts`:
```typescript
/** Tool helper: validate + persist a subscription. Returns a user-facing string. */
export async function applyAlertSubscription(
  store: GameSubscriptionStore,
  params: {
    userId: string; platform: GameSubscription["platform"]; chatId: string;
    sport: string; team: string; now: string;
  }
): Promise<string> {
  const sport = params.sport?.trim().toLowerCase();
  const team = params.team?.trim();
  if (!sport || !team) return "Error: both sport and team are required.";
  if (!params.chatId) return "Error: no delivery target available for alerts on this platform.";
  await store.add({
    userId: params.userId, platform: params.platform, chatId: params.chatId,
    sport, team, createdAt: params.now,
  });
  return `Subscribed to ${team} (${sport}) alerts. I'll message you on goals, lead changes, and the final.`;
}

/** Tool helper: remove a subscription. Returns a user-facing string. */
export async function removeAlertSubscription(
  store: GameSubscriptionStore,
  params: { userId: string; platform: GameSubscription["platform"]; sport: string; team: string }
): Promise<string> {
  const sport = params.sport?.trim().toLowerCase();
  const team = params.team?.trim();
  if (!sport || !team) return "Error: both sport and team are required.";
  const removed = await store.remove(params.userId, params.platform, sport, team);
  return removed ? `Unsubscribed from ${team} (${sport}) alerts.` : `You weren't subscribed to ${team} (${sport}).`;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run build && node --test test/game-alert-tools.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 7: Register the engine tools**

In `src/engine.ts`, where the other internal tools are registered (near the `create_task` tool, ~line 1605), add the import at the top with the other local imports:
```typescript
import { gameSubscriptionStore } from "./game-subscriptions.js";
import { applyAlertSubscription, removeAlertSubscription } from "./game-alerts.js";
```
Then register both tools (place beside `create_task`):
```typescript
    toolMap["subscribe_team_alerts"] = defineTool({
      description:
        "Subscribe the current user to proactive live-game alerts for a team. " +
        "When the team plays, the user gets messaged on kickoff, scores, lead changes, and the final. " +
        "Use when the user says things like 'alert me about Brazil' or 'tell me when the Lakers score'.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          sport: { type: "string", description: "Sport key, e.g. soccer, nba, nfl." },
          team: { type: "string", description: "Team name, e.g. Brazil, Lakers." },
        },
        required: ["sport", "team"],
      }),
      execute: async (args: { sport?: string; team?: string }) => {
        try {
          return await applyAlertSubscription(gameSubscriptionStore, {
            userId: watcherUserId,
            platform: watcherPlatform,
            chatId: watcherChatId,
            sport: args.sport ?? "",
            team: args.team ?? "",
            now: new Date().toISOString(),
          });
        } catch (err) {
          if (isHalt(err)) throw err;
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });

    toolMap["unsubscribe_team_alerts"] = defineTool({
      description:
        "Unsubscribe the current user from live-game alerts for a team.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          sport: { type: "string", description: "Sport key, e.g. soccer, nba." },
          team: { type: "string", description: "Team name, e.g. Brazil." },
        },
        required: ["sport", "team"],
      }),
      execute: async (args: { sport?: string; team?: string }) => {
        try {
          return await removeAlertSubscription(gameSubscriptionStore, {
            userId: watcherUserId,
            platform: watcherPlatform,
            sport: args.sport ?? "",
            team: args.team ?? "",
          });
        } catch (err) {
          if (isHalt(err)) throw err;
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });
```

- [ ] **Step 8: Wire the Telegram listener (delivery target + alert loop)**

In `src/listeners/telegram.ts`:

(a) At the `engine.run(...)` call in `processMessage` (~line 715), pass platform/chatId:
```typescript
    const response = await engine.run(prompt, {
      userId,
      sessionId: userId,
      platform: "telegram",
      chatId: String(msg.chat.id),
      images: images.length > 0 ? images : undefined,
    });
```
(Apply the same `platform`/`chatId` additions to the resume-path `engine.run(...)` at ~line 854, using that handler's `chatId`/`userId`.)

(b) Add imports at the top:
```typescript
import { gameSubscriptionStore } from "../game-subscriptions.js";
import { GameAlertService } from "../game-alerts.js";
import { detectGameEvents, normalizeScoreboard } from "../game-events.js";
import { executePythonBridge } from "../tools.js";
import type { GameState } from "../types.js";
```

(c) Add the alert loop near the bottom of the file, before `main()`'s polling loop starts. The loop polls each active sport's `scores`, normalizes, detects events against the prior snapshot, and feeds the service:
```typescript
function startGameAlertLoop(apiBase: string, engineConfig: Partial<sportsclawConfig>): () => void {
  const service = new GameAlertService({
    store: gameSubscriptionStore,
    deliver: async (target, text) => sendMessage(apiBase, Number(target.chatId), text),
    runEngine: async (prompt, sub) => {
      const engine = new sportsclawEngine(engineConfig);
      return engine.run(prompt, {
        userId: sub.userId, platform: "telegram", chatId: sub.chatId,
      });
    },
  });

  const lastStates = new Map<string, GameState>(); // gameId → last seen
  let stopped = false;
  const POLL_MS = 20_000;

  const tick = async () => {
    if (stopped) return;
    try {
      const sports = await gameSubscriptionStore.activeSports();
      for (const sport of sports) {
        const res = await executePythonBridge(sport, "scores", {}, engineConfig);
        if (!res.success) continue;
        for (const curr of normalizeScoreboard(sport, res.data)) {
          const prev = lastStates.get(curr.gameId);
          for (const event of detectGameEvents(prev, curr)) {
            await service.handleEvent(event);
          }
          lastStates.set(curr.gameId, curr);
        }
      }
    } catch (err) {
      console.error(`[sportsclaw] alert loop tick error: ${err instanceof Error ? err.message : err}`);
    }
    if (!stopped) setTimeout(tick, POLL_MS);
  };

  setTimeout(tick, POLL_MS);
  console.error("[sportsclaw] game alert loop started");
  return () => { stopped = true; };
}
```
Call `startGameAlertLoop(apiBase, engineConfig)` once during boot, right after `engineConfig` is built (~line 380) and `apiBase` is known. (Confirm `sportsclawEngine` and `sportsclawConfig` are imported — `sportsclawEngine` is imported at line 22; add `sportsclawConfig` to the type import if not already present.)

- [ ] **Step 9: Build, run all new suites, and manual smoke**

Run:
```bash
npm run build && node --test test/game-events.test.mjs test/game-subscriptions.test.mjs test/game-alerts.test.mjs test/game-alert-tools.test.mjs
```
Expected: ALL PASS.

Regression:
```bash
npm run test:halt-guard && npm run test:guardrails && npm run test:tool-call-part-guard
```
Expected: PASS.

Manual smoke (requires `TELEGRAM_BOT_TOKEN` + a live game): start the listener, DM the bot "alert me about <team playing now>", confirm a subscription file appears under `~/.sportsclaw/game-subscriptions/`, and confirm an alert message arrives within ~20s of a score/status change. Document the result in the PR.

- [ ] **Step 10: Add package.json script and commit**

```json
"test:game-alert-tools": "npm run build && node --test test/game-alert-tools.test.mjs",
```
```bash
git add src/types.ts src/engine.ts src/listeners/telegram.ts test/game-alert-tools.test.mjs package.json
git commit -m "feat(alerts): subscribe tools + Telegram delivery and polling loop (end-to-end)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Out of Scope (deferred fast-follows)

- Discord delivery (same shape behind the `deliver` collaborator).
- Auto-suggesting subscriptions from FAN_PROFILE.
- Soccer-specific events (scorer attribution, red card, penalty, halftime).
- A daily-digest consumer on the `game-events` channel.
- Moving the poll loop into a dedicated daemon (it lives in the Telegram listener process for v1).
- Per-game alert throttle beyond the dedup TTL (dedup keys on score signature already suppress repeats; add a rate cap only if flurries prove noisy).

## Self-Review Notes

- **Spec coverage:** Unit 1 store → Task 2; Unit 2 detector → Task 1; Unit 3 service → Task 4; Unit 4 hybrid delivery → Task 4 (`renderAlert`/headline routing) + Task 5 (real Telegram + engine wiring); Unit 5 relay channel → Task 3, tools → Task 5. Types → Task 1 + Task 5. Testing requirements → per-task test files. ✓
- **Type consistency:** `GameSubscription`/`GameState`/`GameEvent`/`GameEventType` defined in Task 1, used identically in Tasks 2–5. `DeliveryTarget` (Task 4) `{platform, chatId}` matches `deliver` usage in Task 5. `findSubscribers`/`activeSports`/`add`/`remove`/`listForUser` signatures match between Task 2 definition and Task 4/5 use. ✓
- **Ambiguity:** the one real unknown — exact score/status field names in the `scores` payload — is resolved by capturing a real fixture in Task 1 Step 1 before writing the normalizer, with a documented fallback shape. ✓
- **Throttle:** spec mentioned a per-game/minute throttle; v1 relies on the dedup-by-score-signature key (identical events suppressed for 30 min) and defers an additional rate cap to fast-follows — noted above so it isn't a silent omission.
