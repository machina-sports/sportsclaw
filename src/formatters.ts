/**
 * sportsclaw — Rich Message Formatters (Phase 5)
 *
 * Channel-specific formatters for Discord, Telegram, and CLI.
 * Detects tables, headers, and scores to format appropriately.
 */

import { c, box } from "./colors.js";

export interface DiscordEmbed {
  title?: string;
  description?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  color?: number;
}

export interface FormattedMessage {
  text: string;
  discord?: DiscordEmbed;
  telegram?: string;
}

type Channel = "discord" | "telegram" | "cli";

// Color constants for Discord embeds
const EMBED_COLORS = {
  info: 0x5865f2, // Blurple
  score: 0x57f287, // Green
  error: 0xed4245, // Red
};

/**
 * Detect if response contains table-like data.
 */
function hasTableData(text: string): boolean {
  const lines = text.split("\n");
  const pipeCount = lines.filter((line) => line.includes("|")).length;
  return pipeCount >= 2;
}

/**
 * Detect if response has markdown headers (### format).
 */
function hasHeaders(text: string): boolean {
  return /^###?\s+/m.test(text);
}

/**
 * Detect if response contains score-like patterns (Team 1-0 Team).
 */
function hasScores(text: string): boolean {
  return /\d+\s*-\s*\d+/.test(text);
}

/**
 * Extract source attribution from the bottom of the response.
 */
function extractSource(text: string): string | null {
  const lines = text.split("\n");
  const lastLine = lines[lines.length - 1]?.trim() || "";
  if (lastLine.toLowerCase().startsWith("source:")) {
    return lastLine.replace(/^source:\s*/i, "");
  }
  return null;
}

/**
 * Remove source line from text if present.
 */
function removeSourceLine(text: string): string {
  const source = extractSource(text);
  if (!source) return text;
  const lines = text.split("\n");
  return lines.slice(0, -1).join("\n");
}

/**
 * Parse markdown headers and content into embed fields.
 */
function parseHeaderFields(
  text: string
): Array<{ name: string; value: string }> {
  const fields: Array<{ name: string; value: string }> = [];
  const lines = text.split("\n");

  let currentHeader: string | null = null;
  let currentContent: string[] = [];

  for (const line of lines) {
    const headerMatch = line.match(/^###?\s+(.+)$/);
    if (headerMatch) {
      // Save previous section
      if (currentHeader && currentContent.length > 0) {
        fields.push({
          name: currentHeader,
          value: currentContent.join("\n").trim() || "-",
        });
      }
      // Start new section
      currentHeader = headerMatch[1];
      currentContent = [];
    } else if (currentHeader) {
      currentContent.push(line);
    }
  }

  // Save last section
  if (currentHeader && currentContent.length > 0) {
    fields.push({
      name: currentHeader,
      value: currentContent.join("\n").trim() || "-",
    });
  }

  return fields;
}

/**
 * Format response as a Discord embed.
 */
function formatDiscord(response: string): DiscordEmbed {
  const source = extractSource(response);
  const content = removeSourceLine(response);
  const hasScore = hasScores(content);

  // If response has headers, parse into fields
  if (hasHeaders(content)) {
    const fields = parseHeaderFields(content);
    return {
      title: "Sports Data",
      fields: fields.slice(0, 25), // Discord limit: 25 fields
      footer: source ? { text: source } : undefined,
      color: hasScore ? EMBED_COLORS.score : EMBED_COLORS.info,
    };
  }

  // Simple response — use description
  return {
    description: content.slice(0, 4096), // Discord limit: 4096 chars
    footer: source ? { text: source } : undefined,
    color: hasScore ? EMBED_COLORS.score : EMBED_COLORS.info,
  };
}

/**
 * Format response as Telegram MarkdownV2.
 * Escapes special characters and highlights scores/team names.
 */
function formatTelegram(response: string): string {
  const source = extractSource(response);
  let content = removeSourceLine(response);

  // Escape special MarkdownV2 characters
  const escape = (text: string): string =>
    text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");

  // Highlight scores (Team 1-0 Team → **Team** `1-0` **Team**)
  content = content.replace(
    /(\w+(?:\s+\w+)*)\s+(\d+\s*-\s*\d+)\s+(\w+(?:\s+\w+)*)/g,
    (_, team1, score, team2) =>
      `**${escape(team1)}** \`${escape(score)}\` **${escape(team2)}**`
  );

  // Convert ### headers to bold
  content = content.replace(/^###?\s+(.+)$/gm, (_, header) => `**${escape(header)}**`);

  // Wrap code blocks
  content = content.replace(/```(\w+)?\n([\s\S]+?)```/g, (_, lang, code) =>
    `\`\`\`${lang || ""}\n${code}\`\`\``
  );

  // Add source footer
  if (source) {
    content += `\n\n_${escape(source)}_`;
  }

  return content;
}

/**
 * Convert markdown table to Unicode box-drawing table.
 */
function convertTableToUnicode(lines: string[]): string[] {
  // Parse all table rows and calculate column widths
  const rows: string[][] = [];
  let headerIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip separator lines (e.g., "|---|---|")
    if (/^\|[\s\-:|]+\|$/.test(line)) {
      headerIndex = rows.length - 1;
      continue;
    }

    if (!line.includes("|")) continue;

    // Parse cells (exclude empty first/last from split)
    const cells = line.split("|").slice(1, -1).map(c => c.trim());
    rows.push(cells);
  }

  if (rows.length === 0) return lines;

  // Calculate max width for each column
  const colCount = Math.max(...rows.map(r => r.length));
  const widths: number[] = [];
  for (let col = 0; col < colCount; col++) {
    widths[col] = Math.max(...rows.map(r => (r[col] || "").length));
  }

  // Build Unicode table
  const result: string[] = [];

  // Top border
  const top = box.topLeft + widths.map(w => box.horizontal.repeat(w + 2)).join(box.topTee) + box.topRight;
  result.push(top);

  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i];
    const paddedCells = cells.map((cell, col) => cell.padEnd(widths[col] || 0));
    const row = box.vertical + paddedCells.map(cell => ` ${cell} `).join(box.vertical) + box.vertical;
    result.push(row);

    // Add header separator after first row if detected
    if (i === headerIndex) {
      const sep = box.leftTee + widths.map(w => box.horizontal.repeat(w + 2)).join(box.cross) + box.rightTee;
      result.push(sep);
    }
  }

  // Bottom border
  const bottom = box.bottomLeft + widths.map(w => box.horizontal.repeat(w + 2)).join(box.bottomTee) + box.bottomRight;
  result.push(bottom);

  return result;
}

