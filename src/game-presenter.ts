/**
 * sportsclaw — Game Presenter (Sprint 2 Live Games)
 *
 * Subscribes to LiveGameEvent messages on the relay pub/sub channel and
 * renders live-updating messages to Discord (webhook PATCH) and Telegram
 * (editMessageText). Each game gets a single message per channel that is
 * edited in-place as the score changes.
 *
 * Discord flow:
 *   1. First event → POST webhook (creates message, stores message ID)
 *   2. Subsequent events → PATCH webhook/messages/:id (edits in-place)
 *
 * Telegram flow:
 *   1. First event → sendMessage (stores message_id)
 *   2. Subsequent events → editMessageText (edits in-place)
 */

import { relayManager } from "./relay.js";
import type {
  LiveGameEvent,
  LiveGameState,
  GameStatus,
} from "./relay.js";

// ---------------------------------------------------------------------------
// API base URLs
// ---------------------------------------------------------------------------

const DISCORD_API = "https://discord.com/api/v10";
const TELEGRAM_API = "https://api.telegram.org";

// ---------------------------------------------------------------------------
// Subscription target types
// ---------------------------------------------------------------------------

export interface DiscordTarget {
  webhookId: string;
  webhookToken: string;
}

export interface TelegramTarget {
  botToken: string;
  chatId: string | number;
}

export interface SubscriptionTarget {
  discord?: DiscordTarget;
  telegram?: TelegramTarget;
}

/** Tracks per-game message IDs so we can PATCH/edit in-place */
interface TrackedMessage {
  discordMessageId?: string;
  telegramMessageId?: number;
}

// ---------------------------------------------------------------------------
// Sport display metadata
// ---------------------------------------------------------------------------

const SPORT_EMOJI: Record<string, string> = {
  nfl: "\u{1F3C8}",
  nba: "\u{1F3C0}",
  mlb: "\u26BE",
  nhl: "\u{1F3D2}",
  wnba: "\u{1F3C0}",
  cfb: "\u{1F3C8}",
  cbb: "\u{1F3C0}",
  soccer: "\u26BD",
  football: "\u26BD",
  tennis: "\u{1F3BE}",
  golf: "\u26F3",
  f1: "\u{1F3CE}\uFE0F",
};

const STATUS_INDICATOR: Record<GameStatus, string> = {
  scheduled: "\u{1F550}",
  in_progress: "\u{1F534} LIVE",
  halftime: "\u23F8\uFE0F HT",
  final: "\u2705 Final",
  delayed: "\u26A0\uFE0F Delayed",
  postponed: "\u{1F6AB} PPD",
};

const EMBED_COLORS: Record<string, number> = {
  scheduled: 0x95a5a6,  // gray
  in_progress: 0xe74c3c, // red
  halftime: 0xf39c12,   // orange
  final: 0x2ecc71,      // green
  delayed: 0xe67e22,    // dark orange
  postponed: 0x7f8c8d,  // dark gray
};

// ---------------------------------------------------------------------------
// GamePresenter
// ---------------------------------------------------------------------------

export class GamePresenter {
  private subscriptions = new Map<string, SubscriptionTarget>();
  private trackedMessages = new Map<string, TrackedMessage>();
  private unsubscribeRelay: (() => void) | null = null;
  private initialized = false;

  /**
   * Initialize the presenter: connect to the relay and start listening.
   * Must be called before subscribing to games.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await relayManager.initialize();
    this.unsubscribeRelay = relayManager.onMessage((event) =>
      this.handleEvent(event)
    );
    this.initialized = true;
    console.log(
      "[GamePresenter] Initialized and listening for live game events"
    );
  }

  /**
   * Subscribe to live updates for a game and deliver to the given targets.
   * The presenter will create a message on first update, then edit it in-place.
   */
  subscribe(gameId: string, targets: SubscriptionTarget): void {
    this.subscriptions.set(gameId, targets);
    console.log(
      `[GamePresenter] Subscribed to game ${gameId}` +
        (targets.discord ? " [Discord]" : "") +
        (targets.telegram ? " [Telegram]" : "")
    );
  }

  /** Unsubscribe from a game and stop tracking its message. */
  unsubscribe(gameId: string): void {
    this.subscriptions.delete(gameId);
    this.trackedMessages.delete(gameId);
    console.log(`[GamePresenter] Unsubscribed from game ${gameId}`);
  }

  /** Get all actively subscribed game IDs. */
  getSubscriptions(): string[] {
    return Array.from(this.subscriptions.keys());
  }

