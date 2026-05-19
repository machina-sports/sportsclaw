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
import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import { openai, createOpenAI } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";

import {
  createOperatorDaemon,
  type TickEvent,
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
import { createGenerateImageTool } from "./image-gen.js";
import {
  resolveSink,
  type OperatorSinkPlugin,
  type SinkContext,
} from "./operator-sink.js";
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
import type { InferenceRoute, LLMProvider, OpenShellConfig } from "./types.js";

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
async function buildOperatorTools(
  cfg: OperatorJobConfig,
  verbose: boolean,
  sink?: OperatorSinkPlugin,
): Promise<OperatorTools> {
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

  // Sink-driven tool registration: domain-specific tools (e.g. recall_*)
  // and the image generator (with the sink's preferred description + sink)
  // come from the resolved sink. Without a sink, the operator daemon ships
  // sport-skills + MCP tools only — no domain-specific bits.
  if (sink) {
    if (sink.wrapImageGenerator) {
      const opts = sink.wrapImageGenerator({ cfg, mcpManager });
      toolSet["generate_image"] = createGenerateImageTool(opts);
      toolNames.push("generate_image");
    }
    sink.registerTools?.({ toolSet, toolNames, cfg, mcpManager });
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
  // The MCP tool returns one of:
  //   - a bare string (some servers)
  //   - {content|text|prompt: "..."}  (legacy/simple servers)
  //   - {data: {data: {template|content|text|prompt: "..."}, status}, status}
  //     (Machina pod's get_prompt_by_name — the prompt record nests inside
  //     data.data, and the persona text lives in the `template` field that
  //     mirrors the YAML's template:.)
  // Accept all shapes pragmatically.
  try {
    const parsed = JSON.parse(result.content);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object") {
      const p = parsed as Record<string, unknown>;
      // Direct fields.
      const direct = (p.content ?? p.text ?? p.prompt ?? p.template) as string | undefined;
      if (typeof direct === "string" && direct.length > 0) return direct;
      // Machina pod nested shape: { data: { data: { template|content|text|prompt } } }
      const outer = p.data as Record<string, unknown> | undefined;
      const inner = (outer?.data ?? outer) as Record<string, unknown> | undefined;
      if (inner) {
        const nested = (inner.template ?? inner.content ?? inner.text ?? inner.prompt) as string | undefined;
        if (typeof nested === "string" && nested.length > 0) return nested;
      }
    }
    return result.content;
  } catch {
    return result.content;
  }
}

// ---------------------------------------------------------------------------
// Model resolution — small dup of engine's private helper. Extended here to
// route through OpenShell's Privacy Router when the job opts in.
// ---------------------------------------------------------------------------

/**
 * Provider-specific default base URLs for OpenShell's `inference.local`.
 * Each SDK has its own path convention — Anthropic appends `/v1/messages`,
 * OpenAI clients expect the `/v1` prefix already in the base URL.
 */
function defaultOpenShellBaseUrl(provider: LLMProvider): string {
  switch (provider) {
    case "anthropic":
      return "https://inference.local";
    case "openai":
      return "https://inference.local/v1";
    case "google":
      throw new Error(
        "OpenShell does not support Google's API protocol. Drop the openshell block or pick provider \"anthropic\" / \"openai\".",
      );
  }
}

interface ResolvedOpenShell {
  enabled: boolean;
  baseUrl: string;
}

function resolveOpenShell(
  provider: LLMProvider,
  openshell: OpenShellConfig | undefined,
): ResolvedOpenShell | undefined {
  if (!openshell) return undefined;
  const enabled = openshell.enabled !== false; // default true when block present
  if (!enabled) return { enabled: false, baseUrl: "" };
  const baseUrl = openshell.baseUrl ?? defaultOpenShellBaseUrl(provider);
  return { enabled: true, baseUrl };
}

function resolveModel(
  provider: LLMProvider,
  modelId: string,
  openshell?: ResolvedOpenShell,
) {
  if (openshell?.enabled) {
    // Privacy Router strips client credentials and injects backend ones,
    // so the apiKey here is a placeholder that satisfies SDK validation.
    switch (provider) {
      case "anthropic":
        return createAnthropic({
          baseURL: openshell.baseUrl,
          apiKey: "openshell-unused",
        })(modelId);
      case "openai":
        return createOpenAI({
          baseURL: openshell.baseUrl,
          apiKey: "openshell-unused",
        })(modelId);
      case "google":
        // Unreachable in practice — config validator rejects this combo.
        throw new Error(
          `OpenShell mode does not support provider "${provider}".`,
        );
    }
  }
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

/**
 * Set provider-specific base-URL env vars so any code path inside this
 * process (e.g. engine.ts singletons used by sub-tools) also routes
 * through `inference.local`. The factory call in resolveModel covers the
 * daemon's own generateText path; this covers everything else.
 */
function applyOpenShellEnv(
  provider: LLMProvider,
  openshell: ResolvedOpenShell,
): void {
  switch (provider) {
    case "anthropic":
      process.env.ANTHROPIC_BASE_URL = openshell.baseUrl;
      break;
    case "openai":
      process.env.OPENAI_BASE_URL = openshell.baseUrl;
      break;
    case "google":
      // Never reached — config validator + resolveOpenShell both reject.
      break;
  }
}

interface ResolvedDaemonInputs {
  provider: LLMProvider;
  modelId: string;
  rootDir: string;
  personaText: string;
  extraFragments: string[];
  openshell?: ResolvedOpenShell;
  inferenceRoute: InferenceRoute;
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
  const openshell = resolveOpenShell(provider, cfg.openshell);
  if (openshell?.enabled) {
    applyOpenShellEnv(provider, openshell);
  }
  const inferenceRoute: InferenceRoute = openshell?.enabled
    ? { via: "openshell", baseUrl: openshell.baseUrl, provider, model: modelId }
    : { via: "direct", provider, model: modelId };
  return {
    provider,
    modelId,
    rootDir,
    personaText,
    extraFragments,
    openshell,
    inferenceRoute,
  };
}

/**
 * Best-effort startup probe: when openshell is enabled, confirm
 * `inference.local` (or the configured host) resolves before we hand
 * control to the daemon. Fails fast with a clear error message rather
 * than letting the first generateText surface an opaque DNS error.
 * Mitigates Risk R4 in docs/openshell-integration-plan.md.
 */
async function probeOpenShellHost(baseUrl: string): Promise<void> {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    throw new Error(`OpenShell mode: invalid baseUrl ${JSON.stringify(baseUrl)}`);
  }
  const { promises: dnsp } = await import("node:dns");
  try {
    await Promise.race([
      dnsp.lookup(host),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("dns lookup timeout (1.5s)")), 1500),
      ),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `OpenShell mode: cannot resolve "${host}" (${msg}). ` +
        `Are you running inside an OpenShell sandbox? ` +
        `Set openshell.enabled=false or remove the openshell block to disable.`,
    );
  }
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
// `--dry-run`
// ---------------------------------------------------------------------------

