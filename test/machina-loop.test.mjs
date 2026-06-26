import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findLoopServer, LOOP_RUNNER_AGENT } from "../dist/mcp.js";
import { machinaLoopTool } from "../dist/tools/machina_loop.js";

const caps = (agents) => ({ workflows: [], agents, connectors: [], discoveredAt: 0 });

describe("findLoopServer — durable loop detection", () => {
  it("detects the server exposing the loop-runner agent", () => {
    const pods = new Map([
      ["other", caps([{ name: "some-agent" }])],
      ["machina", caps([{ name: LOOP_RUNNER_AGENT }])],
    ]);
    assert.equal(findLoopServer(pods), "machina");
  });

  it("returns undefined when no server has the loop-runner agent", () => {
    const pods = new Map([["pod", caps([{ name: "copilot-executor" }])]]);
    assert.equal(findLoopServer(pods), undefined);
  });

  it("returns undefined for empty capabilities", () => {
    assert.equal(findLoopServer(new Map()), undefined);
  });
});

describe("machinaLoopTool spec", () => {
  it("exposes a machina_loop tool with start/continue/read actions", () => {
    assert.equal(machinaLoopTool.spec.name, "machina_loop");
    assert.deepEqual(machinaLoopTool.spec.input_schema.properties.action.enum, [
      "start",
      "continue",
      "read",
    ]);
    assert.deepEqual(machinaLoopTool.spec.input_schema.required, ["action"]);
  });

  it("errors clearly when no Machina loop is connected", async () => {
    // No registry / no mcpManager → tool must fail safe, not throw.
    const res = await machinaLoopTool.execute({ action: "start", prompt: "hi" }, {}, undefined);
    assert.equal(res.isError, true);
    const body = JSON.parse(res.content);
    assert.equal(body.error_code, "machina_loop");
    assert.match(body.error, /No Machina durable loop/i);
  });

  it("requires session_id for read", async () => {
    // Registry whose mcpManager reports a connected loop server.
    const registry = { getMcpManager: () => ({ getMachinaLoopServer: () => "machina" }) };
    const res = await machinaLoopTool.execute({ action: "read" }, {}, registry);
    assert.equal(res.isError, true);
    assert.match(JSON.parse(res.content).error, /read requires session_id/i);
  });
});
