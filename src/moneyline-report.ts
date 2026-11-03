/**
 * Code-owned moneyline report — a closed data input, pure pricing math and an
 * escaped, self-contained HTML renderer for one single-venue moneyline report.
 *
 * The model supplies only data (games → outcomes). Code owns the title, every
 * label and explanatory sentence, the layout and all arithmetic; the engine
 * scope owns the venue, language and generated-at label, so identical input
 * renders byte-identically and the clock is never read.
 *
 * Parsed values are UNVERIFIED data: a valid schema is not grounding. The
 * rendered document must still pass the existing factual check against real
 * sources before anything is published. This module never marks a report
 * verified, never stores, publishes or talks to the network.
 *
 * Only a type is imported from artifact-output so the collector can import
 * this module without a runtime cycle; the wire parser stays the single
 * validator of the produced artifact-v1.
 */

import type { ArtifactOutput } from "./artifact-output.js";

// Mirrors of artifact-output constants (kept literal to avoid a runtime import cycle).
const ARTIFACT_CONTRACT = "artifact-v1" as const;
const ARTIFACT_MIME_TYPE = "text/html" as const;
const MAX_ARTIFACT_HTML_BYTES = 262_144;

export const MONEYLINE_MAX_GAMES = 32;
export const MONEYLINE_MIN_OUTCOMES = 2;
export const MONEYLINE_MAX_OUTCOMES = 3;
export const MONEYLINE_MAX_EVENT_CHARS = 120;
export const MONEYLINE_MAX_NAME_CHARS = 64;
export const MONEYLINE_STATUSES = ["upcoming", "live", "finished"] as const;
export const MONEYLINE_LANGUAGES = ["en", "pt", "es"] as const;
/** Fraction-priced contract venues only; American-odds venues keep the generic report path. */
export const MONEYLINE_VENUES = ["polymarket", "kalshi"] as const;

const MAX_AMERICAN_ODDS = 100_000;
const MAX_RECORD_COUNT = 10_000;
const MAX_POINTS_PER_GAME = 1_000;
const MAX_SCOPE_SPORTS = 3;
const MAX_SCOPE_SPORT_CHARS = 40;
const MAX_TIME_SCOPE_CHARS = 120;

export type MoneylineStatus = (typeof MONEYLINE_STATUSES)[number];
export type MoneylineLanguage = (typeof MONEYLINE_LANGUAGES)[number];
export type MoneylineVenue = (typeof MONEYLINE_VENUES)[number];

export interface MoneylineRecord {
  wins: number;
  losses: number;
  draws?: number;
}

export interface MoneylineOutcome {
  name: string;
  /** Venue market price as a fraction 0..1 (a price, never a true probability). */
  price: number;
  /** Supplied American odds (no provenance asserted); finite, |odds| >= 100. */
  americanOdds?: number;
  record?: MoneylineRecord;
  pointsForPerGame?: number;
  pointsAgainstPerGame?: number;
}

export interface MoneylineGame {
  event: string;
  status: MoneylineStatus;
  outcomes: MoneylineOutcome[];
  /** Index of a qualitative lean; never on a finished game. */
  pick?: number;
}

export interface MoneylineReport {
  games: MoneylineGame[];
}

/** Supplied by the engine from the trusted task brief, never by the model. */
export interface MoneylineScope {
  venue: MoneylineVenue;
  sports: string[];
  timeScope: string;
  language: MoneylineLanguage;
  /** Per-run stable UTC timestamp, e.g. 2026-11-02T18:00:00.000Z. */
  generatedAt: string;
}

export interface BookmakerBenchmark {
  /** Raw implied probability per outcome of the supplied American odds. */
  raw: number[];
  /** Sum of implied probabilities of the supplied set. */
  total: number;
  /** Proportional odds benchmark: the supplied set normalized to sum to 1 (not a true win probability). */
  normalized: number[];
}

// ---------------------------------------------------------------------------
// Pure pricing math
// ---------------------------------------------------------------------------

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const isAmericanOdds = (value: unknown): value is number =>
  isFiniteNumber(value) && Math.abs(value) >= 100 && Math.abs(value) <= MAX_AMERICAN_ODDS;

