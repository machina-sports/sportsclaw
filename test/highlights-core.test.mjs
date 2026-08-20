/**
 * Highlights core — deterministic PBP→video window planning + extraction
 *
 * The V1 highlights core must be a clean, importable module that:
 *   - fails closed when rights, canonical event ID, real PBP actions, sync
 *     anchor, input file, or FFmpeg/FFprobe are missing or invalid;
 *   - deterministically maps real PBP actions to source-video seconds using a
 *     fixed sync anchor (elapsed/ascending clocks only — anything else is
 *     rejected explicitly, never guessed);
 *   - clamps windows to the source duration, keeps provenance/action IDs,
 *     sorts deterministically and enforces candidate limits;
 *   - contains no mocked/evenly-spaced timestamps and no LLM calls;
 *   - produces a manifest with rights/event/action/provenance data and
 *     ffprobe evidence, whose clips pass ffprobe.
 *
 * Extraction tests use a synthetic, rights-cleared test pattern generated
 * locally with ffmpeg (lavfi testsrc) — no external media is downloaded.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(join(repoRoot, "dist/highlights/index.js"));

const {
  validateHighlightsRequest,
  planCandidateWindows,
  runHighlights,
  parseHighlightsRequest,
  HighlightsValidationError,
  DEFAULT_MAX_JOB_OUTPUT_BYTES,
  resolveMaxJobOutputBytes,
  extractSegment,
  probeVideo,
} = core;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fully valid request against a 60s source. Override pieces per test. */
function validRequest(overrides = {}) {
  return {
    rights: {
      rightsHolder: "Machina Test League",
      licenseRef: "license/test-2026-001",
      clearedForClipping: true,
    },
    source: { kind: "local-file", path: "/tmp/does-not-matter-for-pure-tests.mp4" },
    event: { provider: "espn", sport: "football", eventId: "401234567" },
    actions: [
      action({ actionId: "a1", elapsedSec: 7, label: "Goal", type: "goal", importance: 95 }),
      action({ actionId: "a2", elapsedSec: 9, label: "Save", type: "save", importance: 60 }),
      action({ actionId: "a3", elapsedSec: 41, label: "Red card", type: "card", importance: 80 }),
    ],
    syncAnchor: { videoSec: 5, clockSec: 0 },
    window: { preRollSec: 4, postRollSec: 6, maxCandidates: 5 },
    outputDir: "/tmp/unused",
    ...overrides,
  };
}

function action({ actionId, elapsedSec, label, type, importance, semantics = "elapsed-ascending", period = 1 }) {
  return {
    actionId,
    provider: "espn",
    period,
    clock: { semantics, elapsedSec },
    label,
    type,
    importance,
    provenance: `espn:pbp:401234567:${actionId}`,
  };
}

const SOURCE_DURATION = 60;

// ---------------------------------------------------------------------------
// Fail-closed validation
// ---------------------------------------------------------------------------

describe("highlights validation fails closed", () => {
  it("accepts a fully valid request", () => {
    validateHighlightsRequest(validRequest());
  });

  const rejects = (name, req, pattern) => {
    it(name, () => {
      assert.throws(
        () => validateHighlightsRequest(req),
        (err) => {
          assert.ok(
            err instanceof HighlightsValidationError,
            `expected HighlightsValidationError, got ${err?.constructor?.name}: ${err?.message}`
          );
          assert.match(err.message, pattern);
          return true;
        }
      );
    });
  };

  rejects("rejects a missing rights block", validRequest({ rights: undefined }), /rights/i);
  rejects(
    "rejects rights not cleared for clipping",
    validRequest({ rights: { rightsHolder: "x", licenseRef: "y", clearedForClipping: false } }),
    /cleared/i
  );
  rejects(
    "rejects an empty rights holder",
    validRequest({ rights: { rightsHolder: "  ", licenseRef: "y", clearedForClipping: true } }),
    /rightsHolder/
  );
  rejects("rejects a missing canonical event", validRequest({ event: undefined }), /event/i);
  rejects(
    "rejects an empty canonical event ID",
    validRequest({ event: { provider: "espn", sport: "football", eventId: "" } }),
    /eventId/
  );
  rejects("rejects missing PBP actions", validRequest({ actions: undefined }), /actions/i);
  rejects("rejects an empty PBP action list", validRequest({ actions: [] }), /actions/i);
  rejects(
    "rejects an action without provenance",
    validRequest({
      actions: [{ ...action({ actionId: "a1", elapsedSec: 5, label: "Goal", type: "goal" }), provenance: "" }],
    }),
    /provenance/
  );
  rejects(
    "rejects duplicate action IDs",
    validRequest({
      actions: [
        action({ actionId: "dup", elapsedSec: 5, label: "Goal", type: "goal" }),
        action({ actionId: "dup", elapsedSec: 9, label: "Save", type: "save" }),
      ],
    }),
    /duplicate/i
  );
  rejects("rejects a missing sync anchor", validRequest({ syncAnchor: undefined }), /syncAnchor|sync anchor/i);
  rejects(
    "rejects a negative sync anchor",
    validRequest({ syncAnchor: { videoSec: -1, clockSec: 0 } }),
    /videoSec/
  );
  rejects(
    "explicitly rejects unsupported clock semantics rather than guessing",
    validRequest({
      actions: [action({ actionId: "a1", elapsedSec: 5, label: "Goal", type: "goal", semantics: "countdown" })],
    }),
    /elapsed-ascending/
  );
  rejects(
    "rejects a non-positive post-roll",
    validRequest({ window: { preRollSec: 4, postRollSec: 0, maxCandidates: 5 } }),
    /postRollSec/
  );
  rejects(
    "rejects a zero candidate limit",
    validRequest({ window: { preRollSec: 4, postRollSec: 6, maxCandidates: 0 } }),
    /maxCandidates/
  );
  rejects("rejects a missing source", validRequest({ source: undefined }), /source/i);
  rejects(
    "rejects non-local source kinds in V1",
    validRequest({ source: { kind: "signed-url", path: "https://example.com/match.mp4" } }),
    /local-file/
  );
});

