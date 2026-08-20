/**
 * sportsclaw Auto-Clipper — Conversational CLI Wizard
 *
 * Adapter over the deterministic highlights core (src/highlights/*). The
 * wizard collects real inputs — a rights authorization file, real play-by-play
 * (PBP) actions, and a fixed video sync anchor — and hands them to the same
 * core the relay job API executes. There is no mocked timestamp selection and
 * no LLM call in this path.
 *
 * Interactive flow:
 *   1. Match selection via natural language → sports-skills local lookup
 *   2. Video file selection with validation
 *   3. Real PBP actions JSON file
 *   4. Rights authorization JSON file
 *   5. Video sync anchor (video second ↔ PBP clock second)
 *   6. Deterministic extraction via the highlights core (FFprobe/FFmpeg)
 *
 * Flags:
 *   --request <path>           Full typed HighlightsRequest JSON (skips wizard)
 *   --yes, --non-interactive   Skip all prompts (requires --request)
 *   --file <path>              Video file path (skip prompt)
 *   --match <query>            Match query (skip prompt)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { executePythonBridge } from "./tools.js";
import { resolveConfig } from "./config.js";
import { runHighlights } from "./highlights/run.js";
import { runHighlightsRequestFile } from "./highlights/cli.js";
import type { ClipManifest, PBPAction, RightsAuthorization } from "./highlights/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MatchOption {
  value: string;
  label: string;
  hint?: string;
}

interface ClipFlags {
  nonInteractive: boolean;
  request?: string;
  file?: string;
  match?: string;
  intent?: string;
  format?: "landscape" | "vertical";
}

const DEFAULT_OUTPUT_DIR = "./highlights";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseClipArgs(args: string[]): ClipFlags {
  const flags: ClipFlags = { nonInteractive: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--yes" || arg === "--non-interactive") {
      flags.nonInteractive = true;
    } else if (arg === "--request" && args[i + 1]) {
      flags.request = args[++i];
    } else if (arg === "--file" && args[i + 1]) {
      flags.file = args[++i];
    } else if (arg === "--match" && args[i + 1]) {
      flags.match = args[++i];
    } else if (arg === "--intent" && args[i + 1]) {
      flags.intent = args[++i];
    } else if (arg === "--format" && args[i + 1]) {
      const fmt = args[++i];
      if (fmt === "landscape" || fmt === "vertical") {
        flags.format = fmt;
      }
    }
  }

  return flags;
}

// ---------------------------------------------------------------------------
// Sports-skills match discovery
// ---------------------------------------------------------------------------

/** Sport modules to query for recent matches */
const MATCH_SPORTS = [
  { skill: "football", label: "Football (Soccer)" },
  { skill: "nba",      label: "NBA" },
  { skill: "nfl",      label: "NFL" },
  { skill: "mlb",      label: "MLB" },
  { skill: "nhl",      label: "NHL" },
] as const;

/**
 * Query local sports-skills for recent/live matches across multiple sports.
 * Parses the bridge result and returns a flat array of selectable options.
 */
async function fetchRecentMatches(
  query?: string,
  pythonPath?: string,
): Promise<MatchOption[]> {
  const options: MatchOption[] = [];
  const config = { pythonPath: pythonPath ?? "python3", timeout: 15_000 };

  // Query each sport for scores (recent/live games)
  const sportQueries = MATCH_SPORTS.map(async ({ skill, label }) => {
    try {
      const result = await executePythonBridge(skill, "scores", undefined, config);
      if (!result.success || !result.data) return [];

      const data = result.data as Record<string, unknown>;
      const events = extractEvents(data);

      return events.map((evt) => ({
        value: `${skill}_${evt.id}`,
        label: evt.name,
        hint: label,
      }));
    } catch {
      return [];
    }
  });

  const results = await Promise.allSettled(sportQueries);
  for (const r of results) {
    if (r.status === "fulfilled") {
      options.push(...r.value);
    }
  }

  // Filter by query if provided
  if (query && query.trim().length > 0) {
    const q = query.toLowerCase();
    const filtered = options.filter(
      (o) => o.label.toLowerCase().includes(q) || (o.hint ?? "").toLowerCase().includes(q)
    );
    if (filtered.length > 0) return filtered;
  }

  return options;
}

/**
 * Extract event entries from a sports-skills scores response.
 * Handles the common ESPN data shape: { events: [{ id, name, ... }] }
 * as well as flat arrays and nested data wrappers.
 */
function extractEvents(data: Record<string, unknown>): Array<{ id: string; name: string }> {
  // Direct events array
  if (Array.isArray(data.events)) {
    return (data.events as Array<Record<string, unknown>>)
      .filter((e) => typeof e.id === "string" && typeof e.name === "string")
      .map((e) => ({ id: e.id as string, name: e.name as string }));
  }

  // Nested under data.events (sports-skills wrapper)
  if (data.data && typeof data.data === "object") {
    const inner = data.data as Record<string, unknown>;
    if (Array.isArray(inner.events)) {
      return (inner.events as Array<Record<string, unknown>>)
        .filter((e) => typeof e.id === "string" && typeof e.name === "string")
        .map((e) => ({ id: e.id as string, name: e.name as string }));
    }
  }

  // Flat array at top level
  if (Array.isArray(data)) {
    return (data as Array<Record<string, unknown>>)
      .filter((e) => typeof e.id === "string" && typeof e.name === "string")
      .map((e) => ({ id: e.id as string, name: e.name as string }));
  }

  return [];
}

