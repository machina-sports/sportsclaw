/**
 * sportsclaw — Telegram Renderer
 *
 * Converts a ParsedResponse into an HTML string for Telegram's HTML parse mode.
 * Headers → <b>, tables → <pre>, code → <pre>, bold → <b>, inline code → <code>.
 */

import {
  stripBold,
  isComparisonTable,
  renderComparisonText,
} from "./parser.js";
import type { ParsedResponse, ParsedBlock } from "./parser.js";

// ---------------------------------------------------------------------------
// renderTelegram
// ---------------------------------------------------------------------------

export function renderTelegram(parsed: ParsedResponse): string {
  const result: string[] = [];

  for (const block of parsed.blocks) {
    switch (block.type) {
      case "header":
        result.push(`\n<b>${escapeHtml(block.text)}</b>`);
        break;

      case "table": {
        if (isComparisonTable(block.rows)) {
          const text = renderComparisonText(block.rows, block.headerIndex);
          result.push(`<pre>${escapeHtml(text)}</pre>`);
        } else {
          result.push(`<pre>${escapeHtml(renderAlignedTable(block))}</pre>`);
        }
        break;
      }

      case "code":
        result.push(
          `<pre>${block.lines.map((l) => escapeHtml(l)).join("\n")}</pre>`
        );
        break;

      case "text":
        for (const line of block.lines) {
          let processed = escapeHtml(line);
          // **bold** → <b>bold</b>  (must come before single * italic)
          processed = processed.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
          // `inline code` → <code>inline code</code>
          processed = processed.replace(/`([^`]+)`/g, "<code>$1</code>");
          // *italic* → <i>italic</i>  (after ** is already handled)
          processed = processed.replace(/\*(.+?)\*/g, "<i>$1</i>");
          // Bullet markers → clean bullets (- or leftover * at line start)
          processed = processed.replace(/^(\s*)[*\-]\s+/, "$1• ");
          result.push(processed);
        }
        break;
    }
  }

  // Source footer
  if (parsed.source) {
    result.push("");
    result.push(`<i>${escapeHtml(parsed.source)}</i>`);
  }

  return result.join("\n");
}

// ---------------------------------------------------------------------------
// renderAlignedTable — fixed-width column alignment for monospace <pre>
// ---------------------------------------------------------------------------

function renderAlignedTable(block: ParsedBlock & { type: "table" }): string {
  const stripped = block.rows.map((row) => row.map((c) => stripBold(c)));

  // Compute max width per column
  const colCount = Math.max(...stripped.map((r) => r.length));
  const colWidths: number[] = Array(colCount).fill(0);
  for (const row of stripped) {
    for (let c = 0; c < row.length; c++) {
      colWidths[c] = Math.max(colWidths[c], row[c].length);
    }
  }

  const lines: string[] = [];
  for (let r = 0; r < stripped.length; r++) {
    const row = stripped[r];
    const padded = row.map((cell, c) => {
      // Right-align if the cell looks numeric, left-align otherwise
      const w = colWidths[c];
      return looksNumeric(cell) ? cell.padStart(w) : cell.padEnd(w);
    });
    lines.push(padded.join("  "));

    // Add separator after header row
    if (r === block.headerIndex) {
      lines.push(colWidths.map((w) => "─".repeat(w)).join("──"));
    }
  }

  return lines.join("\n");
}

/** Check if a string looks like a number, score, percentage, or stat. */
function looksNumeric(s: string): boolean {
  return /^\s*[-+]?\d[\d.,]*%?\s*$/.test(s) || /^\d+\s*-\s*\d+$/.test(s);
}

// ---------------------------------------------------------------------------
// escapeHtml — Telegram HTML-safe escaping
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
