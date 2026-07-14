/**
 * ToolRegistry.dispatchToolCall — real wired-branch coverage for the
 * classifyFailure integration in handleDynamicTool's general failure path.
 *
 * Uses test/fixtures/maxbuffer-overflow-bridge.sh as a stand-in for the
 * Python interpreter. The fixture writes a classifiable signal to stderr,
 * then floods stdout past execFile's hardcoded 25MB maxBuffer so Node
 * replaces `error.message` with the generic "stdout maxBuffer length
 * exceeded" — a real-world case where the classifying text only survives
 * in `stderr`, not in `error`. This reproduces the exact divergence the
 * error_code/hint mismatch fix addresses.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ToolRegistry, bridgeBreaker } from "../dist/tools.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "maxbuffer-overflow-bridge.sh");

describe("dispatchToolCall — wired classifyFailure branch", () => {
  beforeEach(() => {
    chmodSync(FIXTURE, 0o755);
    bridgeBreaker.reset();
  });

  afterEach(() => {
    bridgeBreaker.reset();
  });

  it("classifies the failure using both error and stderr, not error alone", async () => {
    const registry = new ToolRegistry();
    registry.injectSchema({
      sport: "nfl",
      version: "1",
      tools: [{ name: "nfl_scores", command: "scores", description: "test tool", parameters: {} }],
    });

    const result = await registry.dispatchToolCall("nfl_scores", {}, {
      pythonPath: FIXTURE,
      timeout: 15_000,
      env: { FLAKY_ERROR: "permission denied while reaching upstream" },
    });

    assert.equal(result.isError, true);
    const parsed = JSON.parse(result.content);

    // The classifying text ("permission denied") only exists in stderr —
    // execFile's error.message is the generic maxBuffer message. A hint
    // derived from `error` alone would fall back to the generic
    // "command executed but returned a failure exit code" message.
    assert.equal(parsed.error, "stdout maxBuffer length exceeded");
    assert.match(parsed.stderr, /permission denied/);
    assert.match(
      parsed.hint,
      /permission|storage/i,
      `hint should reflect the stderr-only signal, got: ${parsed.hint}`
    );
  });
});
