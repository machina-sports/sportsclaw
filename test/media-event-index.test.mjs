/**
 * Event index: PBP actions + clock map -> indexed plays with video times, and search.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const { buildEventIndex, findEvents } = await import(join(repoRoot, "dist/media/event-index.js"));

const act = (actionId, period, clock, label, o = {}) => ({
  actionId, provider: "nba", period, clock: { semantics: "countdown-per-period", elapsedSec: clock },
  label, type: "shot", provenance: "test", ...o,
});
const countdownMap = (stretches) => ({ version: 1, semantics: "countdown-per-period", stretches });
const stretch = (o = {}) => ({
  videoStartSec: 100, videoEndSec: 160, period: 1, clockStartSec: 720, clockEndSec: 660, running: true, ...o,
});
const build = (actions, o = {}) =>
  buildEventIndex({ sourceSha256: "abc", sourceDurationSec: 1000, clockMap: countdownMap([stretch()]), actions, ...o });

describe("buildEventIndex", () => {
  it("indexes mapped actions and skips one outside every stretch", () => {
    const idx = build([act("a1", 1, 700, "Curry three pointer"), act("a2", 1, 400, "Lost ball"), act("a3", 1, 680, "Dunk")]);
    assert.deepEqual(idx.events.map((e) => e.actionId), ["a1", "a3"]);
    assert.deepEqual(idx.skipped, [{ actionId: "a2", reason: "no_stretch" }]);
    assert.equal(idx.version, 1);
    assert.equal(idx.sourceSha256, "abc");
    const e = idx.events[0];
    assert.equal(e.eventId, "ev_a1");
    assert.equal(e.videoSec, 120);
    assert.equal(e.startSec, 112);
    assert.equal(e.endSec, 132);
    assert.equal(e.clockSec, 700);
    assert.equal(e.label, "Curry three pointer");
    assert.equal(e.type, "shot");
    assert.deepEqual(e.people, []);
  });

  it("clamps windows to [0, sourceDurationSec]", () => {
    const map = countdownMap([stretch({ videoStartSec: 2, videoEndSec: 62 }), stretch({ period: 2, videoStartSec: 990, videoEndSec: 1000 })]);
    const idx = buildEventIndex({
      sourceSha256: "x", sourceDurationSec: 1000, clockMap: map,
      actions: [act("a", 1, 718, "Early"), act("b", 2, 715, "Late")],
    });
    assert.equal(idx.events[0].startSec, 0);
    assert.equal(idx.events[1].endSec, 1000);
  });

  it("skips an action whose video second falls outside the source", () => {
    const idx = build([act("a", 1, 700, "In")], { sourceDurationSec: 110 });
    assert.deepEqual(idx.skipped, [{ actionId: "a", reason: "no_stretch" }]);
    assert.deepEqual(idx.events, []);
  });

  it("honours a custom window policy", () => {
    const idx = build([act("a", 1, 700, "x")], { window: { preRollSec: 2, postRollSec: 3, maxCandidates: 5 } });
    assert.equal(idx.events[0].startSec, 118);
    assert.equal(idx.events[0].endSec, 123);
  });

  it("throws naming a duplicate actionId", () => {
    assert.throws(() => build([act("dup", 1, 700, "a"), act("dup", 1, 690, "b")]), /dup/);
  });

  it("orders by period, then game progression, ties by input order", () => {
    const map = countdownMap([stretch(), stretch({ period: 2, videoStartSec: 300, videoEndSec: 360 })]);
    const idx = buildEventIndex({
      sourceSha256: "x", sourceDurationSec: 1000, clockMap: map,
      actions: [act("p2", 2, 700, "p2"), act("late", 1, 670, "late"), act("t1", 1, 700, "t1"), act("t2", 1, 700, "t2")],
    });
    assert.deepEqual(idx.events.map((e) => e.actionId), ["t1", "t2", "late", "p2"]);
  });

  it("orders ascending clocks by clockSec ascending", () => {
    const map = { version: 1, semantics: "elapsed-ascending", stretches: [stretch({ clockStartSec: 0, clockEndSec: 60 })] };
    const a = (id, c) => act(id, 1, c, id, { clock: { semantics: "elapsed-ascending", elapsedSec: c } });
    const idx = buildEventIndex({ sourceSha256: "x", sourceDurationSec: 1000, clockMap: map, actions: [a("b", 30), a("a", 10)] });
    assert.deepEqual(idx.events.map((e) => e.actionId), ["a", "b"]);
  });

  it("returns plain JSON", () => {
    const idx = build([act("a", 1, 700, "x", { people: ["Stephen Curry"] })]);
    assert.deepEqual(JSON.parse(JSON.stringify(idx)), idx);
    assert.deepEqual(idx.events[0].people, ["Stephen Curry"]);
  });
});

describe("findEvents", () => {
  const idx = build([
    act("a1", 1, 710, "Curry three pointer", { people: ["Stephen Curry"] }),
    act("a2", 1, 700, "Threesome fouled", { people: ["Klay Thompson"], type: "foul" }),
    act("a3", 1, 690, "Curry layup", { people: ["Stephen Curry", "Draymond Green"] }),
  ]);
  const ids = (q) => findEvents(idx, q).map((e) => e.actionId);

  it("matches whole words only, case-insensitively", () => {
    assert.deepEqual(ids({ text: "three" }), ["a1"]);
    assert.deepEqual(ids({ text: "THREE Pointer" }), ["a1"]);
    assert.deepEqual(ids({ text: "curry" }), ["a1", "a3"]);
  });

  it("treats empty text as no filter", () => {
    assert.equal(ids({ text: "  " }).length, 3);
    assert.equal(ids({}).length, 3);
  });

  it("matches people by full name exactly, case-insensitively; all must match", () => {
    assert.deepEqual(ids({ people: ["stephen curry"] }), ["a1", "a3"]);
    assert.deepEqual(ids({ people: ["Curry"] }), []);
    assert.deepEqual(ids({ people: [" Stephen Curry ", "draymond green"] }), ["a3"]);
  });

  it("filters by period and type, all filters combined", () => {
    assert.deepEqual(ids({ type: "foul" }), ["a2"]);
    assert.deepEqual(ids({ period: 2 }), []);
    assert.deepEqual(ids({ period: 1, type: "shot", text: "curry" }), ["a1", "a3"]);
  });

  it("clamps limit to 1..50 and defaults to 12", () => {
    const many = build(Array.from({ length: 60 }, (_, i) => act(`m${i}`, 1, 719 - i, "shot")));
    assert.equal(findEvents(many, { limit: 500 }).length, 50);
    assert.equal(findEvents(many, {}).length, 12);
    assert.equal(findEvents(many, { limit: 0 }).length, 1);
    assert.equal(findEvents(many, { limit: -3 }).length, 1);
    assert.equal(findEvents(many, { limit: 2.5 }).length, 12);
    assert.equal(findEvents(many, { limit: NaN }).length, 12);
    assert.equal(findEvents(many, { limit: 5 }).length, 5);
  });
});