async function runDryRun(jobId: string): Promise<void> {
  const { config: cfg } = loadOperatorJobConfig(jobId);
  const sink = await resolveSink(cfg);
  const tools = await buildOperatorTools(cfg, false, sink);
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
    const memoryToolsOn = cfg.enableMemoryTools !== false;
    const memoryToolCount = memoryToolsOn ? 3 : 0;
    const totalToolCount = tools.toolNames.length + memoryToolCount;
    console.log(`=== Tools (${totalToolCount}) ===`);
    for (const name of tools.toolNames) console.log(`  - ${name}`);
    if (memoryToolsOn) {
      console.log(`  - add_lesson         (daemon-owned memory writeback)`);
      console.log(`  - replace_lesson     (daemon-owned memory writeback)`);
      console.log(`  - remove_lesson      (daemon-owned memory writeback)`);
    }
    console.log("");
    console.log(`provider:          ${inputs.provider}`);
    console.log(`model:             ${inputs.modelId}`);
    console.log(`rootDir:           ${inputs.rootDir}`);
    console.log(`sink:              ${sink.name}`);
    console.log(`memory writeback:  ${memoryToolsOn ? "enabled" : "disabled"}`);
    if (inputs.openshell?.enabled) {
      console.log(`inference:         openshell (${inputs.openshell.baseUrl})`);
    } else {
      console.log(`inference:         direct`);
    }
  } finally {
    await tools.mcpManager.disconnectAll().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// `--once`
// ---------------------------------------------------------------------------

async function runOnce(jobId: string): Promise<void> {
  const { config: cfg } = loadOperatorJobConfig(jobId);
  const sink = await resolveSink(cfg);
  const tools = await buildOperatorTools(cfg, false, sink);
  try {
    const inputs = await resolveJobInputs(cfg, tools.mcpManager, { ensureRootDir: true });
    if (inputs.openshell?.enabled) {
      await probeOpenShellHost(inputs.openshell.baseUrl);
    }
    const ctx: SinkContext = {
      jobId: cfg.jobId,
      modelId: inputs.modelId,
      intervalMs: cfg.intervalMs,
      mcpManager: tools.mcpManager,
      cfg,
    };
    const daemon = createOperatorDaemon({
      jobId: cfg.jobId,
      jobLabel: cfg.label,
      intervalMs: cfg.intervalMs,
      model: resolveModel(inputs.provider, inputs.modelId, inputs.openshell),
      role: inputs.personaText,
      tools: tools.toolSet,
      rootDir: inputs.rootDir,
      extraFragments: inputs.extraFragments,
      guardOptions: cfg.guardOptions,
      enableMemoryTools: cfg.enableMemoryTools,
      inferenceRoute: inputs.inferenceRoute,
      onTickEvent: sink.onTickEvent
        ? async (evt) => { await sink.onTickEvent!(evt, ctx); }
        : undefined,
      onToolCall: sink.onToolCall
        ? (evt) => { void sink.onToolCall!(evt, ctx); }
        : undefined,
      onComposeTickContext: sink.composeTickContext
        ? async (args) =>
            sink.composeTickContext!({
              ...args,
              cfg,
              mcpManager: tools.mcpManager,
            })
        : undefined,
    });
    const event = await daemon.tickOnce();
    console.log(JSON.stringify(event, null, 2));
    // Drain: onTickEvent / onToolCall handlers may have fire-and-forget POSTs
    // (e.g. broadcast sink's tail-server). Give them a short window to flush
    // before process.exit kills any pending fetches.
    if (sink.onTickEvent || sink.onToolCall) {
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
  const sink = await resolveSink(cfg);
  const tools = await buildOperatorTools(cfg, false, sink);
  const inputs = await resolveJobInputs(cfg, tools.mcpManager, { ensureRootDir: true });
  if (inputs.openshell?.enabled) {
    await probeOpenShellHost(inputs.openshell.baseUrl);
  }

  const ctx: SinkContext = {
    jobId: cfg.jobId,
    modelId: inputs.modelId,
    intervalMs: cfg.intervalMs,
    mcpManager: tools.mcpManager,
    cfg,
  };
  const daemon = createOperatorDaemon({
    jobId: cfg.jobId,
    jobLabel: cfg.label,
    intervalMs: cfg.intervalMs,
    model: resolveModel(inputs.provider, inputs.modelId, inputs.openshell),
    role: inputs.personaText,
    tools: tools.toolSet,
    rootDir: inputs.rootDir,
    extraFragments: inputs.extraFragments,
    guardOptions: cfg.guardOptions,
    enableMemoryTools: cfg.enableMemoryTools,
    inferenceRoute: inputs.inferenceRoute,
    onTickEvent: sink.onTickEvent
      ? async (evt) => { await sink.onTickEvent!(evt, ctx); }
      : (evt) => console.log(JSON.stringify(evt)),
    onToolCall: sink.onToolCall
      ? (evt) => { void sink.onToolCall!(evt, ctx); }
      : undefined,
    onComposeTickContext: sink.composeTickContext
      ? async (args) =>
          sink.composeTickContext!({
            ...args,
            cfg,
            mcpManager: tools.mcpManager,
          })
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

  const inferenceTag = inputs.openshell?.enabled
    ? ` inference=openshell(${inputs.openshell.baseUrl})`
    : "";
  console.error(
    `[operate] job=${cfg.jobId} interval=${cfg.intervalMs}ms provider=${inputs.provider} model=${inputs.modelId}${inferenceTag}`,
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
