/**
 * sportsclaw — Shared Button Strategy
 *
 * Sport-aware contextual buttons for Discord and Telegram.
 * Detects the sport from prompt + response, then provides
 * appropriate follow-up actions and generic prompts that let
 * the engine route to the right tools.
 *
 * Buttons are conditionally rendered: actions like "Match Stats"
 * or "Lineup" only appear when the detected league is verified
 * as fully supported by our data fetchers. Unsupported leagues
 * (e.g. Brazilian Paulista, lower-tier domestic cups) get a
 * reduced button set to avoid dead-end interactions.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DetectedSport =
  | "nba" | "nfl" | "mlb" | "nhl" | "wnba" | "cbb" | "cfb"
  | "football" | "tennis" | "golf" | "f1"
  | null;

export type DetectedLeague = string | null;

export interface ButtonDef {
  /** Unique action ID used in customId / callback_data */
  action: string;
  /** Display label (with optional emoji) */
  label: string;
}

// ---------------------------------------------------------------------------
// Sport detection
// ---------------------------------------------------------------------------

const SPORT_PATTERNS: [DetectedSport, RegExp][] = [
  // Football/Soccer — broad league and keyword coverage
  ["football", /\b(premier league|la liga|bundesliga|serie a(?! brazil)|ligue 1|mls|champions league|europa league|world cup|eredivisie|primeira liga|campeonato brasileiro|libertadores|copa am[eé]rica|fa cup|carabao|efl|soccer|f[uú]tbol|futebol|transfermarkt|fbref|corinthians|flamengo|palmeiras|cruzeiro|s[aã]o paulo|internacional|gr[eê]mio|botafogo|vasco|atletico mineiro|atl[eé]tico|santos|bahia|fortaleza|bragantino|cuiab[aá]|juventude|cear[aá]|sport recife|goi[aá]s|coritiba|am[eé]rica mineiro|arsenal|chelsea|liverpool|manchester|man city|man utd|tottenham|spurs|newcastle|aston villa|west ham|everton|brighton|wolves|bournemouth|nottingham|crystal palace|fulham|brentford|burnley|sheffield|luton|barcelona|real madrid|atletico madrid|sevilla|villarreal|betis|sociedad|athletic bilbao|valencia|bayern|dortmund|leverkusen|leipzig|juventus|milan|inter|napoli|roma|lazio|fiorentina|atalanta|psg|marseille|lyon|monaco|lille)\b/i],
  // NBA
  ["nba", /\b(nba|lakers|celtics|warriors|suns|nuggets|bucks|heat|knicks|76ers|sixers|nets|clippers|cavaliers|cavs|bulls|mavericks|mavs|spurs|pistons|rockets|thunder|timberwolves|wolves|blazers|trail ?blazers|raptors|pacers|hawks|hornets|magic|wizards|grizzlies|pelicans|kings)\b/i],
  // NFL
  ["nfl", /\b(nfl|chiefs|eagles|cowboys|49ers|niners|packers|ravens|bills|bengals|dolphins|lions|vikings|chargers|texans|jaguars|steelers|broncos|seahawks|rams|bears|falcons|saints|panthers|commanders|giants|jets|colts|titans|browns|raiders|cardinals|buccaneers|bucs|super ?bowl|touchdown)\b/i],
  // MLB
  ["mlb", /\b(mlb|yankees|dodgers|astros|braves|mets|phillies|padres|cubs|white sox|red sox|mariners|guardians|orioles|twins|rangers|rays|blue jays|diamondbacks|d-?backs|brewers|reds|pirates|royals|tigers|athletics|rockies|nationals|marlins|angels|baseball|world series)\b/i],
  // NHL
  ["nhl", /\b(nhl|avalanche|bruins|canadiens|habs|canucks|capitals|hurricanes|canes|blackhawks|blue jackets|coyotes|devils|ducks|flames|flyers|golden knights|islanders|kraken|lightning|maple leafs|oilers|penguins|predators|sabres|senators|sharks|stars|wild|hockey|stanley cup)\b/i],
  // WNBA
  ["wnba", /\b(wnba|liberty|aces|storm|lynx|mercury|mystics|fever|sparks|sun|sky|wings|dream|valkyries)\b/i],
  // College Football
  ["cfb", /\b(college football|cfb|ncaa football|cfp|heisman|sec championship|big ten championship)\b/i],
  // College Basketball
  ["cbb", /\b(college basketball|cbb|ncaa basketball|march madness|final four|sweet sixteen|elite eight)\b/i],
  // Tennis
  ["tennis", /\b(tennis|atp|wta|wimbledon|french open|roland garros|australian open|us open(?! golf)|grand slam(?! golf)|djokovic|nadal|federer|alcaraz|sinner|sabalenka|swiatek|gauff)\b/i],
  // Golf
  ["golf", /\b(golf|pga tour|lpga|masters tournament|the masters|the open championship|us open golf|pga championship|ryder cup|tour championship|dp world tour)\b/i],
  // F1
  ["f1", /\b(formula ?1|formula ?one|\bf1\b|grand prix|verstappen|hamilton|leclerc|norris|sainz|perez|red bull racing|ferrari f1|mclaren|mercedes f1)\b/i],
];

