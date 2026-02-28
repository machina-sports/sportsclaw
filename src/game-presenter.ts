/**
 * sportsclaw — Game Presenter (Sprint 2 Live Games)
 *
 * Subscribes to IPTCSportEventEnvelope messages on the relay pub/sub channel
 * and renders live-updating messages to Discord (webhook PATCH) and Telegram
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
import {
  iptcGameId,
  iptcSportCode,
  iptcHome,
  iptcAway,
  iptcStatus,
} from "./relay.js";
import type {
  LiveGameEnvelope,
  LiveGameEvent,
  LegacyGameStatus,
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

const STATUS_INDICATOR: Record<LegacyGameStatus, string> = {
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
    this.unsubscribeRelay = relayManager.on("live-games", (envelope) =>
      this.handleEvent(envelope)
    );
    this.initialized = true;
    console.log(
      "[GamePresenter] Initialized and listening for IPTC sport events"
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

  private async handleEvent(envelope: LiveGameEnvelope): Promise<void> {
    const gameId = iptcGameId(envelope.data);
    const targets = this.subscriptions.get(gameId);
    if (!targets) return; // Not subscribed to this game

    const tracked = this.trackedMessages.get(gameId) ?? {};

    // Run Discord and Telegram updates in parallel
    const [discordId, telegramId] = await Promise.all([
      targets.discord
        ? this.updateDiscord(targets.discord, envelope, tracked.discordMessageId)
        : Promise.resolve(tracked.discordMessageId),
      targets.telegram
        ? this.updateTelegram(
            targets.telegram,
            envelope,
            tracked.telegramMessageId
          )
        : Promise.resolve(tracked.telegramMessageId),
    ]);

    tracked.discordMessageId = discordId;
    tracked.telegramMessageId = telegramId;
    this.trackedMessages.set(gameId, tracked);

    // Clean up completed games after a grace period
    const status = iptcStatus(envelope.data);
    if (status === "final") {
      setTimeout(() => {
        this.subscriptions.delete(gameId);
        this.trackedMessages.delete(gameId);
      }, 120_000);
    }
  }

  // -------------------------------------------------------------------------
  // Discord webhook — POST (create) / PATCH (edit)
  // -------------------------------------------------------------------------

  private async updateDiscord(
    target: DiscordTarget,
    envelope: LiveGameEnvelope,
    existingMessageId?: string
  ): Promise<string | undefined> {
    const embed = buildDiscordEmbed(envelope);
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
    envelope: LiveGameEnvelope,
    existingMessageId?: number
  ): Promise<number | undefined> {
    const html = buildTelegramHTML(envelope);
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
// Discord embed builder — reads from IPTC sport event
// ---------------------------------------------------------------------------

function buildDiscordEmbed(
  envelope: LiveGameEnvelope
): Record<string, unknown> {
  const { data, delta } = envelope;
  const sportCode = iptcSportCode(data);
  const status = iptcStatus(data);
  const home = iptcHome(data);
  const away = iptcAway(data);
  const gameId = iptcGameId(data);

  const emoji = SPORT_EMOJI[sportCode] ?? "\u{1F3C6}";
  const statusText = STATUS_INDICATOR[status] ?? status;
  const color = EMBED_COLORS[status] ?? 0x5865f2;

  const title = `${emoji} ${sportCode.toUpperCase()} ${statusText}`;

  // Main scoreline
  const scoreline =
    `**${away["sport:code"]}** ${away["spstat:score"] ?? 0}` +
    `  \u2014  ` +
    `${home["spstat:score"] ?? 0} **${home["sport:code"]}**`;

  // Score delta annotation (e.g. "+3 LAL")
  let deltaNote = "";
  if (delta?.homeScoreDelta && delta.homeScoreDelta > 0) {
    deltaNote += ` (+${delta.homeScoreDelta} ${home["sport:code"]})`;
  }
  if (delta?.awayScoreDelta && delta.awayScoreDelta > 0) {
    deltaNote += ` (+${delta.awayScoreDelta} ${away["sport:code"]})`;
  }

  const description =
    scoreline +
    (deltaNote ? `\n${deltaNote.trim()}` : "") +
    `\n\n${data["sport:statusDetail"]}`;

  const fields: Array<{ name: string; value: string; inline: boolean }> = [];

  // Period-by-period scores
  if (home["spstat:periodScore"]?.length) {
    fields.push({
      name: home["sport:code"],
      value: home["spstat:periodScore"].join(" | "),
      inline: true,
    });
  }
  if (away["spstat:periodScore"]?.length) {
    fields.push({
      name: away["sport:code"],
      value: away["spstat:periodScore"].join(" | "),
      inline: true,
    });
  }

  // Venue
  if (data["sport:venue"]) {
    fields.push({
      name: "\u{1F3DF}\uFE0F Venue",
      value: data["sport:venue"]["sport:name"],
      inline: false,
    });
  }

  // machina: signals (if present)
  if (data["machina:winProbability"]) {
    const wp = data["machina:winProbability"];
    fields.push({
      name: "\u{1F52E} Win Probability",
      value:
        `${home["sport:code"]}: ${(wp.home * 100).toFixed(1)}%` +
        ` — ${away["sport:code"]}: ${(wp.away * 100).toFixed(1)}%` +
        (wp.draw != null ? ` — Draw: ${(wp.draw * 100).toFixed(1)}%` : ""),
      inline: false,
    });
  }

  const embed: Record<string, unknown> = {
    title,
    description,
    color,
    footer: {
      text: `Game ${gameId} \u00B7 IPTC Sport Schema \u00B7 Last updated`,
    },
    timestamp: data["sport:lastUpdated"],
  };

  // Set team logo as thumbnail (prefer home team)
  if (home["sport:logo"]) {
    embed.thumbnail = { url: home["sport:logo"] };
  } else if (away["sport:logo"]) {
    embed.thumbnail = { url: away["sport:logo"] };
  }

  if (fields.length > 0) {
    embed.fields = fields;
  }

  return embed;
}

// ---------------------------------------------------------------------------
// Telegram HTML builder — reads from IPTC sport event
// ---------------------------------------------------------------------------

function buildTelegramHTML(envelope: LiveGameEnvelope): string {
  const { data, delta } = envelope;
  const sportCode = iptcSportCode(data);
  const status = iptcStatus(data);
  const home = iptcHome(data);
  const away = iptcAway(data);

  const emoji = SPORT_EMOJI[sportCode] ?? "\u{1F3C6}";
  const statusText = STATUS_INDICATOR[status] ?? status;

  const lines: string[] = [];

  // Header
  lines.push(`${emoji} <b>${sportCode.toUpperCase()} ${statusText}</b>`);
  lines.push("");

  // Scoreline
  lines.push(
    `<b>${esc(away["sport:name"])}</b> ${away["spstat:score"] ?? 0}` +
      `  \u2014  ` +
      `${home["spstat:score"] ?? 0} <b>${esc(home["sport:name"])}</b>`
  );

  // Delta annotation
  if (delta?.homeScoreDelta && delta.homeScoreDelta > 0) {
    lines.push(`  \u26A1 +${delta.homeScoreDelta} ${esc(home["sport:code"])}`);
  }
  if (delta?.awayScoreDelta && delta.awayScoreDelta > 0) {
    lines.push(`  \u26A1 +${delta.awayScoreDelta} ${esc(away["sport:code"])}`);
  }

  lines.push("");
  lines.push(`\u{1F551} ${esc(data["sport:statusDetail"])}`);

  // Period scores
  if (home["spstat:periodScore"]?.length) {
    lines.push("");
    lines.push(
      `${esc(home["sport:code"])}: ${home["spstat:periodScore"].join(" | ")}`
    );
    if (away["spstat:periodScore"]?.length) {
      lines.push(
        `${esc(away["sport:code"])}: ${away["spstat:periodScore"].join(" | ")}`
      );
    }
  }

  // Venue
  if (data["sport:venue"]) {
    lines.push("");
    lines.push(`\u{1F3DF}\uFE0F ${esc(data["sport:venue"]["sport:name"])}`);
  }

  // machina: signals
  if (data["machina:winProbability"]) {
    const wp = data["machina:winProbability"];
    lines.push("");
    lines.push(
      `\u{1F52E} <b>Win Prob:</b> ` +
        `${esc(home["sport:code"])} ${(wp.home * 100).toFixed(1)}%` +
        ` \u2014 ${esc(away["sport:code"])} ${(wp.away * 100).toFixed(1)}%` +
        (wp.draw != null ? ` \u2014 Draw ${(wp.draw * 100).toFixed(1)}%` : "")
    );
  }

  // Timestamp
  const updated = new Date(data["sport:lastUpdated"]);
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
