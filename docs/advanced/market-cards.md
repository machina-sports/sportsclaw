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
MarketTurnResult  { contract: "market-turn-v1", nonce, markets: market-card-v1[0..3], reasonCode: "denied" | null }
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
- `readAt`: `YYYY-MM-DDTHH:MM:SS.sssZ`.
- Exact keys everywhere: an extra field (a URL, a token id) makes the value invalid.
- Cards and a `reasonCode` never coexist. `denied` means an explicit `toolAllowlist` omits
  `cite_markets`. `markets: []` with `reasonCode: null` means the model cited nothing, or
  nothing it cited had been fetched.

## What a card does and does not say

- **`readAt` is the engine's read time.** It is when the engine received the tool result, kept
  through the registry cache so a cache hit reports the original time. It is not a provider
  timestamp: the venue API does not supply one in this shape, and sports-skills may itself have
  served the value from a short cache.
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
3. The model may call `cite_markets({ market_ids })`. Known ids are kept in the order given, at
   most three; a later call replaces the choice. A retried model call starts with no choice.
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
