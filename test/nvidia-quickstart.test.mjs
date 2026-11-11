/**
 * `sportsclaw quickstart` — offline hosted-model launch bundle.
 *
 * Drives the real CLI with an isolated HOME. Generated scripts run against
 * inert stub binaries (docker / sportsclaw / openshell) that only record their
 * argv and env; nothing here starts a container, a sandbox, an SSH session or
 * claims GPU inference. The --once fixture talks to an in-process fake
 * OpenAI-compatible server.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { buildJobObject, buildOpenShellCommands } from "../dist/openshell-cli.js";
import { validateOperatorJobConfig } from "../dist/operator-config.js";
import { buildQuickstartBundle, buildQuickstartJob, parseQuickstartArgs } from "../dist/quickstart.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "dist", "index.js");
const GUIDE = path.join(ROOT, "quickstart", "hosted-models", "SKILL.md");
const SECRET = "s3cr3t-marker";

const tmpRoots = [];
function tmp(prefix = "sc-qs-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpRoots.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

function quickstart(args, { home = tmp("sc-qs-home-"), cwd = tmp("sc-qs-cwd-"), env = {} } = {}) {
  const res = spawnSync(process.execPath, [CLI, "quickstart", ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, ...env },
  });
  return { ...res, home, cwd };
}

function listTree(dir) {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      out.push(entry.isDirectory() ? `${child}/` : child);
      if (entry.isDirectory()) walk(child);
    }
  };
  walk("");
  return out.sort();
}

function mode(p) {
  return fs.statSync(p).mode & 0o777;
}

function generate(args) {
  const parent = tmp("sc-qs-out-");
  const out = path.join(parent, "bundle");
  const res = quickstart([...args, "--out", out]);
  assert.equal(res.status, 0, res.stderr);
  return { out, res };
}

/**
 * Write an inert stub that records argv (one per line) and optionally env.
 * `failOn` ("<arg1> <arg2>") makes that call exit 1 after being recorded.
 */
function stub(binDir, name, { recordEnv = false, stdout = "", failOn = "" } = {}) {
  const log = path.join(binDir, `${name}.calls`);
  const lines = [
    "#!/usr/bin/env bash",
    `printf '%s\\n' "---" "$@" >> '${log}'`,
    recordEnv ? `env > '${log}.env'` : "",
    stdout ? `if [ "\${1:-}" = "--version" ]; then echo "${stdout}"; fi` : "",
    failOn ? `if [ "\${1:-} \${2:-}" = '${failOn}' ]; then echo "stub: ${failOn} failed" >&2; exit 1; fi` : "",
    "exit 0",
    "",
  ];
  fs.writeFileSync(path.join(binDir, name), lines.join("\n"), { mode: 0o755 });
  return log;
}

function calls(log) {
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, "utf8")
    .split("---\n")
    .filter(Boolean)
    .map((c) => c.replace(/\n$/, "").split("\n"));
}

function bash(script, { env = {}, args = [], cwd = tmp("sc-qs-run-") } = {}) {
  return spawnSync("bash", [script, ...args], { cwd, encoding: "utf8", env });
}

const readJob = (out) =>
  JSON.parse(fs.readFileSync(path.join(out, ".sportsclaw", "operator", "quickstart.json"), "utf8"));

