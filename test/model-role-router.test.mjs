/**
 * Model Role Router — test suite
 *
 * Tests for role-route config validation and invokeModelRole. Written
 * test-first (TDD). No network calls — real routes are exercised only
 * through their config/error paths; execution goes through the mock route.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  validateModelRoleRouterConfig,
  invokeModelRole,
  InferenceRouteError,
} from "../dist/inference/model-role-router.js";

import { validateInferenceTrace } from "../dist/inference/inference-task.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Full four-role router config (mock routes so tests never hit a network). */
function mockRouterConfig() {
  return {
    roles: {
      eyes: { route: "mock", model: "nvidia/cosmos3-nano-reasoner" },
      brain: { route: "mock", model: "nvidia/nemotron-3-super-120b-a12b" },
      hands: { route: "mock", model: "nvidia/cosmos3-super-i2v" },
      voice: { route: "mock", model: "nvidia/llama-3.3-nemotron-super-49b" },
    },
  };
}

/** The target production shape from the spec — NIM routes with H200 metadata. */
function nimRouterConfig() {
  return {
    roles: {
      eyes: {
        route: "nim",
        locality: "h200",
        accelerator: "h200",
        model: "nvidia/cosmos3-nano-reasoner",
      },
      brain: {
        route: "nim",
        locality: "h200",
        accelerator: "h200",
        model: "nvidia/nemotron-3-super-120b-a12b",
      },
      hands: {
        route: "nim",
        locality: "h200",
        accelerator: "h200",
        model: "nvidia/cosmos3-super-i2v",
      },
      voice: {
        route: "nim",
        locality: "h200",
        accelerator: "h200",
        model: "nvidia/llama-3.3-nemotron-super-49b",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// validateModelRoleRouterConfig
// ---------------------------------------------------------------------------

describe("validateModelRoleRouterConfig", () => {
  it("accepts a full mock config", () => {
    const result = validateModelRoleRouterConfig(mockRouterConfig());
    assert.strictEqual(result.ok, true);
  });

  it("accepts the target NIM/H200 config shape", () => {
    const result = validateModelRoleRouterConfig(nimRouterConfig());
    assert.strictEqual(result.ok, true);
  });

  it("accepts a partial config (only some roles configured)", () => {
    const config = { roles: { brain: { route: "mock", model: "test-model" } } };
    const result = validateModelRoleRouterConfig(config);
    assert.strictEqual(result.ok, true);
  });

  it("rejects a non-object", () => {
    assert.strictEqual(validateModelRoleRouterConfig(null).ok, false);
    assert.strictEqual(validateModelRoleRouterConfig("inference").ok, false);
  });

  it("rejects a missing roles block", () => {
    const result = validateModelRoleRouterConfig({});
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("roles"));
  });

  it("rejects an unknown role key", () => {
    const config = mockRouterConfig();
    config.roles.ears = { route: "mock", model: "test-model" };
    const result = validateModelRoleRouterConfig(config);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("ears"));
  });

  it("rejects an unknown route", () => {
    const config = mockRouterConfig();
    config.roles.eyes.route = "gpu-direct";
    const result = validateModelRoleRouterConfig(config);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("eyes"));
    assert.ok(result.error.includes("route"));
  });

  it("rejects a missing model", () => {
    const config = mockRouterConfig();
    config.roles.brain.model = "";
    const result = validateModelRoleRouterConfig(config);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("brain"));
    assert.ok(result.error.includes("model"));
  });

  it("rejects an unknown locality", () => {
    const config = mockRouterConfig();
    config.roles.hands.locality = "moon-base";
    const result = validateModelRoleRouterConfig(config);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("hands"));
    assert.ok(result.error.includes("locality"));
  });

  it("rejects an unknown accelerator", () => {
    const config = mockRouterConfig();
    config.roles.voice.accelerator = "tpu9000";
    const result = validateModelRoleRouterConfig(config);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes("voice"));
    assert.ok(result.error.includes("accelerator"));
  });
});