/**
 * Clean markdown formatting for CLI display.
 * - Converts **bold** to ANSI bold or strips it
 * - Converts * bullets to clean bullets
 */
function cleanMarkdown(line: string): string {
  let cleaned = line;
  
  // Convert **text** to bold ANSI (or strip if nested/complex)
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, (_, text) => c.bold(text));
  
  // Convert leading * bullets to clean bullets
  // Match: "* text" or "  * text" (with indentation)
  cleaned = cleaned.replace(/^(\s*)\*\s+/, "$1• ");
  
  // Convert leading - bullets to clean bullets (already clean, but normalize)
  cleaned = cleaned.replace(/^(\s*)-\s+/, "$1• ");
  
  return cleaned;
}

/**
 * Format response for CLI with Unicode tables and colors.
 */
function formatCli(response: string): string {
  const source = extractSource(response);
  let content = removeSourceLine(response);

  const lines = content.split("\n");
  const formatted: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Format headers with Unicode separator (match ##, ###, ####)
    if (/^#{2,4}\s+/.test(line)) {
      const headerText = line.replace(/^#{2,4}\s+/, "").replace(/\*\*/g, ""); // Strip ** from headers
      formatted.push(`\n${c.bold(headerText)}`);
      formatted.push(c.dim(box.horizontal.repeat(Math.min(headerText.length, 60))));
      continue;
    }

    // Detect table blocks and convert them
    if (line.includes("|") && line.trim().startsWith("|")) {
      const tableLines = [line];
      let j = i + 1;

      // Collect all consecutive table lines
      while (j < lines.length && (lines[j].includes("|") || /^[\s\-:|]+$/.test(lines[j]))) {
        tableLines.push(lines[j]);
        j++;
      }

      const unicodeTable = convertTableToUnicode(tableLines);
      formatted.push(...unicodeTable);
      i = j - 1; // Skip processed lines
      continue;
    }

    // Clean markdown formatting (bullets, bold)
    line = cleanMarkdown(line);

    // Format scores with colors (e.g., "Arsenal 2-1 Chelsea")
    if (/\w+.*\d+\s*-\s*\d+.*\w+/.test(line)) {
      const scoreLine = line.replace(
        /(\w+(?:\s+\w+)*)\s+(\d+)\s*-\s*(\d+)\s+(\w+(?:\s+\w+)*)/g,
        (_, team1, score1, score2, team2) => {
          const s1 = Number.parseInt(score1);
          const s2 = Number.parseInt(score2);
          if (s1 > s2) {
            return `${c.green(team1)} ${score1}-${score2} ${team2}`;
          } else if (s2 > s1) {
            return `${team1} ${score1}-${score2} ${c.green(team2)}`;
          }
          return `${team1} ${score1}-${score2} ${team2}`;
        }
      );
      formatted.push(scoreLine);
      continue;
    }

    // Highlight live games
    if (/🔴|LIVE/i.test(line)) {
      formatted.push(c.yellow(line));
      continue;
    }

    formatted.push(line);
  }

  // Add source footer
  if (source) {
    formatted.push("");
    formatted.push(c.dim(`Source: ${source}`));
  }

  return formatted.join("\n");
}

/**
 * Format response for the specified channel.
 */
export function formatResponse(
  response: string,
  channel: Channel = "cli"
): FormattedMessage {
  const formatted: FormattedMessage = {
    text: response, // Always include plain text fallback
  };

  if (channel === "discord") {
    formatted.discord = formatDiscord(response);
  } else if (channel === "telegram") {
    formatted.telegram = formatTelegram(response);
  } else if (channel === "cli") {
    formatted.text = formatCli(response);
  }

  return formatted;
}