const guideBody = () => fs.readFileSync(GUIDE, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();

// ---------------------------------------------------------------------------
// Help + argument validation: nothing is written, nothing is read
// ---------------------------------------------------------------------------

describe("quickstart CLI arguments", () => {
  it("--help prints usage and writes nothing", () => {
    const res = quickstart(["--help"]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /sportsclaw quickstart/);
    assert.match(res.stdout, /--host brev\|nim/);
    assert.match(res.stdout, /--openshell/);
    assert.deepEqual(fs.readdirSync(res.home), []);
    assert.deepEqual(fs.readdirSync(res.cwd), []);
  });

  it("is listed in global help", () => {
    const res = spawnSync(process.execPath, [CLI, "--help"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: tmp() },
    });
    assert.match(res.stdout, /sportsclaw quickstart/);
  });

  const invalid = [
    ["missing --model", ["--host", "brev", "--out", "x"]],
    ["missing --host", ["--model", "org/m", "--out", "x"]],
    ["missing --out", ["--host", "brev", "--model", "org/m"]],
    ["unknown host", ["--host", "aws", "--model", "org/m", "--out", "x"]],
    ["unknown flag", ["--host", "brev", "--model", "org/m", "--out", "x", "--yolo"]],
    ["duplicate flag", ["--host", "brev", "--model", "org/a", "--model", "org/b", "--out", "x"]],
    ["duplicate boolean", ["--host", "nim", "--model", "m", "--out", "x", "--openshell", "--openshell", "--image", "r/i:t"]],
    ["missing value", ["--host", "brev", "--model", "--out", "x"]],
    ["empty value", ["--host", "brev", "--model", "", "--out", "x"]],
    ["control char in model", ["--host", "brev", "--model", "org/m\u0007", "--out", "x"]],
    ["control char in out", ["--host", "brev", "--model", "org/m", "--out", "x\ny"]],
    ["shell metachar in model", ["--host", "brev", "--model", "org/m;id", "--out", "x"]],
    ["nim custom endpoint", ["--host", "nim", "--model", "m", "--out", "x", "--endpoint", "https://other.example/v1"]],
    ["nim served-model", ["--host", "nim", "--model", "m", "--out", "x", "--served-model", "a"]],
    ["nim tool-parser", ["--host", "nim", "--model", "m", "--out", "x", "--tool-parser", "hermes"]],
    ["nim revision", ["--host", "nim", "--model", "m", "--out", "x", "--revision", "main"]],
    ["openshell without image", ["--host", "nim", "--model", "m", "--out", "x", "--openshell"]],
    ["image without openshell", ["--host", "nim", "--model", "m", "--out", "x", "--image", "r/i:t"]],
    ["brev openshell without endpoint", ["--host", "brev", "--model", "org/m", "--out", "x", "--openshell", "--image", "r/i:t"]],
    ["bad tool parser", ["--host", "brev", "--model", "org/m", "--out", "x", "--tool-parser", "a b"]],
  ];
  for (const [name, args] of invalid) {
    it(`rejects ${name} before writing`, () => {
      const res = quickstart(args);
      assert.equal(res.status, 2, `${name}: ${res.stdout}${res.stderr}`);
      assert.match(res.stderr, /quickstart/);
      assert.deepEqual(fs.readdirSync(res.cwd), [], `${name} wrote into cwd`);
      assert.deepEqual(fs.readdirSync(res.home), [], `${name} wrote into HOME`);
    });
  }

  const badEndpoints = [
    [false, `https://user:${SECRET}@gpu.example.com/v1`],
    [false, `https://gpu.example.com/v1?key=${SECRET}`],
    [false, `https://gpu.example.com/v1#${SECRET}`],
    [false, `https://*.${SECRET}.example.com/v1`],
    [false, `https://gpu.example.com/%2a/${SECRET}`],
    [false, `https://gpu.example.com/v1/*/${SECRET}`],
    [false, `https://gpu.example.com/v1/../${SECRET}`],
    [false, `http://${SECRET}.example.com/v1`],
    [false, `ftp://${SECRET}.example.com/v1`],
    [false, `https://gpu.example.com/v1\\${SECRET}`],
    [false, `https://gpu.example.com/v1 ${SECRET}`],
    // DNS names that merely start with 127. are remote: no plaintext.
    [false, `http://127.${SECRET}.example/v1`],
    [false, `http://127.0.0.1.${SECRET}.example/v1`],
    [true, `http://127.0.0.1:8000/v1?${SECRET}`],
    [true, `https://127.0.0.2/${SECRET}`],
    [true, `https://${SECRET}.localhost/v1`],
    [true, `http://127.0.0.1:8000/${SECRET}`],
    [true, `https://localhost/${SECRET}`],
    [true, `http://${SECRET}.example.com/v1`],
    [true, `https://inference.local/${SECRET}`],
  ];
  for (const [openshell, url] of badEndpoints) {
    it(`rejects ${openshell ? "OpenShell " : ""}endpoint without echoing it (${url.slice(0, 30)}…)`, () => {
      const args = ["--host", "brev", "--model", "org/m", "--out", "x", "--endpoint", url];
      if (openshell) args.push("--openshell", "--image", "r/i:t");
      const res = quickstart(args);
      assert.equal(res.status, 2, res.stdout + res.stderr);
      assert.ok(!(res.stdout + res.stderr).includes(SECRET), "endpoint value leaked into output");
      assert.deepEqual(fs.readdirSync(res.cwd), []);
    });
  }

  it("accepts a real IPv4 loopback over http for direct runs, normalized", () => {
    for (const [given, expected] of [
      ["http://127.0.0.2:9000/v1", "http://127.0.0.2:9000/v1"],
      ["http://127.1:8000/v1/", "http://127.0.0.1:8000/v1"],
      ["https://127.attacker.example/v1", "https://127.attacker.example/v1"],
    ]) {
      const { out } = generate(["--host", "brev", "--model", "org/m", "--endpoint", given]);
      assert.ok(
        fs.readFileSync(path.join(out, "run.sh"), "utf8").includes(`OPENAI_COMPATIBLE_BASE_URL='${expected}'`),
        given,
      );
    }
  });

  it("does not echo a credential-bearing unknown --flag=value", () => {
    const res = quickstart(["--host", "brev", "--model", "org/m", "--out", "x", `--endpoint=https://u:${SECRET}@h/v1`]);
    assert.equal(res.status, 2);
    assert.ok(!(res.stdout + res.stderr).includes(SECRET));
  });

  it("refuses an existing output directory and leaves it unchanged", () => {
    const parent = tmp();
    const out = path.join(parent, "existing");
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, "keep.txt"), "mine");
    const res = quickstart(["--host", "nim", "--model", "m", "--out", out]);
    assert.equal(res.status, 2);
    assert.deepEqual(fs.readdirSync(out), ["keep.txt"]);
    assert.equal(fs.readFileSync(path.join(out, "keep.txt"), "utf8"), "mine");
  });

  it("refuses a symlinked output path without touching its target", () => {
    const parent = tmp();
    const target = tmp();
    const link = path.join(parent, "link");
    fs.symlinkSync(target, link);
    const res = quickstart(["--host", "nim", "--model", "m", "--out", link]);
    assert.equal(res.status, 2);
    assert.deepEqual(fs.readdirSync(target), []);
    assert.equal(fs.readlinkSync(link), target);
  });

  it("refuses a missing parent directory", () => {
    const res = quickstart(["--host", "nim", "--model", "m", "--out", path.join(tmp(), "a", "b")]);
    assert.equal(res.status, 2);
  });

  it("ignores saved config and credential env during generation", () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, ".sportsclaw"));
    const cfg = path.join(home, ".sportsclaw", "config.json");
    const dotenv = path.join(home, ".sportsclaw", ".env");
    fs.writeFileSync(cfg, JSON.stringify({ provider: "openai-compatible", model: "leaky-config-model" }));
    fs.writeFileSync(dotenv, "OPENAI_COMPATIBLE_BASE_URL=https://leaky-dotenv.example/v1\n");
    const out = path.join(tmp(), "bundle");
    const res = quickstart(["--host", "brev", "--model", "org/m", "--out", out], {
      home,
      env: { OPENAI_COMPATIBLE_BASE_URL: "https://leaky-env.example/v1", VLLM_API_KEY: SECRET, NVIDIA_API_KEY: SECRET },
    });
    assert.equal(res.status, 0, res.stderr);
    const all = listTree(out)
      .filter((f) => !f.endsWith("/"))
      .map((f) => fs.readFileSync(path.join(out, f), "utf8"))
      .join("\n");
    assert.ok(!/leaky/.test(all), "saved config or env leaked into the bundle");
    assert.ok(!all.includes(SECRET), "credential env leaked into the bundle");
    assert.ok(!(res.stdout + res.stderr).includes(SECRET));
    assert.deepEqual(fs.readdirSync(path.join(home, ".sportsclaw")).sort(), [".env", "config.json"]);
  });
});

