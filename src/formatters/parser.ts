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

    // Fenced code blocks — detect embedded tables inside them
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

      // If most lines contain pipes, treat as a table instead of code
      const nonEmpty = codeLines.filter((l) => l.trim().length > 0);
      const pipeLines = nonEmpty.filter((l) => l.includes("|"));
      if (nonEmpty.length >= 2 && pipeLines.length / nonEmpty.length >= 0.7) {
        const parsed = parsePipeLines(codeLines);
        if (parsed) {
          blocks.push(parsed);
          continue;
        }
      }

      blocks.push({ type: "code", language, lines: codeLines });
      continue;
    }

    // Pipe tables (with or without leading |)
    if (line.includes("|") && looksLikeTableRow(line)) {
      flushText();
      const rows: string[][] = [];
      let headerIndex = -1;

      while (
        i < lines.length &&
        (lines[i].includes("|") || /^\s*[-:|]+\s*$/.test(lines[i]))
      ) {
        // Separator row (|---|---| or ---|---)
        if (/^[\s|]*[-:|][-:\s|]+$/.test(lines[i])) {
          headerIndex = rows.length - 1;
          i++;
          continue;
        }

        if (!lines[i].includes("|")) {
          i++;
          continue;
        }

        const cells = splitPipeRow(lines[i]);
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

  // Prompt: user is asking about game/match data
  const gamePromptPatterns = [
    /\b(score|scores|game|games|playing|live|tonight|today)\b/,
    /\b(match|matchup|match-up|vs\.?|versus)\b/,
    /\b(box\s*score|play[\s-]*by[\s-]*play|stats|lineup|standings|leaderboard)\b/,
    /\bhow.*(playing|doing)\b/,
  ];

  // Response: contains actual game/match data (cross-sport)
  const gameResponsePatterns = [
    // Universal score pattern
    /\b\d{1,3}\s*[-–]\s*\d{1,3}\b/,
    /\b(final|live|in progress|upcoming|full[\s-]?time)\b/i,
    // Basketball
    /\b(Q[1-4]|[1-4](st|nd|rd|th)\s*(quarter|qtr)|halftime|overtime|OT)\b/i,
    /\b(pts?|reb|ast|points|rebounds|assists)\b/i,
    // Football/Soccer
    /\b(goal|clean sheet|xG|possession|penalty|half[\s-]?time|match\s*day)\b/i,
    // American Football
    /\b(touchdown|TD|field goal|interception|rushing|passing yards?)\b/i,
    // Baseball
    /\b(inning|RBI|ERA|home run|strikeout|at[\s-]?bat)\b/i,
    // Hockey
    /\b([1-3](st|nd|rd)\s*period|power play|shutout)\b/i,
    // Tennis
    /\b(set [1-5]|match point|break point|tiebreak)\b/i,
    // F1
    /\b(lap \d+|pole position|pit stop|fastest lap)\b/i,
    // Golf
    /\b(under par|over par|leaderboard|round [1-4])\b/i,
  ];

  const promptMatch = gamePromptPatterns.some((p) => p.test(promptLower));
  const responseMatch = gameResponsePatterns.some((p) => p.test(responseLower));

  return promptMatch || responseMatch;
}

// ---------------------------------------------------------------------------
// Table formatting utilities (shared by Discord + Telegram renderers)
// ---------------------------------------------------------------------------

/** Strip markdown bold markers (don't render inside code/pre blocks) */
export function stripBold(s: string): string {
  return s.replace(/\*\*/g, "").trim();
}

/** Center a string within a given width */
export function centerPad(s: string, width: number): string {
  if (s.length >= width) return s;
  const left = Math.floor((width - s.length) / 2);
  return " ".repeat(left) + s + " ".repeat(width - s.length - left);
}

/** Check if a table is a head-to-head comparison (3 columns: stat, team1, team2) */
export function isComparisonTable(rows: string[][]): boolean {
  return rows.length >= 3 && rows.every((r) => r.length === 3);
}

/**
 * Render a 3-column comparison table as center-aligned plain text:
 *
 *   Real Madrid  vs  Getafe
 *   ────────────────────────────
 *      77.7%  Possession  22.3%
 *        554  Total Passes  158
 */
export function renderComparisonText(
  rows: string[][],
  headerIndex: number
): string {
  const hIdx = headerIndex >= 0 ? headerIndex : 0;
  const headerRow = rows[hIdx];
  const dataRows = rows.filter((_, i) => i !== hIdx);

  if (dataRows.length === 0) {
    return rows.map((r) => r.map(stripBold).join("  |  ")).join("\n");
  }

  const team1 = stripBold(headerRow[1] || "Home");
  const team2 = stripBold(headerRow[2] || "Away");

  const data = dataRows.map((r) => [
    stripBold(r[0] || ""),
    stripBold(r[1] || ""),
    stripBold(r[2] || ""),
  ]);

  const val1W = Math.max(team1.length, ...data.map((r) => r[1].length));
  const statW = Math.max(...data.map((r) => r[0].length));
  const val2W = Math.max(team2.length, ...data.map((r) => r[2].length));

  const gap = "  ";
  const totalW = val1W + gap.length + statW + gap.length + val2W;

  const lines: string[] = [];

  // Team header
  lines.push(
    team1.padStart(val1W) + gap + centerPad("vs", statW) + gap + team2
  );

  // Separator
  lines.push("─".repeat(totalW));

  // Data rows
  for (const [stat, v1, v2] of data) {
    lines.push(v1.padStart(val1W) + gap + centerPad(stat, statW) + gap + v2);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractSource(text: string): string | null {
  const lines = text.split("\n");
  const lastLine = lines[lines.length - 1]?.trim() || "";
  // Match "Source: ...", "*Source: ...*", "**Source: ...**"
  const stripped = lastLine.replace(/^\*{1,2}|\*{1,2}$/g, "").trim();
  if (stripped.toLowerCase().startsWith("source:")) {
    return stripped.replace(/^source:\s*/i, "");
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

// ---------------------------------------------------------------------------
// Pipe table helpers — handle tables with or without leading/trailing |
// ---------------------------------------------------------------------------

/** Check if a line looks like a table row (has pipes separating 2+ cells). */
function looksLikeTableRow(line: string): boolean {
  const trimmed = line.trim();
  // Must have at least one pipe that's not at the very start/end only
  const parts = trimmed.split("|").filter((p) => p.trim().length > 0);
  return parts.length >= 2;
}

/** Split a pipe-delimited row into cells, handling both |a|b| and a|b formats. */
function splitPipeRow(line: string): string[] {
  const trimmed = line.trim();
  // If it starts and ends with |, slice off the outer pipes
  if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
    return trimmed.split("|").slice(1, -1).map((c) => c.trim());
  }
  // Otherwise split on | and trim each cell
  return trimmed.split("|").map((c) => c.trim());
}

/**
 * Parse an array of lines (e.g. from inside a code block) as a pipe table.
 * Returns a table block if successful, null otherwise.
 */
function parsePipeLines(
  lines: string[]
): (ParsedBlock & { type: "table" }) | null {
  const rows: string[][] = [];
  let headerIndex = -1;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    // Separator row
    if (/^[\s|]*[-:|][-:\s|]+$/.test(trimmed)) {
      headerIndex = rows.length - 1;
      continue;
    }

    if (!trimmed.includes("|")) continue;

    rows.push(splitPipeRow(trimmed));
  }

  if (rows.length < 2) return null;

  // If no explicit separator, assume first row is header
  if (headerIndex < 0) headerIndex = 0;

  return { type: "table", rows, headerIndex };
}
