/**
 * FFprobe/FFmpeg extraction — the single implementation shared by the CLI
 * (`sportsclaw clip`) and the relay job path (`sportsclaw highlights run`).
 * Accurate re-encoding avoids keyframe-aligned stream-copy overshoot while
 * producing broadly playable social/highlight clips.
 */

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { open, rm } from "node:fs/promises";
import type { FfprobeData } from "fluent-ffmpeg";

const require = createRequire(import.meta.url);
const ffmpeg = require("fluent-ffmpeg") as typeof import("fluent-ffmpeg");

export function probeVideo(filePath: string): Promise<FfprobeData> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err: Error | null, data: FfprobeData) => {
      if (err) return reject(err);
      resolve(data);
    });
  });
}

export function extractSegment(
  input: string,
  output: string,
  startSec: number,
  durationSec: number,
  maxOutputBytes: number,
): Promise<void> {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    return Promise.reject(new Error("maxOutputBytes must be a positive safe integer"));
  }

  return streamExtractSegment(input, output, startSec, durationSec, maxOutputBytes);
}

async function streamExtractSegment(
  input: string,
  output: string,
  startSec: number,
  durationSec: number,
  maxOutputBytes: number,
): Promise<void> {
  const handle = await open(output, "w");
  const child = spawn(process.env.FFMPEG_PATH || "ffmpeg", [
    "-v", "error",
    "-ss", String(startSec),
    "-i", input,
    "-t", String(durationSec),
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "20",
    "-threads", "1",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-map_metadata", "-1",
    "-avoid_negative_ts", "make_zero",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4",
    "pipe:1",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-16_384);
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  try {
    let writtenBytes = 0;
    for await (const rawChunk of child.stdout) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      if (writtenBytes + chunk.length > maxOutputBytes) {
        child.kill("SIGKILL");
        throw new Error(`FFmpeg output exceeded maxOutputBytes budget of ${maxOutputBytes} bytes`);
      }
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        offset += bytesWritten;
      }
      writtenBytes += chunk.length;
    }

    const { code, signal } = await exited;
    if (code !== 0) {
      throw new Error(
        `FFmpeg exited with code ${String(code)}${signal ? ` (${signal})` : ""}: ${stderr.trim()}`,
      );
    }
    await handle.close();
  } catch (err) {
    child.kill("SIGKILL");
    await exited.catch(() => undefined);
    await handle.close().catch(() => undefined);
    await rm(output, { force: true });
    throw err;
  }
}
