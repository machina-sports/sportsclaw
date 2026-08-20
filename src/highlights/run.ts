/**
 * Deterministic highlights execution: validate → probe → plan → extract →
 * verify → manifest. No LLM calls anywhere in this path; every failure mode
 * (missing file, missing FFmpeg/FFprobe, no in-range windows, unverifiable
 * clip) fails closed with a descriptive error.
 */

import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { extractSegment, probeVideo } from "./ffmpeg.js";
import { DEFAULT_WINDOW_POLICY, parseHighlightsRequest, planCandidateWindows } from "./plan.js";
import type { ClipArtifact, ClipManifest, FfprobeEvidence } from "./types.js";

export class HighlightsRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HighlightsRunError";
  }
}

/**
 * Hard per-job output budget (bytes). Overridable via the
 * HIGHLIGHTS_MAX_JOB_OUTPUT_BYTES environment variable; the relay injects the
 * value clamped to its global storage quota. Finite by design — an accepted
 * job must never be able to fill the disk before later requests are rejected.
 */
export const DEFAULT_MAX_JOB_OUTPUT_BYTES = 2 * 1024 ** 3;

/** Fail closed if measured output differs from its requested window by more than this. */
const CLIP_DURATION_TOLERANCE_SEC = 0.5;

/** Parse a budget env value; anything but a positive integer falls back to the finite default. */
export function resolveMaxJobOutputBytes(raw: string | undefined): number {
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw.trim())) return DEFAULT_MAX_JOB_OUTPUT_BYTES;
  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return DEFAULT_MAX_JOB_OUTPUT_BYTES;
  return parsed;
}

function safeFileName(actionId: string): string {
  return actionId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64);
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

async function probeEvidence(file: string, what: string): Promise<FfprobeEvidence> {
  let data;
  try {
    data = await probeVideo(file);
  } catch (err) {
    throw new HighlightsRunError(
      `FFprobe failed for ${what} (${file}) — is FFmpeg/FFprobe installed? ${String(err)}`
    );
  }
  const durationSec = data.format?.duration ?? 0;
  if (!durationSec || durationSec <= 0) {
    throw new HighlightsRunError(`Could not determine duration via ffprobe for ${what}: ${file}`);
  }
  const streamDuration = (type: "video" | "audio") => {
    const stream = data.streams?.find((candidate) => candidate.codec_type === type);
    const duration = Number(stream?.duration);
    return Number.isFinite(duration) && duration > 0 ? duration : undefined;
  };
  return {
    durationSec,
    formatName: String(data.format?.format_name ?? ""),
    videoDurationSec: streamDuration("video"),
    audioDurationSec: streamDuration("audio"),
  };
}

