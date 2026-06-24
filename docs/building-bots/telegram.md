# Telegram Bot

Run sportsclaw as a Telegram bot — in DMs, group chats, or inline in any conversation.

## Setup

1. Create a bot with [@BotFather](https://t.me/botfather) and copy the token.
2. Add it to sportsclaw:
   ```bash
   sportsclaw channels
   ```
3. Start the bot:
   ```bash
   sportsclaw listen telegram
   ```

To keep it running in the background, see **[Running as a Daemon](../deployment/daemons)**.

## What your users get

- **Inline keyboards** for quick actions and picking a sport or team.
- **Inline queries** — type `@yourbot lakers score` in any chat and drop the answer inline,
  without adding the bot to that group.
- **Image replies** — generated graphics are sent straight into the chat.
- **Vision** — send a photo and ask about it.

## Following teams

Just like Discord, users can say "tell me when Brazil scores" and the bot will message them on
goals, lead changes, and the final whistle. See **[Live-Game Alerts](./live-game-alerts)**.
