# Read-Only by Default

sportsclaw can read live odds and prediction-market prices from Kalshi and Polymarket — but it
is built to **track, not trade**. Placing bets, moving funds, or signing transactions is off by
default.

## What's blocked

The engine refuses any action that would place or cancel an order, buy or sell, or touch a
wallet or balance. This is enforced everywhere the agent runs — when tools are first offered to
the model and again before any tool actually executes. A prompt that asks the bot to "buy 100
shares" gets a refusal, not an order.

## Bots and servers are always read-only

Any deployment that other people talk to — your Discord bot, your Telegram bot, a hosted
service — is hard read-only. There is no configuration in those surfaces that turns trading on.
Your community can ask for odds, edges, and analysis; they cannot make your bot place a wager.

## The local owner can opt in

When you run sportsclaw yourself from your own terminal, you're the trusted owner. In that
local session you *can* opt into trading-capable tools — but only if an underlying skill
actually exposes them, and only for you. This never extends to a deployed bot.

## Approvals for everything else

Beyond markets, the engine gates other side effects — writing files, running shell commands —
behind explicit approval, so an autonomous run can't quietly do something you didn't sanction.
You approve an action once, or pre-approve it for the session.

<div class="tip custom-block"><p class="custom-block-title">The short version</p>

Read odds and markets freely. Trading is blocked for every bot and server deployment. Only you,
locally, can opt into trade-capable tools.

</div>
