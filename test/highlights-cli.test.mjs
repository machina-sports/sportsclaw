/**
 * Highlights CLI adapters — `sportsclaw highlights run` and `sportsclaw clip`
 *
 * Both commands must be thin consumers of the same deterministic core
 * (src/highlights/*): the typed subcommand is what the relay invokes, and the
 * legacy `clip` wizard must fail honestly when it cannot provide real
 * PBP/rights/sync inputs instead of silently falling back to mocked selection.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = join(repoRoot, "dist/index.js");
const core = await import(join(repoRoot, "dist/highlights/index.js"));

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

let workDir;
let sourceVideo;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "sportsclaw-highlights-cli-"));
  sourceVideo = join(workDir, "synthetic-match.mp4");
  const gen = spawnSync(FFMPEG, [
    "-y", "-f", "lavfi", "-i", "testsrc=duration=45:size=160x90:rate=10",
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "10", "-keyint_min", "10",
    "-pix_fmt", "yuv420p", sourceVideo,
  ], { encoding: "utf-8" });
  assert.equal(gen.status, 0, `fixture generation failed: ${gen.stderr}`);
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function requestFor(outputDir, overrides = {}) {
  return {
    rights: {
      rightsHolder: "Machina Test League",
      licenseRef: "license/test-2026-001",
      clearedForClipping: true,
    },
    source: { kind: "local-file", path: sourceVideo },
    event: { provider: "espn", sport: "football", eventId: "401234567" },
    actions: [
      {
        actionId: "goal-1",
        provider: "espn",
        period: 1,
        clock: { semantics: "elapsed-ascending", elapsedSec: 10 },
        label: "Goal",
        type: "goal",
        importance: 95,
        provenance: "espn:pbp:401234567:goal-1",
      },
      {
        actionId: "save-1",
        provider: "espn",
        period: 1,
        clock: { semantics: "elapsed-ascending", elapsedSec: 30 },
        label: "Save",
        type: "save",
        importance: 55,
        provenance: "espn:pbp:401234567:save-1",
      },
    ],
    syncAnchor: { videoSec: 2, clockSec: 0 },
    window: { preRollSec: 3, postRollSec: 4, maxCandidates: 5 },
    outputDir,
    ...overrides,
  };
}

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [distEntry, ...args], {
    encoding: "utf-8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// sportsclaw highlights run — the typed subcommand the relay invokes
// ---------------------------------------------------------------------------

describe("sportsclaw highlights run", () => {
  it("executes a typed request and writes the core manifest to --output", () => {
    const caseDir = join(workDir, "run-ok");
    mkdirSync(caseDir, { recursive: true });
    const requestPath = join(caseDir, "request.json");
    const outputPath = join(caseDir, "output.json");
    const outputDir = join(caseDir, "clips");
    const request = requestFor(outputDir);
    writeFileSync(requestPath, JSON.stringify(request), "utf-8");

    const run = runCli(["highlights", "run", "--request", requestPath, "--output", outputPath]);
    assert.equal(run.status, 0, `expected success:\n${run.stdout}\n${run.stderr}`);

    const manifest = JSON.parse(readFileSync(outputPath, "utf-8"));
    assert.equal(manifest.state, "succeeded");
    assert.equal(manifest.event.eventId, "401234567");
    assert.equal(manifest.rights.rightsHolder, "Machina Test League");

    // Same core: the CLI's windows must equal a direct core invocation.
    const expected = core.planCandidateWindows(request, manifest.source.ffprobe.durationSec);
    assert.deepEqual(
      manifest.windows.map((w) => ({ id: w.actionId, start: w.startSec, end: w.endSec })),
      expected.map((w) => ({ id: w.actionId, start: w.startSec, end: w.endSec }))
    );

    // Clips exist and pass an independent ffprobe.
    assert.equal(manifest.clips.length, 2);
    for (const clip of manifest.clips) {
      assert.ok(existsSync(clip.file), `clip must exist: ${clip.file}`);
      const probe = spawnSync(FFPROBE, ["-v", "error", "-show_format", clip.file], { encoding: "utf-8" });
      assert.equal(probe.status, 0, `ffprobe must pass: ${probe.stderr}`);
      assert.match(clip.provenance, /^espn:pbp:/);
    }
  });

  it("fails closed with a structured error when rights are missing", () => {
    const caseDir = join(workDir, "run-no-rights");
    mkdirSync(caseDir, { recursive: true });
    const requestPath = join(caseDir, "request.json");
    const outputPath = join(caseDir, "output.json");
    const request = requestFor(join(caseDir, "clips"));
    delete request.rights;
    writeFileSync(requestPath, JSON.stringify(request), "utf-8");

    const run = runCli(["highlights", "run", "--request", requestPath, "--output", outputPath]);
    assert.notEqual(run.status, 0, "missing rights must fail");
    assert.match(run.stderr, /rights/i);

    const output = JSON.parse(readFileSync(outputPath, "utf-8"));
    assert.equal(output.state, "failed");
    assert.match(output.error, /rights/i);
  });

  it("fails with an actionable error when the request file does not exist", () => {
    const run = runCli(["highlights", "run", "--request", join(workDir, "nope.json"), "--output", join(workDir, "o.json")]);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /request/i);
  });

  it("fails with usage guidance when --request is omitted", () => {
    const run = runCli(["highlights", "run"]);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /--request/);
  });

  it("fails closed when FFmpeg/FFprobe are not available", () => {
    const caseDir = join(workDir, "run-no-ffmpeg");
    mkdirSync(join(caseDir, "bin"), { recursive: true });
    const requestPath = join(caseDir, "request.json");
    const outputPath = join(caseDir, "output.json");
    writeFileSync(requestPath, JSON.stringify(requestFor(join(caseDir, "clips"))), "utf-8");

    const run = runCli(
      ["highlights", "run", "--request", requestPath, "--output", outputPath],
      { env: { PATH: join(caseDir, "bin"), HOME: caseDir } }
    );
    assert.notEqual(run.status, 0, "missing ffmpeg must fail, not silently skip");
    assert.match(run.stderr, /ffprobe|ffmpeg/i);
  });
});

// ---------------------------------------------------------------------------
// sportsclaw clip — legacy wizard as an adapter over the same core
// ---------------------------------------------------------------------------

describe("sportsclaw clip (refactored adapter)", () => {
  it("non-interactive without real inputs fails honestly, pointing at --request", () => {
    const run = runCli(["clip", "--non-interactive"]);
    assert.notEqual(run.status, 0, "legacy mocked flow must not silently run");
    const text = `${run.stdout}\n${run.stderr}`;
    assert.match(text, /--request/, "error must tell the caller how to provide real inputs");
    assert.match(text, /PBP|play-by-play/i, "error must name the missing real data");
  });

  it("non-interactive with --request runs the same deterministic core", () => {
    const caseDir = join(workDir, "clip-request");
    mkdirSync(caseDir, { recursive: true });
    const requestPath = join(caseDir, "request.json");
    const outputDir = join(caseDir, "clips");
    writeFileSync(requestPath, JSON.stringify(requestFor(outputDir)), "utf-8");

    const run = runCli(["clip", "--non-interactive", "--request", requestPath]);
    assert.equal(run.status, 0, `expected success:\n${run.stdout}\n${run.stderr}`);
    assert.ok(existsSync(join(outputDir, "clip_01_goal-1.mp4")), "core-named clip must exist");
    assert.ok(existsSync(join(outputDir, "clip_02_save-1.mp4")), "core-named clip must exist");
  });
});

// ---------------------------------------------------------------------------
// Source contracts — no mocks, no LLM in the deterministic path, shared core
// ---------------------------------------------------------------------------

describe("clipper source contract", () => {
  const clipperSource = readFileSync(join(repoRoot, "src/clipper.ts"), "utf-8");

  it("imports the shared highlights core", () => {
    assert.match(clipperSource, /from "\.\/highlights\//, "clip must consume src/highlights/*");
  });

  it("contains no mocked/evenly-spaced timestamp generator", () => {
    assert.ok(!/searchPBPTimestamps/.test(clipperSource), "mock PBP generator must be gone");
    assert.ok(
      !/totalDurationSec \/ \(count \+ 1\)|spacing \* i/.test(clipperSource),
      "even-spacing timestamp math must be gone"
    );
  });

  it("has no LLM calls in the deterministic extraction path", () => {
    assert.ok(!/generative-ai/i.test(clipperSource), "Gemini must not be imported by clip");
    for (const file of ["types.ts", "plan.ts", "ffmpeg.ts", "run.ts", "index.ts", "cli.ts"]) {
      const src = readFileSync(join(repoRoot, "src/highlights", file), "utf-8");
      assert.ok(!/generative-ai|GoogleGenerativeAI/i.test(src), `no LLM in highlights/${file}`);
    }
  });

  it("owns FFmpeg extraction in the core, not a second implementation", () => {
    assert.ok(
      !/require\("fluent-ffmpeg"\)/.test(clipperSource),
      "clipper.ts must not carry its own fluent-ffmpeg copy"
    );
  });
});
