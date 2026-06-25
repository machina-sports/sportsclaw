# Coverage

sportsclaw comes with live data for 14 sports plus odds and prediction markets — all keyless
for the data itself. You don't wire up feeds or manage API keys; you just ask.

<div class="tip custom-block"><p class="custom-block-title">Powered by sports-skills</p>

All of this coverage comes from **[sports-skills](https://sports-skills.sh)** — the open
Python data layer that the installer sets up for you. It's what turns "who won last night?"
into a real, sourced answer. Browse the full catalog at **[sports-skills.sh](https://sports-skills.sh)**.

Need **licensed data, real-time feeds, or production SLAs**? There's a `sports-skills premium`
tier for deeper coverage, plus the [Machina premium layer](./machina) for licensed real-time
pods. Connect a Machina pod in one command with `sportsclaw machina connect`.

</div>

## Sports

| | | |
| --- | --- | --- |
| 🏈 NFL | 🏀 NBA | 🏀 WNBA |
| ⚾ MLB | 🏒 NHL | ⚽ Soccer |
| 🏎️ Formula 1 | 🎾 Tennis | 🏏 Cricket |
| ⛳ Golf | 🏐 Volleyball | 🏈 College Football |
| 🏀 College Basketball | 🏃 Track & Field | |

Typical questions each can answer: live and recent scores, standings, schedules, rosters,
player stats, play-by-play, and news — availability varies a little by sport.

## Markets & analysis

| Source | What it gives you |
| --- | --- |
| **ESPN** | Live scores, standings, schedules, stats |
| **Kalshi** | Event-market prices |
| **Polymarket** | Prediction-market odds |
| **Betting tools** | Edge, de-vig, Kelly, arbitrage math |

See **[Odds & Prediction Markets](./odds-and-markets)** for how to use these together.

## How asking works

You never name a data source or a sport code — just ask naturally:

```bash
sportsclaw "How did Arsenal do this weekend?"
sportsclaw "Show me the NBA standings"
sportsclaw "Who's favored in the F1 championship?"
```

The first time you touch a new sport, sportsclaw installs it in a couple of seconds. To load
everything up front: `sportsclaw init --all`. To see what's installed: `sportsclaw list`.
