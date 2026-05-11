/**
 * `sportsclaw operate` — autonomous operator daemon CLI.
 *
 * Foreground driver for createOperatorDaemon(). Also the implementation
 * invoked by the supervised form (`sportsclaw start operator <jobId>`)
 * via daemon.ts → scriptArgsFor.
 *
 *   sportsclaw operate --job <jobId>             run forever, ticking
 *   sportsclaw operate --job <jobId> --once      one tick, exit by status
 *   sportsclaw operate --job <jobId> --dry-run   resolve + print prompt, no LLM
 *   sportsclaw operate --list [--json]           list configured jobs
 *   sportsclaw operate --validate <jobId>        load + validate; exit non-zero on errors
 *
 * --once exit code matrix:
 *   0 — published (LLM produced output)
 *   0 — silent    (LLM voted [SILENT])
 *   1 — skipped   (wake gate denied)
 *   2 — failed    (LLM/tool error)
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

import { tool as defineTool, jsonSchema, type ToolSet } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";

import {
  createOperatorDaemon,
  type TickEvent,
  type ToolCallEvent,
} from "./operator-daemon.js";
import {
  listOperatorJobs,
  loadOperatorJobConfig,
  defaultRootDir,
  validateOperatorJobConfig,
  operatorConfigPath,
  type OperatorJobConfig,
} from "./operator-config.js";
import { ToolRegistry, type ToolCallInput } from "./tools.js";
import { McpManager } from "./mcp.js";
import { loadAllSchemas } from "./schema.js";
import { resolveConfig, applyConfigToEnv } from "./config.js";
import {
  BROADCAST_DIRECTIVE_FRAGMENT,
  buildSystemPrompt,
  CRON_AUTONOMY_FRAGMENT,
  EDITORIAL_MEMORY_FRAGMENT_HEADER,
  SILENT_SENTINEL_FRAGMENT,
  SILENT_SENTINEL_TOKEN,
  TICK_BRIEF_FRAGMENT_HEADER,
  TOOL_DISCIPLINE_FRAGMENT,
} from "./prompts.js";
import type { LLMProvider } from "./types.js";

// ---------------------------------------------------------------------------
// Public entry — wired into src/index.ts main dispatcher
// ---------------------------------------------------------------------------

interface ParsedFlags {
  job?: string;
  list: boolean;
  validate?: string;
  once: boolean;
  dryRun: boolean;
  json: boolean;
  unknown: string[];
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = {
    list: false,
    once: false,
    dryRun: false,
    json: false,
    unknown: [],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--list") flags.list = true;
    else if (arg === "--once") flags.once = true;
    else if (arg === "--dry-run") flags.dryRun = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--validate") {
      flags.validate = args[++i];
    } else if (arg === "--job") {
      flags.job = args[++i];
    } else if (arg.startsWith("--job=")) {
      flags.job = arg.slice("--job=".length);
    } else if (arg.startsWith("--validate=")) {
      flags.validate = arg.slice("--validate=".length);
    } else {
      flags.unknown.push(arg);
    }
  }
  return flags;
}

export async function cmdOperate(args: string[]): Promise<void> {
  const flags = parseFlags(args);

  if (flags.unknown.length > 0) {
    console.error(`Unknown argument(s): ${flags.unknown.join(" ")}`);
    printOperateHelp();
    process.exit(2);
  }

  if (flags.list) return runList({ json: flags.json });
  if (flags.validate) return runValidate(flags.validate);

  if (!flags.job) {
    printOperateHelp();
    process.exit(2);
  }

  if (flags.dryRun) return runDryRun(flags.job);
  if (flags.once) return runOnce(flags.job);
  return runForeground(flags.job);
}

function printOperateHelp(): void {
  console.log(
    [
      "sportsclaw operate — autonomous operator daemon",
      "",
      "Usage:",
      "  sportsclaw operate --job <jobId>             run forever, ticking",
      "  sportsclaw operate --job <jobId> --once      one tick, exit by status",
      "  sportsclaw operate --job <jobId> --dry-run   resolve + print prompt, no LLM",
      "  sportsclaw operate --list [--json]           list configured jobs",
      "  sportsclaw operate --validate <jobId>        load + validate; non-zero on errors",
      "",
      "Job configs live in ~/.sportsclaw/operator/<jobId>.json.",
      "",
      "--once exit codes:",
      "  0  published (LLM produced output)",
      "  0  silent    (LLM voted [SILENT])",
      "  1  skipped   (wake gate denied)",
      "  2  failed    (LLM / tool error)",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// `--list`
// ---------------------------------------------------------------------------

interface ListItem {
  jobId: string;
  path: string;
  intervalMs?: number;
  label?: string;
  valid: boolean;
  issues?: string[];
}

function runList(opts: { json: boolean }): void {
  const jobs = listOperatorJobs();
  const items: ListItem[] = jobs.map(({ jobId, path: filePath }) => {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      const result = validateOperatorJobConfig(parsed, { sourcePath: filePath });
      if (!result.valid || !result.config) {
        return {
          jobId,
          path: filePath,
          valid: false,
          issues: result.issues.map((i) => `${i.field}: ${i.message}`),
        };
      }
      return {
        jobId,
        path: filePath,
        intervalMs: result.config.intervalMs,
        label: result.config.label,
        valid: true,
      };
    } catch (err) {
      return {
        jobId,
        path: filePath,
        valid: false,
        issues: [err instanceof Error ? err.message : String(err)],
      };
    }
  });

  if (opts.json) {
    console.log(JSON.stringify(items, null, 2));
    return;
  }

  if (items.length === 0) {
    console.log("No operator jobs configured.");
    console.log(
      `Drop a JSON file in ${path.join(homedir(), ".sportsclaw", "operator")}/ to add one.`,
    );
    console.log("See examples/operator-jobs/ in the repo for starter configs.");
    return;
  }

  console.log("Operator jobs:");
  console.log("");
  for (const it of items) {
    const tag = it.valid ? "\x1b[32m●\x1b[0m" : "\x1b[31m✗\x1b[0m";
    const interval = it.intervalMs ? `${it.intervalMs}ms` : "—";
    const label = it.label ? ` "${it.label}"` : "";
    console.log(`  ${tag} ${it.jobId.padEnd(28)} ${interval.padEnd(12)}${label}`);
    if (!it.valid && it.issues) {
      for (const msg of it.issues) console.log(`     ${msg}`);
    }
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// `--validate`
// ---------------------------------------------------------------------------

function runValidate(jobId: string): void {
  try {
    const { config, path: filePath } = loadOperatorJobConfig(jobId);
    console.log(`OK: ${filePath}`);
    console.log(`  jobId:      ${config.jobId}`);
    console.log(`  intervalMs: ${config.intervalMs}`);
    if (config.label) console.log(`  label:      ${config.label}`);
    process.exit(0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Tool source — reuse the engine's ToolRegistry / McpManager logic
// ---------------------------------------------------------------------------

interface OperatorTools {
  registry: ToolRegistry;
  mcpManager: McpManager;
  toolSet: ToolSet;
  toolNames: string[];
}

/**
 * Build the same ToolSet `sportsclaw chat` would expose, minus engine-state-
 * specific internal tools (memory ops, sport install, etc.). v1: no per-job
 * filtering. The registry + mcpManager are returned so callers can use them
 * for persona resolution and clean shutdown.
 */
