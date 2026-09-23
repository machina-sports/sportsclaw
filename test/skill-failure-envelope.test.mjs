// #187: sports-skills reports most failures in-band ({"status": false,
// "message": ...}) with exit code 0. The registry must flag those as tool
// errors instead of successes. Drives the real registry → Python bridge path
// against a fake interpreter that prints a canned response.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ToolRegistry, isSkillFailurePayload } from "../dist/tools.js";

function fakePython(dir, body) {
  const path = join(dir, "python");
  writeFileSync(path, `#!/bin/sh\ncat <<'JSON'\n${body}\nJSON\n`);
  chmodSync(path, 0o755);
  return path;
}

async function dispatch(body) {
  const dir = mkdtempSync(join(tmpdir(), "skill-envelope-"));
  try {
    const registry = new ToolRegistry();
    registry.injectSchema({
      sport: "mlb",
      version: "test",
      tools: [{ name: "mlb_get_mlbstats_leaders", command: "get_mlbstats_leaders", description: "leaders",
        parameters: { type: "object", properties: { category: { type: "string" } } } }],
    });
    return await registry.dispatchToolCall("mlb_get_mlbstats_leaders", { category: "home_runs" }, { pythonPath: fakePython(dir, body) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("isSkillFailurePayload recognises only status:false envelopes", () => {
  assert.equal(isSkillFailurePayload({ status: false, data: null, message: "x" }), true);
  assert.equal(isSkillFailurePayload({ status: true, data: [] }), false);
  assert.equal(isSkillFailurePayload({ leaders: [] }), false);
  assert.equal(isSkillFailurePayload([{ status: false }]), false);
  assert.equal(isSkillFailurePayload(null), false);
});

test("a status:false response is an error, and its message reaches the model", async () => {
  const res = await dispatch(JSON.stringify({ status: false, data: null,
    message: "No leaders returned for category 'home_runs' in 2025. Categories are camelCase MLB stat names, e.g. homeRuns" }));
  assert.equal(res.isError, true);
  assert.match(JSON.parse(res.content).message, /camelCase MLB stat names/);
});

test("a successful response is still a success", async () => {
  const res = await dispatch(JSON.stringify({ status: true, data: { leaders: [{ player: "Cal Raleigh", value: 60 }] } }));
  assert.equal(res.isError, false);
  assert.match(res.content, /Cal Raleigh/);
});
