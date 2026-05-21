import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { injectSystemPrefix } from "../dist/anthropic-oauth.js";

const PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";

describe("injectSystemPrefix", () => {
  it("adds the prefix as the only system block when none is set", () => {
    const out = injectSystemPrefix({ messages: [] });
    assert.deepEqual(out.system, [{ type: "text", text: PREFIX }]);
  });

  it("wraps a string system into [prefix, original]", () => {
    const out = injectSystemPrefix({ system: "You are a sports analyst.", messages: [] });
    assert.deepEqual(out.system, [
      { type: "text", text: PREFIX },
      { type: "text", text: "You are a sports analyst." },
    ]);
  });

  it("prepends the prefix when the array's first block doesn't already match", () => {
    const out = injectSystemPrefix({
      system: [{ type: "text", text: "Be terse." }],
      messages: [],
    });
    assert.deepEqual(out.system, [
      { type: "text", text: PREFIX },
      { type: "text", text: "Be terse." },
    ]);
  });

  it("is idempotent: re-running on an already-prefixed body is a no-op", () => {
    const first = injectSystemPrefix({ system: "Be terse.", messages: [] });
    const second = injectSystemPrefix(first);
    assert.deepEqual(second.system, first.system);
  });

  it("treats a string starting with the prefix as already-prefixed", () => {
    const already = `${PREFIX}\n\nExtra guidance.`;
    const out = injectSystemPrefix({ system: already, messages: [] });
    // String stayed a string (we don't rewrap) — and the prefix is preserved at the front
    assert.equal(out.system, already);
  });

  it("preserves other body fields untouched", () => {
    const input = { system: "x", messages: [{ role: "user", content: "hi" }], model: "claude-x" };
    const out = injectSystemPrefix(input);
    assert.deepEqual(out.messages, input.messages);
    assert.equal(out.model, input.model);
  });
});
