// SPORTSCLAW_VENV_DIR names a Python environment that already has sports-skills
// (the OpenShell image's /opt/venv). SportsClaw uses it as is: it never creates
// a venv or runs pip there, because a sandbox's policy blocks PyPI.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { ensureVenv, getVenvDir, getVenvPythonPath } from "../dist/python.js";

const saved = process.env.SPORTSCLAW_VENV_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.SPORTSCLAW_VENV_DIR;
  else process.env.SPORTSCLAW_VENV_DIR = saved;
});

/** A fake venv whose python3 logs every call, so a pip run would show up. */
function fakeVenv() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sc-venv-")));
  fs.mkdirSync(path.join(dir, "bin"));
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(path.join(dir, "bin", "python3"), `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`, { mode: 0o755 });
  return { dir, log };
}

describe("a provided venv (SPORTSCLAW_VENV_DIR)", () => {
  it("is the venv SportsClaw uses", () => {
    const { dir } = fakeVenv();
    process.env.SPORTSCLAW_VENV_DIR = dir;
    assert.equal(getVenvDir(), dir);
    assert.equal(getVenvPythonPath(), path.join(dir, "bin", "python3"));
  });

  it("is used as is: no venv is created and pip never runs", () => {
    const { dir, log } = fakeVenv();
    process.env.SPORTSCLAW_VENV_DIR = dir;
    const r = ensureVenv("/nonexistent/python3");
    assert.deepEqual(r, { ok: true, pythonPath: path.join(dir, "bin", "python3") });
    assert.ok(!fs.existsSync(log), "python was run in the provided venv: " + (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : ""));
  });

  it("fails clearly when the named venv has no python3", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-venv-empty-"));
    process.env.SPORTSCLAW_VENV_DIR = dir;
    const r = ensureVenv();
    assert.equal(r.ok, false);
    assert.match(r.error, /SPORTSCLAW_VENV_DIR/);
  });

  it("the OpenShell image points SportsClaw at its own /opt/venv", () => {
    const dockerfile = readFileSync(new URL("../openshell/Dockerfile", import.meta.url), "utf8");
    assert.match(dockerfile, /^ENV SPORTSCLAW_VENV_DIR=\/opt\/venv$/m);
  });
});