// ---------------------------------------------------------------------------
// Brev direct bundle
// ---------------------------------------------------------------------------

describe("brev direct bundle", () => {
  const model = "acme-labs/Unlisted-Sports-Model-13B";
  const { out } = generate([
    "--host", "brev", "--model", model,
    "--served-model", "qs-model", "--tool-parser", "hermes", "--revision", "abc123",
  ]);

  it("writes exactly the direct-mode files with private permissions", () => {
    assert.deepEqual(listTree(out), [
      ".sportsclaw/",
      ".sportsclaw/operator/",
      ".sportsclaw/operator/quickstart.json",
      "README.md",
      "run.sh",
      "serve.sh",
      "skills/",
      "skills/hosted-models/",
      "skills/hosted-models/SKILL.md",
    ]);
    for (const dir of ["", ".sportsclaw", ".sportsclaw/operator", "skills", "skills/hosted-models"]) {
      assert.equal(mode(path.join(out, dir)), 0o700, `dir ${dir || "."}`);
    }
    assert.equal(mode(path.join(out, "run.sh")), 0o700);
    assert.equal(mode(path.join(out, "serve.sh")), 0o700);
    for (const f of ["README.md", ".sportsclaw/operator/quickstart.json", "skills/hosted-models/SKILL.md"]) {
      assert.equal(mode(path.join(out, f)), 0o600, f);
    }
  });

  it("generated scripts parse under bash -n", () => {
    for (const f of ["run.sh", "serve.sh"]) {
      const res = spawnSync("bash", ["-n", path.join(out, f)], { encoding: "utf8" });
      assert.equal(res.status, 0, `${f}: ${res.stderr}`);
    }
  });

  it("job config is a valid direct openai-compatible smoke job carrying the guide", () => {
    const job = readJob(out);
    const result = validateOperatorJobConfig(job, { sourcePath: "/x/quickstart.json" });
    assert.ok(result.valid, JSON.stringify(result.issues));
    assert.equal(job.provider, "openai-compatible");
    assert.equal(job.model, "qs-model");
    assert.equal(job.openshell, undefined);
    assert.deepEqual(job.skills, []);
    assert.equal(job.enableMemoryTools, false);
    assert.equal(job.sink, undefined);
    assert.ok(!path.isAbsolute(job.rootDir) || job.rootDir.startsWith("~/"), job.rootDir);
    assert.ok(job.personaText.includes(guideBody()), "guide body missing from personaText");
    assert.match(job.personaText, /do not invent/i);
    assert.equal(fs.readFileSync(path.join(out, "skills/hosted-models/SKILL.md"), "utf8"), fs.readFileSync(GUIDE, "utf8"));
  });

  it("serve.sh passes the arbitrary model id straight into vLLM args", () => {
    const serve = fs.readFileSync(path.join(out, "serve.sh"), "utf8");
    assert.match(serve, /docker run --rm --gpus all --shm-size 4g/);
    assert.match(serve, /-p 127\.0\.0\.1:8000:8000/);
    assert.match(serve, /--env HF_TOKEN --env VLLM_API_KEY/);
    assert.ok(serve.includes(`--model '${model}'`));
    assert.ok(serve.includes("--served-model-name 'qs-model'"));
    assert.ok(serve.includes("--revision 'abc123'"));
    assert.ok(serve.includes("--enable-auto-tool-choice --tool-call-parser 'hermes'"));
    assert.ok(serve.includes('"$@"'));
    assert.doesNotMatch(serve, /^[^#]*--trust-remote-code/m);
    assert.doesNotMatch(serve, /pkill|killall|docker (rm|stop|restart|kill)|--restart|snapshot_download/);
  });

  it("serve.sh requires VLLM_IMAGE and VLLM_API_KEY and keeps the key off argv", () => {
    const bin = tmp();
    const log = stub(bin, "docker");
    const home = tmp();
    const base = { PATH: `${bin}:${process.env.PATH}`, HOME: home };
    const serve = path.join(out, "serve.sh");

    let res = bash(serve, { env: { ...base, VLLM_API_KEY: SECRET } });
    assert.notEqual(res.status, 0);
    assert.equal(calls(log).length, 0);

    res = bash(serve, { env: { ...base, VLLM_IMAGE: "vllm/vllm-openai:reviewed", VLLM_API_KEY: " \t " } });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /VLLM_API_KEY/);
    assert.equal(calls(log).length, 0, "whitespace-only key reached docker");

    res = bash(serve, { env: { ...base, VLLM_IMAGE: "vllm/vllm-openai:reviewed" } });
    assert.notEqual(res.status, 0);
    assert.equal(calls(log).length, 0);

    res = bash(serve, {
      env: { ...base, VLLM_IMAGE: "vllm/vllm-openai:reviewed", VLLM_API_KEY: SECRET },
      args: ["--max-model-len", "4096"],
    });
    assert.equal(res.status, 0, res.stderr);
    const [argv] = calls(log);
    assert.equal(argv[0], "run");
    assert.ok(argv.includes("vllm/vllm-openai:reviewed"));
    assert.equal(argv[argv.indexOf("--model") + 1], model);
    assert.deepEqual(argv.slice(-2), ["--max-model-len", "4096"]);
    assert.ok(!argv.join(" ").includes(SECRET), "API key on docker argv");
    assert.ok(!(res.stdout + res.stderr).includes(SECRET));
  });

  it("run.sh runs one isolated --once tick with only the scoped credential", () => {
    const bin = tmp();
    const log = stub(bin, "sportsclaw", { recordEnv: true });
    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: tmp(),
      VLLM_API_KEY: "vllm-key-123",
      ANTHROPIC_API_KEY: "leak-a",
      OPENAI_API_KEY: "leak-o",
      OPENAI_COMPATIBLE_BASE_URL: "https://leak.example/v1",
      SPORTSCLAW_SKILLS: "nba",
      sportsclaw_SKILLS: "nba",
      sportsclaw_SCHEMA_DIR: "/leak",
      SPORTSCLAW_MCP_SERVERS: '{"leak":{"url":"https://leak.example"}}',
      SPORTSCLAW_MCP_TOKEN_LEAK: "leak-t",
      sportsclaw_PROVIDER: "anthropic",
    };
    const res = bash(path.join(out, "run.sh"), { env });
    assert.equal(res.status, 0, res.stderr);
    const [argv] = calls(log);
    assert.deepEqual(argv, ["operate", "--job", "quickstart", "--once"]);
    const recorded = Object.fromEntries(
      fs.readFileSync(`${log}.env`, "utf8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    assert.equal(recorded.HOME, out);
    assert.equal(recorded.OPENAI_COMPATIBLE_BASE_URL, "http://127.0.0.1:8000/v1");
    assert.equal(recorded.OPENAI_COMPATIBLE_API_KEY, "vllm-key-123");
    assert.equal(recorded.SPORTSCLAW_SKILLS, "");
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "sportsclaw_SKILLS", "sportsclaw_SCHEMA_DIR", "SPORTSCLAW_MCP_SERVERS", "SPORTSCLAW_MCP_TOKEN_LEAK", "sportsclaw_PROVIDER", "VLLM_API_KEY"]) {
      assert.equal(recorded[k], undefined, `${k} leaked into the run`);
    }
    assert.ok(!fs.readFileSync(`${log}.env`, "utf8").includes("leak"));
  });

  it("run.sh refuses a missing or whitespace-only VLLM_API_KEY (no fallback)", () => {
    for (const key of [undefined, "", "   ", " \t "]) {
      const bin = tmp();
      const log = stub(bin, "sportsclaw");
      const env = { PATH: `${bin}:${process.env.PATH}`, HOME: tmp(), OPENAI_COMPATIBLE_API_KEY: "x", ANTHROPIC_API_KEY: "x" };
      if (key !== undefined) env.VLLM_API_KEY = key;
      const res = bash(path.join(out, "run.sh"), { env });
      assert.notEqual(res.status, 0, JSON.stringify(key));
      assert.match(res.stderr, /VLLM_API_KEY/);
      assert.equal(calls(log).length, 0, JSON.stringify(key));
    }
  });

  it("README covers the Brev native flow with placeholders and scope", () => {
    const readme = fs.readFileSync(path.join(out, "README.md"), "utf8");
    assert.match(readme, /brev refresh/);
    assert.match(readme, /scp -F ~\/\.brev\/ssh_config/);
    assert.match(readme, /ssh -F ~\/\.brev\/ssh_config -N -o ExitOnForwardFailure=yes -L 127\.0\.0\.1:8000:127\.0\.0\.1:8000 <brev-machine>/);
    assert.match(readme, /VRAM/);
    assert.match(readme, /tool call/i);
    assert.match(readme, /docs\.vllm\.ai/);
    assert.match(readme, /docs\.nvidia\.com\/brev/);
    assert.doesNotMatch(readme, /brev (delete|stop|reset)|docker (rm|restart)|pkill/);
  });
});

