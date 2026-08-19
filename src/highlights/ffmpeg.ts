/**
 * FFprobe/FFmpeg extraction — the single implementation shared by the CLI
 * (`sportsclaw clip`) and the relay job path (`sportsclaw highlights run`).
 * Moved here from src/clipper.ts so the highlights core owns extraction;
 * behavior (stream copy, -avoid_negative_ts make_zero) is unchanged.
 */

import { createRequire } from "node:module";
import type { FfprobeData } from "fluent-ffmpeg";

const require = createRequire(import.meta.url);
const ffmpeg = require("fluent-ffmpeg") as typeof import("fluent-ffmpeg");

// FFmpeg's -fs check happens at packet boundaries, so reserve room for the
// final encoded packet and muxer trailer instead of aiming at the last byte.
const FFMPEG_SIZE_HEADROOM_BYTES = 256 * 1024;

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
  const ffmpegSizeLimit = Math.max(1, maxOutputBytes - FFMPEG_SIZE_HEADROOM_BYTES);
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .setStartTime(startSec)
      .duration(durationSec)
      .outputOptions([
        "-c copy",
        "-avoid_negative_ts make_zero",
        "-fs",
        String(ffmpegSizeLimit),
      ])
      .output(output)
      .on("end", () => resolve())
      .on("error", (err: Error) => reject(err))
      .run();
  });
}