async function buildOperatorTools(verbose: boolean): Promise<OperatorTools> {
  const registry = new ToolRegistry();
  for (const schema of loadAllSchemas()) {
    registry.injectSchema(schema, false);
  }

  const mcpManager = new McpManager(verbose, false);
  if (mcpManager.serverCount > 0) {
    await mcpManager.connectAll();
    registry.injectMcpTools(mcpManager);
  }

  const toolSet: ToolSet = {};
  const toolNames: string[] = [];
  for (const spec of registry.getAllToolSpecs()) {
    toolNames.push(spec.name);
    toolSet[spec.name] = defineTool({
      description: spec.description,
      inputSchema: jsonSchema(spec.input_schema),
      execute: async (args: Record<string, unknown>) => {
        const result = await registry.dispatchToolCall(spec.name, args as ToolCallInput);
        if (result.isError) {
          throw new Error(result.content);
        }
        // Cap output, same policy as engine.buildTools (~30k chars).
        const MAX = 30_000;
        return result.content.length > MAX
          ? result.content.slice(0, MAX) +
              `\n\n[... output truncated: ${MAX} of ${result.content.length} chars shown]`
          : result.content;
      },
    });
  }

  return { registry, mcpManager, toolSet, toolNames };
}

// ---------------------------------------------------------------------------
// Persona + fragment resolution
// ---------------------------------------------------------------------------