// ---------------------------------------------------------------------------
// Strict request parsing (JSON boundary)
// ---------------------------------------------------------------------------

describe("highlights request parsing", () => {
  it("parses a valid request object", () => {
    const req = parseHighlightsRequest(validRequest());
    assert.equal(req.event.eventId, "401234567");
    assert.equal(req.actions.length, 3);
  });

  it("rejects non-object payloads", () => {
    assert.throws(() => parseHighlightsRequest([1, 2, 3]), HighlightsValidationError);
    assert.throws(() => parseHighlightsRequest("hello"), HighlightsValidationError);
    assert.throws(() => parseHighlightsRequest(null), HighlightsValidationError);
  });
});

// ---------------------------------------------------------------------------
// Deterministic mapping, clamping, sorting, limits
// ---------------------------------------------------------------------------

describe("candidate window planning", () => {
  it("maps real PBP actions to source-video seconds via the sync anchor", () => {
    const windows = planCandidateWindows(validRequest(), SOURCE_DURATION);

    // anchor: video 5s == clock 0s → videoSec = 5 + elapsedSec
    assert.deepEqual(
      windows.map((w) => ({ id: w.actionId, at: w.actionVideoSec, start: w.startSec, end: w.endSec })),
      [
        { id: "a1", at: 12, start: 8, end: 18 },
        { id: "a2", at: 14, start: 10, end: 20 },
        { id: "a3", at: 46, start: 42, end: 52 },
      ]
    );
  });

  it("keeps provenance and action identity on every window", () => {
    const windows = planCandidateWindows(validRequest(), SOURCE_DURATION);
    for (const w of windows) {
      assert.match(w.provenance, /^espn:pbp:401234567:/);
      assert.equal(w.provider, "espn");
      assert.ok(w.actionId);
      assert.ok(w.label);
    }
  });

  it("keeps mergedActions additive by omitting it from single-action windows", () => {
    const windows = planCandidateWindows(validRequest(), SOURCE_DURATION);

    assert.equal(windows.length, 3);
    for (const window of windows) {
      assert.equal(Object.hasOwn(window, "mergedActions"), false);
    }
  });

  it("is not evenly spaced — windows derive from PBP times, not duration division", () => {
    // The legacy mock spread N windows at duration/(N+1) intervals (15/30/45
    // for 60s). Real mapping of elapsed 7/9/41 lands at 12/14/46.
    const windows = planCandidateWindows(validRequest(), SOURCE_DURATION);
    const centers = windows.map((w) => w.actionVideoSec);
    const evenSpacing = [15, 30, 45];
    assert.notDeepEqual(centers, evenSpacing);
    const gaps = centers.slice(1).map((c, i) => c - centers[i]);
    assert.notEqual(gaps[0], gaps[1], "gaps must not be uniform for non-uniform PBP input");
  });

  it("clamps windows to the source duration", () => {
    const req = validRequest({
      actions: [
        action({ actionId: "early", elapsedSec: 0, label: "Kickoff", type: "kickoff" }), // video 5 → start clamps 1
        action({ actionId: "late", elapsedSec: 53, label: "Winner", type: "goal" }), // video 58 → end clamps 60
      ],
      syncAnchor: { videoSec: 5, clockSec: 0 },
      window: { preRollSec: 10, postRollSec: 10, maxCandidates: 5 },
    });
    const windows = planCandidateWindows(req, SOURCE_DURATION);
    assert.equal(windows[0].startSec, 0);
    assert.equal(windows[0].endSec, 15);
    assert.equal(windows[1].startSec, 48);
    assert.equal(windows[1].endSec, 60);
  });

  it("drops actions that fall outside the source video entirely", () => {
    const req = validRequest({
      actions: [
        action({ actionId: "before", elapsedSec: 0, label: "x", type: "x" }), // video -5
        action({ actionId: "inside", elapsedSec: 20, label: "Goal", type: "goal" }), // video 25
        action({ actionId: "after", elapsedSec: 200, label: "y", type: "y" }), // video 205
      ],
      syncAnchor: { videoSec: -0, clockSec: 5 }, // video = elapsed - 5
    });
    const windows = planCandidateWindows(req, SOURCE_DURATION);
    assert.deepEqual(windows.map((w) => w.actionId), ["inside"]);
  });

  it("sorts deterministically by start time regardless of input order", () => {
    const shuffled = validRequest({
      actions: [
        action({ actionId: "a3", elapsedSec: 41, label: "Red card", type: "card" }),
        action({ actionId: "a1", elapsedSec: 7, label: "Goal", type: "goal" }),
        action({ actionId: "a2", elapsedSec: 9, label: "Save", type: "save" }),
      ],
    });
    const windows = planCandidateWindows(shuffled, SOURCE_DURATION);
    assert.deepEqual(windows.map((w) => w.actionId), ["a1", "a2", "a3"]);
  });

  it("enforces maxCandidates by importance, then re-sorts by start time", () => {
    const req = validRequest({
      actions: [
        action({ actionId: "low1", elapsedSec: 3, label: "Throw-in", type: "throwin", importance: 10 }),
        action({ actionId: "big-late", elapsedSec: 45, label: "Goal", type: "goal", importance: 99 }),
        action({ actionId: "low2", elapsedSec: 20, label: "Foul", type: "foul", importance: 15 }),
        action({ actionId: "big-early", elapsedSec: 10, label: "Goal", type: "goal", importance: 90 }),
      ],
      window: { preRollSec: 2, postRollSec: 3, maxCandidates: 2 },
    });
    const windows = planCandidateWindows(req, SOURCE_DURATION);
    assert.deepEqual(windows.map((w) => w.actionId), ["big-early", "big-late"]);
  });

  it("coalesces near-simultaneous goal and shot windows under the higher-importance action", () => {
    const req = validRequest({
      actions: [
        action({
          actionId: "shot-926",
          elapsedSec: 926,
          label: "Shots on target",
          type: "shot-on-target",
          importance: 80,
        }),
        action({
          actionId: "goal-927",
          elapsedSec: 927,
          label: "Goal",
          type: "goal",
          importance: 100,
          period: 2,
        }),
        action({
          actionId: "save-960",
          elapsedSec: 960,
          label: "Save",
          type: "save",
          importance: 50,
          period: 2,
        }),
      ],
      syncAnchor: { videoSec: 0, clockSec: 0 },
      window: { preRollSec: 8, postRollSec: 12, maxCandidates: 2 },
    });

    const windows = planCandidateWindows(req, 1_000);

    assert.equal(windows.length, 2, "maxCandidates must count coalesced windows, not raw actions");
    assert.equal(windows[0].actionId, "goal-927", "the higher-importance action must be primary");
    assert.equal(windows[0].startSec, 918, "coalesced start must include the earlier attached context");
    assert.equal(windows[0].endSec, 939, "coalesced end must include the primary context");
    assert.deepEqual(windows[0].mergedActions, [
      {
        actionId: "goal-927",
        provider: "espn",
        provenance: "espn:pbp:401234567:goal-927",
        label: "Goal",
        type: "goal",
        period: 2,
        importance: 100,
      },
      {
        actionId: "shot-926",
        provider: "espn",
        provenance: "espn:pbp:401234567:shot-926",
        label: "Shots on target",
        type: "shot-on-target",
        period: 1,
        importance: 80,
      },
    ]);
    assert.equal(windows[1].actionId, "save-960", "a unique non-overlapping action must remain separate");
    assert.equal(Object.hasOwn(windows[1], "mergedActions"), false);

    const reversed = planCandidateWindows({ ...req, actions: [...req.actions].reverse() }, 1_000);
    assert.deepEqual(reversed, windows, "coalescing must not depend on provider input order");
  });

  it("does not transitively merge an action that does not strongly overlap the primary", () => {
    const req = validRequest({
      actions: [
        action({ actionId: "a", elapsedSec: 20, label: "A", type: "shot", importance: 100 }),
        action({ actionId: "b", elapsedSec: 21, label: "B", type: "save", importance: 90 }),
        action({ actionId: "c", elapsedSec: 22, label: "C", type: "rebound", importance: 80 }),
      ],
      syncAnchor: { videoSec: 0, clockSec: 0 },
      window: { preRollSec: 5, postRollSec: 5, maxCandidates: 5 },
    });

    const windows = planCandidateWindows(req, SOURCE_DURATION);

    assert.deepEqual(windows.map((window) => window.actionId), ["a", "c"]);
    assert.deepEqual(
      windows.map(({ startSec, endSec }) => ({ startSec, endSec })),
      [
        { startSec: 15, endSec: 26 },
        { startSec: 17, endSec: 27 },
      ],
      "attached bounds must expand the emitted window without causing transitive grouping"
    );
    assert.deepEqual(windows[0].mergedActions.map((merged) => merged.actionId), ["a", "b"]);
    assert.equal(Object.hasOwn(windows[1], "mergedActions"), false);

    const reversed = planCandidateWindows({ ...req, actions: [...req.actions].reverse() }, SOURCE_DURATION);
    assert.deepEqual(reversed, windows, "greedy primary selection must be input-order independent");
  });

  it("allows existing TypeScript consumers to construct a V1 CandidateWindow without mergedActions", () => {
    const fixture = join(repoRoot, "test/fixtures/highlights-v1-candidate-window.ts");
    const tsc = join(repoRoot, "node_modules/typescript/bin/tsc");
    const run = spawnSync(process.execPath, [
      tsc,
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target", "ES2022",
      "--module", "Node16",
      "--moduleResolution", "Node16",
      fixture,
    ], { encoding: "utf-8" });

    assert.equal(run.status, 0, `V1 consumer compatibility compile failed:\n${run.stdout}\n${run.stderr}`);
  });

  it("is deterministic — identical input yields identical output", () => {
    const a = planCandidateWindows(validRequest(), SOURCE_DURATION);
    const b = planCandidateWindows(validRequest(), SOURCE_DURATION);
    assert.deepEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// Output directory containment — rejected before any probe or extraction
// ---------------------------------------------------------------------------

describe("output directory containment", () => {
  let dir;
  let sourceFile;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "sportsclaw-highlights-outdir-"));
    // A plain file suffices: unsafe outputDir must be rejected before ffprobe
    // ever runs, so no real video (or ffmpeg install) is needed here.
    sourceFile = join(dir, "source.mp4");
    writeFileSync(sourceFile, "not-a-real-video", "utf-8");
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an outputDir that resolves to the source file itself", async () => {
    const req = validRequest({
      source: { kind: "local-file", path: sourceFile },
      outputDir: sourceFile,
    });
    await assert.rejects(() => runHighlights(req), /outputDir/);
  });

  it("rejects an outputDir that reaches the source file through a symlink", async () => {
    const link = join(dir, "out-link");
    symlinkSync(sourceFile, link);
    const req = validRequest({
      source: { kind: "local-file", path: sourceFile },
      outputDir: link,
    });
    await assert.rejects(() => runHighlights(req), /outputDir/);
  });

  it("rejects an outputDir that is an existing non-directory target", async () => {
    const blob = join(dir, "already-a-file");
    writeFileSync(blob, "occupied", "utf-8");
    const req = validRequest({
      source: { kind: "local-file", path: sourceFile },
      outputDir: blob,
    });
    await assert.rejects(() => runHighlights(req), /outputDir/);
  });
});