/** Raw implied probability of American odds, or null. No coercion. */
export function impliedFromAmerican(odds: unknown): number | null {
  if (!isAmericanOdds(odds)) return null;
  return odds < 0 ? -odds / (-odds + 100) : 100 / (odds + 100);
}

/** Raw, total and proportional benchmark of a COMPLETE odds set (2..3 outcomes), or null. */
export function bookmakerBenchmark(odds: unknown): BookmakerBenchmark | null {
  if (!Array.isArray(odds) || odds.length < MONEYLINE_MIN_OUTCOMES || odds.length > MONEYLINE_MAX_OUTCOMES) return null;
  const raw: number[] = [];
  for (const value of Array.from(odds)) {
    const implied = impliedFromAmerican(value);
    if (implied === null) return null;
    raw.push(implied);
  }
  const total = raw.reduce((sum, p) => sum + p, 0);
  if (!(total > 0)) return null;
  return { raw, total, normalized: raw.map((p) => p / total) };
}

// ---------------------------------------------------------------------------
// Closed data parser: exact keys, exact types, fresh copies, never throws
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The object when it has every required key and nothing outside required ∪ optional. */
function keyed(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  if (!required.every((key) => Object.hasOwn(value, key))) return null;
  return Object.keys(value).every((key) => required.includes(key) || optional.includes(key)) ? value : null;
}

const isLabel = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !CONTROL.test(value) && !LONE_SURROGATE.test(value);

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_RECORD_COUNT;

const isPerGame = (value: unknown): value is number => isFiniteNumber(value) && value >= 0 && value <= MAX_POINTS_PER_GAME;

function parseRecord(value: unknown): MoneylineRecord | null {
  const raw = keyed(value, ["wins", "losses"], ["draws"]);
  if (!raw || !isCount(raw.wins) || !isCount(raw.losses)) return null;
  const record: MoneylineRecord = { wins: raw.wins, losses: raw.losses };
  if (Object.hasOwn(raw, "draws")) {
    if (!isCount(raw.draws)) return null;
    record.draws = raw.draws;
  }
  return record;
}

function parseOutcome(value: unknown): MoneylineOutcome | null {
  const raw = keyed(value, ["name", "price"], ["americanOdds", "record", "pointsForPerGame", "pointsAgainstPerGame"]);
  if (!raw || !isLabel(raw.name, MONEYLINE_MAX_NAME_CHARS)) return null;
  if (!isFiniteNumber(raw.price) || raw.price < 0 || raw.price > 1) return null;
  const outcome: MoneylineOutcome = { name: raw.name, price: raw.price };
  if (Object.hasOwn(raw, "americanOdds")) {
    if (!isAmericanOdds(raw.americanOdds)) return null;
    outcome.americanOdds = raw.americanOdds;
  }
  if (Object.hasOwn(raw, "record")) {
    const record = parseRecord(raw.record);
    if (!record) return null;
    outcome.record = record;
  }
  for (const key of ["pointsForPerGame", "pointsAgainstPerGame"] as const) {
    if (!Object.hasOwn(raw, key)) continue;
    const n = raw[key];
    if (!isPerGame(n)) return null;
    outcome[key] = n;
  }
  return outcome;
}

const nameKey = (name: string) => name.normalize("NFC").trim().toLowerCase();