// ---------------------------------------------------------------------------
// File validation
// ---------------------------------------------------------------------------

const VIDEO_EXTENSIONS = new Set([".mp4", ".mkv", ".mov", ".avi", ".webm", ".ts", ".m4v"]);

function validateVideoPath(filePath: string): string | undefined {
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    return `File not found: ${resolved}`;
  }
  const ext = resolved.slice(resolved.lastIndexOf(".")).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) {
    return `Unsupported video format: ${ext}. Supported: ${[...VIDEO_EXTENSIONS].join(", ")}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Real-input loaders (PBP actions + rights authorization)
// ---------------------------------------------------------------------------

function loadJsonFile(path: string, what: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(resolve(path), "utf-8");
  } catch (err) {
    throw new Error(`cannot read ${what} file ${path}: ${String(err)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${what} file ${path} is not valid JSON: ${String(err)}`);
  }
}

/** Accepts either a bare array of actions or `{ "actions": [...] }`. */
function loadPBPActions(path: string): PBPAction[] {
  const parsed = loadJsonFile(path, "PBP actions");
  if (Array.isArray(parsed)) return parsed as PBPAction[];
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).actions)) {
    return (parsed as { actions: PBPAction[] }).actions;
  }
  throw new Error(`PBP actions file ${path} must be a JSON array or an object with an "actions" array`);
}

const MISSING_REAL_INPUTS_ERROR = [
  "clip requires real inputs: play-by-play (PBP) actions, rights authorization, and a video sync anchor.",
  "Mocked/evenly-spaced timestamp selection has been removed.",
  "",
  "Provide a typed request file:",
  "  sportsclaw clip --non-interactive --request <request.json>",
  "or use the typed job entrypoint directly:",
  "  sportsclaw highlights run --request <request.json> --output <manifest.json>",
].join("\n");

// ---------------------------------------------------------------------------
// Main CLI flow
// ---------------------------------------------------------------------------

export async function cmdClip(args: string[] = [], _opts?: { fromChat?: boolean }): Promise<void> {
  const flags = parseClipArgs(args);

  p.intro(pc.bold("SportsClaw Auto-Clipper") + pc.dim(" (deterministic PBP engine)"));

  if (flags.format === "vertical") {
    console.error("9:16 auto-tracking is not implemented in V1. Re-run with --format landscape.");
    process.exitCode = 1;
    return;
  }
  if (flags.intent) {
    p.log.info("Note: --intent is not used in V1 — clip selection is driven by the PBP actions file.");
  }

  // Typed request path: same core, no prompts.
  if (flags.request) {
    try {
      const manifest = await runHighlightsRequestFile(flags.request);
      printManifestSummary(manifest);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`clip: ${message}`);
      process.exitCode = 1;
    }
    return;
  }

  // Non-interactive without a typed request: fail honestly — prompts cannot
  // provide real PBP/rights/sync inputs, and mocked selection is gone.
  if (flags.nonInteractive) {
    console.error(MISSING_REAL_INPUTS_ERROR);
    process.exitCode = 1;
    return;
  }

  // Step 1: Match selection — conversational natural language flow
  const { pythonPath } = resolveConfig();
  let sport: string;
  let eventId: string;
  let selectedMatchLabel: string;

  {
    const matchQuery = flags.match ?? (await (async () => {
      const q = await p.text({
        message: "What match are you clipping?",
        placeholder: "e.g., Corinthians vs Flamengo, Lakers vs Warriors",
      });
      if (p.isCancel(q)) {
        p.cancel("Cancelled.");
        return process.exit(0);
      }
      return q as string;
    })());

    const s = p.spinner();
    s.start("Searching local sports-skills for matching fixtures...");

    const matches = await fetchRecentMatches(matchQuery, pythonPath);

    if (matches.length === 0) {
      s.stop("No matches found.");
      p.log.warn(
        "Could not find matching fixtures via sports-skills.\n" +
        "  Tip: Try a broader query, or ensure sports-skills is installed:\n" +
        "    sportsclaw init"
      );

      // Allow manual event identity entry as fallback
      const manualId = await p.text({
        message: "Enter a match/event ID manually (or Ctrl+C to cancel):",
        placeholder: "e.g., 401234567",
      });
      if (p.isCancel(manualId)) {
        p.cancel("Cancelled.");
        return process.exit(0);
      }
      const manualSport = await p.text({
        message: "Which sport module is this event from?",
        placeholder: "e.g., football, nba, nfl",
      });
      if (p.isCancel(manualSport)) {
        p.cancel("Cancelled.");
        return process.exit(0);
      }
      sport = (manualSport as string).trim();
      eventId = (manualId as string).trim();
      selectedMatchLabel = `${sport}_${eventId}`;
    } else {
      s.stop(`Found ${matches.length} fixture(s).`);

      const selection = await p.select({
        message: "Select the match:",
        options: matches.map((m) => ({
          value: m.value,
          label: m.label,
          hint: m.hint,
        })),
      });
      if (p.isCancel(selection)) {
        p.cancel("Cancelled.");
        return process.exit(0);
      }

      const value = selection as string;
      const idx = value.indexOf("_");
      sport = idx > 0 ? value.slice(0, idx) : value;
      eventId = idx > 0 ? value.slice(idx + 1) : value;
      selectedMatchLabel = matches.find((m) => m.value === selection)?.label ?? value;
    }
  }

  // Step 2: Video file selection with validation
  let videoPath: string;

  if (flags.file) {
    const err = validateVideoPath(flags.file);
    if (err) {
      p.log.error(err);
      process.exit(1);
    }
    videoPath = resolve(flags.file);
    p.log.info(`Video: ${videoPath}`);
  } else {
    const fileInput = await p.text({
      message: "Where is the local video file?",
      placeholder: "./downloads/match.mp4",
      validate: (val) => val ? validateVideoPath(val) : "File path is required.",
    });
    if (p.isCancel(fileInput)) {
      p.cancel("Cancelled.");
      return process.exit(0);
    }
    videoPath = resolve(fileInput as string);
  }

  // Step 3: Real PBP actions (no mocked timestamps — a real feed export)
  const pbpInput = await p.text({
    message: "Path to the real PBP actions JSON file:",
    placeholder: "./pbp-actions.json",
    validate: (val) => (val && existsSync(resolve(val)) ? undefined : "PBP actions file is required."),
  });
  if (p.isCancel(pbpInput)) {
    p.cancel("Cancelled.");
    return process.exit(0);
  }

  // Step 4: Rights authorization
  const rightsInput = await p.text({
    message: "Path to the rights authorization JSON file:",
    placeholder: "./rights.json",
    validate: (val) => (val && existsSync(resolve(val)) ? undefined : "Rights file is required."),
  });
  if (p.isCancel(rightsInput)) {
    p.cancel("Cancelled.");
    return process.exit(0);
  }

  // Step 5: Fixed video sync anchor
  const anchorVideo = await promptNumber("Sync anchor — source-video second of the anchored moment:", "120");
  if (anchorVideo === undefined) return process.exit(0);
  const anchorClock = await promptNumber("Sync anchor — PBP elapsed-clock second at that same moment:", "0");
  if (anchorClock === undefined) return process.exit(0);

  // Step 6: Output directory
  const outDirInput = await p.text({
    message: "Output directory for clips:",
    placeholder: DEFAULT_OUTPUT_DIR,
    defaultValue: DEFAULT_OUTPUT_DIR,
  });
  if (p.isCancel(outDirInput)) {
    p.cancel("Cancelled.");
    return process.exit(0);
  }

  console.log("");
  p.log.info(
    pc.bold("Pipeline Summary") + "\n" +
    `  Match:   ${selectedMatchLabel}\n` +
    `  Video:   ${videoPath}\n` +
    `  PBP:     ${pbpInput}\n` +
    `  Rights:  ${rightsInput}\n` +
    `  Anchor:  video ${anchorVideo}s ↔ clock ${anchorClock}s\n` +
    `  Event:   ${sport}/${eventId}`
  );

  const proceed = await p.confirm({
    message: "Start extraction?",
    initialValue: true,
  });
  if (p.isCancel(proceed) || !proceed) {
    p.cancel("Cancelled.");
    return process.exit(0);
  }

  try {
    const manifest = await runHighlights({
      rights: loadJsonFile(rightsInput as string, "rights authorization") as RightsAuthorization,
      source: { kind: "local-file", path: videoPath },
      event: { provider: "espn", sport, eventId },
      actions: loadPBPActions(pbpInput as string),
      syncAnchor: { videoSec: anchorVideo, clockSec: anchorClock },
      outputDir: resolve(outDirInput as string),
    });
    printManifestSummary(manifest);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    p.log.error(message);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function promptNumber(message: string, placeholder: string): Promise<number | undefined> {
  const input = await p.text({
    message,
    placeholder,
    validate: (val) => {
      const n = Number(val);
      return val && Number.isFinite(n) && n >= 0 ? undefined : "Enter a number >= 0.";
    },
  });
  if (p.isCancel(input)) {
    p.cancel("Cancelled.");
    return undefined;
  }
  return Number(input as string);
}

function printManifestSummary(manifest: ClipManifest): void {
  p.log.success(`${manifest.clips.length} highlight clip(s) extracted:`);
  for (const clip of manifest.clips) {
    p.log.info(
      `  [${clip.type}] ${clip.label} @ ${fmtTime(clip.actionVideoSec)} → ${clip.file}`
    );
  }
  p.outro("Ready to post!");
}

function fmtTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}
