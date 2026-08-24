/**
 * highlights/providers — provider-payload normalization (86ak32k1w)
 *
 * The same synthetic fixture ships in TWO raw provider shapes (espn +
 * canonical). Both must normalize into equivalent typed PBPAction[] that the
 * core's request parser accepts — proving the workflow source is
 * provider-neutral without any second extraction engine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  classifyActionType,
  filterActionsByIntent,
  intentToActionTypes,
  normalizeProviderPayload,
  toElapsedSec,
} from "../dist/highlights/providers.js";
import { parseHighlightsRequest, planCandidateWindows } from "../dist/highlights/plan.js";

const espnPayload = JSON.parse(
  readFileSync(new URL("./fixtures/pbp-espn-synthetic.json", import.meta.url), "utf8"),
);
const canonicalPayload = JSON.parse(
  readFileSync(new URL("./fixtures/pbp-canonical-synthetic.json", import.meta.url), "utf8"),
);

test("espn and canonical payloads normalize equivalently", () => {
  const espn = normalizeProviderPayload(espnPayload);
  const canonical = normalizeProviderPayload(canonicalPayload);

  assert.equal(espn.length, 4);
  assert.equal(canonical.length, 4);

  for (const actions of [espn, canonical]) {
    assert.deepEqual(
      actions.map((a) => a.type),
      ["goal", "shot-on-target", "goal", "substitution"],
    );
    assert.deepEqual(
      actions.map((a) => a.clock.elapsedSec),
      [15, 40, 65, 80],
    );
    for (const a of actions) {
      assert.equal(a.clock.semantics, "elapsed-ascending");
      assert.ok(a.provenance.length > 0, "provenance is required");
    }
  }

  // Provider identity + native ids survive verbatim
  assert.equal(espn[0].provider, "espn");
  assert.equal(espn[0].actionId, "pl-1");
  assert.equal(canonical[0].provider, "canonical");
  assert.equal(canonical[0].actionId, "urn:synthetic:event:1");
});

test("clock lifting: absolute espn clocks kept, per-period canonical lifted", () => {
  assert.equal(toElapsedSec(46 * 60 + 30, 2), 46 * 60 + 30); // absolute stays
  assert.equal(toElapsedSec(90, 2), 45 * 60 + 90); // per-period lifted
});

test("intent filtering", () => {
  const actions = normalizeProviderPayload(espnPayload);

  const goals = filterActionsByIntent(actions, "all goals");
  assert.deepEqual(goals.map((a) => a.type), ["goal", "goal"]);

  const relevant = filterActionsByIntent(actions, "best moments");
  assert.equal(relevant.length, 3); // goals + shot on target; substitution out

  assert.deepEqual(intentToActionTypes("red cards"), ["red-card"]);
  assert.deepEqual(intentToActionTypes("yellow cards"), ["yellow-card"]);
});

test("classifier never invents goals from negations", () => {
  assert.equal(classifyActionType("", "No goal — flag up"), "other");
  assert.equal(classifyActionType("Goal", "Goal! 1-0"), "goal");
});

test("normalized actions flow into the core request parser and planner", () => {
  const actions = filterActionsByIntent(
    normalizeProviderPayload(canonicalPayload),
    "best moments",
  );

  const request = parseHighlightsRequest({
    rights: {
      rightsHolder: "Machina (synthetic fixture)",
      licenseRef: "fixture-internal",
      clearedForClipping: true,
    },
    source: { kind: "local-file", path: "/tmp/synthetic-match.mp4" },
    event: { provider: "canonical", sport: "soccer", eventId: "synthetic-1" },
    actions,
    syncAnchor: { videoSec: 5, clockSec: 0, period: 1 },
    outputDir: "/tmp/out",
  });

  const windows = planCandidateWindows(request, 90);
  assert.equal(windows.length, 3);
  // anchor +5s: goal@15 → 20, shot@40 → 45, goal@65 → 70
  assert.deepEqual(windows.map((w) => w.actionVideoSec), [20, 45, 70]);
  for (const w of windows) {
    assert.ok(w.provenance.length > 0);
    assert.ok(w.endSec > w.startSec);
  }
});

test("unknown payload shapes return empty (fail-closed upstream)", () => {
  assert.deepEqual(normalizeProviderPayload({ nothing: true }), []);
  assert.deepEqual(normalizeProviderPayload(null), []);
  assert.deepEqual(normalizeProviderPayload("plays"), []);
});
