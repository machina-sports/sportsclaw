# Proactive Game Presence — v1 Design

**Status:** Approved (brainstorm 2026-06-12)
**Feature:** #1 from the June 2026 harness analysis — the flagship "AGI moment for sports."

## Overview

The sportsclaw agent proactively messages a user when something happens in a game they care about — a goal, a lead change, a final whistle — within a poll-interval of the moment, enriched with context from their fan profile. The user opts in once ("alert me about Brazil and the Lakers") and the agent shows up on its own initiative during matches.

This is the differentiator no general harness can structurally provide (their heartbeats are minute-scale) and no sports incumbent packages as an open agent: live-event detection + per-user subscriptions + fan-aware messaging fused into the harness's existing relay.

## Goals & Success Criteria

- A user can subscribe to a team via chat and receive an alert on the next qualifying event in that team's live game, delivered to their chat without them asking.
- Routine events (score, start) arrive fast and cheap (templated, zero LLM). Headline events (lead change, final) arrive with fan-aware reasoning (engine.run()).
- No duplicate alerts for the same event; no spam during score flurries.
- A budget-exhausted user still gets templated alerts (graceful degradation), never a crash.
- The detector and subscription store are pure/deterministic and covered by unit tests.

## Decisions (locked during brainstorm)

| Decision | Choice |
|---|---|
| Alert brain | **Hybrid** — templated for routine events, `engine.run()` for headline events |
| Subscription model | **Team-level** — subscribe to a team, auto-covers all its live games |
| Event taxonomy | **Sport-agnostic core** — `game_start`, `score_change`, `lead_change`, `final`; extensible |
| v1 scope | **Thin vertical slice** — one end-to-end path, then expand |
| Detection ↔ delivery seam | **Relay-mediated** — detector publishes to a new `game-events` channel |
| Delivery channel (v1) | **Telegram first** — Discord is the same shape, immediate fast-follow |
| Subscription source | **Explicit chat tool** — auto-derive-from-fan-profile is a fast-follow |

## Architecture

Five units, each with one responsibility and a well-defined interface:

```
 chat "alert me about Brazil"
   → subscribe_team_alerts tool (engine) → GameSubscriptionStore.add()  [persisted]

 Watcher (existing) ──poll scoreboard──▶ GameAlertService.onSnapshot()
                                              │ normalizeScoreboard()
                                              │ detectGameEvents(prev, curr)  [pure]
                                              │ publish GameEvent[] → "game-events" relay channel
                                              ▼
 GameAlertService (subscribes to "game-events")
   → dedup (gameId:type:scoreSig + per-game throttle)
   → GameSubscriptionStore.findSubscribers(sport, team)
   → route: routine → templated | headline → engine.run() (budget-guarded)
   → Telegram sendMessage(chatId, text)
```

### Unit 1 — `GameSubscriptionStore` (`src/game-subscriptions.ts`, new)

- **Does:** persists team-level alert subscriptions per user; resolves which users care about a given team.
- **Interface:**
  - `add(sub: GameSubscription): Promise<void>`
  - `remove(userId, platform, sport, team): Promise<boolean>`
  - `listForUser(userId, platform): Promise<GameSubscription[]>`
  - `findSubscribers(sport, team): Promise<GameSubscription[]>`
  - `activeSports(): Promise<string[]>` — distinct sports across all subscriptions (drives which scoreboards to poll)
- **Storage:** one JSON file per user under `~/.sportsclaw/game-subscriptions/` (env `SPORTSCLAW_SUBS_DIR` override), atomic temp+rename writes, sanitized filenames — the exact pattern shipped in P1 (`SessionStore`/`FileMemoryStorage`).
- **Depends on:** node:fs/promises only.

### Unit 2 — `detectGameEvents` + `normalizeScoreboard` (`src/game-events.ts`, new)

- **Does:** the semantic core. `normalizeScoreboard(snapshot)` extracts `GameState[]` from a raw sports-skills scoreboard payload; `detectGameEvents(prev, curr)` diffs two `GameState`s for one game and returns typed `GameEvent[]`.
- **Pure & deterministic** — no I/O, no clock dependence beyond values passed in. This is the most heavily unit-tested unit.
- **Event rules (sport-agnostic):**
  - `game_start` — status transitions scheduled → in_progress.
  - `score_change` — either side's score increases.
  - `lead_change` — the leader changes (incl. tie→lead and lead→tie boundary handled explicitly).
  - `final` — status transitions to final.
- **Interface:**
  - `normalizeScoreboard(sport: string, snapshot: unknown): GameState[]`
  - `detectGameEvents(prev: GameState | undefined, curr: GameState): GameEvent[]`
- **Depends on:** types only. Field-path extraction in `normalizeScoreboard` is pinned against real scoreboard fixtures during implementation (one fixture per sport in v1).

### Unit 3 — `GameAlertService` (`src/game-alerts.ts`, new)

