/**
 * Inference Contracts — test suite
 *
 * Tests for model-role types and inference task envelope/trace/result
 * validators. Written test-first (TDD).
 *
 * The abstraction is inference roles, not hardware — H200 is only runtime
 * metadata/trace. See the model-role router spec.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MODEL_ROLES,
  isModelRole,
} from "../dist/inference/model-roles.js";

import {
  INFERENCE_ROUTES,
  validateInferenceTaskEnvelope,
  validateInferenceTrace,
} from "../dist/inference/inference-task.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid InferenceTaskEnvelope */
function validEnvelope(overrides = {}) {
  return {
    taskId: "task-1",
    role: "eyes",
    model: "nvidia/cosmos3-nano-reasoner",
    input: { clipUrl: "https://example.com/clip.mp4" },
    requestedAt: new Date().toISOString(),
    source: "machina-pod",
    ...overrides,
  };
}

/** Minimal valid InferenceTrace */
function validTrace(overrides = {}) {
  return {
    taskId: "task-1",
    role: "eyes",
    model: "nvidia/cosmos3-nano-reasoner",
    startedAt: "2026-06-01T00:00:00.000Z",
    endedAt: "2026-06-01T00:00:01.250Z",
    latencyMs: 1250,
    route: "mock",
    status: "completed",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ModelRole
// ---------------------------------------------------------------------------

describe("MODEL_ROLES", () => {
  it("exports exactly the four expected roles", () => {
    assert.deepStrictEqual(
      [...MODEL_ROLES].sort(),
      ["brain", "eyes", "hands", "voice"].sort(),
    );
  });
});

describe("isModelRole", () => {
  it("accepts every declared role", () => {
    for (const role of MODEL_ROLES) {
      assert.strictEqual(isModelRole(role), true, `expected ${role} to be valid`);
    }
  });

  it("rejects unknown role strings", () => {
    assert.strictEqual(isModelRole("gpu0"), false);
    assert.strictEqual(isModelRole("ears"), false);
    assert.strictEqual(isModelRole(""), false);
  });

  it("rejects non-string values", () => {
    assert.strictEqual(isModelRole(undefined), false);
    assert.strictEqual(isModelRole(null), false);
    assert.strictEqual(isModelRole(42), false);
    assert.strictEqual(isModelRole(["eyes"]), false);
  });
});

// ---------------------------------------------------------------------------
// validateInferenceTaskEnvelope
// ---------------------------------------------------------------------------

describe("validateInferenceTaskEnvelope", () => {
  it("accepts a valid envelope", () => {
    const result = validateInferenceTaskEnvelope(validEnvelope());
    assert.strictEqual(result.ok, true);
  });

  it("accepts every declared source", () => {
    for (const source of ["machina-pod", "sportsclaw-operator", "benchmark"]) {
      const result = validateInferenceTaskEnvelope(validEnvelope({ source }));
      assert.strictEqual(result.ok, true, `expected source ${source} to be valid`);
    }
  });

  it("rejects a non-object", () => {
    const result = validateInferenceTaskEnvelope(null);
    assert.strictEqual(result.ok, false);
  });

  it("rejects a missing taskId", () => {
    const envelope = validEnvelope();
    delete envelope.taskId;
    const result = validateInferenceTaskEnvelope(envelope);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("taskId"));
  });

  it("rejects an empty taskId", () => {
    const result = validateInferenceTaskEnvelope(validEnvelope({ taskId: "" }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("taskId"));
  });

  it("rejects an unknown role", () => {
    const result = validateInferenceTaskEnvelope(validEnvelope({ role: "gpu0" }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("role"));
  });

  it("rejects a missing model", () => {
    const result = validateInferenceTaskEnvelope(validEnvelope({ model: "" }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("model"));
  });

  it("rejects a missing requestedAt", () => {
    const result = validateInferenceTaskEnvelope(validEnvelope({ requestedAt: "" }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("requestedAt"));
  });

  it("rejects an unknown source", () => {
    const result = validateInferenceTaskEnvelope(validEnvelope({ source: "h200" }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("source"));
  });
});

// ---------------------------------------------------------------------------
// validateInferenceTrace
// ---------------------------------------------------------------------------

describe("INFERENCE_ROUTES", () => {
  it("exports exactly the expected routes", () => {
    assert.deepStrictEqual(
      [...INFERENCE_ROUTES].sort(),
      ["mock", "nim", "openshell"].sort(),
    );
  });
});

describe("validateInferenceTrace", () => {
  it("accepts a valid completed trace", () => {
    const result = validateInferenceTrace(validTrace());
    assert.strictEqual(result.ok, true);
  });

  it("accepts a failed trace with an error message", () => {
    const result = validateInferenceTrace(
      validTrace({ status: "failed", error: "NIM endpoint unreachable" }),
    );
    assert.strictEqual(result.ok, true);
  });

  it("rejects a non-object", () => {
    const result = validateInferenceTrace("trace");
    assert.strictEqual(result.ok, false);
  });

  it("rejects a missing taskId", () => {
    const result = validateInferenceTrace(validTrace({ taskId: "" }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("taskId"));
  });

  it("rejects an unknown role", () => {
    const result = validateInferenceTrace(validTrace({ role: "h200" }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("role"));
  });

  it("rejects a negative latencyMs", () => {
    const result = validateInferenceTrace(validTrace({ latencyMs: -5 }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("latencyMs"));
  });

  it("rejects a non-numeric latencyMs", () => {
    const result = validateInferenceTrace(validTrace({ latencyMs: "fast" }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("latencyMs"));
  });

  it("rejects an unknown route", () => {
    const result = validateInferenceTrace(validTrace({ route: "direct-gpu" }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("route"));
  });

  it("rejects an unknown status", () => {
    const result = validateInferenceTrace(validTrace({ status: "pending" }));
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("status"));
  });

  it("rejects missing startedAt / endedAt", () => {
    assert.strictEqual(validateInferenceTrace(validTrace({ startedAt: "" })).ok, false);
    assert.strictEqual(validateInferenceTrace(validTrace({ endedAt: "" })).ok, false);
  });
});
