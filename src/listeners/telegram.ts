/**
 * sportsclaw — Telegram Listener (Phase 4)
 *
 * A simple Telegram bot that pipes messages to the sportsclaw engine.
 * Uses the Telegram Bot API directly via fetch — no extra dependencies.
 *
 * Environment:
 *   TELEGRAM_BOT_TOKEN   — Your Telegram bot token (from @BotFather)
 *   sportsclaw_PROVIDER  — LLM provider (anthropic, openai, google)
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY
 *   ALLOWED_USERS        — Comma-separated Telegram user IDs (optional whitelist)
 *
 * The bot responds to all text messages sent to it (1:1 or in groups when
 * mentioned via /claw <question>).
 */

import { sportsclawEngine } from "../engine.js";
import type { LLMProvider, sportsclawConfig } from "../types.js";
import { splitMessage } from "../utils.js";

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

/** Parse ALLOWED_USERS env var into a Set of user IDs, or null if unset */
function getAllowedUsers(): Set<string> | null {
  const raw = process.env.ALLOWED_USERS;
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length > 0 ? new Set(ids) : null;
}

export async function startTelegramListener(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("Error: TELEGRAM_BOT_TOKEN is required.");
    process.exit(1);
  }

  const apiBase = `https://api.telegram.org/bot${token}`;

  const allowedUsers = getAllowedUsers();
  if (allowedUsers) {
    console.log(
      `[sportsclaw] User whitelist active: ${allowedUsers.size} user(s) allowed`
    );
  }

  const engineConfig: Partial<sportsclawConfig> = {
    provider: (process.env.sportsclaw_PROVIDER || "anthropic") as LLMProvider,
    ...(process.env.sportsclaw_MODEL && {
      model: process.env.sportsclaw_MODEL,
    }),
    ...(process.env.PYTHON_PATH && { pythonPath: process.env.PYTHON_PATH }),
  };

  // Verify the bot token is valid
  const meRes = await fetch(`${apiBase}/getMe`);
  const meData = (await meRes.json()) as {
    ok: boolean;
    result?: { username: string };
  };
  if (!meData.ok) {
    console.error("Error: Invalid TELEGRAM_BOT_TOKEN.");
    process.exit(1);
  }
  console.log(
    `[sportsclaw] Telegram bot connected as @${meData.result?.username}`
  );
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

      // Advance offset for all received updates immediately
      for (const update of data.result) {
        offset = Math.max(offset, update.update_id + 1);
      }

      // Process updates concurrently to avoid head-of-line blocking
      const tasks = data.result.map((update) =>
        processUpdate(update, apiBase, engineConfig, allowedUsers)
      );
      await Promise.allSettled(tasks);
    } catch (error: unknown) {
      // Network errors during polling — retry after a short delay
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[sportsclaw] Polling error: ${errMsg}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

/** Process a single Telegram update in its own async context */
async function processUpdate(
  update: TelegramUpdate,
  apiBase: string,
  engineConfig: Partial<sportsclawConfig>,
  allowedUsers: Set<string> | null
): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return;

  // Check user whitelist
  if (allowedUsers && msg.from && !allowedUsers.has(String(msg.from.id)))
    return;

  let prompt: string | null = null;

  // In private chats, respond to all messages
  if (msg.chat.type === "private") {
    prompt = msg.text;
  }

  // In groups, respond to /claw commands
  if (!prompt && msg.text.startsWith(COMMAND_PREFIX)) {
    prompt = msg.text.slice(COMMAND_PREFIX.length).trim();
  }

  if (!prompt) return;

  // Send "typing" action
  await fetch(`${apiBase}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: msg.chat.id,
      action: "typing",
    }),
  });

  // Use the Telegram user ID for memory isolation
  const userId = `telegram-${msg.from?.id ?? msg.chat.id}`;

  try {
    // Fresh engine per request — avoids shared-state issues
    const engine = new sportsclawEngine(engineConfig);
    const response = await engine.run(prompt, { userId });

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
