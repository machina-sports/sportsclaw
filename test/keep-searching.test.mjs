// Sports Agent Bench v1-fix2: the routed arm answered UNKNOWN after 1-4 data
// calls where a bare loop found the data in 4-21. A give-up draft after few
// calls now gets one more round before it is accepted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { isGiveUpDraft, keepSearchingNote } from "../dist/engine.js";

describe("isGiveUpDraft", () => {
  it("recognises declines for lack of data", () => {
    for (const t of [
      "The provided data does not contain individual player box scores.\n\nFINAL: UNKNOWN",
      "FINAL: UNKNOWN",
      "I could not find a record of that game.",
      "Unable to determine the AP poll points from the data.",
      "No data for that date.".replace("No data for", "No data for"),
      "The standings data is not available for that week.",
      "There is no record of a game between Canada and France on 2026-02-15.",
    ]) assert.equal(isGiveUpDraft(t), true, t);
  });
  it("does not fire on answers", () => {
    for (const t of [
      "The Tempo won 7 home games.\n\nFINAL: 7",
      "FINAL: Nottingham Forest",
      "Canada beat France 10-2; FINAL: 10",
      "Brunson scored 163 points in the Finals.",
    ]) assert.equal(isGiveUpDraft(t), false, t);
  });
});

describe("keepSearchingNote", () => {
  it("names the call count, suggests other endpoints, and keeps declining legitimate", () => {
    const note = keepSearchingNote(2);
    assert.match(note, /you made 2 data call/);
    assert.match(note, /scoreboard, schedule, box score/);
    assert.match(note, /premise is false, decline exactly as before, in the same format/);
  });
});

describe("the pass is wired into run() (source check)", () => {
  const source = readFileSync(new URL("../dist/engine.js", import.meta.url), "utf8");
  it("runs only for a give-up draft after few calls with turns left", () => {
    assert.match(source, /isGiveUpDraft\(result\.text \?\? ""\) &&\s*dataCalls <= KEEP_SEARCHING_MAX_CALLS &&\s*stepCount < this\.config\.maxTurns - 2/);
    assert.match(source, /const KEEP_SEARCHING_MAX_CALLS = 6;/);
  });
  it("evidence, warnings, usage and history include both rounds", () => {
    assert.match(source, /const allSteps = \[\.\.\.priorSteps, \.\.\.result\.steps\]/);
    assert.match(source, /this\._lastUsage = addUsage\(priorUsage, usageOf\(result\)\)/);
    assert.match(source, /\[\.\.\.priorMessages, \.\.\.result\.response\.messages\]/);
    assert.ok((source.match(/allSteps,/g) ?? []).length + (source.match(/allSteps\)/g) ?? []).length >= 3);
    assert.match(source, /notePass\("keep_searching"/);
  });
});
