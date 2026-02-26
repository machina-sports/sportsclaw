#!/usr/bin/env node
/**
 * sportsclaw Engine — CLI Entry Point
 *
 * Subcommands:
 *   sportsclaw add <sport>       — Inject a sport schema from the Python package
 *   sportsclaw remove <sport>    — Remove a previously added sport schema
 *   sportsclaw list              — List all installed sport schemas
 *   sportsclaw init              — Bootstrap all 14 default sport schemas
 *   sportsclaw chat              — Start an interactive conversation (REPL)
 *   sportsclaw doctor            — Check setup and diagnose issues
 *   sportsclaw listen <platform> — Start a Discord or Telegram listener
 *   sportsclaw "<prompt>"        — Run a one-shot query (default)
 *
 * Or import as a library:
 *   import { sportsclawEngine } from "sportsclaw-engine-core";
 *   const engine = new sportsclawEngine();
 *   const answer = await engine.run("What are today's NBA scores?");
 */

import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { Marked, type MarkedExtension } from "marked";
import { markedTerminal } from "marked-terminal";
import { sportsclawEngine } from "./engine.js";
import { MemoryManager } from "./memory.js";
import {
  fetchSportSchema,
  saveSchema,
  removeSchema,
  listSchemas,
  getSchemaDir,
  bootstrapDefaultSchemas,
  ensureSportsSkills,
  DEFAULT_SKILLS,
} from "./schema.js";
import type { LLMProvider, ToolProgressEvent } from "./types.js";
import {
  loadConfig,
  saveConfig,
  resolveConfig,
  applyConfigToEnv,
  runConfigFlow,
  runSportSelectionFlow,
  ASCII_LOGO,
} from "./config.js";
import { buildSportsSkillsRepairCommand } from "./python.js";

// ---------------------------------------------------------------------------
// Re-exports for library usage
// ---------------------------------------------------------------------------

export { sportsclawEngine } from "./engine.js";
export {
  TOOL_SPECS,
  ToolRegistry,
  executePythonBridge,
} from "./tools.js";
export type { ToolCallInput, ToolCallResult } from "./tools.js";
export {
  fetchSportSchema,
  saveSchema,
  removeSchema,
  listSchemas,
  loadAllSchemas,
  bootstrapDefaultSchemas,
  ensureSportsSkills,
  DEFAULT_SKILLS,
  SKILL_DESCRIPTIONS,
  getInstalledVsAvailable,
} from "./schema.js";
export { MemoryManager, getMemoryDir } from "./memory.js";
export {
  loadConfig,
  saveConfig,
  resolveConfig,
  applyConfigToEnv,
  runConfigFlow,
  runSportSelectionFlow,
  SPORTS_SKILLS_DISCLAIMER,
} from "./config.js";
export type { CLIConfig, ResolvedConfig } from "./config.js";
export type {
  LLMProvider,
  sportsclawConfig,
  RunOptions,
  ToolProgressEvent,
  ToolSpec,
  PythonBridgeResult,
  TurnResult,
  SportSchema,
  SportToolDef,
} from "./types.js";

// ---------------------------------------------------------------------------
// Markdown terminal renderer
// ---------------------------------------------------------------------------

const terminalExt = markedTerminal({
  strong: pc.bold,
  em: pc.italic,
  heading: pc.bold,
  firstHeading: pc.bold,
  codespan: pc.yellow,
  code: pc.yellow,
  del: pc.strikethrough,
  link: pc.cyan,
  href: pc.underline,
}) as MarkedExtension;

// Patch: marked-terminal's `text` renderer doesn't parse inline tokens
// (strong, em, etc.) inside non-loose list items. Override it so bold works
// everywhere, not just in paragraphs.
const origTextRenderer = (terminalExt as { renderer: Record<string, Function> }).renderer.text;
(terminalExt as { renderer: Record<string, Function> }).renderer.text = function (
  this: { parser: { parseInline(tokens: unknown[]): string } },
  token: string | { tokens?: unknown[]; text: string },
) {
  if (typeof token === "object" && token.tokens) {
    return this.parser.parseInline(token.tokens);
  }
  return origTextRenderer.call(this, token);
};

const md = new Marked(terminalExt);

function renderMarkdown(text: string): string {
  const rendered = md.parse(text);
  if (typeof rendered !== "string") return text;
  // marked-terminal adds a trailing newline; trim to avoid double-spacing
  return rendered.replace(/\n+$/, "");
}

