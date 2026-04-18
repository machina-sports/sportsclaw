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
 *   sportsclaw channels          — Configure Discord & Telegram tokens
 *   sportsclaw listen <platform> — Start a Discord or Telegram listener
 *   sportsclaw start <platform> — Start a listener as a background daemon
 *   sportsclaw stop <platform>  — Stop a running daemon
 *   sportsclaw status           — Show daemon status
 *   sportsclaw logs <platform>  — Tail daemon log output
 *   sportsclaw mcp add <url>        — Connect an MCP server
 *   sportsclaw mcp remove <name>   — Disconnect an MCP server
 *   sportsclaw mcp list            — List configured MCP servers
 *   sportsclaw watch <sport> <cmd> — Watch an endpoint for realtime changes
 *   sportsclaw watch --config=... — Run multiple watchers from config file
 *   sportsclaw plugin install <name> — Install an optional plugin (e.g. auto-clipper)
 *   sportsclaw plugin list        — List installed plugins
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
import { Transform, type TransformCallback } from "node:stream";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { formatResponse } from "./formatters/index.js";
import { saveImageToDisk, saveVideoToDisk } from "./utils.js";
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
  getInstalledSportsSkillsVersion,
  getCachedSchemaVersion,
  DEFAULT_SKILLS,
} from "./schema.js";
import type { LLMProvider, ToolProgressEvent, McpServerConfig } from "./types.js";
import {
  loadConfig,
  saveConfig,
  resolveConfig,
  applyConfigToEnv,
  runConfigFlow,
  runChannelsFlow,
  runSportSelectionFlow,
  writeEnvVar,
  ENV_PATH,
  ASCII_LOGO,
} from "./config.js";
import {
  buildSportsSkillsRepairCommand,
  checkPythonVersion,
  ensureVenv,
  MIN_PYTHON_VERSION,
} from "./python.js";
import {
  bootstrapDefaultAgents,
  needsAgentBootstrap,
  loadAgents,
  loadAgent,
  listAgentIds,
  getAgentsDir,
} from "./agents.js";
import {
  generateReport as generateAnalyticsReport,
  getAggregateStats,
  getToolMetrics,
} from "./analytics.js";
import { cmdPlugin } from "./plugin.js";
import { cmdClip } from "./clipper.js";
import {
  daemonStart,
  daemonStop,
  daemonStatus,
  daemonRestart,
  daemonLogs,
  isValidPlatform,
} from "./daemon.js";
import { runSetup } from "./setup.js";
import {
  loadMcpConfigs,
  saveMcpConfigs,
  removeMcpConfig,
  getMcpConfigPath,
} from "./mcp.js";
import { WatchManager } from "./watch.js";
import type { WatchOutputMode, WatcherConfig } from "./types.js";


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
  getInstalledSportsSkillsVersion,
  getCachedSchemaVersion,
} from "./schema.js";
export { MemoryManager, getMemoryDir } from "./memory.js";
export {
  checkPythonVersion,
  findBestPython,
  checkPrerequisites,
  ensureVenv,
  isVenvSetup,
  getVenvPythonPath,
  getVenvDir,
  MIN_PYTHON_VERSION,
} from "./python.js";
export type { PythonVersionResult, PrerequisiteStatus, EnsureVenvResult } from "./python.js";
export {
  loadAgents,
  loadAgent,
  listAgentIds,
  bootstrapDefaultAgents,
  getAgentsDir,
} from "./agents.js";
export type { AgentDef } from "./agents.js";
export {
  loadConfig,
  saveConfig,
  resolveConfig,
  applyConfigToEnv,
  runConfigFlow,
  runChannelsFlow,
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
  AskUserOption,
  AskUserQuestionRequest,
  SuspendedState,
  WatcherTask,
  WatchEvent,
  WatchChange,
  WatcherConfig,
  WatchOutputMode,
  ImageAttachment,
  GeneratedImage,
  GeneratedVideo,
} from "./types.js";

// Sprint 2 modules
export {
  AskUserQuestionHalt,
  saveSuspendedState,
  loadSuspendedState,
  clearSuspendedState,
} from "./ask.js";
export { isGuideIntent, generateGuideResponse } from "./guide.js";
export {
  createTask,
  listTasks,
  completeTask,
  deleteTask,
  expireOldTasks,
} from "./taskbus.js";

// Universal Watcher
export {
  Watcher,
  WatchManager,
  computeWatcherId,
  structuralDiff,
} from "./watch.js";

// Bracket Builder
export {
  createBracket, loadBracket, listBrackets, deleteBracket,
  makePick, getBracketProgress, getNextMatchups,
  REGIONS, ROUND_NAMES,
} from "./bracket.js";
export type { BracketTeam, BracketMatchup, BracketSession } from "./bracket.js";
export { applySimulationToBracket, autoFillBracketFromSim } from "./bracket.js";

// Monte Carlo bracket simulation
export { simulateBracket, fetchTournamentField } from "./bracket-sim.js";

// Buttons — sport detection, contextual follow-ups, sport picker menus
export {
  detectSport,
  detectLeague,
  getButtons,
  getFilteredButtons,
  getFollowUpPrompt,
  getQuickActionPrompt,
  getSportDisplayName,
  SPORT_MENU_ROWS,
  SPORT_QUICK_ACTION_ROWS,
} from "./buttons.js";
export type { DetectedSport, DetectedLeague, ButtonDef, MenuButtonDef } from "./buttons.js";
export type { SimTeam, SimConfig, SimulationResult } from "./bracket-sim.js";

// Sprint 3: Subagent spawning
export {
  subagentManager,
  SubagentManager,
} from "./subagent.js";
export type { SubagentTask, SubagentResult, SubagentResultHandler } from "./subagent.js";

// Sprint 3: Heartbeat & Cron
export {
  heartbeatService,
  HeartbeatService,
} from "./heartbeat.js";
export type { CronJob, HeartbeatEvent, HeartbeatEventHandler } from "./heartbeat.js";

// Daemon management
export {
  daemonStart,
  daemonStop,
  daemonStatus,
  daemonLogs,
  isValidPlatform,
} from "./daemon.js";
export type { DaemonPlatform } from "./daemon.js";

// AI-native setup wizard
export { runSetup } from "./setup.js";

// ---------------------------------------------------------------------------
// Markdown terminal renderer
// ---------------------------------------------------------------------------

function renderMarkdown(text: string): string {
  // Pre-process: strip HTML tags that may appear in LLM responses
  let cleaned = text.replace(/<br\s*\/?>/gi, "\n");
  cleaned = cleaned.replace(/<\/?[a-z][^>]*>/gi, "");

  const rendered = formatResponse(cleaned, "cli").text;

  // Collapse excessive blank lines; trim trailing whitespace
  return rendered.replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "");
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
// sports-skills update check (chat startup)
// ---------------------------------------------------------------------------

