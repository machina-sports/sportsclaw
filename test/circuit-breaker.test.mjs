/**
 * CircuitBreaker — keyed failure counter that fails fast after a threshold
 * of consecutive failures and allows a half-open probe after a cooldown.
 * Clock is injectable so tests never sleep.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CircuitBreaker } from "../dist/circuit-breaker.js";

describe("CircuitBreaker", () => {
  it("allows calls while below the failure threshold", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure("nfl");
    cb.recordFailure("nfl");
    assert.equal(cb.canProceed("nfl"), true);
  });

  it("opens after threshold consecutive failures", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure("nfl");
    cb.recordFailure("nfl");
    cb.recordFailure("nfl");
    assert.equal(cb.canProceed("nfl"), false);
  });

  it("keys are independent", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure("nfl");
    assert.equal(cb.canProceed("nfl"), false);
    assert.equal(cb.canProceed("nba"), true);
  });

  it("a success resets the consecutive failure count and closes the circuit", () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    cb.recordFailure("nfl");
    cb.recordFailure("nfl");
    assert.equal(cb.canProceed("nfl"), false);
    cb.recordSuccess("nfl");
    assert.equal(cb.canProceed("nfl"), true);
    cb.recordFailure("nfl");
    assert.equal(cb.canProceed("nfl"), true, "count restarted after success");
  });

  it("allows a half-open probe after the cooldown elapses", () => {
    let clock = 1_000_000;
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 60_000,
      now: () => clock,
    });
    cb.recordFailure("nfl");
    assert.equal(cb.canProceed("nfl"), false);
    clock += 59_999;
    assert.equal(cb.canProceed("nfl"), false);
    clock += 1;
    assert.equal(cb.canProceed("nfl"), true, "half-open after cooldown");
  });

  it("a failed half-open probe re-opens for another full cooldown", () => {
    let clock = 1_000_000;
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 60_000,
      now: () => clock,
    });
    cb.recordFailure("nfl");
    clock += 60_000;
    assert.equal(cb.canProceed("nfl"), true);
    cb.recordFailure("nfl"); // probe failed
    clock += 30_000;
    assert.equal(cb.canProceed("nfl"), false, "re-opened from the probe failure");
  });

  it("reset() clears all state", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure("nfl");
    cb.reset();
    assert.equal(cb.canProceed("nfl"), true);
  });
});
