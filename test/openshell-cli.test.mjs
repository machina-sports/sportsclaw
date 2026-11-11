/**
 * `sportsclaw openshell` CLI — focused tests on the pure helpers.
 *
 * The doctor's individual probes shell out to `openshell` and `docker`,
 * which would make any test depend on host state. We test the
 * formatter and the scaffold builder directly with synthetic inputs.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  buildJobObject,
  buildOpenShellCommands,
  buildScaffoldConfig,
  buildSetupRecipe,
  formatReport,
  interpretSandboxProbeResult,
  parseGatewayListJson,
  parseProviderNames,
} from "../dist/openshell-cli.js";

function stripAnsi(text) {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

// ---------------------------------------------------------------------------
// formatReport
// ---------------------------------------------------------------------------

describe("formatReport", () => {
  it("includes a marker, label, and detail per result", () => {
    const out = formatReport({
      results: [
        { id: "a", label: "Item A", status: "ok", detail: "v1.2.3" },
        { id: "b", label: "Item B", status: "missing", detail: "not found", hint: "do X" },
      ],
      allOk: false,
    });
    assert.match(out, /Item A/);
    assert.match(out, /v1\.2\.3/);
    assert.match(out, /Item B/);
    assert.match(out, /not found/);
    assert.match(stripAnsi(out), /→ do X/);
  });

  it("prints the all-ok banner when every check passes", () => {
    const out = formatReport({
      results: [{ id: "a", label: "Item A", status: "ok", detail: "" }],
      allOk: true,
    });
    assert.match(out, /All checks passed/);
    assert.match(out, /openshell sandbox create/);
  });

  it("prints a remediation hint pointing at `setup` when any check fails", () => {
    const out = formatReport({
      results: [
        { id: "a", label: "Item A", status: "ok" },
        { id: "b", label: "Item B", status: "missing", hint: "do X" },
      ],
      allOk: false,
    });
    assert.match(out, /sportsclaw openshell setup/);
  });

  it("renders a `warn` status with its hint", () => {
    const out = formatReport({
      results: [
        { id: "k", label: "API key", status: "warn", detail: "not set", hint: "export X" },
      ],
      allOk: false,
    });
    assert.match(out, /API key/);
    assert.match(out, /not set/);
    assert.match(stripAnsi(out), /→ export X/);
  });

  it("does not print a remediation arrow for OK rows", () => {
    const out = formatReport({
      results: [{ id: "a", label: "Item A", status: "ok", detail: "fine", hint: "ignored" }],
      allOk: true,
    });
    assert.doesNotMatch(out, /→ ignored/);
  });
});

// ---------------------------------------------------------------------------
// 0.1.x structured CLI output
//
// The 0.0.47 provider-table and `inference` parsers were removed with the
// managed route; 0.1.x exposes `gateway list -o json` (bare array) and the
// documented one-name-per-line `provider list --names`.
// ---------------------------------------------------------------------------

describe("parseGatewayListJson", () => {
  it("counts entries in the bare JSON array", () => {
    assert.strictEqual(parseGatewayListJson("[]"), 0);
    assert.strictEqual(parseGatewayListJson('[{"name":"local"}]\n'), 1);
  });

  it("returns undefined for non-array or unparseable output", () => {
    assert.strictEqual(parseGatewayListJson(""), undefined);
    assert.strictEqual(parseGatewayListJson("{}"), undefined);
    assert.strictEqual(parseGatewayListJson("NAME  ENDPOINT\n"), undefined);
  });
});

describe("parseProviderNames", () => {
  it("returns one provider per non-blank line", () => {
    assert.deepStrictEqual(parseProviderNames("nvidia-native-prod\nollama\n"), ["nvidia-native-prod", "ollama"]);
  });

  it("returns [] for empty output", () => {
    assert.deepStrictEqual(parseProviderNames(""), []);
  });
});

// ---------------------------------------------------------------------------
// interpretSandboxProbeResult — `openshell sandbox create` probe interpreter
// ---------------------------------------------------------------------------

describe("interpretSandboxProbeResult", () => {
  it("returns 'ok' when sandbox provisions cleanly", () => {
    const r = interpretSandboxProbeResult({
      ok: true,
      stdout: "Created sandbox: sc-doctor-abc123\n  [0.3s] Running...\n  [0.4s] Completed\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
    assert.strictEqual(r.id, "compute-driver");
    assert.strictEqual(r.status, "ok");
  });

  it("flags the supervisor-relay symptom with a service-restart hint", () => {
    // Verbatim from `openshell sandbox create` on 2026-05-23 when only the
    // gateway was running and no compute driver was registered. CLI exit was
    // 0 despite the timeout — we must look at the error text, not just exit.
    const r = interpretSandboxProbeResult({
      ok: true,
      stdout:
        "Created sandbox: sportsclaw-test\n\n  [0.0s] Requesting compute...\n\n" +
        "Error:   × sandbox provisioning timed out after 300s. Last reported status:\n" +
        "  │ DependenciesNotReady: Container is running; waiting for supervisor relay\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
    assert.strictEqual(r.status, "missing");
    assert.match(r.detail, /no compute driver/i);
    assert.match(r.hint, /brew services restart/i);
  });

  it("flags the same symptom when our probe times out before the CLI prints", () => {
    // Real observed case: our 45s probe killed the CLI before its own 300s
    // wait completed, so no "supervisor relay" text was emitted. timedOut
    // must still produce the driver-bringup hint.
    const r = interpretSandboxProbeResult({
      ok: false,
      stdout: "Created sandbox: sc-doctor-xyz\n\n  [0.0s] Requesting compute...\n",
      stderr: "",
      exitCode: null,
      timedOut: true,
    });
    assert.strictEqual(r.status, "missing");
    assert.match(r.detail, /no compute driver/i);
    assert.match(r.hint, /brew services restart/i);
  });

  it("surfaces the first error line for unrelated failures", () => {
    const r = interpretSandboxProbeResult({
      ok: false,
      stdout: "",
      stderr:
        "Error:   × status: Internal, message: \"create sandbox failed: pull Docker image failed: denied\\ndenied\"\n",
      exitCode: 1,
      timedOut: false,
    });
    assert.strictEqual(r.status, "missing");
    assert.match(r.detail, /pull Docker image failed|denied/i);
    assert.doesNotMatch(r.hint ?? "", /brew services restart/i);
  });

  it("falls back to a generic detail when no error line is recognizable", () => {
    const r = interpretSandboxProbeResult({
      ok: false,
      stdout: "",
      stderr: "",
      exitCode: 137,
      timedOut: false,
    });
    assert.strictEqual(r.status, "missing");
    assert.match(r.detail, /exit 137/);
  });
});

// ---------------------------------------------------------------------------
// buildScaffoldConfig
// ---------------------------------------------------------------------------

describe("buildScaffoldConfig", () => {
  it("produces valid JSON with an explicit native openshell block", () => {
    const raw = buildScaffoldConfig({
      jobId: "tv-op",
      personaText: "You are an operator.",
      provider: "anthropic",
      model: "claude-opus-4-6",
      intervalMs: 60000,
      baseUrl: "https://api.anthropic.com/v1",
      credentialEnv: "ANTHROPIC_API_KEY",
    });
    const cfg = JSON.parse(raw);
    assert.strictEqual(cfg.jobId, "tv-op");
    assert.strictEqual(cfg.provider, "anthropic");
    assert.strictEqual(cfg.model, "claude-opus-4-6");
    assert.strictEqual(cfg.intervalMs, 60000);
    assert.strictEqual(cfg.personaText, "You are an operator.");
    assert.deepStrictEqual(cfg.openshell, {
      baseUrl: "https://api.anthropic.com/v1",
      credentialEnv: "ANTHROPIC_API_KEY",
    });
  });

  it("ends with a trailing newline (POSIX file convention)", () => {
    const raw = buildScaffoldConfig({
      jobId: "x",
      personaText: "...",
      provider: "openai",
      model: "gpt-4.1",
      intervalMs: 30000,
      baseUrl: "http://host.openshell.internal:8000/v1",
      credentialless: true,
    });
    assert.ok(raw.endsWith("\n"));
    assert.deepStrictEqual(JSON.parse(raw).openshell, {
      baseUrl: "http://host.openshell.internal:8000/v1",
      credentialless: true,
    });
  });

  it("survives the operator-config validator", async () => {
    const { validateOperatorJobConfig } = await import("../dist/operator-config.js");
    const raw = buildScaffoldConfig({
      jobId: "scaffold-test",
      personaText: "You are SportsClaw.",
      provider: "anthropic",
      model: "claude-opus-4-6",
      intervalMs: 60000,
      baseUrl: "https://api.anthropic.com/v1",
      credentialEnv: "ANTHROPIC_API_KEY",
    });
    const result = validateOperatorJobConfig(JSON.parse(raw));
    assert.strictEqual(result.valid, true, JSON.stringify(result.issues));
    assert.strictEqual(result.config.openshell.baseUrl, "https://api.anthropic.com/v1");
    assert.strictEqual(result.config.openshell.credentialEnv, "ANTHROPIC_API_KEY");
  });

  it("keeps the original serialized output (key order, label, credential choice)", () => {
    const base = { jobId: "tv-op", personaText: "p", provider: "openai", model: "m", intervalMs: 60000, baseUrl: "https://x.example/v1" };
    const head = { jobId: "tv-op", label: "tv-op (OpenShell)", intervalMs: 60000, personaText: "p", provider: "openai", model: "m" };
    assert.strictEqual(
      buildScaffoldConfig({ ...base, credentialEnv: "K" }),
      JSON.stringify({ ...head, openshell: { baseUrl: "https://x.example/v1", credentialEnv: "K" } }, null, 2) + "\n",
    );
    assert.strictEqual(
      buildScaffoldConfig({ ...base, credentialEnv: "K", credentialless: true }),
      JSON.stringify({ ...head, openshell: { baseUrl: "https://x.example/v1", credentialless: true } }, null, 2) + "\n",
    );
  });
});

// ---------------------------------------------------------------------------
// buildJobObject — shared core for setup scaffolds and quickstart jobs
// ---------------------------------------------------------------------------

describe("buildJobObject", () => {
  const core = { jobId: "j1", label: "L", intervalMs: 1000, personaText: "p", model: "m" };

  it("direct OpenAI-compatible jobs carry no openshell block and validate", async () => {
    const { validateOperatorJobConfig } = await import("../dist/operator-config.js");
    const job = buildJobObject({ ...core, provider: "openai-compatible" });
    assert.deepStrictEqual(job, { ...core, provider: "openai-compatible" });
    assert.ok(!("openshell" in job));
    const r = validateOperatorJobConfig(job);
    assert.strictEqual(r.valid, true, JSON.stringify(r.issues));
  });

  it("OpenShell jobs carry exactly one credential choice and validate", async () => {
    const { validateOperatorJobConfig } = await import("../dist/operator-config.js");
    const withEnv = buildJobObject({ ...core, provider: "openai", openshell: { baseUrl: "https://h.example/v1", credentialEnv: "NVIDIA_API_KEY" } });
    assert.deepStrictEqual(withEnv, { ...core, provider: "openai", openshell: { baseUrl: "https://h.example/v1", credentialEnv: "NVIDIA_API_KEY" } });
    assert.strictEqual(validateOperatorJobConfig(withEnv).valid, true);
    const less = buildJobObject({
      ...core, provider: "openai",
      openshell: { baseUrl: "http://host.openshell.internal:8000/v1", credentialEnv: "IGNORED", credentialless: true },
    });
    assert.deepStrictEqual(less.openshell, { baseUrl: "http://host.openshell.internal:8000/v1", credentialless: true });
    assert.strictEqual(validateOperatorJobConfig(less).valid, true);
  });
});

// ---------------------------------------------------------------------------
// buildSetupRecipe / buildOpenShellCommands — shared launch builder
// ---------------------------------------------------------------------------

const tmpRoots = [];
after(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

/** Run `script` under /bin/sh with an inert `openshell` that records argv. */
function runRecorded(script) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sc-os-cli-")));
  tmpRoots.push(dir);
  const log = path.join(dir, "argv.log");
  fs.writeFileSync(
    path.join(dir, "openshell"),
    `#!/bin/sh\n{ for a in "$@"; do printf '%s\\037' "$a"; done; printf '\\036'; } >> "$LOG"\nexit 0\n`,
    { mode: 0o755 },
  );
  const r = spawnSync("/bin/sh", ["-c", script], { cwd: dir, env: { PATH: dir, LOG: log }, encoding: "utf8" });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(dir, "pwned")), "shell metacharacters were executed");
  return fs.readFileSync(log, "utf8").split("\x1e").filter(Boolean).map((c) => c.split("\x1f").slice(0, -1));
}