  /** Shut down the presenter and unsubscribe from the relay. */
  shutdown(): void {
    if (this.unsubscribeRelay) {
      this.unsubscribeRelay();
      this.unsubscribeRelay = null;
    }
    this.subscriptions.clear();
    this.trackedMessages.clear();
    this.initialized = false;
    console.log("[GamePresenter] Shut down");
  }

  // -------------------------------------------------------------------------
  // Event handler
  // -------------------------------------------------------------------------

  private async handleEvent(event: LiveGameEvent): Promise<void> {
    const { data } = event;
    const targets = this.subscriptions.get(data.gameId);
    if (!targets) return; // Not subscribed to this game

    const tracked = this.trackedMessages.get(data.gameId) ?? {};

    // Run Discord and Telegram updates in parallel
    const [discordId, telegramId] = await Promise.all([
      targets.discord
        ? this.updateDiscord(targets.discord, event, tracked.discordMessageId)
        : Promise.resolve(tracked.discordMessageId),
      targets.telegram
        ? this.updateTelegram(
            targets.telegram,
            event,
            tracked.telegramMessageId
          )
        : Promise.resolve(tracked.telegramMessageId),
    ]);

    tracked.discordMessageId = discordId;
    tracked.telegramMessageId = telegramId;
    this.trackedMessages.set(data.gameId, tracked);

    // Clean up completed games after a grace period
    if (data.status === "final") {
      setTimeout(() => {
        this.subscriptions.delete(data.gameId);
        this.trackedMessages.delete(data.gameId);
      }, 120_000);
    }
  }

  // -------------------------------------------------------------------------
  // Discord webhook — POST (create) / PATCH (edit)
  // -------------------------------------------------------------------------

  private async updateDiscord(
    target: DiscordTarget,
    event: LiveGameEvent,
    existingMessageId?: string
  ): Promise<string | undefined> {
    const embed = buildDiscordEmbed(event);
    const payload = JSON.stringify({ embeds: [embed] });
    const headers = { "Content-Type": "application/json" };

    try {
      if (existingMessageId) {
        // PATCH the existing message in-place
        const res = await fetch(
          `${DISCORD_API}/webhooks/${target.webhookId}/${target.webhookToken}/messages/${existingMessageId}`,
          { method: "PATCH", headers, body: payload }
        );
        if (res.ok) return existingMessageId;
        // PATCH failed (message deleted?) — fall through to create a new one
        console.error(
          `[GamePresenter] Discord PATCH failed (${res.status}), creating new message`
        );
      }

      // POST a new message via webhook (?wait=true returns the created message)
      const res = await fetch(
        `${DISCORD_API}/webhooks/${target.webhookId}/${target.webhookToken}?wait=true`,
        { method: "POST", headers, body: payload }
      );

      if (res.ok) {
        const data = (await res.json()) as { id: string };
        return data.id;
      }

      console.error(
        `[GamePresenter] Discord POST failed: ${res.status} ${res.statusText}`
      );
    } catch (err) {
      console.error(
        "[GamePresenter] Discord error:",
        err instanceof Error ? err.message : err
      );
    }
    return existingMessageId;
  }

  // -------------------------------------------------------------------------
  // Telegram — sendMessage (create) / editMessageText (edit)
  // -------------------------------------------------------------------------

  private async updateTelegram(
    target: TelegramTarget,
    event: LiveGameEvent,
    existingMessageId?: number
  ): Promise<number | undefined> {
    const html = buildTelegramHTML(event);
    const headers = { "Content-Type": "application/json" };

    try {
      if (existingMessageId) {
        const res = await fetch(
          `${TELEGRAM_API}/bot${target.botToken}/editMessageText`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              chat_id: target.chatId,
              message_id: existingMessageId,
              text: html,
              parse_mode: "HTML",
            }),
          }
        );
        if (res.ok) return existingMessageId;

        const errBody = (await res.json().catch(() => ({}))) as {
          description?: string;
        };
        console.error(
          `[GamePresenter] Telegram editMessageText failed: ${errBody.description ?? res.status}`
        );
      }

      // Send new message
      const res = await fetch(
        `${TELEGRAM_API}/bot${target.botToken}/sendMessage`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            chat_id: target.chatId,
            text: html,
            parse_mode: "HTML",
          }),
        }
      );

      if (res.ok) {
        const data = (await res.json()) as {
          result?: { message_id: number };
        };
        return data.result?.message_id;
      }

      console.error(
        `[GamePresenter] Telegram sendMessage failed: ${res.status}`
      );
    } catch (err) {
      console.error(
        "[GamePresenter] Telegram error:",
        err instanceof Error ? err.message : err
      );
    }
    return existingMessageId;
  }
}

