# Market cards (`market-turn-v1`)

A caller can let one run return **up to three prediction-market cards** beside the answer
text, for an app that draws a market as a card instead of a sentence.

Every value on a card is copied by code from a tool result the run really received. The model
never writes a price, a volume or a time. Its only part is choosing which fetched markets to
show, by id, through the `cite_markets` tool. An id that was not fetched in this run is refused.

Without the opt-in, nothing changes: no `cite_markets` tool, no prompt section, nothing
recorded, and no new field on the result line.

Polymarket only, for now.

## Wire

```text
MarketTurnInput   { contract: "market-turn-v1", nonce }
MarketTurnResult  { contract: "market-turn-v1", nonce, markets: market-card-v1[0..3],
                    reasonCode: "denied" | "none_found" | null, checkedAt | null }
market-card-v1    { contract: "market-card-v1", venue: "polymarket", id, question, slug, eventSlug | null,
                    status, outcomes: [{ name, price }], volume | null, liquidity | null,
                    gameStartTime | null, readAt }
```

- `nonce`: 16–64 characters of `[A-Za-z0-9_-]`, chosen by the caller. The one result for the run
  echoes it.
- `id`: 1–64 characters of `[A-Za-z0-9_-]`; unique within a result.
- `question`: 1–300 UTF-16 units, no control characters.
- `slug`, `eventSlug`: lowercase letters, digits and hyphens, at most 200. `slug` may be empty;
  `eventSlug` is null unless the market was read nested in an event.
- `status`: `active`, `closed` or `inactive`.
- `outcomes`: 2–4, each a `name` (1–80 units) and a `price` from 0 to 1. The price is the venue's
  price, never a probability estimate.
- `volume`, `liquidity`: a number of at least 0, or null.
- `readAt`, `checkedAt`: `YYYY-MM-DDTHH:MM:SS.sssZ`. `checkedAt` is the engine's receipt time of
  the latest successful `polymarket_*` result of the run, or null when the run received none.
- Exact keys everywhere: an extra field (a URL, a token id) or a missing one makes the value
  invalid.

The result has four valid forms. Anything else is refused by both parsers.

| `markets` | `reasonCode`   | `checkedAt` | Meaning |
|-----------|----------------|-------------|---------|
| 1–3 cards | `null`         | a time      | The model cited markets the run read. |
| `[]`      | `"denied"`     | `null`      | An explicit `toolAllowlist` omits `cite_markets`. Nothing the run read is reported. |
| `[]`      | `"none_found"` | a time      | A market or event listing came back empty, and nothing else the run read leaves doubt (rules below). |
| `[]`      | `null`         | a time or `null` | Everything else: the model cited nothing, or nothing it cited had been fetched, or the run's results do not support `none_found`. `checkedAt` is null only when no successful Polymarket result was received. |

## When the result says `none_found`

Each `polymarket_*` result the run receives is put in one of four classes. The payload is the
`data` of a sports-skills `{ status: true, data, … }` envelope, or the whole value when there is
no envelope.

- **Market seen:** anywhere in the result there is an object with a string `question` or an
  `outcomes` array. This includes a market that could not become a card (a missing price, an
  unknown status, a compact row without outcomes).
- **Empty listing:** the payload is an empty array, or an object whose `markets` and/or `events`
  keys are all arrays and all empty (`{ markets: [], count: 0 }`, `{ events: [] }`, an event
  with `markets: []`).
- **Unrecognised:** any other successful result: a price, an order book, a price history, a
  series or sports-config list, an event list whose events show no market, text that is not
  JSON. It says nothing about whether a market exists.
- **Error:** the result reports `status: false`. It is not a successful result and does not move
  `checkedAt`.

`none_found` is given only when the run has at least one empty listing, no market seen, no
unrecognised result and no error result. One result of any other class, before or after the
empty listing, makes the reason `null`.

Results of other tools (Kalshi, scores) are not read at all: they neither set `checkedAt` nor
block `none_found`.

## What a card does and does not say

- **`readAt` is the engine's read time.** It is when the engine received the tool result, kept
  through the registry cache so a cache hit reports the original time. It is not a provider
  timestamp: the venue API does not supply one in this shape, and sports-skills may itself have
  served the value from a short cache.
- **`checkedAt` is the same kind of time**, for the run's latest successful Polymarket result,
  whatever its shape. When several results were received it is the latest receipt time, so it
  is never earlier than a card's `readAt`. It says when the engine last heard from the venue's
  tools, not that any particular market was read then.
- **`none_found` describes the listings the run asked for, nothing wider.** It means the search
  or listing the model chose returned no rows at `checkedAt`. A different query, tag or page
  might return a market. A caller should word it as "no market found for this search", not as
  "no market exists".
- **A zero amount is not shown.** sports-skills writes `0.0` when the provider omits volume or
  liquidity, so a zero cannot be told from "missing" and becomes `null`. A market that really
  has zero volume is therefore shown without one.
- **Nothing is clipped or defaulted.** A market missing a price on any outcome, with fewer than
  two or more than four outcomes, with an unknown status or with a question over the bound is
  not turned into a card at all.
- **A card is not a claim check.** It shows that the venue returned those numbers at that time.
  Whether the answer's prose agrees with them is still the evidence check's job.
- **No link is built here.** The caller builds one from `eventSlug` or `slug`.

## How a run uses it

1. The caller passes `market` and `onMarketResult` in `RunOptions`. The input is validated before
   any model, tool or credential work.
2. Each successful `polymarket_*` result of the run is read whole, before any output capping.
   Complete markets are remembered by id; a later read of the same market replaces the earlier one.
   The receipt time and the class of each result (above) are remembered too.
3. The model may call `cite_markets({ market_ids })`. Known ids are kept in the order given, at
   most three; a later call replaces the choice. A retried model call starts with no choice, but
   keeps what was already read: the markets, the check time and the result classes.
4. After the run, `onMarketResult` receives exactly one result.

`cite_markets` is not offered to parallel lanes and does not count as a data source for the
evidence check.

## Headless and relay

- **CLI:** with `--history-stdin`, add `"market": { "contract": "market-turn-v1", "nonce": "…" }` to
  the stdin JSON. The result line carries `"market": { … }`. The key is absent on a run that did
  not ask for it.
- **Relay:** send `market` in the body of `POST /api/query/sync` with `history_mode: "caller"`. The
  server must have `SPORTSCLAW_MARKET_CARDS_ENABLED=true`; a request body can never enable it.
  `GET /api/capabilities` advertises `market_contract` only when it is on. See
  [`docker/relay/market_contract.py`](../../docker/relay/market_contract.py) for the validation the
  relay applies in both directions.

## Not covered

- Kalshi and sportsbook lines.
- Price history ("what changed"): a caller that keeps cards can compare two reads itself.
- Any check that the cited market is the one the answer is about.
- Any check that an empty listing was the right search for the question. `none_found` reports
  what the run's own calls returned; it does not retry with other terms or page through results.
- Why a non-empty result produced no card. `markets: []` with `reasonCode: null` does not tell
  "the model cited nothing" from "a market was seen but incomplete" or "only a price was read".
