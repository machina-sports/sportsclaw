/**
 * sportsclaw — Telegram Listener (Phase 4 + Sprint 2)
 *
 * A Telegram bot that pipes messages to the sportsclaw engine with:
 *   - HTML-formatted responses (bold headers, code blocks, tables)
 *   - Inline keyboard buttons (Box Score / Play-by-Play / Full Stats)
 *   - Callback query handling for button interactions
 *
 * Uses the Telegram Bot API directly via fetch — no extra dependencies.
 *
 * Environment:
 *   TELEGRAM_BOT_TOKEN   — Your Telegram bot token (from @BotFather)
 *   SPORTSCLAW_PROVIDER  — LLM provider (anthropic, openai, google)
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY
 *   ALLOWED_USERS        — Comma-separated Telegram user IDs (optional whitelist)
 */

import { sportsclawEngine } from "../engine.js";
import type { LLMProvider, sportsclawConfig } from "../types.js";
import { splitMessage } from "../utils.js";
import { formatResponse, isGameRelatedResponse } from "../formatters/index.js";

const COMMAND_PREFIX = "/claw";

// ---------------------------------------------------------------------------
// Telegram API types
// ---------------------------------------------------------------------------

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    text?: string;
    from?: { id: number; first_name: string };
  };
  callback_query?: {
    id: string;
    from: { id: number; first_name: string };
    message?: {
      message_id: number;
      chat: { id: number };
    };
    data?: string;
  };
}

interface TelegramResponse {
  ok: boolean;
  result: TelegramUpdate[];
}

interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

// ---------------------------------------------------------------------------
// Button context store (ephemeral in-process map)
// ---------------------------------------------------------------------------

interface ButtonContext {
  prompt: string;
  userId: string;
}

const buttonContexts = new Map<string, ButtonContext>();
const MAX_BUTTON_CONTEXTS = 200;

function storeButtonContext(prompt: string, userId: string): string {
  const key = Math.random().toString(36).slice(2, 9);
  buttonContexts.set(key, { prompt, userId });
  // Evict oldest entries beyond cap
  if (buttonContexts.size > MAX_BUTTON_CONTEXTS) {
    const firstKey = buttonContexts.keys().next().value;
    if (firstKey) buttonContexts.delete(firstKey);
  }
  return key;
}

// ---------------------------------------------------------------------------
// Inline keyboard builder
// ---------------------------------------------------------------------------

function buildInlineKeyboard(
  contextKey: string
): { inline_keyboard: InlineKeyboardButton[][] } {
  return {
    inline_keyboard: [
      [
        { text: "📊 Box Score", callback_data: `sc_boxscore_${contextKey}` },
        { text: "📋 Play-by-Play", callback_data: `sc_pbp_${contextKey}` },
        { text: "📈 Full Stats", callback_data: `sc_stats_${contextKey}` },
      ],
    ],
  };
}

