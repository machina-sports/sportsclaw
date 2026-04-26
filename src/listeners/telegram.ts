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
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { sportsclawEngine } from "../engine.js";
import type { sportsclawConfig } from "../types.js";
import { splitMessage, saveImageToDisk, saveVideoToDisk } from "../utils.js";
import { formatResponse, isGameRelatedResponse } from "../formatters/index.js";
import {
  detectSport, detectLeague, getFilteredButtons, getFollowUpPrompt,
  getSportDisplayName, getQuickActionPrompt, getSportNavRow,
  SPORT_MENU_ROWS, SPORT_QUICK_ACTION_ROWS,
} from "../buttons.js";
import type { DetectedSport, MenuButtonDef } from "../buttons.js";
import {
  AskUserQuestionHalt,
  saveSuspendedState,
  loadSuspendedState,
  clearSuspendedState,
} from "../ask.js";
import {
  getAllowedUsers,
  ButtonContextStore,
  buildListenerEngineConfig,
} from "./shared.js";

const COMMAND_PREFIX = "/claw";

// ---------------------------------------------------------------------------
// Telegram API types
// ---------------------------------------------------------------------------

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    chat: { id: number; type: string };
    text?: string;
    caption?: string;
    photo?: Array<{ file_id: string; width: number; height: number; file_size?: number }>;
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
  inline_query?: {
    id: string;
    from: { id: number; first_name: string };
    query: string;
    offset: string;
  };
}

interface TelegramResponse {
  ok: boolean;
  result: TelegramUpdate[];
}

interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  switch_inline_query?: string;
}

// ---------------------------------------------------------------------------
// Button context store — module-scoped instance shared across the listener.
// ---------------------------------------------------------------------------

const buttonContexts = new ButtonContextStore();

