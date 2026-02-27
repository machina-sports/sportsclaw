/**
 * sportsclaw — Shared Markdown Parser
 *
 * Parses LLM markdown responses into structured blocks.
 * Each renderer (Discord, Telegram, CLI) consumes ParsedResponse
 * instead of re-parsing the same markdown independently.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ParsedBlock =
  | { type: "header"; text: string; level: number }
  | { type: "table"; rows: string[][]; headerIndex: number }
  | { type: "code"; language: string; lines: string[] }
  | { type: "text"; lines: string[] };

export interface ParsedResponse {
  blocks: ParsedBlock[];
  source: string | null;
  meta: { hasScores: boolean };
}

// ---------------------------------------------------------------------------
// parseBlocks — single-pass markdown → structured blocks
// ---------------------------------------------------------------------------

export function parseBlocks(markdown: string): ParsedResponse {
  const source = extractSource(markdown);
  const content = source ? removeSourceLine(markdown) : markdown;
  const hasScore = hasScores(content);

  const lines = content.split("\n");
  const blocks: ParsedBlock[] = [];
  let i = 0;

  // Accumulate consecutive text lines, then flush as a single block
  let textBuf: string[] = [];

  function flushText(): void {
    if (textBuf.length > 0) {
      blocks.push({ type: "text", lines: textBuf });
      textBuf = [];
    }
  }

  while (i < lines.length) {
    const line = lines[i];

    // Headers: ## or ###
    const headerMatch = line.match(/^(#{2,4})\s+(.+)$/);
    if (headerMatch) {
      flushText();
      const level = headerMatch[1].length;
      const text = headerMatch[2].replace(/\*\*/g, ""); // strip bold markers
      blocks.push({ type: "header", text, level });
      i++;
      continue;
    }

    // Fenced code blocks
    if (line.startsWith("```")) {
      flushText();
      const language = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // skip closing ```
      blocks.push({ type: "code", language, lines: codeLines });
      continue;
    }

    // Pipe tables
    if (line.includes("|") && line.trim().startsWith("|")) {
      flushText();
      const rows: string[][] = [];
      let headerIndex = -1;

      while (
        i < lines.length &&
        (lines[i].includes("|") || /^\s*[-:|]+\s*$/.test(lines[i]))
      ) {
        // Separator row (|---|---|)
        if (/^\|[\s\-:|]+\|$/.test(lines[i])) {
          headerIndex = rows.length - 1;
          i++;
          continue;
        }

        if (!lines[i].includes("|")) {
          i++;
          continue;
        }

        const cells = lines[i]
          .split("|")
          .slice(1, -1)
          .map((c) => c.trim());
        rows.push(cells);
        i++;
      }

      if (rows.length > 0) {
        blocks.push({ type: "table", rows, headerIndex });
      }
      continue;
    }

    // Regular text line
    textBuf.push(line);
    i++;
  }

  flushText();

  return { blocks, source, meta: { hasScores: hasScore } };
}

// ---------------------------------------------------------------------------
// isGameRelatedResponse — shared by Discord + Telegram listeners
// ---------------------------------------------------------------------------

export function isGameRelatedResponse(
  response: string,
  prompt: string
): boolean {
  const promptLower = prompt.toLowerCase();
  const responseLower = response.toLowerCase();

  const gamePromptPatterns = [
    /\b(score|scores|game|games|playing|live|tonight|today)\b/,
    /\b(matchup|match-up|vs\.?|versus)\b/,
    /\b(box\s*score|play[\s-]*by[\s-]*play|stats)\b/,
    /\bhow.*(playing|doing)\b/,
  ];

  const gameResponsePatterns = [
    /\b\d{1,3}\s*[-–]\s*\d{1,3}\b/,
    /\b(Q[1-4]|[1-4](st|nd|rd|th)\s*(quarter|qtr)|half|halftime|overtime|OT)\b/i,
    /\b(final|live|in progress|upcoming)\b/i,
    /\b(pts?|reb|ast|points|rebounds|assists)\b/i,
  ];

  const promptMatch = gamePromptPatterns.some((p) => p.test(promptLower));
  const responseMatch = gameResponsePatterns.some((p) => p.test(responseLower));

  return promptMatch || responseMatch;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractSource(text: string): string | null {
  const lines = text.split("\n");
  const lastLine = lines[lines.length - 1]?.trim() || "";
  if (lastLine.toLowerCase().startsWith("source:")) {
    return lastLine.replace(/^source:\s*/i, "");
  }
  return null;
}

function removeSourceLine(text: string): string {
  const lines = text.split("\n");
  return lines.slice(0, -1).join("\n");
}

function hasScores(text: string): boolean {
  return /\d+\s*-\s*\d+/.test(text);
}
