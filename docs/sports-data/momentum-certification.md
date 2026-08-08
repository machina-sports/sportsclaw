# Momentum seven-sport certification

Machine-checkable companion to [`momentum-certification.json`](./momentum-certification.json).
Generated **2026-08-08T14:29:13Z**. Guarded by `test/momentum-certification.test.mjs`.

> **No sport in this table is currently live-certified.** Synthetic evidence proves the
> pipeline's mechanics only. The MLB and WNBA rows are *historical reports* from
> [PR #135](https://github.com/machina-sports/sportsclaw/pull/135) whose complete run
> receipts were not retained. Fresh 2026-08-08 revalidation found a WNBA
> **resolver anomaly** and an unresolved MLB market; separate scoreboard discovery for
> both sports was **blocked** by ESPN HTTP 403.

## Evidence types

| Type | Meaning |
| --- | --- |
| `live-reported` | A live run against real ESPN + Kalshi data was reported in PR #135, but the retained receipt is incomplete (missing exact run timestamp and latency; for MLB also the output/evaluator counts). |
| `synthetic` | The sport was out of season, or no live market existed. A fixture was run end-to-end through swing detection → card generation → evaluator gate. Proves mechanics, not live behaviour. |

There is deliberately **no `live-certified` type**. A row earns one only when a single fresh
run yields, together: ESPN event id, resolved Kalshi market, non-empty price series, output
verdict, evaluator verdict, and a measured latency.

## The seven sports

| sport | evidenceType | certificationStatus | ESPN event | market | output | evaluator | latencyMs | pendingLive |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| nfl | synthetic | pending-live | — | — | card-generated | accepted | not retained | yes |
| mlb | live-reported | pending-live-revalidation | 401872178 | `KXMLBGAME-26JUL171335TBBOSG1-BOS` | not-retained | not-retained | not retained | yes |
| nba | synthetic | pending-live | — | — | card-generated | accepted | not retained | yes |
| nhl | synthetic | pending-live | — | — | card-generated | **held** | not retained | yes |
| wnba | live-reported | pending-live-revalidation | 401857073 | `KXWNBAGAME-26JUL17SEAIND-IND` | 3-cards-generated | 2-passed-1-held | not retained | yes |
| cfb | synthetic | pending-live | — | — | card-generated | accepted | not retained | yes |
| cbb | synthetic | pending-live | — | — | card-generated | accepted | not retained | yes |

### Fixtures behind the synthetic rows

| sport | fixture |
| --- | --- |
| nfl | `demo/vault_data/mock_game.json` |
| nba | `demo/vault_data/mock_game_nba.json` |
| nhl | `demo/vault_data/mock_game_nhl.json` |
| cfb | `demo/vault_data/mock_game_cfb.json` |
| cbb | `demo/vault_data/mock_game_cbb.json` |

### NHL is a held card, not an accepted one

The NHL fixture's shorthanded-goal swing makes the generator add unsupported "momentum"
language, and the evaluator holds the card rather than passing it. That is the fail-closed
gate working as designed — but it means NHL has **never** produced an accepted card, synthetic
or live. Any future artifact that shows NHL as `accepted` without a new run is a regression.

## Fresh revalidation (2026-08-08T14:29:13Z) — unresolved

Both live-reported rows were re-run to try to close the receipt gap. Neither succeeded, so
neither row advanced.

| sport | command | revalidation status | observed | discovery status | discovery observed |
| --- | --- | --- | --- | --- | --- |
| wnba | `node dist/intelligence/momentum-replay.js wnba 401857073` | resolver-anomaly | Resolved a different market, `KXWNBAGAME-26JUL28INDSEA-IND`, instead of the reported `KXWNBAGAME-26JUL17SEAIND-IND`, and returned 0 price points. | blocked | Follow-up scoreboard discovery returned ESPN HTTP 403. |
| mlb | `node dist/intelligence/momentum-replay.js mlb 401872178` | blocked | No Kalshi winner market resolved for ESPN event 401872178. | blocked | Follow-up scoreboard discovery returned ESPN HTTP 403. |

These are unresolved revalidation and blocked discovery receipts, not passes. Response bodies
are deliberately not embedded here — only each status and one-line outcome.

## What the offline test suite does and does not prove

`npm run test:momentum` passes 33/33. Those tests are offline and cover candle→swing
extraction, card generation surfaces, and the evaluator gate. They prove the mechanics are
correct; they say nothing about live ESPN or Kalshi behaviour for any sport.

## Related

- [`demo/vault_data/README.md`](../../demo/vault_data/README.md) — fixture details and run commands
- [`coverage.md`](./coverage.md) — sports-data coverage