const FRAGMENT_ALIASES: Record<string, string> = {
  "broadcast-directive": BROADCAST_DIRECTIVE_FRAGMENT,
  broadcast: BROADCAST_DIRECTIVE_FRAGMENT,
  "cron-autonomy": CRON_AUTONOMY_FRAGMENT,
  "tool-discipline": TOOL_DISCIPLINE_FRAGMENT,
  "silent-sentinel": SILENT_SENTINEL_FRAGMENT,
};

function resolveExtraFragments(names: string[] | undefined): string[] {
  if (!names || names.length === 0) return [];
  return names.map((n) => {
    const alias = FRAGMENT_ALIASES[n];
    return alias !== undefined ? alias : n;
  });
}

async function resolvePersona(
  cfg: OperatorJobConfig,
  mcpManager: McpManager,
): Promise<string> {
  if (cfg.personaText) return cfg.personaText;
  if (!cfg.persona) {
    throw new Error(
      `Job "${cfg.jobId}": neither personaText nor persona is set. Add one to the config.`,
    );
  }
  const machinaServer = mcpManager.getMachinaServerName();
  if (!machinaServer) {
    throw new Error(
      `Job "${cfg.jobId}": persona "${cfg.persona}" requires an MCP server, but none provides get_prompt_by_name. Inline the persona via "personaText" or configure an MCP server.`,
    );
  }
  const result = await mcpManager.callToolDirect(machinaServer, "get_prompt_by_name", {
    name: cfg.persona,
  });
  if (result.isError) {
    throw new Error(
      `Job "${cfg.jobId}": failed to resolve persona "${cfg.persona}" via MCP: ${result.content}`,
    );
  }
  // The MCP tool returns either { content: "..." } or a structured prompt;
  // accept both shapes pragmatically.
  try {
    const parsed = JSON.parse(result.content) as
      | { content?: string; text?: string; prompt?: string }
      | string;
    if (typeof parsed === "string") return parsed;
    return parsed.content ?? parsed.text ?? parsed.prompt ?? result.content;
  } catch {
    return result.content;
  }
}

// ---------------------------------------------------------------------------
// Model resolution — small dup of engine's private helper; spec forbids
// engine.ts changes, so we reproduce 3 lines rather than expose a getter.
// ---------------------------------------------------------------------------

function resolveModel(provider: LLMProvider, modelId: string) {
  switch (provider) {
    case "anthropic":
      return anthropic(modelId);
    case "openai":
      return openai(modelId);
    case "google":
      return google(modelId);
    default:
      throw new Error(`Unsupported provider: "${provider}"`);
  }
}

interface ResolvedDaemonInputs {
  provider: LLMProvider;
  modelId: string;
  rootDir: string;
  personaText: string;
  extraFragments: string[];
}

async function resolveJobInputs(
  cfg: OperatorJobConfig,
  mcpManager: McpManager,
  opts: { ensureRootDir?: boolean } = {},
): Promise<ResolvedDaemonInputs> {
  const sportsclawCfg = resolveConfig();
  applyConfigToEnv();
  const provider = cfg.provider ?? sportsclawCfg.provider ?? "google";
  const modelId =
    cfg.model ?? sportsclawCfg.model ?? defaultModelFor(provider);
  const rawRootDir = cfg.rootDir ?? defaultRootDir(cfg.jobId);
  const rootDir = expandTilde(rawRootDir);
  if (opts.ensureRootDir) {
    fs.mkdirSync(rootDir, { recursive: true });
  }
  const personaText = await resolvePersona(cfg, mcpManager);
  const extraFragments = resolveExtraFragments(cfg.extraFragments);
  return { provider, modelId, rootDir, personaText, extraFragments };
}

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

function defaultModelFor(provider: LLMProvider): string {
  switch (provider) {
    case "anthropic":
      return "claude-sonnet-4-6";
    case "openai":
      return "gpt-4.1";
    case "google":
      return "gemini-2.5-flash";
  }
}

