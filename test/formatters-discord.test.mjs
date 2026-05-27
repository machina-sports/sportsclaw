/**
 * Discord renderer — tests for renderDiscord + table → labelled-card rendering.
 *
 * Tables get labelled-card treatment on Discord (mirrors the Telegram fix):
 * each data row becomes a bold-headed mini-block with `• **Label:** value`
 * bullets. Tests pin that behaviour for both the embed and plain-text paths.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseBlocks } from "../dist/formatters/parser.js";
import {
  renderDiscord,
  formatTextForDiscord,
} from "../dist/formatters/discord.js";

// ---------------------------------------------------------------------------
// formatTextForDiscord — table rendering
// ---------------------------------------------------------------------------

describe("formatTextForDiscord — tables", () => {
  it("renders a fenced multi-column table as labelled cards", () => {
    const input =
      "```\n" +
      "Data | Adversário | Estádio\n" +
      "13/06/2026 | Marrocos | MetLife Stadium\n" +
      "20/06/2026 | Haiti | Lincoln Financial Field\n" +
      "```";
    const out = formatTextForDiscord(input);

    assert.match(out, /\*\*13\/06\/2026\*\*/);
    assert.match(out, /• \*\*Adversário:\*\* Marrocos/);
    assert.match(out, /• \*\*Estádio:\*\* MetLife Stadium/);
    assert.match(out, /\n\n\*\*20\/06\/2026\*\*/);
    assert.ok(!out.includes("```\nData"), "table must not be wrapped in a code block");
    assert.ok(!/Data \| Adversário/.test(out), "pipe row must not appear in output");
  });

  it("renders a proper markdown table the same way", () => {
    const input =
      "| Data | Adversário | Estádio |\n" +
      "| --- | --- | --- |\n" +
      "| 13/06/2026 | Marrocos | MetLife |\n" +
      "| 20/06/2026 | Haiti | Lincoln |";
    const out = formatTextForDiscord(input);

    assert.match(out, /\*\*13\/06\/2026\*\*/);
    assert.match(out, /• \*\*Adversário:\*\* Marrocos/);
    assert.match(out, /• \*\*Estádio:\*\* Lincoln/);
    assert.ok(!out.includes("```"), "no code block on the table path");
  });

  it("skips blank cells without emitting a 'Label:' line", () => {
    const input =
      "```\n" +
      "Team | W | L\n" +
      "Lakers | 11 | \n" +
      "```";
    const out = formatTextForDiscord(input);

    assert.match(out, /\*\*Lakers\*\*/);
    assert.match(out, /• \*\*W:\*\* 11/);
    assert.ok(!/• \*\*L:\*\*/.test(out));
  });

  it("falls back to 'Col N' when a row is wider than the header", () => {
    const input =
      "```\n" +
      "Stat | Value\n" +
      "Possession | 58% | extra-cell\n" +
      "```";
    const out = formatTextForDiscord(input);

    assert.match(out, /\*\*Possession\*\*/);
    assert.match(out, /• \*\*Value:\*\* 58%/);
    assert.match(out, /• \*\*Col 3:\*\* extra-cell/);
  });

  it("preserves real code blocks (no embedded table) as ```", () => {
    const out = formatTextForDiscord(
      "```javascript\nconst x = 1;\nconsole.log(x);\n```",
    );
    assert.match(out, /```javascript\nconst x = 1;\nconsole\.log\(x\);\n```/);
  });
});

// ---------------------------------------------------------------------------
// renderDiscord — embed shape with table content
// ---------------------------------------------------------------------------

describe("renderDiscord — embed with table", () => {
  it("puts the labelled-card content in the embed description (no headers)", () => {
    const input =
      "```\n" +
      "Data | Adversário\n" +
      "13/06/2026 | Marrocos\n" +
      "20/06/2026 | Haiti\n" +
      "```";
    const embed = renderDiscord(parseBlocks(input));

    assert.ok(embed.description);
    assert.match(embed.description, /\*\*13\/06\/2026\*\*/);
    assert.match(embed.description, /• \*\*Adversário:\*\* Marrocos/);
    assert.ok(!embed.description.includes("```"));
  });

  it("groups a table beneath a header into a field value", () => {
    const input =
      "## Agenda da Seleção\n" +
      "```\n" +
      "Data | Adversário\n" +
      "13/06/2026 | Marrocos\n" +
      "```";
    const embed = renderDiscord(parseBlocks(input));

    assert.ok(embed.fields && embed.fields.length === 1);
    assert.strictEqual(embed.fields[0].name, "Agenda da Seleção");
    assert.match(embed.fields[0].value, /\*\*13\/06\/2026\*\*/);
    assert.match(embed.fields[0].value, /• \*\*Adversário:\*\* Marrocos/);
  });

  it("does not put parsed source attribution into the embed footer", () => {
    const input = "Lakers up 78-71, 4:12 left in Q3.\n*Source: ESPN*";
    const embed = renderDiscord(parseBlocks(input));

    assert.equal(embed.footer, undefined);
    assert.match(embed.description ?? "", /Lakers up 78-71/);
    assert.ok(!/Source:/i.test(embed.description ?? ""));
    assert.ok(!/ESPN/.test(embed.description ?? ""));
  });

  it("does not append source attribution in plain Discord text", () => {
    const out = formatTextForDiscord("Lakers up 78-71.\n*Source: ESPN*");

    assert.match(out, /Lakers up 78-71/);
    assert.ok(!/Source:/i.test(out));
    assert.ok(!/ESPN/.test(out));
  });
});