// ---------------------------------------------------------------------------
// Discord embed builder
// ---------------------------------------------------------------------------

function buildDiscordEmbed(
  event: LiveGameEvent
): Record<string, unknown> {
  const { data, delta } = event;
  const emoji = SPORT_EMOJI[data.sport] ?? "\u{1F3C6}";
  const statusText = STATUS_INDICATOR[data.status] ?? data.status;
  const color = EMBED_COLORS[data.status] ?? 0x5865f2;

  const title = `${emoji} ${data.sport.toUpperCase()} ${statusText}`;

  // Main scoreline
  const scoreline =
    `**${data.away.abbreviation}** ${data.away.score}` +
    `  \u2014  ` +
    `${data.home.score} **${data.home.abbreviation}**`;

  // Score delta annotation (e.g. "+3 LAL")
  let deltaNote = "";
  if (delta?.homeScoreDelta && delta.homeScoreDelta > 0) {
    deltaNote += ` (+${delta.homeScoreDelta} ${data.home.abbreviation})`;
  }
  if (delta?.awayScoreDelta && delta.awayScoreDelta > 0) {
    deltaNote += ` (+${delta.awayScoreDelta} ${data.away.abbreviation})`;
  }

  const description =
    scoreline +
    (deltaNote ? `\n${deltaNote.trim()}` : "") +
    `\n\n${data.statusDetail}`;

  const fields: Array<{ name: string; value: string; inline: boolean }> = [];

  // Period-by-period scores
  if (data.home.periodScores?.length) {
    fields.push({
      name: data.home.abbreviation,
      value: data.home.periodScores.join(" | "),
      inline: true,
    });
  }
  if (data.away.periodScores?.length) {
    fields.push({
      name: data.away.abbreviation,
      value: data.away.periodScores.join(" | "),
      inline: true,
    });
  }

  // Venue
  if (data.venue) {
    fields.push({
      name: "\u{1F3DF}\uFE0F Venue",
      value: data.venue,
      inline: false,
    });
  }

  const embed: Record<string, unknown> = {
    title,
    description,
    color,
    footer: {
      text: `Game ${data.gameId} \u00B7 Last updated`,
    },
    timestamp: data.lastUpdated,
  };

  // Set team logo as thumbnail (prefer home team)
  if (data.home.logo) {
    embed.thumbnail = { url: data.home.logo };
  } else if (data.away.logo) {
    embed.thumbnail = { url: data.away.logo };
  }

  if (fields.length > 0) {
    embed.fields = fields;
  }

  return embed;
}

// ---------------------------------------------------------------------------
// Telegram HTML builder
// ---------------------------------------------------------------------------

function buildTelegramHTML(event: LiveGameEvent): string {
  const { data, delta } = event;
  const emoji = SPORT_EMOJI[data.sport] ?? "\u{1F3C6}";
  const statusText = STATUS_INDICATOR[data.status] ?? data.status;

  const lines: string[] = [];

  // Header
  lines.push(`${emoji} <b>${data.sport.toUpperCase()} ${statusText}</b>`);
  lines.push("");

  // Scoreline
  lines.push(
    `<b>${esc(data.away.name)}</b> ${data.away.score}` +
      `  \u2014  ` +
      `${data.home.score} <b>${esc(data.home.name)}</b>`
  );

  // Delta annotation
  if (delta?.homeScoreDelta && delta.homeScoreDelta > 0) {
    lines.push(`  \u26A1 +${delta.homeScoreDelta} ${esc(data.home.abbreviation)}`);
  }
  if (delta?.awayScoreDelta && delta.awayScoreDelta > 0) {
    lines.push(`  \u26A1 +${delta.awayScoreDelta} ${esc(data.away.abbreviation)}`);
  }

  lines.push("");
  lines.push(`\u{1F551} ${esc(data.statusDetail)}`);

  // Period scores
  if (data.home.periodScores?.length) {
    lines.push("");
    lines.push(
      `${esc(data.home.abbreviation)}: ${data.home.periodScores.join(" | ")}`
    );
    if (data.away.periodScores?.length) {
      lines.push(
        `${esc(data.away.abbreviation)}: ${data.away.periodScores.join(" | ")}`
      );
    }
  }

  // Venue
  if (data.venue) {
    lines.push("");
    lines.push(`\u{1F3DF}\uFE0F ${esc(data.venue)}`);
  }

  // Timestamp
  const updated = new Date(data.lastUpdated);
  const timeStr = updated.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  lines.push(`\u{1F4E1} Updated: ${timeStr}`);

  return lines.join("\n");
}

/** Escape HTML special characters for Telegram parse_mode=HTML */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const gamePresenter = new GamePresenter();
