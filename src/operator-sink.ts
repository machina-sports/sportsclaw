/**
 * Operator Sink Plugin — the seam where domain-specific concerns (telemetry
 * destinations, domain tools, archive layouts) hook into the otherwise-
 * generic operator daemon.
 *
 * Why a plugin?
 * The daemon's tick lifecycle is universal: schedule → wake-gate → load
 * memory → generateText → write brief → mark heartbeat. But what to DO with
 * the resulting events is wildly domain-specific:
 *   - SportsClaw TV posts kind="broadcast" events to a tail-server, parses
 *     a structured packet, archives to a tv-content-archive doc, registers
 *     recall_recent_content + recall_library tools.
 *   - A betting agent might POST signed trades, archive to a positions-log,
 *     register expose_edge or close_position tools.
 *   - A scouting agent might write to a scouting-report dataset, register
 *     recall_player_history tools.
 *
 * None of those belong in sportsclaw core. The sink interface lets each
 * domain ship its own driver outside this repo (or as a separate package).
 *
 * The four hooks:
 *   - registerTools     — add domain-specific tools to the daemon's toolset
 *   - wrapImageGenerator — override generate_image's description + sink
 *   - onTickEvent       — handle every TickEvent (the existing callback)
 *   - onToolCall        — handle every ToolCallEvent (the existing callback)
 *
 * Sinks are resolved from `OperatorJobConfig.sink`. The only built-in is
 * `"noop"` (tick events stream to stdout as NDJSON). Any other value is
 * loaded at runtime — npm package name or filesystem path — via dynamic
 * import. See `resolveSink` / `loadExternalSink` below.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ToolSet } from "ai";

import type { TickEvent, ToolCallEvent } from "./operator-daemon.js";
import type { OperatorJobConfig } from "./operator-config.js";
import type { McpManager } from "./mcp.js";
import type { CreateGenerateImageToolOpts } from "./image-gen.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-tick context passed to onTickEvent / onToolCall. The sink may use
 * fields here to construct telemetry envelopes (e.g. modelId in a broadcast
 * payload, intervalMs in a tick-anchor event).
 *
 * The full `cfg` is exposed so sinks can read domain-specific fields they
 * care about (e.g. broadcast sink reads `cfg.tailServer`) without the core
 * needing to know which fields any given sink touches.
 */
export interface SinkContext {
  jobId: string;
  /** Resolved model id, e.g. "gemini-3.1-pro-preview". */
  modelId?: string;
  /** Tick cadence in ms, e.g. 90000 for a 90-second channel. */
  intervalMs?: number;
  /** MCP manager handle (only set when the daemon was configured with one). */
  mcpManager?: McpManager;
  /** Full operator job config, for sinks reading domain-specific fields. */
  cfg: OperatorJobConfig;
}

/**
 * The contract a domain implements to plug into the operator daemon.
 *
 * All hooks are optional — the noop sink implements none of them and
 * simply prints events to stdout when used as the default for the
 * foreground runForeground path.
 */
export interface OperatorSinkPlugin {
  /** Stable identifier, used in `cfg.sink` resolution + diagnostics. */
  name: string;

  /**
   * Register domain-specific tools on the daemon's toolset. Called once
   * during `buildOperatorTools` after sport-skills + MCP tools are
   * already populated. Mutate `toolSet` in place.
   *
   * Mirror the same `toolNames` list the daemon uses for --dry-run output
   * by mutating that array too.
   */
  registerTools?(args: {
    toolSet: ToolSet;
    toolNames: string[];
    cfg: OperatorJobConfig;
    mcpManager: McpManager;
  }): void;

  /**
   * If implemented, returns the options passed to `createGenerateImageTool`
   * for this domain — letting the sink override the description (e.g.
   * "broadcast-overlay image, poster card") and the onImage sink (e.g.
   * disk-write + telemetry + archive).
   *
   * If omitted, the daemon won't register generate_image at all for this
   * sink. Chat-mode's generate_image (in engine.ts) is unaffected — the
   * sink interface only governs operator-mode.
   */
  wrapImageGenerator?(args: {
    cfg: OperatorJobConfig;
    mcpManager: McpManager;
  }): CreateGenerateImageToolOpts;

