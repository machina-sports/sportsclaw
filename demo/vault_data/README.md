# demo/vault_data

Static mock data for the Momentum & Price Explainer loop demo.

## Cross-sport fixtures (2026-07-18)

The momentum pipeline's `markets` connector is already sport-parametric
(`_ESPN_SPORT_PATHS` / `KALSHI_SERIES` cover nfl, nba, mlb, nhl, wnba, cfb,
cbb — see `sports-skills/src/sports_skills/markets/_connector.py`). MLB was
live-verified against real ESPN + Kalshi data; WNBA was live-verified the
same way on 2026-07-18 (real game SEA @ IND, ESPN event 401857073, Kalshi
`KXWNBAGAME-26JUL17SEAIND-IND`) since WNBA was in season at the time.

**NBA, NHL, CFB, and CBB were all out of season as of 2026-07-18**, so
there was no live game or open Kalshi market to test against. Each has a
synthetic fixture below, built the same way as `mock_game.json`, and each
was run end-to-end through `momentum-demo.js` (swing detection → card
generation → evaluator gate) to confirm the pipeline works mechanically.
*They have not been live-verified against real ESPN/Kalshi data for those
sports — re-run with `resolve_game_market`/`momentum-replay.js` once each
league is back in season to close that gap.*

- `mock_game_nba.json` — BOS @ MIA (fictional), steal + dunk swing. Card generation verified — passed.
- `mock_game_nhl.json` — TOR @ BOS (fictional), shorthanded goal swing. Pipeline verified end-to-end, but the generator consistently adds unsupported "momentum" language on this play and the evaluator correctly holds the card for review rather than passing it — this exercises the fail-closed gate, not a passing card.
- `mock_game_cfb.json` — OSU @ MICH (fictional), punt-return TD swing. Card generation verified — passed.
- `mock_game_cbb.json` — DUKE @ UNC (fictional), go-ahead 3-pointer swing. Card generation verified — passed.

Run any of them the same way as the NFL demo, e.g.:

```
MOMENTUM_MOCK_FILE=demo/vault_data/mock_game_nba.json node dist/intelligence/momentum-demo.js
```

## mock_game.json

A JAX @ HOU (home = HOU) mock with a 3-tick timeline. `polymarket_home_price_cents`
moves **42 → 43 → 68**; the 43 → 68 jump at tick 2 is the momentum swing, caused by
the embedded pick-six play. Consumed by `sports_skills.markets.get_mock_tick`, which
returns one tick per call, selected deterministically by the system clock:

```
tick_index = (epoch_seconds // interval_seconds) % total_ticks
```

### ⚠️ Keep the two intervals equal

Two separate intervals are in play and **must match** (both `5` in this demo):

| Interval | Where | Role |
| --- | --- | --- |
| `--interval=5` | sportsclaw watcher | how often the watcher polls `get_mock_tick` |
| `interval_seconds=5` | `get_mock_tick` | how long each tick is "held" in the modulo |

The sportsclaw `watch` command consumes `--interval` for the watcher and does **not**
forward it to Python, so `get_mock_tick` uses its own `interval_seconds` default (5).
If the two ever diverge, the watcher polls out of phase with the tick boundaries and
either **re-reads the same tick** (duplicate, no event) or **steps past a tick**
(skips the 42→43 or 43→68 transition). Either way the intended progression won't emit
cleanly. If you change one, pass the other explicitly:
`--interval=N ... --interval_seconds=N`.

### Run the watcher (Phase 2)

```
PYTHONPATH=<repo>/sports-skills/src \
node dist/index.js watch markets get_mock_tick \
  --mock_file_path=demo/vault_data/mock_game.json \
  --interval=5 --output=relay --channel=watch
```

Note: the flag is `--mock_file_path` (underscore), not `--mock-file`. sports-skills'
CLI passes flag names to the Python function verbatim, so it must match the parameter
name `mock_file_path` exactly.
