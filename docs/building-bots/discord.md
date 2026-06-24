# Discord Bot

Put sportsclaw in your Discord server and your community can ask about any game, any time —
and get answers with the real numbers, rich cards, and interactive buttons.

## Setup

1. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications)
   and copy its token.
2. Add the token to sportsclaw:
   ```bash
   sportsclaw channels
   ```
3. Install the Discord library (it's an optional dependency):
   ```bash
   npm install -g discord.js
   ```
4. Start the bot:
   ```bash
   sportsclaw listen discord
   ```

Mention the bot or message it, and it answers. To keep it running after you close your
terminal, see **[Running as a Daemon](../deployment/daemons)**.

## What your users get

- **Rich embeds** with team logos and clean formatting.
- **Interactive buttons** — Box Score, Play-by-Play, and Full Stats expand the detail without a
  new question.
- **Native polls** for "who wins?"-style prompts.
- **Image replies** — ask for a matchday graphic and the bot posts one back.
- **Vision** — drop in a screenshot of a bracket or scoreboard and ask about it.

## Turning features on and off

Each surface is a feature flag, so you can tailor the experience:

| Feature | Default |
| --- | --- |
| Embeds | On |
| Buttons | On |
| Polls | On |
| Reactions | Off |

Set them when you start the listener, e.g. `DISCORD_FEATURE_POLLS=false sportsclaw listen discord`.

## Following teams

Your users can subscribe to their teams right from chat — "alert me about the Lakers" — and the
bot will message them automatically when the game moves. See
**[Live-Game Alerts](./live-game-alerts)**.
