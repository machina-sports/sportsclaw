/**
 * Typed market cards — up to three prediction-market cards per turn, carried
 * beside the answer text, never inside it.
 *
 * Every value on a card is copied by code from a tool result this run really
 * received: the model never writes a price, a volume or a time. The model's
 * only part is choosing which fetched markets to show, by id, through the
 * `cite_markets` output tool. An id that was not fetched in this run is
 * refused, so a card can never describe a market the run did not read.
 *
 * `market-turn-v1` (MarketTurnInput/MarketTurnResult) is the envelope a caller
 * uses to opt one run in: a caller nonce in, and one typed result bound to
 * that nonce out. Without it the engine offers no `cite_markets` tool, records
 * nothing and behaves exactly as before.
 *
 * `readAt` is when the engine received the tool result, not a provider
 * timestamp: the venue API does not supply one in this shape. `checkedAt` on
 * the result is the same kind of time, for the latest Polymarket result the
 * run received. `none_found` is given only when a listing came back empty and
 * nothing else the run read leaves room for doubt (see `readPolymarketResult`).
 *
 * This module validates the wire and reads tool results. It never fetches,
 * stores, renders or talks to the network. Polymarket only, for now.
 */

import { tool as defineToolRaw, jsonSchema, type Tool } from "ai";

// Same cast workaround as artifact-output.ts / slip-output.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const defineTool = defineToolRaw as any;

export const MARKET_TURN_CONTRACT = "market-turn-v1";
export const MARKET_CARD_CONTRACT = "market-card-v1";
export const MARKET_OUTPUT_TOOL_NAME = "cite_markets";
export const MAX_MARKET_CARDS = 3;
export const MAX_MARKET_QUESTION_CHARS = 300;
export const MAX_MARKET_OUTCOME_CHARS = 80;
export const MIN_MARKET_OUTCOMES = 2;
export const MAX_MARKET_OUTCOMES = 4;
export const MARKET_VENUES = ["polymarket"] as const;
export const MARKET_STATUSES = ["active", "closed", "inactive"] as const;
export const MARKET_REASON_CODES = ["denied", "none_found"] as const;

/** Distinct markets remembered per run; later reads of a known market still replace it. */
const MAX_REMEMBERED_MARKETS = 400;
const MAX_WALK_NODES = 20_000;
const MAX_WALK_DEPTH = 8;

export type MarketVenue = (typeof MARKET_VENUES)[number];
export type MarketStatus = (typeof MARKET_STATUSES)[number];
export type MarketReasonCode = (typeof MARKET_REASON_CODES)[number];

export interface MarketOutcome {
  name: string;
  /** Venue price as a fraction 0..1 (a price, never a true probability). */
  price: number;
}

export interface MarketCard {
  contract: typeof MARKET_CARD_CONTRACT;
  venue: MarketVenue;
  id: string;
  question: string;
  slug: string;
  /** Slug of the event the market was read under, when the tool result nested it in one. */
  eventSlug: string | null;
  status: MarketStatus;
  outcomes: MarketOutcome[];
  /** Null when the tool result carried none (or a zero that the source also uses for "missing"). */
  volume: number | null;
  liquidity: number | null;
  gameStartTime: string | null;
  /** When the engine received the tool result this card was copied from (UTC, milliseconds). */
  readAt: string;
}

export interface MarketTurnInput {
  contract: typeof MARKET_TURN_CONTRACT;
  /** Opaque caller nonce; echoed by the one result that answers this run. */
  nonce: string;
}

export interface MarketTurnResult {
  contract: typeof MARKET_TURN_CONTRACT;
  nonce: string;
  markets: MarketCard[];
  /**
   * denied: an explicit tool allowlist omits `cite_markets`.
   * none_found: a Polymarket listing came back empty, and no result of the run
   * showed a market or had a shape this module cannot read.
   * Never set with markets.
   */
  reasonCode: MarketReasonCode | null;
  /**
   * When the engine received the latest successful Polymarket result of the
   * run (same clock and format as a card's `readAt`); null when it received
   * none, and always null with `denied`.
   */
  checkedAt: string | null;
}

