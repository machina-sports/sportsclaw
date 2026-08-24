#!/usr/bin/env node
/**
 * Generate the synthetic/cleared 90s match fixture video (86ak32k1w).
 *
 * Pure FFmpeg testsrc — no broadcast footage, no rights concerns, safe to
 * regenerate anywhere. The classic `testsrc` pattern burns a visible clock
 * into the frame, so a human can verify that a clip cut for "goal at match
 * clock 0:15 with anchor 5s" really shows video seconds ~12–32.
 *
 * Usage: node scripts/make-fixture-video.mjs [out.mp4] [durationSec]
 */
import { spawnSync } from "node:child_process";

const out = process.argv[2] ?? "test/fixtures/synthetic-match.mp4";
const duration = Number(process.argv[3] ?? 90);

const res = spawnSync(
  "ffmpeg",
  [
    "-y",
    "-f", "lavfi", "-i", `testsrc=size=1280x720:rate=30:duration=${duration}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${duration}`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    // 1s GOP so `-c copy` window cuts land within a second of the target —
    // copy-cut precision always depends on the source's keyframe interval.
    "-g", "30", "-keyint_min", "30", "-sc_threshold", "0",
    "-c:a", "aac", "-shortest",
    out,
  ],
  { stdio: "inherit" },
);

process.exit(res.status ?? 1);
