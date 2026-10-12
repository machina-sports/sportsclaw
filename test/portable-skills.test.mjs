// Portable skill runtime: two generic tools, offered only when skill guides are
// configured, that read a skill's own reference files and run operator-approved
// Python helpers. Approval lives outside the skill, in
// SPORTSCLAW_SKILL_SCRIPT_ALLOWLIST ([{ skill, script, sha256 }]).
//
// All skills and helpers are synthetic and generated per test. Helpers run as
// real python3 subprocesses; nothing touches the network or a model provider.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// analytics.ts resolves its log dir from homedir() at import time.
const isolatedHome = mkdtempSync(join(tmpdir(), "portable-skills-home-"));
process.env.HOME = isolatedHome;
const { ToolRegistry } = await import("../dist/tools.js");
const { loadSkillGuides } = await import("../dist/skill-guides.js");
const { buildSystemPrompt } = await import("../dist/prompts/system.js");

const READ = "skill_read_reference";
const RUN = "skill_run_script";
const ENV_KEYS = [
  "SPORTSCLAW_SKILL_GUIDES_DIR",
  "SPORTSCLAW_SKILL_SCRIPT_ALLOWLIST",
  "SPORTS_SKILLS_REPLAY",
  "SPORTSCLAW_TEST_SECRET",
  "ANTHROPIC_API_KEY",
  "PYTHONPATH",
];

let work;
let root;
let demo;
let savedEnv;

function write(path, content) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function approve(entries) {
  process.env.SPORTSCLAW_SKILL_SCRIPT_ALLOWLIST = JSON.stringify(entries);
}

function approveScript(skill, script) {
  return { skill, script, sha256: sha256(join(root, skill, script)) };
}

async function call(tool, input, config) {
  const result = await new ToolRegistry().dispatchToolCall(tool, input, config);
  let body;
  try {
    body = JSON.parse(result.content);
  } catch {
    body = { raw: result.content };
  }
  return { result, body };
}

function assertError(outcome, code) {
  assert.equal(outcome.result.isError, true, `expected isError for ${code}: ${outcome.result.content.slice(0, 300)}`);
  assert.equal(outcome.body.error_code, code, outcome.result.content.slice(0, 300));
}

