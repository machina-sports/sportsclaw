# Productionize Proactive Game Presence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make proactive game presence multi-channel and robust — Discord delivery, per-platform-filtered loops, nickname aliasing, and a live (but non-load-bearing) `game-events` relay channel.

**Architecture:** Each listener runs its own poll loop with a platform-filtered `GameAlertService`. The detector's events are published best-effort to `game-events` AND drive the service directly (hybrid). A curated alias map closes the nickname gap on top of the existing token-subset match.

**Tech Stack:** TypeScript/ESM; `node:test`+`assert/strict` tests in `test/*.test.mjs` from `../dist/*.js`. Builds on branch `feat/proactive-game-presence`. Spec: `docs/superpowers/specs/2026-06-12-proactive-game-presence-productionize-design.md`.

**Conventions:** explicit `.js` imports; `npm run build` clean = success; one `test:<name>` script per new test file; `console.error("[sportsclaw] ...")` logs.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/game-alerts.ts` | Modify | Add `platform` filter to deps; export `publishGameEvent` |
| `src/game-subscriptions.ts` | Modify | `TEAM_ALIASES` map + alias expansion in `teamMatches` |
| `src/listeners/telegram.ts` | Modify | Service gets `platform:"telegram"`; loop publishes events |
| `src/listeners/discord.ts` | Modify | Pass platform/chatId to run(); Discord alert loop at boot |
| `test/game-alerts.test.mjs` | Modify | Platform-filter + publish-isolation tests |
| `test/game-subscriptions.test.mjs` | Modify | Alias matching tests |

---

## Task 1: Platform filter + relay publish helper (`game-alerts.ts`)

**Files:** Modify `src/game-alerts.ts`; Modify `test/game-alerts.test.mjs`.

- [ ] **Step 1: Add failing tests** — append inside the existing `describe("GameAlertService", ...)` block in `test/game-alerts.test.mjs`:

```js
  it("a platform-filtered service ignores subscribers on other platforms", async () => {
    // store (from beforeEach) has a telegram sub for Brazil. Add a discord one too.
    await store.add({ userId: "d1", platform: "discord", chatId: "chan1",
      sport: "soccer", team: "Brazil", createdAt: "2026-06-12T00:00:00.000Z" });
    const svc = makeService({ platform: "telegram" });
    await svc.handleEvent(evt());
    assert.equal(sent.length, 1, "only the telegram subscriber delivered");
    assert.equal(sent[0].target.platform, "telegram");
  });

  it("a discord-filtered service delivers to the discord subscriber", async () => {
    await store.add({ userId: "d1", platform: "discord", chatId: "chan1",
      sport: "soccer", team: "Brazil", createdAt: "2026-06-12T00:00:00.000Z" });
    const svc = makeService({ platform: "discord" });
    await svc.handleEvent(evt());
    assert.equal(sent.length, 1);
    assert.equal(sent[0].target.platform, "discord");
    assert.equal(sent[0].target.chatId, "chan1");
  });

  it("no platform set delivers to all (backward compatible)", async () => {
    await store.add({ userId: "d1", platform: "discord", chatId: "chan1",
      sport: "soccer", team: "Brazil", createdAt: "2026-06-12T00:00:00.000Z" });
    const svc = makeService(); // no platform
    await svc.handleEvent(evt());
    assert.equal(sent.length, 2);
  });
```

Also add a separate top-level test for the publish helper (after the describe block):

```js
import { publishGameEvent } from "../dist/game-alerts.js";

describe("publishGameEvent", () => {
  it("never throws even if the relay rejects", async () => {
    // publishGameEvent swallows errors; calling it must resolve, not reject.
    await assert.doesNotReject(() => publishGameEvent(evt()));
  });
});
```

- [ ] **Step 2: Run** `npm run build && node --test test/game-alerts.test.mjs` — expect FAIL (`platform` opt ignored / `publishGameEvent` not exported).

- [ ] **Step 3: Implement.** In `src/game-alerts.ts`:

Add `relayManager` import at the top:
```typescript
import { relayManager } from "./relay.js";
```

Add `platform` to `GameAlertServiceDeps` (after `now?`):
```typescript
  /** When set, only deliver to subscribers on this platform (per-listener loops). */
  platform?: GameSubscription["platform"];
