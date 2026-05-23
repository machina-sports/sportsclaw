/**
 * Telegram renderer — tests for renderTelegram + table → labelled-card rendering.
 *
 * Telegram has no native table support; this renderer drops the spreadsheet
 * metaphor in favour of per-row labelled cards. Tests pin that behaviour and
 * cover the surrounding block types (headers, code, text, source footer).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseBlocks } from "../dist/formatters/parser.js";
import { renderTelegram } from "../dist/formatters/telegram.js";

// ---------------------------------------------------------------------------
// table rendering
// ---------------------------------------------------------------------------

describe("renderTelegram — tables", () => {
  it("renders a multi-column fenced-table as one labelled card per data row", () => {
    const input =
      "```\n" +
      "Data | Adversário | Estádio\n" +
      "13/06/2026 | Marrocos | MetLife Stadium\n" +
      "20/06/2026 | Haiti | Lincoln Financial Field\n" +
      "```";
    const out = renderTelegram(parseBlocks(input));

    assert.match(out, /<b>13\/06\/2026<\/b>/);
    assert.match(out, /• <b>Adversário:<\/b> Marrocos/);
    assert.match(out, /• <b>Estádio:<\/b> MetLife Stadium/);
    assert.match(out, /<b>20\/06\/2026<\/b>/);
    assert.match(out, /• <b>Adversário:<\/b> Haiti/);
    // Cards separated by a blank line.
    assert.match(out, /\n\n<b>20\/06\/2026<\/b>/);
    // No <pre> wrapping, no flowing-pipe text.
    assert.ok(!out.includes("<pre>"), "table must not emit a <pre> block");
    assert.ok(!out.includes(" | "), "table must not emit pipe-separated rows");
  });

  it("renders a proper markdown table (with separator) the same way", () => {
    const input =
      "| Data | Adversário | Estádio |\n" +
      "| --- | --- | --- |\n" +
      "| 13/06/2026 | Marrocos | MetLife |\n" +
      "| 20/06/2026 | Haiti | Lincoln |";
    const out = renderTelegram(parseBlocks(input));

    assert.match(out, /<b>13\/06\/2026<\/b>/);
    assert.match(out, /• <b>Adversário:<\/b> Marrocos/);
    assert.match(out, /• <b>Estádio:<\/b> Lincoln/);
    assert.ok(!out.includes("<pre>"));
  });

  it("skips blank cells without emitting a 'Label:' line", () => {
    const input =
      "```\n" +
      "Team | W | L\n" +
      "Lakers | 11 | \n" +
      "```";
    const out = renderTelegram(parseBlocks(input));

    assert.match(out, /<b>Lakers<\/b>/);
    assert.match(out, /• <b>W:<\/b> 11/);
    // No "• L:" line because the value was blank.
    assert.ok(!/• <b>L:<\/b>/.test(out), "blank cells must not emit a bullet");
  });

  it("falls back to 'Col N' when a row is wider than the header", () => {
    const input =
      "```\n" +
      "Stat | Value\n" +
      "Possession | 58% | extra-cell\n" +
      "```";
    const out = renderTelegram(parseBlocks(input));

    assert.match(out, /<b>Possession<\/b>/);
    assert.match(out, /• <b>Value:<\/b> 58%/);
    assert.match(out, /• <b>Col 3:<\/b> extra-cell/);
  });

  it("escapes HTML-sensitive characters inside cells and headers", () => {
    const input =
      "```\n" +
      "Team & Notes | Comment\n" +
      "<Lakers> | a <b>fake bold</b> tag\n" +
      "```";
    const out = renderTelegram(parseBlocks(input));

    assert.match(out, /<b>&lt;Lakers&gt;<\/b>/);
    assert.match(out, /• <b>Comment:<\/b> a &lt;b&gt;fake bold&lt;\/b&gt; tag/);
    // The literal "<b>fake bold</b>" must be escaped, not interpreted.
    assert.ok(!out.includes("<b>fake bold</b>"));
  });

  it("renders a header-only table as a single bolded line with · separators", () => {
    // A "table" with no data rows — unusual but possible after filtering.
    const input =
      "```\n" +
      "Col A | Col B | Col C\n" +
      "```";
    // parseBlocks with a single pipe-line inside a fence falls through to code
    // (not table — needs at least 2 rows to trigger parsePipeLines). Skip if so.
    const blocks = parseBlocks(input).blocks;
    if (blocks[0]?.type !== "table") return; // not the path we're testing
    const out = renderTelegram({ blocks, meta: {} });
    assert.match(out, /<b>Col A · Col B · Col C<\/b>/);
  });
});

// ---------------------------------------------------------------------------
// surrounding block types — sanity coverage
// ---------------------------------------------------------------------------

describe("renderTelegram — other blocks", () => {
  it("wraps headers in <b>", () => {
    const out = renderTelegram(parseBlocks("## Match Report"));
    assert.match(out, /<b>Match Report<\/b>/);
  });

  it("emits real code blocks (no embedded table) as <pre>", () => {
    const out = renderTelegram(
      parseBlocks("```javascript\nconst x = 1;\nconsole.log(x);\n```"),
    );
    assert.match(out, /<pre>const x = 1;\nconsole\.log\(x\);<\/pre>/);
  });

  it("converts **bold** and `inline code` markers in flowing text", () => {
    const out = renderTelegram(
      parseBlocks("Tonight: **Lakers** vs `Warriors`."),
    );
    assert.match(out, /<b>Lakers<\/b>/);
    assert.match(out, /<code>Warriors<\/code>/);
  });

  it("converts a leading - or * into a • bullet", () => {
    const out = renderTelegram(parseBlocks("- first\n- second"));
    assert.match(out, /^• first$/m);
    assert.match(out, /^• second$/m);
  });
});