const TURN_KEYS = ["contract", "nonce"] as const;
const RESULT_KEYS = ["contract", "nonce", "markets", "reasonCode", "checkedAt"] as const;
const CARD_KEYS = [
  "contract", "venue", "id", "question", "slug", "eventSlug", "status", "outcomes", "volume", "liquidity", "gameStartTime", "readAt",
] as const;
const OUTCOME_KEYS = ["name", "price"] as const;

const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const MARKET_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SLUG = /^[a-z0-9-]{0,200}$/;
const READ_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const UNPAIRED = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

function exactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!isPlain(value)) return null;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k)) ? value : null;
}

const cleanText = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max && !CONTROL.test(v) && !UNPAIRED.test(v);
const amountOrNull = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);

/** Exact market-card-v1 validation. Returns a fresh copy, or null. Never throws. */
export function parseMarketCard(value: unknown): MarketCard | null {
  const raw = exactKeys(value, CARD_KEYS);
  if (!raw || raw.contract !== MARKET_CARD_CONTRACT) return null;
  if (!(MARKET_VENUES as readonly unknown[]).includes(raw.venue)) return null;
  if (typeof raw.id !== "string" || !MARKET_ID.test(raw.id)) return null;
  if (!cleanText(raw.question, MAX_MARKET_QUESTION_CHARS)) return null;
  if (typeof raw.slug !== "string" || !SLUG.test(raw.slug)) return null;
  if (raw.eventSlug !== null && (typeof raw.eventSlug !== "string" || raw.eventSlug.length === 0 || !SLUG.test(raw.eventSlug))) return null;
  if (!(MARKET_STATUSES as readonly unknown[]).includes(raw.status)) return null;
  if (!Array.isArray(raw.outcomes) || raw.outcomes.length < MIN_MARKET_OUTCOMES || raw.outcomes.length > MAX_MARKET_OUTCOMES) return null;
  const outcomes: MarketOutcome[] = [];
  for (const item of Array.from(raw.outcomes)) {
    const o = exactKeys(item, OUTCOME_KEYS);
    if (!o || !cleanText(o.name, MAX_MARKET_OUTCOME_CHARS)) return null;
    if (typeof o.price !== "number" || !Number.isFinite(o.price) || o.price < 0 || o.price > 1) return null;
    outcomes.push({ name: o.name, price: o.price });
  }
  if (!amountOrNull(raw.volume) || !amountOrNull(raw.liquidity)) return null;
  if (raw.gameStartTime !== null && (typeof raw.gameStartTime !== "string" || raw.gameStartTime.length === 0 || raw.gameStartTime.length > 40 || CONTROL.test(raw.gameStartTime))) return null;
  if (typeof raw.readAt !== "string" || !READ_AT.test(raw.readAt)) return null;
  return {
    contract: MARKET_CARD_CONTRACT,
    venue: raw.venue as MarketVenue,
    id: raw.id,
    question: raw.question,
    slug: raw.slug,
    eventSlug: raw.eventSlug as string | null,
    status: raw.status as MarketStatus,
    outcomes,
    volume: raw.volume,
    liquidity: raw.liquidity,
    gameStartTime: raw.gameStartTime as string | null,
    readAt: raw.readAt,
  };
}

export function parseMarketTurnInput(value: unknown): MarketTurnInput | null {
  const raw = exactKeys(value, TURN_KEYS);
  if (!raw || raw.contract !== MARKET_TURN_CONTRACT) return null;
  if (typeof raw.nonce !== "string" || !NONCE.test(raw.nonce)) return null;
  return { contract: MARKET_TURN_CONTRACT, nonce: raw.nonce };
}

/**
 * Exact result validation against the exact input it must answer. Cards and a
 * reason code never coexist; card ids are unique. Cards and `none_found` need
 * a `checkedAt`; `denied` never has one. Returns a fresh copy, or null. Never
 * throws.
 */
