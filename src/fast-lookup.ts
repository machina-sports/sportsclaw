/**
 * Fixed-text answer for an exact single-league scoreboard lookup.
 *
 * Pure date projection and rendering over a native `<skill>_get_scoreboard`
 * payload ({status:true, data:{events:[...]}}). Every row must validate and
 * fall on the requested day, or the whole answer is undefined and the caller
 * takes the normal answer path: an empty, partial or unknown slate is never
 * presented as "no games", and an upcoming 0-0 is never shown as a score.
 */

/** ponytail: one fixed league-day zone; per-league zones if a non-US league needs them. */
const TIME_ZONE = "America/Los_Angeles";

const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const timeFormat = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit", timeZoneName: "short" });
const headerFormat = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, weekday: "short", month: "short", day: "numeric" });

const FINAL = new Set(["final", "post", "closed", "complete", "completed"]);
const LIVE = new Set(["in_progress", "live", "halftime"]);
const UPCOMING = new Set(["not_started", "scheduled", "pre"]);
/** Plain names and details only: no URL, query string or markup reaches unchecked text. */
const SAFE_NAME = /^[\p{L}\p{N} .'&()-]{1,60}$/u;
const SAFE_DETAIL = /^[\p{L}\p{N} .:'-]{1,40}$/u;
const SCORE = /^\d{1,3}$/;
const MAX_EVENTS = 50;

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);

/** Today's league day as YYYY-MM-DD. */
export function scoreboardDate(now = new Date()): string {
  return dayFormat.format(now);
}

function side(competitors: unknown[], homeAway: string): { name: string; score?: string } | undefined {
  const matches = competitors.filter((c) => isRow(c) && c.home_away === homeAway) as Row[];
  if (matches.length !== 1) return undefined;
  const name = isRow(matches[0].team) ? matches[0].team.name : undefined;
  if (typeof name !== "string" || !SAFE_NAME.test(name)) return undefined;
  const raw = typeof matches[0].score === "number" ? String(matches[0].score) : matches[0].score;
  return { name, ...(typeof raw === "string" && SCORE.test(raw) ? { score: raw } : {}) };
}

function renderEvent(event: unknown, date: string): string | undefined {
  if (!isRow(event) || typeof event.status !== "string" || typeof event.start_time !== "string") return undefined;
  const start = new Date(event.start_time);
  if (Number.isNaN(start.getTime()) || dayFormat.format(start) !== date) return undefined;
  if (!Array.isArray(event.competitors) || event.competitors.length !== 2) return undefined;
  const home = side(event.competitors, "home");
  const away = side(event.competitors, "away");
  if (!home || !away) return undefined;
  if (UPCOMING.has(event.status)) return `${away.name} at ${home.name}, ${timeFormat.format(start)}`;
  if (home.score === undefined || away.score === undefined) return undefined;
  const result = `${away.name} ${away.score}, ${home.name} ${home.score}`;
  if (FINAL.has(event.status)) return `${result} (final)`;
  if (LIVE.has(event.status) && typeof event.status_detail === "string" && SAFE_DETAIL.test(event.status_detail)) {
    return `${result} (${event.status_detail})`;
  }
  return undefined;
}

/** The whole slate for `date`, or undefined when any part cannot be validated. */
export function renderScoreboard(league: string, date: string, content: string): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRow(payload) || payload.status !== true || !isRow(payload.data)) return undefined;
  const events = payload.data.events;
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS) return undefined;
  const lines: string[] = [];
  for (const event of events) {
    const line = renderEvent(event, date);
    if (line === undefined) return undefined;
    lines.push(`- ${line}`);
  }
  // Noon UTC is the same calendar day in the league zone.
  return [`${league.toUpperCase()}, ${headerFormat.format(new Date(`${date}T12:00:00Z`))}:`, ...lines].join("\n");
}