function parseGame(value: unknown): MoneylineGame | null {
  const raw = keyed(value, ["event", "status", "outcomes"], ["pick"]);
  if (!raw || !isLabel(raw.event, MONEYLINE_MAX_EVENT_CHARS)) return null;
  if (typeof raw.status !== "string" || !(MONEYLINE_STATUSES as readonly string[]).includes(raw.status)) return null;
  if (!Array.isArray(raw.outcomes) || raw.outcomes.length < MONEYLINE_MIN_OUTCOMES || raw.outcomes.length > MONEYLINE_MAX_OUTCOMES) return null;
  const outcomes: MoneylineOutcome[] = [];
  for (const item of Array.from(raw.outcomes)) {
    const outcome = parseOutcome(item);
    if (!outcome) return null;
    outcomes.push(outcome);
  }
  if (new Set(outcomes.map((o) => nameKey(o.name))).size !== outcomes.length) return null;
  const game: MoneylineGame = { event: raw.event, status: raw.status as MoneylineStatus, outcomes };
  if (Object.hasOwn(raw, "pick")) {
    const pick = raw.pick;
    if (typeof pick !== "number" || !Number.isInteger(pick) || pick < 0 || pick >= outcomes.length) return null;
    // A finished game cannot carry a lean.
    if (game.status === "finished") return null;
    game.pick = pick;
  }
  return game;
}

/** The validated closed report as a fresh copy, or null. Never repairs, trims, coerces or throws. */
export function parseMoneylineReport(value: unknown): MoneylineReport | null {
  try {
    const raw = keyed(value, ["games"]);
    if (!raw || !Array.isArray(raw.games) || raw.games.length < 1 || raw.games.length > MONEYLINE_MAX_GAMES) return null;
    const games: MoneylineGame[] = [];
    for (const item of Array.from(raw.games)) {
      const game = parseGame(item);
      if (!game) return null;
      games.push(game);
    }
    return { games };
  } catch {
    return null;
  }
}

const GENERATED_AT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?Z$/;

/** The validated engine scope as a fresh copy, or null. */
export function parseMoneylineScope(value: unknown): MoneylineScope | null {
  try {
    const raw = keyed(value, ["venue", "sports", "timeScope", "language", "generatedAt"]);
    if (!raw) return null;
    if (typeof raw.venue !== "string" || !(MONEYLINE_VENUES as readonly string[]).includes(raw.venue)) return null;
    if (typeof raw.language !== "string" || !(MONEYLINE_LANGUAGES as readonly string[]).includes(raw.language)) return null;
    if (!Array.isArray(raw.sports) || raw.sports.length > MAX_SCOPE_SPORTS) return null;
    const sports = Array.from(raw.sports);
    if (!sports.every((s) => isLabel(s, MAX_SCOPE_SPORT_CHARS))) return null;
    const { timeScope, generatedAt } = raw;
    if (typeof timeScope !== "string" || timeScope.length > MAX_TIME_SCOPE_CHARS || CONTROL.test(timeScope) || LONE_SURROGATE.test(timeScope)) return null;
    if (typeof generatedAt !== "string") return null;
    const m = GENERATED_AT.exec(generatedAt);
    if (!m) return null;
    const [month, day, hour, minute, second] = [m[2], m[3], m[4], m[5], m[6] ?? "0"].map(Number);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
    return {
      venue: raw.venue as MoneylineVenue,
      sports: sports as string[],
      timeScope,
      language: raw.language as MoneylineLanguage,
      generatedAt,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Model-facing data schema (for the submit_artifact collector)
// ---------------------------------------------------------------------------

const OUTCOME_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "price"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: MONEYLINE_MAX_NAME_CHARS, description: "Outcome label exactly as in the source, plain text." },
    price: { type: "number", minimum: 0, maximum: 1, description: "Venue market price as a fraction 0..1, exactly as obtained." },
    americanOdds: { type: "number", description: "Optional American odds exactly as obtained; absolute value at least 100." },
    record: {
      type: "object",
      additionalProperties: false,
      required: ["wins", "losses"],
      properties: {
        wins: { type: "integer", minimum: 0, maximum: MAX_RECORD_COUNT },
        losses: { type: "integer", minimum: 0, maximum: MAX_RECORD_COUNT },
        draws: { type: "integer", minimum: 0, maximum: MAX_RECORD_COUNT },
      },
    },
    pointsForPerGame: { type: "number", minimum: 0, maximum: MAX_POINTS_PER_GAME },
    pointsAgainstPerGame: { type: "number", minimum: 0, maximum: MAX_POINTS_PER_GAME },
  },
} as const;