// ---------------------------------------------------------------------------
// NIM direct bundle
// ---------------------------------------------------------------------------

describe("nim direct bundle", () => {
  const { out } = generate(["--host", "nim", "--model", "vendor/any-served-id"]);

  it("has no serve.sh and targets the NVIDIA API with NVIDIA_API_KEY", () => {
    assert.ok(!fs.existsSync(path.join(out, "serve.sh")));
    const job = readJob(out);
    assert.equal(job.provider, "openai-compatible");
    assert.equal(job.model, "vendor/any-served-id");

    const bin = tmp();
    const log = stub(bin, "sportsclaw", { recordEnv: true });
    let res = bash(path.join(out, "run.sh"), { env: { PATH: `${bin}:${process.env.PATH}`, VLLM_API_KEY: "x" } });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /NVIDIA_API_KEY/);
    assert.equal(calls(log).length, 0);

    res = bash(path.join(out, "run.sh"), { env: { PATH: `${bin}:${process.env.PATH}`, NVIDIA_API_KEY: " \t  " } });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /NVIDIA_API_KEY/);
    assert.equal(calls(log).length, 0, "whitespace-only NVIDIA_API_KEY reached sportsclaw");

    res = bash(path.join(out, "run.sh"), { env: { PATH: `${bin}:${process.env.PATH}`, NVIDIA_API_KEY: "nv-key" } });
    assert.equal(res.status, 0, res.stderr);
    const env = fs.readFileSync(`${log}.env`, "utf8");
    assert.match(env, /^OPENAI_COMPATIBLE_BASE_URL=https:\/\/integrate\.api\.nvidia\.com\/v1$/m);
    assert.match(env, /^OPENAI_COMPATIBLE_API_KEY=nv-key$/m);
    assert.doesNotMatch(env, /^NVIDIA_API_KEY=/m);
  });
});