// ---------------------------------------------------------------------------
// Structured packet — the persona may end its narrative with a JSON packet
// delimited by <<<DATA>>>...<<<END>>>. The packet carries arrays the overlay
// renders as widgets (prediction_markets, fixtures, news). We strip the
// packet from the broadcast text, parse the JSON, and post each array as
// its own telemetry event.
// ---------------------------------------------------------------------------

interface MarketItem {
  question?: string;
  prob?: number | string;
  trend?: string;
  source?: string;
}
interface FixtureItem {
  home?: string;
  away?: string;
  odds?: string;
  kickoff?: string;
  source?: string;
}
interface NewsItem {
  headline?: string;
  source?: string;
  ts?: string;
}
interface StructuredPacket {
  prediction_markets?: MarketItem[];
  fixtures?: FixtureItem[];
  news?: NewsItem[];
}
interface ParsedBroadcast {
  narrative: string;
  data: StructuredPacket | null;
  parseError?: string;
}

const PACKET_RE = /<<<DATA>>>\s*([\s\S]*?)\s*<<<END>>>/;

export function parseStructuredBroadcast(text: string): ParsedBroadcast {
  const match = text.match(PACKET_RE);
  if (!match) return { narrative: text.trim(), data: null };
  const raw = match[1].trim();
  let data: StructuredPacket | null = null;
  let parseError: string | undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      data = parsed as StructuredPacket;
    }
  } catch (err) {
    parseError = err instanceof Error ? err.message : String(err);
  }
  const narrative = text.replace(PACKET_RE, "").trim();
  return { narrative, data, parseError };
}

// ---------------------------------------------------------------------------
// Tail-server poster — non-fatal HTTP POST per TickEvent
// ---------------------------------------------------------------------------

/**
 * Map a TickEvent type to the overlay's kind vocabulary (see
 * machina-sports-tv/agent-templates/.../docs/telemetry-event-shape.md).
 * Returns kind + a human-readable message + an optional model name.
 */
function mapTickEventToTelemetry(
  evt: TickEvent,
  jobId: string,
  modelId: string | undefined,
  intervalMs: number | undefined,
): {
  kind: string;
  message: string;
  level: "info" | "warn" | "error";
  model?: string;
  prompt_excerpt?: string;
  phase?: string;
  intervalMs?: number;
} {
  switch (evt.type) {
    case "tick_started":
      // "tick" kind drives the overlay's countdown / upcoming strip — it
      // carries the schedule interval so the overlay can sync its timer.
      return {
        kind: "tick",
        message: `tick ${evt.tickId.slice(0, 12)}… started · job ${jobId}`,
        level: "info",
        phase: "started",
        intervalMs: intervalMs,
      };
    case "tick_published":
      // "broadcast" kind tells the overlay to take over the main renderer
      // slot AND populate the spotlight + "last covered" tease.
      return {
        kind: "broadcast",
        message: `${evt.toolCalls ?? 0} tool calls · ${(evt.text ?? "").length} chars`,
        level: "info",
        model: modelId,
        prompt_excerpt: evt.text,
      };
    case "tick_silent":
      return {
        kind: "reasoning",
        message: `tick ${evt.tickId.slice(0, 12)}… silent · no broadcast`,
        level: "info",
      };
    case "tick_failed":
      return {
        kind: "error",
        message: `tick failed: ${evt.reason ?? "unknown"}`,
        level: "error",
      };
    case "tick_skipped":
      return {
        kind: "gate",
        message: `tick skipped · ${evt.reason ?? "wake gate denied"}`,
        level: "warn",
      };
    default:
      return { kind: "reasoning", message: String(evt.type), level: "info" };
  }
}

async function postTelemetry(url: string, body: Record<string, unknown>): Promise<void> {
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(
      `[operate] tail-server POST failed (${url}): ${err instanceof Error ? err.message : err}`,
    );
  }
}

