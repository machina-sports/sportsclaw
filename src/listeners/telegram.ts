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

import { spawn } from "node:child_process";
import { sportsclawEngine } from "../engine.js";
import type { LLMProvider, sportsclawConfig } from "../types.js";
import { splitMessage } from "../utils.js";
import { formatResponse, isGameRelatedResponse } from "../formatters/index.js";
import { detectSport, detectLeague, getFilteredButtons, getFollowUpPrompt } from "../buttons.js";
import type { DetectedSport } from "../buttons.js";
import {
  AskUserQuestionHalt,
  saveSuspendedState,
  loadSuspendedState,
  clearSuspendedState,
} from "../ask.js";

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
  sport: DetectedSport;
}

const buttonContexts = new Map<string, ButtonContext>();
const MAX_BUTTON_CONTEXTS = 200;

function storeButtonContext(prompt: string, userId: string, sport: DetectedSport): string {
  const key = Math.random().toString(36).slice(2, 9);
  buttonContexts.set(key, { prompt, userId, sport });
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
  contextKey: string,
  sport: DetectedSport,
  response: string,
  prompt: string
): { inline_keyboard: InlineKeyboardButton[][] } | null {
  const league = detectLeague(response, prompt);
  const buttons = getFilteredButtons(sport, league);
  if (buttons.length === 0) return null;
  return {
    inline_keyboard: [
      buttons.map((b) => ({
        text: b.label,
        callback_data: `sc_${b.action}_${contextKey}`,
      })),
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

  if (process.env.SPORTSCLAW_RESTART_CHAT_ID) {
    try {
      const restartChatId = parseInt(process.env.SPORTSCLAW_RESTART_CHAT_ID, 10);
      await sendMessage(apiBase, restartChatId, "✅ I'm back. New configs loaded.");
      console.log(`[sportsclaw] Sent restart confirmation to ${restartChatId}`);
    } catch (e) {
      console.error("[sportsclaw] Failed to send restart confirmation:", e);
    }
    delete process.env.SPORTSCLAW_RESTART_CHAT_ID;
  }

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


  if (prompt.toLowerCase() === "restart" || prompt.toLowerCase() === "/restart" || prompt.toLowerCase() === "/claw restart") {
    await sendMessage(apiBase, msg.chat.id, "🔄 Restarting Telegram daemon to apply new configurations...", {
      replyToMessageId: msg.message_id,
    });
    console.log("[sportsclaw] Restart triggered via Telegram chat.");
    const child = spawn(process.execPath, [process.argv[1], "restart", "telegram"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, SPORTSCLAW_RESTART_CHAT_ID: msg.chat.id.toString() }
    });
    child.unref();
    setTimeout(() => process.exit(0), 100);
    return;
  }

  // Send "typing" action and keep it alive every 4s (Telegram expires after 5s)
  const sendTyping = () =>
    fetch(`${apiBase}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: msg.chat.id, action: "typing" }),
    }).catch(() => {});
  await sendTyping();
  const typingInterval = setInterval(sendTyping, 4000);

  // Use the Telegram user ID for memory isolation
  const userId = `telegram-${msg.from?.id ?? msg.chat.id}`;

  try {
    // Fresh engine per request — session state lives in the global SessionStore
    const engine = new sportsclawEngine(engineConfig);
    const response = await engine.run(prompt, { userId, sessionId: userId });

    // Format response for Telegram (HTML)
    const formatted = formatResponse(response, "telegram");
    const textToSend = formatted.telegram || formatted.text;

    // Build inline keyboard for game-related responses with supported data
    let replyMarkup: object | undefined;
    if (isGameRelatedResponse(response, prompt)) {
      const sport = detectSport(response, prompt);
      const contextKey = storeButtonContext(prompt, userId, sport);
      const keyboard = buildInlineKeyboard(contextKey, sport, response, prompt);
      if (keyboard) {
        replyMarkup = keyboard;
      }
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
    // Sprint 2: AskUserQuestion — render options as Telegram inline keyboard
    if (error instanceof AskUserQuestionHalt) {
      const q = error.question;
      const stateKey = Math.random().toString(36).slice(2, 9);

      // Persist state so the callback handler can resume
      await saveSuspendedState(
        {
          platform: "telegram",
          userId,
          question: q,
          createdAt: new Date().toISOString(),
          originalPrompt: prompt,
        },
        stateKey
      );

      // Build inline keyboard from question options
      const keyboard: InlineKeyboardButton[][] = [
        q.options.map((opt, idx) => ({
          text: opt.label,
          callback_data: `sc_ask_${stateKey}_${idx}`,
        })),
      ];

      await sendMessage(apiBase, msg.chat.id, q.prompt, {
        replyToMessageId: msg.message_id,
        replyMarkup: { inline_keyboard: keyboard },
      });
      return;
    }

    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[sportsclaw] Telegram error: ${errMsg}`);
    await sendMessage(apiBase, msg.chat.id, "Sorry, I encountered an error processing your request.", {
      replyToMessageId: msg.message_id,
    });
  } finally {
    clearInterval(typingInterval);
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
  const cqMessage = cq.message;

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

  // Sprint 2: AskUserQuestion callback handling
  // Format: sc_ask_<stateKey>_<optionIndex>
  if (cq.data.startsWith("sc_ask_")) {
    const askParts = cq.data.split("_");
    const stateKey = askParts[2];
    const optionIdx = parseInt(askParts[3], 10);
    const userId = `telegram-${cq.from.id}`;
    const suspended = await loadSuspendedState("telegram", userId, stateKey);

    if (!suspended) {
      await fetch(`${apiBase}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callback_query_id: cq.id,
          text: "This question has expired. Please ask again.",
          show_alert: true,
        }),
      });
      return;
    }

    const selectedOption = suspended.question.options[optionIdx];
    if (!selectedOption) return;

    await clearSuspendedState("telegram", userId, stateKey);

    await fetch(`${apiBase}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: cq.id, text: "Loading..." }),
    });

    const sendTyping = () =>
      fetch(`${apiBase}/sendChatAction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: cqMessage.chat.id, action: "typing" }),
      }).catch(() => {});
    await sendTyping();
    const typingInterval = setInterval(sendTyping, 4000);

    try {
      const resumePrompt = `${suspended.originalPrompt}\n\n[User selected: ${selectedOption.value}]`;
      const engine = new sportsclawEngine(engineConfig);
      const response = await engine.run(resumePrompt, { userId, sessionId: userId });

      const formatted = formatResponse(response, "telegram");
      const textToSend = formatted.telegram || formatted.text;

      const chunks = splitMessage(textToSend, 4096);
      for (const chunk of chunks) {
        await sendMessage(apiBase, cqMessage.chat.id, chunk, {
          parseMode: formatted.telegram ? "HTML" : undefined,
          replyToMessageId: cqMessage.message_id,
        });
      }
    } catch (resumeErr: unknown) {
      const errMsg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
      console.error(`[sportsclaw] AskUserQuestion resume error: ${errMsg}`);
      await sendMessage(apiBase, cqMessage.chat.id, "Sorry, I encountered an error processing your selection.", {
        replyToMessageId: cqMessage.message_id,
      });
    } finally {
      clearInterval(typingInterval);
    }
    return;
  }

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

  const followUpPrompt = getFollowUpPrompt(action, ctx.sport, ctx.prompt);
  if (!followUpPrompt) return;

  // Acknowledge the button press
  await fetch(`${apiBase}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: cq.id,
      text: "Loading...",
    }),
  });

  // Send typing indicator and keep it alive every 4s
  const sendTyping = () =>
    fetch(`${apiBase}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: cqMessage.chat.id, action: "typing" }),
    }).catch(() => {});
  await sendTyping();
  const typingInterval = setInterval(sendTyping, 4000);

  try {
    // Skip fan profile for button follow-ups (data-only requests)
    const engine = new sportsclawEngine({
      ...engineConfig,
      skipFanProfile: true,
    });
    const response = await engine.run(followUpPrompt, { userId: ctx.userId, sessionId: ctx.userId });

    const formatted = formatResponse(response, "telegram");
    const textToSend = formatted.telegram || formatted.text;

    const chunks = splitMessage(textToSend, 4096);
    for (const chunk of chunks) {
      await sendMessage(apiBase, cqMessage.chat.id, chunk, {
        parseMode: formatted.telegram ? "HTML" : undefined,
        replyToMessageId: cqMessage.message_id,
      });
    }
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[sportsclaw] Callback query error: ${errMsg}`);
    await sendMessage(
      apiBase,
      cqMessage.chat.id,
      "Sorry, I encountered an error processing that request.",
      { replyToMessageId: cqMessage.message_id }
    );
  } finally {
    clearInterval(typingInterval);
  }
}
