/**
 * Media rights switch — rights checking is an operator-level switch.
 * Default is "require"; only the exact string "off" (config or env) turns it off.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { resolveRightsCheck, RIGHTS_CHECK_ENV, RIGHTS_OFF_NOTE } = await import(join(repoRoot, "dist/media/rights.js"));
const { parseHighlightsRequest, runHighlights } = await import(join(repoRoot, "dist/highlights/index.js"));

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

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
      {
        actionId: "a1",
        provider: "espn",
        period: 1,
        clock: { semantics: "elapsed-ascending", elapsedSec: 7 },
        label: "Goal",
        type: "goal",
        importance: 95,
        provenance: "espn:pbp:401234567:a1",
      },
    ],
    syncAnchor: { videoSec: 1, clockSec: 0 },
    window: { preRollSec: 1, postRollSec: 1, maxCandidates: 5 },
    outputDir: "/tmp/unused",
    ...overrides,
  };
}

describe("resolveRightsCheck", () => {
  it("exports the env name and the manifest note", () => {
    assert.equal(RIGHTS_CHECK_ENV, "SPORTSCLAW_MEDIA_RIGHTS_CHECK");
    assert.equal(RIGHTS_OFF_NOTE, "off (operator)");
  });

  it("defaults to require; env or config can turn it off; anything else is require", () => {
    assert.equal(resolveRightsCheck({}, {}), "require");
    assert.equal(resolveRightsCheck({ rightsCheck: "off" }, {}), "off");
    assert.equal(resolveRightsCheck({}, { SPORTSCLAW_MEDIA_RIGHTS_CHECK: "off" }), "off");
    assert.equal(resolveRightsCheck({ rightsCheck: "require" }, { SPORTSCLAW_MEDIA_RIGHTS_CHECK: "off" }), "require");
    for (const v of ["OFF", "false", "0", "", " off "]) {
      assert.equal(resolveRightsCheck({}, { SPORTSCLAW_MEDIA_RIGHTS_CHECK: v }), "require", v);
    }
  });
});

describe("highlights under the rights switch", () => {
  it("a request without rights fails under require and parses under off", () => {
    const { rights, ...noRights } = validRequest();
    assert.throws(() => parseHighlightsRequest(noRights), /rights/);
    assert.throws(() => parseHighlightsRequest(noRights, { rightsCheck: "require" }), /rights/);
    assert.equal(parseHighlightsRequest(noRights, { rightsCheck: "off" }).rights, undefined);
  });

  it("clearedForClipping false still fails under require", () => {
    assert.throws(
      () =>
        parseHighlightsRequest({
          ...validRequest(),
          rights: { ...validRequest().rights, clearedForClipping: false },
        }),
      /clearedForClipping/,
    );
  });

  describe("a run", () => {
    let workDir;
    let sourceVideo;

    before(() => {
      workDir = mkdtempSync(join(tmpdir(), "sportsclaw-media-rights-"));
      sourceVideo = join(workDir, "tiny.mp4");
      const gen = spawnSync(
        FFMPEG,
        ["-y", "-f", "lavfi", "-i", "testsrc=duration=12:size=160x90:rate=10", "-c:v", "mpeg4", "-q:v", "5", "-g", "10", "-pix_fmt", "yuv420p", sourceVideo],
        { encoding: "utf-8" },
      );
      assert.equal(gen.status, 0, `fixture generation failed: ${gen.stderr}`);
    });

    after(() => rmSync(workDir, { recursive: true, force: true }));

    it("under off records it in the manifest and carries no rights", async () => {
      const { rights, ...noRights } = validRequest({
        source: { kind: "local-file", path: sourceVideo },
        outputDir: join(workDir, "out-off"),
      });
      const manifest = await runHighlights(noRights, { rightsCheck: "off" });
      assert.equal(manifest.rightsCheck, "off (operator)");
      assert.equal(manifest.rights, undefined);
      assert.ok(manifest.clips.length > 0);
    });

    it("under the default still carries rights and no rightsCheck note", async () => {
      const manifest = await runHighlights(
        validRequest({ source: { kind: "local-file", path: sourceVideo }, outputDir: join(workDir, "out-req") }),
      );
      assert.equal(manifest.rights.rightsHolder, "Machina Test League");
      assert.equal(manifest.rightsCheck, undefined);
    });
  });
});
