# demo/vault_data

Static mock data for the Momentum & Price Explainer loop demo.

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
