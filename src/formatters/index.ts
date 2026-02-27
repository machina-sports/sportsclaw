/**
 * sportsclaw — Formatter Public API
 *
 * Parse-once, render-per-target architecture.
 * Consumers call formatResponse() with a channel; internally the markdown
 * is parsed once into structured blocks, then rendered by the target renderer.
 */

import { parseBlocks } from "./parser.js";
import { renderDiscord } from "./discord.js";
import { renderTelegram } from "./telegram.js";
import { renderCli } from "./cli.js";

// Re-export types that consumers need
export type { DiscordEmbed } from "./discord.js";
export type { ParsedBlock, ParsedResponse } from "./parser.js";
export { isGameRelatedResponse } from "./parser.js";

export interface FormattedMessage {
  text: string;
  discord?: import("./discord.js").DiscordEmbed;
  telegram?: string;
}

export type Channel = "discord" | "telegram" | "cli";

export function formatResponse(
  response: string,
  channel: Channel = "cli"
): FormattedMessage {
  const parsed = parseBlocks(response);

  const formatted: FormattedMessage = {
    text: response,
  };

  if (channel === "discord") {
    formatted.discord = renderDiscord(parsed);
  } else if (channel === "telegram") {
    formatted.telegram = renderTelegram(parsed);
  } else if (channel === "cli") {
    formatted.text = renderCli(parsed);
  }

  return formatted;
}