function storeButtonContext(prompt: string, userId: string, sport: DetectedSport): string {
  return buttonContexts.store(prompt, userId, sport);
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
// Unified response markup builder — action buttons + persistent nav row
// ---------------------------------------------------------------------------

/**
 * Build the full inline keyboard for any engine response.
 * - If the response is game-related, prepends sport-specific action buttons
 *   (box score, stats, etc.) as the first row.
 * - Always appends the sport's quick-nav row so users can keep browsing
 *   without typing.
 */
function buildResponseMarkup(
  response: string,
  prompt: string,
  userId: string,
  sport: DetectedSport
): object {
  const rows: InlineKeyboardButton[][] = [];

  if (isGameRelatedResponse(response, prompt)) {
    const contextKey = storeButtonContext(prompt, userId, sport);
    const actionKeyboard = buildInlineKeyboard(contextKey, sport, response, prompt);
    if (actionKeyboard) rows.push(...actionKeyboard.inline_keyboard);
  }

  rows.push(
    getSportNavRow(sport).map((btn) => ({ text: btn.label, callback_data: btn.callback }))
  );

  return { inline_keyboard: rows };
}

// ---------------------------------------------------------------------------
// Sport picker menu helpers
// ---------------------------------------------------------------------------

const WELCOME_TEXT =
  "👋 Welcome to <b>sportsclaw</b>!\n\nPick a sport to get started, or just type any question:";

function buildMenuKeyboard(
  rows: MenuButtonDef[][]
): { inline_keyboard: InlineKeyboardButton[][] } {
  return {
    inline_keyboard: rows.map((row) =>
      row.map((btn) => ({ text: btn.label, callback_data: btn.callback }))
    ),
  };
}

function buildSportPickerKeyboard(): { inline_keyboard: InlineKeyboardButton[][] } {
  return buildMenuKeyboard(SPORT_MENU_ROWS);
}

function buildSportQuickMenu(sport: string): { inline_keyboard: InlineKeyboardButton[][] } | null {
  const rows = SPORT_QUICK_ACTION_ROWS[sport];
  if (!rows) return null;
  return buildMenuKeyboard(rows);
}

async function handleStartCommand(apiBase: string, chatId: number): Promise<void> {
  await sendMessage(apiBase, chatId, WELCOME_TEXT, {
    parseMode: "HTML",
    replyMarkup: buildSportPickerKeyboard(),
  });
}

async function editMessage(
  apiBase: string,
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: object
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await fetch(`${apiBase}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`[sportsclaw] editMessageText failed: ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------------
// Inline query handler — @botname <sport> from any Telegram chat
// ---------------------------------------------------------------------------

async function processInlineQuery(
  update: TelegramUpdate,
  apiBase: string
): Promise<void> {
  const iq = update.inline_query;
  if (!iq) return;

  const query = iq.query.trim().toLowerCase();
  const allSports = SPORT_MENU_ROWS.flat();

  // Filter sports by query text (empty query → show all)
  const filtered = query
    ? allSports.filter(
        (btn) =>
          btn.label.toLowerCase().includes(query) ||
          btn.callback.replace("sc_sport_", "").includes(query) ||
          getSportDisplayName(btn.callback.replace("sc_sport_", ""))
            .toLowerCase()
            .includes(query)
      )
    : allSports;

  const results = filtered.map((btn) => {
    const sport = btn.callback.replace("sc_sport_", "");
    const displayName = getSportDisplayName(sport);
    const quickMenu = buildSportQuickMenu(sport);

    return {
      type: "article",
      id: sport,
      title: btn.label,
      description: `${displayName} — scores, standings, news & more`,
      // Sends this message into whichever chat the user selects
      input_message_content: {
        message_text: `${btn.label} — what would you like to know?`,
        parse_mode: "HTML",
      },
      // The sent message includes the sport's quick action buttons
      reply_markup: quickMenu ?? undefined,
      // Small icon so results look clean in the inline list
      thumb_width: 48,
      thumb_height: 48,
    };
  });

  await fetch(`${apiBase}/answerInlineQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      inline_query_id: iq.id,
      results: results.slice(0, 50),
      cache_time: 300, // Cache results for 5 minutes
      is_personal: false,
    }),
  }).catch((err) => {
    console.error(`[sportsclaw] answerInlineQuery failed: ${err}`);
  });
}

// ---------------------------------------------------------------------------
// Welcome-on-reconnect — notify all known private-chat users
// ---------------------------------------------------------------------------

async function sendWelcomeToKnownUsers(apiBase: string): Promise<void> {
  const memoryDir =
    process.env.SPORTSCLAW_MEMORY_DIR ||
    join(homedir(), ".sportsclaw", "memory");

  if (!existsSync(memoryDir)) return;

  let entries: string[];
  try {
    entries = readdirSync(memoryDir);
  } catch {
    return;
  }

  // Find all telegram-<numericId> directories (private chat users only)
  const telegramUserIds = entries
    .filter((e) => /^telegram-\d+$/.test(e))
    .map((e) => parseInt(e.replace("telegram-", ""), 10))
    .filter((id) => !isNaN(id));

  if (telegramUserIds.length === 0) return;

  console.log(
    `[sportsclaw] Sending welcome to ${telegramUserIds.length} known user(s)...`
  );

  for (const chatId of telegramUserIds) {
    try {
      await sendMessage(
        apiBase,
        chatId,
        "✅ sportsclaw is back!\n\n" + WELCOME_TEXT,
        { parseMode: "HTML", replyMarkup: buildSportPickerKeyboard() }
      );
    } catch {
      // User may have blocked the bot — ignore silently
    }
    // Respect Telegram rate limits: 1 msg/sec to different chats
    await new Promise((r) => setTimeout(r, 1000));
  }
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

  const engineConfig: Partial<sportsclawConfig> = buildListenerEngineConfig();

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
    delete process.env.SPORTSCLAW_RESTART_CHAT_ID;
    // Send welcome + sport picker to all known users on reconnect
    if (process.env.SPORTSCLAW_BROADCAST_ON_STARTUP === "true") {
      sendWelcomeToKnownUsers(apiBase).catch((e) =>
        console.error("[sportsclaw] Welcome broadcast failed:", e)
      );
    }
  }

  // Mark boot time — ignore any messages sent before this to prevent
  // restart loops (the old "restart" command would otherwise be reprocessed).
  const bootEpoch = Math.floor(Date.now() / 1000);

  // Flush stale updates so we don't re-process messages from before this
  // startup (e.g. the "restart" command that triggered a respawn).
  let offset = 0;
  try {
    const flushRes = await fetch(
      `${apiBase}/getUpdates?offset=-1&timeout=0`,
      { signal: AbortSignal.timeout(10_000) }
    );
    const flushData = (await flushRes.json()) as TelegramResponse;
    if (flushData.ok && flushData.result?.length) {
      offset = flushData.result[flushData.result.length - 1].update_id + 1;
    }
  } catch {
    // Non-critical — worst case the date guard catches stale messages
  }

  // Long-polling loop
  while (true) {
    try {
      const res = await fetch(
        `${apiBase}/getUpdates?timeout=30&offset=${offset}&allowed_updates=${encodeURIComponent(JSON.stringify(["message", "callback_query", "inline_query"]))}`,
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
        if (update.inline_query) {
          return processInlineQuery(update, apiBase);
        }
        return processMessage(update, apiBase, engineConfig, allowedUsers, bootEpoch);
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

// ---------------------------------------------------------------------------
// Extract Images (Inbound Vision)
// ---------------------------------------------------------------------------
async function extractImages(msg: any, apiBase: string): Promise<import("../types.js").ImageAttachment[]> {
  if (!msg.photo || msg.photo.length === 0) return [];
  
  // Get the largest photo size (last element in the array)
  const largestPhoto = msg.photo[msg.photo.length - 1];
  const fileId = largestPhoto.file_id;
  
  try {
    // 1. Get file path
    const fileRes = await fetch(`${apiBase}/getFile?file_id=${fileId}`);
    if (!fileRes.ok) return [];
    const fileData = await fileRes.json() as any;
    if (!fileData.ok || !fileData.result.file_path) return [];
    
    // 2. Download file bytes
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileData.result.file_path}`;
    const dlRes = await fetch(fileUrl);
    if (!dlRes.ok) return [];
    
    const arrayBuffer = await dlRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    return [{
      data: buffer.toString("base64"),
      mimeType: "image/jpeg"
    }];
  } catch (error) {
    console.error("[sportsclaw] Failed to extract Telegram image:", error);
    return [];
  }
}

// Send generated images/videos via Telegram API
// ---------------------------------------------------------------------------

async function sendGeneratedVideos(
  engine: sportsclawEngine,
  apiBase: string,
  chatId: number,
  replyToMessageId?: number
): Promise<void> {
  for (const vid of engine.generatedVideos) {
    const buffer = Buffer.from(vid.data, "base64");
    const blob = new Blob([buffer], { type: vid.mimeType });
    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    formData.append("video", blob, `sportsclaw_generated.mp4`);
    if (replyToMessageId) {
      formData.append("reply_to_message_id", String(replyToMessageId));
    }
    await fetch(`${apiBase}/sendVideo`, {
      method: "POST",
      body: formData,
    }).catch((err) => {
      console.error(`[sportsclaw] Failed to send generated video to Telegram:\n`, err);
    });
    // Persist locally
    saveVideoToDisk(vid.data).catch(() => {});
  }
}

async function sendGeneratedImages(
  engine: sportsclawEngine,
  apiBase: string,
  chatId: number,
  replyToMessageId?: number
): Promise<void> {
  for (const img of engine.generatedImages) {
    const buffer = Buffer.from(img.data, "base64");
    const ext = img.mimeType === "image/jpeg" ? "jpg" : "png";
    const blob = new Blob([buffer], { type: img.mimeType });
    const formData = new FormData();
    formData.append("chat_id", String(chatId));
    formData.append("photo", blob, `sportsclaw_generated.${ext}`);
    if (replyToMessageId) {
      formData.append("reply_to_message_id", String(replyToMessageId));
    }
    await fetch(`${apiBase}/sendPhoto`, {
      method: "POST",
      body: formData,
    }).catch((err) => {
      console.error(`[sportsclaw] Failed to send generated image: ${err instanceof Error ? err.message : err}`);
    });
    // Persist locally
    saveImageToDisk(img.data, img.mimeType).catch(() => {});
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
  allowedUsers: Set<string> | null,
  bootEpoch: number
): Promise<void> {
  const msg = update.message;
  if (!msg?.text && !msg?.photo) return;

  // Ignore messages sent before this process started — prevents restart loops
  if (msg.date < bootEpoch) return;

  // Check user whitelist
  if (allowedUsers && msg.from && !allowedUsers.has(String(msg.from.id)))
    return;

  let prompt: string | null = null;

  // In private chats, respond to all messages
  if (msg.chat.type === "private") {
    prompt = msg.text || msg.caption || "";
  }

  // In groups, respond to /claw commands
  if (!prompt && msg.text && msg.text.startsWith(COMMAND_PREFIX)) {
    prompt = msg.text.slice(COMMAND_PREFIX.length).trim();
  }

  if (!prompt) return;


  // /start, /menu, or "menu" — show sport picker without running the engine
  if (
    prompt === "/start" ||
    prompt === "/menu" ||
    prompt.toLowerCase() === "menu"
  ) {
    await handleStartCommand(apiBase, msg.chat.id);
    return;
  }

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
    const images = await extractImages(msg, apiBase);
      const engine = new sportsclawEngine(engineConfig);
    const response = await engine.run(prompt, { userId, sessionId: userId, images: images.length > 0 ? images : undefined });

    // Format response for Telegram (HTML)
    const formatted = formatResponse(response, "telegram");
    const textToSend = formatted.telegram || formatted.text;

    const sport = detectSport(response, prompt);
    const replyMarkup = sport ? buildResponseMarkup(response, prompt, userId, sport) : undefined;

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
    await sendGeneratedImages(engine, apiBase, msg.chat.id, msg.message_id);
    await sendGeneratedVideos(engine, apiBase, msg.chat.id, msg.message_id);
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

      const resumeSport = detectSport(response, suspended.originalPrompt);
      const resumeReplyMarkup = resumeSport
        ? buildResponseMarkup(response, suspended.originalPrompt, userId, resumeSport)
        : undefined;

      for (let idx = 0; idx < chunks.length; idx++) {
        await sendMessage(apiBase, cqMessage.chat.id, chunks[idx], {
          parseMode: formatted.telegram ? "HTML" : undefined,
          replyToMessageId: cqMessage.message_id,
          replyMarkup: idx === chunks.length - 1 ? resumeReplyMarkup : undefined,
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

  // sc_menu — navigate back to top-level sport picker
  if (cq.data === "sc_menu") {
    await fetch(`${apiBase}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: cq.id }),
    });
    await editMessage(
      apiBase,
      cqMessage.chat.id,
      cqMessage.message_id,
      WELCOME_TEXT,
      buildSportPickerKeyboard()
    );
    return;
  }

  // sc_sport_<sport> — show quick action menu for selected sport
  if (cq.data.startsWith("sc_sport_")) {
    const sport = cq.data.slice("sc_sport_".length);
    await fetch(`${apiBase}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: cq.id }),
    });
    const quickMenu = buildSportQuickMenu(sport);
    const label = getSportDisplayName(sport);
    await editMessage(
      apiBase,
      cqMessage.chat.id,
      cqMessage.message_id,
      `<b>${label}</b> — what would you like to know?`,
      quickMenu ?? undefined
    );
    return;
  }

  // sc_qa_<sport>_<action> — fire a quick action engine prompt
  if (cq.data.startsWith("sc_qa_")) {
    const withoutPrefix = cq.data.slice("sc_qa_".length);
    const underscoreIdx = withoutPrefix.indexOf("_");
    if (underscoreIdx < 0) return;
    const sport = withoutPrefix.slice(0, underscoreIdx);
    const action = withoutPrefix.slice(underscoreIdx + 1);
    const followUp = getQuickActionPrompt(sport, action);
    if (!followUp) return;

    await fetch(`${apiBase}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: cq.id, text: "Loading..." }),
    });

    const sendTypingQA = () =>
      fetch(`${apiBase}/sendChatAction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: cqMessage.chat.id, action: "typing" }),
      }).catch(() => {});
    await sendTypingQA();
    const typingIntervalQA = setInterval(sendTypingQA, 4000);

    const userId = `telegram-${cq.from.id}`;
    try {
      const engine = new sportsclawEngine({ ...engineConfig, skipFanProfile: true });
      const response = await engine.run(followUp, { userId, sessionId: userId });

      const formatted = formatResponse(response, "telegram");
      const textToSend = formatted.telegram || formatted.text;
      const chunks = splitMessage(textToSend, 4096);

      const qaSport = detectSport(response, followUp);
      const qaReplyMarkup = qaSport
        ? buildResponseMarkup(response, followUp, userId, qaSport)
        : undefined;

      for (let idx = 0; idx < chunks.length; idx++) {
        await sendMessage(apiBase, cqMessage.chat.id, chunks[idx], {
          parseMode: formatted.telegram ? "HTML" : undefined,
          replyMarkup: idx === chunks.length - 1 ? qaReplyMarkup : undefined,
        });
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[sportsclaw] Quick action error: ${errMsg}`);
      await sendMessage(apiBase, cqMessage.chat.id, "Sorry, I encountered an error processing that request.");
    } finally {
      clearInterval(typingIntervalQA);
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

    // Show nav row so the user can keep browsing after a drill-down
    const followUpMarkup = ctx.sport
      ? buildResponseMarkup(response, followUpPrompt, ctx.userId, ctx.sport)
      : undefined;

    for (let idx = 0; idx < chunks.length; idx++) {
      await sendMessage(apiBase, cqMessage.chat.id, chunks[idx], {
        parseMode: formatted.telegram ? "HTML" : undefined,
        replyToMessageId: cqMessage.message_id,
        replyMarkup: idx === chunks.length - 1 ? followUpMarkup : undefined,
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