```

Store it in the constructor — add a field and assignment:
```typescript
  private platform?: GameSubscription["platform"];
```
and in the constructor body:
```typescript
    this.platform = deps.platform;
```

In `resolveSubscribers`, filter by platform before returning. Change the final return:
```typescript
    const resolved = [...byTarget.values()];
    return this.platform ? resolved.filter((s) => s.platform === this.platform) : resolved;
```

Add the exported best-effort publish helper at the end of the file:
```typescript
/** Best-effort publish of a GameEvent to the relay's game-events channel.
 * Never rejects — relay availability must not affect core alert delivery. */
export async function publishGameEvent(event: GameEvent): Promise<void> {
  try {
    await relayManager.publish("game-events", event);
  } catch {
    // relay broker unavailable / not configured — ignore.
  }
}
```

- [ ] **Step 4: Run** `npm run build && node --test test/game-alerts.test.mjs` — expect PASS (6 existing + 3 filter + 1 publish = 10).

- [ ] **Step 5: Commit**
```bash
git add src/game-alerts.ts test/game-alerts.test.mjs
git commit -m "feat(alerts): per-platform subscriber filter + best-effort game-events publish

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Team nickname alias map (`game-subscriptions.ts`)

**Files:** Modify `src/game-subscriptions.ts`; Modify `test/game-subscriptions.test.mjs`.

- [ ] **Step 1: Add failing tests** — append inside the existing describe block in `test/game-subscriptions.test.mjs`:

```js
  it("alias map resolves a non-substring nickname (Niners -> 49ers)", async () => {
    const store = new GameSubscriptionStore(dir);
    await store.add(sub({ team: "Niners", sport: "nfl" }));
    const subs = await store.findSubscribers("nfl", "San Francisco 49ers");
    assert.equal(subs.length, 1);
  });

  it("alias map resolves Man U -> Manchester United", async () => {
    const store = new GameSubscriptionStore(dir);
    await store.add(sub({ team: "Man U", sport: "football" }));
    assert.equal((await store.findSubscribers("football", "Manchester United")).length, 1);
  });

  it("aliasing does not over-match unrelated teams", async () => {
    const store = new GameSubscriptionStore(dir);
    await store.add(sub({ team: "Niners", sport: "nfl" }));
    assert.equal((await store.findSubscribers("nfl", "Dallas Cowboys")).length, 0);
  });
```

- [ ] **Step 2: Run** `npm run build && node --test test/game-subscriptions.test.mjs` — expect the 3 new ones FAIL (alias not applied).

- [ ] **Step 3: Implement.** In `src/game-subscriptions.ts`:

Add the alias map near the top (after imports):
```typescript
/** Well-known non-substring nicknames → a canonical token present in the full name.
 * Token-subset matching already covers substring nicknames (e.g. "Lakers"). */
const TEAM_ALIASES: Record<string, string> = {
  "niners": "49ers",
  "the niners": "49ers",
  "man u": "manchester united",
  "man utd": "manchester united",
  "red devils": "manchester united",
  "man city": "manchester city",
  "spurs": "tottenham",
  "gunners": "arsenal",
  "a's": "athletics",
  "nats": "nationals",
  "g-men": "giants",
  "habs": "canadiens",
  "cards": "cardinals",
};
```

