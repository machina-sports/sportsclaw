/**
 * Review regressions for the OpenShell 0.1.x migration.
 *
 * Behavioral fixtures only: real CLI subprocesses in an isolated HOME, a local
 * mock HTTP server, a recording global dispatcher, and inert fake
 * `openshell`/`docker` executables that only record argv. No external calls,
 * no provisioning, fixture tokens only.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { generateText } from "ai";

import * as providers from "../dist/llm-providers.js";
import * as cli from "../dist/openshell-cli.js";
import { invokeModelRole } from "../dist/inference/model-role-router.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = join(root, "dist", "index.js");
const scratch = mkdtempSync(join(tmpdir(), "sc-os-review-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let seq = 0;
const freshDir = (name) => {
  const d = join(scratch, `${name}-${seq++}`);
  mkdirSync(d, { recursive: true });
  return d;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const completion = () => ({
  id: "c1",
  object: "chat.completion",
  created: 1,
  model: "served-model",
  choices: [{ index: 0, message: { role: "assistant", content: "native ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
});

/** Mock server recording requests and distinct TCP connections. */
async function withServer(fn, { delayMs = 0 } = {}) {
  const requests = [];
  let connections = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      requests.push({ url: req.url, headers: req.headers, body });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (res.destroyed) return;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(completion()));
    });
  });
  server.on("connection", () => connections++);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/v1`, requests, () => connections);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

/** Fake executables that append `name\x1farg\x1farg...\x1e` to $FAKE_ARGV_LOG and exit 0. */
function makeFakeBin(names = ["openshell", "docker", "podman"]) {
  const dir = freshDir("bin");
  for (const name of names) {
    writeFileSync(
      join(dir, name),
      `#!/bin/sh\n{ printf '%s' '${name}'; for a in "$@"; do printf '\\037%s' "$a"; done; printf '\\036'; } >> "$FAKE_ARGV_LOG"\nexit 0\n`,
      { mode: 0o755 },
    );
  }
  return dir;
}

function readArgvLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\x1e")
    .filter(Boolean)
    .map((rec) => rec.split("\x1f"));
}

/** Isolated HOME with optional ~/.sportsclaw/{.env,config.json,operator/<job>.json}. */
function makeHome({ dotenv, config, jobs = {} } = {}) {
  const home = freshDir("home");
  const sc = join(home, ".sportsclaw");
  mkdirSync(join(sc, "operator"), { recursive: true });
  if (dotenv) writeFileSync(join(sc, ".env"), dotenv);
  if (config) writeFileSync(join(sc, "config.json"), JSON.stringify(config));
  for (const [id, job] of Object.entries(jobs)) {
    writeFileSync(join(sc, "operator", `${id}.json`), JSON.stringify({ jobId: id, ...job }));
  }
  return home;
}

