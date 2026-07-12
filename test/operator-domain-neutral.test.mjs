/**
 * Domain-neutral operator output contract (PR2).
 *
 * The structured output path must be domain-neutral by default (no TV/World Cup
 * language), with the tool name, classifier, text extractor, and any domain
 * guidance supplied by the sink's contract.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { createOperatorDaemon } from "../dist/operator-daemon.js";
import { HeartbeatService } from "../dist/heartbeat.js";

let tmpDir;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "domain-neutral-")); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

const minimalSchema = { type: "object", properties: {}, additionalProperties: true };

function genToolCall(toolName, input) {
  const calls = [];
  const impl = async (args) => { calls.push(args); return { toolCalls: [{ toolName, input }], text: "" }; };
  impl.calls = calls;
  return impl;
}
function base(overrides = {}) {
  return {
    jobId: "dn-test", intervalMs: 60_000, rootDir: tmpDir,
    role: "You are a test operator.", model: { name: "m" },
    heartbeat: new HeartbeatService(), persistence: false,
    ...overrides,
  };
}

describe("domain-neutral output contract (PR2)", () => {
  it("default structured fragment has no TV/World Cup language", async () => {
    const gen = genToolCall("submit_broadcast", { silent: false, narrative: "x" });
    const d = createOperatorDaemon(base({ generateTextImpl: gen, outputSchema: { schema: minimalSchema } }));
    await d.tickOnce();
    const sys = gen.calls[0].system;
    assert.doesNotMatch(sys, /world cup|broadcasting|on-air/i, "engine default fragment is domain-neutral");
    assert.match(sys, /submit_broadcast/, "still names the (default) output tool");
  });

  it("uses a custom toolName + classify + extractText contract", async () => {
    const gen = genToolCall("submit_vault_answer", { type: "answer", answer: "Cleared for full contact." });
    const d = createOperatorDaemon(base({
      generateTextImpl: gen,
      outputSchema: {
        schema: minimalSchema,
        toolName: "submit_vault_answer",
        classify: (o) => (o?.type === "idle" ? "idle" : "answer"),
        extractText: (o) => o?.answer,
      },
    }));
    const ev = await d.tickOnce();
    assert.ok(gen.calls[0].tools?.submit_vault_answer, "forces the custom output tool");
    assert.equal(ev.type, "tick_published");
    assert.equal(ev.text, "Cleared for full contact.");
  });

  it("classifier idle → tick_silent", async () => {
    const gen = genToolCall("submit_vault_answer", { type: "idle" });
    const d = createOperatorDaemon(base({
      generateTextImpl: gen,
      outputSchema: { schema: minimalSchema, toolName: "submit_vault_answer", classify: (o) => (o?.type === "idle" ? "idle" : "answer") },
    }));
    const ev = await d.tickOnce();
    assert.equal(ev.type, "tick_silent");
  });

  it("appends sink guidance to the output instruction", async () => {
    const gen = genToolCall("submit_result", { silent: false, narrative: "x" });
    const d = createOperatorDaemon(base({
      generateTextImpl: gen,
      outputSchema: { schema: minimalSchema, toolName: "submit_result", guidance: "PREFER_XYZ_GUIDANCE" },
    }));
    await d.tickOnce();
    assert.match(gen.calls[0].system, /PREFER_XYZ_GUIDANCE/);
    assert.match(gen.calls[0].system, /submit_result/);
  });

  it("forwards a custom tickPrompt template", async () => {
    const gen = genToolCall("submit_broadcast", { silent: false, narrative: "x" });
    const d = createOperatorDaemon(base({
      generateTextImpl: gen,
      outputSchema: { schema: minimalSchema },
      tickPrompt: "CUSTOM_TICK_{tickId}",
    }));
    await d.tickOnce();
    assert.match(gen.calls[0].prompt, /CUSTOM_TICK_/);
  });
});
