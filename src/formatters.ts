/**
 * sportsclaw — Rich Message Formatters (Phase 5)
 *
 * Channel-specific formatters for Discord, Telegram, and CLI.
 * Detects tables, headers, and scores to format appropriately.
 */

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
  }

  return formatted;
}