/**
 * Detect the sport from the user prompt and engine response.
 * Returns the first confident match, or null for ambiguous / non-sport content.
 */
export function detectSport(response: string, prompt: string): DetectedSport {
  const combined = `${prompt} ${response}`;
  for (const [sport, pattern] of SPORT_PATTERNS) {
    if (pattern.test(combined)) return sport;
  }
  return null;
}

// ---------------------------------------------------------------------------
// League detection — identifies specific football/soccer league
// ---------------------------------------------------------------------------

const LEAGUE_PATTERNS: [string, RegExp][] = [
  // Top-tier European leagues (full data support)
  ["eng.1", /\b(premier league|epl)\b/i],
  ["esp.1", /\b(la liga|laliga)\b/i],
  ["ger.1", /\b(bundesliga)\b/i],
  ["ita.1", /\b(serie a(?!\s*brazil))\b/i],
  ["fra.1", /\b(ligue 1)\b/i],
  ["usa.1", /\b(mls|major league soccer)\b/i],
  ["uefa.champions", /\b(champions league|ucl)\b/i],
  ["uefa.europa", /\b(europa league|uel)\b/i],
  ["ned.1", /\b(eredivisie)\b/i],
  ["por.1", /\b(primeira liga|liga portugal)\b/i],
  // English lower tiers
  ["eng.2", /\b(championship|efl championship)\b/i],
  ["eng.fa", /\b(fa cup)\b/i],
  ["eng.league_cup", /\b(carabao|league cup|efl cup)\b/i],
  // International
  ["fifa.world", /\b(world cup|fifa world)\b/i],
  ["conmebol.libertadores", /\b(libertadores|copa libertadores)\b/i],
  ["conmebol.copa", /\b(copa am[eé]rica)\b/i],
  // Brazilian leagues (limited data — stats/lineup often missing)
  ["bra.1", /\b(campeonato brasileiro|brasileir[aã]o|s[eé]rie a brazil)\b/i],
  ["bra.paulista", /\b(paulista|paulist[aã]o|campeonato paulista)\b/i],
  ["bra.carioca", /\b(carioca|campeonato carioca)\b/i],
  ["bra.mineiro", /\b(mineiro|campeonato mineiro)\b/i],
  ["bra.gaucho", /\b(ga[uú]cho|campeonato ga[uú]cho)\b/i],
  // Brazilian clubs (may be in any of the above leagues)
  ["bra._club", /\b(corinthians|flamengo|palmeiras|cruzeiro|s[aã]o paulo|internacional|gr[eê]mio|botafogo|vasco|atletico mineiro|santos|bahia|fortaleza|bragantino|cuiab[aá]|juventude|cear[aá]|sport recife|goi[aá]s|coritiba|am[eé]rica mineiro)\b/i],
];

/**
 * Detect the specific football/soccer league from the combined text.
 * Returns a league code (e.g. "eng.1", "bra.paulista") or null.
 */
