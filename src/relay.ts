/**
 * sportsclaw — Relay Manager (Generic Pub/Sub Primitive)
 *
 * Type-safe, multi-channel pub/sub layer on top of @agent-relay/sdk.
 * Channels and their payload types are defined via a ChannelMap type
 * parameter so producers and consumers stay in sync at compile time.
 *
 * Segregated channels:
 *
 *   Channel        Cadence   Payload Type
 *   ─────────────  ────────  ──────────────────────────────────
 *   live-games     fast      LiveGameEnvelope (enriched IPTC events)
 *   odds           fast      MarketOdds (real-time market pricing)
 *   predictions    medium    PredictionPayload (EventPrediction | PlayerPropTrend)
 *   intel          slow      CoverageInsight (editorial analysis)
 *
 * Usage:
 *   relayManager.publish("live-games", envelope);   // type-checked payload
 *   relayManager.publish("odds", odds);             // type-checked payload
 *   relayManager.on("predictions", handler);        // type-checked handler
 */

import { AgentRelay } from '@agent-relay/sdk';
import type { Message as RelayMessage } from '@agent-relay/sdk';

// ---------------------------------------------------------------------------
// IPTC Sport Schema — pure IPTC types (no proprietary extensions)
// ---------------------------------------------------------------------------

export type {
  IPTCSportEvent,
  IPTCSportEventEnvelope,
  IPTCEventType,
  IPTCEventStatus,
  IPTCCompetitor,
  IPTCSportDiscipline,
  IPTCVenue,
  IPTCContext,
  IPTCEntity,
  LegacyGameStatus,
} from "./schema/iptc.js";

export {
  IPTC_CONTEXT,
  toIPTCStatus,
  fromIPTCStatus,
  toIPTCDiscipline,
  iptcGameId,
  iptcSportCode,
  iptcHome,
  iptcAway,
  iptcStatus,
} from "./schema/iptc.js";

// ---------------------------------------------------------------------------
// Machina Alpha Schema — proprietary AI extensions + channel payloads
// ---------------------------------------------------------------------------

export type {
  MachinaContext,
  MachinaWinProbability,
  MachinaMarketEdge,
  MachinaAgentSignal,
  LiveGameEvent,
  LiveGameEnvelope,
  OddsLine,
  MarketOdds,
  EventPrediction,
  PlayerPropTrend,
  PredictionPayload,
  CoverageInsight,
} from "./schema/machina.js";

export {
  MACHINA_NS,
  MACHINA_CONTEXT,
} from "./schema/machina.js";

import type { LiveGameEnvelope } from "./schema/machina.js";
import type { MarketOdds } from "./schema/machina.js";
import type { PredictionPayload } from "./schema/machina.js";
import type { CoverageInsight } from "./schema/machina.js";

// ---------------------------------------------------------------------------
// Channel map — strict typing for segregated pub/sub channels
// ---------------------------------------------------------------------------

/**
 * Map channel names → payload types. Each channel is isolated with its own
 * cadence and payload contract. Producers and consumers must agree on types
 * at compile time.
 *
 *   live-games   — fast:   Score updates, status changes, light win probability
 *   odds         — fast:   Real-time market odds snapshots (Sportingbot structure)
 *   predictions  — medium: Model predictions, player prop trends
 *   intel        — slow:   Editorial coverage insights, deep analysis
 */
export type SportsClawChannels = {
  "live-games": LiveGameEnvelope;
  "odds": MarketOdds;
  "predictions": PredictionPayload;
  "intel": CoverageInsight;
};

/** All valid channel names */
export type SportsClawChannelName = keyof SportsClawChannels;

/** Handler for messages on a specific channel. */
export type ChannelHandler<T> = (payload: T) => void;

// ---------------------------------------------------------------------------
// RelayManager — generic, multi-channel pub/sub over AgentRelay
// ---------------------------------------------------------------------------

export class RelayManager<TMap extends Record<string, unknown> = SportsClawChannels> {
  private relay: AgentRelay | null = null;
  private handlers = new Map<string, Array<ChannelHandler<unknown>>>();
  private isInitialized = false;
  private channelNames: string[];

  constructor(channels?: Array<keyof TMap & string>) {
    this.channelNames = channels ? [...channels] : [];
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // Ensure "general" is always included
    const sdkChannels = [...new Set([...this.channelNames, "general"])];

    this.relay = new AgentRelay({ channels: sdkChannels });

    this.relay.onMessageReceived = (msg: RelayMessage) => {
      if (msg.eventId?.includes("presence")) return;
      if (!msg.text) return;

      // Resolve the channel name (strip leading '#' if present)
      const rawTo = msg.to ?? "";
      const channel = rawTo.startsWith("#") ? rawTo.slice(1) : rawTo;

      const channelHandlers = this.handlers.get(channel);
      if (!channelHandlers?.length) return;

      try {
        const payload = JSON.parse(msg.text) as unknown;

        for (const handler of channelHandlers) {
          try {
            handler(payload);
          } catch (err) {
            console.error(
              `[RelayManager] Handler error on "${channel}":`,
              err instanceof Error ? err.message : err
            );
          }
        }
      } catch {
        // Non-JSON message, ignore
      }
    };

    this.isInitialized = true;
    console.log(
      "[RelayManager] Relay SDK initialized on channels:",
      sdkChannels.join(", ")
    );
  }

  /**
   * Subscribe to typed messages on a channel.
   * Returns an unsubscribe function.
   */
  on<K extends keyof TMap & string>(
    channel: K,
    handler: ChannelHandler<TMap[K]>
  ): () => void {
    let arr = this.handlers.get(channel);
    if (!arr) {
      arr = [];
      this.handlers.set(channel, arr);
    }
    arr.push(handler as ChannelHandler<unknown>);

    return () => {
      const list = this.handlers.get(channel);
      if (!list) return;
      const idx = list.indexOf(handler as ChannelHandler<unknown>);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  /**
   * Publish a typed payload to a channel.
   * Lazily initializes the relay connection on first call.
   */
  async publish<K extends keyof TMap & string>(
    channel: K,
    payload: TMap[K]
  ): Promise<void> {
    if (!this.relay) await this.initialize();

    await this.relay!.system().sendMessage({
      to: "#" + channel,
      text: JSON.stringify(payload),
    });
  }

  async shutdown(): Promise<void> {
    if (this.relay) {
      await this.relay.shutdown();
      this.relay = null;
      this.isInitialized = false;
      this.handlers.clear();
      console.log("[RelayManager] Relay SDK shut down.");
    }
  }
}

// ---------------------------------------------------------------------------
// Default singleton — typed to all SportsClaw channels
// ---------------------------------------------------------------------------

export const relayManager = new RelayManager<SportsClawChannels>([
  "live-games",
  "odds",
  "predictions",
  "intel",
]);