/** Async CLI run (the mock server lives in this process, so never block it). */
function runCli(args, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRY, ...args], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/** Run an ES module snippet in a subprocess with the given env (for HOME-bound config paths). */
function runModule(source, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const baseEnv = (home, fakeBin, log, extra = {}) => ({
  HOME: home,
  PATH: fakeBin,
  FAKE_ARGV_LOG: log,
  SPORTSCLAW_MEMORY_BACKEND: "file",
  NO_COLOR: "1",
  ...extra,
});

const DOTENV_TOKEN = "fixture-saved-dotenv-token-0001";
const CONFIG_TOKEN = "fixture-saved-config-token-0002";

// ---------------------------------------------------------------------------
// 1. P1 — saved credentials must not satisfy an OpenShell credential env
//    (`sportsclaw start operator` children run this same `operate --job` path;
//    see daemon-operator.test.mjs scriptArgsFor).
// ---------------------------------------------------------------------------

describe("P1: CLI hydration never fills an OpenShell credential env", () => {
  const job = (baseUrl, credentialEnv) => ({
    intervalMs: 60_000,
    personaText: "op",
    provider: "openai",
    model: "served-model",
    openshell: { baseUrl, credentialEnv },
  });

  for (const variant of [
    { name: ".env value", credentialEnv: "NVIDIA_API_KEY", token: DOTENV_TOKEN },
    { name: "persisted config apiKey", credentialEnv: "OPENAI_API_KEY", token: CONFIG_TOKEN },
  ]) {
    it(`operate --once rejects before inference/MCP when only a ${variant.name} exists`, async () => {
      await withServer(async (baseUrl, requests) => {
        const home = makeHome({
          dotenv: `NVIDIA_API_KEY=${DOTENV_TOKEN}\n`,
          config: { provider: "openai", apiKey: CONFIG_TOKEN },
          jobs: { "os-job": job(baseUrl, variant.credentialEnv) },
        });
        const log = join(home, "argv.log");
        const r = await runCli(
          ["operate", "--job", "os-job", "--once"],
          baseEnv(home, makeFakeBin(), log, { OPENSHELL_SANDBOX: "1" }),
        );
        assert.notStrictEqual(r.code, 0, r.out);
        assert.strictEqual(requests.length, 0, "no model request with a hydrated credential");
        assert.ok(!r.out.includes(variant.token), "token never printed");
        assert.match(r.out, new RegExp(variant.credentialEnv));
        assert.deepStrictEqual(readArgvLog(log), [], "no openshell/docker probes");
      });
    });
  }

  it("a real workload-injected value still wins over saved ones", async () => {
    await withServer(async (baseUrl, requests) => {
      const home = makeHome({
        dotenv: `NVIDIA_API_KEY=${DOTENV_TOKEN}\n`,
        jobs: { "os-job": job(baseUrl, "NVIDIA_API_KEY") },
      });
      await runCli(
        ["operate", "--job", "os-job", "--once"],
        baseEnv(home, makeFakeBin(), join(home, "argv.log"), {
          OPENSHELL_SANDBOX: "1",
          NVIDIA_API_KEY: "openshell-placeholder-injected",
        }),
      );
      assert.ok(requests.length >= 1);
      assert.strictEqual(requests[0].headers.authorization, "Bearer openshell-placeholder-injected");
    });
  });

  it("direct jobs keep .env hydration, even inside a sandbox", async () => {
    await withServer(async (baseUrl, requests) => {
      const home = makeHome({
        dotenv: `OPENAI_API_KEY=${DOTENV_TOKEN}\nOPENAI_BASE_URL=${baseUrl}\n`,
        jobs: { "direct-job": { intervalMs: 60_000, personaText: "op", provider: "openai", model: "gpt-4.1" } },
      });
      const log = join(home, "argv.log");
      await runCli(
        ["operate", "--job", "direct-job", "--once"],
        baseEnv(home, makeFakeBin(), log, { OPENSHELL_SANDBOX: "1" }),
      );
      assert.ok(requests.length >= 1, "direct job reached its endpoint");
      assert.strictEqual(requests[0].headers.authorization, `Bearer ${DOTENV_TOKEN}`);
      assert.deepStrictEqual(readArgvLog(log), [], "disabled path runs no OpenShell probes");
    });
  });

  it("openshell model roles ignore hydrated values after applyConfigToEnv (library + mixed jobs)", async () => {
    await withServer(async (baseUrl, requests) => {
      const home = makeHome({ dotenv: `NVIDIA_API_KEY=${DOTENV_TOKEN}\n` });
      const src = `
        import { applyConfigToEnv } from ${JSON.stringify(pathToFileURL(join(root, "dist/config.js")).href)};
        import { invokeModelRole } from ${JSON.stringify(pathToFileURL(join(root, "dist/inference/model-role-router.js")).href)};
        applyConfigToEnv();
        try {
          await invokeModelRole({ role: "brain", input: "x", source: "benchmark",
            config: { roles: { brain: { route: "openshell", model: "m", baseUrl: process.env.MOCK_URL, credentialEnv: "NVIDIA_API_KEY" } } } });
          console.log("RESULT ok");
        } catch (e) { console.log("RESULT rejected " + e.message); }
      `;
      const r = await runModule(src, { HOME: home, OPENSHELL_SANDBOX: "1", MOCK_URL: baseUrl, PATH: "" });
      assert.match(r.out, /RESULT rejected/, r.out);
      assert.ok(!r.out.includes(DOTENV_TOKEN));
      assert.strictEqual(requests.length, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. P2 — NIM keeps ambient transport; OpenShell clients stay isolated
// ---------------------------------------------------------------------------

describe("P2: transport separation", () => {
  const SYM = Symbol.for("undici.globalDispatcher.1");

  /** Wrap Node's own global dispatcher so we observe ambient routing without changing it. */
  async function withRecordingGlobalDispatcher(baseUrl, fn) {
    await fetch(`${baseUrl}/warmup`, { method: "POST", body: "{}" }); // initialise built-in dispatcher
    const inner = globalThis[SYM];
    const seen = [];
    globalThis[SYM] = {
      dispatch(opts, handler) {
        seen.push(String(opts.path));
        return inner.dispatch(opts, handler);
      },
      close: (...a) => inner.close(...a),
      destroy: (...a) => inner.destroy(...a),
    };
    try {
      return await fn(seen);
    } finally {
      globalThis[SYM] = inner;
    }
  }

  it("NIM roles go through the ambient global dispatcher (existing proxy behavior)", async () => {
    await withServer(async (baseUrl) => {
      await withRecordingGlobalDispatcher(baseUrl, async (seen) => {
        await invokeModelRole({ role: "brain", input: "x", source: "benchmark", config: { roles: { brain: { route: "nim", model: "m", baseUrl } } } });
        assert.ok(seen.some((p) => p.endsWith("/chat/completions")), JSON.stringify(seen));
      });
    });
  });

  it("enabled OpenShell clients bypass the ambient global dispatcher", async () => {
    await withServer(async (baseUrl, requests) => {
      await withRecordingGlobalDispatcher(baseUrl, async (seen) => {
        const ep = providers.resolveOpenShellEndpoint("openai", { baseUrl, credentialEnv: "K" }, { OPENSHELL_SANDBOX: "1", K: "p" });
        await generateText({ model: providers.resolveModel("openai", "m", ep), prompt: "x", maxRetries: 0 });
        assert.ok(!seen.some((p) => p.endsWith("/chat/completions")), JSON.stringify(seen));
        assert.ok(requests.some((r) => r.url.endsWith("/chat/completions")));
      });
    });
  });

  it("an explicitly configured NIM timeout is honoured", async () => {
    await withServer(
      async (baseUrl) => {
        const started = Date.now();
        await assert.rejects(() =>
          invokeModelRole({ role: "brain", input: "x", source: "benchmark", config: { roles: { brain: { route: "nim", model: "m", baseUrl, timeoutMs: 200 } } } }),
        );
        assert.ok(Date.now() - started < 2_000);
      },
      { delayMs: 3_000 },
    );
  });
});

// ---------------------------------------------------------------------------
// 3. P2 — OpenShell clients share one bounded isolated pool
// ---------------------------------------------------------------------------

describe("P2: isolated agent reuse", () => {
  it("repeated OpenShell clients reuse a keep-alive connection instead of new pools", async () => {
    await withServer(async (baseUrl, requests, connections) => {
      for (let i = 0; i < 4; i++) {
        const ep = providers.resolveOpenShellEndpoint("openai", { baseUrl, credentialEnv: "K" }, { OPENSHELL_SANDBOX: "1", K: `p${i}` });
        await generateText({ model: providers.resolveModel("openai", `m${i}`, ep), prompt: "x", maxRetries: 0 });
        // Let fetch release the consumed response's socket before the next client.
        // A separate Agent per client still opens four sockets after this yield.
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.strictEqual(requests.length, 4);
      // Credentials stay request-scoped even on a shared pool.
      assert.deepStrictEqual(requests.map((r) => r.headers.authorization), ["Bearer p0", "Bearer p1", "Bearer p2", "Bearer p3"]);
      assert.strictEqual(connections(), 1, `expected one reused socket, saw ${connections()}`);
    });
  });
});

// ---------------------------------------------------------------------------
// 4 + 7. setup: print-only, strict default policy, explicit connected opt-in
// ---------------------------------------------------------------------------

describe("setup: print-only with a strict default policy", () => {
  async function setup(args) {
    const home = makeHome();
    const log = join(home, "argv.log");
    const r = await runCli(["openshell", "setup", ...args], baseEnv(home, makeFakeBin(), log));
    return { ...r, invocations: readArgvLog(log) };
  }
  const policyArg = (out) => /--policy\s+'?([^'\s]+)'?/.exec(out)?.[1] ?? "";

  it("renders without running openshell/docker/podman and exits 0", async () => {
    const r = await setup([]);
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual(r.invocations, []);
  });

  it("defaults to the local-only Vault policy for hosted and local profiles", async () => {
    for (const args of [[], ["--profile", "nim-local"]]) {
      const r = await setup(args);
      assert.ok(policyArg(r.out).endsWith("/policy.vault.yaml"), `${args}: ${policyArg(r.out)}`);
    }
  });

  it("names the privacy boundary of a hosted provider attachment", async () => {
    const r = await setup([]);
    assert.match(r.out, /external/i);
  });

  it("connected/vault-espn policies are explicit opt-ins; connected warns about its permissions", async () => {
    const connected = await setup(["--policy", "connected"]);
    assert.strictEqual(connected.code, 0, connected.out);
    assert.ok(policyArg(connected.out).endsWith("/policy.yaml"), policyArg(connected.out));
    assert.match(connected.out, /warning/i);
    assert.match(connected.out, /MCP/);
    const espn = await setup(["--policy", "vault-espn"]);
    assert.ok(policyArg(espn.out).endsWith("/policy.vault-espn.yaml"), policyArg(espn.out));
  });

  it("rejects unknown policies and unsupported flags without probing", async () => {
    for (const args of [["--policy", "wide-open"], ["--json"]]) {
      const r = await setup(args);
      assert.strictEqual(r.code, 2, `${args}: ${r.out}`);
      assert.deepStrictEqual(r.invocations, []);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Generated commands are POSIX-quoted and executable as printed
// ---------------------------------------------------------------------------

describe("setup recipe shell safety", () => {
  it("executes as printed with hostile names, producing exact argv and no injection", () => {
    const work = freshDir("recipe");
    const fakeBin = makeFakeBin();
    const log = join(work, "argv.log");
    const o = {
      profileFile: `${work}/it's a dir/$(touch pwned); prof.yaml`,
      profileId: "nvidia-native",
      providerName: "nv'prod $(touch pwned)",
      image: "registry.example.com/team/img:1.0;touch pwned",
      sandboxName: "sb'1 & `touch pwned`",
      policyFile: `${work}/pol icy's/policy.vault.yaml`,
      jobId: "tv-op_1.x",
    };
    const recipe = cli.buildSetupRecipe(o);
    const r = spawnSync("/bin/sh", ["-c", recipe], { cwd: work, env: { PATH: fakeBin, FAKE_ARGV_LOG: log }, encoding: "utf8" });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!existsSync(join(work, "pwned")), "shell metacharacters were executed");

    const calls = readArgvLog(log);
    const find = (...prefix) => calls.find((c) => prefix.every((p, i) => c[i] === p));
    assert.deepStrictEqual(find("openshell", "profile", "lint"), ["openshell", "profile", "lint", "-f", o.profileFile]);
    assert.deepStrictEqual(find("openshell", "profile", "import"), ["openshell", "profile", "import", "-f", o.profileFile]);
    assert.deepStrictEqual(find("openshell", "provider", "create"), [
      "openshell", "provider", "create", "--name", o.providerName, "--type", o.profileId, "--from-existing",
    ]);
    const create = find("openshell", "sandbox", "create");
    assert.ok(create, JSON.stringify(calls));
    const valueOf = (flag) => create[create.indexOf(flag) + 1];
    assert.strictEqual(valueOf("--name"), o.sandboxName);
    assert.strictEqual(valueOf("--from"), o.image);
    assert.strictEqual(valueOf("--provider"), o.providerName);
    assert.strictEqual(valueOf("--policy"), o.policyFile);
    assert.strictEqual(valueOf("--upload"),`./${o.jobId}.json:/sandbox/.sportsclaw/operator/${o.jobId}.json`);
    assert.deepStrictEqual(create.slice(create.indexOf("--")), ["--", "node", "/app/dist/index.js", "operate", "--job", o.jobId]);
    assert.ok(create.includes("--detach"), "line continuation kept the command whole");
    assert.ok(!calls.some((c) => c[0] !== "openshell"), "no stray commands from broken continuations");
  });

  it("rejects job ids that are not valid operator job ids", () => {
    const base = {
      profileFile: "p.yaml", profileId: "nvidia-native", providerName: "nv", image: "img:1",
      sandboxName: "sb", policyFile: "policy.vault.yaml",
    };
    for (const jobId of ["../evil", "a b", "x;y", "it's", ""]) {
      assert.throws(() => cli.buildSetupRecipe({ ...base, jobId }), undefined, JSON.stringify(jobId));
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Versions: suffixes preserved, prereleases rejected, newer stable = warn
// ---------------------------------------------------------------------------

describe("OpenShell version qualification", () => {
  const probe = (stdout) => cli.interpretVersionProbe({ ok: true, stdout, stderr: "", exitCode: 0, timedOut: false });

  it("preserves prerelease suffixes", () => {
    assert.strictEqual(cli.parseOpenShellVersion("openshell 0.1.5-rc.1\n"), "0.1.5-rc.1");
    assert.strictEqual(cli.parseOpenShellVersion("openshell 0.1.6-dev"), "0.1.6-dev");
  });

  it("rejects prereleases", () => {
    for (const v of ["0.1.5-rc.1", "0.1.6-dev"]) {
      assert.strictEqual(cli.isSupportedOpenShellVersion(v), false, v);
      assert.strictEqual(probe(`openshell ${v}\n`).status, "missing", v);
    }
  });

  it("only 0.1.5 is green; newer stable 0.1.x is an unqualified warning; 0.2.0 is rejected", () => {
    assert.strictEqual(probe("openshell 0.1.5\n").status, "ok");
    const newer = probe("openshell 0.1.6\n");
    assert.strictEqual(newer.status, "warn");
    assert.match(newer.detail ?? "", /0\.1\.6/);
    assert.match(`${newer.detail} ${newer.hint}`, /unqualified|untested/i);
    assert.strictEqual(probe("openshell 0.2.0\n").status, "missing");
  });
});
