/**
 * Story timeline (captions only by checked lineId) and the plain renderer.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { resolveTimeline, TimelineError } = await import(join(repoRoot, "dist/media/timeline.js"));
const { renderPlain } = await import(join(repoRoot, "dist/media/render-plain.js"));

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const HAVE_FFMPEG = spawnSync(FFMPEG, ["-version"]).status === 0;
const HAVE_DRAWTEXT = HAVE_FFMPEG &&
  /drawtext/.test(spawnSync(FFMPEG, ["-hide_banner", "-filters"], { encoding: "utf-8" }).stdout ?? "");

const LINES = [
  { lineId: "line_1", text: "Smith scores 30.", cites: ["event_1"] },
  { lineId: "line_2", text: "Jones answers.", cites: ["event_2"] },
];
const ARTIFACTS = { src_1: "source", lines_1: "lines-checked", voice_1: "voice", tracks_1: "subject-tracks" };
const ctx = {
  lines: LINES,
  sourceDurationSec: 20,
  hasArtifact: async (id, kind) => ARTIFACTS[id] === kind,
};
const clip = (extra = {}) => ({ kind: "clip", startSec: 2, endSec: 5, ...extra });
const timeline = (segments, extra = {}) => ({ version: 1, sourceArtifactId: "src_1", linesArtifactId: "lines_1", segments, ...extra });

async function refused(t, code, indexPattern) {
  await assert.rejects(resolveTimeline(t, ctx), (err) => {
    assert.ok(err instanceof TimelineError, String(err));
    assert.equal(err.code, code);
    if (indexPattern !== undefined) assert.equal(err.segmentIndex, indexPattern);
    return true;
  });
}

describe("resolveTimeline", () => {
  it("resolves captions from checked lines, null when a segment has no line, in a fresh object", async () => {
    const input = timeline([clip({ lineId: "line_2" }), clip({ startSec: 6, endSec: 8 }), { kind: "card", cardSeconds: 2, lineId: "line_1" }]);
    const out = await resolveTimeline(input, ctx);
    assert.deepEqual(out.captions, ["Jones answers.", null, "Smith scores 30."]);
    assert.notEqual(out, input);
    assert.deepEqual(Object.keys(out).sort(), ["captions", "linesArtifactId", "segments", "sourceArtifactId", "version"]);
    assert.equal(JSON.stringify(out), JSON.stringify(JSON.parse(JSON.stringify(out))));
  });

  it("refuses a lineId that is not in the checked lines", async () => {
    await refused(timeline([clip(), clip({ lineId: "line_9" })]), "unknown_line", 1);
  });

  it("refuses a lineId when the timeline has no linesArtifactId", async () => {
    await refused(timeline([clip({ lineId: "line_1" })], { linesArtifactId: undefined }), "missing_lines_artifact", 0);
  });

  it("refuses a linesArtifactId that is not a lines-checked artifact", async () => {
    await refused(timeline([clip()], { linesArtifactId: "voice_1" }), "missing_artifact", null);
  });

  it("refuses caption and text properties on a segment, and any unknown key at either level", async () => {
    await refused(timeline([clip(), clip({ caption: "Smith scores 99." })]), "unknown_field", 1);
    await refused(timeline([clip({ text: "free text" })]), "unknown_field", 0);
    await refused(timeline([clip({ colour: "red" })]), "unknown_field", 0);
    await refused({ ...timeline([clip()]), caption: "x" }, "unknown_field", null);
    await assert.rejects(resolveTimeline(timeline([clip({ caption: "x" })]), ctx), /caption/);
  });

  it("refuses a bad version and a non-object timeline", async () => {
    await refused({ ...timeline([clip()]), version: 2 }, "bad_version", null);
    await refused("nope", "bad_version", null);
  });

  it("refuses clips outside the source, out of order, too short, too long, or non-finite", async () => {
    await refused(timeline([clip({ startSec: 18, endSec: 21 })]), "clip_outside_source", 0);
    await refused(timeline([clip({ startSec: -1, endSec: 2 })]), "clip_outside_source", 0);
    await refused(timeline([clip({ startSec: 5, endSec: 2 })]), "bad_clip", 0);
    await refused(timeline([clip({ startSec: 2, endSec: 2.5 })]), "bad_clip", 0);
    await refused(timeline([clip({ startSec: 0, endSec: 61 })]), "bad_clip", 0);
    await refused(timeline([clip({ endSec: Infinity })]), "bad_clip", 0);
    await refused(timeline([clip({ startSec: undefined })]), "bad_clip", 0);
    await refused(timeline([clip({ cardSeconds: 2 })]), "bad_clip", 0);
  });

  it("refuses bad cards", async () => {
    await refused(timeline([{ kind: "card" }]), "bad_card", 0);
    await refused(timeline([{ kind: "card", cardSeconds: 0.5 }]), "bad_card", 0);
    await refused(timeline([{ kind: "card", cardSeconds: 11 }]), "bad_card", 0);
    await refused(timeline([{ kind: "card", cardSeconds: 2, startSec: 1 }]), "bad_card", 0);
    await refused(timeline([{ kind: "card", cardSeconds: 2, eventId: "e" }]), "bad_card", 0);
    await refused(timeline([{ kind: "card", cardSeconds: 2, subjectTracksArtifactId: "tracks_1" }]), "bad_card", 0);
  });

  it("refuses a voice or subject-tracks artifact the store denies", async () => {
    await refused(timeline([clip({ voiceArtifactId: "nope" })]), "missing_artifact", 0);
    await refused(timeline([clip({ voiceArtifactId: "tracks_1" })]), "missing_artifact", 0);
    await refused(timeline([clip(), clip({ subjectTracksArtifactId: "voice_1" })]), "missing_artifact", 1);
    const ok = await resolveTimeline(timeline([clip({ voiceArtifactId: "voice_1", subjectTracksArtifactId: "tracks_1" })]), ctx);
    assert.equal(ok.segments.length, 1);
  });

  it("refuses a source artifact that is not a source", async () => {
    await refused(timeline([clip()], { sourceArtifactId: "voice_1" }), "missing_artifact", null);
  });

  it("refuses 0 and 41 segments, and totals over 600 s", async () => {
    await refused(timeline([]), "too_many_segments", null);
    await refused(timeline(Array.from({ length: 41 }, () => clip())), "too_many_segments", null);
    const long = Array.from({ length: 11 }, () => ({ kind: "clip", startSec: 0, endSec: 55 }));
    await assert.rejects(
      resolveTimeline(timeline(long), { ...ctx, sourceDurationSec: 100 }),
      (err) => err instanceof TimelineError && err.code === "too_long",
    );
  });

  describe("clips named by eventId", () => {
    // The event index the timeline's lines were checked against.
    const EVENTS = [{ eventId: "ev_1", startSec: 4, endSec: 10 }, { eventId: "ev_far", startSec: 15, endSec: 25 }];
    const withEvents = { ...ctx, events: EVENTS };
    const refusedWith = (t, code, index) =>
      assert.rejects(resolveTimeline(t, withEvents), (err) => {
        assert.ok(err instanceof TimelineError, String(err));
        assert.equal(err.code, code, err.message);
        assert.equal(err.segmentIndex, index);
        return true;
      });

    it("a clip naming only an eventId gets the event's window, and the resolved timeline carries it", async () => {
      const out = await resolveTimeline(timeline([{ kind: "clip", eventId: "ev_1", lineId: "line_1" }]), withEvents);
      assert.deepEqual(out.segments, [{ kind: "clip", eventId: "ev_1", startSec: 4, endSec: 10, lineId: "line_1" }]);
      assert.deepEqual(out.captions, ["Smith scores 30."]);
    });

    it("an eventId with startSec/endSec inside the event's window +- 5 s keeps the given window", async () => {
      const out = await resolveTimeline(timeline([clip({ eventId: "ev_1", startSec: 0, endSec: 15 })]), withEvents);
      assert.deepEqual([out.segments[0].startSec, out.segments[0].endSec], [0, 15]);
    });

    it("a window outside the event's window +- 5 s -> clip_not_event", async () => {
      await refusedWith(timeline([clip(), clip({ eventId: "ev_1", startSec: 10, endSec: 15.5 })]), "clip_not_event", 1);
      await refusedWith(timeline([clip({ eventId: "ev_far", startSec: 2, endSec: 5 })]), "clip_not_event", 0);
    });

    it("an eventId not in the index -> unknown_event", async () => {
      await refusedWith(timeline([clip({ eventId: "ev_9" })]), "unknown_event", 0);
      await refusedWith(timeline([{ kind: "clip", eventId: "ev_9" }]), "unknown_event", 0);
    });

    it("an eventId with only one of startSec/endSec -> bad_clip; the filled window is checked like any other", async () => {
      await refusedWith(timeline([{ kind: "clip", eventId: "ev_1", startSec: 4 }]), "bad_clip", 0);
      await refusedWith(timeline([{ kind: "clip", eventId: "ev_far" }]), "clip_outside_source", 0);
    });

    it("an eventId when the timeline has no lines (so no event index) -> missing_lines_artifact", async () => {
      await refused(timeline([{ kind: "clip", eventId: "ev_1" }], { linesArtifactId: undefined }), "missing_lines_artifact", 0);
      await refused(timeline([{ kind: "clip", eventId: "ev_1" }]), "missing_lines_artifact", 0);
    });
  });

  it("accepts 40 segments", async () => {
    const out = await resolveTimeline(timeline(Array.from({ length: 40 }, () => clip())), ctx);
    assert.equal(out.captions.length, 40);
  });
});

describe("renderPlain input hardening (needs no FFmpeg)", () => {
  it("refuses a playlist voice file and an ffconcat source before rendering", async () => {
    const dir = mkdtempSync(join(tmpdir(), "media-timeline-harden-"));
    try {
      const dummy = join(dir, "dummy.mp4");
      writeFileSync(dummy, "not a real video");
      const playlist = join(dir, "voice.m3u");
      writeFileSync(playlist, "#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n");
      const concat = join(dir, "source.ffconcat");
      writeFileSync(concat, "ffconcat version 1.0\nfile '/etc/passwd'\n");
      const voiced = await resolveTimeline(timeline([clip({ voiceArtifactId: "voice_1" })]), ctx);
      await assert.rejects(
        renderPlain({ timeline: voiced, sourcePath: dummy, voicePaths: { voice_1: playlist }, outPath: join(dir, "pl.mp4") }),
        /Playlist and concat/,
      );
      const card = await resolveTimeline(timeline([{ kind: "card", cardSeconds: 2 }]), ctx);
      await assert.rejects(
        renderPlain({ timeline: card, sourcePath: concat, voicePaths: {}, outPath: join(dir, "cc.mp4") }),
        /Playlist and concat/,
      );
    assert.equal(existsSync(join(dir, "pl.mp4")) || existsSync(join(dir, "cc.mp4")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renderPlain", { skip: !HAVE_FFMPEG && "FFmpeg not available" }, () => {
  let dir, source, voice;
  const probe = (file) => {
    const run = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration:stream=codec_name,codec_type,width,height", "-of", "json", file], { encoding: "utf-8" });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  };

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "media-timeline-"));
    source = join(dir, "source.mp4");
    const gen = spawnSync(FFMPEG, ["-y", "-f", "lavfi", "-i", "testsrc=duration=20:size=160x90:rate=10",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=20", "-c:v", "mpeg4", "-q:v", "5", "-g", "10",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source], { encoding: "utf-8" });
    assert.equal(gen.status, 0, gen.stderr);
    voice = join(dir, "voice.wav");
    const v = spawnSync(FFMPEG, ["-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=1.5", voice], { encoding: "utf-8" });
    assert.equal(v.status, 0, v.stderr);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("renders clips, a card and a voiced clip to 1280x720 H.264/AAC within 0.5 s of the sum of the segments", async () => {
    const resolved = await resolveTimeline(
      timeline([clip({ startSec: 1, endSec: 4 }), clip({ startSec: 8, endSec: 11, voiceArtifactId: "voice_1" }), { kind: "card", cardSeconds: 2 }]),
      ctx,
    );
    const outPath = join(dir, "plain.mp4");
    const res = await renderPlain({ timeline: resolved, sourcePath: source, voicePaths: { voice_1: voice }, outPath });
    assert.ok(Math.abs(res.durationSec - 8) < 0.5, `reported ${res.durationSec}`);
    const info = probe(outPath);
    assert.ok(Math.abs(Number(info.format.duration) - 8) < 0.5, `probed ${info.format.duration}`);
    const video = info.streams.find((s) => s.codec_type === "video");
    const audio = info.streams.find((s) => s.codec_type === "audio");
    assert.equal(video.codec_name, "h264");
    assert.equal(video.width, 1280);
    assert.equal(video.height, 720);
    assert.equal(audio.codec_name, "aac");
  });

  it("draws captions with drawtext, including quotes and colons", { skip: !HAVE_DRAWTEXT && "FFmpeg build has no drawtext" }, async () => {
    const lines = [{ lineId: "line_1", text: "It's 30: a \"career\" night, 100%", cites: ["e"] }];
    const resolved = await resolveTimeline(timeline([clip({ lineId: "line_1" })]), { ...ctx, lines });
    const outPath = join(dir, "caption.mp4");
    const res = await renderPlain({ timeline: resolved, sourcePath: source, voicePaths: {}, outPath });
    assert.ok(Math.abs(res.durationSec - 3) < 0.5);
  });

  it("fails with a clear error when a caption is needed and drawtext is missing", { skip: HAVE_DRAWTEXT && "FFmpeg build has drawtext" }, async () => {
    const resolved = await resolveTimeline(timeline([clip({ lineId: "line_1" })]), ctx);
    await assert.rejects(
      renderPlain({ timeline: resolved, sourcePath: source, voicePaths: {}, outPath: join(dir, "nodraw.mp4") }),
      /drawtext/,
    );
    assert.equal(existsSync(join(dir, "nodraw.mp4")), false);
  });

  it("refuses a voice artifact with no path, and honors an aborted signal", async () => {
    const resolved = await resolveTimeline(timeline([clip({ voiceArtifactId: "voice_1" })]), ctx);
    await assert.rejects(
      renderPlain({ timeline: resolved, sourcePath: source, voicePaths: {}, outPath: join(dir, "novoice.mp4") }),
      /voice_1/,
    );
    const ac = new AbortController();
    ac.abort();
    const plain = await resolveTimeline(timeline([clip()]), ctx);
    await assert.rejects(
      renderPlain({ timeline: plain, sourcePath: source, voicePaths: {}, outPath: join(dir, "aborted.mp4"), abortSignal: ac.signal }),
      /abort/i,
    );
  });
});