// ---------------------------------------------------------------------------
// OpenShell bundle
// ---------------------------------------------------------------------------

describe("brev OpenShell bundle", () => {
  const image = "registry.example.com/sportsclaw-openshell:test";
  const { out } = generate([
    "--host", "brev", "--model", "org/m", "--openshell",
    "--endpoint", "https://gpu-gateway.example.com:8443/qs/v1/", "--image", image,
  ]);

  it("writes the OpenShell files", () => {
    for (const f of ["provider.yaml", "policy.yaml", "launch-openshell.sh", "run.sh", "serve.sh"]) {
      assert.ok(fs.existsSync(path.join(out, f)), f);
    }
    assert.equal(mode(path.join(out, "launch-openshell.sh")), 0o700);
    assert.equal(mode(path.join(out, "provider.yaml")), 0o600);
    assert.equal(mode(path.join(out, "policy.yaml")), 0o600);
    for (const f of ["run.sh", "serve.sh", "launch-openshell.sh"]) {
      const res = spawnSync("bash", ["-n", path.join(out, f)], { encoding: "utf8" });
      assert.equal(res.status, 0, `${f}: ${res.stderr}`);
    }
  });

  it("provider profile names exactly the selected host/port/path and env name only", () => {
    const profile = parseYaml(fs.readFileSync(path.join(out, "provider.yaml"), "utf8"));
    assert.equal(profile.id, "sportsclaw-quickstart");
    assert.deepEqual(profile.credentials.map((c) => c.env_vars), [["VLLM_API_KEY"]]);
    assert.equal(profile.endpoints.length, 1);
    assert.equal(profile.endpoints[0].host, "gpu-gateway.example.com");
    assert.equal(profile.endpoints[0].port, 8443);
    assert.equal(profile.endpoints[0].path, "/qs/v1/**");
    assert.deepEqual(profile.binaries, ["/usr/local/bin/node"]);
  });

  it("base policy grants no network egress and no vault/MCP routes", () => {
    const text = fs.readFileSync(path.join(out, "policy.yaml"), "utf8");
    const policy = parseYaml(text);
    assert.deepEqual(policy.network_policies, {});
    assert.ok(policy.filesystem_policy.read_write.includes("/sandbox"));
    assert.doesNotMatch(text.replace(/^#.*$/gm, ""), /vault|mcp|8103|5103|8193/i);
  });

  it("job config is OpenShell-native and fails closed outside a sandbox", () => {
    const job = readJob(out);
    assert.ok(validateOperatorJobConfig(job, { sourcePath: "/x/quickstart.json" }).valid);
    assert.equal(job.provider, "openai");
    assert.deepEqual(job.openshell, { baseUrl: "https://gpu-gateway.example.com:8443/qs/v1", credentialEnv: "VLLM_API_KEY" });

    const res = spawnSync(process.execPath, [CLI, "operate", "--job", "quickstart", "--once"], {
      cwd: out,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: out, VLLM_API_KEY: "x" },
      timeout: 60_000,
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /OpenShell sandbox/);
  });

  it("run.sh refuses to run the OpenShell job directly", () => {
    const bin = tmp();
    const log = stub(bin, "sportsclaw");
    const res = bash(path.join(out, "run.sh"), { env: { PATH: `${bin}:${process.env.PATH}`, VLLM_API_KEY: "x" } });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /launch-openshell\.sh/);
    assert.doesNotMatch(res.stderr, /enabled|disable/i);
    assert.equal(calls(log).length, 0);
  });

  function launch(version, extraEnv = { VLLM_API_KEY: SECRET }, failOn = "") {
    const bin = tmp();
    const log = stub(bin, "openshell", { stdout: `openshell ${version}`, failOn });
    const res = bash(path.join(out, "launch-openshell.sh"), {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp(), ...extraEnv },
    });
    return { res, calls: calls(log) };
  }

  it("launch-openshell.sh imports, creates from env and runs one --once sandbox", () => {
    const { res, calls: argvs } = launch("0.1.5");
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(argvs, [
      ["--version"],
      ["profile", "lint", "-f", "./provider.yaml"],
      ["profile", "import", "-f", "./provider.yaml"],
      ["provider", "create", "--name", "sportsclaw-quickstart", "--type", "sportsclaw-quickstart", "--from-existing"],
      [
        "sandbox", "create", "--name", "sportsclaw-quickstart", "--from", image,
        "--provider", "sportsclaw-quickstart", "--policy", "./policy.yaml",
        "--upload", "./.sportsclaw/operator/quickstart.json:/sandbox/.sportsclaw/operator/quickstart.json",
        "--no-keep", "--", "node", "/app/dist/index.js", "operate", "--job", "quickstart", "--once",
      ],
    ]);
    assert.ok(!JSON.stringify(argvs).includes(SECRET), "credential on openshell argv");
    assert.doesNotMatch(JSON.stringify(argvs), /delete|restart/);
  });

  it("launch-openshell.sh enforces the stable 0.1.x range", () => {
    for (const bad of ["0.2.0", "0.1.4", "0.1.6-dev", "0.0.47"]) {
      const { res, calls: argvs } = launch(bad);
      assert.notEqual(res.status, 0, bad);
      assert.deepEqual(argvs, [["--version"]], bad);
    }
    const newer = launch("0.1.7");
    assert.equal(newer.res.status, 0, newer.res.stderr);
    assert.match(newer.res.stderr, /unqualified|only 0\.1\.5/);
  });

  it("launch-openshell.sh requires a non-blank credential in the shell", () => {
    for (const env of [{}, { VLLM_API_KEY: "" }, { VLLM_API_KEY: " \t " }]) {
      const { res, calls: argvs } = launch("0.1.5", env);
      assert.notEqual(res.status, 0, JSON.stringify(env));
      assert.match(res.stderr, /VLLM_API_KEY/);
      assert.equal(argvs.length, 0, JSON.stringify(env));
    }
  });

  // Inert stub only: proves set -e stops later steps when OpenShell reports a
  // failure (e.g. a name collision). Real OpenShell collision behavior is not verified here.
  it("launch-openshell.sh stops at the first failing OpenShell step and deletes nothing", () => {
    const expectedCalls = { "profile import": 3, "provider create": 4, "sandbox create": 5 };
    for (const [failOn, count] of Object.entries(expectedCalls)) {
      const { res, calls: argvs } = launch("0.1.5", { VLLM_API_KEY: SECRET }, failOn);
      assert.notEqual(res.status, 0, failOn);
      assert.equal(argvs.length, count, `${failOn}: ${JSON.stringify(argvs)}`);
      assert.equal(argvs.at(-1).slice(0, 2).join(" "), failOn);
      assert.doesNotMatch(JSON.stringify(argvs), /delete|restart|--force/);
      assert.ok(!JSON.stringify(argvs).includes(SECRET));
    }
  });

  it("README explains the host bridge without binding SSH publicly", () => {
    const readme = fs.readFileSync(path.join(out, "README.md"), "utf8");
    assert.match(readme, /host\.openshell\.internal/);
    assert.match(readme, /0\.1\.5/);
    assert.doesNotMatch(readme, /-L 0\.0\.0\.0|GatewayPorts yes/);
  });
});

