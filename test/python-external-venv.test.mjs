/**
 * ensureVenv — external virtualenv vs managed venv. No-network tests.
 *
 * Fake interpreters are shell scripts that log their argv, so the tests can
 * assert which interpreter was invoked and that nothing was pip-installed.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "sportsclaw-python-test-"));
const home = join(root, "home");
const managedDir = join(home, ".sportsclaw", "venv");
const managedPython = join(managedDir, "bin", "python3");
const marker = join(managedDir, ".sportsclaw-extras");

/**
 * Write a fake interpreter: the `-c` probe exits with `probeExit`, everything else exits 0.
 * Each invocation's argv is logged terminated by an ASCII record separator (\x1e), since
 * the multiline `-c` probe script would otherwise be split into several log lines.
 */
function fakePython(path, probeExit) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s\\036' "$*" >> "${path}.log"\nif [ "$1" = "-c" ]; then exit ${probeExit}; fi\nexit 0\n`,
    { mode: 0o755 }
  );
  return path;
}

/** One entry per invocation of the fake interpreter. */
function calls(path) {
  try {
    return readFileSync(`${path}.log`, "utf-8").split("\x1e").filter(Boolean);
  } catch {
    return [];
  }
}

describe("ensureVenv", () => {
  let python;
  const originalHome = process.env.HOME;

  before(async () => {
    // VENV_DIR is resolved from homedir() at module load, so HOME must be set
    // before the (dynamic) import.
    process.env.HOME = home;
    python = await import("../dist/python.js");
    // Pre-existing managed venv without extras marker (the canary state).
    fakePython(managedPython, 0);
  });

  after(() => {
    process.env.HOME = originalHome;
    rmSync(root, { recursive: true, force: true });
  });

  it("uses a supplied virtualenv with sports-skills as-is", () => {
    const external = fakePython(join(root, "opt-venv", "bin", "python3"), 0);

    const result = python.ensureVenv(external);

    assert.deepEqual(result, { ok: true, pythonPath: external });
    assert.equal(calls(external).length, 1);
    assert.match(calls(external)[0], /^-c /);
    assert.deepEqual(calls(managedPython), []);
    assert.equal(existsSync(marker), false);
  });

  it("falls back to the managed venv when no interpreter is supplied (upgrades extras)", () => {
    const result = python.ensureVenv();

    assert.deepEqual(result, { ok: true, pythonPath: managedPython });
    assert.deepEqual(calls(managedPython), ["-m pip install --upgrade sports-skills[all]"]);
    assert.equal(readFileSync(marker, "utf-8"), "sports-skills[all]");
  });

  it("falls back to the managed venv when the supplied interpreter fails the probe", () => {
    const unusable = fakePython(join(root, "system", "python3"), 1);

    const result = python.ensureVenv(unusable);

    assert.deepEqual(result, { ok: true, pythonPath: managedPython });
    assert.equal(calls(unusable).length, 1);
    // Marker already matches, so no further pip calls on the managed venv.
    assert.equal(calls(managedPython).length, 1);
  });

  it("falls back to the managed venv when the supplied interpreter does not exist", () => {
    const result = python.ensureVenv(join(root, "missing", "python3"));

    assert.deepEqual(result, { ok: true, pythonPath: managedPython });
    assert.equal(calls(managedPython).length, 1);
  });
});
