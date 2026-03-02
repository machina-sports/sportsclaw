/**
 * sportsclaw — CLI Renderer
 *
 * Converts a ParsedResponse into an ANSI-colored string with
 * Unicode box-drawing tables.
 */

import { c, box } from "../colors.js";
import type { ParsedResponse } from "./parser.js";

// ---------------------------------------------------------------------------
// renderCli
// ---------------------------------------------------------------------------

export function renderCli(parsed: ParsedResponse): string {
  const width = termWidth();
  const formatted: string[] = [];

  for (const block of parsed.blocks) {
    switch (block.type) {
      case "header":
        formatted.push(`\n${c.bold(block.text)}`);
        formatted.push(
          c.dim(box.horizontal.repeat(Math.min(block.text.length, width - 2)))
        );
        break;

      case "table":
        formatted.push(...convertTableToUnicode(block.rows, block.headerIndex));
        break;

      case "code":
        for (const line of block.lines) {
          formatted.push(line);
        }
        break;

      case "text":
        for (const line of block.lines) {
          let processed = cleanMarkdown(line);

          // Format scores with colors (e.g., "Arsenal 2-1 Chelsea")
          if (/\w+.*\d+\s*-\s*\d+.*\w+/.test(processed)) {
            const scoreLine = processed.replace(
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
            formatted.push(wrapLine(scoreLine, width));
            continue;
          }

          // Highlight live games
          if (/🔴|LIVE/i.test(processed)) {
            formatted.push(wrapLine(c.yellow(processed), width));
            continue;
          }

          // Determine hanging indent for wrapped lines
          const bulletMatch = processed.match(/^(\s*)•\s/);
          const indent = bulletMatch ? bulletMatch[1].length + 2 : 0;
          formatted.push(wrapLine(processed, width, indent));
        }
        break;
    }
  }

  // Source footer
  if (parsed.source) {
    formatted.push("");
    formatted.push(c.dim(`Source: ${parsed.source}`));
  }

  return formatted.join("\n");
}

// ---------------------------------------------------------------------------
// Terminal helpers
// ---------------------------------------------------------------------------

function termWidth(): number {
  const cols = process.stdout.columns || 80;
  return Math.min(cols, 120);
}

function stripAnsi(s: string): number {
  return stripAnsiChars(s).length;
}

function stripAnsiChars(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function wrapLine(line: string, width: number, indent = 0): string {
  if (stripAnsi(line) <= width) return line;
  if (/[┌┐└┘─│├┤┬┴┼]/.test(line)) return line;

  const words = line.split(/( +)/);
  const lines: string[] = [];
  let current = "";
  const pad = " ".repeat(indent);

  for (const word of words) {
    const candidate = current + word;
    if (stripAnsi(candidate) > width && current.length > 0) {
      lines.push(current.trimEnd());
      current = pad + word.trimStart();
    } else {
      current = candidate;
    }
  }
  if (current.trimEnd().length > 0) lines.push(current.trimEnd());

  return lines.join("\n");
}

function cleanMarkdown(line: string): string {
  let cleaned = line;
  // Bold: **text**
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, (_, text) => c.bold(text));
  // Italic: *text* (but not list items — those start the line with "* ")
  cleaned = cleaned.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, (_, text) => c.dim(text));
  // Unordered list bullets
  cleaned = cleaned.replace(/^(\s*)\*\s+/, "$1• ");
  cleaned = cleaned.replace(/^(\s*)-\s+/, "$1• ");
  return cleaned;
}

// ---------------------------------------------------------------------------
// Unicode box-drawing table
// ---------------------------------------------------------------------------

/**
 * Pad a string that may contain ANSI escape codes to a target visible width.
 * Standard padEnd counts escape codes as characters, breaking table alignment.
 */
function padEndVisible(s: string, targetWidth: number): string {
  const visible = stripAnsi(s);
  if (visible >= targetWidth) return s;
  return s + " ".repeat(targetWidth - visible);
}

function convertTableToUnicode(
  rows: string[][],
  headerIndex: number
): string[] {
  const maxWidth = termWidth();

  if (rows.length === 0) return [];

  // Apply markdown formatting (e.g. **bold** → ANSI bold) to all cells.
  // Store both the styled cell and its visible (ANSI-stripped) text so
  // column widths are measured correctly.
  const styledRows: string[][] = rows.map((row) =>
    row.map((cell) => cleanMarkdown(cell))
  );

  // Calculate max *visible* width for each column
  const colCount = Math.max(...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let col = 0; col < colCount; col++) {
    widths[col] = Math.max(
      ...styledRows.map((r) => {
        const cell = r[col] ?? "";
        return stripAnsi(cell);
      })
    );
  }

  // Shrink columns to fit terminal width
  const overhead = colCount + 1 + colCount * 2;
  const totalContent = widths.reduce((a, b) => a + b, 0);
  if (totalContent + overhead > maxWidth) {
    const available = maxWidth - overhead;
    if (available > colCount) {
      const ratio = available / totalContent;
      for (let col = 0; col < colCount; col++) {
        widths[col] = Math.max(3, Math.floor(widths[col] * ratio));
      }
      // Truncate cells that exceed the shrunk column width
      for (const row of styledRows) {
        for (let col = 0; col < row.length; col++) {
          const visible = stripAnsiChars(row[col] ?? "");
          if (visible.length > widths[col]) {
            row[col] = visible.slice(0, widths[col] - 1) + "…";
          }
        }
      }
    }
  }

  const result: string[] = [];

  // Top border
  const top =
    box.topLeft +
    widths.map((w) => box.horizontal.repeat(w + 2)).join(box.topTee) +
    box.topRight;
  result.push(top);

  for (let i = 0; i < styledRows.length; i++) {
    const cells = styledRows[i];
    const paddedCells = cells.map((cell, col) =>
      padEndVisible(cell, widths[col] || 0)
    );
    const row =
      box.vertical +
      paddedCells.map((cell) => ` ${cell} `).join(box.vertical) +
      box.vertical;
    result.push(row);

    if (i === headerIndex) {
      const sep =
        box.leftTee +
        widths.map((w) => box.horizontal.repeat(w + 2)).join(box.cross) +
        box.rightTee;
      result.push(sep);
    }
  }

  // Bottom border
  const bottom =
    box.bottomLeft +
    widths.map((w) => box.horizontal.repeat(w + 2)).join(box.bottomTee) +
    box.bottomRight;
  result.push(bottom);

  return result;
}