// ---------------------------------------------------------------------------
// Main listener
// ---------------------------------------------------------------------------

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
    provider: (
      process.env.SPORTSCLAW_PROVIDER ||
      process.env.sportsclaw_PROVIDER ||
      "anthropic"
    ) as LLMProvider,
    ...((process.env.SPORTSCLAW_MODEL || process.env.sportsclaw_MODEL) && {
      model: process.env.SPORTSCLAW_MODEL || process.env.sportsclaw_MODEL,
    }),
    ...(process.env.PYTHON_PATH && { pythonPath: process.env.PYTHON_PATH }),
    routingMode: "soft_lock",
    routingMaxSkills: parsePositiveInt(
      process.env.SPORTSCLAW_ROUTING_MAX_SKILLS,
      2
    ),
    routingAllowSpillover: parsePositiveInt(
      process.env.SPORTSCLAW_ROUTING_ALLOW_SPILLOVER,
      1
    ),
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
        `${apiBase}/getUpdates?timeout=30&offset=${offset}&allowed_updates=${encodeURIComponent(JSON.stringify(["message", "callback_query"]))}`,
        { signal: AbortSignal.timeout(60_000) }
      );
      const data = (await res.json()) as TelegramResponse;

      if (!data.ok || !data.result) continue;

      // Advance offset for all received updates immediately
      for (const update of data.result) {
        offset = Math.max(offset, update.update_id + 1);
      }

      // Process updates concurrently to avoid head-of-line blocking
      const tasks = data.result.map((update) => {
        if (update.callback_query) {
          return processCallbackQuery(
            update,
            apiBase,
            engineConfig,
            allowedUsers
          );
        }
        return processMessage(update, apiBase, engineConfig, allowedUsers);
      });
      await Promise.allSettled(tasks);
    } catch (error: unknown) {
      // Network errors during polling — retry after a short delay
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[sportsclaw] Polling error: ${errMsg}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// ---------------------------------------------------------------------------
// Send helpers
// ---------------------------------------------------------------------------

/** Send a message via the Telegram API, with HTML fallback to plain text */
async function sendMessage(
  apiBase: string,
  chatId: number,
  text: string,
  options: {
    parseMode?: "HTML";
    replyToMessageId?: number;
    replyMarkup?: object;
  } = {}
): Promise<boolean> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
  };
  if (options.parseMode) body.parse_mode = options.parseMode;
  if (options.replyToMessageId)
    body.reply_to_message_id = options.replyToMessageId;
  if (options.replyMarkup) body.reply_markup = options.replyMarkup;

  let res = await fetch(`${apiBase}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok && options.parseMode) {
    // Fallback: strip HTML and send as plain text
    const errBody = await res.text();
    console.error(`[sportsclaw] sendMessage (HTML) failed: ${errBody}`);
    res = await fetch(`${apiBase}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.replace(/<[^>]+>/g, ""),
        reply_to_message_id: options.replyToMessageId,
        reply_markup: options.replyMarkup,
      }),
    });
    if (!res.ok) {
      console.error(
        `[sportsclaw] plain text fallback also failed: ${await res.text()}`
      );
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Process a text message
// ---------------------------------------------------------------------------

async function processMessage(
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

    // Format response for Telegram (HTML)
    const formatted = formatResponse(response, "telegram");
    const textToSend = formatted.telegram || formatted.text;

    // Build inline keyboard for game-related responses
    let replyMarkup: object | undefined;
    if (isGameRelatedResponse(response, prompt)) {
      const contextKey = storeButtonContext(prompt, userId);
      replyMarkup = buildInlineKeyboard(contextKey);
    }

    // Telegram has a 4096 char limit — split if needed
    const chunks = splitMessage(textToSend, 4096);
    for (let idx = 0; idx < chunks.length; idx++) {
      await sendMessage(apiBase, msg.chat.id, chunks[idx], {
        parseMode: formatted.telegram ? "HTML" : undefined,
        replyToMessageId: msg.message_id,
        // Attach buttons only to the last chunk
        replyMarkup: idx === chunks.length - 1 ? replyMarkup : undefined,
      });
    }
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[sportsclaw] Telegram error: ${errMsg}`);
    await sendMessage(apiBase, msg.chat.id, "Sorry, I encountered an error processing your request.", {
      replyToMessageId: msg.message_id,
    });
  }
}

// ---------------------------------------------------------------------------
// Process a callback query (button press)
// ---------------------------------------------------------------------------

async function processCallbackQuery(
  update: TelegramUpdate,
  apiBase: string,
  engineConfig: Partial<sportsclawConfig>,
  allowedUsers: Set<string> | null
): Promise<void> {
  const cq = update.callback_query;
  if (!cq?.data || !cq.message) return;

  // Check user whitelist
  if (allowedUsers && !allowedUsers.has(String(cq.from.id))) {
    await fetch(`${apiBase}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: cq.id,
        text: "You don't have permission to use this bot.",
        show_alert: true,
      }),
    });
    return;
  }

  if (!cq.data.startsWith("sc_")) return;

  const parts = cq.data.split("_");
  const action = parts[1]; // boxscore | pbp | stats
  const contextKey = parts[2];

  const ctx = buttonContexts.get(contextKey);
  if (!ctx) {
    await fetch(`${apiBase}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: cq.id,
        text: "This button has expired. Please ask your question again.",
        show_alert: true,
      }),
    });
    return;
  }

  const actionLabels: Record<string, string> = {
    boxscore: "📊 Loading box score...",
    pbp: "📋 Loading play-by-play...",
    stats: "📈 Loading stats...",
  };

  const actionPrompts: Record<string, string> = {
    boxscore: `Use nba_get_live_boxscore to show the detailed box score with all player stats for the game mentioned in: ${ctx.prompt}`,
    pbp: `Use nba_get_live_playbyplay to show the actual game play-by-play events (shots, fouls, timeouts) for the game in: ${ctx.prompt}`,
    stats: `Show comprehensive team and player statistics for: ${ctx.prompt}`,
  };

  const followUpPrompt = actionPrompts[action];
  if (!followUpPrompt) return;

  // Acknowledge the button press
  await fetch(`${apiBase}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: cq.id,
      text: actionLabels[action] || "Loading...",
    }),
  });

  // Send typing indicator
  await fetch(`${apiBase}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: cq.message.chat.id,
      action: "typing",
    }),
  });

  try {
    // Skip fan profile for button follow-ups (data-only requests)
    const engine = new sportsclawEngine({
      ...engineConfig,
      skipFanProfile: true,
    });
    const response = await engine.run(followUpPrompt, { userId: ctx.userId });

    const formatted = formatResponse(response, "telegram");
    const textToSend = formatted.telegram || formatted.text;

    const chunks = splitMessage(textToSend, 4096);
    for (const chunk of chunks) {
      await sendMessage(apiBase, cq.message.chat.id, chunk, {
        parseMode: formatted.telegram ? "HTML" : undefined,
        replyToMessageId: cq.message.message_id,
      });
    }
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[sportsclaw] Callback query error: ${errMsg}`);
    await sendMessage(
      apiBase,
      cq.message.chat.id,
      "Sorry, I encountered an error processing that request.",
      { replyToMessageId: cq.message.message_id }
    );
  }
}
