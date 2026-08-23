import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { runOneShotEngine, takeOneShotUserId } from "../dist/index.js";

function recordingEngine() {
  const calls = [];
  return {
    calls,
    engine: {
      async run(prompt, options) {
        calls.push({ prompt, options });
        return "ok";
      },
    },
  };
}

describe("one-shot CLI user propagation", () => {
  it("passes the parsed user to engine.run in verbose mode", async () => {
    const { engine, calls } = recordingEngine();
    const args = ["score", "update", "--user", "verbose-user", "--verbose"];
    await runOneShotEngine(engine, "score update", {
      userId: takeOneShotUserId(args),
      systemPrompt: undefined,
      agentIds: [],
      delegated: false,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.userId, "verbose-user");
  });

  it("passes the parsed user and progress options to engine.run in normal mode", async () => {
    const { engine, calls } = recordingEngine();
    const args = ["score", "update", "--user", "normal-user"];
    const onProgress = () => {};
    const abortSignal = new AbortController().signal;
    await runOneShotEngine(engine, "score update", {
      userId: takeOneShotUserId(args),
      systemPrompt: "caller context",
      agentIds: ["scoreboard"],
      delegated: true,
      onProgress,
      abortSignal,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.userId, "normal-user");
    assert.equal(calls[0].options.onProgress, onProgress);
    assert.equal(calls[0].options.abortSignal, abortSignal);
  });

  it("rejects a missing --user value instead of treating it as prompt text", () => {
    assert.throws(() => takeOneShotUserId(["score update", "--user"]), /requires a user id/);
    assert.throws(
      () => takeOneShotUserId(["score update", "--user", "--verbose"]),
      /requires a user id/
    );
  });

  it("routes headless, verbose, and normal CLI branches through the shared user-aware runner", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const calls = [...source.matchAll(/runOneShotEngine\(engine, prompt, \{([\s\S]*?)\n\s*\}\);/g)];
    assert.equal(calls.length, 3, "all one-shot branches must use the shared runner");
    for (const call of calls) {
      assert.match(call[1], /\buserId\s*,/, "every one-shot engine.run path must receive parsed --user");
    }
  });
});
