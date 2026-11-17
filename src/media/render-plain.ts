/**
 * The plain renderer: cuts clips from the source, draws a card as a black frame, writes the
 * checked caption at the bottom centre, and joins everything into a 1280x720 H.264/AAC mp4.
 *
 * Overlay values and subjectTracksArtifactId are ignored here on purpose: the plain renderer
 * has no tracking or graphics; a skill's renderer is what uses them.
 *
 * Each segment is rendered to its own mp4 with identical parameters, then joined with the
 * concat demuxer. Caption text goes through a textfile (never argv or filter syntax), so it
 * needs no shell or filter escaping.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { INPUT_FORMAT_ALLOWLIST, INPUT_PROTOCOL_ALLOWLIST, probeVideo, rejectIndirectInput } from "../highlights/ffmpeg.js";
import type { ResolvedTimeline, TimelineSegment } from "./timeline.js";

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
const CAPTION_WRAP_CHARS = 52;

const ffmpegBin = (): string => process.env.FFMPEG_PATH || "ffmpeg";

function hasDrawtext(): boolean {
  const run = spawnSync(ffmpegBin(), ["-hide_banner", "-filters"], { encoding: "utf8" });
  return run.status === 0 && /\bdrawtext\b/.test(run.stdout ?? "");
}

/** Wrap on spaces so a long caption stays inside the frame. */
function wrapCaption(text: string): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > CAPTION_WRAP_CHARS) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

function runFfmpeg(args: string[], cwd: string, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error("Render aborted"));
      return;
    }
    const child = spawn(ffmpegBin(), ["-v", "error", "-nostdin", "-y", ...args], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      signal: abortSignal,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_384);
    });
    child.once("error", (err) => reject(abortSignal?.aborted ? new Error("Render aborted") : err));
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else if (abortSignal?.aborted) reject(new Error("Render aborted"));
      else reject(new Error(`FFmpeg exited with code ${String(code)}${signal ? ` (${signal})` : ""}: ${stderr.trim()}`));
    });
  });
}

/** Demuxers accepted for a voice file: wav, mp3, ogg (incl. opus), flac, mov (incl. mp4/m4a), matroska/webm (opus). */
const VOICE_FORMAT_ALLOWLIST = "wav,mp3,ogg,flac,mov,matroska,webm";

/** Per-input hardening, as in the highlights path: file protocol only, named demuxers only. */
const hardenInput = (formats: string): string[] => ["-protocol_whitelist", INPUT_PROTOCOL_ALLOWLIST, "-format_whitelist", formats];

const AUDIO_NORMALISE = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";

export async function renderPlain(args: {
  timeline: ResolvedTimeline;
  sourcePath: string;
  voicePaths: Record<string, string>;
  outPath: string;
  abortSignal?: AbortSignal;
}): Promise<{ durationSec: number }> {
  const { timeline, abortSignal } = args;
  // ffmpeg runs with cwd in a work dir (see renderSegment), so every path must be absolute.
  const sourcePath = resolve(args.sourcePath);
  const outPath = resolve(args.outPath);
  const voicePaths = Object.fromEntries(Object.entries(args.voicePaths).map(([id, p]) => [id, resolve(p)]));
  const { segments, captions } = timeline;

  if (captions.some((c) => c !== null) && !hasDrawtext()) {
    throw new Error("This FFmpeg build has no drawtext filter, so captions cannot be drawn; install an FFmpeg with libfreetype");
  }
  for (const seg of segments) {
    if (seg.voiceArtifactId !== undefined && voicePaths[seg.voiceArtifactId] === undefined) {
      throw new Error(`No file for voice artifact ${seg.voiceArtifactId}`);
    }
  }
  // Playlist and concat files would make ffmpeg fetch URLs or read local files into the output.
  await rejectIndirectInput(sourcePath);
  for (const p of Object.values(voicePaths)) await rejectIndirectInput(p);
  const sourceHasAudio = segments.some((s) => s.kind === "clip")
    ? (await probeVideo(sourcePath)).streams.some((s) => s.codec_type === "audio")
    : false;

  // Work next to the output so the final rename stays on one filesystem.
  const work = await mkdtemp(join(dirname(outPath), ".render-plain-"));
  try {
    const segmentFiles: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const caption = captions[i];
      const name = `seg_${i}.mp4`;
      await renderSegment(seg, caption, i, name, work, sourcePath, sourceHasAudio, seg.voiceArtifactId === undefined ? undefined : voicePaths[seg.voiceArtifactId], abortSignal);
      segmentFiles.push(name);
    }

    await writeFile(join(work, "list.txt"), segmentFiles.map((f) => `file '${f}'`).join("\n") + "\n");
    await runFfmpeg(
      ["-f", "concat", "-safe", "0", "-protocol_whitelist", "file", "-i", "list.txt", "-c", "copy", "-movflags", "+faststart", "joined.mp4"],
      work,
      abortSignal,
    );
    const joined = join(work, "joined.mp4");
    const durationSec = Number((await probeVideo(joined)).format?.duration);
    await rename(joined, outPath);
    return { durationSec };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function renderSegment(
  seg: TimelineSegment,
  caption: string | null,
  index: number,
  outName: string,
  work: string,
  sourcePath: string,
  sourceHasAudio: boolean,
  voicePath: string | undefined,
  abortSignal?: AbortSignal,
): Promise<void> {
  const isClip = seg.kind === "clip";
  const length = isClip ? (seg.endSec as number) - (seg.startSec as number) : (seg.cardSeconds as number);

  let video = isClip
    ? `[0:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p`
    : `[0:v]format=yuv420p`;
  if (caption !== null) {
    const captionFile = `caption_${index}.txt`;
    await writeFile(join(work, captionFile), wrapCaption(caption));
    // The textfile is a bare name resolved against cwd (= work), so the filter needs no path escaping.
    video += `,drawtext=textfile=${captionFile}:expansion=none:fontcolor=white:fontsize=36:box=1:boxcolor=black@0.6:boxborderw=12:x=(w-text_w)/2:y=h-text_h-48`;
  }
  video += "[v]";

  const inputs: string[] = [];
  let audioLabel: string;
  const filters: string[] = [video];
  if (isClip) {
    inputs.push("-ss", String(seg.startSec), "-t", String(length), ...hardenInput(INPUT_FORMAT_ALLOWLIST), "-i", sourcePath);
  } else {
    inputs.push("-f", "lavfi", "-i", `color=c=black:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${length}`);
  }
  if (voicePath !== undefined) {
    inputs.push(...hardenInput(VOICE_FORMAT_ALLOWLIST), "-i", voicePath);
    filters.push(`[1:a]${AUDIO_NORMALISE},apad[a]`);
    audioLabel = "[a]";
  } else if (isClip && sourceHasAudio) {
    filters.push(`[0:a]${AUDIO_NORMALISE},apad[a]`);
    audioLabel = "[a]";
  } else {
    inputs.push("-f", "lavfi", "-i", `anullsrc=r=48000:cl=stereo`);
    filters.push("[1:a]anull[a]");
    audioLabel = "[a]";
  }

  await runFfmpeg(
    [
      ...inputs,
      "-filter_complex", filters.join(";"),
      "-map", "[v]", "-map", audioLabel,
      "-t", String(length),
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-threads", "1", "-pix_fmt", "yuv420p", "-r", String(FPS),
      "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
      "-map_metadata", "-1",
      outName,
    ],
    work,
    abortSignal,
  );
}
