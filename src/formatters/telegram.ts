/**
 * sportsclaw — Telegram Renderer
 *
 * Converts a ParsedResponse into an HTML string for Telegram's HTML parse mode.
 * Headers → <b>, code → <pre>, bold → <b>, inline code → <code>.
 *
 * Tables get a Telegram-native treatment: each data row becomes a labelled
 * multi-line item (bold first cell as heading, remaining cells as bulleted
 * "Header: value" lines). Telegram has no native table support and `<pre>`
 * table renderings wrap awkwardly on phone screens, so we drop the
 * spreadsheet metaphor entirely.
 */

import { stripBold } from "./parser.js";
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
// renderTableAsText — Telegram-native labelled multi-line rendering
// ---------------------------------------------------------------------------

/**
 * Render a table as Telegram HTML, one labelled "card" per data row.
 *
 * Layout per row:
 *   <b>{first-cell}</b>
 *   • <b>{header[1]}:</b> {cell[1]}
 *   • <b>{header[2]}:</b> {cell[2]}
 *   ...
 *
 * Why: Telegram has no native tables. `<pre>`-wrapped grids wrap awkwardly
 * on narrow screens and pipe-separated flowing text reads like CSV. The
 * labelled-card format keeps the data without the spreadsheet metaphor.
 *
 * Edge cases:
 *   - 1-column tables: just bold the value (no labels to attach).
 *   - Empty cells: skipped (no "Label:" line emitted for blank values).
 *   - Header has fewer cells than a data row: extra cells fall back to "Col N".
 *   - No data rows: the header itself is bolded with ` · ` separators.
 */
function renderTableAsText(block: ParsedBlock & { type: "table" }): string {
  const rows = block.rows.map((row) => row.map((c) => stripBold(c)));
  const headerIdx = block.headerIndex >= 0 ? block.headerIndex : 0;
  const headerRow = rows[headerIdx] ?? [];
  const dataRows = rows.filter((_, i) => i !== headerIdx);

  if (dataRows.length === 0) {
    return `<b>${escapeHtml(headerRow.join(" · "))}</b>`;
  }

  const cards: string[] = [];
  for (const row of dataRows) {
    const lines: string[] = [];
    // First cell is the row heading (bold).
    const heading = (row[0] ?? "").trim();
    if (heading) {
      lines.push(`<b>${escapeHtml(heading)}</b>`);
    }
    // Remaining cells become labelled bullets keyed by the header.
    for (let c = 1; c < row.length; c++) {
      const val = (row[c] ?? "").trim();
      if (val.length === 0) continue;
      const label = (headerRow[c] ?? `Col ${c + 1}`).trim();
      // 1-column tables (no header label) — just dump the value bolded above.
      // (Shouldn't normally hit since c >= 1 implies a second column exists.)
      if (label.length === 0) {
        lines.push(`• ${escapeHtml(val)}`);
      } else {
        lines.push(`• <b>${escapeHtml(label)}:</b> ${escapeHtml(val)}`);
      }
    }
    if (lines.length > 0) {
      cards.push(lines.join("\n"));
    }
  }
  return cards.join("\n\n");
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
