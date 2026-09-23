// sports-skills record/replay is configured by env vars that must reach the
// Python child; otherwise a frozen benchmark run silently goes live.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { ConnectionManager, SAFE_ENV_KEYS, SENSITIVE_PROCESS_KEYS } from "../dist/connections.js";

const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

test("SPORTS_SKILLS_REPLAY and _DIR are forwarded to the sports-skills subprocess", () => {
  process.env.SPORTS_SKILLS_REPLAY = "replay";
  process.env.SPORTS_SKILLS_REPLAY_DIR = "/tmp/frozen-corpus";
  const env = new ConnectionManager().getSandboxEnv();
  assert.equal(env.SPORTS_SKILLS_REPLAY, "replay");
  assert.equal(env.SPORTS_SKILLS_REPLAY_DIR, "/tmp/frozen-corpus");
});

test("replay keys are treated as config, not secrets", () => {
  for (const key of ["SPORTS_SKILLS_REPLAY", "SPORTS_SKILLS_REPLAY_DIR"]) {
    assert.ok(SAFE_ENV_KEYS.includes(key), key);
    assert.ok(!SENSITIVE_PROCESS_KEYS.includes(key), key);
  }
});

test("unset replay vars stay unset (default off behaviour unchanged)", () => {
  delete process.env.SPORTS_SKILLS_REPLAY;
  delete process.env.SPORTS_SKILLS_REPLAY_DIR;
  const env = new ConnectionManager().getSandboxEnv();
  assert.equal("SPORTS_SKILLS_REPLAY" in env, false);
  assert.equal("SPORTS_SKILLS_REPLAY_DIR" in env, false);
});

test("pythonSupportsReplay reports whether the interpreter's sports-skills has replay", async () => {
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { pythonSupportsReplay } = await import("../dist/run-manifest.js");
  const dir = mkdtempSync(join(tmpdir(), "fake-python-"));
  try {
    const good = join(dir, "good"); writeFileSync(good, "#!/bin/sh\nexit 0\n"); chmodSync(good, 0o755);
    const old = join(dir, "old"); writeFileSync(old, "#!/bin/sh\necho 'No module named sports_skills._replay' >&2\nexit 1\n"); chmodSync(old, 0o755);
    assert.equal(await pythonSupportsReplay(good), true);
    assert.equal(await pythonSupportsReplay(old), false);
    assert.equal(await pythonSupportsReplay(join(dir, "missing")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
