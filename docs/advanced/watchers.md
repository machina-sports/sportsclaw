# Watchers & Schedules

Beyond answering on demand, sportsclaw can keep an eye on things and act when a condition is
met or on a timer.

## Conditional alerts

Ask the agent to watch for something and ping you when it happens:

> "Ping me if LeBron scores 30 tonight."

The agent records the condition and notifies you when it's met. (For following whole teams,
[Live-Game Alerts](../building-bots/live-game-alerts) are simpler and need no phrasing.)

## Scheduled tasks

Ask for something on a recurring schedule:

> "Send me an NFL injury report every morning at 9."

The agent runs the prompt on that schedule and delivers the result. Schedules run at most once
every few minutes.

## Watching a data endpoint (CLI)

For power users, `sportsclaw watch` polls a specific data endpoint and emits whenever the
result changes:

```bash
sportsclaw watch nfl scores              # watch one endpoint for changes
sportsclaw watch --config=watchers.json  # run several at once
```

This is a low-level primitive — most use cases are better served by team alerts or scheduled
tasks above.
