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
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

describe("highlight extraction (synthetic media)", () => {
  let workDir;
  let sourceVideo;

  before(() => {
    workDir = mkdtempSync(join(tmpdir(), "sportsclaw-highlights-core-"));
    sourceVideo = join(workDir, "synthetic-match.mp4");
    // 60s test pattern, keyframe every second so stream-copy cuts are accurate.
    const gen = spawnSync(FFMPEG, [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=60:size=160x90:rate=10",
      "-c:v", "libx264", "-preset", "ultrafast", "-g", "10", "-keyint_min", "10",
      "-pix_fmt", "yuv420p", sourceVideo,
    ], { encoding: "utf-8" });
    assert.equal(gen.status, 0, `fixture generation failed: ${gen.stderr}`);
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
});

// ---------------------------------------------------------------------------
// Per-job output budget — bounded before FFmpeg writes, hard-capped after
// ---------------------------------------------------------------------------

describe("per-job output budget", () => {
  let budgetDir;
  let mixedVideo;
  let mixedBytes;

  before(() => {
    budgetDir = mkdtempSync(join(tmpdir(), "sportsclaw-highlights-budget-"));
    // 60s source: 30s of black (near-zero bitrate) followed by 30s of noise
    // (high bitrate). Clips planned inside the noise half deterministically
    // outweigh the source-average preflight estimate, so the cumulative
    // backstop — not the preflight — is what must catch them.
    mixedVideo = join(budgetDir, "black-then-noise.mp4");
    const gen = spawnSync(FFMPEG, [
      "-y", "-f", "lavfi", "-i", "color=c=black:s=160x90:r=10:d=60",
      "-vf", "noise=alls=100:allf=t+u:enable='gte(t,30)'",
      "-c:v", "libx264", "-preset", "ultrafast", "-g", "10", "-keyint_min", "10",
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

  it("rejects an oversized pre/post-roll request before any clip is written", async () => {
    const outputDir = join(budgetDir, "preflight-clips");
    const req = validRequest({
      source: { kind: "local-file", path: mixedVideo },
      outputDir,
      actions: [action({ actionId: "big-roll", elapsedSec: 35, label: "Goal", type: "goal" })],
      syncAnchor: { videoSec: 0, clockSec: 0 },
      window: { preRollSec: 15, postRollSec: 15, maxCandidates: 5 },
    });
    await withBudget("1024", async () => {
      await assert.rejects(
        () => runHighlights(req),
        /budget|HIGHLIGHTS_MAX_JOB_OUTPUT_BYTES/i,
        "preflight estimate over the budget must reject the job"
      );
    });
    assert.equal(existsSync(outputDir), false, "rejection must happen before the output dir is created");
  });

  it("fails and cleans up partial clips when actual output exceeds the budget", async () => {
    const outputDir = join(budgetDir, "cumulative-clips");
    // Two 5s windows inside the noise half: planned total 10s of a 60s source
    // → conservative estimate ≈ 0.21 × source bytes, below the budget; actual
    // noise-heavy output ≈ 0.33 × source bytes, above it. The first clip fits
    // on its own, the second breaches — both must be gone afterwards.
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

    // Exercise the shared extraction implementation directly: -fs may exceed
    // the requested limit by a final packet/container trailer, but it must not
    // write the complete high-bitrate clip before the caller notices.
    await extractSegment(mixedVideo, directOutput, 35, 5, budget).catch(() => {});
    assert.ok(existsSync(directOutput), "FFmpeg should leave a bounded partial for the caller to inspect");
    assert.ok(
      statSync(directOutput).size <= budget + 64 * 1024,
      `hard-capped output ${statSync(directOutput).size} must stay near ${budget}`
    );
    assert.ok(
      Number(ffprobeJson(directOutput).duration) < 4.25,
      "the hard byte limit must stop this high-bitrate 5s extraction early"
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