  /**
   * Pre-tick context composer. Called once per tick BEFORE the LLM call so
   * the sink can inject deterministic, daemon-side directives into the tick
   * input (e.g. a scored rotation pool, a live-match cue, an editorial
   * override). The returned string is prepended to the tick prompt; return
   * null/undefined to add nothing.
   *
   * Use this — instead of persona rules — when you want a constraint the
   * LLM cannot ignore. Rules in the persona compete with the LLM's training
   * prior; data injected into the tick input doesn't.
   *
   * Errors are caught and logged; the tick proceeds without the directive.
   */
  composeTickContext?(args: {
    jobId: string;
    tickId: string;
    timestamp: string;
    cfg: OperatorJobConfig;
    mcpManager: McpManager;
  }): Promise<string | null | undefined> | string | null | undefined;

  /**
   * Optional structured-output spec the daemon enforces via Vercel AI SDK's
   * `experimental_output: Output.object({schema})`. When this returns a
   * value, the daemon:
   *   - validates every model response against the schema (with SDK-side
   *     retries on mismatch)
   *   - suppresses the legacy `[SILENT]` sentinel fragment (the schema is
   *     expected to carry a `silent` field if the sink wants to support
   *     "skip this tick")
   *   - populates `TickEvent.output` with the parsed object, so sinks can
   *     consume the structured result without any text parsing
   *
   * Return `undefined` to keep the legacy free-text path (no SDK validation;
   * sink owns any envelope parsing). Built-in sinks that don't model a
   * structured contract should leave this unimplemented.
   *
   * Shape:
   *   { schema: <JSON Schema object>, name?: string, description?: string }
   *
   * `name` and `description` are forwarded to `Output.object` — they're hints
   * that some providers expose to the model (e.g. via the tool/schema name).
   * Use them; they materially improve adherence on smaller models.
   */
  /**
   * Cheap wake probe (PR3): runs BEFORE any model call to decide whether this
   * tick has work. Return `{ wake: false }` to skip the tick entirely — zero
   * model calls. MUST be cheap I/O only (no inference). Wired to the daemon's
   * wake gate; a throw or timeout fails closed (skip). The actual claim /
   * preparation happens in `composeTickContext` inside tick single-flight, so a
   * `pollWake` that only peeks (non-mutating) is safe even when the daemon is busy.
   */
  pollWake?(args: { cfg: OperatorJobConfig }):
    | Promise<{ wake: boolean; context?: string; reason?: string }>
    | { wake: boolean; context?: string; reason?: string };

  getOutputSchema?(args: { cfg: OperatorJobConfig }):
    | {
        schema: unknown;
        /** Schema name hint (legacy meaning; not the tool name). */
        name?: string;
        /** Forced output tool name. Default "submit_broadcast" (back-compat);
         * generic sinks set "submit_result", the Vault "submit_vault_answer". */
        toolName?: string;
        description?: string;
        /** Domain guidance appended to the neutral output instruction. */
        guidance?: string;
        /** Classify the submitted output (default: `silent===true` → idle). */
        classify?: (output: unknown) => "idle" | "answer";
        /** Extract the human-facing text (default: `.narrative`). */
        extractText?: (output: unknown) => string | undefined;
      }
    | undefined;

  /**
   * Per-tick event handler. Called once per `tick_started` / `tick_published`
   * / `tick_silent` / `tick_failed` / `tick_skipped` emission. Sinks may
   * `await` the call — the daemon awaits it before the next tick can fire.
   * Throwing here does NOT halt the daemon; the runtime logs and continues.
   */
  onTickEvent?(evt: TickEvent, ctx: SinkContext): Promise<void> | void;

