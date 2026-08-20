/**
 * `sportsclaw highlights run --request <json> [--output <json>]`
 *
 * The typed, non-interactive entrypoint the project relay invokes for each
 * job. Reads a HighlightsRequest JSON file, executes the deterministic core,
 * and writes the resulting manifest (or a {state:"failed", error} payload) to
 * the --output path so the relay can persist job results.
 */

import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseHighlightsRequest } from "./plan.js";
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
  return runHighlights(parseHighlightsRequest(readRequestFile(requestPath)));
}

function readRequestFile(requestPath: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(requestPath, "utf-8");
  } catch (err) {
    throw new Error(`cannot read request file ${requestPath}: ${String(err)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`request file ${requestPath} is not valid JSON: ${String(err)}`);
  }
}

function comparablePath(path: string): string {
  let existingAncestor = resolve(path);
  const missingComponents: string[] = [];
  while (!pathEntryExists(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) return resolve(path);
    missingComponents.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  return resolve(realpathSync(existingAncestor), ...missingComponents);
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isWithin(path: string, directory: string): boolean {
  const pathRelative = relative(directory, path);
  return pathRelative === "" || (
    pathRelative !== ".." &&
    !pathRelative.startsWith(`..${sep}`) &&
    !isAbsolute(pathRelative)
  );
}

function validateManifestOutput(outputPath: string, requestPath: string, request: unknown): void {
  if (outputPath.includes("\0")) throw new Error("manifest --output contains an invalid character");
  const output = comparablePath(outputPath);
  if (output === comparablePath(requestPath)) {
    throw new Error("manifest --output must not resolve to the request file");
  }

  if (request && typeof request === "object" && !Array.isArray(request)) {
    const value = request as Record<string, unknown>;
    const source = value.source;
    if (source && typeof source === "object" && !Array.isArray(source)) {
      const sourcePath = (source as Record<string, unknown>).path;
      if (typeof sourcePath === "string" && output === comparablePath(sourcePath)) {
        throw new Error("manifest --output must not resolve to the source file");
      }
    }
    if (typeof value.outputDir === "string") {
      const outputDir = comparablePath(value.outputDir);
      if (isWithin(output, outputDir)) {
        throw new Error("manifest --output must be outside the clip output directory");
      }
    }
  }

  if (pathEntryExists(outputPath)) {
    throw new Error("manifest --output already exists and will not be overwritten");
  }
}

function unlinkOwned(path: string, device: number, inode: number): void {
  try {
    const current = lstatSync(path);
    if (current.dev === device && current.ino === inode) unlinkSync(path);
  } catch {
    // Never remove a path whose identity cannot be confirmed.
  }
}

function writeManifestAtomic(outputPath: string, payload: unknown): void {
  const temporary = `${dirname(outputPath)}/.${basename(outputPath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let temporaryFd: number | undefined;
  let reservationFd: number | undefined;
  let temporaryIdentity: { dev: number; ino: number } | undefined;
  let reservationIdentity: { dev: number; ino: number } | undefined;
  try {
    temporaryFd = openSync(temporary, "wx", 0o600);
    const temporaryStat = fstatSync(temporaryFd);
    temporaryIdentity = { dev: temporaryStat.dev, ino: temporaryStat.ino };
    writeFileSync(temporaryFd, JSON.stringify(payload, null, 2), "utf-8");
    fsyncSync(temporaryFd);
    closeSync(temporaryFd);
    temporaryFd = undefined;

    reservationFd = openSync(outputPath, "wx", 0o600);
    const reservationStat = fstatSync(reservationFd);
    reservationIdentity = { dev: reservationStat.dev, ino: reservationStat.ino };
    const current = lstatSync(outputPath);
    if (current.dev !== reservationIdentity.dev || current.ino !== reservationIdentity.ino) {
      throw new Error("manifest --output changed during atomic publication");
    }
    renameSync(temporary, outputPath);
    temporaryIdentity = undefined;
    closeSync(reservationFd);
    reservationFd = undefined;
  } catch (err) {
    if (temporaryFd !== undefined) closeSync(temporaryFd);
    if (reservationFd !== undefined) closeSync(reservationFd);
    if (temporaryIdentity) unlinkOwned(temporary, temporaryIdentity.dev, temporaryIdentity.ino);
    if (reservationIdentity) unlinkOwned(outputPath, reservationIdentity.dev, reservationIdentity.ino);
    throw err;
  }
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

  let canWriteFailure = false;
  try {
    const rawRequest = readRequestFile(flags.requestPath);
    if (flags.outputPath) {
      validateManifestOutput(flags.outputPath, flags.requestPath, rawRequest);
      canWriteFailure = true;
    }
    const manifest = await runHighlights(parseHighlightsRequest(rawRequest));
    if (flags.outputPath) writeManifestAtomic(flags.outputPath, manifest);
    console.log(
      `highlights: ${manifest.clips.length} clip(s) written to ${manifest.clips[0] ? manifest.clips.map((c) => c.file).join(", ") : "(none)"}`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (flags.outputPath && canWriteFailure) {
      try {
        writeManifestAtomic(flags.outputPath, { state: "failed", error: message });
      } catch {
        // Never replace an unrelated file that appeared while the job ran.
      }
    }
    console.error(`highlights: ${message}`);
    process.exitCode = 1;
  }
}