/** Closed JSON schema offered in place of title/html. Code renders the document. */
export const MONEYLINE_REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["games"],
  properties: {
    games: {
      type: "array",
      minItems: 1,
      maxItems: MONEYLINE_MAX_GAMES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["event", "status", "outcomes"],
        properties: {
          event: { type: "string", minLength: 1, maxLength: MONEYLINE_MAX_EVENT_CHARS, description: "Event label, plain text." },
          status: { type: "string", enum: [...MONEYLINE_STATUSES] },
          outcomes: { type: "array", minItems: MONEYLINE_MIN_OUTCOMES, maxItems: MONEYLINE_MAX_OUTCOMES, items: OUTCOME_SCHEMA },
          pick: { type: "integer", minimum: 0, maximum: MONEYLINE_MAX_OUTCOMES - 1, description: "Optional index of a qualitative lean; never on a finished game." },
        },
      },
    },
  },
} as const;

export const MONEYLINE_TOOL_DESCRIPTION =
  "Submit ONE moneyline report as data only: games with their outcomes, venue prices (fractions 0..1), optional " +
  "American odds, records and per-game points exactly as obtained in this conversation. Code writes the " +
  "title, labels, explanations and all arithmetic; send no HTML, prose, analysis or derived numbers. Submit once; a " +
  "different second submission invalidates the turn. This publishes nothing and returns no link.";

// ---------------------------------------------------------------------------
// Code-owned renderer
// ---------------------------------------------------------------------------

const VENUE_LABELS: Record<MoneylineVenue, string> = { polymarket: "Polymarket", kalshi: "Kalshi" };

interface Labels {
  title: string;
  generated: string;
  timeScope: string;
  games: string;
  benchmarks: string;
  outcome: string;
  status: Record<MoneylineStatus, string>;
  record: string;
  perGame: string;
  marketPrice: string;
  americanOdds: string;
  rawImplied: string;
  benchmark: string;
  difference: string;
  rawTotal: string;
  noBenchmark: string;
  lean: string;
  chart: string;
  pp: string;
  notesTitle: string;
  notes: string[];
  statsNote: string;
}

