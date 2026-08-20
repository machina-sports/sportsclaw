/**
 * FFprobe/FFmpeg extraction — the single implementation shared by the CLI
 * (`sportsclaw clip`) and the relay job path (`sportsclaw highlights run`).
 * Accurate re-encoding avoids keyframe-aligned stream-copy overshoot while
 * producing broadly playable social/highlight clips.
 */

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { extname } from "node:path";
import type { FfprobeData } from "fluent-ffmpeg";

const INPUT_PROTOCOL_ALLOWLIST = "file";
const FFMPEG_PROTOCOL_ALLOWLIST = "file,pipe";
const INPUT_FORMAT_ALLOWLIST = "mov,matroska,webm,avi,mpegts";
const INDIRECT_EXTENSIONS = new Set([".m3u", ".m3u8", ".ffconcat"]);
const MAX_PROBE_OUTPUT_BYTES = 16 * 1024 * 1024;

async function rejectIndirectInput(filePath: string): Promise<void> {
  if (INDIRECT_EXTENSIONS.has(extname(filePath).toLowerCase())) {
    throw new Error("Playlist and concat inputs are not supported");
  }
  const handle = await open(filePath, "r");
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new Error("Input must be a regular video file");
    const prefix = Buffer.alloc(Math.min(4096, fileStat.size));
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    const text = prefix.subarray(0, bytesRead).toString("utf8").trimStart();
    if (/^(?:#EXTM3U|ffconcat\s+version\b)/i.test(text)) {
      throw new Error("Playlist and concat inputs are not supported");
    }
  } finally {
    await handle.close();
  }
}

export async function probeVideo(filePath: string): Promise<FfprobeData> {
  await rejectIndirectInput(filePath);
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFPROBE_PATH || "ffprobe", [
      "-v", "error",
      "-protocol_whitelist", INPUT_PROTOCOL_ALLOWLIST,
      "-format_whitelist", INPUT_FORMAT_ALLOWLIST,
      "-show_streams",
      "-show_format",
      "-of", "json",
      filePath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let outputExceeded = false;
    child.stdout.on("data", (rawChunk: Buffer) => {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_PROBE_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_384);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (outputExceeded) {
        reject(new Error(`FFprobe output exceeded ${MAX_PROBE_OUTPUT_BYTES} bytes`));
        return;
      }
      if (code !== 0) {
        reject(new Error(
          `FFprobe exited with code ${String(code)}${signal ? ` (${signal})` : ""}: ${stderr.trim()}`,
        ));
        return;
      }
      try {
        const data = JSON.parse(Buffer.concat(stdout).toString("utf8")) as FfprobeData;
        if (data.format?.duration !== undefined) {
          data.format.duration = Number(data.format.duration);
        }
        resolve(data);
      } catch (err) {
        reject(new Error(`FFprobe returned invalid JSON: ${String(err)}`));
      }
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
  await rejectIndirectInput(input);
  const outputFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
    (constants.O_NOFOLLOW ?? 0);
  const handle = await open(output, outputFlags, 0o600);
  const child = spawn(process.env.FFMPEG_PATH || "ffmpeg", [
    "-v", "error",
    "-ss", String(startSec),
    "-protocol_whitelist", FFMPEG_PROTOCOL_ALLOWLIST,
    "-format_whitelist", INPUT_FORMAT_ALLOWLIST,
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
