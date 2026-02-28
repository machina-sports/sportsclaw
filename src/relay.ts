/**
 * sportsclaw — Relay Manager (Sprint 2 Live Games)
 *
 * Typed pub/sub layer on top of @agent-relay/sdk. The GameMonitor publishes
 * structured `LiveGameEvent` messages to the `live-games` channel; one or
 * more GamePresenter instances subscribe and render updates to Discord/Telegram.
 *
 * Event flow:
 *   ESPN API → GameMonitor → RelayManager.broadcastEvent() → channel
 *   channel → RelayManager.onMessage() → GamePresenter.handleMessage()
 */

import { AgentRelay } from '@agent-relay/sdk';
import type { Message as RelayMessage } from '@agent-relay/sdk';

// ---------------------------------------------------------------------------
// Live game event types — the contract between monitor and presenter
// ---------------------------------------------------------------------------

export type GameStatus = "scheduled" | "in_progress" | "halftime" | "final" | "delayed" | "postponed";

export interface TeamScore {
  id: string;
  name: string;
  abbreviation: string;
  score: number;
  logo?: string;
  /** Period-by-period scores (quarters, innings, sets, etc.) */
  periodScores?: number[];
}

export interface LiveGameState {
  gameId: string;
  sport: string;
  status: GameStatus;
  /** Human-readable status line: "4th 2:31", "TOP 7th", "2nd Half 67'" */
  statusDetail: string;
  home: TeamScore;
  away: TeamScore;
  /** Game clock or period indicator */
  clock: string;
  /** Venue name */
  venue?: string;
  /** ISO timestamp of last data fetch */
  lastUpdated: string;
}

export type LiveGameEventType =
  | "GAME_UPDATE"       // score/clock changed
  | "GAME_START"        // game transitioned to in_progress
  | "GAME_END"          // game transitioned to final
  | "SCORE_CHANGE"      // specific score delta detected
  | "STATUS_CHANGE";    // status changed (e.g. halftime)

export interface LiveGameEvent {
  event: LiveGameEventType;
  data: LiveGameState;
  /** What changed from the previous state (for presenters to highlight) */
  delta?: {
    homeScoreDelta?: number;
    awayScoreDelta?: number;
    previousStatus?: GameStatus;
  };
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Relay Manager — typed wrapper around AgentRelay pub/sub
// ---------------------------------------------------------------------------

export type LiveGameMessageHandler = (event: LiveGameEvent) => void;

export class RelayManager {
  private relay: AgentRelay | null = null;
  private handlers: LiveGameMessageHandler[] = [];
  private isInitialized = false;
  private broadcastChannel = "live-games";

  constructor() {}

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    this.relay = new AgentRelay({
      channels: [this.broadcastChannel, 'general'],
    });

    this.relay.onMessageReceived = (msg: RelayMessage) => {
      // Ignore presence/system events
      if (msg.eventId?.includes('presence')) return;
      if (!msg.text) return;

      // Only process messages on our channel
      if (msg.to !== this.broadcastChannel && msg.to !== `#${this.broadcastChannel}`) return;

      try {
        const event = JSON.parse(msg.text) as LiveGameEvent;
        if (!event.event || !event.data) return;

        for (const handler of this.handlers) {
          try {
            handler(event);
          } catch (err) {
            console.error("[RelayManager] Handler error:", err instanceof Error ? err.message : err);
          }
        }
      } catch {
        // Non-JSON message on channel, ignore
      }
    };

    this.isInitialized = true;
    console.log("[RelayManager] Relay SDK initialized on channel:", this.broadcastChannel);
  }

  /**
   * Register a handler for live game events.
   * Multiple handlers can be registered (e.g. Discord + Telegram presenters).
   */
  onMessage(handler: LiveGameMessageHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx >= 0) this.handlers.splice(idx, 1);
    };
  }

  /**
   * Publish a live game event to all subscribers on the channel.
   */
  async broadcastEvent(event: LiveGameEvent): Promise<void> {
    if (!this.relay) await this.initialize();

    await this.relay!.system().sendMessage({
      to: '#' + this.broadcastChannel,
      text: JSON.stringify(event),
    });
  }

  async shutdown(): Promise<void> {
    if (this.relay) {
      await this.relay.shutdown();
      this.relay = null;
      this.isInitialized = false;
      this.handlers.length = 0;
      console.log("[RelayManager] Relay SDK shut down.");
    }
  }
}

export const relayManager = new RelayManager();
