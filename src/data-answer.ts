/**
 * Data written by code from tool results (sportsclawConfig.answerFrom).
 *
 * A number in an answer is copied from data, computed from data, or invented,
 * and only code can guarantee the first two. So when every tool result of the
 * turn is one a fixed renderer fully validates, the engine writes what was
 * found itself: under the model's answer ("model+data"), or in place of it
 * ("data", and whenever the model's own numbers are not in the data). The
 * model chose what to look up and how to say it; code states the figures. A
 * mistake here can show a game too many or leave one out; it cannot state a
 * number the data does not contain.
 *
 * Rendered so far: `<league>_get_scoreboard` and `<league>_get_standings`. Any
 * other tool, an error, or a payload the renderer cannot validate returns
 * undefined, and the model's answer stands (with the usual checks).
 */
import { SAFE_NAME, scoreboardDate, scoreboardGames, type ScoreboardGame } from "./fast-lookup.js";

/** A tool result of the turn, as runDetailed() reports it. */
export interface ReadResult {
  toolName: string;
  input: unknown;
  output: string;
  isError: boolean;
}

const SCOREBOARD_TOOL = /^([a-z][a-z0-9]*)_get_scoreboard$/;
const STANDINGS_TOOL = /^([a-z][a-z0-9]*)_get_standings$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const COUNT = /^\d{1,3}$/;
const RANK = /^\d{1,2}$/;
const MAX_GROUPS = 12;
const MAX_ENTRIES = 40;

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
/** A count as the data gives it, string or number, when it is a plain whole number. */
const count = (value: unknown): string | undefined => {
  const text = typeof value === "number" ? String(value) : value;
  return typeof text === "string" && COUNT.test(text) ? text : undefined;
};

/** True when the question says the phrase as whole words. */
function says(question: string, phrase: string, exactCase = false): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, exactCase ? "u" : "iu").test(question);
}

/** True when the question says the team's full name or its last word ("Lakers"). */
function names(question: string, team: string): boolean {
  return says(question, team) || says(question, team.split(" ").at(-1) ?? team);
}

/** True when the question says the group: "Eastern Conference", "Eastern", "East", or its initials ("AFC", "AL"). */
function namesGroup(question: string, label: string): boolean {
  const words = label.split(" ");
  return says(question, label) || says(question, words[0]) || (words[0].endsWith("ern") && says(question, words[0].slice(0, -3))) ||
    (words.length > 1 && says(question, words.map((w) => w[0]).join(""), true));
}

interface StandingsGroup {
  label: string;
  rows: Array<{ line: string; team: string }>;
}

/** One group's teams in the order the data ranks them (playoff_seed), or undefined when any row cannot be validated. */
function standingsGroup(group: unknown): StandingsGroup | undefined {
  if (!isRow(group) || group.division !== "" || !Array.isArray(group.entries)) return undefined;
  const label = typeof group.conference === "string" ? group.conference : group.league;
  if (typeof label !== "string" || !SAFE_NAME.test(label) || group.entries.length === 0 || group.entries.length > MAX_ENTRIES) return undefined;
  const ranked: Array<{ rank: number; line: string; team: string }> = [];
  for (const entry of group.entries) {
    if (!isRow(entry) || !isRow(entry.team)) return undefined;
    const team = entry.team.name;
    const rank = typeof entry.playoff_seed === "number" ? String(entry.playoff_seed) : entry.playoff_seed;
    const wins = count(entry.wins);
    const losses = count(entry.losses);
    if (typeof team !== "string" || !SAFE_NAME.test(team) || typeof rank !== "string" || !RANK.test(rank) || !wins || !losses) return undefined;
    if (ranked.some((r) => r.rank === Number(rank))) return undefined;
    // Ties, overtime losses and points only where the league's data has them; each must be a count when present.
    const extras = ["ties", "overtime_losses", "points"].map((key) => (key in entry ? count(entry[key]) ?? null : undefined));
    if (extras.includes(null)) return undefined;
    const [ties, overtimeLosses, points] = extras;
    const record = [wins, losses, ...(ties && ties !== "0" ? [ties] : []), ...(overtimeLosses ? [overtimeLosses] : [])].join("-");
    ranked.push({ rank: Number(rank), team, line: `${rank}. ${team} ${record}${points ? `, ${points} pts` : ""}` });
  }
  return { label, rows: ranked.sort((a, b) => a.rank - b.rank) };
}

/** The standings the question asks about, one block per group, or undefined when any part cannot be validated. */
function standingsBlocks(league: string, input: unknown, content: string, question: string): string[] | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRow(payload) || payload.status !== true || !isRow(payload.data) || payload.data.season_type !== "regular") return undefined;
  const requested = isRow(input) ? input.season : undefined;
  if (requested !== undefined && (!Number.isInteger(requested) || requested !== payload.data.season)) return undefined;
  const raw = payload.data.groups;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_GROUPS) return undefined;
  const groups: StandingsGroup[] = [];
  for (const item of raw) {
    const group = standingsGroup(item);
    if (!group) return undefined;
    groups.push(group);
  }
  // The teams the question names; else the groups it names; else everything.
  const teamNamed = groups.some((g) => g.rows.some((r) => names(question, r.team)));
  const groupNamed = groups.filter((g) => namesGroup(question, g.label));
  const title = `${league.toUpperCase()} standings${requested === undefined ? "" : `, season ${requested}`}`;
  return groups
    .map((g) => ({ label: g.label, rows: teamNamed ? g.rows.filter((r) => names(question, r.team)) : groupNamed.length > 0 && !groupNamed.includes(g) ? [] : g.rows }))
    .filter((g) => g.rows.length > 0)
    .map((g) => [`${title}, ${g.label}:`, ...g.rows.map((r) => r.line)].join("\n"));
}

/** The games of the teams the question names, or every game when it names none. */
function asked(question: string, games: ScoreboardGame[]): ScoreboardGame[] {
  const named = games.filter((g) => g.teams.some((team) => names(question, team)));
  return named.length > 0 ? named : games;
}

/** The answer written from `results`, or undefined when any of them cannot be rendered. */
export function dataAnswer(question: string, results: readonly ReadResult[], now = new Date()): string | undefined {
  if (results.length === 0) return undefined;
  const blocks: string[] = [];
  for (const result of results) {
    if (result.isError) return undefined;
    const standings = STANDINGS_TOOL.exec(result.toolName)?.[1];
    if (standings) {
      const tables = standingsBlocks(standings, result.input, result.output, question);
      if (!tables) return undefined;
      blocks.push(...tables);
      continue;
    }
    const league = SCOREBOARD_TOOL.exec(result.toolName)?.[1];
    if (!league) return undefined;
    const requested = isRow(result.input) ? result.input.date : undefined;
    const date = requested === undefined ? scoreboardDate(now) : typeof requested === "string" && ISO_DATE.test(requested) ? requested : undefined;
    const slate = date === undefined ? undefined : scoreboardGames(league, date, result.output);
    if (!slate) return undefined;
    blocks.push([slate.header, ...asked(question, slate.games).map((g) => `- ${g.line}`)].join("\n"));
  }
  return [...new Set(blocks)].join("\n\n");
}
