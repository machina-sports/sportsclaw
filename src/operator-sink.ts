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
 *   1. cfg.sink === "noop"      → noopSink
 *   2. cfg.sink === "broadcast" → builtin broadcast sink (deprecated path,
 *                                 to be removed when TV ships its own pkg)
 *   3. cfg.sink === <other>     → reserved for future dynamic import (npm
 *                                 package name or filesystem path); throws
 *                                 in this PR until the resolver lands.
 *   4. cfg.tailServer is set    → backward-compat: use broadcast sink
 *   5. otherwise                → noopSink
 *
 * The async signature is forward-looking — dynamic-import support will use
 * it. Callers should `await` the resolver.
 */
export async function resolveSink(
  cfg: OperatorJobConfig,
): Promise<OperatorSinkPlugin> {
  if (cfg.sink === "noop") return noopSink;
  if (cfg.sink === "broadcast") {
    const { broadcastSink } = await import("./sinks/broadcast.js");
    return broadcastSink;
  }
  if (cfg.sink) {
    throw new Error(
      `OperatorJobConfig.sink="${cfg.sink}" is not a built-in. ` +
        `External sinks (npm package / filesystem path) will be supported in a ` +
        `follow-up PR. Use "noop" or "broadcast" for now.`,
    );
  }
  // Backward-compat: legacy configs without `sink` but with a `tailServer`
  // got the broadcast sink implicitly. Preserve that.
  if (cfg.tailServer) {
    const { broadcastSink } = await import("./sinks/broadcast.js");
    return broadcastSink;
  }
  return noopSink;
}
