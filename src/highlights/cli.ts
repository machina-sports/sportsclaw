/**
 * `sportsclaw highlights run --request <json> [--output <json>]`
 *
 * The typed, non-interactive entrypoint the project relay invokes for each
 * job. Reads a HighlightsRequest JSON file, executes the deterministic core,
 * and writes the resulting manifest (or a {state:"failed", error} payload) to
 * the --output path so the relay can persist job results.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { runHighlights } from "./run.js";
import type { ClipManifest } from "./types.js";

const USAGE = "usage: sportsclaw highlights run --request <request.json> [--output <manifest.json>]";

interface HighlightsRunFlags {
  requestPath?: string;
  outputPath?: string;
}

function parseRunFlags(args: string[]): HighlightsRunFlags {
  const flags: HighlightsRunFlags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--request" && args[i + 1]) flags.requestPath = args[++i];
    else if (args[i] === "--output" && args[i + 1]) flags.outputPath = args[++i];
  }
  return flags;
}

/**
 * Load a request JSON file and execute the deterministic core. Shared by
 * `sportsclaw highlights run` and `sportsclaw clip --request`.
 */
export async function runHighlightsRequestFile(requestPath: string): Promise<ClipManifest> {
  let raw: string;
  try {
    raw = readFileSync(requestPath, "utf-8");
  } catch (err) {
    throw new Error(`cannot read request file ${requestPath}: ${String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`request file ${requestPath} is not valid JSON: ${String(err)}`);
  }
  return runHighlights(parsed);
}

export async function cmdHighlights(args: string[]): Promise<void> {
  if (args[0] !== "run") {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const flags = parseRunFlags(args.slice(1));
  if (!flags.requestPath) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  try {
    const manifest = await runHighlightsRequestFile(flags.requestPath);
    if (flags.outputPath) {
      writeFileSync(flags.outputPath, JSON.stringify(manifest, null, 2), "utf-8");
    }
    console.log(
      `highlights: ${manifest.clips.length} clip(s) written to ${manifest.clips[0] ? manifest.clips.map((c) => c.file).join(", ") : "(none)"}`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (flags.outputPath) {
      writeFileSync(flags.outputPath, JSON.stringify({ state: "failed", error: message }, null, 2), "utf-8");
    }
    console.error(`highlights: ${message}`);
    process.exitCode = 1;
  }
}