  /**
   * Per-tool-call event handler. Called once per `ok` / `error` / `blocked`
   * outcome inside a tick. Same awaiting + error contract as onTickEvent.
   */
  onToolCall?(evt: ToolCallEvent, ctx: SinkContext): Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Default no-op sink
// ---------------------------------------------------------------------------

/**
 * Inert sink. Registers no tools, no image generator, ignores all events.
 * Used when no `sink` is configured and no `tailServer` is set (backward
 * compat). The runForeground path falls through to printing TickEvents to
 * stdout when the sink is noop.
 */
export const noopSink: OperatorSinkPlugin = {
  name: "noop",
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve which sink to use for a given job config. Resolution order:
 *
 *   1. cfg.sink === "noop"     → noopSink (built-in)
 *   2. cfg.sink begins with "./", "../", "/", or ends in ".js"/".mjs"
 *                              → filesystem path. Dynamic-import resolved
 *                                against process.cwd() (or absolute as-is).
 *   3. cfg.sink === <other>    → npm package name. Dynamic-import — the
 *                                package must be installed alongside
 *                                sportsclaw (workspace dep, npm link, or
 *                                published).
 *   4. otherwise               → noopSink
 *
 * External modules (cases 2 and 3) must expose the sink as one of:
 *   - `export default <plugin>`
 *   - `export const sink = <plugin>` (named export)
 *
 * The resolver picks `default` first, then `sink`. The chosen value must be
 * an object with a string `name` field — minimal contract check; runtime
 * validation of the hooks themselves happens lazily when they're called.
 */
export async function resolveSink(
  cfg: OperatorJobConfig,
): Promise<OperatorSinkPlugin> {
  if (cfg.sink === "noop") return noopSink;
  if (cfg.sink) return loadExternalSink(cfg.sink);
  return noopSink;
}

// ---------------------------------------------------------------------------
// External sink loader
// ---------------------------------------------------------------------------

/**
 * Load a sink plugin from an external module — either a filesystem path or
 * an npm package name. ESM dynamic-import in both cases.
 *
 * Filesystem detection: a spec is treated as a path if it starts with `./`,
 * `../`, `/`, or ends in `.js`/`.mjs`/`.cjs`. Everything else is treated as
 * an npm package name and passed through to `import()` directly — Node's
 * resolver handles workspace deps, `npm link`'d packages, and installed
 * packages identically. The caller's CWD is used to resolve relative paths.
 *
 * Module shape: the loader accepts `default` export OR `sink` named export.
 * `default` wins. The chosen value must be an object with a string `name`
 * field. Tools / hook methods are validated lazily — a sink that ships
 * neither registerTools nor any event hook is technically legal (and
 * equivalent to noopSink).
 */
async function loadExternalSink(spec: string): Promise<OperatorSinkPlugin> {
  let mod: unknown;
  try {
    const specifier = isFilesystemSpec(spec)
      ? toFileUrl(spec)
      : spec;
    mod = await import(specifier);
  } catch (err) {
    throw new Error(
      `Failed to load operator sink "${spec}": ` +
        (err instanceof Error ? err.message : String(err)) +
        ". Check the path/package is reachable from the daemon's working " +
        "directory and exports a default or named `sink` plugin.",
    );
  }
  if (!mod || typeof mod !== "object") {
    throw new Error(`Operator sink module "${spec}" did not produce a module object.`);
  }
  const m = mod as Record<string, unknown>;
  const candidate = (m.default ?? m.sink) as unknown;
  if (!candidate || typeof candidate !== "object") {
    throw new Error(
      `Operator sink "${spec}" exports neither a default nor a named "sink" — ` +
        "module must export one or the other as an OperatorSinkPlugin object.",
    );
  }
  const plugin = candidate as Record<string, unknown>;
  if (typeof plugin.name !== "string" || !plugin.name) {
    throw new Error(
      `Operator sink "${spec}" is missing the required \`name\` field on its plugin export.`,
    );
  }
  return plugin as unknown as OperatorSinkPlugin;
}

function isFilesystemSpec(spec: string): boolean {
  if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/")) return true;
  if (/\.(?:js|mjs|cjs)$/.test(spec)) return true;
  return false;
}

/**
 * ESM dynamic import needs an absolute path as a file:// URL (or a bare
 * specifier). Relative paths get resolved against process.cwd() so daemons
 * launched from arbitrary working directories behave predictably.
 */
function toFileUrl(spec: string): string {
  const absolute = path.isAbsolute(spec) ? spec : path.resolve(process.cwd(), spec);
  return pathToFileURL(absolute).href;
}
