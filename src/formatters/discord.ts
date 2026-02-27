/**
 * sportsclaw — Discord Renderer
 *
 * Converts a ParsedResponse into a DiscordEmbed object.
 * Tables → code blocks, headers → embed fields, source → footer.
 */

import type { ParsedResponse } from "./parser.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscordEmbed {
  title?: string;
  description?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  color?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EMBED_COLORS = {
  info: 0x5865f2, // Blurple
  score: 0x57f287, // Green
  error: 0xed4245, // Red
};

// ---------------------------------------------------------------------------
// renderDiscord
// ---------------------------------------------------------------------------

// Discord embed limits
const MAX_FIELD_NAME = 256;
const MAX_FIELD_VALUE = 1024;
const MAX_DESCRIPTION = 4096;

export function renderDiscord(parsed: ParsedResponse): DiscordEmbed {
  const color = parsed.meta.hasScores ? EMBED_COLORS.score : EMBED_COLORS.info;
  const footer = parsed.source ? { text: parsed.source } : undefined;

  // Check if we have any header blocks → use fields layout
  const hasHeaders = parsed.blocks.some((b) => b.type === "header");

  if (hasHeaders) {
    const fields: Array<{ name: string; value: string }> = [];
    let currentHeader: string | null = null;
    let currentContent: string[] = [];

    function flushField(): void {
      if (currentHeader && currentContent.length > 0) {
        const value = currentContent.join("\n").trim() || "-";
        fields.push({
          name: truncate(currentHeader, MAX_FIELD_NAME),
          value: truncate(value, MAX_FIELD_VALUE),
        });
      }
      currentContent = [];
    }

    for (const block of parsed.blocks) {
      if (block.type === "header") {
        flushField();
        currentHeader = block.text;
      } else if (currentHeader) {
        currentContent.push(renderBlockForDiscord(block));
      }
    }
    flushField();

    return {
      title: "Sports Data",
      fields: fields.slice(0, 25), // Discord limit: 25 fields
      footer,
      color,
    };
  }

  // No headers — render all blocks into description
  const description =
    parsed.blocks.map(renderBlockForDiscord).join("\n").trim().slice(0, MAX_DESCRIPTION) ||
    undefined;

  return { description, footer, color };
}

// ---------------------------------------------------------------------------
// Internal: render a single block for Discord context
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function renderBlockForDiscord(block: ParsedResponse["blocks"][number]): string {
  switch (block.type) {
    case "header":
      return `**${block.text}**`;

    case "table": {
      const lines = block.rows.map((cells) => cells.join("  |  "));
      return "```\n" + lines.join("\n") + "\n```";
    }

    case "code":
      return "```" + block.language + "\n" + block.lines.join("\n") + "\n```";

    case "text":
      return block.lines.join("\n");
  }
}