/** Execute a validated highlights request and return the clip manifest. */
export async function runHighlights(request: unknown): Promise<ClipManifest> {
  const req = parseHighlightsRequest(request);

  if (!existsSync(req.source.path)) {
    throw new HighlightsRunError(`Input file not found: ${req.source.path}`);
  }

  // Reject an unsafe outputDir before probing or writing anything, so a bad
  // target never clobbers the source and never leaves partial output behind.
  const sourceReal = realpathSync(req.source.path);
  const outputTarget = existsSync(req.outputDir) ? realpathSync(req.outputDir) : resolve(req.outputDir);
  if (outputTarget === sourceReal) {
    throw new HighlightsRunError("outputDir must not resolve to the source file");
  }
  if (existsSync(outputTarget) && !statSync(outputTarget).isDirectory()) {
    throw new HighlightsRunError(`outputDir resolves to an existing non-directory target: ${req.outputDir}`);
  }

  const sourceEvidence = await probeEvidence(req.source.path, "source video");
  const windows = planCandidateWindows(req, sourceEvidence.durationSec);
  if (windows.length === 0) {
    throw new HighlightsRunError(
      "No candidate windows fall inside the source video — check the sync anchor and PBP clock values"
    );
  }

  const budgetBytes = resolveMaxJobOutputBytes(process.env.HIGHLIGHTS_MAX_JOB_OUTPUT_BYTES);
  const plannedFiles = windows.map((window, index) => join(
    req.outputDir,
    `clip_${String(index + 1).padStart(2, "0")}_${safeFileName(window.actionId)}.mp4`,
  ));
  for (const file of plannedFiles) {
    const targetExists = pathEntryExists(file);
    const targetStat = targetExists ? lstatSync(file) : undefined;
    if (targetStat?.isSymbolicLink() || (targetStat && !targetStat.isFile())) {
      throw new HighlightsRunError(`Generated clip target must be a new regular file, not a symlink or special file: ${file}`);
    }
    const target = targetExists ? realpathSync(file) : resolve(file);
    if (target === sourceReal) {
      throw new HighlightsRunError(`Generated clip target resolves to the source file: ${file}`);
    }
    if (targetExists) {
      throw new HighlightsRunError(`Generated clip target already exists and will not be overwritten: ${file}`);
    }
  }
  mkdirSync(req.outputDir, { recursive: true });

  let writtenBytes = 0;
  const clips: ClipArtifact[] = [];
  const createdFiles = new Set<string>();
  const removePartialOutputs = () => {
    for (const partial of createdFiles) {
      try {
        if (existsSync(partial) && realpathSync(partial) !== sourceReal) {
          rmSync(partial, { force: true });
        }
      } catch {
        // The path changed after creation; fail closed without deleting it.
      }
    }
  };
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const requestedDurationSec = w.endSec - w.startSec;
    const remainingBudgetBytes = budgetBytes - writtenBytes;
    if (remainingBudgetBytes <= 0) {
      removePartialOutputs();
      throw new HighlightsRunError(
        `Generated output exhausted the per-job output budget of ${budgetBytes} bytes ` +
        "(HIGHLIGHTS_MAX_JOB_OUTPUT_BYTES) — partial clips were removed"
      );
    }
    const file = plannedFiles[i];
    try {
      await extractSegment(
        req.source.path,
        file,
        w.startSec,
        requestedDurationSec,
        remainingBudgetBytes
      );
      createdFiles.add(file);
    } catch (err) {
      removePartialOutputs();
      throw new HighlightsRunError(
        `FFmpeg extraction failed for action ${w.actionId} — is FFmpeg installed? ${String(err)}`
      );
    }
    // Check actual cumulative bytes after every clip; a breach removes
    // everything written so far rather than leaving partial output behind.
    const outputStat = lstatSync(file);
    if (outputStat.isSymbolicLink() || !outputStat.isFile()) {
      removePartialOutputs();
      throw new HighlightsRunError(`Generated clip target changed during extraction: ${file}`);
    }
    writtenBytes += outputStat.size;
    if (writtenBytes > budgetBytes) {
      removePartialOutputs();
      throw new HighlightsRunError(
        `Generated output (${writtenBytes} bytes after ${i + 1} clip(s)) exceeded the per-job ` +
        `output budget of ${budgetBytes} bytes (HIGHLIGHTS_MAX_JOB_OUTPUT_BYTES) — ` +
        "partial clips were removed"
      );
    }
    let ffprobe: FfprobeEvidence;
    try {
      ffprobe = await probeEvidence(file, `clip for action ${w.actionId}`);
    } catch (err) {
      removePartialOutputs();
      throw err;
    }
    if (ffprobe.videoDurationSec === undefined) {
      removePartialOutputs();
      throw new HighlightsRunError(
        `FFprobe reported no usable video duration for action ${w.actionId} — partial clips were removed`,
      );
    }
    if (Math.abs(ffprobe.videoDurationSec - requestedDurationSec) > CLIP_DURATION_TOLERANCE_SEC) {
      removePartialOutputs();
      throw new HighlightsRunError(
        `FFmpeg produced a ${ffprobe.videoDurationSec}s video duration for action ${w.actionId}, outside the allowed ` +
        `±${CLIP_DURATION_TOLERANCE_SEC}s tolerance for the ${requestedDurationSec}s request ` +
        `(remaining output budget: ${remainingBudgetBytes} bytes) — partial clips were removed`
      );
    }
    clips.push({ ...w, file, durationSec: ffprobe.videoDurationSec, ffprobe });
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    state: "succeeded",
    event: req.event,
    rights: req.rights,
    source: { ...req.source, ffprobe: sourceEvidence },
    syncAnchor: req.syncAnchor,
    window: req.window ?? DEFAULT_WINDOW_POLICY,
    windows,
    clips,
  };
}