export function parseMarketTurnResult(value: unknown, input: MarketTurnInput): MarketTurnResult | null {
  const turn = parseMarketTurnInput(input);
  const raw = exactKeys(value, RESULT_KEYS);
  if (!turn || !raw || raw.contract !== MARKET_TURN_CONTRACT || raw.nonce !== turn.nonce) return null;
  if (raw.reasonCode !== null && !(MARKET_REASON_CODES as readonly unknown[]).includes(raw.reasonCode)) return null;
  if (raw.checkedAt !== null && (typeof raw.checkedAt !== "string" || !READ_AT.test(raw.checkedAt))) return null;
  if (!Array.isArray(raw.markets) || raw.markets.length > MAX_MARKET_CARDS) return null;
  const markets: MarketCard[] = [];
  for (const item of Array.from(raw.markets)) {
    const card = parseMarketCard(item);
    if (!card || markets.some((m) => m.id === card.id)) return null;
    markets.push(card);
  }
  if (markets.length > 0 && (raw.reasonCode !== null || raw.checkedAt === null)) return null;
  if (raw.reasonCode === "denied" && raw.checkedAt !== null) return null;
  if (raw.reasonCode === "none_found" && raw.checkedAt === null) return null;
  return {
    contract: MARKET_TURN_CONTRACT,
    nonce: turn.nonce,
    markets,
    reasonCode: raw.reasonCode as MarketReasonCode | null,
    checkedAt: raw.checkedAt as string | null,
  };
}

// ---------------------------------------------------------------------------
// Reading tool results
// ---------------------------------------------------------------------------

/** A positive amount, or null. The source writes 0.0 for a missing amount, so zero is not shown as a fact. */
function amount(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** One normalized sports-skills Polymarket market, or null when anything a card needs is absent or out of bounds. Nothing is clipped or defaulted. */
function cardFrom(node: Record<string, unknown>, eventSlug: string | null, readAt: string): MarketCard | null {
  const id = typeof node.id === "number" && Number.isSafeInteger(node.id) ? String(node.id) : node.id;
  if (!Array.isArray(node.outcomes)) return null;
  const outcomes: MarketOutcome[] = [];
  for (const o of node.outcomes) {
    if (!isPlain(o)) return null;
    outcomes.push({ name: o.name as string, price: o.price as number });
  }
  return parseMarketCard({
    contract: MARKET_CARD_CONTRACT,
    venue: "polymarket",
    id,
    question: node.question,
    slug: typeof node.slug === "string" && SLUG.test(node.slug) ? node.slug : "",
    eventSlug,
    status: node.status,
    outcomes,
    volume: amount(node.volume),
    liquidity: amount(node.liquidity),
    gameStartTime: typeof node.game_start_time === "string" && node.game_start_time.length > 0 && node.game_start_time.length <= 40 && !CONTROL.test(node.game_start_time)
      ? node.game_start_time
      : null,
    readAt,
  });
}

/**
 * What one Polymarket tool result says about whether a market exists:
 *
 *   - `markets`: at least one market-shaped entry was seen (an object with a
 *     string `question` or an `outcomes` array), complete or not;
 *   - `empty_listing`: the payload is an empty array, or an object whose
 *     `markets` and/or `events` keys are all arrays and all empty;
 *   - `unrecognised`: any other successful result (a price, an order book, a
 *     series or config list, a listing of entries that are not market-shaped,
 *     non-JSON text). It says nothing about whether a market exists;
 *   - `error`: the result reports `status: false`, or came without a usable
 *     receipt time. It is not a successful read at all.
 *
 * The payload is `data` of a sports-skills `{ status: true, data, … }`
 * envelope, or the whole value when there is no such envelope.
 */
export type PolymarketResultKind = "markets" | "empty_listing" | "unrecognised" | "error";

export interface PolymarketRead {
  kind: PolymarketResultKind;
  /** Every complete market of the result, as cards. Empty unless `kind` is `markets`. */
  cards: MarketCard[];
}

const isEmptyListing = (payload: unknown): boolean => {
  if (Array.isArray(payload)) return payload.length === 0;
  if (!isPlain(payload)) return false;
  const lists = ["markets", "events"].filter((key) => Object.hasOwn(payload, key)).map((key) => payload[key]);
  return lists.length > 0 && lists.every((list) => Array.isArray(list) && list.length === 0);
};

/**
 * Reads one sports-skills Polymarket tool result: its complete markets as
 * cards, and what the result says about whether a market exists. A market
 * nested in an event keeps that event's slug. Markets missing a price on any
 * outcome, or anything else a card needs, are skipped (but still count as
 * seen). Never throws.
 */
export function readPolymarketResult(content: string, readAtMs: number): PolymarketRead {
  if (!Number.isFinite(readAtMs)) return { kind: "error", cards: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { kind: "unrecognised", cards: [] };
  }
  if (isPlain(parsed) && parsed.status === false) return { kind: "error", cards: [] };
  const readAt = new Date(readAtMs).toISOString();
  const found = new Map<string, MarketCard>();
  let visited = 0;
  let seen = false;
  const walk = (node: unknown, eventSlug: string | null, depth: number): void => {
    if (depth > MAX_WALK_DEPTH || ++visited > MAX_WALK_NODES) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, eventSlug, depth + 1);
      return;
    }
    if (!isPlain(node)) return;
    if (typeof node.question === "string" || Array.isArray(node.outcomes)) seen = true;
    if (typeof node.question === "string" && Array.isArray(node.outcomes)) {
      const card = cardFrom(node, eventSlug, readAt);
      if (card) found.set(card.id, card);
      return;
    }
    // An event: its own slug names the page its markets live on.
    const here = Array.isArray(node.markets) && typeof node.slug === "string" && node.slug.length > 0 && SLUG.test(node.slug) ? node.slug : eventSlug;
    for (const value of Object.values(node)) {
      if (value !== null && typeof value === "object") walk(value, here, depth + 1);
    }
  };
  walk(parsed, null, 0);
  if (seen) return { kind: "markets", cards: [...found.values()] };
  const payload = isPlain(parsed) && parsed.status === true && Object.hasOwn(parsed, "data") ? parsed.data : parsed;
  return { kind: isEmptyListing(payload) ? "empty_listing" : "unrecognised", cards: [] };
}