Add an `applyAlias` helper and use it in `teamMatches`. Replace the `teamMatches` method:
```typescript
  /** True if team names refer to the same team: exact, alias-expanded, or token-subset. */
  private teamMatches(a: string, b: string): boolean {
    const expand = (s: string): string => {
      const key = s.trim().toLowerCase();
      return TEAM_ALIASES[key] ?? key;
    };
    const norm = (s: string) => expand(s).split(/\s+/).filter(Boolean);
    const at = norm(a), bt = norm(b);
    if (at.length === 0 || bt.length === 0) return false;
    const aset = new Set(at), bset = new Set(bt);
    const subset = (small: string[], big: Set<string>) => small.every((t) => big.has(t));
    return subset(at, bset) || subset(bt, aset);
  }
```

- [ ] **Step 4: Run** `npm run build && node --test test/game-subscriptions.test.mjs` — expect PASS (11 existing + 3 = 14).

- [ ] **Step 5: Commit**
```bash
git add src/game-subscriptions.ts test/game-subscriptions.test.mjs
git commit -m "feat(alerts): curated team-nickname alias map for subscriber matching

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: Telegram loop — platform filter + publish (`telegram.ts`)

**Files:** Modify `src/listeners/telegram.ts`.

- [ ] **Step 1: Add the import** — add `publishGameEvent` to the existing `GameAlertService` import line:
```typescript
import { GameAlertService, publishGameEvent } from "../game-alerts.js";
```

- [ ] **Step 2: Set the service platform.** In `startGameAlertLoop`, the `new GameAlertService({...})` call gains `platform: "telegram"`:
```typescript
  const service = new GameAlertService({
    store: gameSubscriptionStore,
    platform: "telegram",
    deliver: async (target, text) => sendMessage(apiBase, Number(target.chatId), text),
    runEngine: async (prompt, sub) => {
      const engine = new sportsclawEngine(engineConfig);
      return engine.run(prompt, { userId: sub.userId, platform: "telegram", chatId: sub.chatId });
    },
  });
```

- [ ] **Step 3: Publish events in the loop.** In the `tick`'s inner detect loop, add a best-effort publish next to the handleEvent call:
```typescript
          for (const event of detectGameEvents(prev, curr)) {
            void publishGameEvent(event);
            await service.handleEvent(event);
          }
```

- [ ] **Step 4: Build + regression**
```bash
npm run build && node --test test/game-alerts.test.mjs test/game-subscriptions.test.mjs test/game-events.test.mjs test/game-alert-tools.test.mjs
```
Expected: ALL PASS.

- [ ] **Step 5: Commit**
```bash
git add src/listeners/telegram.ts
git commit -m "feat(alerts): telegram loop filters to its platform and publishes game-events

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: Discord delivery + alert loop (`discord.ts`)

**Files:** Modify `src/listeners/discord.ts`.

- [ ] **Step 1: Add imports** (near `import { sportsclawEngine } from "../engine.js";`, line ~24):
```typescript
import { gameSubscriptionStore } from "../game-subscriptions.js";
import { GameAlertService, publishGameEvent } from "../game-alerts.js";
import { detectGameEvents, normalizeScoreboard } from "../game-events.js";
import { executePythonBridge } from "../tools.js";
import type { GameState } from "../types.js";
```

- [ ] **Step 2: Capture the delivery target on the main message run.** At the main `messageCreate` handler's `engine.run` (line ~700):
```typescript
      const response = await engine.run(prompt, {
        userId,
        sessionId: userId,
        platform: "discord",
        chatId: String(message.channel.id),
      });
```
(Leave the button/QA resume `engine.run` calls — lines ~434/495/541 — as-is; those are follow-ups, not subscription entry points. Subscribing happens through normal messages.)