// ---------------------------------------------------------------------------
// Update check (chat startup)
// ---------------------------------------------------------------------------

function parseVersion(version: string): [number, number, number] | null {
  const cleaned = version.trim().replace(/^v/, "").split("-")[0];
  const parts = cleaned.split(".");
  if (parts.length < 1 || parts.length > 3) return null;
  const nums: number[] = [];
  for (let i = 0; i < 3; i++) {
    const raw = parts[i] ?? "0";
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  return [nums[0], nums[1], nums[2]];
}

function isVersionNewer(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  if (!l || !c) return false;
  for (let i = 0; i < 3; i++) {
    if (l[i] > c[i]) return true;
    if (l[i] < c[i]) return false;
  }
  return false;
}

async function getCurrentCliVersion(): Promise<string | undefined> {
  try {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const raw = await readFile(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version;
  } catch {
    return undefined;
  }
}

async function getLatestCliVersion(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "npm",
      ["view", "sportsclaw-engine-core", "version", "--json"],
      {
        encoding: "utf-8",
        timeout: 5_000,
      },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const out = (stdout ?? "").trim();
        if (!out) {
          resolve(undefined);
          return;
        }
        try {
          const parsed = JSON.parse(out);
          resolve(typeof parsed === "string" ? parsed : undefined);
        } catch {
          resolve(out.replace(/^"|"$/g, ""));
        }
      }
    );
  });
}

async function upgradeCliToLatest(): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      "npm",
      ["install", "-g", "sportsclaw-engine-core@latest"],
      {
        encoding: "utf-8",
        timeout: 180_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            error: (stderr || stdout || error.message).trim(),
          });
          return;
        }
        resolve({ ok: true });
      }
    );
  });
}

async function maybePromptForCliUpgrade(): Promise<void> {
  const [currentVersion, latestVersion] = await Promise.all([
    getCurrentCliVersion(),
    getLatestCliVersion(),
  ]);

  if (!currentVersion || !latestVersion) return;
  if (!isVersionNewer(latestVersion, currentVersion)) return;

  const confirmUpgrade = await p.confirm({
    message: `Update available: ${currentVersion} → ${latestVersion}. Upgrade now?`,
    initialValue: true,
  });

  if (p.isCancel(confirmUpgrade) || !confirmUpgrade) return;

  const s = p.spinner();
  s.start(`Upgrading sportsclaw to ${latestVersion}...`);
  const result = await upgradeCliToLatest();
  if (result.ok) {
    s.stop(`Upgrade complete. Restart chat to use v${latestVersion}.`);
    return;
  }
  s.stop("Upgrade failed.");
  console.log("Run manually: npm install -g sportsclaw-engine-core@latest");
  if (result.error) {
    console.error(result.error);
  }
}

// ---------------------------------------------------------------------------
// Tool progress tracker for spinner display
// ---------------------------------------------------------------------------

interface ToolState {
  label: string;
  skillName?: string;
  status: "running" | "done" | "failed";
  durationMs?: number;
}

type TrackerPhase = "thinking" | "tools" | "synthesizing";
type SpinnerLike = { message(msg?: string): void };

/** Format a tool name for display: strip the skill prefix for brevity */
function toolLabel(toolName: string, skillName?: string): string {
  if (skillName) {
    // e.g. "football_get_team_schedule" → "get_team_schedule" when skill is "football"
    const prefix = skillName.replace(/-/g, "_") + "_";
    if (toolName.startsWith(prefix)) {
      return toolName.slice(prefix.length);
    }
  }
  return toolName;
}

