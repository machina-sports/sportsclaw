# Live-Game Alerts

sportsclaw doesn't just answer questions — it can reach out. Users follow a team in plain
language, and the bot messages them the moment something happens.

## How users subscribe

There's no menu or setup. A user just asks:

> "Alert me about the Lakers."
> "Tell me when Brazil scores."

The bot confirms:

> Subscribed to the Lakers (NBA). I'll message you on scores, lead changes, and the final.

To stop, they say "stop alerting me about the Lakers." Team names are matched loosely — "niners"
finds the 49ers, "man u" finds Manchester United, "spurs" finds Tottenham.

## What triggers an alert

Once anyone is following a team, sportsclaw watches that team's games in the background and
sends a message on each meaningful moment:

| Event | Example |
| --- | --- |
| **Game start** | "Lakers vs. Warriors is underway." |
| **Score change** | "Warriors 24, Lakers 21 — end of Q1." |
| **Lead change** | "🔄 The Lakers take the lead, 58–56." |
| **Final** | "Final: Lakers 112, Warriors 108." |

Routine updates are delivered instantly from templates; the bigger moments — a lead change, the
final — get a short, written-up message.

## Good to know

- Subscriptions are **per user** and persist across restarts.
- Alerts work on both **Discord** and **Telegram**.
- The watch loop only runs for sports someone is actually following, so it stays light.