describe("nim OpenShell bundle", () => {
  it("binds NVIDIA_API_KEY to integrate.api.nvidia.com only", () => {
    const { out } = generate(["--host", "nim", "--model", "m", "--openshell", "--image", "r.example/i:t"]);
    const profile = parseYaml(fs.readFileSync(path.join(out, "provider.yaml"), "utf8"));
    assert.deepEqual(profile.endpoints.map((e) => [e.host, e.port, e.path]), [["integrate.api.nvidia.com", 443, "/v1/**"]]);
    assert.deepEqual(profile.credentials[0].env_vars, ["NVIDIA_API_KEY"]);
    assert.deepEqual(readJob(out).openshell, { baseUrl: "https://integrate.api.nvidia.com/v1", credentialEnv: "NVIDIA_API_KEY" });
    assert.ok(!fs.existsSync(path.join(out, "serve.sh")));

    const bin = tmp();
    const log = stub(bin, "openshell", { stdout: "openshell 0.1.5" });
    const res = bash(path.join(out, "launch-openshell.sh"), {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp(), NVIDIA_API_KEY: "  \t", VLLM_API_KEY: "unrelated" },
    });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /NVIDIA_API_KEY/);
    assert.equal(calls(log).length, 0, "whitespace-only NVIDIA_API_KEY reached openshell");
  });

  it("accepts the approved host bridge over http for brev", () => {
    const { out } = generate([
      "--host", "brev", "--model", "org/m", "--openshell", "--image", "r.example/i:t",
      "--endpoint", "http://host.openshell.internal:8000/v1",
    ]);
    const profile = parseYaml(fs.readFileSync(path.join(out, "provider.yaml"), "utf8"));
    assert.deepEqual(profile.endpoints.map((e) => [e.host, e.port, e.path]), [["host.openshell.internal", 8000, "/v1/**"]]);
  });
});

