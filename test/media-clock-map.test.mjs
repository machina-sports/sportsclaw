/**
 * Clock map: countdown and ascending clocks to video seconds.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { parseClockMap, clockToVideoSec, clockMapFromSyncAnchor, ClockMapError, CLOCK_SEMANTICS } =
  await import(join(repoRoot, "dist/media/clock-map.js"));
const { parseHighlightsRequest, planCandidateWindows } = await import(join(repoRoot, "dist/highlights/plan.js"));

const stretch = (o = {}) => ({
  videoStartSec: 100, videoEndSec: 160, period: 2, clockStartSec: 720, clockEndSec: 660, running: true, ...o,
});
const countdown = (stretches) => ({ version: 1, semantics: "countdown-per-period", stretches });

describe("clockToVideoSec", () => {
  it("maps a countdown clock inside a running stretch, inclusive of both ends", () => {
    const map = countdown([stretch()]);
    assert.equal(clockToVideoSec(map, 2, 700), 120);
    assert.equal(clockToVideoSec(map, 2, 720), 100);
    assert.equal(clockToVideoSec(map, 2, 660), 160);
    assert.equal(clockToVideoSec(map, 2, 650), null);
    assert.equal(clockToVideoSec(map, 1, 700), null, "period must match");
  });

  it("returns null for a stopped stretch, so two plays at the same stopped clock are both left out", () => {
    const map = countdown([stretch({ running: false, clockStartSec: 500, clockEndSec: 500 })]);
    assert.equal(clockToVideoSec(map, 2, 500), null);
    assert.equal(clockToVideoSec(map, 2, 500), null);
  });

  it("returns null for a clock between two stretches", () => {
    const map = countdown([
      stretch(),
      stretch({ videoStartSec: 200, videoEndSec: 260, clockStartSec: 600, clockEndSec: 540 }),
    ]);
    assert.equal(clockToVideoSec(map, 2, 630), null);
    assert.equal(clockToVideoSec(map, 2, 570), 230);
  });

  it("picks the stretch earliest in video time when several contain the clock", () => {
    const map = countdown([
      stretch({ videoStartSec: 300, videoEndSec: 360 }),
      stretch({ videoStartSec: 100, videoEndSec: 160 }),
    ]);
    assert.equal(clockToVideoSec(map, 2, 700), 120);
  });

  it("ignores period for elapsed-ascending maps", () => {
    const map = clockMapFromSyncAnchor({ videoSec: 30, clockSec: 10 });
    assert.equal(clockToVideoSec(map, 1, 25), 45);
    assert.equal(clockToVideoSec(map, 4, 25), 45);
  });
});

describe("clockMapFromSyncAnchor", () => {
  it("is JSON-safe and re-parses", () => {
    const map = clockMapFromSyncAnchor({ videoSec: 5, clockSec: 0 });
    assert.deepEqual(parseClockMap(JSON.parse(JSON.stringify(map))), map);
  });

  it("reproduces video = v + (clock - c), dropping only negative video", () => {
    for (const [v, c] of [[5, 0], [0, 5], [30, 10], [0, 0], [12.5, 3.25]]) {
      const map = clockMapFromSyncAnchor({ videoSec: v, clockSec: c });
      for (const e of [0, 1, 3, 5, 7.5, 100, 99999]) {
        const direct = v + (e - c);
        const got = clockToVideoSec(map, 1, e);
        if (direct < 0) assert.equal(got, null);
        else assert.ok(Math.abs(got - direct) < 1e-9, `v=${v} c=${c} e=${e}`);
      }
    }
  });
});

describe("parseClockMap", () => {
  const rejects = (name, value, field) =>
    it(`rejects ${name}`, () => {
      assert.throws(() => parseClockMap(value), (err) => {
        assert.ok(err instanceof ClockMapError);
        assert.ok(err instanceof Error);
        assert.match(err.field, field);
        return true;
      });
    });

  rejects("overlapping video ranges", countdown([stretch(), stretch({ videoStartSec: 150, videoEndSec: 200 })]), /videoStartSec/);
  rejects("videoEndSec <= videoStartSec", countdown([stretch({ videoEndSec: 100 })]), /videoEndSec/);
  rejects("a running countdown stretch whose clock rises", countdown([stretch({ clockStartSec: 660, clockEndSec: 720 })]), /clockEndSec/);
  rejects("an unknown semantics", { version: 1, semantics: "sideways", stretches: [] }, /semantics/);
  rejects("more than 20000 stretches", countdown(Array.from({ length: 20001 }, () => stretch())), /stretches/);
  rejects("a non-finite number", countdown([stretch({ clockStartSec: Infinity })]), /clockStartSec/);
  rejects("a stopped stretch whose clock moves", countdown([stretch({ running: false })]), /clockEndSec/);

  it("returns a fresh object without extra keys", () => {
    const input = { ...countdown([{ ...stretch(), extra: 1 }]), junk: true };
    const out = parseClockMap(input);
    assert.deepEqual(out, countdown([stretch()]));
    assert.notEqual(out.stretches[0], input.stretches[0]);
    assert.deepEqual(CLOCK_SEMANTICS, ["elapsed-ascending", "countdown-per-period"]);
  });
});

describe("highlights request", () => {
  const base = (o = {}) => ({
    rights: { rightsHolder: "x", licenseRef: "y", clearedForClipping: true },
    source: { kind: "local-file", path: "a.mp4" },
    event: { provider: "p", sport: "basketball", eventId: "e1" },
    actions: [{
      actionId: "a1", provider: "p", period: 2, label: "Dunk", type: "dunk", provenance: "feed",
      clock: { semantics: "countdown-per-period", elapsedSec: 700 },
    }],
    outputDir: "out",
    ...o,
  });
  const map = countdown([stretch()]);

  it("rejects both syncAnchor and clockMap", () => {
    assert.throws(() => parseHighlightsRequest(base({ clockMap: map, syncAnchor: { videoSec: 0, clockSec: 0 } })), /syncAnchor|clockMap/);
  });
  it("rejects neither", () => {
    assert.throws(() => parseHighlightsRequest(base()), /syncAnchor/);
  });
  it("plans through the clock map and drops actions that map to null", () => {
    const req = base({ clockMap: map });
    req.actions.push({ ...req.actions[0], actionId: "a2", clock: { semantics: "countdown-per-period", elapsedSec: 650 } });
    const windows = planCandidateWindows(req, 1000);
    assert.deepEqual(windows.map((w) => [w.actionId, w.actionVideoSec]), [["a1", 120]]);
  });
  it("rejects actions whose clock semantics differ from the map", () => {
    const req = base({ syncAnchor: { videoSec: 0, clockSec: 0 } });
    assert.throws(() => parseHighlightsRequest(req), /elapsed-ascending/);
  });
});