const LABELS: Record<MoneylineLanguage, Labels> = {
  en: {
    title: "Moneyline report",
    generated: "Generated",
    timeScope: "Time scope",
    games: "Games",
    benchmarks: "Complete supplied odds sets",
    outcome: "Outcome",
    status: { upcoming: "Upcoming", live: "Live", finished: "Finished" },
    record: "Record",
    perGame: "Points per game (for / against)",
    marketPrice: "Market-implied price",
    americanOdds: "Supplied American odds",
    rawImplied: "Raw implied (supplied odds)",
    benchmark: "Proportional odds benchmark",
    difference: "Benchmark difference",
    rawTotal: "Sum of raw implied probabilities (supplied odds)",
    noBenchmark: "Supplied American odds are incomplete for this game, so no benchmark is shown.",
    lean: "Lean (qualitative)",
    chart: "Market-implied price vs proportional odds benchmark",
    pp: "pp",
    notesTitle: "How to read this report",
    notes: [
      "Market-implied price is the venue price in cents read as a percentage. It is a market price, not a true outcome probability.",
      "Raw implied values are computed from the supplied American odds; their sum can exceed 100%.",
      "The proportional odds benchmark divides each raw implied value by the sum of implied probabilities. It only normalizes the supplied odds set: it does not establish a common source or an independent win probability.",
      "Benchmark difference is the market-implied price minus the benchmark, in percentage points. A positive value means the market price sits above the benchmark; it does not demonstrate a profitable bet.",
      "No independent win-probability model, fees or slippage justification was supplied.",
      "A lean is a qualitative preference only, not demonstrated mispricing.",
      "All values are inputs from this conversation and still require source verification.",
    ],
    statsNote: "Records and points per game are reported figures, not per-100-possession ratings.",
  },
  pt: {
    title: "Relatório de moneyline",
    generated: "Gerado em",
    timeScope: "Período",
    games: "Jogos",
    benchmarks: "Conjuntos completos de odds fornecidas",
    outcome: "Resultado",
    status: { upcoming: "Próximo", live: "Ao vivo", finished: "Encerrado" },
    record: "Campanha",
    perGame: "Pontos por jogo (pró / contra)",
    marketPrice: "Preço implícito de mercado",
    americanOdds: "Odds americanas fornecidas",
    rawImplied: "Implícita bruta (odds fornecidas)",
    benchmark: "Referência proporcional das odds",
    difference: "Diferença para a referência",
    rawTotal: "Soma das probabilidades implícitas brutas (odds fornecidas)",
    noBenchmark: "As odds americanas fornecidas estão incompletas neste jogo; nenhuma referência é exibida.",
    lean: "Inclinação (qualitativa)",
    chart: "Preço implícito de mercado vs referência proporcional das odds",
    pp: "p.p.",
    notesTitle: "Como ler este relatório",
    notes: [
      "O preço implícito de mercado é o preço da plataforma em centavos lido como porcentagem. É um preço de mercado, não uma probabilidade real do resultado.",
      "Os valores implícitos brutos são calculados a partir das odds americanas fornecidas; sua soma pode passar de 100%.",
      "A referência proporcional divide cada valor bruto pela soma das probabilidades implícitas. Apenas normaliza o conjunto de odds fornecido: não mostra que as odds têm a mesma origem nem que formam uma referência comum, e não é uma probabilidade independente de vitória.",
      "A diferença é o preço implícito de mercado menos a referência, em pontos percentuais. Um valor positivo indica preço acima da referência; não demonstra aposta lucrativa.",
      "Nenhum modelo independente de probabilidade de vitória, taxas ou slippage foi fornecido.",
      "Uma inclinação é apenas uma preferência qualitativa, não um erro de preço demonstrado.",
      "Todos os valores são entradas desta conversa e ainda exigem verificação nas fontes.",
    ],
    statsNote: "Campanhas e pontos por jogo são números informados, não índices por 100 posses.",
  },
  es: {
    title: "Informe de moneyline",
    generated: "Generado",
    timeScope: "Período",
    games: "Partidos",
    benchmarks: "Conjuntos completos de cuotas proporcionadas",
    outcome: "Resultado",
    status: { upcoming: "Próximo", live: "En vivo", finished: "Finalizado" },
    record: "Récord",
    perGame: "Puntos por partido (a favor / en contra)",
    marketPrice: "Precio implícito de mercado",
    americanOdds: "Cuotas americanas proporcionadas",
    rawImplied: "Implícita bruta (cuotas proporcionadas)",
    benchmark: "Referencia proporcional de las cuotas",
    difference: "Diferencia con la referencia",
    rawTotal: "Suma de probabilidades implícitas brutas (cuotas suministradas)",
    noBenchmark: "Las cuotas americanas proporcionadas están incompletas en este partido; no se muestra referencia.",
    lean: "Inclinación (cualitativa)",
    chart: "Precio implícito de mercado vs referencia proporcional de las cuotas",
    pp: "p.p.",
    notesTitle: "Cómo leer este informe",
    notes: [
      "El precio implícito de mercado es el precio de la plataforma en centavos leído como porcentaje. Es un precio de mercado, no una probabilidad real del resultado.",
      "Los valores implícitos brutos se calculan a partir de las cuotas americanas proporcionadas; su suma puede superar el 100%.",
      "La referencia proporcional divide cada valor bruto por la suma de probabilidades implícitas. Solo normaliza el conjunto de cuotas proporcionado: no muestra que las cuotas tengan el mismo origen ni que formen una referencia común, y no es una probabilidad independiente de victoria.",
      "La diferencia es el precio implícito de mercado menos la referencia, en puntos porcentuales. Un valor positivo indica precio por encima de la referencia; no demuestra una apuesta rentable.",
      "No se proporcionó ningún modelo independiente de probabilidad de victoria, comisiones ni slippage.",
      "Una inclinación es solo una preferencia cualitativa, no un error de precio demostrado.",
      "Todos los valores son entradas de esta conversación y aún requieren verificación en las fuentes.",
    ],
    statsNote: "Récords y puntos por partido son cifras informadas, no índices por 100 posesiones.",
  },
};

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const pct = (fraction: number): string => `${(fraction * 100).toFixed(1)}%`;
const cents = (fraction: number): string => `${(fraction * 100).toFixed(1)}c`;
const width = (fraction: number): string => `${Math.min(100, Math.max(0, fraction * 100)).toFixed(1)}%`;
const american = (odds: number): string => (odds > 0 ? `+${odds}` : `${odds}`);
const points = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function difference(price: number, benchmark: number, unit: string): string {
  const d = (price - benchmark) * 100;
  if (Math.abs(d) < 0.05) return `0.0 ${unit}`;
  return `${d > 0 ? "+" : "-"}${Math.abs(d).toFixed(1)} ${unit}`;
}

