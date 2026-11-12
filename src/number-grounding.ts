/**
 * Deterministic number grounding (sportsclawConfig.groundingCheck).
 *
 * The generative checker asks a model whether the draft matches the data; a
 * small local model can wave an invented score through, and it costs a model
 * call. This check needs no model: every number of two or more digits in the
 * answer must appear in the turn's evidence (tool results, host context, the
 * question, caller history, today's date). Numbers written as words ("thirty
 * eight") count like digits. A number said of a full name the looked-up data
 * never contains is unsupported too (numbersOfUnnamedPeople). It stays narrow:
 * one-word names, teams and prose are left to the generative checker, because
 * "Lakers" in an answer is not wrong when the tool said "LAL".
 */

const UNITS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const TEENS = ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const ORDINAL_UNITS = "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth";
const TENS_WORDS = new RegExp(`\\b(${TENS.join("|")})(?![\\s-]+(?:${ORDINAL_UNITS})\\b)(?:[\\s-]+(${UNITS.join("|")}))?\\b`, "gi");
const TEEN_WORDS = new RegExp(`\\b(${TEENS.join("|")})\\b`, "gi");
/** Number words that are not numbers in sports prose: an even chance, a football team's line-up. */
const IDIOMS = /\b(?:fifty[\s-]fifty|starting eleven)\b/gi;

/**
 * Number words from ten to ninety-nine as digits ("thirty eight" -> "38"), so a model that spells its
 * numbers is checked like one that writes digits. One to nine stay words (one-digit numbers are not
 * checked), and so do ordinals ("twenty-first", "thirteenth") and the idioms above.
 */
function spelledAsDigits(text: string): string {
  return text
    .replace(IDIOMS, "idiom")
    .replace(TENS_WORDS, (_m, tens: string, unit?: string) =>
      String((TENS.indexOf(tens.toLowerCase()) + 2) * 10 + (unit ? UNITS.indexOf(unit.toLowerCase()) + 1 : 0)))
    .replace(TEEN_WORDS, (_m, teen: string) => String(10 + TEENS.indexOf(teen.toLowerCase())));
}

/** Thousands separators removed, so "1,234" and "1234" are the same token; number words become digits. */
function normalize(text: string): string {
  return spelledAsDigits(text.replace(/(\d),(?=\d{3}(?!\d))/g, "$1"));
}

/** Every number in the text: whole tokens, so "99" is not found inside "401909921". */
function numbersIn(text: string): Set<string> {
  return new Set(normalize(text).match(/\d+(?:\.\d+)?/g) ?? []);
}

/** A clock time, "2:31" or "2:31:07", not part of a longer run of digits and colons. */
const CLOCK = /(?<![\d:])\d{1,2}:\d{2}(?::\d{2})?(?![\d:])/g;

/**
 * Numbers in `answer` that no source contains. One-digit integers, ordinals
 * ("4th") and list markers ("12." at a line start) are not checked. A number
 * the answer spelled is reported in digits ("twelve" -> "12").
 *
 * `times` are times of day the model was told (see timeSources). They support
 * only that same clock time written in the answer ("It is 2:31 PM"), never a
 * bare number: the minute is not evidence for a score.
 */
export function unsupportedNumbers(answer: string, sources: readonly string[], times: readonly string[] = []): string[] {
  const known = numbersIn(sources.join("\n"));
  const text = normalize(answer);
  const told = times.flatMap((t) => t.match(CLOCK) ?? []);
  const toldSpans = [...text.matchAll(CLOCK)]
    .filter((m) => told.some((t) => t === m[0] || t.startsWith(m[0] + ":")))
    .map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
  const out: string[] = [];
  for (const { token, at } of checkedNumbers(text)) {
    if (toldSpans.some(([from, to]) => at >= from && at < to)) continue; // the time of day, as told
    if (!known.has(token) && !out.includes(token)) out.push(token);
  }
  return out;
}

/** The numbers of a normalized text that are checked at all: see unsupportedNumbers for what is skipped. */
function* checkedNumbers(text: string): Generator<{ token: string; at: number }> {
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
    yield { token, at };
  }
}

/** Two or more capitalized words in a row: how a person or a full team name is written. */
const FULL_NAME = /\p{Lu}[\p{L}'’-]*\.?(?:\s+\p{Lu}[\p{L}'’-]*\.?)+/gu;
/** Capitalized words that open a sentence or a date rather than name someone. */
const NOT_A_NAME = new Set([
  "the", "a", "an", "and", "but", "or", "so", "yes", "no", "on", "in", "at", "by", "for", "from", "with", "after", "before",
  "here", "there", "he", "she", "they", "it", "this", "that", "these", "those", "his", "her", "their",
]);
const CALENDAR = new Set([
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

/**
 * Numbers the answer says of someone the data never names.
 *
 * unsupportedNumbers asks only whether a number exists somewhere in the evidence, so a model that
 * invents "Jalen Brunson scored 32 points" passes when 32 is some quarter's score. This asks the
 * other half: in a sentence that carries a number and a full name (two or more capitalized words),
 * the name's last word must appear in `data`. `data` is what was looked up — tool results and host
 * data — not the question: asking about a player is not evidence about him. One-word names are not
 * judged ("Lakers" is fine when the tool said "LAL"), and with no data nothing is.
 */
export function numbersOfUnnamedPeople(answer: string, data: readonly string[]): string[] {
  if (data.length === 0) return [];
  const haystack = data.join("\n").toLowerCase();
  const inData = (word: string): boolean =>
    new RegExp(`(?<![\\p{L}\\d])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\d])`, "u").test(haystack);
  const out: string[] = [];
  for (const sentence of normalize(answer).split(/(?<=[.!?])\s+|\n+/)) {
    const unnamed = [...sentence.matchAll(FULL_NAME)].some((m) => {
      const words = m[0].split(/\s+/).map((w) => w.replace(/\.$/, "").toLowerCase());
      if (words.some((w) => CALENDAR.has(w))) return false;
      while (words.length > 0 && NOT_A_NAME.has(words[0])) words.shift();
      return words.length >= 2 && !inData(words[words.length - 1]);
    });
    if (!unnamed) continue;
    for (const { token } of checkedNumbers(sentence)) if (!out.includes(token)) out.push(token);
  }
  return out;
}

/** The local date as the model was told it, so "today" and the year are supported. No time of day: see timeSources. */
export function dateSources(timeZone: string, now = new Date()): string[] {
  return [
    now.toLocaleDateString("en-US", { timeZone }),
    now.toLocaleDateString("en-US", { timeZone, weekday: "long", year: "numeric", month: "long", day: "numeric" }),
    now.toLocaleDateString("en-CA", { timeZone }),
  ];
}

/** The local time of day as the model was told it, and in 24-hour form, for unsupportedNumbers' `times`. */
export function timeSources(timeZone: string, now = new Date()): string[] {
  return [now.toLocaleTimeString("en-US", { timeZone }), now.toLocaleTimeString("en-GB", { timeZone })];
}