function buildFixtures() {
  demo = join(root, "demo");
  write(
    join(demo, "SKILL.md"),
    [
      "---",
      "name: demo",
      "description: |",
      "  Synthetic portable skill used by tests.",
      "allowed-tools: Bash(python3:*)",
      "metadata:",
      "  sportsclaw:",
      "    approved: true",
      "    script_allowlist:",
      "      - script: scripts/marker.py",
      "---",
      "# Demo",
      "",
      "Read references/guide.md, then run scripts/echo_args.py.",
      "",
    ].join("\n"),
  );
  write(join(demo, "references", "guide.md"), "# Guide v1\n");
  write(join(demo, "references", "data.json"), '{"k": 1}\n');
  write(join(demo, "references", "notes.txt"), "plain notes\n");
  write(join(demo, "references", "conf.yaml"), "a: 1\n");
  write(join(demo, "references", "conf.yml"), "b: 2\n");
  write(join(demo, "references", "sub", "nested.md"), "nested ref\n");
  write(join(demo, "references", "secret.env"), "TOKEN=nope\n");
  write(join(demo, "references", "key.pem"), "-----BEGIN PRIVATE KEY-----\n");
  write(join(demo, "references", "big.md"), "x".repeat(4 * 1024 * 1024));
  write(join(demo, "references", "binary.md"), Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28]));
  write(join(work, "outside", "secret.md"), "OUTSIDE SECRET\n");
  symlinkSync(join(work, "outside", "secret.md"), join(demo, "references", "escape.md"), "file");

  write(
    join(demo, "scripts", "echo_args.py"),
    [
      "import json, os, sys",
      "print(json.dumps({",
      '  "argv": sys.argv[1:],',
      '  "file": os.path.basename(__file__),',
      '  "isolated": sys.flags.isolated,',
      '  "env": dict(os.environ),',
      "}))",
      "",
    ].join("\n"),
  );
  write(join(demo, "scripts", "marker.py"), 'import sys\nopen(sys.argv[1], "w").write("ran")\nprint("ok")\n');
  write(join(demo, "scripts", "place_order.py"), 'import sys\nopen(sys.argv[1], "w").write("ran")\n');
  write(join(demo, "scripts", "fail.py"), 'import sys\nsys.stderr.write("boom\\n")\nsys.exit(3)\n');
  write(join(demo, "scripts", "flood.py"), 'import sys\nsys.stdout.write("x" * (8 * 1024 * 1024))\n');
  write(
    join(demo, "scripts", "sleep.py"),
    'import os, sys, time\nopen(sys.argv[1], "w").write(str(os.getpid()))\ntime.sleep(30)\n',
  );
  write(join(demo, "scripts", "nested", "tool.py"), 'print("nested ok")\n');
  write(join(demo, "scripts", "run.sh"), "#!/bin/sh\necho shell\n");
  write(join(work, "outside", "evil.py"), 'print("escaped")\n');
  symlinkSync(join(work, "outside", "evil.py"), join(demo, "scripts", "link.py"), "file");

  write(join(root, "other", "SKILL.md"), "---\nname: other\ndescription: Another skill.\n---\n# Other\n");
  write(join(root, "other", "references", "x.md"), "other ref\n");
  write(join(root, "other", "scripts", "marker.py"), 'import sys\nopen(sys.argv[1], "w").write("ran")\n');
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  work = mkdtempSync(join(tmpdir(), "portable-skills-"));
  root = join(work, "skills");
  mkdirSync(root);
  buildFixtures();
  process.env.SPORTSCLAW_SKILL_GUIDES_DIR = root;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(work, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("portable skill tools — registration", () => {
  it("are not offered when SPORTSCLAW_SKILL_GUIDES_DIR is unset (default unchanged)", () => {
    delete process.env.SPORTSCLAW_SKILL_GUIDES_DIR;
    const names = new ToolRegistry().getAllToolSpecs().map((s) => s.name);
    assert.ok(!names.includes(READ));
    assert.ok(!names.includes(RUN));
  });

  it("are not offered when the configured root has no valid guides", () => {
    const empty = join(work, "empty");
    mkdirSync(empty);
    process.env.SPORTSCLAW_SKILL_GUIDES_DIR = empty;
    const names = new ToolRegistry().getAllToolSpecs().map((s) => s.name);
    assert.ok(!names.includes(READ));
    assert.ok(!names.includes(RUN));
  });

  it("are offered with strict input schemas when valid guides exist", () => {
    const specs = new ToolRegistry().getAllToolSpecs();
    const read = specs.find((s) => s.name === READ);
    const run = specs.find((s) => s.name === RUN);
    assert.ok(read, "skill_read_reference is offered");
    assert.ok(run, "skill_run_script is offered");
    assert.deepEqual([...read.input_schema.required].sort(), ["path", "skill"]);
    assert.equal(read.input_schema.additionalProperties, false);
    assert.ok([...run.input_schema.required].includes("skill"));
    assert.ok([...run.input_schema.required].includes("script"));
    assert.equal(run.input_schema.additionalProperties, false);
    assert.equal(run.input_schema.properties.args.type, "array");
  });

  it("are not reported as installed Python skills", () => {
    assert.deepEqual(new ToolRegistry().getInstalledSkills(), []);
  });

  it("dispatch fails closed when no guides are configured", async () => {
    delete process.env.SPORTSCLAW_SKILL_GUIDES_DIR;
    const out = await call(READ, { skill: "demo", path: "SKILL.md" });
    assert.equal(out.result.isError, true);
  });
});

// ---------------------------------------------------------------------------
// skill_read_reference
// ---------------------------------------------------------------------------

describe("skill_read_reference", () => {
  it("reads SKILL.md of an installed skill without any script approval", async () => {
    const out = await call(READ, { skill: "demo", path: "SKILL.md" });
    assert.ok(!out.result.isError, out.result.content);
    assert.equal(out.body.skill, "demo");
    assert.equal(out.body.path, "SKILL.md");
    assert.match(out.body.content, /# Demo/);
  });

  it("reads documented text formats under references/, including nested paths", async () => {
    const cases = {
      "references/guide.md": "# Guide v1\n",
      "references/data.json": '{"k": 1}\n',
      "references/notes.txt": "plain notes\n",
      "references/conf.yaml": "a: 1\n",
      "references/conf.yml": "b: 2\n",
      "references/sub/nested.md": "nested ref\n",
    };
    for (const [path, expected] of Object.entries(cases)) {
      const out = await call(READ, { skill: "demo", path });
      assert.ok(!out.result.isError, `${path}: ${out.result.content}`);
      assert.equal(out.body.content, expected, path);
    }
  });

  it("rejects unknown and path-like skill ids", async () => {
    for (const skill of ["nope", "../demo", "/demo", "demo/../other", ""]) {
      assertError(await call(READ, { skill, path: "SKILL.md" }), "unknown_skill");
    }
  });

  it("rejects absolute, traversal, URL, and cross-skill paths", async () => {
    for (const path of [
      join(demo, "references", "guide.md"),
      "/etc/passwd",
      "../other/references/x.md",
      "references/../../other/references/x.md",
      "references/../SKILL.md/../../other/SKILL.md",
      "https://example.com/references/x.md",
      "file:///etc/passwd",
      "references\\..\\..\\other\\SKILL.md",
      "references/guide.md\u0000.txt",
    ]) {
      assertError(await call(READ, { skill: "demo", path }), "invalid_path");
    }
  });

  it("only reads SKILL.md and references/, never scripts or other files", async () => {
    for (const path of ["scripts/echo_args.py", "scripts/run.sh", "skill.yml", "references"]) {
      const out = await call(READ, { skill: "demo", path });
      assert.equal(out.result.isError, true, path);
      assert.ok(["invalid_path", "not_found"].includes(out.body.error_code), `${path}: ${out.result.content}`);
    }
    assertError(await call(READ, { skill: "demo", path: "scripts/echo_args.py" }), "invalid_path");
  });

  it("rejects non-text extensions such as secrets and keys", async () => {
    assertError(await call(READ, { skill: "demo", path: "references/secret.env" }), "invalid_path");
    assertError(await call(READ, { skill: "demo", path: "references/key.pem" }), "invalid_path");
  });

  it("does not follow a symlink out of the skill directory", async () => {
    const out = await call(READ, { skill: "demo", path: "references/escape.md" });
    assertError(out, "invalid_path");
    assert.doesNotMatch(out.result.content, /OUTSIDE SECRET/);
  });

  it("bounds the bytes it will read", async () => {
    const out = await call(READ, { skill: "demo", path: "references/big.md" });
    assertError(out, "too_large");
    assert.ok(out.result.content.length < 64 * 1024, "oversized content is not returned");
  });

  it("refuses non-UTF-8 content", async () => {
    assertError(await call(READ, { skill: "demo", path: "references/binary.md" }), "not_text");
  });

  it("reports a missing reference as not_found", async () => {
    assertError(await call(READ, { skill: "demo", path: "references/missing.md" }), "not_found");
  });

  it("rejects unexpected input fields", async () => {
    assertError(await call(READ, { skill: "demo", path: "SKILL.md", url: "https://example.com" }), "invalid_args");
    assertError(await call(READ, { skill: "demo", path: 42 }), "invalid_args");
  });

  it("is never served from the registry cache", async () => {
    const registry = new ToolRegistry();
    const first = await registry.dispatchToolCall(READ, { skill: "demo", path: "references/guide.md" });
    assert.match(JSON.parse(first.content).content, /Guide v1/);
    writeFileSync(join(demo, "references", "guide.md"), "# Guide v2\n");
    const second = await registry.dispatchToolCall(READ, { skill: "demo", path: "references/guide.md" });
    assert.match(JSON.parse(second.content).content, /Guide v2/);
    assert.equal(registry.getCacheStats().size, 0);
  });
});

// ---------------------------------------------------------------------------
// skill_run_script — approval policy
// ---------------------------------------------------------------------------

describe("skill_run_script — approval policy", () => {
  function markerRun(marker = join(work, "marker")) {
    return { input: { skill: "demo", script: "scripts/marker.py", args: [marker] }, marker };
  }

  it("runs an approved helper whose hash matches", async () => {
    approve([approveScript("demo", "scripts/marker.py")]);
    const { input, marker } = markerRun();
    const out = await call(RUN, input);
    assert.ok(!out.result.isError, out.result.content);
    assert.equal(out.body.exit_code, 0);
    assert.equal(out.body.stdout.trim(), "ok");
    assert.ok(existsSync(marker));
  });

  it("runs an approved helper nested under scripts/", async () => {
    approve([approveScript("demo", "scripts/nested/tool.py")]);
    const out = await call(RUN, { skill: "demo", script: "scripts/nested/tool.py", args: [] });
    assert.ok(!out.result.isError, out.result.content);
    assert.equal(out.body.stdout.trim(), "nested ok");
  });

  const denials = {
    "no policy configured": () => {},
    "policy is not JSON": () => {
      process.env.SPORTSCLAW_SKILL_SCRIPT_ALLOWLIST = "{not json";
    },
    "policy is not an array": () => {
      process.env.SPORTSCLAW_SKILL_SCRIPT_ALLOWLIST = JSON.stringify(approveScript("demo", "scripts/marker.py"));
    },
    "entry is missing sha256": () => approve([{ skill: "demo", script: "scripts/marker.py" }]),
    "sha256 is not 64 hex chars": () => approve([{ skill: "demo", script: "scripts/marker.py", sha256: "abc123" }]),
    "entry has extra fields": () =>
      approve([{ ...approveScript("demo", "scripts/marker.py"), interpreter: "/bin/sh" }]),
    "one malformed entry poisons the whole policy": () =>
      approve([approveScript("demo", "scripts/marker.py"), { skill: "demo" }]),
    "duplicate entries": () =>
      approve([approveScript("demo", "scripts/marker.py"), approveScript("demo", "scripts/marker.py")]),
    "hash does not match the file": () =>
      approve([{ skill: "demo", script: "scripts/marker.py", sha256: sha256(join(demo, "scripts", "fail.py")) }]),
    "approval is for a different skill": () => approve([approveScript("other", "scripts/marker.py")]),
    "approval is for a different script": () => approve([approveScript("demo", "scripts/echo_args.py")]),
  };

  for (const [label, setup] of Object.entries(denials)) {
    it(`denies without spawning when ${label}`, async () => {
      setup();
      const { input, marker } = markerRun();
      const out = await call(RUN, input);
      assertError(out, "not_approved");
      assert.ok(!existsSync(marker), "helper must not run");
    });
  }

  it("ignores skill metadata, yoloMode, and model-supplied approval claims", async () => {
    const { marker } = markerRun();
    const out = await call(
      RUN,
      { skill: "demo", script: "scripts/marker.py", args: [marker] },
      { yoloMode: true },
    );
    assertError(out, "not_approved");
    assert.ok(!existsSync(marker));
  });

  it("refusals are actionable and name only approved helpers of that skill", async () => {
    approve([approveScript("demo", "scripts/echo_args.py"), approveScript("other", "scripts/marker.py")]);
    const out = await call(RUN, markerRun().input);
    assertError(out, "not_approved");
    assert.match(out.body.hint, /SPORTSCLAW_SKILL_SCRIPT_ALLOWLIST/);
    assert.deepEqual(out.body.approved_scripts, ["scripts/echo_args.py"]);
  });

  it("re-checks the hash on every call: an edited helper is denied, not served from cache", async () => {
    approve([approveScript("demo", "scripts/marker.py")]);
    const registry = new ToolRegistry();
    const { input, marker } = markerRun();
    const first = await registry.dispatchToolCall(RUN, input);
    assert.ok(!first.isError, first.content);
    assert.ok(existsSync(marker));
    rmSync(marker);

    appendFileSync(join(demo, "scripts", "marker.py"), "# tampered\n");
    const second = await registry.dispatchToolCall(RUN, input);
    assert.equal(second.isError, true);
    assert.equal(JSON.parse(second.content).error_code, "not_approved");
    assert.ok(!existsSync(marker), "tampered helper must not run");
    assert.equal(registry.getCacheStats().size, 0);
  });

  it("re-reads the policy on every call", async () => {
    approve([approveScript("demo", "scripts/marker.py")]);
    const registry = new ToolRegistry();
    const { input, marker } = markerRun();
    assert.ok(!(await registry.dispatchToolCall(RUN, input)).isError);
    rmSync(marker);
    delete process.env.SPORTSCLAW_SKILL_SCRIPT_ALLOWLIST;
    const second = await registry.dispatchToolCall(RUN, input);
    assert.equal(JSON.parse(second.content).error_code, "not_approved");
    assert.ok(!existsSync(marker));
  });
});

// ---------------------------------------------------------------------------
// skill_run_script — input validation
// ---------------------------------------------------------------------------

describe("skill_run_script — input validation", () => {
  beforeEach(() => {
    approve([
      approveScript("demo", "scripts/echo_args.py"),
      approveScript("demo", "scripts/marker.py"),
      { skill: "demo", script: "scripts/link.py", sha256: sha256(join(work, "outside", "evil.py")) },
    ]);
  });

  it("rejects script paths outside scripts/*.py of the skill", async () => {
    for (const script of [
      "scripts/run.sh",
      "references/guide.md",
      "SKILL.md",
      "../other/scripts/marker.py",
      "scripts/../../other/scripts/marker.py",
      join(demo, "scripts", "echo_args.py"),
      "/usr/bin/python3",
      "scripts/echo_args.py\u0000",
    ]) {
      assertError(await call(RUN, { skill: "demo", script, args: [] }), "invalid_path");
    }
  });

  it("rejects a symlinked helper even when its target hash is approved", async () => {
    const out = await call(RUN, { skill: "demo", script: "scripts/link.py", args: [] });
    assertError(out, "invalid_path");
    assert.doesNotMatch(out.result.content, /escaped/);
  });

  it("rejects unknown skills", async () => {
    assertError(await call(RUN, { skill: "nope", script: "scripts/marker.py", args: [] }), "unknown_skill");
  });

  it("rejects model-supplied executable, env, cwd, or shell fields", async () => {
    const marker = join(work, "marker");
    for (const extra of [
      { python: "/bin/sh" },
      { interpreter: "/bin/sh" },
      { env: { PYTHONPATH: work } },
      { cwd: "/" },
      { shell: true },
      { code: "print(1)" },
    ]) {
      const out = await call(RUN, { skill: "demo", script: "scripts/marker.py", args: [marker], ...extra });
      assertError(out, "invalid_args");
    }
    assert.ok(!existsSync(marker));
  });

  it("rejects non-string, oversized, too many, NUL, and control-character args", async () => {
    for (const args of [
      "not-an-array",
      [1],
      [{ a: 1 }],
      ["a\u0000b"],
      ["a\u001b[31m"],
      ["x".repeat(64 * 1024)],
      Array.from({ length: 1000 }, () => "a"),
    ]) {
      assertError(await call(RUN, { skill: "demo", script: "scripts/echo_args.py", args }), "invalid_args");
    }
  });

  it("keeps the trading guard: approval does not unblock trading helpers or operations", async () => {
    approve([approveScript("demo", "scripts/place_order.py"), approveScript("demo", "scripts/marker.py")]);
    const marker = join(work, "marker");
    assertError(await call(RUN, { skill: "demo", script: "scripts/place_order.py", args: [marker] }), "blocked_tool");
    assertError(await call(RUN, { skill: "demo", script: "scripts/marker.py", args: [marker, "withdraw"] }), "blocked_tool");
    assertError(await call(RUN, { skill: "demo", script: "scripts/marker.py", args: [marker, "--place-order"] }), "blocked_tool");
    assert.ok(!existsSync(marker), "blocked helpers must not run");
    const allowed = await call(RUN, { skill: "demo", script: "scripts/place_order.py", args: [marker] }, { allowTrading: true });
    assert.ok(!allowed.result.isError, allowed.result.content);
    assert.ok(existsSync(marker));
  });

  it("passes shell metacharacters through as literal argv without a shell", async () => {
    const marker = join(work, "SHELL_RAN");
    const args = [`; touch ${marker}`, `$(touch ${marker})`, `\`touch ${marker}\``, `| touch ${marker}`, "&&", "*"];
    const out = await call(RUN, { skill: "demo", script: "scripts/echo_args.py", args });
    assert.ok(!out.result.isError, out.result.content);
    const echoed = JSON.parse(out.body.stdout);
    assert.deepEqual(echoed.argv, args);
    assert.equal(echoed.file, "echo_args.py", "__file__ is preserved");
    assert.ok(!existsSync(marker), "no shell interpreted the args");
  });
});

// ---------------------------------------------------------------------------
// skill_run_script — execution environment and limits
// ---------------------------------------------------------------------------

describe("skill_run_script — execution", () => {
  it("runs Python in isolated mode with a minimal environment", async () => {
    approve([approveScript("demo", "scripts/echo_args.py")]);
    process.env.SPORTSCLAW_TEST_SECRET = "s3cr3t-value-for-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-real";
    process.env.PYTHONPATH = join(work, "evil-pythonpath");
    process.env.SPORTS_SKILLS_REPLAY = "off";
    const out = await call(RUN, { skill: "demo", script: "scripts/echo_args.py", args: [] });
    assert.ok(!out.result.isError, out.result.content);
    const echoed = JSON.parse(out.body.stdout);
    assert.equal(echoed.isolated, 1, "python -I");
    for (const key of [
      "SPORTSCLAW_TEST_SECRET",
      "ANTHROPIC_API_KEY",
      "PYTHONPATH",
      "HOME",
      "SPORTSCLAW_SKILL_SCRIPT_ALLOWLIST",
      "SPORTSCLAW_SKILL_GUIDES_DIR",
    ]) {
      assert.ok(!(key in echoed.env), `${key} must not reach the helper`);
    }
    assert.ok("PATH" in echoed.env);
    assert.equal(echoed.env.SPORTS_SKILLS_REPLAY, "off");
    assert.doesNotMatch(out.result.content, /s3cr3t-value-for-test|sk-ant-test-not-real/);
  });

  for (const mode of ["replay", "record", "RECORD"]) {
    it(`refuses to spawn when SPORTS_SKILLS_REPLAY=${mode}`, async () => {
      approve([approveScript("demo", "scripts/marker.py")]);
      process.env.SPORTS_SKILLS_REPLAY = mode;
      const marker = join(work, "marker");
      const out = await call(RUN, { skill: "demo", script: "scripts/marker.py", args: [marker] });
      assertError(out, "replay_blocked");
      assert.ok(!existsSync(marker));
    });
  }

  it("reports a nonzero exit with bounded stderr", async () => {
    approve([approveScript("demo", "scripts/fail.py")]);
    const out = await call(RUN, { skill: "demo", script: "scripts/fail.py", args: [] });
    assertError(out, "script_failed");
    assert.equal(out.body.exit_code, 3);
    assert.match(out.body.stderr, /boom/);
  });

  it("stops and reports oversized output", async () => {
    approve([approveScript("demo", "scripts/flood.py")]);
    const out = await call(RUN, { skill: "demo", script: "scripts/flood.py", args: [] });
    assertError(out, "output_limit");
    assert.ok(out.result.content.length < 1024 * 1024, "result content stays bounded");
  });

  for (const ending of ["timeout", "success", "output_limit"]) {
    it(`cleans up helper child processes after ${ending}`, { skip: process.platform === "win32" }, async () => {
      const runtime = await import("../dist/skill-runtime.js");
      writeFileSync(join(root, "demo/scripts/children.py"),
        `import subprocess, sys, time\np = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(20)'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\nopen(sys.argv[1], 'w').write(str(p.pid))\n` +
        (ending === "timeout" ? "time.sleep(20)\n" : ending === "output_limit" ? "print('x' * 300000)\n" : "print('ok')\n"));
      approve([approveScript("demo", "scripts/children.py")]);
      const pidFile = join(work, "descendant-pid");
      let pid;
      try {
        const result = await runtime.runSkillScript(loadSkillGuides(),
          { skill: "demo", script: "scripts/children.py", args: [pidFile] }, undefined, { timeoutMs: 500 });
        pid = Number(readFileSync(pidFile, "utf8"));
        if (ending !== "success") assert.equal(JSON.parse(result.content).error_code, ending);
        else assert.ok(!result.isError, result.content);
        let alive = true;
        for (let i = 0; i < 40 && alive; i++) {
          try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 25)); }
          catch { alive = false; }
        }
        assert.equal(alive, false, "helper child process must not survive completion");
      } finally {
        if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
      }
    });
  }

  it("refuses helper execution on platforms without process-group cleanup", async () => {
    approve([approveScript("demo", "scripts/marker.py")]);
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    const marker = join(work, "unsupported-marker");
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      assertError(await call(RUN, { skill: "demo", script: "scripts/marker.py", args: [marker] }), "unsupported_platform");
      assert.ok(!existsSync(marker));
    } finally { Object.defineProperty(process, "platform", descriptor); }
  });

  it("defaults to a 30s timeout", async () => {
    const runtime = await import("../dist/skill-runtime.js").catch(() => ({}));
    assert.equal(runtime.SKILL_SCRIPT_TIMEOUT_MS, 30_000);
  });

  it("hard-kills a helper that exceeds the timeout", async () => {
    const runtime = await import("../dist/skill-runtime.js").catch(() => ({}));
    assert.equal(typeof runtime.runSkillScript, "function", "skill-runtime exports runSkillScript");
    approve([approveScript("demo", "scripts/sleep.py")]);
    const pidFile = join(work, "pid");
    const started = Date.now();
    const result = await runtime.runSkillScript(
      loadSkillGuides(),
      { skill: "demo", script: "scripts/sleep.py", args: [pidFile] },
      undefined,
      { timeoutMs: 500 },
    );
    assert.ok(Date.now() - started < 10_000, "returned promptly");
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content).error_code, "timeout");
    const pid = Number(readFileSync(pidFile, "utf8"));
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, "helper process was killed");
  });
});