/** Every complete market in one sports-skills Polymarket tool result (see `readPolymarketResult`). Never throws. */
export function harvestPolymarketMarkets(content: string, readAtMs: number): MarketCard[] {
  return readPolymarketResult(content, readAtMs).cards;
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

export interface MarketCardCollector {
  /** The `cite_markets` tool to offer for one run. */
  readonly tool: Tool;
  /** Feed one successful tool result of this run, with the time it was really received. */
  record(toolName: string, content: string, receivedAtMs: number): void;
  /**
   * Forget the model's selection (a retried model call starts clean). What was
   * read stays, because it was really read: the markets, the latest check time
   * and what the results said about whether a market exists.
   */
  reset(): void;
  /** Remember the current selection; calling the returned function restores it. What was read is not part of it. */
  checkpoint(): () => void;
  /** The cited cards, in the order cited, each as last read in this run. */
  finish(): MarketCard[];
  /**
   * `checkedAt`: receipt time of the latest successful `polymarket_*` result
   * recorded, or null. `noneFound`: an empty listing was recorded, and no
   * recorded result showed a market, had an unrecognised shape or was an error.
   */
  checked(): { checkedAt: string | null; noneFound: boolean };
}

const CITE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["market_ids"],
  properties: {
    market_ids: {
      type: "array",
      minItems: 1,
      maxItems: MAX_MARKET_CARDS,
      items: { type: "string", minLength: 1, maxLength: 64 },
      description: "Ids of Polymarket markets you fetched in this turn, most relevant first.",
    },
  },
} as const;

export const MARKET_TOOL_DESCRIPTION =
  `Show up to ${MAX_MARKET_CARDS} Polymarket markets beside your answer as cards. Pass only the ids of markets a polymarket tool returned in this turn. ` +
  "The card's question, prices, volume and read time are copied from that tool result by the app, not from you: you choose the markets, nothing else. " +
  "Calling it again replaces the earlier choice.";