- **Does:** orchestrates the loop. Starts/stops a `Watcher` per active sport, holds last-seen `GameState` per `gameId`, runs the detector each tick, publishes events to the relay, subscribes to `game-events`, dedups, resolves subscribers, routes delivery.
- **Dedup:** in-memory seen-set keyed `gameId:type:scoreSignature` with a TTL; plus a per-game alert throttle (max N alerts/game/minute) so corrections/flurries don't spam.
- **Interface:**
  - `start(): Promise<void>` / `stop(): Promise<void>`
  - `refreshWatchers(): Promise<void>` — reconcile running watchers against `activeSports()` (called on subscribe/unsubscribe)
- **Depends on:** `Watcher`/`WatchManager`, `relayManager`, `GameSubscriptionStore`, `detectGameEvents`, the delivery adapter, and (for headline events) an engine factory.

### Unit 4 — Delivery (hybrid brain) (within `src/game-alerts.ts` + a small `renderAlert` helper)

- **Routine** (`game_start`, `score_change`): `renderAlert(event, subscription)` → deterministic template string (event line + one-line fan-profile snippet if available). Zero LLM.
- **Headline** (`lead_change`, `final`): `engine.run()` with a constrained prompt embedding the event + fan profile, producing fan-aware reasoning. Guarded by the P2 `dailyTokenBudget` gate — if `run()` throws budget-exhausted, fall back to `renderAlert` (templated). Headline delivery is best-effort: any failure logs and falls through to templated.
- **Transport (v1):** Telegram `POST /bot<token>/sendMessage {chat_id, text}` — same call `GamePresenter.updateTelegram` already uses. The `chatId` + bot token are captured in the subscription / resolved from Telegram config.

### Unit 5 — Relay channel + engine tool surface

- **`game-events` channel:** add to `SportsClawChannels` in `relay.ts`, payload `GameEvent`. Detector publishes; `GameAlertService` subscribes. Decouples detection from delivery and lets future consumers (digest, analytics) attach.
- **Engine tools:** `subscribe_team_alerts({ sport, team })` and `unsubscribe_team_alerts({ sport, team })` registered in the engine's tool map, writing through `GameSubscriptionStore` using the run's `userId`/platform/chatId. Mirrors the existing `create_task`/`taskbus` tool pattern.

## Types (new, in `src/types.ts`)

```ts
export interface GameSubscription {
  userId: string;
  platform: "telegram" | "discord" | "cli";
  chatId: string;           // delivery target (Telegram chat_id, etc.)
  sport: string;
  team: string;             // normalized team identifier/name
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
  state: GameState;         // current state snapshot
  scoreSignature: string;   // `${homeScore}-${awayScore}` for dedup
  timestamp: string;
}
```

## Error Handling

- `normalizeScoreboard` tolerates malformed/partial payloads → returns `[]` (never throws). A game missing required fields is skipped.
- `detectGameEvents` with `prev === undefined` (first sighting) emits only `game_start`/`final` if the status already indicates it, never a phantom `score_change`.
- Watcher failures already back off (existing behavior) and are now further protected by the P0 circuit breaker.
- Delivery failures (Telegram API error) are logged and never crash the alert loop.
- Budget-exhausted headline `engine.run()` falls back to templated delivery.

## Testing

- **`detectGameEvents`** (unit, exhaustive): start transition; single + simultaneous score changes; lead flip home↔away; tie→lead and lead→tie; final transition; no-change → `[]`; first-sighting behavior.
- **`normalizeScoreboard`** (unit, fixture-driven): one real scoreboard fixture per v1 sport → correct `GameState[]`; malformed payload → `[]`.
- **`GameSubscriptionStore`** (unit): add/remove/list round-trip across instances (disk persistence), `findSubscribers` matching, `activeSports` distinctness, atomic-write/no-temp-files, sanitized filenames — mirrors the P1 session-store test.
- **`GameAlertService`** (integration with a fake Watcher/relay + stub delivery): dedup (no double-fire on repeated identical events), throttle, subscriber resolution, routine→templated vs headline→engine path selection, budget-exhausted fallback, delivery-failure isolation.

## Scope Boundaries (v1 is NOT)

- **Not** Discord delivery (same shape; immediate fast-follow behind the delivery adapter interface).
- **Not** auto-derived subscriptions from FAN_PROFILE (explicit tool only).
- **Not** sub-second — latency is bounded by the Watcher poll interval (configurable, ~15–30s); no push feed exists from ESPN.
- **Not** soccer-specific events (red card, penalty, scorer attribution) — the taxonomy is left extensible for these as a follow-up.
- **Not** edit-in-place scoreboard cards — that is the separate existing `GamePresenter` concern; alerts are user-centric one-shot messages.

## Fast-follows (explicitly deferred)

Discord delivery; auto-suggest subscriptions from fan profile; soccer-rich event taxonomy; a daily digest consumer on the `game-events` channel; relay-published events feeding the existing `GamePresenter` scoreboard cards.
