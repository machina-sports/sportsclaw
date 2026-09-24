// Sports Agent Bench v1-fix: the fact-checker's cost is almost all evidence
// input (24k head + tail per source). Large outputs are now cut to the
// windows around the draft's names and numbers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { draftClaimTerms, focusEvidenceOnClaims, isTruncatedEvidence, sportsclawEngine } from "../dist/engine.js";

const rows = (n) => Array.from({ length: n }, (_, i) => `{"player":"Player${i}","pts":${100 + i}}`).join(",");

describe("draftClaimTerms", () => {
  it("takes names and multi-digit numbers, not FINAL or single digits", () => {
    const terms = draftClaimTerms("Jalen Brunson scored 163 points across 6 games.\n\nFINAL: 163");
    assert.deepEqual(terms.sort(), ["163", "Brunson", "Jalen"].sort());
  });
});

describe("focusEvidenceOnClaims", () => {
  it("keeps short outputs whole", () => {
    assert.equal(focusEvidenceOnClaims("short", ["x"], 8000), "short");
  });
  it("keeps the rows around the draft's terms, drops the rest, and marks the cut", () => {
    const text = `{"header":"box score","rows":[${rows(2000)}]}`;
    const out = focusEvidenceOnClaims(text, ["Player1234"], 8000);
    assert.ok(out.length <= 8000 + 200, String(out.length));
    assert.match(out, /Player1234","pts":1334/);
    assert.match(out, /box score/, "head is kept");
    assert.doesNotMatch(out, /Player1999"/, "an unrelated tail row is dropped");
    assert.ok(isTruncatedEvidence(out));
  });
  it("rarest terms win the budget", () => {
    const text = `{"rows":[${rows(2000)}]}` + ',"common":"' + "Knicks ".repeat(500) + '"';
    const out = focusEvidenceOnClaims(text, ["Knicks", "Player1500"], 3000);
    assert.match(out, /Player1500/);
  });
  it("with no matching terms, only the head remains", () => {
    const out = focusEvidenceOnClaims("a".repeat(20000), ["zzz"], 8000);
    assert.equal(out.length, 1500 + "\n...[truncated middle]...\n".length);
  });
});

describe("the fact-checker gets focused evidence (source check)", () => {
  const source = readFileSync(new URL("../dist/engine.js", import.meta.url), "utf8");
  it("both verification sites pass the draft's terms and the 8k budget", () => {
    assert.equal(source.match(/VERIFICATION_EVIDENCE_CHARS, draftClaimTerms\(responseText\)/g)?.length, 2);
  });
  it("collectToolOutputSnippets focuses when given terms", () => {
    const engine = Object.create(sportsclawEngine.prototype);
    const big = `{"rows":[${rows(2000)}]}`;
    const [snip] = engine.collectToolOutputSnippets([{ toolResults: [{ toolCallId: "a", toolName: "t", output: big }] }], new Set(["a"]), 8000, ["Player42"]);
    assert.match(snip.output, /Player42","pts":142/);
    assert.equal(snip.truncated, true);
  });
});