describe("shared OpenShell launch builder", () => {
  const base = {
    profileFile: "p.yaml", profileId: "nvidia-native", providerName: "nv", image: "img:1",
    sandboxName: "sc-op", policyFile: "policy.vault.yaml",
  };

  it("setup keeps the default detached on-failure launch, job file and verification steps", () => {
    const recipe = buildSetupRecipe(base);
    assert.ok(
      recipe.includes([
        "openshell sandbox create --name 'sc-op' --from 'img:1' \\",
        "  --provider 'nv' --policy 'policy.vault.yaml' \\",
        "  --upload './openshell-op.json:/sandbox/.sportsclaw/operator/openshell-op.json' \\",
        "  --detach --restart-policy on-failure -- node /app/dist/index.js operate --job 'openshell-op'",
      ].join("\n")),
      recipe,
    );
    assert.ok(recipe.includes("# 4. Save the job config (see below) as ./openshell-op.json, then launch"));
    assert.ok(recipe.includes("openshell sandbox provider list 'sc-op'\nopenshell policy get 'sc-op' --full"));
    assert.ok(recipe.includes("#   openshell sandbox provider attach 'sc-op' 'nv' --wait"));
    assert.doesNotMatch(recipe, /--no-keep|--once/);
  });

  it("setup renders exactly the shared builder's commands", () => {
    for (const o of [base, { ...base, credentialless: true, jobId: "tv-op" }]) {
      const recipe = buildSetupRecipe(o);
      const cmds = buildOpenShellCommands(o);
      for (const line of [cmds.profileLint, cmds.profileImport, cmds.providerCreate, cmds.sandboxCreate]) {
        assert.ok(recipe.includes(line), line);
      }
      assert.strictEqual(cmds.jobFile, `./${o.jobId ?? "openshell-op"}.json`);
      assert.strictEqual(/--from-existing/.test(cmds.providerCreate), !o.credentialless);
    }
  });

  it("one-shot launch with an exact custom source path executes as printed", () => {
    const jobFile = "./it's a dir/$(touch pwned) job's.json";
    const o = { ...base, sandboxName: "sb 'x'", image: "r.example/i:t", jobId: "quickstart", jobFile, once: true };
    const cmds = buildOpenShellCommands(o);
    assert.strictEqual(cmds.jobFile, jobFile);
    assert.doesNotMatch(cmds.sandboxCreate, /--detach|--restart-policy/);
    const argvs = runRecorded([cmds.profileLint, cmds.profileImport, cmds.providerCreate, cmds.sandboxCreate].join("\n"));
    assert.deepStrictEqual(argvs, [
      ["profile", "lint", "-f", "p.yaml"],
      ["profile", "import", "-f", "p.yaml"],
      ["provider", "create", "--name", "nv", "--type", "nvidia-native", "--from-existing"],
      [
        "sandbox", "create", "--name", "sb 'x'", "--from", "r.example/i:t",
        "--provider", "nv", "--policy", "policy.vault.yaml",
        "--upload", `${jobFile}:/sandbox/.sportsclaw/operator/quickstart.json`,
        "--no-keep", "--", "node", "/app/dist/index.js", "operate", "--job", "quickstart", "--once",
      ],
    ]);
  });

  it("default (non-once) launch keeps the detached daemon argv", () => {
    const [argv] = runRecorded(buildOpenShellCommands({ ...base, jobId: "tv-op" }).sandboxCreate);
    assert.deepStrictEqual(argv.slice(argv.indexOf("--upload")), [
      "--upload", "./tv-op.json:/sandbox/.sportsclaw/operator/tv-op.json",
      "--detach", "--restart-policy", "on-failure", "--", "node", "/app/dist/index.js", "operate", "--job", "tv-op",
    ]);
  });

  it("rejects invalid job ids even with a custom source path or once", () => {
    for (const jobId of ["../evil", "a b", "it's", ""]) {
      assert.throws(() => buildOpenShellCommands({ ...base, jobId, jobFile: "./ok.json", once: true }), /Invalid job id/, jobId);
    }
  });
});
