/**
 * resolveRetryPlan — error-class-aware retry policy for the Python bridge.
 *
 * Deterministic failures (missing deps, old Python) must never retry.
 * Transient failures (rate limit, DNS) retry with growing backoff.
 * Timeouts retry once with no sleep (the caller widens the window instead).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveRetryPlan } from "../dist/tools.js";

describe("resolveRetryPlan", () => {
  it("never retries dependency_missing", () => {
    assert.deepEqual(resolveRetryPlan("dependency_missing", 0), { retry: false, delayMs: 0 });
  });

  it("never retries python_version_incompatible", () => {
    assert.deepEqual(resolveRetryPlan("python_version_incompatible", 0), { retry: false, delayMs: 0 });
  });

  it("never retries circuit_open", () => {
    assert.deepEqual(resolveRetryPlan("circuit_open", 0), { retry: false, delayMs: 0 });
  });

  it("retries rate_limited twice with growing backoff", () => {
    const first = resolveRetryPlan("rate_limited", 0);
    assert.equal(first.retry, true);
    assert.ok(first.delayMs >= 1500 && first.delayMs < 1750, `got ${first.delayMs}`);

    const second = resolveRetryPlan("rate_limited", 1);
    assert.equal(second.retry, true);
    assert.ok(second.delayMs >= 3000 && second.delayMs < 3250, `got ${second.delayMs}`);

    assert.equal(resolveRetryPlan("rate_limited", 2).retry, false);
  });

  it("retries network_dns twice with shorter backoff", () => {
    const first = resolveRetryPlan("network_dns", 0);
    assert.equal(first.retry, true);
    assert.ok(first.delayMs >= 500 && first.delayMs < 750, `got ${first.delayMs}`);

    assert.equal(resolveRetryPlan("network_dns", 1).retry, true);
    assert.equal(resolveRetryPlan("network_dns", 2).retry, false);
  });

  it("retries timeout exactly once with zero delay", () => {
    assert.deepEqual(resolveRetryPlan("timeout", 0), { retry: true, delayMs: 0 });
    assert.equal(resolveRetryPlan("timeout", 1).retry, false);
  });

  it("retries tool_execution_failed once with a brief pause", () => {
    const first = resolveRetryPlan("tool_execution_failed", 0);
    assert.equal(first.retry, true);
    assert.ok(first.delayMs >= 250 && first.delayMs < 500, `got ${first.delayMs}`);
    assert.equal(resolveRetryPlan("tool_execution_failed", 1).retry, false);
  });
});
