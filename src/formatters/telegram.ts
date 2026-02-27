/**
 * sportsclaw — Telegram Renderer
 *
 * Converts a ParsedResponse into an HTML string for Telegram's HTML parse mode.
 * Headers → <b>, tables → <pre>, code → <pre>, bold → <b>, inline code → <code>.
 */

import type { ParsedResponse } from "./parser.js";

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
        const lines = block.rows.map((cells) =>
          cells.map((c) => escapeHtml(c)).join("  |  ")
        );
        result.push(`<pre>${lines.join("\n")}</pre>`);
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
          // **bold** → <b>bold</b>
          processed = processed.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
          // `inline code` → <code>inline code</code>
          processed = processed.replace(/`([^`]+)`/g, "<code>$1</code>");
          // Bullet markers → clean bullets
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
// escapeHtml — Telegram HTML-safe escaping
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