- [ ] **Step 3: Add the alert loop function** (place near the bottom of the file, before `startDiscordListener`'s definition or after it — a module-scope function). `engineConfig` is in scope inside `startDiscordListener` (line 159); the loop is started from inside `ClientReady`, so define it to take `client` + `engineConfig`:
```typescript
function startDiscordGameAlertLoop(
  client: Discord.Client,
  engineConfig: ReturnType<typeof buildListenerEngineConfig>
): () => void {
  const service = new GameAlertService({
    store: gameSubscriptionStore,
    platform: "discord",
    deliver: async (target, text) => {
      try {
        const ch = await client.channels.fetch(target.chatId);
        if (ch && ch.isTextBased() && "send" in ch) {
          await (ch as Discord.TextChannel).send(text);
          return true;
        }
      } catch (err) {
        console.error(`[sportsclaw] discord alert deliver error: ${err instanceof Error ? err.message : err}`);
      }
      return false;
    },
    runEngine: async (prompt, sub) => {
      const engine = new sportsclawEngine(engineConfig);
      return engine.run(prompt, { userId: sub.userId, platform: "discord", chatId: sub.chatId });
    },
  });

  const lastStates = new Map<string, GameState>();
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
            void publishGameEvent(event);
            await service.handleEvent(event);
          }
          lastStates.set(curr.gameId, curr);
        }
      }
    } catch (err) {
      console.error(`[sportsclaw] discord alert loop tick error: ${err instanceof Error ? err.message : err}`);
    }
    if (!stopped) setTimeout(tick, POLL_MS);
  };

  setTimeout(tick, POLL_MS);
  console.error("[sportsclaw] discord game alert loop started");
  return () => { stopped = true; };
}
```
(Confirm `buildListenerEngineConfig` is imported/defined in discord.ts — it's used at line 159. If its return type isn't easily referenced, type the param as `Partial<sportsclawConfig>` and import `sportsclawConfig` type from `../types.js`.)

- [ ] **Step 4: Start the loop at ClientReady.** Inside the `client.once(Discord.Events.ClientReady, ...)` callback (line ~575), after the connect log, add:
```typescript
    startDiscordGameAlertLoop(client, engineConfig);
```

- [ ] **Step 5: Build + full regression**
```bash
npm run build && node --test test/game-alerts.test.mjs test/game-subscriptions.test.mjs test/game-events.test.mjs test/game-alert-tools.test.mjs
```
Expected: ALL PASS. Then `npm run test:guardrails && npm run test:halt-guard`.

- [ ] **Step 6: Manual smoke (document in PR).** With `DISCORD_BOT_TOKEN` set and a live game on: run the Discord listener, in a server channel send `<prefix> alert me about <team playing now>`, confirm a subscription file under `~/.sportsclaw/game-subscriptions/` with `platform:"discord"` and the channel id, and confirm an alert posts to that channel within ~20s of a score/status change.

- [ ] **Step 7: Commit**
```bash
git add src/listeners/discord.ts
git commit -m "feat(alerts): Discord channel delivery + per-platform alert loop

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Out of Scope (deferred)
Auto-suggest subscriptions from FAN_PROFILE; soccer-specific events; dedicated alert daemon; DM-based Discord delivery; a real `game-events` subscriber/consumer (the channel is now published-to and ready, but no consumer is built in this plan).

## Self-Review Notes
- **Spec coverage:** §1 platform filter → Task 1; §2 aliasing → Task 2; §3 relay publish → Task 1 (helper) + Tasks 3/4 (call sites); §4 Discord delivery → Task 4; Telegram platform/publish → Task 3. ✓
- **Type consistency:** `publishGameEvent(event: GameEvent)` and `GameAlertServiceDeps.platform: GameSubscription["platform"]` match usage in Tasks 3/4. `deliver` signature `(target: DeliveryTarget, text) => Promise<boolean>` unchanged; the Discord adapter returns boolean. ✓
- **Backward compatibility:** `platform` is optional — services constructed without it (the existing 6 game-alerts tests) behave as before; a new test asserts the no-platform path delivers to all. ✓
- **Ambiguity:** the `game-events` channel is now genuinely published-to (hybrid); no consumer is in scope, stated explicitly so it isn't a silent gap.