function makeTailServerPoster(
  tailServer: string,
  jobId: string,
  modelId?: string,
  intervalMs?: number,
): (evt: TickEvent) => Promise<void> {
  const url = tailServer.replace(/\/+$/, "") + "/ingest";
  const wfName = `sportsclaw-operate:${jobId}`;
  return async (evt: TickEvent) => {
    // For tick_published events, strip the structured packet from the
    // narrative before posting, then fan out the packet's arrays as their
    // own kind-specific events (prediction_markets / fixtures / news).
    let textOverride: string | undefined;
    let packet: StructuredPacket | null = null;
    if (evt.type === "tick_published" && evt.text) {
      const parsed = parseStructuredBroadcast(evt.text);
      textOverride = parsed.narrative;
      packet = parsed.data;
      if (parsed.parseError) {
        console.error(`[operate] structured packet parse error: ${parsed.parseError}`);
      }
    }

    const eventForMap: TickEvent = textOverride !== undefined
      ? { ...evt, text: textOverride }
      : evt;
    const mapped = mapTickEventToTelemetry(eventForMap, jobId, modelId, intervalMs);
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ts: evt.timestamp,
          kind: mapped.kind,
          message: mapped.message,
          level: mapped.level,
          model: mapped.model ?? "",
          prompt_excerpt: mapped.prompt_excerpt ?? "",
          phase: mapped.phase ?? "",
          intervalMs: mapped.intervalMs ?? 0,
          workflow_name: wfName,
        }),
      });
    } catch (err) {
      console.error(
        `[operate] tail-server POST failed (${url}): ${err instanceof Error ? err.message : err}`,
      );
    }

    // Fan out the structured packet — each array becomes a widget event.
    if (packet) {
      const ts = evt.timestamp;
      if (Array.isArray(packet.prediction_markets) && packet.prediction_markets.length > 0) {
        await postTelemetry(url, {
          ts,
          kind: "prediction_markets",
          message: `${packet.prediction_markets.length} markets live`,
          level: "info",
          workflow_name: wfName,
          items: packet.prediction_markets,
        });
      }
      if (Array.isArray(packet.fixtures) && packet.fixtures.length > 0) {
        await postTelemetry(url, {
          ts,
          kind: "fixtures",
          message: `${packet.fixtures.length} fixtures`,
          level: "info",
          workflow_name: wfName,
          items: packet.fixtures,
        });
      }
      if (Array.isArray(packet.news) && packet.news.length > 0) {
        await postTelemetry(url, {
          ts,
          kind: "news",
          message: `${packet.news.length} headlines`,
          level: "info",
          workflow_name: wfName,
          items: packet.news,
        });
      }
    }
  };
}

/**
 * Map ToolCallEvent → tv-telemetry-event. Each tool call shows up in the
 * reasoning trail as an "ingest" line with the tool name + duration so the
 * overlay surfaces which tools the LLM actually picked.
 */
function makeToolCallPoster(
  tailServer: string,
  jobId: string,
): (evt: ToolCallEvent) => void {
  const url = tailServer.replace(/\/+$/, "") + "/ingest";
  return (evt: ToolCallEvent) => {
    const level: "info" | "warn" | "error" =
      evt.outcome === "ok" ? "info" : evt.outcome === "blocked" ? "warn" : "error";
    const msg = `${evt.toolName} · ${evt.outcome} · ${evt.durationMs}ms` +
      (evt.reason ? ` · ${evt.reason}` : "");
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ts: evt.timestamp,
        kind: "ingest",
        message: msg,
        level,
        workflow_name: `sportsclaw-operate:${jobId}`,
      }),
    }).catch(() => { /* non-fatal */ });
  };
}

// ---------------------------------------------------------------------------
// `--dry-run`
// ---------------------------------------------------------------------------