// ---------------------------------------------------------------------------
// Prompt and engine integration
// ---------------------------------------------------------------------------

function promptContext(overrides = {}) {
  return {
    packageVersion: "test",
    provider: "anthropic",
    modelId: "test",
    routingMaxSkills: 2,
    routingAllowSpillover: 0,
    allowTrading: false,
    skipFanProfile: true,
    installedSports: [],
    availableSports: [],
    toolSpecs: [],
    mcpManager: {
      getServerDescriptions: () => new Map(),
      getPodCapabilities: () => new Map(),
      getMachinaLoopServer: () => undefined,
      getMachinaServerName: () => undefined,
    },
    discordConfigured: false,
    discordPrefix: "!",
    hasMemory: false,
    diskSkillGuides: [],
    userPrompt: "use the demo skill",
    selectedSkills: [],
    ...overrides,
  };
}

describe("portable skill tools — prompt", () => {
  it("explains how to read references and run helpers when the tools are offered", () => {
    const guides = loadSkillGuides();
    const toolSpecs = new ToolRegistry().getAllToolSpecs();
    const prompt = buildSystemPrompt(promptContext({ diskSkillGuides: guides, toolSpecs }));
    assert.match(prompt, /skill_read_reference/);
    assert.match(prompt, /skill_run_script/);
    assert.match(prompt, /\bdemo\b/);
    assert.match(prompt, /untrusted/i);
  });

  it("is unchanged for existing guides when the tools are not offered", () => {
    const legacy = [{ id: "legacy", name: "Legacy", description: "old", body: "LEGACY BODY" }];
    const prompt = buildSystemPrompt(promptContext({ diskSkillGuides: legacy }));
    assert.match(prompt, /LEGACY BODY/);
    assert.doesNotMatch(prompt, /skill_read_reference|skill_run_script/);
  });
});