// ---------------------------------------------------------------------------
// Shared builders: quickstart renders the same core as `openshell setup`
// ---------------------------------------------------------------------------

describe("quickstart uses the shared OpenShell builders", () => {
  const guide = fs.readFileSync(GUIDE, "utf8");
  const opts = (...extra) => {
    const o = parseQuickstartArgs(["--host", "brev", "--model", "org/m", "--out", "unused", ...extra]);
    assert.notEqual(o, "help");
    return o;
  };

  it("launch-openshell.sh renders the shared one-shot commands verbatim", () => {
    const o = opts("--openshell", "--endpoint", "https://gpu.example.com/v1", "--image", "r.example/i:t");
    const launch = buildQuickstartBundle(o, guide).find((f) => f.path === "launch-openshell.sh").content;
    const cmds = buildOpenShellCommands({
      profileFile: "./provider.yaml",
      profileId: "sportsclaw-quickstart",
      providerName: "sportsclaw-quickstart",
      image: "r.example/i:t",
      sandboxName: "sportsclaw-quickstart",
      policyFile: "./policy.yaml",
      jobId: "quickstart",
      jobFile: "./.sportsclaw/operator/quickstart.json",
      once: true,
    });
    assert.ok(
      launch.includes([cmds.profileLint, cmds.profileImport, cmds.providerCreate, cmds.sandboxCreate].join("\n")),
      launch,
    );
    // One-shot only: no daemon restart, no verification against an auto-removed sandbox.
    assert.doesNotMatch(launch, /--detach|--restart-policy|sandbox provider list|policy get/);
  });

  it("job core fields equal the shared job object (OpenShell and direct)", () => {
    const cases = [
      [opts("--openshell", "--endpoint", "https://gpu.example.com/v1", "--image", "r.example/i:t"),
        { provider: "openai", openshell: { baseUrl: "https://gpu.example.com/v1", credentialEnv: "VLLM_API_KEY" } }],
      [opts(), { provider: "openai-compatible" }],
    ];
    for (const [o, route] of cases) {
      const job = buildQuickstartJob(o, guide);
      const core = buildJobObject({
        jobId: "quickstart",
        label: `Hosted-model quickstart (brev${o.openshell ? ", OpenShell" : ""})`,
        intervalMs: 300_000,
        personaText: job.personaText,
        model: "org/m",
        ...route,
      });
      for (const [key, value] of Object.entries(core)) assert.deepEqual(job[key], value, key);
      assert.equal("openshell" in job, o.openshell);
      assert.ok(job.personaText.includes(guideBody()));
    }
  });
});