function recordText(record: MoneylineRecord): string {
  return record.draws === undefined ? `${record.wins}-${record.losses}` : `${record.wins}-${record.losses}-${record.draws}`;
}

const STYLE =
  "*{box-sizing:border-box}body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:1rem;" +
  "color:#1a1a1a;background:#f6f7f9;line-height:1.45}main{max-width:960px;margin:0 auto}h1{font-size:1.5rem;margin:.2rem 0}" +
  "h2{font-size:1.15rem;margin:0 0 .4rem}.meta{color:#555;font-size:.9rem}" +
  ".cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.6rem;margin:1rem 0}" +
  ".card{background:#fff;border:1px solid #dde1e6;border-radius:8px;padding:.6rem .8rem}.card b{display:block;font-size:1.3rem}" +
  "section.game{background:#fff;border:1px solid #dde1e6;border-radius:8px;padding:.8rem;margin:0 0 1rem}" +
  ".scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.9rem}" +
  "th,td{border-bottom:1px solid #e5e7eb;padding:.35rem .5rem;text-align:left;white-space:nowrap}th{background:#f1f3f5;white-space:normal}.legend{display:flex;gap:1rem;flex-wrap:wrap;font-size:.85rem;margin:.4rem 0}.legend i{display:inline-block;width:.8rem;height:.8rem;margin-right:.3rem}" +
  ".bars{margin:.6rem 0 0}.row{display:grid;grid-template-columns:minmax(80px,140px) 1fr;gap:.5rem;align-items:center;margin:.25rem 0}" +
  ".bar{background:#eef0f3;border-radius:4px;height:.7rem;overflow:hidden;margin:.1rem 0}.bar span{display:block;height:100%}" +
  ".m{background:#3b6fd8}.k{background:#9aa3ad}.note{color:#555;font-size:.85rem;margin:.4rem 0 0}" +
  ".notes{font-size:.85rem;color:#333}@media (max-width:600px){body{padding:.5rem}h1{font-size:1.25rem}}";

