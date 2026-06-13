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
import { GameSubscriptionStore } from "./game-subscriptions.js";

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
export function renderAlert(event: GameEvent, _sub: GameSubscription): string {
  const { state } = event;
  const score = `${state.home} ${state.homeScore}–${state.awayScore} ${state.away}`;
  switch (event.type) {
    case "game_start": return `🟢 Kickoff: ${score}`;
    case "score_change": return `📣 Score: ${score}`;
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