const engineUrl = new URL("../dist/engine.js", import.meta.url).href;
const aiTestUrl = import.meta.resolve("ai/test");

function runEngine({ guidesDir, allowlist }) {
  const home = mkdtempSync(join(tmpdir(), "portable-skills-engine-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && !/^(SPORTSCLAW|MACHINA)_/i.test(key),
    ),
  );
  env.HOME = home;
  env.SPORTSCLAW_MEMORY_BACKEND = "file";
  if (guidesDir) env.SPORTSCLAW_SKILL_GUIDES_DIR = guidesDir;
  const code = `
    globalThis.AI_SDK_LOG_WARNINGS = false;
    const { MockLanguageModelV3 } = await import(${JSON.stringify(aiTestUrl)});
    const { sportsclawEngine } = await import(${JSON.stringify(engineUrl)});
    const model = new MockLanguageModelV3({ doGenerate: async () => ({
      content: [{ type: "text", text: "done" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: { inputTokens: { total: 1, noCache: 1 }, outputTokens: { total: 1, text: 1 } },
      warnings: [],
    })});
    const engine = new sportsclawEngine({ clarifyOnLowConfidence: false, thinkingBudget: 0, verbose: false, skipFanProfile: true });
    engine.mainModel = model;
    const all = engine.listToolNames();
    engine.setToolAllowlist(${JSON.stringify(allowlist ?? null)});
    await engine.run("use the demo skill");
    const calls = model.doGenerateCalls;
    const offered = calls.map((c) => (c.tools ?? []).map((t) => t.name).sort()).filter((n) => n.length > 0);
    const system = JSON.stringify(calls.at(-1)?.prompt ?? []);
    console.log(JSON.stringify({ all, offered, mentionsRun: system.includes("skill_run_script") }));
  `;
  try {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    return JSON.parse(output.trim().split("\n").at(-1));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("portable skill tools — engine", () => {
  it("are absent from a default engine", () => {
    const out = runEngine({});
    assert.ok(!out.all.includes(READ));
    assert.ok(!out.all.includes(RUN));
  });

  it("are offered by an engine with configured guides", () => {
    const out = runEngine({ guidesDir: root });
    assert.ok(out.all.includes(READ));
    assert.ok(out.all.includes(RUN));
    assert.ok(out.offered.some((names) => names.includes(RUN)));
    assert.equal(out.mentionsRun, true);
  });

  it("respect the tool allowlist", () => {
    const out = runEngine({ guidesDir: root, allowlist: [READ] });
    assert.ok(out.offered.length > 0);
    for (const names of out.offered) assert.deepEqual(names, [READ]);
    assert.equal(out.mentionsRun, false, "prompt does not advertise a tool that is not offered");
  });
});