function formatElapsed(ms: number): string {
  const safeMs = Math.max(0, ms);
  const totalSeconds = Math.floor(safeMs / 1000);
  if (totalSeconds < 60) {
    return `${(safeMs / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function isAbortError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof Error) {
    const name = error.name.toLowerCase();
    const msg = error.message.toLowerCase();
    return (
      name.includes("abort") ||
      name.includes("cancel") ||
      msg.includes("abort") ||
      msg.includes("cancel")
    );
  }
  return String(error).toLowerCase().includes("abort");
}

function clearPostSubmitEchoLine(): void {
  if (!process.stdout.isTTY) return;
  // When switching from readline to raw-mode, some terminals re-echo the
  // submitted input on a NEW line. We need to:
  //   1. Clear the current (possibly empty) line
  //   2. Move up one line and clear the re-echoed text
  //   3. Return the cursor to the start of that line
  process.stdout.write("\x1b[2K\x1b[1A\x1b[2K\r");
}

function setupEscCancellation() {
  const abortController = new AbortController();
  const stdin = process.stdin;
  let cancelled = false;
  const canRawMode = stdin.isTTY && typeof stdin.setRawMode === "function";
  const wasRaw = canRawMode ? Boolean(stdin.isRaw) : false;
  let listening = false;

  const onData = (chunk: Buffer | string) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    // Treat only a lone ESC byte as cancellation. Ignore arrow keys/paste sequences.
    if (buf.length !== 1 || buf[0] !== 0x1b || cancelled) return;
    cancelled = true;
    abortController.abort();
  };

  if (stdin.isTTY) {
    stdin.on("data", onData);
    listening = true;
    if (canRawMode && !wasRaw) {
      stdin.setRawMode(true);
    }
    stdin.resume();
  }

  return {
    abortSignal: abortController.signal,
    showCancelHint: listening,
    wasCancelled: () => cancelled || abortController.signal.aborted,
    cleanup: () => {
      if (listening) {
        stdin.off("data", onData);
      }
      if (canRawMode && !wasRaw && stdin.isRaw) {
        stdin.setRawMode(false);
      }
    },
  };
}

function createToolTracker(
  spinner: SpinnerLike,
  options?: { showCancelHint?: boolean }
) {
  const tools = new Map<string, ToolState>();
  const startedAt = Date.now();
  let phase: TrackerPhase = "thinking";
  let ticker: ReturnType<typeof setInterval> | undefined;
  const showCancelHint = options?.showCancelHint ?? false;

  // @clack spinner renders: `${frame}  ${message}` (icon + 2 spaces)
  // Subsequent lines in a multi-line message need 3 chars to align.
  const PAD = "   ";

  function formatMultiline(lines: string[]): string {
    if (lines.length === 0) return "";
    return lines
      .map((line, idx) => (idx === 0 ? line : `${PAD}${line}`))
      .join("\n");
  }

  function formatLine(t: ToolState): string {
    const skill = t.skillName ? `sports-skills/${t.skillName}` : "agent";
    if (t.status === "running") {
      return `${pc.dim("\u25CB")} ${skill}: ${t.label}...`;
    }
    const sec = t.durationMs != null ? ` ${(t.durationMs / 1000).toFixed(1)}s` : "";
    const icon = t.status === "done" ? pc.green("\u2713") : pc.red("\u2717");
    return `${icon} ${skill}: ${t.label}${sec}`;
  }

  function headerLine(): string {
    const cancelHint = showCancelHint ? " · Press Esc to cancel" : "";
    return pc.dim(`Elapsed ${formatElapsed(Date.now() - startedAt)}${cancelHint}`);
  }

  function render() {
    const entries = Array.from(tools.values());
    const done = entries.filter(t => t.status !== "running");
    const running = entries.filter(t => t.status === "running");

    const bodyLines: string[] = [];
    if (entries.length === 0) {
      bodyLines.push(
        phase === "synthesizing" ? pc.dim("Synthesizing...") : pc.dim("Thinking...")
      );
    } else {
      const all = [...done, ...running];
      for (let i = 0; i < all.length; i++) {
        bodyLines.push(formatLine(all[i]));
      }
      if (phase === "synthesizing") {
        bodyLines.push(pc.dim("Synthesizing..."));
      }
    }

    spinner.message(formatMultiline([headerLine(), ...bodyLines]));
  }

  function stopTicker() {
    if (ticker) {
      clearInterval(ticker);
      ticker = undefined;
    }
  }

  function start() {
    render();
    ticker = setInterval(render, 100);
  }

  function buildFinalLines(prefix: string): string {
    stopTicker();
    const entries = Array.from(tools.values());
    const lines = [`${prefix} (${formatElapsed(Date.now() - startedAt)}).`];
    if (entries.length === 0) return formatMultiline(lines);

    for (let i = 0; i < entries.length; i++) {
      const t = entries[i];
      const sec = t.durationMs != null ? ` ${(t.durationMs / 1000).toFixed(1)}s` : "";
      const icon = t.status === "done" ? pc.green("\u2713") : t.status === "failed" ? pc.red("\u2717") : "\u2026";
      const skill = t.skillName ? `sports-skills/${t.skillName}` : "agent";
      lines.push(`${icon} ${skill}: ${t.label}${sec}`);
    }
    return formatMultiline(lines);
  }

  const handler = (event: ToolProgressEvent) => {
    switch (event.type) {
      case "tool_start":
        phase = "tools";
        tools.set(event.toolCallId, {
          label: toolLabel(event.toolName, event.skillName),
          skillName: event.skillName,
          status: "running",
        });
        render();
        break;
      case "tool_finish":
        tools.set(event.toolCallId, {
          label: toolLabel(event.toolName, event.skillName),
          skillName: event.skillName,
          status: event.success ? "done" : "failed",
          durationMs: event.durationMs,
        });
        render();
        break;
      case "synthesizing":
        phase = "synthesizing";
        render();
        break;
    }
  };

  return {
    start,
    stop: stopTicker,
    handler,
    doneSummary: () => buildFinalLines("Done"),
    errorSummary: () => buildFinalLines("Failed"),
    cancelledSummary: () => buildFinalLines("Cancelled"),
  };
}

// ---------------------------------------------------------------------------
// CLI: `sportsclaw add <sport>`
// ---------------------------------------------------------------------------

async function cmdAdd(args: string[]): Promise<void> {
  const sport = args[0];
  if (!sport) {
    console.error("Usage: sportsclaw add <sport>");
    console.error("Example: sportsclaw add nfl");
    process.exit(1);
  }

  const { pythonPath } = resolveConfig();
  console.log(`Fetching schema for "${sport}"...`);

  try {
    const schema = await fetchSportSchema(sport, { pythonPath });
    saveSchema(schema);
    console.log(`Successfully added "${sport}" (${schema.tools.length} tools):`);
    for (const tool of schema.tools) {
      console.log(`  - ${tool.name}: ${tool.description.slice(0, 80)}`);
    }
    console.log(`\nSchema saved to ${getSchemaDir()}/${sport}.json`);
    console.log("The agent will now use these tools automatically.");
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error("Failed to add sport schema:", error);
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// CLI: `sportsclaw remove <sport>`
// ---------------------------------------------------------------------------

function cmdRemove(args: string[]): void {
  const sport = args[0];
  if (!sport) {
    console.error("Usage: sportsclaw remove <sport>");
    process.exit(1);
  }

  if (removeSchema(sport)) {
    console.log(`Removed schema for "${sport}".`);
  } else {
    console.error(`No schema found for "${sport}".`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// CLI: `sportsclaw list`
// ---------------------------------------------------------------------------

function cmdList(): void {
  const schemas = listSchemas();
  if (schemas.length === 0) {
    console.log("No sport schemas installed.");
    console.log('Add one with: sportsclaw add <sport>');
    return;
  }
  console.log(`Installed sport schemas (${schemas.length}):`);
  for (const name of schemas) {
    console.log(`  - ${name}`);
  }
  console.log(`\nSchema directory: ${getSchemaDir()}`);
}

// ---------------------------------------------------------------------------
// CLI: `sportsclaw doctor` — diagnose and fix common issues
// ---------------------------------------------------------------------------

async function cmdDoctor(): Promise<void> {
  const { pythonPath, provider, model, apiKey } = resolveConfig();
  let allGood = true;

  console.log(pc.bold("sportsclaw doctor\n"));

  // 1. Node.js version
  const nodeVersion = process.versions.node;
  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0], 10);
  if (nodeMajor >= 18) {
    console.log(pc.green("  ✓") + ` Node.js ${nodeVersion}`);
  } else {
    console.log(pc.red("  ✗") + ` Node.js ${nodeVersion} — v18+ required`);
    allGood = false;
  }

  // 2. Python reachable
  let pythonVersion = "";
  try {
    pythonVersion = await new Promise<string>((resolve, reject) => {
      execFile(pythonPath, ["--version"], { timeout: 5_000 }, (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve((stdout || stderr).trim());
      });
    });
    console.log(pc.green("  ✓") + ` ${pythonVersion} (${pythonPath})`);
  } catch {
    console.log(pc.red("  ✗") + ` Python not found at ${pythonPath}`);
    console.log(`    Set PYTHON_PATH or run: sportsclaw config`);
    allGood = false;
  }

  // 3. sports-skills installed + version
  if (pythonVersion) {
    let ssVersion = "";
    try {
      ssVersion = await new Promise<string>((resolve, reject) => {
        execFile(
          pythonPath,
          ["-c", "from sports_skills import __version__; print(__version__)"],
          { timeout: 10_000 },
          (err, stdout) => {
            if (err) return reject(err);
            resolve(stdout.trim());
          }
        );
      });
      console.log(pc.green("  ✓") + ` sports-skills ${ssVersion}`);
    } catch {
      console.log(pc.red("  ✗") + " sports-skills not installed");
      console.log(`    Fix: ${buildSportsSkillsRepairCommand(pythonPath)}`);
      allGood = false;
    }

    // 4. F1 module (optional but checked)
    if (ssVersion) {
      try {
        await new Promise<void>((resolve, reject) => {
          execFile(
            pythonPath,
            ["-c", "from sports_skills import f1"],
            { timeout: 10_000 },
            (err) => (err ? reject(err) : resolve())
          );
        });
        console.log(pc.green("  ✓") + " F1 support (fastf1)");
      } catch {
        console.log(pc.yellow("  ⚠") + " F1 support unavailable (fastf1 not installed)");
        console.log(`    Optional: ${pythonPath} -m pip install 'sports-skills[f1]'`);
      }
    }
  }

  // 5. API key
  if (apiKey) {
    const masked = apiKey.slice(0, 6) + "..." + apiKey.slice(-4);
    console.log(pc.green("  ✓") + ` ${provider} API key (${masked})`);
  } else {
    console.log(pc.red("  ✗") + ` No API key for ${provider}`);
    console.log(`    Set the env var or run: sportsclaw config`);
    allGood = false;
  }

  // 6. Model
  if (model) {
    console.log(pc.green("  ✓") + ` Model: ${model}`);
  }

  // 7. Schemas installed
  const schemas = listSchemas();
  if (schemas.length > 0) {
    console.log(pc.green("  ✓") + ` ${schemas.length} sport schemas installed`);
  } else {
    console.log(pc.yellow("  ⚠") + " No sport schemas installed");
    console.log("    Fix: sportsclaw init --all");
    allGood = false;
  }

  // 8. Schema directory location
  if (schemas.length > 0) {
    console.log(pc.green("  ✓") + ` Schema dir: ${getSchemaDir()}`);
  }

  // Summary
  console.log("");
  if (allGood) {
    console.log(pc.green("All checks passed."));
  } else {
    console.log(pc.yellow("Some issues found — see suggestions above."));
  }
}

// ---------------------------------------------------------------------------
// CLI: `sportsclaw init`
// ---------------------------------------------------------------------------

async function cmdInit(args: string[]): Promise<void> {
  const verbose = args.includes("--verbose") || args.includes("-v");
  const all = args.includes("--all") || args.includes("-a");
  const { pythonPath } = resolveConfig();

  if (all) {
    // --all flag: install all 14 without prompting (backward-compatible for scripts)
    console.log(
      `Bootstrapping ${DEFAULT_SKILLS.length} default sport schemas...`
    );

    const count = await bootstrapDefaultSchemas(
      { pythonPath },
      { verbose, force: true }
    );

    console.log(
      `Done. ${count}/${DEFAULT_SKILLS.length} schemas installed in ${getSchemaDir()}`
    );

    if (count < DEFAULT_SKILLS.length) {
      console.log(
        "Some schemas could not be fetched. Ensure sports-skills is up to date:"
      );
      console.log(`  ${buildSportsSkillsRepairCommand(pythonPath)}`);
    }
  } else {
    // Interactive sport selection
    await runSportSelectionFlow(pythonPath);
  }
}

// ---------------------------------------------------------------------------
// Auto-bootstrap: ensure default schemas are present on first use
// ---------------------------------------------------------------------------

async function ensureDefaultSchemas(): Promise<void> {
  // Always preflight sports-skills (including F1) even when schemas already exist.
  const { pythonPath } = resolveConfig();
  await ensureSportsSkills({ pythonPath });

  const installed = listSchemas();
  if (installed.length > 0) return; // schemas already exist

  // First-time user: interactive sport selection instead of installing all 14
  console.error(
    "[sportsclaw] No sport schemas found. Let's pick your sports."
  );
  try {
    await runSportSelectionFlow(pythonPath);
  } catch {
    // If interactive flow fails (non-TTY, etc.), fall back to all defaults
    console.error("[sportsclaw] Sport selection unavailable — installing all defaults...");
    const count = await bootstrapDefaultSchemas({ pythonPath });
    console.error(
      `[sportsclaw] Bootstrapped ${count}/${DEFAULT_SKILLS.length} default schemas.`
    );
  }
}

// ---------------------------------------------------------------------------
// CLI: `sportsclaw listen <platform>`
// ---------------------------------------------------------------------------

async function cmdListen(args: string[]): Promise<void> {
  const platform = args[0]?.toLowerCase();
  if (!platform || !["discord", "telegram"].includes(platform)) {
    console.error("Usage: sportsclaw listen <discord|telegram>");
    process.exit(1);
  }

  const resolved = applyConfigToEnv();
  if (!resolved.apiKey) {
    await runConfigFlow();
    applyConfigToEnv();
  }

  await ensureDefaultSchemas();

  if (platform === "discord") {
    if (!process.env.DISCORD_BOT_TOKEN) {
      console.error("Error: DISCORD_BOT_TOKEN environment variable is required.");
      console.error("Get one at https://discord.com/developers/applications");
      process.exit(1);
    }
    const { startDiscordListener } = await import("./listeners/discord.js");
    await startDiscordListener();
  } else if (platform === "telegram") {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      console.error("Error: TELEGRAM_BOT_TOKEN environment variable is required.");
      console.error("Get one from @BotFather on Telegram.");
      process.exit(1);
    }
    const { startTelegramListener } = await import("./listeners/telegram.js");
    await startTelegramListener();
  }
}

// ---------------------------------------------------------------------------
// CLI: `sportsclaw chat` — persistent REPL conversation
// ---------------------------------------------------------------------------

async function cmdChat(args: string[]): Promise<void> {
  const verbose = args.includes("--verbose") || args.includes("-v");
  const userId = "cli-chat";

  // Merge config file + env vars, push into process.env
  let resolved = applyConfigToEnv();

  // No API key → interactive setup
  if (!resolved.apiKey) {
    await runConfigFlow();
    resolved = applyConfigToEnv();
  }

  await maybePromptForCliUpgrade();
  await ensureDefaultSchemas();

  const engine = new sportsclawEngine({
    provider: resolved.provider,
    ...(resolved.model && { model: resolved.model }),
    ...(resolved.routerModel && { routerModel: resolved.routerModel }),
    ...(resolved.routerModelStrategy && {
      routerModelStrategy: resolved.routerModelStrategy,
    }),
    pythonPath: resolved.pythonPath,
    routingMode: resolved.routingMode,
    routingMaxSkills: resolved.routingMaxSkills,
    routingAllowSpillover: resolved.routingAllowSpillover,
    verbose,
  });

  // Clear screen for a fresh start
  process.stdout.write("\x1B[2J\x1B[H");

  console.log(pc.bold(pc.blue(ASCII_LOGO)));
  p.intro("sportsclaw chat — type 'exit' or 'quit' to leave");

  // Welcome message — evolves with the relationship
  const memory = new MemoryManager(userId);
  const soulRaw = await memory.readSoul();
  const soul = memory.parseSoulHeader(soulRaw);

  if (soul.exchanges >= 20) {
    console.log("\nWhat's good. Let's get into it.\n");
  } else if (soul.exchanges >= 6) {
    console.log(
      "\nWelcome back. I know what you're into by now — ask me anything " +
      "or just say \"what's new\" and I'll catch you up.\n"
    );
  } else if (soul.exchanges >= 1) {
    console.log(
      "\nGood to see you again. Still getting to know your taste — " +
      "keep talking to me and I'll get sharper.\n"
    );
  } else {
    console.log(
      "\nHey! Ask me anything about sports — scores, standings, news, odds, " +
      "you name it. The more we talk, the more I learn what you care about " +
      "and how you like it delivered.\n"
    );
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: 200,
    removeHistoryDuplicates: false,
    terminal: true,
  });

  // REPL loop — each turn feeds history back through the same engine instance
  try {
    while (true) {
      let input: string;
      try {
        console.log("You");
        input = await rl.question("> ");
      } catch {
        p.outro("See you.");
        break;
      }

      const prompt = input.trim();
      if (!prompt) continue;
      if (prompt === "exit" || prompt === "quit") {
        p.outro("See you.");
        break;
      }

      if (verbose) {
        rl.pause();
        clearPostSubmitEchoLine();
        process.stdout.write(`You\n> ${prompt}\n`);
        try {
          const result = await engine.run(prompt, { userId });
          console.log(`\n${renderMarkdown(result)}\n`);
        } catch (error: unknown) {
          if (error instanceof Error) {
            console.error(`Error: ${error.message}`);
          } else {
            console.error("An unknown error occurred:", error);
          }
        } finally {
          rl.resume();
        }
      } else {
        rl.pause();
        const s = p.spinner();
        const cancel = setupEscCancellation();
        // Clear the echo line AFTER mode switches (rl.pause + raw mode)
        // so it catches any re-echo caused by the transition.
        clearPostSubmitEchoLine();
        process.stdout.write(`You\n> ${prompt}\n`);
        const tracker = createToolTracker(s, {
          showCancelHint: cancel.showCancelHint,
        });
        s.start("Thinking...");
        tracker.start();
        try {
          const result = await engine.run(prompt, {
            userId,
            onProgress: tracker.handler,
            abortSignal: cancel.abortSignal,
          });
          s.stop(tracker.doneSummary());
          console.log(`\n${renderMarkdown(result)}\n`);
        } catch (error: unknown) {
          if (cancel.wasCancelled() || isAbortError(error)) {
            s.stop(tracker.cancelledSummary());
            console.log("");
            continue;
          }
          s.stop(tracker.errorSummary());
          if (error instanceof Error) {
            console.error(`Error: ${error.message}`);
          } else {
            console.error("An unknown error occurred:", error);
          }
        } finally {
          tracker.stop();
          cancel.cleanup();
          rl.resume();
        }
      }
    }
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// CLI: default — run a one-shot query
// ---------------------------------------------------------------------------

async function cmdQuery(args: string[]): Promise<void> {
  const verbose = args.includes("--verbose") || args.includes("-v");
  const filteredArgs = args.filter((a) => a !== "--verbose" && a !== "-v");
  const prompt = filteredArgs.join(" ");

  if (!prompt) {
    printHelp();
    process.exit(0);
  }

  // Merge config file + env vars (env wins), push into process.env
  let resolved = applyConfigToEnv();

  // No API key anywhere → interactive setup
  if (!resolved.apiKey) {
    await runConfigFlow();
    resolved = applyConfigToEnv();
  }

  await ensureDefaultSchemas();

  const engine = new sportsclawEngine({
    provider: resolved.provider,
    ...(resolved.model && { model: resolved.model }),
    ...(resolved.routerModel && { routerModel: resolved.routerModel }),
    ...(resolved.routerModelStrategy && {
      routerModelStrategy: resolved.routerModelStrategy,
    }),
    pythonPath: resolved.pythonPath,
    routingMode: resolved.routingMode,
    routingMaxSkills: resolved.routingMaxSkills,
    routingAllowSpillover: resolved.routingAllowSpillover,
    verbose,
  });

  if (verbose) {
    // Verbose mode: no spinner, raw console.error logs
    try {
      const result = await engine.run(prompt);
      console.log(renderMarkdown(result));
    } catch (error: unknown) {
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
        console.error(error.stack);
      } else {
        console.error("An unknown error occurred:", error);
      }
      process.exit(1);
    }
  } else {
    // Normal mode: show a reasoning spinner
    const s = p.spinner();
    const cancel = setupEscCancellation();
    const tracker = createToolTracker(s, {
      showCancelHint: cancel.showCancelHint,
    });
    s.start("Thinking...");
    tracker.start();
    try {
      const result = await engine.run(prompt, {
        onProgress: tracker.handler,
        abortSignal: cancel.abortSignal,
      });
      s.stop(tracker.doneSummary());
      console.log(renderMarkdown(result));
    } catch (error: unknown) {
      if (cancel.wasCancelled() || isAbortError(error)) {
        s.stop(tracker.cancelledSummary());
        process.exit(130);
      }
      s.stop(tracker.errorSummary());
      if (error instanceof Error) {
        console.error(`Error: ${error.message}`);
      } else {
        console.error("An unknown error occurred:", error);
      }
      process.exit(1);
    } finally {
      tracker.stop();
      cancel.cleanup();
    }
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log("sportsclaw Engine v0.4.1");
  console.log("");
  console.log("Usage:");
  console.log('  sportsclaw "<prompt>"              Run a one-shot sports query');
  console.log("  sportsclaw chat                    Start an interactive conversation (REPL)");
  console.log("  sportsclaw doctor                  Check setup and diagnose issues");
  console.log("  sportsclaw config                  Run interactive configuration wizard");
  console.log("  sportsclaw add <sport>             Add a sport schema (e.g. nfl-data, nba-data)");
  console.log("  sportsclaw remove <sport>          Remove a sport schema");
  console.log("  sportsclaw list                    List installed sport schemas");
  console.log("  sportsclaw init                    Interactive sport selection & install");
  console.log("  sportsclaw init --all              Bootstrap all 14 default sport schemas");
  console.log("  sportsclaw listen <platform>       Start a chat listener (discord, telegram)");
  console.log("");
  console.log("Default skills (selected during first-run config):");
  console.log("  football-data, nfl-data, nba-data, nhl-data, mlb-data, wnba-data,");
  console.log("  tennis-data, cfb-data, cbb-data, golf-data, fastf1, kalshi,");
  console.log("  polymarket, sports-news");
  console.log("  See https://sports-skills.sh for details.");
  console.log("");
  console.log("Options:");
  console.log("  --verbose, -v    Enable verbose logging");
  console.log("  --help, -h       Show this help message");
  console.log("");
  console.log("Configuration:");
  console.log("  Config file: ~/.sportsclaw/config.json (created by `sportsclaw config`)");
  console.log("  Environment variables override config file values.");
  console.log("");
  console.log("Environment:");
  console.log("  sportsclaw_PROVIDER     LLM provider: anthropic, openai, or google (default: anthropic)");
  console.log("  sportsclaw_MODEL        Model override (default: depends on provider)");
  console.log("  SPORTSCLAW_ROUTER_STRATEGY  Router model strategy: provider_fast or same_as_main");
  console.log("  SPORTSCLAW_ROUTER_MODEL     Router model override (default: provider fast model)");
  console.log("  ANTHROPIC_API_KEY       API key for Anthropic (required when provider=anthropic)");
  console.log("  OPENAI_API_KEY          API key for OpenAI (required when provider=openai)");
  console.log("  GOOGLE_GENERATIVE_AI_API_KEY  API key for Google Gemini (required when provider=google)");
  console.log("  PYTHON_PATH             Path to Python interpreter (default: auto-detect)");
  console.log("  sportsclaw_SCHEMA_DIR   Custom schema storage directory");
  console.log("  DISCORD_BOT_TOKEN       Discord bot token (for listen discord)");
  console.log("  TELEGRAM_BOT_TOKEN      Telegram bot token (for listen telegram)");
  console.log("  ALLOWED_USERS           Comma-separated user IDs for listener whitelist");
}

// ---------------------------------------------------------------------------
// CLI: `sportsclaw config` — interactive configuration wizard
// ---------------------------------------------------------------------------

async function cmdConfig(): Promise<void> {
  await runConfigFlow();
}

// ---------------------------------------------------------------------------
// Main — route subcommands
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  // No arguments: show help, or trigger config if no API key configured
  if (args.length === 0) {
    const resolved = resolveConfig();
    if (!resolved.apiKey) {
      await runConfigFlow();
      applyConfigToEnv();
    }
    printHelp();
    process.exit(0);
  }

  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case "config":
      return cmdConfig();
    case "chat":
      return cmdChat(subArgs);
    case "doctor":
      return cmdDoctor();
    case "add":
      return cmdAdd(subArgs);
    case "remove":
      return cmdRemove(subArgs);
    case "list":
      return cmdList();
    case "init":
      return cmdInit(subArgs);
    case "listen":
      return cmdListen(subArgs);
    default:
      // Not a subcommand — treat the entire args as a query prompt
      return cmdQuery(args);
  }
}

import { realpathSync } from "node:fs";

// Run if executed directly
let isMain = false;
try {
  const fileUrlPath = fileURLToPath(import.meta.url);
  const realArgv1 = realpathSync(process.argv[1]);
  const realFileUrlPath = realpathSync(fileUrlPath);
  isMain = realArgv1 === realFileUrlPath;
} catch (e) {
  isMain = process.argv[1] === fileURLToPath(import.meta.url);
}

if (isMain) {
  main();
}
