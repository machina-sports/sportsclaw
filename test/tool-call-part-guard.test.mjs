/**
 * isToolCallPart — runtime guard for cross-provider tool-call message parts.
 *
 * Replaces a structural cast (`msg.content as Array<{type?, toolName?}>`)
 * that silently produced no matches when a provider returned an unexpected
 * shape. The guard only accepts parts where `type === "tool-call"` and
 * `toolName` is a string.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isToolCallPart } from "../dist/index.js";

describe("isToolCallPart", () => {
  it("accepts a well-formed tool-call part", () => {
    assert.equal(isToolCallPart({ type: "tool-call", toolName: "get_score" }), true);
  });

  it("accepts extra fields without rejecting", () => {
    // Real Vercel AI SDK parts carry id/args/etc.; the guard only checks the
    // fields we depend on, so additional properties are fine.
    assert.equal(
      isToolCallPart({
        type: "tool-call",
        toolName: "get_score",
        toolCallId: "tc-1",
        args: { sport: "nba" },
      }),
      true
    );
  });

  it("rejects a part with the wrong type", () => {
    assert.equal(isToolCallPart({ type: "text", toolName: "get_score" }), false);
    assert.equal(isToolCallPart({ type: "tool-result", toolName: "get_score" }), false);
  });

  it("rejects a part missing toolName", () => {
    assert.equal(isToolCallPart({ type: "tool-call" }), false);
  });

  it("rejects a part where toolName is not a string", () => {
    assert.equal(isToolCallPart({ type: "tool-call", toolName: 42 }), false);
    assert.equal(isToolCallPart({ type: "tool-call", toolName: null }), false);
    assert.equal(isToolCallPart({ type: "tool-call", toolName: { name: "x" } }), false);
  });

  it("rejects non-objects", () => {
    assert.equal(isToolCallPart(null), false);
    assert.equal(isToolCallPart(undefined), false);
    assert.equal(isToolCallPart("tool-call"), false);
    assert.equal(isToolCallPart(123), false);
    assert.equal(isToolCallPart(true), false);
  });
});
