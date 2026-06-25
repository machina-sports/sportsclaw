# Odds & Prediction Markets

sportsclaw pulls live odds and prediction-market prices alongside real game data, and can run
the math that turns prices into insight — all read-only.

## Ask across sources

The agent can fetch and compare prices from ESPN, Kalshi, and Polymarket in a single question:

```bash
sportsclaw "What are the NBA Finals odds on Polymarket?"
sportsclaw "Compare the moneyline on tonight's game across books"
```

It can also pull a single fused snapshot — scores, odds, predictions, and news for a game,
player, or market in one go — which is handy for dashboards and broadcast tools.

## Betting math, built in

Beyond raw prices, sportsclaw can do the analysis:

- **De-vig** — strip the bookmaker margin to get true implied probability.
- **Edge** — compare a market price to a fair estimate.
- **Kelly** — suggest stake sizing from an edge.
- **Arbitrage** — spot price gaps across sources.

```bash
sportsclaw "De-vig these odds and tell me if there's any edge"
```

## Read-only by default

sportsclaw reads markets; it doesn't place bets. Trading is blocked for every bot and server
deployment, and only a local owner session can opt into trade-capable tools. See
**[Read-Only by Default](../core-concepts/safety-and-trading)** for the full picture.