// ---------------------------------------------------------------------------
// invokeModelRole — mock route
// ---------------------------------------------------------------------------

describe("invokeModelRole (mock route)", () => {
  it("returns an InferenceResult with a valid completed trace", async () => {
    const result = await invokeModelRole({
      role: "eyes",
      input: { clipUrl: "https://example.com/clip.mp4", sampledFps: 4 },
      source: "benchmark",
      config: mockRouterConfig(),
    });

    assert.strictEqual(result.role, "eyes");
    assert.ok(result.taskId.length > 0);
    assert.strictEqual(result.trace.taskId, result.taskId);
    assert.strictEqual(result.trace.role, "eyes");
    assert.strictEqual(result.trace.model, "nvidia/cosmos3-nano-reasoner");
    assert.strictEqual(result.trace.route, "mock");
    assert.strictEqual(result.trace.status, "completed");
    assert.ok(typeof result.trace.latencyMs === "number" && result.trace.latencyMs >= 0);

    const traceCheck = validateInferenceTrace(result.trace);
    assert.strictEqual(traceCheck.ok, true, traceCheck.ok ? "" : traceCheck.error);
  });

  it("echoes the input in the mock output", async () => {
    const input = { headline: "Brazil pressure is structural" };
    const result = await invokeModelRole({
      role: "voice",
      input,
      source: "sportsclaw-operator",
      config: mockRouterConfig(),
    });

    assert.strictEqual(result.output.mock, true);
    assert.deepStrictEqual(result.output.echo, input);
  });

  it("honors a caller-supplied taskId", async () => {
    const result = await invokeModelRole({
      role: "brain",
      input: "What is the tactical meaning of this moment?",
      source: "machina-pod",
      config: mockRouterConfig(),
      taskId: "task-fixed-42",
    });

    assert.strictEqual(result.taskId, "task-fixed-42");
    assert.strictEqual(result.trace.taskId, "task-fixed-42");
  });
});

// ---------------------------------------------------------------------------
// invokeModelRole — error paths
// ---------------------------------------------------------------------------

describe("invokeModelRole (error paths)", () => {
  it("rejects an unknown role", async () => {
    await assert.rejects(
      () =>
        invokeModelRole({
          role: "gpu0",
          input: {},
          source: "benchmark",
          config: mockRouterConfig(),
        }),
      (err) => err.message.includes("gpu0"),
    );
  });

  it("fails explicitly (not silently) when a role has no route config", async () => {
    const config = { roles: { eyes: { route: "mock", model: "m" } } };
    await assert.rejects(
      () =>
        invokeModelRole({
          role: "voice",
          input: {},
          source: "machina-pod",
          config,
        }),
      (err) => err.message.includes("voice"),
    );
  });

  it("route errors include role and model", async () => {
    // nim route with no base URL resolvable — must fail fast, before any
    // network attempt, naming the role and model.
    const savedNim = process.env.NIM_BASE_URL;
    const savedOpenai = process.env.OPENAI_BASE_URL;
    delete process.env.NIM_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    try {
      await assert.rejects(
        () =>
          invokeModelRole({
            role: "brain",
            input: "prompt",
            source: "machina-pod",
            config: {
              roles: {
                brain: { route: "nim", model: "nvidia/nemotron-3-super-120b-a12b" },
              },
            },
          }),
        (err) => {
          assert.ok(err instanceof InferenceRouteError);
          assert.ok(err.message.includes("brain"));
          assert.ok(err.message.includes("nvidia/nemotron-3-super-120b-a12b"));
          assert.strictEqual(err.trace.status, "failed");
          assert.strictEqual(err.trace.route, "nim");
          return true;
        },
      );
    } finally {
      if (savedNim !== undefined) process.env.NIM_BASE_URL = savedNim;
      if (savedOpenai !== undefined) process.env.OPENAI_BASE_URL = savedOpenai;
    }
  });
});
