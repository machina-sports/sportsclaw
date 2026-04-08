/**
 * sportsclaw — Telegram Renderer
 *
 * Converts a ParsedResponse into an HTML string for Telegram's HTML parse mode.
 * Headers → <b>, tables → inline text (no <pre> codeblocks), code → <pre>,
 * bold → <b>, inline code → <code>.
 *
 * Tables are rendered as formatted text lines with mid-dot separators so they
 * flow naturally in Telegram without the monospace codeblock treatment.
 */

import {
  stripBold,
  isComparisonTable,
  renderComparisonText,
  renderTableAligned,
  columnWidths,
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
        result.push(renderTableAsText(block));
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
// renderTableAsText — render tables as monospace-aligned <pre> blocks
// ---------------------------------------------------------------------------

/**
 * Render a table as Telegram HTML.
 *
 * - Comparison tables (3 cols): center-aligned in <pre> for readable match stats
 * - Compact tables (≤6 cols, ≤15 data rows): column-padded in <pre>
 * - Wide tables (>6 cols): flowing text with bold first column and | separators
 */
function renderTableAsText(block: ParsedBlock & { type: "table" }): string {
  const rows = block.rows.map((row) => row.map((c) => stripBold(c)));
  const headerIdx = block.headerIndex >= 0 ? block.headerIndex : 0;
  const headerRow = rows[headerIdx];
  const dataRows = rows.filter((_, i) => i !== headerIdx);

  if (dataRows.length === 0) {
    return `<b>${escapeHtml(headerRow.join("  "))}</b>`;
  }

  // Comparison tables (3 columns): center-aligned in <pre>
  if (isComparisonTable(rows)) {
    return `<pre>${escapeHtml(renderComparisonText(rows, block.headerIndex))}</pre>`;
  }

  const numCols = Math.max(...rows.map((r) => r.length));

  // Compact tables: column-padded in <pre> for proper alignment.
  // Also check total rendered width — wide tables overflow mobile monospace
  // (Telegram's <pre> scrolls horizontally but >42 chars reads poorly).
  const widths = columnWidths(rows);
  const totalWidth = widths.reduce((s, w) => s + w, 0) + Math.max(0, numCols - 1) * 3;
  if (numCols <= 6 && dataRows.length <= 15 && totalWidth <= 42) {
    return `<pre>${escapeHtml(renderTableAligned(rows, block.headerIndex))}</pre>`;
  }

  // Wide tables: flowing text with bold first column
  const lines: string[] = [];
  for (const row of dataRows) {
    const parts: string[] = [];
    for (let c = 0; c < row.length; c++) {
      const val = row[c] || "";
      parts.push(c === 0 ? `<b>${escapeHtml(val)}</b>` : escapeHtml(val));
    }
    lines.push(parts.join(" | "));
  }
  return lines.join("\n");
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
