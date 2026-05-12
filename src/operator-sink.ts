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
 * Sinks are resolved from `OperatorJobConfig.sink`. Built-ins:
 *   "noop"      — no-op; tick events stream to stdout as NDJSON
 *   "broadcast" — sportsclaw's bundled broadcast sink (deprecated; TV will
 *                 move to its own package, scheduled for a follow-up PR)
 *
 * External sinks (npm package or filesystem path) will land in a follow-up
 * once the TV sink moves to machina-sports-tv. The interface is stable.
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
 *   1. cfg.sink === "noop"      → noopSink (built-in)
 *   2. cfg.sink === "broadcast" → bundled broadcast sink — DEPRECATED. Emits
 *                                 a stderr warning. Install the
 *                                 @machina-sports/tv-operator-sink package
 *                                 and set cfg.sink to it instead.
 *   3. cfg.sink begins with "./", "../" or "/", or ends in ".js" / ".mjs"
 *                               → filesystem path. Dynamic-import relative to
 *                                 process.cwd() (or use as-is when absolute).
 *   4. cfg.sink === <other>     → npm package name. Resolves via dynamic
 *                                 import — the package must be installed
 *                                 alongside sportsclaw (workspace dep, npm
 *                                 link, or published).
 *   5. cfg.tailServer is set    → DEPRECATED implicit fallback to the
 *                                 bundled broadcast sink. Same warning as
 *                                 case 2.
 *   6. otherwise                → noopSink
 *
 * External modules (cases 3 and 4) must expose the sink as one of:
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
  if (cfg.sink === "broadcast") {
    emitBroadcastDeprecationWarning("explicit");
    const { broadcastSink } = await import("./sinks/broadcast.js");
    return broadcastSink;
  }
  if (cfg.sink) {
    return loadExternalSink(cfg.sink);
  }
  // Backward-compat: legacy configs without `sink` but with a `tailServer`
  // got the broadcast sink implicitly. Preserve that.
  if (cfg.tailServer) {
    emitBroadcastDeprecationWarning("implicit");
    const { broadcastSink } = await import("./sinks/broadcast.js");
    return broadcastSink;
  }
  return noopSink;
}

// ---------------------------------------------------------------------------
// Deprecation warning
// ---------------------------------------------------------------------------

/**
 * Emit a one-line stderr warning when the bundled broadcast sink resolves.
 * Fires for both code paths:
 *   - "explicit": `cfg.sink === "broadcast"` — caller asked for it by name
 *   - "implicit": `cfg.tailServer` set without `cfg.sink` — legacy fallback
 *
 * Both will be removed in a follow-up PR after a soak window. The migration
 * target is the @machina-sports/tv-operator-sink package, which exposes the
 * same plugin at its public name.
 *
 * Suppress via env: SPORTSCLAW_SUPPRESS_DEPRECATION=1 (for deployments still
 * in transition that don't want warning lines polluting their logs).
 */
function emitBroadcastDeprecationWarning(mode: "explicit" | "implicit"): void {
  if (process.env.SPORTSCLAW_SUPPRESS_DEPRECATION === "1") return;
  const reason =
    mode === "explicit"
      ? `cfg.sink="broadcast" resolves to the BUNDLED broadcast sink.`
      : `cfg.tailServer is set but cfg.sink is not — falling back to the BUNDLED broadcast sink.`;
  console.error(
    `[sportsclaw] DEPRECATED: ${reason} ` +
      `The bundled broadcast sink is scheduled for removal. ` +
      `Install @machina-sports/tv-operator-sink and set ` +
      `\`"sink": "@machina-sports/tv-operator-sink"\` in your operator job config. ` +
      `Suppress this warning with SPORTSCLAW_SUPPRESS_DEPRECATION=1.`,
  );
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
