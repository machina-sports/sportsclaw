/**
 * sportsclaw — Discord Renderer
 *
 * Converts a ParsedResponse into a DiscordEmbed object.
 * Headers → embed fields, source → footer, tables → labelled multi-line cards.
 *
 * Tables get a Discord-native treatment: each data row becomes a card
 * (bold first cell as heading, remaining cells as `• **Header:** value`
 * bullets). Code-block-wrapped tables wrap awkwardly on mobile Discord
 * and read like CSV; the labelled-card format keeps the data without the
 * spreadsheet metaphor.
 */

import { parseBlocks, stripBold } from "./parser.js";
import type { ParsedResponse, ParsedBlock } from "./parser.js";

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
// formatTextForDiscord — render LLM response as Discord-friendly text
// ---------------------------------------------------------------------------

/**
 * Parses an LLM response and re-renders it for Discord:
 * - Tables → labelled multi-line cards (one card per data row)
 * - Everything else preserved as-is (bold, italic, code blocks, etc.)
 */
export function formatTextForDiscord(response: string): string {
  const parsed = parseBlocks(response);
  const rendered = parsed.blocks.map(renderBlockForDiscord).join("\n");

  if (parsed.source) {
    return rendered + "\n*Source: " + parsed.source + "*";
  }
  return rendered;
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

    case "table":
      return renderTableAsCards(block);

    case "code":
      return "```" + block.language + "\n" + block.lines.join("\n") + "\n```";

    case "text":
      return block.lines.join("\n");
  }
}

/**
 * Render a table as Discord markdown, one labelled card per data row.
 *
 * Layout per row:
 *   **{first-cell}**
 *   • **{header[1]}:** {cell[1]}
 *   • **{header[2]}:** {cell[2]}
 *   ...
 *
 * Mirrors the Telegram renderer's labelled-card format using Discord's
 * markdown bold (`**`) instead of HTML `<b>`. No HTML escaping — Discord
 * isn't HTML; the parser already strips `**` from cells via stripBold so
 * stray markdown inside values doesn't double-bold.
 */
function renderTableAsCards(block: ParsedBlock & { type: "table" }): string {
  const rows = block.rows.map((row) => row.map((c) => stripBold(c)));
  const headerIdx = block.headerIndex >= 0 ? block.headerIndex : 0;
  const headerRow = rows[headerIdx] ?? [];
  const dataRows = rows.filter((_, i) => i !== headerIdx);

  if (dataRows.length === 0) {
    return `**${headerRow.join(" · ")}**`;
  }

  const cards: string[] = [];
  for (const row of dataRows) {
    const lines: string[] = [];
    const heading = (row[0] ?? "").trim();
    if (heading) {
      lines.push(`**${heading}**`);
    }
    for (let c = 1; c < row.length; c++) {
      const val = (row[c] ?? "").trim();
      if (val.length === 0) continue;
      const label = (headerRow[c] ?? `Col ${c + 1}`).trim();
      if (label.length === 0) {
        lines.push(`• ${val}`);
      } else {
        lines.push(`• **${label}:** ${val}`);
      }
    }
    if (lines.length > 0) {
      cards.push(lines.join("\n"));
    }
  }
  return cards.join("\n\n");
}