export function detectLeague(response: string, prompt: string): DetectedLeague {
  const combined = `${prompt} ${response}`;
  for (const [league, pattern] of LEAGUE_PATTERNS) {
    if (pattern.test(combined)) return league;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Supported leagues — which actions are available per league
// ---------------------------------------------------------------------------

/**
 * Leagues with verified full data support (matchstats + lineup + standings).
 * If a football league is NOT in this set, only "standings" is safe to show.
 */
const FULLY_SUPPORTED_FOOTBALL_LEAGUES = new Set([
  "eng.1", "esp.1", "ger.1", "ita.1", "fra.1",
  "usa.1",
  "uefa.champions", "uefa.europa",
  "ned.1", "por.1",
  "eng.2", "eng.fa", "eng.league_cup",
  "fifa.world",
]);

/**
 * Leagues where standings are available but match-level stats are unreliable.
 * These get a reduced button set (standings only, no matchstats/lineup).
 */
const STANDINGS_ONLY_FOOTBALL_LEAGUES = new Set([
  "bra.1",
  "conmebol.libertadores", "conmebol.copa",
]);

/** Football buttons for leagues with full data */
const FOOTBALL_FULL_BUTTONS: ButtonDef[] = [
  { action: "matchstats", label: "📊 Match Stats" },
  { action: "lineup", label: "📋 Lineup" },
  { action: "standings", label: "🏆 Standings" },
];

/** Football buttons for leagues with only standings */
const FOOTBALL_STANDINGS_BUTTONS: ButtonDef[] = [
  { action: "standings", label: "🏆 Standings" },
];

// ---------------------------------------------------------------------------
// Button definitions per sport category
// ---------------------------------------------------------------------------

/** ESPN live-game sports: NBA, NFL, MLB, NHL, WNBA, CBB, CFB */
const ESPN_BUTTONS: ButtonDef[] = [
  { action: "boxscore", label: "📊 Box Score" },
  { action: "pbp", label: "📋 Play-by-Play" },
  { action: "stats", label: "📈 Full Stats" },
];

/** Tennis */
const TENNIS_BUTTONS: ButtonDef[] = [
  { action: "tennisstats", label: "📊 Match Stats" },
  { action: "rankings", label: "🏆 Rankings" },
];

/** Golf */
const GOLF_BUTTONS: ButtonDef[] = [
  { action: "leaderboard", label: "📊 Leaderboard" },
  { action: "scorecard", label: "📋 Scorecard" },
];

/** Formula 1 */
const F1_BUTTONS: ButtonDef[] = [
  { action: "raceresults", label: "🏁 Race Results" },
  { action: "driverstandings", label: "🏆 Standings" },
  { action: "laptimes", label: "⏱ Lap Times" },
];

/** Generic fallback — works for any sport not explicitly mapped */
const GENERIC_BUTTONS: ButtonDef[] = [
  { action: "details", label: "📊 More Details" },
  { action: "stats", label: "📈 Full Stats" },
];

const ESPN_SPORTS = new Set<DetectedSport>(["nba", "nfl", "mlb", "nhl", "wnba", "cbb", "cfb"]);

/**
 * Get buttons for a sport (ignores league support level).
 * Kept for backward compatibility — prefer `getFilteredButtons()`.
 */
export function getButtons(sport: DetectedSport): ButtonDef[] {
  if (!sport) return GENERIC_BUTTONS;
  if (ESPN_SPORTS.has(sport)) return ESPN_BUTTONS;
  if (sport === "football") return FOOTBALL_FULL_BUTTONS;
  if (sport === "tennis") return TENNIS_BUTTONS;
  if (sport === "golf") return GOLF_BUTTONS;
  if (sport === "f1") return F1_BUTTONS;
  return GENERIC_BUTTONS;
}

/**
 * Get buttons conditionally filtered by sport AND league data availability.
 *
 * For football/soccer, the detected league determines which buttons are safe:
 *   - Fully supported leagues → Match Stats + Lineup + Standings
 *   - Standings-only leagues → Standings only
 *   - Unknown/regional leagues (e.g. Paulista) → no buttons (returns [])
 *
 * For all other sports, delegates to `getButtons()` (no league filtering needed).
 */
export function getFilteredButtons(
  sport: DetectedSport,
  league: DetectedLeague
): ButtonDef[] {
  if (sport !== "football") return getButtons(sport);

  // Football with a known fully-supported league → all buttons
  if (league && FULLY_SUPPORTED_FOOTBALL_LEAGUES.has(league)) {
    return FOOTBALL_FULL_BUTTONS;
  }

  // Football with standings-only support → just standings
  if (league && STANDINGS_ONLY_FOOTBALL_LEAGUES.has(league)) {
    return FOOTBALL_STANDINGS_BUTTONS;
  }

  // Brazilian club detected but no specific league → conservative (standings only)
  if (league === "bra._club") {
    return FOOTBALL_STANDINGS_BUTTONS;
  }

  // Unknown league (e.g. Paulista, Carioca, regional cup) → no data buttons
  if (league) {
    return [];
  }

  // Football detected but no specific league → default full set
  return FOOTBALL_FULL_BUTTONS;
}

// ---------------------------------------------------------------------------
// Follow-up prompts — generic, no hardcoded tool names
// ---------------------------------------------------------------------------

const FOLLOW_UP_PROMPTS: Record<string, (prompt: string) => string> = {
  // ESPN live-game actions
  boxscore: (p) =>
    `Show the detailed box score with all player stats for the game mentioned in: ${p}`,
  pbp: (p) =>
    `Show the play-by-play events (key moments, scoring plays, substitutions) for the game in: ${p}`,
  stats: (p) =>
    `Show comprehensive team and player statistics for: ${p}`,

  // Football/Soccer actions
  matchstats: (p) =>
    `Show detailed match statistics including possession, shots, xG, passing accuracy, and fouls for: ${p}`,
  lineup: (p) =>
    `Show the starting lineup and formation for both teams for: ${p}`,
  standings: (p) =>
    `Show the current league standings and table relevant to: ${p}`,

  // Tennis actions
  tennisstats: (p) =>
    `Show detailed match statistics including aces, double faults, break points, winners, unforced errors, and serve percentages for: ${p}`,
  rankings: (p) =>
    `Show the current ATP or WTA rankings relevant to: ${p}`,

  // Golf actions
  leaderboard: (p) =>
    `Show the tournament leaderboard for: ${p}`,
  scorecard: (p) =>
    `Show the detailed scorecard for: ${p}`,

  // F1 actions
  raceresults: (p) =>
    `Show the race results and finishing order for: ${p}`,
  driverstandings: (p) =>
    `Show the current Formula 1 driver and constructor championship standings relevant to: ${p}`,
  laptimes: (p) =>
    `Show lap times, sector times, and pit stop data for: ${p}`,

  // Generic fallback actions
  details: (p) =>
    `Show more detailed information and a breakdown for: ${p}`,
};

/**
 * Build the follow-up prompt for a button action.
 * Returns null if the action is unknown.
 */
export function getFollowUpPrompt(
  action: string,
  _sport: DetectedSport,
  originalPrompt: string
): string | null {
  const builder = FOLLOW_UP_PROMPTS[action];
  return builder ? builder(originalPrompt) : null;
}
