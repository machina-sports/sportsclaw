/**
 * SportsClaw — Telegram Listener (Phase 4)
 *
 * A simple Telegram bot that pipes messages to the SportsClaw engine.
 * Uses the Telegram Bot API directly via fetch — no extra dependencies.
 *
 * Environment:
 *   TELEGRAM_BOT_TOKEN   — Your Telegram bot token (from @BotFather)
 *   ANTHROPIC_API_KEY    — Anthropic API key for the engine
 *
 * The bot responds to all text messages sent to it (1:1 or in groups when
 * mentioned via /claw <question>).
 */

import { SportsClawEngine } from "../engine.js";

const COMMAND_PREFIX = "/claw";

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    text?: string;
    from?: { id: number; first_name: string };
  };
}

interface TelegramResponse {
  ok: boolean;
  result: TelegramUpdate[];
}

export async function startTelegramListener(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("Error: TELEGRAM_BOT_TOKEN is required.");
    process.exit(1);
  }

  const apiBase = `https://api.telegram.org/bot${token}`;

  const engine = new SportsClawEngine({
    ...(process.env.SPORTSCLAW_MODEL && { model: process.env.SPORTSCLAW_MODEL }),
    ...(process.env.PYTHON_PATH && { pythonPath: process.env.PYTHON_PATH }),
  });

  // Verify the bot token is valid
  const meRes = await fetch(`${apiBase}/getMe`);
  const meData = (await meRes.json()) as { ok: boolean; result?: { username: string } };
  if (!meData.ok) {
    console.error("Error: Invalid TELEGRAM_BOT_TOKEN.");
    process.exit(1);
  }
  console.log(`[sportsclaw] Telegram bot connected as @${meData.result?.username}`);
  console.log(`[sportsclaw] Listening for messages...`);

  let offset = 0;

  // Long-polling loop
  while (true) {
    try {
      const res = await fetch(
        `${apiBase}/getUpdates?timeout=30&offset=${offset}`,
        { signal: AbortSignal.timeout(60_000) }
      );
      const data = (await res.json()) as TelegramResponse;

      if (!data.ok || !data.result) continue;

      for (const update of data.result) {
        offset = update.update_id + 1;

        const msg = update.message;
        if (!msg?.text) continue;

        let prompt: string | null = null;

        // In private chats, respond to all messages
        if (msg.chat.type === "private") {
          prompt = msg.text;
        }

        // In groups, respond to /claw commands
        if (!prompt && msg.text.startsWith(COMMAND_PREFIX)) {
          prompt = msg.text.slice(COMMAND_PREFIX.length).trim();
        }

        if (!prompt) continue;

        // Send "typing" action
        await fetch(`${apiBase}/sendChatAction`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: msg.chat.id,
            action: "typing",
          }),
        });

        try {
          engine.reset();
          const response = await engine.run(prompt);

          // Telegram has a 4096 char limit — split if needed
          const chunks = splitMessage(response, 4096);
          for (const chunk of chunks) {
            await fetch(`${apiBase}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: msg.chat.id,
                text: chunk,
                reply_to_message_id: msg.message_id,
              }),
            });
          }
        } catch (error: unknown) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(`[sportsclaw] Telegram error: ${errMsg}`);
          await fetch(`${apiBase}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: msg.chat.id,
              text: "Sorry, I encountered an error processing your request.",
              reply_to_message_id: msg.message_id,
            }),
          });
        }
      }
    } catch (error: unknown) {
      // Network errors during polling — retry after a short delay
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[sportsclaw] Polling error: ${errMsg}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

/** Split a message into chunks that fit Telegram's character limit */
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx <= 0) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  return chunks;
}