/** Appended to the system prompt of an opted-in run only. */
export function marketPromptSection(): string {
  return [
    "",
    "",
    "## Market cards",
    `When your answer is about specific Polymarket markets you fetched in this turn, call \`${MARKET_OUTPUT_TOOL_NAME}\` once with their ids (at most ${MAX_MARKET_CARDS}, most relevant first) before you write the answer.`,
    "The app draws each card from the tool result itself, so the card is extra to your answer, not a replacement: still state every number with its source and read time in the text.",
    "Do not call it for markets you did not fetch, and do not mention the tool or the cards in your answer.",
  ].join("\n");
}

export function createMarketCardCollector(): MarketCardCollector {
  const read = new Map<string, MarketCard>();
  let selected: string[] = [];
  let checkedAtMs: number | null = null;
  let sawEmptyListing = false;
  let sawMarket = false;
  let sawUnclear = false;

  const tool = defineTool({
    description: MARKET_TOOL_DESCRIPTION,
    inputSchema: jsonSchema(CITE_SCHEMA),
    execute: async (args: unknown) => {
      const ids = isPlain(args) && Array.isArray(args.market_ids) ? args.market_ids : [];
      const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string"))].slice(0, MAX_MARKET_CARDS);
      const shown = wanted.filter((id) => read.has(id));
      selected = shown;
      return JSON.stringify({
        shown,
        not_fetched_this_turn: wanted.filter((id) => !read.has(id)),
        note: "Cards are drawn by the app from the tool results. Do not mention them in your answer.",
      });
    },
  }) as Tool;

  return {
    tool,
    record: (toolName, content, receivedAtMs) => {
      if (!toolName.startsWith("polymarket_")) return;
      const result = readPolymarketResult(content, receivedAtMs);
      if (result.kind === "markets") sawMarket = true;
      else if (result.kind === "empty_listing") sawEmptyListing = true;
      else sawUnclear = true;
      // An error result is not a check; the latest receipt time wins (a cache hit carries its original time).
      if (result.kind !== "error" && (checkedAtMs === null || receivedAtMs > checkedAtMs)) checkedAtMs = receivedAtMs;
      for (const card of result.cards) {
        if (!read.has(card.id) && read.size >= MAX_REMEMBERED_MARKETS) continue;
        // A market read under an event keeps that event's slug when a later read does not know it.
        const prior = read.get(card.id);
        read.set(card.id, card.eventSlug === null && prior?.eventSlug ? { ...card, eventSlug: prior.eventSlug } : card);
      }
    },
    reset: () => {
      selected = [];
    },
    checkpoint: () => {
      const saved = [...selected];
      return () => {
        selected = [...saved];
      };
    },
    finish: () => selected.flatMap((id) => {
      const card = read.get(id);
      return card ? [{ ...card, outcomes: card.outcomes.map((o) => ({ ...o })) }] : [];
    }),
    checked: () => ({
      checkedAt: checkedAtMs === null ? null : new Date(checkedAtMs).toISOString(),
      noneFound: sawEmptyListing && !sawMarket && !sawUnclear,
    }),
  };
}

/**
 * The one result of an opted-in run. A denied run reports nothing it read.
 * `none_found` needs no cards and a check time; cards always carry a check
 * time no earlier than their own reads.
 */
export function marketTurnResult(input: MarketTurnInput, collector: MarketCardCollector, denied: boolean): MarketTurnResult {
  const base = { contract: MARKET_TURN_CONTRACT, nonce: input.nonce } as const;
  if (denied) return { ...base, markets: [], reasonCode: "denied", checkedAt: null };
  const markets = collector.finish();
  const { checkedAt, noneFound } = collector.checked();
  if (markets.length > 0) {
    // Same fixed-width UTC format, so string order is time order.
    const latestRead = markets.reduce((latest, card) => (card.readAt > latest ? card.readAt : latest), markets[0].readAt);
    return { ...base, markets, reasonCode: null, checkedAt: checkedAt !== null && checkedAt >= latestRead ? checkedAt : latestRead };
  }
  return { ...base, markets: [], reasonCode: noneFound && checkedAt !== null ? "none_found" : null, checkedAt };
}
