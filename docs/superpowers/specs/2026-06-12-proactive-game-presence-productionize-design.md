# Productionize Proactive Game Presence — Design

**Status:** Approved (brainstorm 2026-06-12)
**Builds on:** `feat/proactive-game-presence` (PR #82). Extends the v1 thin slice — see `2026-06-12-proactive-game-presence-design.md`.

## Overview

Turn the Telegram-only v1 thin slice into a robust, multi-channel feature: add Discord delivery, close the team-name matching gap for well-known nicknames, and make the declared `game-events` relay channel genuinely live (without making core delivery depend on it).

## Goals

- A Discord user can subscribe to a team in a channel and receive alerts posted to that channel.
- Each listener process delivers only to its own platform's subscribers (no cross-platform misdelivery from the shared store).
- Common non-substring nicknames ("Niners", "Man U") resolve to the right team.
- The `game-events` channel carries real events for future consumers, while core alert delivery stays reliable even if the relay broker is down.

## Decisions (locked during brainstorm)

| Decision | Choice |
|---|---|
| Discord delivery target | **Channel where subscribed** (`chatId` = channel id; bot posts there) |
| Process model | **Per-listener loop**, each `GameAlertService` filtered to its own platform |
| Team aliasing | **Small curated alias map** layered on the existing token-subset match (metadata lookup ruled out — returns wrong teams for ambiguous nicknames) |
| Relay wiring | **Hybrid** — loop publishes `GameEvent` to `game-events` (best-effort) AND directly drives `service.handleEvent`; core delivery never depends on the relay broker or same-process loopback |

## Components

### 1. `GameAlertService` platform filter (`src/game-alerts.ts`)
- Add a `platform?: GameSubscription["platform"]` field to `GameAlertServiceDeps`.
- In `resolveSubscribers`, after collecting home+away subscribers, filter to those whose `platform === this.platform` when a platform is set (undefined = no filter, preserving current test behavior).
- Rationale: the Telegram and Discord loops read the same on-disk store via `findSubscribers` (cross-platform); each must deliver only to its own platform's targets.

### 2. Team aliasing (`src/game-subscriptions.ts`)
- Add a module-level `TEAM_ALIASES: Record<string, string>` mapping a normalized nickname → a canonical token present in the full name (e.g. `"niners": "49ers"`, `"man u": "manchester united"`, `"man utd": "manchester united"`, `"spurs": "tottenham"`, `"gunners": "arsenal"`, `"red devils": "manchester united"`, `"a's": "athletics"`, `"niners": "49ers"`). ~10-15 entries, US + soccer.
- In `teamMatches`, before tokenizing, run each input through an `applyAlias(name)` that, if the whole normalized string is a key in `TEAM_ALIASES`, substitutes the canonical value. Then the existing token-subset test runs on the (possibly aliased) strings.
- Exact keying in `add`/`remove` is unchanged (aliasing affects resolution only).

### 3. Relay publish in the loops (hybrid)
- A tiny best-effort publish helper: `publishGameEvent(event)` → `relayManager.publish("game-events", event).catch(() => {})`. Never awaited in a way that can block or throw into the loop.
- Each listener's poll loop, per detected event, calls `publishGameEvent(event)` (fire-and-forget) AND `await service.handleEvent(event)` (the reliable path).

### 4. Discord delivery (`src/listeners/discord.ts`)
- Pass `platform: "discord", chatId: String(message.channel.id)` to the `engine.run()` call(s) that handle user messages (so `subscribe_team_alerts` captures the channel as the delivery target). No engine/tool changes needed — the tool already reads platform/chatId from run options.
- Add `startGameAlertLoop(client, engineConfig)`: same poll structure as Telegram (20s, `activeSports()` → `executePythonBridge(sport,"scores")` → `normalizeScoreboard` → `detectGameEvents` vs per-game `lastStates`), constructing a `GameAlertService` with:
  - `platform: "discord"`
  - `deliver: async ({ chatId }, text) => { const ch = await client.channels.fetch(chatId); if (ch?.isTextBased() && "send" in ch) await ch.send(text); return true; }`
  - `runEngine`: fresh engine per call, `run(prompt, { userId: sub.userId, platform: "discord", chatId: sub.chatId })`
- Start the loop once at boot (after the client is ready / logged in).

### 5. Telegram loop gets the platform filter + publish
- Construct the Telegram `GameAlertService` with `platform: "telegram"`.
- Add `publishGameEvent(event)` (fire-and-forget) alongside the existing `handleEvent` call in the Telegram loop.

## Data flow (Discord, "alert me about the Niners" in #sports)
1. User message in channel `C` → engine.run with `platform:"discord", chatId:"C"` → `subscribe_team_alerts` persists `{platform:"discord", chatId:"C", sport:"nfl", team:"Niners"}`.
2. Discord poll loop: `nfl scores` → normalize → "San Francisco 49ers" game → `score_change` event.
3. Loop publishes event to `game-events` (best-effort) AND calls `service.handleEvent`.
4. Service (platform=discord) resolves subscribers for `nfl`/team via `teamMatches` — `"Niners"` aliases to `"49ers"`, token-subset of `"San Francisco 49ers"` → match; filters to discord subs → finds this one.
5. Delivery adapter fetches channel `C` and posts the alert.

## Error handling
- `deliver` for Discord: `channels.fetch` may reject (deleted channel / missing perms) → the service's per-subscriber try/catch isolates it (already present).
- `publishGameEvent` is best-effort; a relay failure is swallowed and never affects `handleEvent`.
- Platform filter: a service with no `platform` set behaves exactly as today (keeps existing tests valid).

## Testing
- **Unit (`game-alerts.test.mjs` additions):** a `platform:"telegram"` service ignores a discord-only subscriber; a `platform:"discord"` service delivers to it. A publish-throws fake confirms `handleEvent` still delivers (publish isolation).
- **Unit (`game-subscriptions.test.mjs` additions):** `findSubscribers("nfl","San Francisco 49ers")` matches a stored `"Niners"` subscription via the alias map; an unrelated alias does not over-match.
- **Manual smoke:** Discord bot in a server, subscribe in a channel for a team with a live game, confirm the alert posts to that channel within ~20s.
- Discord delivery adapter (needs a live client) is covered by manual smoke, not unit tests.

## Scope boundaries (still NOT in)
Auto-suggest subscriptions from FAN_PROFILE; soccer-specific events (scorer, red card); a dedicated alert daemon (loops stay in the listener processes); DM-based Discord delivery. Stays on `feat/proactive-game-presence`.