function renderGame(game: MoneylineGame, labels: Labels): string {
  const odds = game.outcomes.map((o) => o.americanOdds);
  const bench = odds.every((o) => o !== undefined) ? bookmakerBenchmark(odds) : null;
  const hasOdds = odds.some((o) => o !== undefined);
  const hasRecord = game.outcomes.some((o) => o.record);
  const hasPerGame = game.outcomes.some((o) => o.pointsForPerGame !== undefined || o.pointsAgainstPerGame !== undefined);

  const head = [labels.outcome];
  if (hasRecord) head.push(labels.record);
  if (hasPerGame) head.push(labels.perGame);
  head.push(labels.marketPrice);
  if (hasOdds) head.push(labels.americanOdds);
  if (bench) head.push(labels.rawImplied, labels.benchmark, labels.difference);

  const rows = game.outcomes.map((o, i) => {
    const cells = [escapeHtml(o.name)];
    if (hasRecord) cells.push(o.record ? recordText(o.record) : "—");
    if (hasPerGame) {
      const f = o.pointsForPerGame === undefined ? "—" : points(o.pointsForPerGame);
      const a = o.pointsAgainstPerGame === undefined ? "—" : points(o.pointsAgainstPerGame);
      cells.push(`${f} / ${a}`);
    }
    cells.push(`${cents(o.price)} (${pct(o.price)})`);
    if (hasOdds) cells.push(o.americanOdds === undefined ? "—" : american(o.americanOdds));
    if (bench) cells.push(pct(bench.raw[i]), pct(bench.normalized[i]), difference(o.price, bench.normalized[i], labels.pp));
    return `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
  });

  const bars = game.outcomes.map((o, i) =>
    `<div class="row"><div>${escapeHtml(o.name)}</div><div>` +
    `<div class="bar"><span class="m" style="width:${width(o.price)}"></span></div>` +
    (bench ? `<div class="bar"><span class="k" style="width:${width(bench.normalized[i])}"></span></div>` : "") +
    "</div></div>").join("");

  const notes: string[] = [];
  if (bench) notes.push(`${labels.rawTotal}: ${pct(bench.total)}`);
  else notes.push(labels.noBenchmark);
  if (game.pick !== undefined) notes.push(`${labels.lean}: ${escapeHtml(game.outcomes[game.pick].name)}`);
  if (hasRecord || hasPerGame) notes.push(labels.statsNote);

  return (
    `<section class="game"><h2>${escapeHtml(game.event)}</h2><div class="meta">${labels.status[game.status]}</div>` +
    `<div class="scroll"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead>` +
    `<tbody>${rows.join("")}</tbody></table></div>` +
    `<div class="bars" role="img" aria-label="${escapeHtml(labels.chart)}"><div class="note">${labels.chart}</div>` +
    `<div class="legend"><span data-series="market"><i class="m"></i>${labels.marketPrice}</span>` +
    (bench ? `<span data-series="benchmark"><i class="k"></i>${labels.benchmark}</span>` : "") +
    `</div>${bars}</div>` +
    notes.map((n) => `<p class="note">${n}</p>`).join("") +
    "</section>"
  );
}

/**
 * One escaped, self-contained artifact-v1 document rendered by code from a
 * report and the engine scope, or null. Re-validates both inputs. The result
 * is a candidate only: the factual check must still judge this exact document.
 */
export function renderMoneylineReport(report: unknown, scope: unknown): ArtifactOutput | null {
  const data = parseMoneylineReport(report);
  const ctx = parseMoneylineScope(scope);
  if (!data || !ctx) return null;
  const labels = LABELS[ctx.language];
  const title = `${labels.title} — ${VENUE_LABELS[ctx.venue]}`;
  const m = GENERATED_AT.exec(ctx.generatedAt)!;
  const generated = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]} UTC`;
  const complete = data.games.filter((g) => bookmakerBenchmark(g.outcomes.map((o) => o.americanOdds)) !== null).length;
  const context = [
    ctx.sports.length > 0 ? escapeHtml(ctx.sports.join(", ")) : "",
    ctx.timeScope.trim().length > 0 ? `${labels.timeScope}: ${escapeHtml(ctx.timeScope)}` : "",
  ].filter(Boolean).join(" · ");

  const html =
    `<!doctype html><html lang="${ctx.language}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>` +
    `<style>${STYLE}</style></head><body><main>` +
    `<header><h1>${escapeHtml(title)}</h1><div class="meta">${labels.generated} ${generated}${context ? ` · ${context}` : ""}</div></header>` +
    `<div class="cards"><div class="card"><b>${data.games.length}</b>${labels.games}</div>` +
    `<div class="card"><b>${complete}</b>${labels.benchmarks}</div>` +
    `<div class="card"><b>${escapeHtml(VENUE_LABELS[ctx.venue])}</b>${labels.marketPrice}</div></div>` +
    data.games.map((g) => renderGame(g, labels)).join("") +
    `<section class="notes"><h2>${labels.notesTitle}</h2><ul>${labels.notes.map((n) => `<li>${n}</li>`).join("")}</ul></section>` +
    "</main></body></html>";

  if (Buffer.byteLength(html, "utf8") > MAX_ARTIFACT_HTML_BYTES) return null;
  return { contract: ARTIFACT_CONTRACT, title, mimeType: ARTIFACT_MIME_TYPE, html };
}