async function getInstalledSkillsVersion(pythonPath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      pythonPath,
      ["-m", "sports_skills", "catalog"],
      { encoding: "utf-8", timeout: 10_000 },
      (error, stdout) => {
        if (error) { resolve(undefined); return; }
        try {
          const data = JSON.parse((stdout ?? "").trim());
          resolve(data.version ?? undefined);
        } catch { resolve(undefined); }
      }
    );
  });
}

async function getLatestSkillsVersion(): Promise<string | undefined> {
  try {
    const res = await fetch("https://pypi.org/pypi/sports-skills/json", {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { info?: { version?: string } };
    return data.info?.version ?? undefined;
  } catch {
    return undefined;
  }
}

async function upgradeSkillsPackage(pythonPath: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      pythonPath,
      ["-m", "pip", "install", "--upgrade", "sports-skills"],
      { encoding: "utf-8", timeout: 120_000 },
      (error, _stdout, stderr) => {
        if (error) {
          resolve({ ok: false, error: (stderr || error.message).trim() });
        } else {
          resolve({ ok: true });
        }
      }
    );
  });
}

async function maybePromptForSkillsUpgrade(pythonPath: string): Promise<void> {
  const [currentVersion, latestVersion] = await Promise.all([
    getInstalledSkillsVersion(pythonPath),
    getLatestSkillsVersion(),
  ]);

  if (!currentVersion || !latestVersion) return;
  if (!isVersionNewer(latestVersion, currentVersion)) return;

  const confirmUpgrade = await p.confirm({
    message: `sports-skills update: ${currentVersion} → ${latestVersion}. Upgrade now?`,
    initialValue: true,
  });

  if (p.isCancel(confirmUpgrade) || !confirmUpgrade) return;

  const s = p.spinner();
  s.start(`Upgrading sports-skills to ${latestVersion}...`);
  const result = await upgradeSkillsPackage(pythonPath);
  if (result.ok) {
    s.stop(`sports-skills upgraded to v${latestVersion}.`);
    return;
  }
  s.stop("Upgrade failed.");
  console.log(`Run manually: ${pythonPath} -m pip install --upgrade sports-skills`);
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

function setupEscCancellation(options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  const abortController = new AbortController();
  const stdin = process.stdin;
  let cancelled = false;
  const canRawMode = stdin.isTTY && typeof stdin.setRawMode === "function";
  const wasRaw = canRawMode ? Boolean(stdin.isRaw) : false;
  let listening = false;
  let savedStdinListeners: Function[] = [];

  const onData = (chunk: Buffer | string) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    // Treat only a lone ESC byte as cancellation. Ignore arrow keys/paste sequences.
    if (buf.length !== 1 || buf[0] !== 0x1b || cancelled) return;
    cancelled = true;
    abortController.abort();
  };

  if (enabled && stdin.isTTY) {
    // Save and remove ALL existing data listeners (readline's keypress
    // parser, etc.) BEFORE adding ours.  This prevents any re-echo of
    // buffered input when the stream is later resumed in activate().
    const existing = stdin.listeners('data');
    savedStdinListeners = [...existing] as Function[];
    for (const l of savedStdinListeners) {
      stdin.removeListener('data', l as (...args: any[]) => void);
    }

    stdin.on("data", onData);
    listening = true;
    if (canRawMode && !wasRaw) {
      stdin.setRawMode(true);
    }
    // NOTE: We do NOT call stdin.resume() here. The caller must call
    // activate() after the spinner has started so that any terminal
    // re-echo of the last readline input is overwritten by the spinner
    // line instead of appearing as a visible duplicate.
  }

  return {
    abortSignal: abortController.signal,
    showCancelHint: listening,
    wasCancelled: () => cancelled || abortController.signal.aborted,
    /** Start listening for ESC. Call this AFTER the spinner is active. */
    activate: () => {
      if (listening) {
        stdin.resume();
      }
    },
    cleanup: () => {
      if (listening) {
        stdin.off("data", onData);
        // Pause stdin before restoring listeners so no buffered data
        // reaches readline when they are re-added.
        stdin.pause();
        for (const l of savedStdinListeners) {
          stdin.on('data', l as (...args: any[]) => void);
        }
        savedStdinListeners = [];
        if (canRawMode && !wasRaw && stdin.isRaw) {
          stdin.setRawMode(false);
        }
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
  let phaseLabel = "Thinking";
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
      return `${pc.dim("\u25CB")} ${skill}: ${t.label}`;
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
        phase === "synthesizing" ? pc.dim("Synthesizing") : pc.dim(phaseLabel)
      );
    } else {
      const all = [...done, ...running];
      for (let i = 0; i < all.length; i++) {
        bodyLines.push(formatLine(all[i]));
      }
      if (phase === "synthesizing") {
        bodyLines.push(pc.dim("Synthesizing"));
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
      case "phase":
        phaseLabel = event.label;
        render();
        break;
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

async function cmdAdd(args: string[], opts?: { fromChat?: boolean }): Promise<void> {
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

function cmdRemove(args: string[], opts?: { fromChat?: boolean }): void {
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

function cmdList(opts?: { fromChat?: boolean }): void {
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

async function cmdDoctor(opts?: { fromChat?: boolean }): Promise<void> {
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

  // 2. Python reachable + version check
  const pyCheck = checkPythonVersion(pythonPath);
  let pythonOk = false;
  if (pyCheck.ok) {
    console.log(pc.green("  ✓") + ` Python ${pyCheck.version} (${pythonPath})`);
    pythonOk = true;
  } else if (pyCheck.version) {
    console.log(
      pc.red("  ✗") +
      ` Python ${pyCheck.version} (${pythonPath}) — v${MIN_PYTHON_VERSION.major}.${MIN_PYTHON_VERSION.minor}+ required`
    );
    console.log(`    Upgrade Python or run: sportsclaw config`);
    allGood = false;
  } else {
    console.log(pc.red("  ✗") + ` Python not found at ${pythonPath}`);
    console.log(`    Set PYTHON_PATH or run: sportsclaw config`);
    allGood = false;
  }

  // 3. sports-skills installed + version (skip if Python too old or missing)
  if (pythonOk) {
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

async function cmdInit(args: string[], opts?: { fromChat?: boolean }): Promise<void> {
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
  // Bootstrap default agents if missing
  if (needsAgentBootstrap()) {
    const agentCount = bootstrapDefaultAgents();
    if (agentCount > 0) {
      console.error(`[sportsclaw] Bootstrapped ${agentCount} default agent(s).`);
    }
  }

  // Always preflight sports-skills (including F1) even when schemas already exist.
  const { pythonPath } = resolveConfig();
  await ensureSportsSkills({ pythonPath });

  const installed = listSchemas();
  if (installed.length > 0) {
    // Schemas exist — check if sports-skills was upgraded since last cache
    const cachedVersion = getCachedSchemaVersion();
    const installedVersion = getInstalledSportsSkillsVersion({ pythonPath });
    if (installedVersion && cachedVersion && installedVersion !== cachedVersion) {
      console.log(
        pc.dim(`[sportsclaw] sports-skills upgraded (${cachedVersion} → ${installedVersion}). Refreshing schemas...`)
      );
      await bootstrapDefaultSchemas({ pythonPath }, { force: true });
      console.log(pc.dim("[sportsclaw] Schemas refreshed."));
    }
    return;
  }

  // First-time user: skip blocking bootstrap — sports load on-demand via install_sport.
  // The engine's self-awareness block tells the LLM about available sports,
  // and install_sport hot-loads them in ~2s when the user first asks.
  console.log(
    pc.dim("[sportsclaw] Sports will be installed on-demand when you ask about them.")
  );
  console.log(
    pc.dim("[sportsclaw] To pre-install all sports at once, run: sportsclaw init --all")
  );
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

  let resolved = applyConfigToEnv();
  if (!resolved.apiKey) {
    await runConfigFlow();
    resolved = applyConfigToEnv();
  }

  // Ensure managed venv exists
  const venvResult = ensureVenv(resolved.pythonPath);
  if (venvResult.ok && resolved.pythonPath !== venvResult.pythonPath) {
    resolved = { ...resolved, pythonPath: venvResult.pythonPath };
    process.env.PYTHON_PATH = venvResult.pythonPath;
  }

  await ensureDefaultSchemas();

  if (platform === "discord") {
    if (!process.env.DISCORD_BOT_TOKEN) {
      console.error("Error: Discord bot token is not configured.");
      console.error("Set it up with: sportsclaw config");
      console.error("Or set the DISCORD_BOT_TOKEN environment variable.");
      console.error("Get a token at https://discord.com/developers/applications");
      process.exit(1);
    }
    const { startDiscordListener } = await import("./listeners/discord.js");
    await startDiscordListener();
  } else if (platform === "telegram") {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      console.error("Error: Telegram bot token is not configured.");
      console.error("Set it up with: sportsclaw channels");
      console.error("Or set the TELEGRAM_BOT_TOKEN environment variable.");
      console.error("Or add it to ~/.sportsclaw/.env");
      console.error("Get a token from @BotFather on Telegram.");
      process.exit(1);
    }
    const { startTelegramListener } = await import("./listeners/telegram.js");
    await startTelegramListener();
  }
}

// ---------------------------------------------------------------------------
// Slash-command hotkey interception
// ---------------------------------------------------------------------------

type PromptResult =
  | { type: "input"; value: string; history: string[] }
  | null;

/** All available slash commands with descriptions */
const SLASH_COMMANDS = [
  { cmd: "/clip", desc: "Launch the auto-clipper wizard" },
  { cmd: "/skills", desc: "List and manage installed sports-skills" },
  { cmd: "/channels", desc: "Configure chat integrations (Discord, Telegram)" },
  { cmd: "/stats", desc: "View usage statistics and token consumption" },
  { cmd: "/compact", desc: "Summarize older messages to reclaim token budget" },
  { cmd: "/reset", desc: "Clear conversation history and memory state" },
  { cmd: "/help", desc: "Open the interactive guide" },
];

/**
 * A newline placeholder that is extremely unlikely to appear in real
 * user input.  During a bracketed paste we replace \n with this so
 * readline sees a single long "line".  After readline delivers the
 * value we restore the original newlines.
 */
const PASTE_NL = "\x00\x1F\x00";

/**
 * Transform stream that sits between process.stdin and readline.
 *
 * - Enables bracketed paste mode on the terminal.
 * - Strips the \x1B[200~ (start) and \x1B[201~ (end) escape sequences.
 * - While inside a paste bracket, replaces \r\n and \n with PASTE_NL
 *   so readline never sees a newline and therefore never fires "line"
 *   until the user presses Enter after the paste.
 */
class BracketedPasteTransform extends Transform {
  private pasting = false;
  private buf = "";

  _transform(chunk: Buffer, _encoding: string, cb: TransformCallback): void {
    let str = chunk.toString();

    // Process bracket open/close — they may be split across chunks so
    // we accumulate in this.buf, but in practice terminals send them in
    // one write.
    str = this.buf + str;
    this.buf = "";

    while (str.length > 0) {
      const openIdx = str.indexOf("\x1B[200~");
      const closeIdx = str.indexOf("\x1B[201~");

      if (!this.pasting) {
        if (openIdx === -1) {
          // No paste start — pass through verbatim
          this.push(str);
          str = "";
        } else {
          // Pass text before the bracket, then enter paste mode
          if (openIdx > 0) this.push(str.slice(0, openIdx));
          str = str.slice(openIdx + 6); // skip \x1B[200~
          this.pasting = true;
        }
      } else {
        // Inside a paste
        if (closeIdx === -1) {
          // No close bracket yet — buffer newlines and push rest
          str = str.replace(/\r?\n/g, PASTE_NL);
          this.push(str);
          str = "";
        } else {
          // Close bracket found — replace newlines in the pasted part
          const pasted = str.slice(0, closeIdx).replace(/\r?\n/g, PASTE_NL);
          this.push(pasted);
          str = str.slice(closeIdx + 6); // skip \x1B[201~
          this.pasting = false;
        }
      }
    }

    cb();
  }
}

/**
 * Simple readline-based prompt with slash-command tab completion,
 * a one-line hint when "/" is typed, and **bracketed-paste** support
 * so multi-line pastes (paragraphs, JSON, etc.) arrive as one input.
 */
function promptWithSlashIntercept(
  promptText: string,
  history: string[],
): Promise<PromptResult> {
  return new Promise((resolve) => {
    // Non-TTY fallback (piped input)
    if (!process.stdin.isTTY) {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
      });
      rl.question(promptText).then((value: string) => {
        rl.close();
        resolve({ type: "input", value, history: [] });
      }).catch(() => {
        rl.close();
        resolve(null);
      });
      return;
    }

    // Tab completer for slash commands
    const completer = (line: string): [string[], string] => {
      if (!line.startsWith("/")) return [[], line];
      const hits = SLASH_COMMANDS
        .map(c => c.cmd)
        .filter(cmd => cmd.startsWith(line));
      return [hits.length ? hits : SLASH_COMMANDS.map(c => c.cmd), line];
    };

    // Pipe stdin through the bracketed-paste transform so readline
    // never sees newlines inside a paste.
    const pasteTransform = new BracketedPasteTransform();
    process.stdin.pipe(pasteTransform);

    // Enable bracketed paste mode on the terminal
    process.stdout.write("\x1B[?2004h");

    const rl = createInterface({
      input: pasteTransform,
      output: process.stdout,
      terminal: true,
      completer,
      history,
    });

    // Show a one-line hint when the user types exactly "/"
    let hintShown = false;
    const onKeypress = () => {
      const line = rl.line;
      if (line === "/" && !hintShown) {
        hintShown = true;
        const hint = SLASH_COMMANDS.map(c => `${c.cmd} ${pc.dim(c.desc)}`).join("  ");
        // Save cursor, move to next line, print hint, restore cursor
        process.stdout.write(`\x1B[s\n\x1B[2K${pc.dim(hint)}\x1B[u`);
      } else if (line !== "/" && hintShown) {
        hintShown = false;
        // Clear the hint line: save cursor, move down, erase line, restore cursor
        process.stdout.write(`\x1B[s\n\x1B[2K\x1B[u`);
      }
    };
    process.stdin.on("keypress", onKeypress);

    const cleanup = () => {
      process.stdin.removeListener("keypress", onKeypress);
      process.stdin.unpipe(pasteTransform);
      pasteTransform.destroy();
      // Disable bracketed paste mode
      process.stdout.write("\x1B[?2004l");
    };

    rl.question(promptText).then((raw: string) => {
      // Snapshot history BEFORE closing readline (close clears internal state)
      const updatedHistory = (rl as unknown as { history: string[] }).history
        ? [...(rl as unknown as { history: string[] }).history]
        : [...history, ...(raw.trim() ? [raw] : [])];

      // Mute stdout during rl.close() to suppress the duplicate echo
      // that readline emits when finishing a line on a piped input.
      const origWrite = process.stdout.write;
      process.stdout.write = (() => true) as typeof process.stdout.write;
      rl.close();
      process.stdout.write = origWrite;
      cleanup();

      // Clear any leftover hint line
      if (hintShown) {
        process.stdout.write(`\x1B[1B\x1B[2K\x1B[1A`);
      }
      // Restore real newlines from the paste placeholder
      const value = raw.replaceAll(PASTE_NL, "\n");

      resolve({ type: "input", value, history: updatedHistory });
    }).catch(() => {
      rl.close();
      cleanup();
      resolve(null);
    });
  });
}

/**
 * Show the interactive slash-command select menu.
 * Returns the selected command string (e.g. "/reset") when the caller
 * needs to handle it, or `true` if the command was fully handled here.
 */
async function handleSlashMenu(): Promise<true | string> {
  const selection = await p.select({
    message: "Select a command:",
    options: [
      { value: "/clip", label: "/clip", hint: "Launch the auto-clipper conversational wizard" },
      { value: "/skills", label: "/skills", hint: "List and manage installed sports-skills" },
      { value: "/channels", label: "/channels", hint: "Configure chat integrations (Discord, Telegram)" },
      { value: "/stats", label: "/stats", hint: "View usage statistics and token consumption" },
      { value: "/compact", label: "/compact", hint: "Summarize older messages to reclaim token budget" },
      { value: "/reset", label: "/reset", hint: "Clear conversation history and memory state" },
      { value: "/help", label: "/help", hint: "Open the interactive guide" },
      { value: "/deploy", label: pc.dim("/deploy (soon)"), hint: pc.dim("Direct deployment of workflows to Machina Cloud") },
      { value: "/live", label: pc.dim("/live (soon)"), hint: pc.dim("Real-time live-streaming monitor mode") },
    ],
  });

  if (p.isCancel(selection)) {
    console.log("");
    return true;
  }

  if (selection === "/deploy" || selection === "/live") {
    console.log(pc.dim("\n  Coming Soon — " + selection + " is on the roadmap.\n"));
    return true;
  }

  // Commands the caller needs to handle (they mutate local state)
  if (selection === "/reset") {
    return "/reset";
  }
  if (selection === "/compact") {
    return "/compact";
  }

  if (selection === "/clip") {
    await cmdClip([], { fromChat: true });
  } else if (selection === "/skills") {
    cmdList({ fromChat: true });
  } else if (selection === "/channels") {
    await cmdChannels({ fromChat: true });
  } else if (selection === "/stats") {
    cmdAnalytics(["summary"], { fromChat: true });
  } else if (selection === "/help") {
    printHelp();
  }

  return true;
}

// ---------------------------------------------------------------------------
// CLI: `sportsclaw chat` — persistent REPL conversation
// ---------------------------------------------------------------------------

async function cmdChat(args: string[]): Promise<void> {
  const verbose = args.includes("--verbose") || args.includes("-v");
  const yoloMode = args.includes("--yolo");
  const userId = "cli-chat";

  // Merge config file + env vars, push into process.env
  let resolved = applyConfigToEnv();

  // No API key → interactive setup
  if (!resolved.apiKey) {
    await runConfigFlow();
    resolved = applyConfigToEnv();
  }

  // Ensure managed venv exists (creates on first run)
  const venvResult = ensureVenv(resolved.pythonPath);
  if (venvResult.ok && resolved.pythonPath !== venvResult.pythonPath) {
    resolved = { ...resolved, pythonPath: venvResult.pythonPath };
    process.env.PYTHON_PATH = venvResult.pythonPath;
  }

  await maybePromptForCliUpgrade();
  await maybePromptForSkillsUpgrade(resolved.pythonPath);
  await ensureDefaultSchemas();

  let engine = new sportsclawEngine({
    provider: resolved.provider,
    ...(resolved.model && { model: resolved.model }),
    pythonPath: resolved.pythonPath,
    routingMode: resolved.routingMode,
    routingMaxSkills: resolved.routingMaxSkills,
    routingAllowSpillover: resolved.routingAllowSpillover,
    verbose,
    allowTrading: true,
    yoloMode,
  });

  // Clear screen for a fresh start
  process.stdout.write("\x1B[2J\x1B[H");

  console.log(pc.bold(pc.blue(ASCII_LOGO)));
  p.intro(`sportsclaw chat${yoloMode ? " [YOLO]" : ""} — type 'exit' or 'quit' to leave`);

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

  const chatHistory: string[] = [];

  // REPL loop — each turn feeds history back through the same engine instance
  while (true) {
    const promptResult = await promptWithSlashIntercept(
      `${pc.dim("You")}  `,
      chatHistory,
    );

    // EOF / Ctrl-C
    if (!promptResult) {
      p.outro("See you.");
      process.exit(0);
    }

    // Normal text input — preserve history across readline instances
    chatHistory.length = 0;
    chatHistory.push(...promptResult.history);

    const prompt = promptResult.value.trim();
    if (!prompt) continue;
    if (prompt === "exit" || prompt === "quit") {
      p.outro("See you.");
      process.exit(0);
    }

    // Fallback: "/" or "sportsclaw /" typed and submitted with Enter
    if (prompt === "sportsclaw /" || prompt === "/") {
      const menuResult = await handleSlashMenu();
      if (menuResult === "/reset") {
        engine.reset();
        await memory.writeContext("");
        await memory.writeThread([]);
        console.log(pc.green("✔ Conversation history and memory cleared."));
      } else if (menuResult === "/compact") {
        const msgCount = engine.messageCount;
        if (msgCount <= 6) {
          console.log(pc.dim(`\n  Nothing to compact (${msgCount} messages in history).\n`));
        } else {
          const s = p.spinner();
          s.start("Compacting conversation history...");
          const compactResult = await engine.compact();
          s.stop(
            pc.green("✔") +
            ` Compacted: ${compactResult.before} → ${compactResult.after} messages ` +
            `(${compactResult.summarized} summarized)`
          );
        }
      }
      continue;
    }

    // Direct slash command shortcuts (without dropdown)
    if (prompt === "/clip") { await cmdClip([], { fromChat: true }); continue; }
    if (prompt === "/skills") { cmdList({ fromChat: true }); continue; }
    if (prompt === "/channels") { await cmdChannels({ fromChat: true }); continue; }
    if (prompt === "/stats") { cmdAnalytics(["summary"], { fromChat: true }); continue; }
    if (prompt === "/compact") {
      const msgCount = engine.messageCount;
      if (msgCount <= 6) {
        console.log(pc.dim(`\n  Nothing to compact (${msgCount} messages in history).\n`));
      } else {
        const s = p.spinner();
        s.start("Compacting conversation history...");
        const result = await engine.compact();
        s.stop(
          pc.green("✔") +
          ` Compacted: ${result.before} → ${result.after} messages ` +
          `(${result.summarized} summarized)`
        );
      }
      continue;
    }
    if (prompt === "/reset") {
      engine.reset();
      await memory.writeContext("");
      await memory.writeThread([]);
      console.log(pc.green("✔ Conversation history and memory cleared."));
      continue;
    }
    if (prompt === "/help") { printHelp(); continue; }
    if (prompt === "/deploy" || prompt === "/live") {
      console.log(pc.dim("\n  Coming Soon — " + prompt + " is on the roadmap.\n"));
      continue;
    }

    if (prompt === "restart" || prompt === "/restart" || prompt === "/claw restart") {
      console.log(pc.yellow("🔄 Reloading configuration and engine state..."));
      const newConfig = resolveConfig();
      applyConfigToEnv();
      
      engine = new sportsclawEngine({
        provider: newConfig.provider,
        ...(newConfig.model && { model: newConfig.model }),
        pythonPath: newConfig.pythonPath,
        routingMode: newConfig.routingMode,
        routingMaxSkills: newConfig.routingMaxSkills,
        routingAllowSpillover: newConfig.routingAllowSpillover,
        verbose,
        allowTrading: true,
        yoloMode,
      });
      console.log(pc.green("✔ Engine restarted successfully."));
      continue;
    }

    if (verbose) {
      try {
        const result = await engine.run(prompt, { userId });
        console.log(`\n${pc.bold(pc.cyan("sportsclaw"))}\n${renderMarkdown(result)}\n`);
        await saveGeneratedImages(engine);
        await saveGeneratedVideos(engine);
      } catch (error: unknown) {
        if (error instanceof Error) {
          console.error(`Error: ${error.message}`);
        } else {
          console.error("An unknown error occurred:", error);
        }
      }
    } else {
      // In chat REPL, ESC cancellation can cause duplicate user input echoes
      // with readline on some terminals. Keep cancellation disabled here.
      const cancel = setupEscCancellation({ enabled: false });
      const s = p.spinner();
      const tracker = createToolTracker(s, {
        showCancelHint: cancel.showCancelHint,
      });
      s.start("Thinking");
      tracker.start();
      try {
        const result = await engine.run(prompt, {
          userId,
          onProgress: tracker.handler,
          abortSignal: cancel.abortSignal,
        });
        s.stop(tracker.doneSummary());
        console.log(`\n${pc.bold(pc.cyan("sportsclaw"))}\n${renderMarkdown(result)}\n`);
        await saveGeneratedImages(engine);
        await saveGeneratedVideos(engine);
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
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Save generated images/videos from the engine to disk and print paths.
// ---------------------------------------------------------------------------

async function saveGeneratedImages(engine: sportsclawEngine): Promise<void> {
  if (engine.generatedImages.length === 0) return;
  for (const img of engine.generatedImages) {
    const filePath = await saveImageToDisk(img.data, img.mimeType);
    console.log(pc.dim(`  Image saved: ${filePath}`));
  }
}

async function saveGeneratedVideos(engine: sportsclawEngine): Promise<void> {
  if (engine.generatedVideos.length === 0) return;
  for (const vid of engine.generatedVideos) {
    const filePath = await saveVideoToDisk(vid.data);
    console.log(pc.dim(`  Video saved: ${filePath}`));
  }
}

// ---------------------------------------------------------------------------
// CLI: default — run a one-shot query
// ---------------------------------------------------------------------------

/**
 * Emit a single NDJSON line to stdout (pipe mode).
 */
function emitNdjson(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + "\n");
}

async function cmdQuery(args: string[]): Promise<void> {
  const verbose = args.includes("--verbose") || args.includes("-v");
  const forcePipe = args.includes("--pipe");
  if (forcePipe) {
    console.error("[sportsclaw] WARNING: --pipe is deprecated, use --json instead.");
  }
  const forceJson = args.includes("--json");
  const yoloMode = args.includes("--yolo");
  const explicitFormat = args.find((a) => a.startsWith("--format="))?.split("=")[1];
  const formatArg = explicitFormat ?? (forcePipe || forceJson ? "markdown" : "cli");

  // Parse --user <id> flag (used by relay/pipe to enable memory & thread persistence)
  let userId: string | undefined;
  const userIdx = args.indexOf("--user");
  if (userIdx >= 0 && userIdx + 1 < args.length) {
    userId = args[userIdx + 1];
    args.splice(userIdx, 2); // remove --user and its value from args
  }

  // Parse --system-prompt <text> flag (used by relay to inject caller context)
  let systemPrompt: string | undefined;
  const systemPromptIdx = args.indexOf("--system-prompt");
  if (systemPromptIdx >= 0 && systemPromptIdx + 1 < args.length) {
    systemPrompt = args[systemPromptIdx + 1];
    args.splice(systemPromptIdx, 2);
  }

  const filteredArgs = args.filter((a) =>
    a !== "--verbose" && a !== "-v" && a !== "--pipe" &&
    a !== "--json" && a !== "--yolo" && !a.startsWith("--format=")
  );
  const prompt = filteredArgs.join(" ");

  if (!prompt) {
    printHelp();
    process.exit(0);
  }

  // Merge config file + env vars (env wins), push into process.env
  let resolved = applyConfigToEnv();

  // No API key anywhere → interactive setup (skip in headless mode)
  if (!resolved.apiKey) {
    if (forceJson || !process.stdout.isTTY) {
      emitNdjson({ type: "error", error: "No API key configured. Run `sportsclaw config` interactively first." });
      process.exit(1);
    }
    await runConfigFlow();
    resolved = applyConfigToEnv();
  }

  // Ensure managed venv exists
  const venvResult = ensureVenv(resolved.pythonPath);
  if (venvResult.ok && resolved.pythonPath !== venvResult.pythonPath) {
    resolved = { ...resolved, pythonPath: venvResult.pythonPath };
    process.env.PYTHON_PATH = venvResult.pythonPath;
  }

  await ensureDefaultSchemas();

  const engine = new sportsclawEngine({
    provider: resolved.provider,
    ...(resolved.model && { model: resolved.model }),
    pythonPath: resolved.pythonPath,
    routingMode: resolved.routingMode,
    routingMaxSkills: resolved.routingMaxSkills,
    routingAllowSpillover: resolved.routingAllowSpillover,
    verbose,
    allowTrading: true,
    yoloMode,
  });

  // Headless NDJSON streaming: --json flag, --pipe flag, or non-TTY stdout.
  // Strips all clack/spinners and emits structured NDJSON lines to stdout.
  const headlessMode = forceJson || forcePipe || !process.stdout.isTTY;

  if (headlessMode) {
    emitNdjson({ type: "start", timestamp: new Date().toISOString(), yolo: yoloMode });
    try {
      const result = await engine.run(prompt, {
        userId,
        systemPrompt,
        onProgress: (event) => emitNdjson({ ...event, category: "progress" }),
      });
      const formatted = formatResponse(result, formatArg as any);
      for (const img of engine.generatedImages) {
        emitNdjson({ type: "image", data: img.data, mimeType: img.mimeType, prompt: img.prompt });
      }
      for (const vid of engine.generatedVideos) {
        emitNdjson({ type: "video", data: vid.data, mimeType: vid.mimeType, prompt: vid.prompt });
      }
      emitNdjson({ type: "result", text: formatted.text });
      // Wait for stdout to drain before exiting — process.stdout.write() to
      // a pipe is async and process.exit() would truncate unflushed data
      // (e.g. large base64 image lines that exceed the 64KB pipe buffer).
      await new Promise<void>((resolve) => {
        if (process.stdout.writableNeedDrain) {
          process.stdout.once("drain", resolve);
        } else {
          resolve();
        }
      });
      process.exit(0);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      emitNdjson({ type: "error", error: msg });
      process.exit(1);
    }
  } else if (verbose) {
    // Verbose mode: no spinner, raw console.error logs
    try {
      const result = await engine.run(prompt, { systemPrompt });
      console.log(renderMarkdown(result));
      await saveGeneratedImages(engine);
      await saveGeneratedVideos(engine);
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
    s.start("Thinking");
    cancel.activate();
    tracker.start();
    try {
      const result = await engine.run(prompt, {
        systemPrompt,
        onProgress: tracker.handler,
        abortSignal: cancel.abortSignal,
      });
      s.stop(tracker.doneSummary());
      console.log(renderMarkdown(result));
      await saveGeneratedImages(engine);
      await saveGeneratedVideos(engine);
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

// ---------------------------------------------------------------------------
// CLI: `sportsclaw start <platform>` — start a daemon
// ---------------------------------------------------------------------------

function cmdStart(args: string[]): void {
  const platform = args[0]?.toLowerCase();
  if (!platform || !isValidPlatform(platform)) {
    console.error("Usage: sportsclaw start <discord|telegram|watch>");
    process.exit(1);
  }
  daemonStart(platform);
}

// ---------------------------------------------------------------------------
// CLI: `sportsclaw stop <platform>` — stop a daemon
// ---------------------------------------------------------------------------

function cmdStop(args: string[]): void {
  const platform = args[0]?.toLowerCase();
  if (!platform || !isValidPlatform(platform)) {
    console.error("Usage: sportsclaw stop <discord|telegram|watch>");
    process.exit(1);
  }
  daemonStop(platform);
}

// ---------------------------------------------------------------------------
// CLI: `sportsclaw status` — show daemon status
// ---------------------------------------------------------------------------

function cmdStatus(): void {
  daemonStatus();
}

// ---------------------------------------------------------------------------
// CLI: `sportsclaw restart <platform>` — restart a running daemon
// ---------------------------------------------------------------------------

function cmdRestart(args: string[]): void {
  const platform = args[0]?.toLowerCase();
  if (!platform || !["discord", "telegram", "watch"].includes(platform)) {
    console.error("Usage: sportsclaw restart <discord|telegram|watch>");
    process.exit(1);
  }
  daemonRestart(platform as any);
}

// ---------------------------------------------------------------------------
// CLI: `sportsclaw logs <platform>` — tail daemon logs
// ---------------------------------------------------------------------------

function cmdLogs(args: string[]): void {
  const platform = args[0]?.toLowerCase();
  if (!platform || !isValidPlatform(platform)) {
    console.error("Usage: sportsclaw logs <discord|telegram|watch>");
    process.exit(1);
  }
  const lines = args[1] ? Number.parseInt(args[1], 10) : 50;
  daemonLogs(platform, Number.isFinite(lines) && lines > 0 ? lines : 50);
}

// ---------------------------------------------------------------------------
// CLI: `sportsclaw watch` — realtime data watcher
// ---------------------------------------------------------------------------

async function cmdWatch(args: string[]): Promise<void> {
  // Parse flags
  const flags = new Map<string, string>();
  const positional: string[] = [];

  for (const arg of args) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        flags.set(arg.slice(2), "true");
      }
    } else {
      positional.push(arg);
    }
  }

  const configPath = flags.get("config");

  // Resolve engine config for Python bridge
  const resolved = resolveConfig();
  applyConfigToEnv();
  const engineConfig = { pythonPath: resolved.pythonPath };

  let manager: WatchManager;

  if (configPath) {
    // Multi-watcher mode from config file
    try {
      manager = await WatchManager.fromConfigFile(configPath, engineConfig);
    } catch (err) {
      console.error(
        `Failed to load watch config from ${configPath}:`,
        err instanceof Error ? err.message : err,
      );
      process.exit(1);
    }
  } else {
    // Single watcher mode: sportsclaw watch <sport> <command> [flags]
    const sport = positional[0];
    const command = positional[1];

    if (!sport || !command) {
      console.log("Usage:");
      console.log("  sportsclaw watch <sport> <command> [--interval=30] [--output=stdout|relay|file]");
      console.log("  sportsclaw watch --config=~/.sportsclaw/watchers.json");
      console.log("");
      console.log("Examples:");
      console.log("  sportsclaw watch nba get_scoreboard --interval=10");
      console.log("  sportsclaw watch nfl get_standings --interval=60 --output=relay");
      console.log("  sportsclaw watch soccer get_season_standings --interval=300 --output=file");
      process.exit(1);
    }

    const config: WatcherConfig = {
      sport,
      command,
      intervalSeconds: parseInt(flags.get("interval") ?? "30", 10),
      output: (flags.get("output") as WatchOutputMode) ?? "stdout",
      channel: flags.get("channel"),
      filePath: flags.get("file"),
    };

    // Parse extra args for the Python bridge (--arg_name=value)
    const bridgeArgs: Record<string, unknown> = {};
    for (const [key, value] of flags) {
      if (!["interval", "output", "channel", "file", "config"].includes(key)) {
        bridgeArgs[key] = value === "true" ? true : value;
      }
    }
    if (Object.keys(bridgeArgs).length > 0) {
      config.args = bridgeArgs;
    }

    manager = new WatchManager();
    manager.addWatcher(config, engineConfig);
  }

  console.log(`\n${manager.size} watcher(s) running. Press Ctrl+C to stop.\n`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down watchers...");
    await manager.stopAll();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep process alive
  await new Promise(() => {});
}

// ---------------------------------------------------------------------------
// CLI: `sportsclaw mcp` — MCP server management
// ---------------------------------------------------------------------------

function serverNameFromUrl(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    // e.g. "machina-podcasts-adidas-tracker.org.machina.gg" → "adidas-tracker"
    const parts = hostname.split(".");
    const sub = parts[0];
    // Strip common prefixes like "machina-podcasts-"
    return sub.replace(/^machina-podcasts-/, "").replace(/^mcp-/, "") || sub;
  } catch {
    return "mcp-server";
  }
}

async function cmdMcp(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === "add") {
    const url = args[1];
    if (!url) {
      console.error("Usage: sportsclaw mcp add <url> [--name <name>] [--token <token>] [--description <desc>]");
      console.error("Example: sportsclaw mcp add https://my-pod.machina.gg/mcp/sse --name my-pod");
      process.exit(1);
    }

    // Parse optional flags
    let name: string | undefined;
    let token: string | undefined;
    let description: string | undefined;
    let timeoutMs: number | undefined;

    for (let i = 2; i < args.length; i++) {
      if ((args[i] === "--name" || args[i] === "-n") && args[i + 1]) {
        name = args[++i];
      } else if ((args[i] === "--token" || args[i] === "-t") && args[i + 1]) {
        token = args[++i];
      } else if ((args[i] === "--description" || args[i] === "-d") && args[i + 1]) {
        description = args[++i];
      } else if (args[i] === "--timeout" && args[i + 1]) {
        timeoutMs = Number.parseInt(args[++i], 10);
      }
    }

    // Auto-derive name from URL if not provided
    if (!name) {
      name = serverNameFromUrl(url);
    }

    // Validate name
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      console.error(`Invalid server name "${name}". Use only alphanumeric, hyphens, and underscores.`);
      process.exit(1);
    }

    // Build server config
    const configs = loadMcpConfigs();
    const isUpdate = name in configs;
    const config: McpServerConfig = {
      url,
      ...(description ? { description } : {}),
      ...(timeoutMs && Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
    };

    configs[name] = config;
    saveMcpConfigs(configs);

    // Store token in ~/.sportsclaw/.env (not in mcp.json — keep secrets separate)
    if (token) {
      const envKey = `SPORTSCLAW_MCP_TOKEN_${name.replace(/-/g, "_").toUpperCase()}`;
      writeEnvVar(ENV_PATH, envKey, token);
      console.log(pc.dim(`Token saved to ${ENV_PATH} as ${envKey}`));
    }

    console.log(
      isUpdate
        ? pc.green(`Updated MCP server "${name}"`)
        : pc.green(`Added MCP server "${name}"`)
    );
    console.log(`  URL: ${url}`);
    if (description) console.log(`  Description: ${description}`);
    if (timeoutMs) console.log(`  Timeout: ${timeoutMs}ms`);
    console.log(pc.dim(`Config: ${getMcpConfigPath()}`));

    if (!token) {
      const envKey = `SPORTSCLAW_MCP_TOKEN_${name.replace(/-/g, "_").toUpperCase()}`;
      console.log("");
      console.log(pc.yellow("No token provided. If the server requires auth, add one:"));
      console.log(`  sportsclaw mcp add ${url} --name ${name} --token <your-token>`);
      console.log(pc.dim(`  Or set ${envKey} in your environment`));
    }

  } else if (sub === "remove") {
    const name = args[1];
    if (!name) {
      console.error("Usage: sportsclaw mcp remove <name>");
      process.exit(1);
    }

    if (removeMcpConfig(name)) {
      console.log(pc.green(`Removed MCP server "${name}"`));
    } else {
      console.error(`No MCP server found with name "${name}".`);
      const configs = loadMcpConfigs();
      if (Object.keys(configs).length > 0) {
        console.error(`Available: ${Object.keys(configs).join(", ")}`);
      }
      process.exit(1);
    }

  } else if (sub === "list" || !sub) {
    const configs = loadMcpConfigs();
    const names = Object.keys(configs);

    if (names.length === 0) {
      console.log("No MCP servers configured.");
      console.log("");
      console.log("Add one with:");
      console.log("  sportsclaw mcp add <url> --name <name> --token <token>");
      return;
    }

    console.log(pc.bold(`MCP Servers (${names.length})`) + `  ${pc.dim(getMcpConfigPath())}`);
    console.log("");
    for (const [name, config] of Object.entries(configs)) {
      const desc = config.description ? pc.dim(` — ${config.description}`) : "";
      const timeout = config.timeoutMs ? pc.dim(` [${config.timeoutMs}ms]`) : "";
      console.log(`  ${pc.cyan(name.padEnd(24))} ${config.url}${desc}${timeout}`);
      if (config.tools?.length) {
        console.log(`  ${" ".repeat(24)} ${pc.dim(`tools: ${config.tools.join(", ")}`)}`);
      }
    }
    console.log("");

  } else {
    console.error(`Unknown mcp subcommand: "${sub}"`);
    console.error("Usage: sportsclaw mcp [add|remove|list]");
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// CLI: `sportsclaw --help` — usage text
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log("sportsclaw Engine v0.4.1");
  console.log("");
  console.log("Usage:");
  console.log('  sportsclaw "<prompt>"              Run a one-shot sports query');
  console.log("  sportsclaw chat                    Start an interactive conversation (REPL)");
  console.log("  sportsclaw setup [prompt]           AI-guided setup wizard");
  console.log("  sportsclaw doctor                  Check setup and diagnose issues");
  console.log("  sportsclaw config                  Run interactive configuration wizard");
  console.log("  sportsclaw channels                Configure Discord & Telegram tokens");
  console.log("  sportsclaw add <sport>             Add a sport schema (e.g. nfl-data, nba-data)");
  console.log("  sportsclaw remove <sport>          Remove a sport schema");
  console.log("  sportsclaw list                    List installed sport schemas");
  console.log("  sportsclaw init                    Interactive sport selection & install");
  console.log("  sportsclaw init --all              Bootstrap all 14 default sport schemas");
  console.log("  sportsclaw listen <platform>       Start a chat listener (discord, telegram)");
  console.log("  sportsclaw start <platform>        Start a listener as a background daemon");
  console.log("  sportsclaw stop <platform>         Stop a running daemon");
  console.log("  sportsclaw status                  Show daemon status");
  console.log("  sportsclaw restart <platform>      Restart a running daemon");
  console.log("  sportsclaw logs <platform>         Tail daemon log output");
  console.log("  sportsclaw agents                  List installed agents");
  console.log("  sportsclaw mcp add <url>           Connect an MCP server (Machina pod, etc.)");
  console.log("  sportsclaw mcp remove <name>       Disconnect an MCP server");
  console.log("  sportsclaw mcp list                List configured MCP servers");
  console.log("  sportsclaw watch <sport> <command>  Watch an endpoint for realtime changes");
  console.log("  sportsclaw watch --config=<path>   Run multiple watchers from config file");
  console.log("  sportsclaw plugin install <name>   Install an optional plugin");
  console.log("  sportsclaw plugin list             List installed plugins");
  console.log("");
  console.log("Default skills (selected during first-run config):");
  console.log("  football-data, nfl-data, nba-data, nhl-data, mlb-data, wnba-data,");
  console.log("  tennis-data, cfb-data, cbb-data, golf-data, fastf1, kalshi,");
  console.log("  polymarket, sports-news");
  console.log("  See https://sports-skills.sh for details.");
  console.log("");
  console.log("Options:");
  console.log("  --verbose, -v    Enable verbose logging");
  console.log("  --yolo           Bypass all Y/n approval prompts (autonomous execution)");
  console.log("  --json           Force headless NDJSON output (no spinners/clack)");
  console.log("  --pipe           Alias for --json (legacy)");
  console.log("  --help, -h       Show this help message");
  console.log("");
  console.log("Configuration:");
  console.log("  Config file: ~/.sportsclaw/config.json (created by `sportsclaw config`)");
  console.log("  Environment variables override config file values.");
  console.log("");
  console.log("Environment:");
  console.log("  sportsclaw_PROVIDER     LLM provider: anthropic, openai, or google (default: anthropic)");
  console.log("  sportsclaw_MODEL        Model override (default: depends on provider)");
  console.log("  ANTHROPIC_API_KEY       API key for Anthropic (required when provider=anthropic)");
  console.log("  OPENAI_API_KEY          API key for OpenAI (required when provider=openai)");
  console.log("  GOOGLE_GENERATIVE_AI_API_KEY  API key for Google Gemini (required when provider=google)");
  console.log("  PYTHON_PATH             Path to Python interpreter (default: auto-detect)");
  console.log("  sportsclaw_SCHEMA_DIR   Custom schema storage directory");
  console.log("  DISCORD_BOT_TOKEN       Discord bot token (for listen discord)");
  console.log("  DISCORD_PREFIX          Command prefix for Discord bot (default: !sportsclaw)");
  console.log("  TELEGRAM_BOT_TOKEN      Telegram bot token (for listen telegram)");
  console.log("  ALLOWED_USERS           Comma-separated user IDs for listener whitelist");
  console.log("");
  console.log("  Discord can also be configured via `sportsclaw config` or in-chat.");
}

// ---------------------------------------------------------------------------
// CLI: `sportsclaw config` — interactive configuration wizard
// ---------------------------------------------------------------------------

async function cmdConfig(opts?: { fromChat?: boolean }): Promise<void> {
  await runConfigFlow();
}

// ---------------------------------------------------------------------------
// CLI: `sportsclaw channels` — channel token wizard
// ---------------------------------------------------------------------------

async function cmdChannels(opts?: { fromChat?: boolean }): Promise<void> {
  await runChannelsFlow();
}

// ---------------------------------------------------------------------------
// CLI: `sportsclaw agents` — list installed agents
// ---------------------------------------------------------------------------

function cmdAgents(opts?: { fromChat?: boolean }): void {
  if (needsAgentBootstrap()) {
    bootstrapDefaultAgents();
  }
  const agents = loadAgents();
  if (agents.length === 0) {
    console.log("No agents installed.");
    console.log(`Create agent files in: ${getAgentsDir()}/`);
    return;
  }

  console.log(pc.bold(`Agents (${agents.length})`) + `  ${pc.dim(getAgentsDir())}`);
  console.log("");
  for (const agent of agents) {
    const skills = agent.skills.length > 0
      ? pc.dim(agent.skills.join(", "))
      : pc.dim("all skills");
    console.log(`  ${pc.cyan(agent.id.padEnd(14))} ${agent.name.padEnd(18)} ${skills}`);
  }
  console.log("");
  console.log(pc.dim("Add custom agents by creating .md files in the agents directory."));
}

// ---------------------------------------------------------------------------
// CLI: `sportsclaw setup [prompt]` — AI-native setup wizard
// ---------------------------------------------------------------------------

async function cmdSetup(args: string[], opts?: { fromChat?: boolean }): Promise<void> {
  const prompt = args.filter((a) => !a.startsWith("-")).join(" ").trim() || undefined;
  await runSetup(prompt);
}

// ---------------------------------------------------------------------------
// Analytics Command
// ---------------------------------------------------------------------------

function cmdAnalytics(args: string[], opts?: { fromChat?: boolean }): void {
  const subCmd = args[0];

  if (subCmd === "report" || !subCmd) {
    // Default: print full report
    console.log(generateAnalyticsReport());
    return;
  }

  if (subCmd === "json") {
    // Export as JSON for programmatic access
    const stats = getAggregateStats();
    const tools = getToolMetrics();
    console.log(JSON.stringify({ stats, tools }, null, 2));
    return;
  }

  if (subCmd === "tools") {
    // Just tool metrics
    const tools = getToolMetrics();
    console.log(pc.bold("Tool Metrics"));
    console.log("");
    const sorted = Object.entries(tools).sort((a, b) => b[1].callCount - a[1].callCount);
    for (const [name, m] of sorted.slice(0, 20)) {
      const successRate = ((m.successCount / m.callCount) * 100).toFixed(1);
      const status = m.failCount > 0 ? pc.yellow(`${m.failCount} fails`) : pc.green("ok");
      console.log(
        `  ${name.padEnd(40)} ${String(m.callCount).padStart(6)} calls  ${successRate}% success  ${status}`
      );
    }
    return;
  }

  if (subCmd === "summary") {
    // Quick summary
    const stats = getAggregateStats();
    console.log(pc.bold("sportsclaw Analytics Summary"));
    console.log("");
    console.log(`  Queries:      ${stats.totalQueries.toLocaleString()}`);
    console.log(`  Users:        ${stats.uniqueUsers.toLocaleString()}`);
    console.log(`  Success Rate: ${(stats.successRate * 100).toFixed(1)}%`);
    console.log(`  Avg Latency:  ${stats.avgLatencyMs}ms`);
    console.log(`  Last Updated: ${stats.lastUpdated}`);
    return;
  }

  console.log("Usage: sportsclaw analytics [report|json|tools|summary]");
  console.log("");
  console.log("  report   Full markdown report (default)");
  console.log("  json     Export all data as JSON");
  console.log("  tools    Tool call metrics");
  console.log("  summary  Quick stats summary");
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
    case "setup":
      return cmdSetup(subArgs);
    case "config":
      return cmdConfig();
    case "channels":
      return cmdChannels();
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
    case "start":
      return cmdStart(subArgs);
    case "stop":
      return cmdStop(subArgs);
    case "status":
      return cmdStatus();
    case "restart":
      return cmdRestart(subArgs);
    case "logs":
      return cmdLogs(subArgs);
    case "agents":
      return cmdAgents();
    case "analytics":
      return cmdAnalytics(subArgs);
    
    case "clip":
      await cmdClip(subArgs);
      break;
case "plugin":
      return cmdPlugin(subArgs);
    case "mcp":
      return cmdMcp(subArgs);
    case "watch":
      return cmdWatch(subArgs);
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
