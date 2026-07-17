/**
 * stripInternalEvidenceArtifacts — deterministic cleanup of internal
 * evidence-gate bookkeeping from user-facing text. The self-correction
 * banner and [Tool N] citations must never reach users, while real answer
 * content (teams, venues) must survive untouched.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  stripInternalEvidenceArtifacts,
  summarizeToolOutputForEvidence,
} from "../dist/engine.js";

describe("stripInternalEvidenceArtifacts", () => {
  it("removes the self-correction warning banner", () => {
    const input =
      "⚠️ Self-correction pass completed: verified and aligned response with raw data.\n\n" +
      "Norway vs England kicks off today at Hard Rock Stadium.";
    const out = stripInternalEvidenceArtifacts(input);
    assert.ok(!/self-correction/i.test(out), "warning banner should be gone");
    assert.ok(!out.includes("⚠️"), "warning emoji should be gone");
    assert.ok(out.includes("Norway vs England"), "real content preserved");
    assert.ok(out.includes("Hard Rock Stadium"), "venue preserved");
  });

  it("removes [Tool N] and [Tool N: name] citation markers", () => {
    const input =
      "Norway vs England [Tool 10] is scheduled at Hard Rock Stadium " +
      "[Tool 1, Tool 6]. Kickoff confirmed [Tool 1: worldcup-get-schedule].";
    const out = stripInternalEvidenceArtifacts(input);
    assert.ok(!/\[Tool\s*\d/i.test(out), "no [Tool N] markers should remain");
    assert.ok(!out.includes("worldcup-get-schedule"), "tool label stripped");
    assert.ok(out.includes("Norway vs England"), "real content preserved");
    assert.ok(out.includes("Hard Rock Stadium"), "venue preserved");
    assert.ok(!/\s{2,}/.test(out), "no doubled whitespace left behind");
  });

  it("removes raw mcp__server__tool identifiers", () => {
    const input =
      "Fetched via mcp__world-cup-mcp__execute_workflow — Norway vs England at Hard Rock Stadium.";
    const out = stripInternalEvidenceArtifacts(input);
    assert.ok(!/mcp__/.test(out), "internal mcp identifier stripped");
    assert.ok(out.includes("Norway vs England"), "real content preserved");
  });

  it("removes internal source labels from evidence validation prompts", () => {
    const input =
      "Norway vs England [Internal source 1 — private, never cite] is at Hard Rock Stadium.";
    const out = stripInternalEvidenceArtifacts(input);
    assert.ok(!/internal source/i.test(out), "internal source label stripped");
    assert.ok(out.includes("Norway vs England"), "real content preserved");
    assert.ok(out.includes("Hard Rock Stadium"), "venue preserved");
  });

  it("leaves clean text untouched", () => {
    const input = "Norway vs England kicks off at Hard Rock Stadium.";
    assert.equal(stripInternalEvidenceArtifacts(input), input);
  });
});

describe("summarizeToolOutputForEvidence", () => {
  it("rejects non-JSON whitespace around otherwise valid structured JSON", () => {
    const prettyValues = [
      `{
  "team": "Norway",
  "score": 3
}`,
      `[
  "Norway",
  "England"
]`,
    ];
    const invalidBoundaryWhitespace = [
      ["NBSP U+00A0", "\u00a0"],
      ["form-feed U+000C", "\u000c"],
      ["vertical-tab U+000B", "\u000b"],
      ["BOM U+FEFF", "\ufeff"],
      ["Ogham space mark U+1680", "\u1680"],
      ["en quad U+2000", "\u2000"],
      ["line separator U+2028", "\u2028"],
      ["paragraph separator U+2029", "\u2029"],
      ["ideographic space U+3000", "\u3000"],
    ];

    for (const pretty of prettyValues) {
      const compact = pretty.replace(/[ \t\r\n]/g, "");
      for (const [label, boundary] of invalidBoundaryWhitespace) {
        const input = `${boundary}${pretty}${boundary}`;
        const out = summarizeToolOutputForEvidence(input);
        assert.equal(out, input, `${label} and the pretty JSON must be preserved byte-for-byte`);
        assert.notEqual(out, compact, `${label} must preserve interior pretty whitespace`);
      }
    }
  });

  it("accepts only JSON whitespace around structured JSON and losslessly minifies it", () => {
    const unsafeInteger = "9007199254740993";
    const prettyObject = `{\n  "id": ${unsafeInteger},\n  "label": "kept   spacing"\n}`;
    const prettyArray = `[\n  { "id": ${unsafeInteger} }\n]`;
    const outerJsonWhitespace = " \t\r\n";

    assert.equal(
      summarizeToolOutputForEvidence(`${outerJsonWhitespace}${prettyObject}${outerJsonWhitespace}`),
      `{"id":${unsafeInteger},"label":"kept   spacing"}`
    );
    assert.equal(
      summarizeToolOutputForEvidence({
        content: `${outerJsonWhitespace}${prettyArray}${outerJsonWhitespace}`,
      }),
      `[{"id":${unsafeInteger}}]`
    );
  });

  it("preserves unsafe integer digits and only losslessly compacts object/array JSON strings", () => {
    const unsafeInteger = "9007199254740993";
    const prettyObject = `{\n  "id": ${unsafeInteger},\n  "label": "kept   spacing\\tand \\\"escapes\\\""\n}`;
    const prettyArray = `[\n  { "id": ${unsafeInteger} }\n]`;

    assert.equal(summarizeToolOutputForEvidence(9007199254740993n), unsafeInteger);
    assert.equal(summarizeToolOutputForEvidence({ content: unsafeInteger }), unsafeInteger);
    assert.equal(
      summarizeToolOutputForEvidence(prettyObject),
      `{"id":${unsafeInteger},"label":"kept   spacing\\tand \\\"escapes\\\""}`
    );
    assert.equal(
      summarizeToolOutputForEvidence({ content: prettyArray }),
      `[{"id":${unsafeInteger}}]`
    );
    assert.equal(
      summarizeToolOutputForEvidence("  9007199254740993  "),
      unsafeInteger,
      "arbitrary JSON scalar strings must never be parsed/stringified"
    );
  });

  it("compacts an oversized pretty-JSON string, keeping beginning and end facts under the limit", () => {
    // Mirrors the production worldcup-get-schedule payload: pretty JSON is
    // >4000 chars while its compact form is well under, so a head-only slice
    // would drop the final venue.
    const matches = Array.from({ length: 26 }, (_, i) => ({
      matchId: 1000 + i,
      stage: "group",
      home: `Team Home ${i}`,
      away: `Team Away ${i}`,
      kickoff: "2026-06-15T18:00:00Z",
      venue: `Stadium ${i}`,
    }));
    const payload = {
      tournament: "World Cup",
      firstVenue: "Hard Rock Stadium",
      matches,
      finalVenue: "New York New Jersey Stadium",
    };
    const pretty = JSON.stringify(payload, null, 2);
    const compact = JSON.stringify(payload);

    // Precondition: reproduces the production shape (pretty > limit, compact within).
    assert.ok(pretty.length > 4000, `pretty JSON must exceed 4000 (was ${pretty.length})`);
    assert.ok(compact.length <= 4000, `compact JSON must be within 4000 (was ${compact.length})`);

    const out = summarizeToolOutputForEvidence(pretty);

    assert.ok(out.length <= 4000, `summary must stay within 4000 (was ${out.length})`);
    assert.ok(out.includes("Hard Rock Stadium"), "beginning fact preserved");
    assert.ok(
      out.includes("New York New Jersey Stadium"),
      "ending fact preserved (the final venue must survive)"
    );
  });

  it("balances head and tail when truncating an oversized non-JSON string", () => {
    const prefix = "PREFIX_MARKER_START";
    const suffix = "SUFFIX_MARKER_END";
    const input = `${prefix} ${"filler ".repeat(1000)} ${suffix}`;
    assert.ok(input.length > 4000, "input must exceed 4000 to force truncation");
    assert.ok(!isJson(input), "input must not be valid JSON");

    const out = summarizeToolOutputForEvidence(input);

    assert.ok(out.length <= 4000, `summary must stay within 4000 (was ${out.length})`);
    assert.ok(out.includes(prefix), "head prefix preserved");
    assert.ok(out.includes(suffix), "tail suffix preserved");
  });

  it("compacts pretty JSON carried inside a legacy {content:string} envelope", () => {
    // Legacy supported envelope: the payload is a pretty-printed JSON string
    // nested under `content`. It must go through the same compaction as a bare
    // string so the whole payload survives instead of a head+tail slice that
    // drops the middle.
    const matches = Array.from({ length: 26 }, (_, i) => ({
      matchId: 1000 + i,
      stage: "group",
      home: `Team Home ${i}`,
      away: `Team Away ${i}`,
      kickoff: "2026-06-15T18:00:00Z",
      venue: `Stadium ${i}`,
    }));
    const payload = {
      tournament: "World Cup",
      firstVenue: "Hard Rock Stadium",
      matches,
      finalVenue: "New York New Jersey Stadium",
    };
    const pretty = JSON.stringify(payload, null, 2);
    const compact = JSON.stringify(payload);
    assert.ok(pretty.length > 4000, `pretty JSON must exceed 4000 (was ${pretty.length})`);
    assert.ok(compact.length <= 4000, `compact JSON must be within 4000 (was ${compact.length})`);

    const out = summarizeToolOutputForEvidence({ content: pretty });

    assert.ok(out.length <= 4000, `summary must stay within 4000 (was ${out.length})`);
    assert.ok(out.includes("Hard Rock Stadium"), "beginning fact preserved");
    assert.ok(out.includes("Stadium 13"), "middle fact preserved (compaction kept the whole payload)");
    assert.ok(
      out.includes("New York New Jersey Stadium"),
      "late fact preserved (the final venue must survive)"
    );
  });

  it("balanced-truncates a {content:string} JSON payload that stays oversized after compaction", () => {
    const matches = Array.from({ length: 60 }, (_, i) => ({
      matchId: 1000 + i,
      stage: "group",
      home: `TeamHome${i}`,
      away: `TeamAway${i}`,
      kickoff: "2026-06-15T18:00:00Z",
      venue: `Stadium${i}`,
    }));
    const payload = {
      headMarker: "HARDROCKSTADIUM",
      matches,
      tailMarker: "NEWYORKNEWJERSEYSTADIUM",
    };
    const pretty = JSON.stringify(payload, null, 2);
    const compact = JSON.stringify(payload);
    assert.ok(compact.length > 4000, `compact JSON must exceed 4000 (was ${compact.length})`);

    const out = summarizeToolOutputForEvidence({ content: pretty });

    assert.ok(out.length <= 4000, `summary must stay within 4000 (was ${out.length})`);
    assert.ok(out.includes("HARDROCKSTADIUM"), "head marker preserved");
    assert.ok(out.includes("NEWYORKNEWJERSEYSTADIUM"), "tail marker preserved");
    // Compaction must have run: pretty-print indentation must not survive.
    assert.ok(!out.includes("  "), "no pretty-print indentation should remain (payload was compacted)");
  });

  it("never throws for unexpected top-level values", () => {
    const cyclic = {};
    cyclic.self = cyclic;
    assert.doesNotThrow(() => summarizeToolOutputForEvidence(undefined), "undefined must not throw");
    assert.doesNotThrow(() => summarizeToolOutputForEvidence(() => 42), "function must not throw");
    assert.doesNotThrow(() => summarizeToolOutputForEvidence(Symbol("x")), "symbol must not throw");
    assert.doesNotThrow(() => summarizeToolOutputForEvidence(10n), "BigInt must not throw");
    assert.doesNotThrow(() => summarizeToolOutputForEvidence(cyclic), "cyclic object must not throw");
    // Each must yield a string (the safe deterministic fallback).
    assert.equal(typeof summarizeToolOutputForEvidence(undefined), "string");
    assert.equal(typeof summarizeToolOutputForEvidence(10n), "string");
    assert.equal(typeof summarizeToolOutputForEvidence(cyclic), "string");
  });

  it("never throws for a hostile proxy whose has/get traps throw", () => {
    // Envelope inspection (`"content" in output` and reading `.content`) trips
    // the proxy traps. Extraction must fail closed rather than propagate.
    const hostile = new Proxy(
      {},
      {
        has() {
          throw new Error("hostile has trap");
        },
        get() {
          throw new Error("hostile get trap");
        },
      }
    );
    let out;
    assert.doesNotThrow(() => {
      out = summarizeToolOutputForEvidence(hostile);
    }, "hostile proxy must not throw");
    assert.equal(typeof out, "string", "must return a string fallback");
  });

  it("reads legacy envelope content exactly once", () => {
    let contentReads = 0;
    const stateful = new Proxy(
      {},
      {
        has(_target, property) {
          return property === "content";
        },
        get(_target, property) {
          if (property !== "content") return undefined;
          contentReads += 1;
          return contentReads === 1 ? "legacy evidence" : Symbol("changed");
        },
      }
    );
    let out;
    assert.doesNotThrow(() => {
      out = summarizeToolOutputForEvidence(stateful);
    }, "stateful content getter must not throw");
    assert.equal(typeof out, "string", "must return a string");
    assert.equal(contentReads, 1, "content must be read exactly once");
  });

  it("fails closed without re-entering a self-referential legacy envelope", () => {
    let contentReads = 0;
    let ownKeysCalls = 0;
    let descriptorCalls = 0;
    let toJSONReads = 0;
    let envelope;
    envelope = new Proxy({}, {
      has(_target, property) {
        return property === "content";
      },
      get(_target, property) {
        if (property === "content") {
          contentReads += 1;
          return envelope;
        }
        if (property === "toJSON") toJSONReads += 1;
        return undefined;
      },
      ownKeys() {
        ownKeysCalls += 1;
        return [];
      },
      getOwnPropertyDescriptor() {
        descriptorCalls += 1;
        return undefined;
      },
    });

    assert.equal(summarizeToolOutputForEvidence(envelope), "[unserializable tool output]");
    assert.equal(contentReads, 1, "content must be read exactly once");
    assert.equal(ownKeysCalls, 0, "original envelope ownKeys must not be invoked");
    assert.equal(descriptorCalls, 0, "original envelope descriptors must not be inspected");
    assert.equal(toJSONReads, 0, "original envelope toJSON must not be inspected");
  });

  it("fails closed without inspecting object content that aliases the legacy envelope", () => {
    let contentReads = 0;
    let ownKeysCalls = 0;
    let descriptorCalls = 0;
    let toJSONReads = 0;
    let envelope;
    envelope = new Proxy({}, {
      has(_target, property) {
        return property === "content";
      },
      get(_target, property) {
        if (property === "content") {
          contentReads += 1;
          return { nested: envelope };
        }
        if (property === "toJSON") toJSONReads += 1;
        return undefined;
      },
      ownKeys() {
        ownKeysCalls += 1;
        return [];
      },
      getOwnPropertyDescriptor() {
        descriptorCalls += 1;
        return undefined;
      },
    });

    assert.equal(summarizeToolOutputForEvidence(envelope), "[unserializable tool output]");
    assert.equal(contentReads, 1, "content must be read exactly once");
    assert.equal(ownKeysCalls, 0, "original envelope ownKeys must not be invoked");
    assert.equal(descriptorCalls, 0, "original envelope descriptors must not be inspected");
    assert.equal(toJSONReads, 0, "original envelope toJSON must not be inspected");
  });

  it("serializes a cached non-string legacy content value without rereading its getter", () => {
    let contentReads = 0;
    const stateful = {
      get content() {
        contentReads += 1;
        return contentReads === 1 ? 9007199254740993n : "changed on second read";
      },
    };

    const out = summarizeToolOutputForEvidence(stateful);

    assert.equal(out, "9007199254740993");
    assert.equal(contentReads, 1, "content must be read exactly once");
  });

  it("attempts a throwing content getter once and returns the stable sentinel", () => {
    let contentReads = 0;
    const hostile = {
      get content() {
        contentReads += 1;
        throw new Error("content getter failed");
      },
      toJSON() {
        throw new Error("original envelope must not be re-serialized");
      },
    };

    assert.equal(
      summarizeToolOutputForEvidence(hostile),
      "[unserializable tool output]"
    );
    assert.equal(contentReads, 1, "throwing content getter must be attempted once");
  });

  it("never throws when toJSON and toString both throw", () => {
    // JSON.stringify trips toJSON; the String() coercion fallback then trips
    // Symbol.toPrimitive/toString. Both paths must be caught, yielding the
    // stable non-secret sentinel.
    const hostile = {
      toJSON() {
        throw new Error("hostile toJSON");
      },
      toString() {
        throw new Error("hostile toString");
      },
      [Symbol.toPrimitive]() {
        throw new Error("hostile Symbol.toPrimitive");
      },
    };
    let out;
    assert.doesNotThrow(() => {
      out = summarizeToolOutputForEvidence(hostile);
    }, "hostile toJSON/toString object must not throw");
    assert.equal(typeof out, "string", "must return a string fallback");
    assert.equal(
      out,
      "[unserializable tool output]",
      "must return the deterministic sentinel"
    );
  });

  it("returns an exactly-4000-char string unchanged", () => {
    const input = "x".repeat(4000);
    assert.equal(input.length, 4000);
    const out = summarizeToolOutputForEvidence(input);
    assert.equal(out, input);
    assert.equal(out.length, 4000);
  });

  it("bounds a 4001-char string to <=4000 while preserving both ends", () => {
    const input = `HEAD${"x".repeat(3993)}TAIL`;
    assert.equal(input.length, 4001);
    const out = summarizeToolOutputForEvidence(input);
    assert.ok(out.length <= 4000, `summary must stay within 4000 (was ${out.length})`);
    assert.ok(out.startsWith("HEAD"), "head preserved");
    assert.ok(out.endsWith("TAIL"), "tail preserved");
  });
});

function isJson(value) {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