// ---------------------------------------------------------------------------
// Extraction — real FFmpeg over synthetic, rights-cleared media
// ---------------------------------------------------------------------------

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

function ffprobeJson(file) {
  const run = spawnSync(
    FFPROBE,
    ["-v", "error", "-show_entries", "format=duration,format_name", "-of", "json", file],
    { encoding: "utf-8" }
  );
  assert.equal(run.status, 0, `ffprobe must pass for ${file}: ${run.stderr}`);
  return JSON.parse(run.stdout).format;
}

function ffprobeStreamTypes(file) {
  const run = spawnSync(
    FFPROBE,
    ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", file],
    { encoding: "utf-8" }
  );
  assert.equal(run.status, 0, `ffprobe must pass for ${file}: ${run.stderr}`);
  return JSON.parse(run.stdout).streams.map((stream) => stream.codec_type);
}

describe("highlight extraction (synthetic media)", () => {
  let workDir;
  let sourceVideo;
  let matroskaVideo;
  let sparseKeyframeVideo;
  let longAudioVideo;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), "sportsclaw-highlights-core-"));
    sourceVideo = join(workDir, "synthetic-match.mp4");
    // 60s baseline test pattern with regular keyframes.
    const gen = spawnSync(FFMPEG, [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=60:size=160x90:rate=10",
      "-c:v", "mpeg4", "-q:v", "5", "-g", "10",
      "-pix_fmt", "yuv420p", sourceVideo,
    ], { encoding: "utf-8" });
    assert.equal(gen.status, 0, `fixture generation failed: ${gen.stderr}`);

    matroskaVideo = join(workDir, "synthetic-match.mkv");
    const matroskaGen = spawnSync(FFMPEG, [
      "-y", "-i", sourceVideo, "-t", "5", "-c", "copy", matroskaVideo,
    ], { encoding: "utf-8" });
    assert.equal(matroskaGen.status, 0, `Matroska fixture generation failed: ${matroskaGen.stderr}`);

    sparseKeyframeVideo = join(workDir, "synthetic-sparse-keyframes.mp4");
    const sparseGen = spawnSync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=45:size=160x90:rate=10",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=45",
      "-c:v", "mpeg4", "-q:v", "5", "-g", "300",
      "-c:a", "aac", "-b:a", "96k",
      "-pix_fmt", "yuv420p", "-shortest", sparseKeyframeVideo,
    ], { encoding: "utf-8" });
    assert.equal(sparseGen.status, 0, `sparse-keyframe fixture generation failed: ${sparseGen.stderr}`);

    longAudioVideo = join(workDir, "synthetic-long-audio.mp4");
    const longAudioGen = spawnSync(FFMPEG, [
      "-y",
      "-f", "lavfi", "-i", "testsrc=duration=5:size=160x90:rate=10",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=10",
      "-c:v", "mpeg4", "-q:v", "5", "-g", "10",
      "-c:a", "aac", "-b:a", "96k",
      "-pix_fmt", "yuv420p", longAudioVideo,
    ], { encoding: "utf-8" });
    assert.equal(longAudioGen.status, 0, `long-audio fixture generation failed: ${longAudioGen.stderr}`);
  });

  after(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("produces clips that pass ffprobe and a manifest with full provenance", async () => {
    const outputDir = join(workDir, "clips");
    const req = validRequest({
      source: { kind: "local-file", path: sourceVideo },
      outputDir,
    });

    const manifest = await runHighlights(req);

    // Manifest carries source/event/action/provenance/rights data + evidence.
    assert.equal(manifest.event.eventId, "401234567");
    assert.equal(manifest.rights.rightsHolder, "Machina Test League");
    assert.equal(manifest.rights.clearedForClipping, true);
    assert.equal(manifest.source.path, sourceVideo);
    assert.ok(manifest.source.ffprobe.durationSec > 59, "source ffprobe evidence required");
    assert.equal(manifest.clips.length, 3);

    for (const clip of manifest.clips) {
      assert.match(clip.provenance, /^espn:pbp:401234567:/);
      assert.ok(clip.actionId, "clip must keep its action ID");
      assert.ok(existsSync(clip.file), `clip file must exist: ${clip.file}`);
      assert.ok(clip.ffprobe.durationSec > 0, "clip manifest must embed ffprobe evidence");

      // Independent ffprobe pass over the produced file.
      const probed = ffprobeJson(clip.file);
      const expected = clip.endSec - clip.startSec;
      assert.ok(
        Math.abs(Number(probed.duration) - expected) < 2.5,
        `clip duration ${probed.duration}s must approximate window ${expected}s`
      );
    }
  });

  it("probes and extracts allowlisted Matroska media", async () => {
    const evidence = await probeVideo(matroskaVideo);
    assert.ok(Number(evidence.format.duration) > 4);
    assert.match(String(evidence.format.format_name), /matroska|webm/);

    const output = join(workDir, "matroska-output.mp4");
    await extractSegment(matroskaVideo, output, 1, 2, 2_000_000);
    assert.ok(existsSync(output));
    assert.ok(Number(ffprobeJson(output).duration) > 1.5);
  });

  it("extracts the exact requested duration from sparse-keyframe media and preserves audio", async () => {
    const outputDir = join(workDir, "exact-duration-clips");
    const req = validRequest({
      source: { kind: "local-file", path: sparseKeyframeVideo },
      outputDir,
      actions: [action({ actionId: "goal-18", elapsedSec: 18, label: "Goal", type: "goal", importance: 100 })],
      syncAnchor: { videoSec: 0, clockSec: 0 },
      window: { preRollSec: 8, postRollSec: 12, maxCandidates: 1 },
    });

    const manifest = await runHighlights(req);
    assert.equal(manifest.clips.length, 1);
    const clip = manifest.clips[0];
    const requestedDuration = clip.endSec - clip.startSec;
    const probedDuration = Number(ffprobeJson(clip.file).duration);

    assert.ok(
      Math.abs(probedDuration - requestedDuration) <= 0.5,
      `ffprobe duration ${probedDuration}s must be within 0.5s of requested ${requestedDuration}s`
    );
    assert.equal(Object.hasOwn(clip, "mergedActions"), false);
    assert.ok(clip.ffprobe.videoDurationSec > 0, "clip evidence must include video-stream duration");
    assert.ok(clip.ffprobe.audioDurationSec > 0, "audio duration evidence must be included when available");
    assert.equal(clip.durationSec, clip.ffprobe.videoDurationSec, "manifest duration must use the video stream");
    assert.deepEqual(ffprobeStreamTypes(clip.file).sort(), ["audio", "video"]);

    const seek = spawnSync(FFMPEG, [
      "-v", "error", "-ss", "19", "-i", clip.file,
      "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
    ]);
    assert.equal(seek.status, 0, `independent seek/decode must pass: ${seek.stderr.toString()}`);
    assert.ok(seek.stdout.length > 0, "independent seek must decode a frame near the clip end");
  });

  it("extracts one artifact for overlapping actions and preserves both provenance records", async () => {
    const outputDir = join(workDir, "coalesced-clips");
    const req = validRequest({
      source: { kind: "local-file", path: sparseKeyframeVideo },
      outputDir,
      actions: [
        action({
          actionId: "shot-18",
          elapsedSec: 18,
          label: "Shots on target",
          type: "shot-on-target",
          importance: 80,
        }),
        action({ actionId: "goal-19", elapsedSec: 19, label: "Goal", type: "goal", importance: 100 }),
      ],
      syncAnchor: { videoSec: 0, clockSec: 0 },
      window: { preRollSec: 8, postRollSec: 12, maxCandidates: 5 },
    });

    const manifest = await runHighlights(req);

    assert.equal(manifest.windows.length, 1);
    assert.equal(manifest.clips.length, 1);
    assert.equal(manifest.clips[0].actionId, "goal-19");
    assert.equal(manifest.clips[0].startSec, 10, "clip must start at the attached action's earlier bound");
    assert.equal(manifest.clips[0].endSec, 31, "clip must end at the primary action's later bound");
    assert.deepEqual(
      manifest.clips[0].mergedActions.map(({ actionId, provenance }) => ({ actionId, provenance })),
      [
        { actionId: "goal-19", provenance: "espn:pbp:401234567:goal-19" },
        { actionId: "shot-18", provenance: "espn:pbp:401234567:shot-18" },
      ]
    );
    const extractedDuration = Number(ffprobeJson(manifest.clips[0].file).duration);
    assert.ok(
      Math.abs(extractedDuration - 21) <= 0.5,
      `coalesced clip duration ${extractedDuration}s must match the 21s union window`
    );
    assert.deepEqual(readdirSync(outputDir), ["clip_01_goal-19.mp4"]);
  });

  it("fails closed when longer audio masks a short video stream", async () => {
    const outputDir = join(workDir, "long-audio-clips");
    const req = validRequest({
      source: { kind: "local-file", path: longAudioVideo },
      outputDir,
      actions: [action({ actionId: "goal-4", elapsedSec: 4, label: "Goal", type: "goal", importance: 100 })],
      syncAnchor: { videoSec: 0, clockSec: 0 },
      window: { preRollSec: 4, postRollSec: 4, maxCandidates: 1 },
    });

    await assert.rejects(
      () => runHighlights(req),
      /video.*duration|duration.*video/i,
      "container/audio duration must not hide a video stream shorter than the requested window"
    );
    assert.deepEqual(
      existsSync(outputDir) ? readdirSync(outputDir) : [],
      [],
      "a clip with invalid video duration must be removed"
    );
  });

  it("fails closed when the input file is missing", async () => {
    const req = validRequest({
      source: { kind: "local-file", path: join(workDir, "nope.mp4") },
      outputDir: join(workDir, "clips2"),
    });
    await assert.rejects(() => runHighlights(req), /not found|no such file/i);
  });

  it("fails closed when no candidate window lands inside the source", async () => {
    const req = validRequest({
      source: { kind: "local-file", path: sourceVideo },
      outputDir: join(workDir, "clips3"),
      actions: [action({ actionId: "way-late", elapsedSec: 5000, label: "x", type: "x" })],
    });
    await assert.rejects(() => runHighlights(req), /no candidate windows/i);
  });

  it("rejects HLS before FFprobe or FFmpeg touches a referenced HTTP endpoint", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "video/mp4" });
      response.end(readFileSync(sourceVideo));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const playlist = join(workDir, "network-sentinel.m3u8");
    writeFileSync(
      playlist,
      `#EXTM3U\n#EXT-X-TARGETDURATION:60\n#EXTINF:60,\nhttp://127.0.0.1:${address.port}/sentinel.mp4\n#EXT-X-ENDLIST\n`,
      "utf-8"
    );

    try {
      await assert.rejects(() => probeVideo(playlist), /protocol|format|playlist|invalid|ffprobe/i);
      assert.equal(requests, 0, "FFprobe must not resolve an HLS segment URL");

      await assert.rejects(
        () => extractSegment(playlist, join(workDir, "hls-output.mp4"), 0, 1, 1_000_000),
        /protocol|format|playlist|invalid|ffmpeg/i
      );
      assert.equal(requests, 0, "FFmpeg must not resolve an HLS segment URL");
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("rejects concat playlists before touching an outside-root file", async () => {
    const outside = join(workDir, "..", `outside-sentinel-${process.pid}.mp4`);
    const playlist = join(workDir, "outside.ffconcat");
    copyFileSync(sourceVideo, outside);
    const oldTime = new Date("2000-01-01T00:00:00.000Z");
    utimesSync(outside, oldTime, oldTime);
    writeFileSync(playlist, `ffconcat version 1.0\nfile '${outside}'\n`, "utf-8");
    const originalAtime = statSync(outside).atimeMs;

    try {
      await assert.rejects(() => probeVideo(playlist), /protocol|format|playlist|concat|invalid|ffprobe/i);
      assert.equal(
        statSync(outside).atimeMs,
        originalAtime,
        "FFprobe must reject concat before opening the referenced outside-root file"
      );

      await assert.rejects(
        () => extractSegment(playlist, join(workDir, "concat-output.mp4"), 0, 1, 1_000_000),
        /protocol|format|playlist|concat|invalid|ffmpeg/i
      );
      assert.equal(
        statSync(outside).atimeMs,
        originalAtime,
        "FFmpeg must reject concat before opening the referenced outside-root file"
      );
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

describe("FFmpeg input confinement contract", () => {
  it("sets explicit protocol and demuxer allowlists for both FFprobe and FFmpeg", () => {
    const source = readFileSync(join(repoRoot, "src/highlights/ffmpeg.ts"), "utf-8");
    const protocolAllowlists = source.match(/["']-protocol_whitelist["']/g) ?? [];
    const formatAllowlists = source.match(/["']-format_whitelist["']/g) ?? [];

    assert.ok(protocolAllowlists.length >= 2, "FFprobe and FFmpeg must each set a protocol allowlist");
    assert.ok(formatAllowlists.length >= 2, "FFprobe and FFmpeg must each set a demuxer allowlist");
    assert.ok(!/ffmpeg\.ffprobe\s*\(/.test(source), "FFprobe must use a direct child process with safe argv");
    const allowlistValues = [...source.matchAll(/const\s+\w+(?:PROTOCOL|FORMAT)_ALLOWLIST\s*=\s*["']([^"']+)["']/g)]
      .map((match) => match[1].split(","))
      .flat();
    for (const forbidden of ["http", "https", "tcp", "udp", "data", "concat", "crypto", "hls"]) {
      assert.ok(
        !allowlistValues.includes(forbidden),
        `${forbidden} must not be present in an input allowlist`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Per-job output budget — hard-capped during FFmpeg writes and checked after
// ---------------------------------------------------------------------------

describe("per-job output budget", () => {
  let budgetDir;
  let mixedVideo;
  let mixedBytes;

  before(() => {
    budgetDir = mkdtempSync(join(tmpdir(), "sportsclaw-highlights-budget-"));
    // 60s source: 30s of black (near-zero bitrate) followed by 30s of noise
    // (high bitrate). This lets tests distinguish source size from CRF output
    // size and exercise the hard cap against noisy extraction windows.
    mixedVideo = join(budgetDir, "black-then-noise.mp4");
    const gen = spawnSync(FFMPEG, [
      "-y", "-f", "lavfi", "-i", "color=c=black:s=160x90:r=10:d=60",
      "-vf", "noise=alls=100:allf=t+u:enable='gte(t,30)'",
      "-c:v", "mpeg4", "-q:v", "5", "-g", "10",
      "-pix_fmt", "yuv420p", mixedVideo,
    ], { encoding: "utf-8" });
    assert.equal(gen.status, 0, `fixture generation failed: ${gen.stderr}`);
    mixedBytes = statSync(mixedVideo).size;
  });

  after(() => {
    rmSync(budgetDir, { recursive: true, force: true });
  });

  async function withBudget(value, fn) {
    const saved = process.env.HIGHLIGHTS_MAX_JOB_OUTPUT_BYTES;
    if (value === undefined) delete process.env.HIGHLIGHTS_MAX_JOB_OUTPUT_BYTES;
    else process.env.HIGHLIGHTS_MAX_JOB_OUTPUT_BYTES = value;
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete process.env.HIGHLIGHTS_MAX_JOB_OUTPUT_BYTES;
      else process.env.HIGHLIGHTS_MAX_JOB_OUTPUT_BYTES = saved;
    }
  }

  it("exposes a finite safe default budget", () => {
    assert.ok(Number.isSafeInteger(DEFAULT_MAX_JOB_OUTPUT_BYTES), "default must be a safe integer");
    assert.ok(DEFAULT_MAX_JOB_OUTPUT_BYTES > 0, "default must be positive (never unlimited)");
  });

  it("resolves a positive integer byte count from the environment value", () => {
    assert.equal(resolveMaxJobOutputBytes("1048576"), 1048576);
    assert.equal(resolveMaxJobOutputBytes("1"), 1);
  });

  it("falls back to the finite default for missing or invalid values", () => {
    for (const raw of [undefined, "", "  ", "abc", "0", "-5", "1.5", "Infinity", "NaN"]) {
      assert.equal(
        resolveMaxJobOutputBytes(raw),
        DEFAULT_MAX_JOB_OUTPUT_BYTES,
        `raw=${JSON.stringify(raw)} must fall back to the default`
      );
    }
  });

  it("does not reject a high-bitrate source when the re-encoded output fits", async () => {
    const baselineFile = join(budgetDir, "low-bitrate-baseline.mp4");
    await extractSegment(mixedVideo, baselineFile, 8, 5, mixedBytes);
    const baselineBytes = statSync(baselineFile).size;
    const budget = baselineBytes + 272 * 1024;
    const oldSourceEstimate = Math.ceil((5 / 60) * mixedBytes * 1.25);
    assert.ok(
      oldSourceEstimate > budget,
      `fixture must exceed the removed source-size estimate (${oldSourceEstimate} <= ${budget})`
    );

    const outputDir = join(budgetDir, "high-source-bitrate-clips");
    const req = validRequest({
      source: { kind: "local-file", path: mixedVideo },
      outputDir,
      actions: [action({ actionId: "black-segment", elapsedSec: 10, label: "Goal", type: "goal" })],
      syncAnchor: { videoSec: 0, clockSec: 0 },
      window: { preRollSec: 2, postRollSec: 3, maxCandidates: 1 },
    });

    const manifest = await withBudget(String(budget), () => runHighlights(req));

    assert.equal(manifest.clips.length, 1);
    assert.ok(statSync(manifest.clips[0].file).size <= budget);
  });

  it("fails and cleans up partial clips when actual output exceeds the budget", async () => {
    const outputDir = join(budgetDir, "cumulative-clips");
    // Two 5s windows inside the noise half. The first clip fits on its own;
    // the second exhausts the remaining hard cap, so both must be removed.
    const budget = Math.floor(mixedBytes * 0.27);
    const req = validRequest({
      source: { kind: "local-file", path: mixedVideo },
      outputDir,
      actions: [
        action({ actionId: "noise-1", elapsedSec: 37, label: "Goal", type: "goal" }),
        action({ actionId: "noise-2", elapsedSec: 47, label: "Save", type: "save" }),
      ],
      syncAnchor: { videoSec: 0, clockSec: 0 },
      window: { preRollSec: 2, postRollSec: 3, maxCandidates: 5 },
    });
    await withBudget(String(budget), async () => {
      await assert.rejects(
        () => runHighlights(req),
        /budget|HIGHLIGHTS_MAX_JOB_OUTPUT_BYTES/i,
        "cumulative output over the budget must fail the job"
      );
    });
    assert.deepEqual(
      existsSync(outputDir) ? readdirSync(outputDir) : [],
      [],
      "partial clips must be cleaned up after a budget failure"
    );
  });

  it("caps a single high-bitrate FFmpeg write and fails closed without partial output", async () => {
    const budget = Math.floor(mixedBytes * 0.13);
    const directOutput = join(budgetDir, "hard-capped-single.mp4");

    await assert.rejects(
      () => extractSegment(mixedVideo, directOutput, 35, 5, budget),
      /budget|maxOutputBytes/i,
      "streaming extraction must reject on the first over-budget chunk"
    );
    assert.ok(
      !existsSync(directOutput) || statSync(directOutput).size <= budget,
      `partial output must never exceed the exact ${budget}-byte budget`
    );
    rmSync(directOutput, { force: true });

    const outputDir = join(budgetDir, "hard-capped-run-clips");
    const req = validRequest({
      source: { kind: "local-file", path: mixedVideo },
      outputDir,
      actions: [action({ actionId: "noise-single", elapsedSec: 37, label: "Goal", type: "goal" })],
      syncAnchor: { videoSec: 0, clockSec: 0 },
      window: { preRollSec: 2, postRollSec: 3, maxCandidates: 1 },
    });
    await withBudget(String(budget), async () => {
      await assert.rejects(
        () => runHighlights(req),
        /budget|duration|HIGHLIGHTS_MAX_JOB_OUTPUT_BYTES/i,
        "an FFmpeg write stopped by the byte limit must fail the whole job"
      );
    });
    assert.deepEqual(
      existsSync(outputDir) ? readdirSync(outputDir) : [],
      [],
      "the bounded partial clip must be removed after the job fails"
    );
  });

  it("succeeds unchanged when the same request fits the budget", async () => {
    const outputDir = join(budgetDir, "within-budget-clips");
    const req = validRequest({
      source: { kind: "local-file", path: mixedVideo },
      outputDir,
      actions: [
        action({ actionId: "noise-1", elapsedSec: 37, label: "Goal", type: "goal" }),
        action({ actionId: "noise-2", elapsedSec: 47, label: "Save", type: "save" }),
      ],
      syncAnchor: { videoSec: 0, clockSec: 0 },
      window: { preRollSec: 2, postRollSec: 3, maxCandidates: 5 },
    });
    const manifest = await withBudget(String(mixedBytes * 2), () => runHighlights(req));
    assert.equal(manifest.clips.length, 2);
    for (const clip of manifest.clips) {
      assert.ok(existsSync(clip.file), `clip must exist: ${clip.file}`);
    }
  });
});
