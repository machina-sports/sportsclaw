/**
 * Deterministic number grounding (sportsclawConfig.groundingCheck).
 *
 * The generative checker asks a model whether the draft matches the data; a
 * small local model can wave an invented score through, and it costs a model
 * call. This check needs no model: every number of two or more digits in the
 * answer must appear in the turn's evidence (tool results, host context, the
 * question, caller history, today's date). It is deliberately narrow: names,
 * teams and prose are left to the generative checker, because "Lakers" in an
 * answer is not wrong when the tool said "LAL".
 */

/** Thousands separators removed, so "1,234" and "1234" are the same token. */
function normalize(text: string): string {
  return text.replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
}

/** Every number in the text: whole tokens, so "99" is not found inside "401909921". */
function numbersIn(text: string): Set<string> {
  return new Set(normalize(text).match(/\d+(?:\.\d+)?/g) ?? []);
}

/**
 * Numbers in `answer` that no source contains. One-digit integers, ordinals
 * ("4th") and list markers ("12." at a line start) are not checked.
 */
export function unsupportedNumbers(answer: string, sources: readonly string[]): string[] {
  const known = numbersIn(sources.join("\n"));
  const text = normalize(answer);
  const out: string[] = [];
  for (const m of text.matchAll(/\d+(?:\.\d+)?/g)) {
    const token = m[0];
    const at = m.index ?? 0;
    const before = text[at - 1] ?? "";
    const after = text.slice(at + token.length, at + token.length + 3);
    if (/\p{L}/u.test(before)) continue; // part of an identifier, e.g. "Q4", "mp3", "H100"
    if (/^(st|nd|rd|th)\b/i.test(after)) continue; // an ordinal, e.g. "4th"
    if (!token.includes(".") && token.length < 2) continue;
    const lineStart = !text.slice(0, at).split("\n").at(-1)!.trim();
    if (lineStart && /^[.)]\s/.test(after)) continue;
    if (!known.has(token) && !out.includes(token)) out.push(token);
  }
  return out;
}

/** The local date and time as the model was told them, so "today" and the year are supported. */
export function dateSources(timeZone: string, now = new Date()): string[] {
  return [
    now.toLocaleString("en-US", { timeZone, timeZoneName: "short" }),
    now.toLocaleDateString("en-US", { timeZone, weekday: "long", year: "numeric", month: "long", day: "numeric" }),
    now.toLocaleDateString("en-CA", { timeZone }),
  ];
}
