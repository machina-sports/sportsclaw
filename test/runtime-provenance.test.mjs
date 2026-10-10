import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { findBestPython } from "../dist/python.js";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const PKG_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const OPENAI_SECRET = "sk-test-SECRET-provenance-123";
const MCP_SECRET = "mcp-SECRET-provenance-456";
const STDERR_CANARY = "STDERR-CANARY";

// The fake sports_skills reports whether the probe leaked parent secrets into
// its env — the real bridge sandbox (buildSubprocessEnv) strips them.
const HEALTHY_INIT = [
  "import os",
  '_leaked = any(k in os.environ for k in ("OPENAI_API_KEY", "SPORTSCLAW_MCP_TOKEN_MOCKPOD"))',
  '__version__ = "9.9.9+leaked" if _leaked else "9.9.9+sandboxed"',
  "",
].join("\n");

const BROKEN_INIT = [
  "import sys",
  `sys.stderr.write("${STDERR_CANARY} " * 2000)`,
  'raise ImportError("sports_skills fixture: broken install")',
  "",
].join("\n");

// Real interpreter (>=3.10) wrapped so the configured path differs from sys.executable.
const best = findBestPython();
const realPython = best
  ? execFileSync(best.path, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim()
  : null;

function makeFixture(init) {
  const root = mkdtempSync(join(tmpdir(), "sportsclaw-provenance-"));
  const home = join(root, "home");
  const pkgDir = join(root, "pylib", "sports_skills");
  mkdirSync(home);
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(join(root, "bin"));
  writeFileSync(join(pkgDir, "__init__.py"), init);
  const wrapper = join(root, "bin", "python-wrapper");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${realPython}" "$@"\n`, { mode: 0o755 });
  return { root, home, pythonPath: join(root, "pylib"), pkgInit: join(pkgDir, "__init__.py"), wrapper };
}

// Counts every request so tests can prove whether MCP was contacted.
let mcpServer;
let mcpRequests = 0;
let mcpUrl;
before(async () => {
  mcpServer = createServer((_req, res) => {
    mcpRequests++;
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => mcpServer.listen(0, "127.0.0.1", resolve));
  mcpUrl = `http://127.0.0.1:${mcpServer.address().port}/mcp`;
});
after(() => new Promise((resolve) => mcpServer.close(resolve)));

async function runCli(fixture, args, pythonPath = fixture.wrapper) {
  const env = {
    HOME: fixture.home,
    PATH: "/usr/bin:/bin",
    PYTHON_PATH: pythonPath,
    PYTHONPATH: fixture.pythonPath,
    SPORTSCLAW_PROVIDER: "openai",
    OPENAI_API_KEY: OPENAI_SECRET,
    SPORTSCLAW_MCP_SERVERS: JSON.stringify({ mockpod: { url: mcpUrl } }),
    SPORTSCLAW_MCP_TOKEN_MOCKPOD: MCP_SECRET,
  };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: fixture.root,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    return { stdout, stderr };
  } catch (err) {
    if (err.killed) throw err;
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function assertNoSecrets(output) {
  assert.ok(!output.includes(OPENAI_SECRET), "provider key leaked");
  assert.ok(!output.includes(MCP_SECRET), "MCP token leaked");
}

describe("sportsclaw health --local --json", { skip: !realPython && "no python >= 3.10" }, () => {
  for (const output of ["null", "42", "[]"]) {
    it(`reports a bounded failure for non-object probe JSON: ${output}`, async () => {
      const fixture = makeFixture(`${HEALTHY_INIT}\nimport atexit\natexit.register(lambda: print(${JSON.stringify(output)}))\n`);
      try {
        const { stdout, stderr } = await runCli(fixture, ["health", "--local", "--json"]);
        const { runtime } = JSON.parse(stdout);
        assert.equal(runtime.probe.ok, false);
        assert.equal(runtime.probe.error, "Probe returned unparseable output");
        assertNoSecrets(stdout + stderr);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }

  it("skips MCP probes and reports them as not checked", async () => {
    const fixture = makeFixture(HEALTHY_INIT);
    try {
      const before = mcpRequests;
      const { stdout, stderr } = await runCli(fixture, ["health", "--local", "--json"]);
      const payload = JSON.parse(stdout);

      assert.equal(mcpRequests - before, 0, "configured MCP server was contacted in --local mode");
      assert.equal(typeof payload.mcpSkipped?.reason, "string");
      assert.ok(payload.mcpSkipped.reason.length > 0);
      for (const entry of payload.mcp ?? []) {
        assert.notEqual(entry.connected, true, "unchecked MCP must not be reported healthy");
      }
      assertNoSecrets(stdout + stderr);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("reports runtime provenance from the sandboxed bridge environment", async () => {
    const fixture = makeFixture(HEALTHY_INIT);
    try {
      const { stdout, stderr } = await runCli(fixture, ["health", "--local", "--json"]);
      const { runtime } = JSON.parse(stdout);

      assert.ok(runtime, "payload.runtime missing");
      assert.equal(runtime.nodeExecutable, process.execPath);
      assert.equal(realpathSync(runtime.cliEntrypoint), realpathSync(CLI));
      assert.equal(runtime.engineVersion, PKG_VERSION);
      assert.equal(runtime.pythonPath, fixture.wrapper);
      assert.equal(realpathSync(runtime.pythonExecutable), realpathSync(realPython));
      assert.equal(realpathSync(runtime.sportsSkillsFile), realpathSync(fixture.pkgInit));
      assert.equal(runtime.sportsSkillsVersion, "9.9.9+sandboxed");
      assert.equal(runtime.probe?.ok, true);
      assertNoSecrets(stdout + stderr);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("reports a bounded probe failure for a broken install without raw stderr", async () => {
    const fixture = makeFixture(BROKEN_INIT);
    try {
      const { stdout, stderr } = await runCli(fixture, ["health", "--local", "--json"]);
      const { runtime } = JSON.parse(stdout);

      assert.equal(runtime?.probe?.ok, false);
      assert.equal(typeof runtime.probe.error, "string");
      assert.ok(runtime.probe.error.length <= 500, "probe error is unbounded");
      assert.equal(runtime.sportsSkillsVersion ?? null, null);
      assert.equal(runtime.pythonPath, fixture.wrapper);
      assert.ok(!(stdout + stderr).includes(STDERR_CANARY), "raw Python stderr leaked");
      assertNoSecrets(stdout + stderr);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("reports a bounded probe failure when the interpreter is missing", async () => {
    const fixture = makeFixture(HEALTHY_INIT);
    try {
      const missing = join(fixture.root, "missing-python");
      const { stdout, stderr } = await runCli(fixture, ["health", "--local", "--json"], missing);
      const { runtime } = JSON.parse(stdout);

      assert.equal(runtime?.probe?.ok, false);
      assert.ok(runtime.probe.error.length <= 500, "probe error is unbounded");
      assert.equal(runtime.pythonPath, missing);
      assertNoSecrets(stdout + stderr);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describe("sportsclaw health --json (normal mode preserved)", { skip: !realPython && "no python >= 3.10" }, () => {
  it("still probes configured MCP servers", async () => {
    const fixture = makeFixture(HEALTHY_INIT);
    try {
      const before = mcpRequests;
      const { stdout, stderr } = await runCli(fixture, ["health", "--json"]);
      const payload = JSON.parse(stdout);

      assert.ok(mcpRequests - before > 0, "normal health no longer probes MCP");
      const pod = payload.mcp.find((m) => m.name === "mockpod");
      assert.equal(typeof pod?.connected, "boolean");
      assertNoSecrets(stdout + stderr);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describe("sportsclaw doctor", { skip: !realPython && "no python >= 3.10" }, () => {
  it("probes sports-skills in the bridge sandbox, not the inherited env", async () => {
    const fixture = makeFixture(HEALTHY_INIT);
    try {
      const { stdout, stderr } = await runCli(fixture, ["doctor"]);
      assert.match(stdout, /sports-skills 9\.9\.9\+sandboxed/);
      assert.doesNotMatch(stdout, /9\.9\.9\+leaked/);
      assertNoSecrets(stdout + stderr);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