async function runDryRun(jobId: string): Promise<void> {
  const { config: cfg } = loadOperatorJobConfig(jobId);
  const tools = await buildOperatorTools(false);
  try {
    const inputs = await resolveJobInputs(cfg, tools.mcpManager);
    const system = buildSystemPrompt({
      role: inputs.personaText,
      isCron: true,
      toolDiscipline: true,
      silentSentinel: true,
      extras: inputs.extraFragments,
    });
    console.log(`=== Resolved system prompt for "${cfg.jobId}" ===`);
    console.log("");
    console.log(system);
    console.log("");
    console.log(`=== Tools (${tools.toolNames.length}) ===`);
    for (const name of tools.toolNames) console.log(`  - ${name}`);
    console.log("");
    console.log(`provider: ${inputs.provider}`);
    console.log(`model:    ${inputs.modelId}`);
    console.log(`rootDir:  ${inputs.rootDir}`);
  } finally {
    await tools.mcpManager.disconnectAll().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// `--once`
// ---------------------------------------------------------------------------

async function runOnce(jobId: string): Promise<void> {
  const { config: cfg } = loadOperatorJobConfig(jobId);
  const tools = await buildOperatorTools(false);
  try {
    const inputs = await resolveJobInputs(cfg, tools.mcpManager, { ensureRootDir: true });
    const daemon = createOperatorDaemon({
      jobId: cfg.jobId,
      jobLabel: cfg.label,
      intervalMs: cfg.intervalMs,
      model: resolveModel(inputs.provider, inputs.modelId),
      role: inputs.personaText,
      tools: tools.toolSet,
      rootDir: inputs.rootDir,
      extraFragments: inputs.extraFragments,
      guardOptions: cfg.guardOptions,
      onTickEvent: cfg.tailServer
        ? makeTailServerPoster(cfg.tailServer, cfg.jobId, inputs.modelId, cfg.intervalMs)
        : undefined,
      onToolCall: cfg.tailServer
        ? makeToolCallPoster(cfg.tailServer, cfg.jobId)
        : undefined,
    });
    const event = await daemon.tickOnce();
    console.log(JSON.stringify(event, null, 2));
    // Bug #12 drain: onTickEvent posters are fire-and-forget — give them a
    // short window to flush before process.exit kills any pending fetches.
    if (cfg.tailServer) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    }
    process.exit(exitCodeFor(event));
  } finally {
    await tools.mcpManager.disconnectAll().catch(() => {});
  }
}

function exitCodeFor(event: TickEvent): number {
  switch (event.type) {
    case "tick_published":
    case "tick_silent":
      return 0;
    case "tick_skipped":
      return 1;
    case "tick_failed":
      return 2;
    default:
      return 2;
  }
}

// ---------------------------------------------------------------------------
// Foreground forever
// ---------------------------------------------------------------------------

async function runForeground(jobId: string): Promise<void> {
  const { config: cfg } = loadOperatorJobConfig(jobId);
  const tools = await buildOperatorTools(false);
  const inputs = await resolveJobInputs(cfg, tools.mcpManager, { ensureRootDir: true });

  const daemon = createOperatorDaemon({
    jobId: cfg.jobId,
    jobLabel: cfg.label,
    intervalMs: cfg.intervalMs,
    model: resolveModel(inputs.provider, inputs.modelId),
    role: inputs.personaText,
    tools: tools.toolSet,
    rootDir: inputs.rootDir,
    extraFragments: inputs.extraFragments,
    guardOptions: cfg.guardOptions,
    onTickEvent: cfg.tailServer
      ? makeTailServerPoster(cfg.tailServer, cfg.jobId, inputs.modelId, cfg.intervalMs)
      : (evt) => console.log(JSON.stringify(evt)),
    onToolCall: cfg.tailServer
      ? makeToolCallPoster(cfg.tailServer, cfg.jobId)
      : undefined,
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[operate] received ${signal}, shutting down`);
    daemon.stop();
    // Best-effort final brief so the next start sees an explicit handoff.
    try {
      await daemon.tickOnce();
    } catch {
      // Don't block exit on a final-brief failure.
    }
    await tools.mcpManager.disconnectAll().catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  console.error(
    `[operate] job=${cfg.jobId} interval=${cfg.intervalMs}ms provider=${inputs.provider} model=${inputs.modelId}`,
  );
  daemon.start();
  // Keep the process alive without unref'd heartbeat timers exiting early.
  await new Promise<void>(() => {});
}

// ---------------------------------------------------------------------------
// Exports kept for tests
// ---------------------------------------------------------------------------

export {
  buildOperatorTools,
  exitCodeFor,
  FRAGMENT_ALIASES,
  makeTailServerPoster,
  parseFlags,
  resolveExtraFragments,
  resolvePersona,
};

// Suppress unused warnings for fragment-header re-exports that may be
// consumed by callers in the future.
void EDITORIAL_MEMORY_FRAGMENT_HEADER;
void TICK_BRIEF_FRAGMENT_HEADER;
void SILENT_SENTINEL_TOKEN;
void operatorConfigPath;
