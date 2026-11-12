/**
 * The role that writes narration and on-screen copy is `writer`. It was called `voice`,
 * which reads as "the thing that speaks" (that is `inference.speech`). `voice` is no
 * longer a role.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MODEL_ROLES, isModelRole } from "../dist/inference/model-roles.js";
import { invokeModelRole, validateModelRoleRouterConfig } from "../dist/inference/model-role-router.js";

const mock = { route: "mock", model: "m" };

describe("writer role", () => {
  it("is one of the four roles", () => {
    assert.deepEqual([...MODEL_ROLES], ["eyes", "brain", "hands", "writer"]);
    assert.equal(isModelRole("writer"), true);
  });

  it("is invoked by its name and reports it in the result and trace", async () => {
    const result = await invokeModelRole({ role: "writer", input: "x", source: "benchmark", config: { roles: { writer: mock } } });
    assert.equal(result.role, "writer");
    assert.equal(result.trace.role, "writer");
  });
});

describe("voice is not a role", () => {
  it("is refused in config, naming the roles that exist", () => {
    assert.equal(isModelRole("voice"), false);
    assert.match(validateModelRoleRouterConfig({ roles: { voice: mock } }).error, /Unknown role "voice".*writer/);
  });

  it("is refused as the role of a call", async () => {
    await assert.rejects(invokeModelRole({ role: "voice", input: "x", source: "benchmark", config: { roles: { writer: mock } } }), /Unknown model role "voice"/);
  });
});