// ---------------------------------------------------------------------------
// Packaging
// ---------------------------------------------------------------------------

describe("packaged guide", () => {
  it("ships quickstart/ in the npm package with a portable SKILL.md", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    assert.ok(pkg.files.includes("quickstart"));
    const text = fs.readFileSync(GUIDE, "utf8");
    assert.match(text, /^---\nname: hosted-models\ndescription: \S/);
    for (const topic of [/\/models/, /tool call/i, /approv/i, /sports-intelligence-playbooks/, /VRAM/]) {
      assert.match(text, topic);
    }
  });
});

// ---------------------------------------------------------------------------
// Real --once against a fake OpenAI-compatible endpoint (no GPU involved)
// ---------------------------------------------------------------------------

describe("credential character validation", () => {
  for (const host of ["brev", "nim"]) {
    for (const sandboxed of [false, true]) {
      it(`${host} ${sandboxed ? "OpenShell" : "direct"} rejects Unicode blank and malformed bearer keys`, () => {
        const options = ["--host", host, "--model", "org/model"];
        if (sandboxed) {
          options.push("--openshell", "--image", "example/agent:test");
          if (host === "brev") options.push("--endpoint", "https://gpu.example.com/v1");
        }
        const { out } = generate(options);
        const bin = tmp();
        const names = ["sportsclaw", "docker", "openshell"];
        const logs = names.map((name) => stub(bin, name));
        const keyName = host === "nim" ? "NVIDIA_API_KEY" : "VLLM_API_KEY";
        const scripts = [sandboxed ? "launch-openshell.sh" : "run.sh"];
        if (host === "brev") scripts.push("serve.sh");
        for (const key of ["\u00a0", "\ufeff", "\u2000", "\u2028", " token ", "token\n"]) {
          for (const script of scripts) {
            const res = bash(path.join(out, script), {
              env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp(), LC_ALL: "C",
                VLLM_IMAGE: "vllm/vllm-openai:reviewed", [keyName]: key },
            });
            assert.notEqual(res.status, 0, `${script} accepted ${JSON.stringify(key)}`);
            assert.match(res.stderr, new RegExp(keyName));
            for (const log of logs) assert.equal(calls(log).length, 0, `${script} invoked a child`);
          }
        }
      });
    }
  }
});

describe("direct --once fixture", () => {
  it("sends the guide-bearing persona to the configured endpoint with the scoped key", async () => {
    const { out } = generate(["--host", "brev", "--model", "org/fixture-model"]);
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = body ? JSON.parse(body) : {};
        requests.push({ url: req.url, auth: req.headers.authorization, body: parsed });
        const message = { role: "assistant", content: "Ready: fixture reply." };
        if (parsed.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const chunk = (delta, finish = null) =>
            `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
          res.write(chunk({ role: "assistant", content: message.content }));
          res.write(chunk({}, "stop"));
          res.end("data: [DONE]\n\n");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "c1", object: "chat.completion", created: 1, model: parsed.model,
          choices: [{ index: 0, message, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();
    try {
      const child = spawn(process.execPath, [CLI, "operate", "--job", "quickstart", "--once"], {
        cwd: out,
        env: {
          PATH: process.env.PATH,
          HOME: out,
          OPENAI_COMPATIBLE_BASE_URL: `http://127.0.0.1:${port}/v1`,
          OPENAI_COMPATIBLE_API_KEY: "fixture-key",
          SPORTSCLAW_SKILLS: "",
        },
      });
      let stderr = "";
      child.stderr.on("data", (c) => (stderr += c));
      const killer = setTimeout(() => child.kill("SIGKILL"), 90_000);
      const code = await new Promise((r) => child.on("close", r));
      clearTimeout(killer);
      assert.equal(code, 0, stderr);
      const chat = requests.find((r) => r.url === "/v1/chat/completions");
      assert.ok(chat, `no chat request; saw ${JSON.stringify(requests.map((r) => r.url))}`);
      assert.equal(chat.auth, "Bearer fixture-key");
      assert.equal(chat.body.model, "org/fixture-model");
      const system = JSON.stringify(chat.body.messages);
      assert.ok(system.includes(JSON.stringify(guideBody()).slice(1, 200)), "guide body did not reach the model");
    } finally {
      server.close();
    }
  });
});
