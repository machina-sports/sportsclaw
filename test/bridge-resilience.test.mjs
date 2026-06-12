/**
 * executePythonBridge — retry + circuit breaker integration.
 *
 * Uses test/fixtures/flaky-bridge.sh as a stand-in for the Python
 * interpreter (config.pythonPath accepts any executable). The fixture
 * fails FLAKY_FAILURES times then succeeds, counting attempts in a
 * state file so tests can assert exactly how many attempts happened.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { executePythonBridge, bridgeBreaker } from "../dist/tools.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "flaky-bridge.sh");

let stateDir;

function bridgeConfig(failures, extraEnv = {}) {
  return {
    pythonPath: FIXTURE,
    timeout: 5_000,
    env: {
      FLAKY_STATE: join(stateDir, "count"),
      FLAKY_FAILURES: String(failures),
      ...extraEnv,
    },
  };
}

function attempts() {
  return Number(readFileSync(join(stateDir, "count"), "utf-8").trim());
}

describe("executePythonBridge resilience", () => {
  beforeEach(() => {
    chmodSync(FIXTURE, 0o755);
    stateDir = mkdtempSync(join(tmpdir(), "sc-bridge-"));
    bridgeBreaker.reset();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    bridgeBreaker.reset();
  });

  it("retries transient network errors and succeeds", async () => {
    const result = await executePythonBridge("nfl", "scores", undefined, bridgeConfig(2));
    assert.equal(result.success, true);
    assert.equal(attempts(), 3, "two failures + one success");
  });

  it("does not retry deterministic dependency failures", async () => {
    const result = await executePythonBridge("nfl", "scores", undefined, bridgeConfig(99, {
      FLAKY_ERROR: "ModuleNotFoundError: No module named 'sports_skills'",
    }));
    assert.equal(result.success, false);
    assert.equal(attempts(), 1, "no retry for missing dependency");
  });

  it("gives up after exhausting transient retries", async () => {
    const result = await executePythonBridge("nfl", "scores", undefined, bridgeConfig(99));
    assert.equal(result.success, false);
    assert.equal(attempts(), 3, "initial attempt + two network retries");
  });

  it("opens the circuit after repeated failing calls and fails fast", async () => {
    const cfg = bridgeConfig(9999, {
      FLAKY_ERROR: "ModuleNotFoundError: No module named 'sports_skills'",
    });
    // Default threshold is 5 consecutive failed calls.
    for (let i = 0; i < 5; i++) {
      await executePythonBridge("nfl", "scores", undefined, cfg);
    }
    const before = attempts();
    const result = await executePythonBridge("nfl", "scores", undefined, cfg);
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /circuit breaker open/i);
    assert.equal(attempts(), before, "subprocess was not spawned while open");
    // Other sports are unaffected.
    const other = await executePythonBridge("nba", "scores", undefined, cfg);
    assert.equal(other.success, false);
    assert.doesNotMatch(other.error ?? "", /circuit breaker open/i);
  });

  it("a success closes the circuit again", async () => {
    const cfg = bridgeConfig(5, {
      FLAKY_ERROR: "ModuleNotFoundError: No module named 'sports_skills'",
    });
    for (let i = 0; i < 5; i++) {
      await executePythonBridge("nfl", "scores", undefined, cfg);
    }
    assert.equal(bridgeBreaker.canProceed("nfl"), false);
    // Simulate cooldown elapsing by resetting (clock injection is unit-tested
    // in circuit-breaker.test.mjs; here we only verify the success path closes).
    bridgeBreaker.recordSuccess("nfl");
    const result = await executePythonBridge("nfl", "scores", undefined, cfg);
    assert.equal(result.success, true, "6th invocation exceeds FLAKY_FAILURES=5");
  });
});
