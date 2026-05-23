/**
 * `sportsclaw openshell` — doctor + setup wizard for the optional
 * NVIDIA OpenShell integration.
 *
 * Subcommands:
 *   sportsclaw openshell doctor          diagnose prereqs, print remediation hints
 *   sportsclaw openshell doctor --json   machine-readable output
 *   sportsclaw openshell setup           guided interactive installer
 *
 * The wizard NEVER imports OpenShell as a library — it only shells out
 * to the `openshell` CLI binary and `docker`. That keeps the engine's
 * optional-at-install promise intact: nothing in this file runs unless
 * the user explicitly invokes `sportsclaw openshell ...`.
 */

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

import pc from "picocolors";

import {
  operatorConfigDir,
  operatorConfigPath,
} from "./operator-config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckStatus = "ok" | "missing" | "warn";

export interface CheckResult {
  /** Stable id for the check (e.g. "openshell-cli"). */
  id: string;
  /** Human-readable label. */
  label: string;
  status: CheckStatus;
  /** Free-text detail (version string, "not found", etc.). */
  detail?: string;
  /** Concrete command/action the user should take when status !== "ok". */
  hint?: string;
}

export interface DoctorReport {
  results: CheckResult[];
  /** True when every check has status "ok". */
  allOk: boolean;
}

// ---------------------------------------------------------------------------
// Process probes (small, side-effect-free, no throws)
// ---------------------------------------------------------------------------

export interface ProbeResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True when spawnSync killed the process because the timeout elapsed.
   *  For the sandbox-creation probe this is the actual signal we want:
   *  a healthy driver finishes in seconds, so any timeout is a hang. */
  timedOut: boolean;
}

function probe(cmd: string, args: string[], timeoutMs = 5_000): ProbeResult {
  const out = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // spawnSync kills the child with SIGTERM on timeout — status becomes null
  // and signal is set. We don't get a distinct error code, so use signal
  // presence as the timeout discriminator.
  const timedOut = out.status === null && out.signal != null;
  return {
    ok: out.status === 0,
    stdout: out.stdout ?? "",
    stderr: out.stderr ?? "",
    exitCode: out.status,
    timedOut,
  };
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkOpenshellCli(): CheckResult {
  const r = probe("openshell", ["--version"]);
  if (!r.ok) {
    return {
      id: "openshell-cli",
      label: "OpenShell CLI",
      status: "missing",
      detail: "not on PATH",
      hint: "curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh",
    };
  }
  const version = r.stdout.trim() || "(version not reported)";
  return { id: "openshell-cli", label: "OpenShell CLI", status: "ok", detail: version };
}

function checkContainerRuntime(): CheckResult {
  const docker = probe("docker", ["info"]);
  if (docker.ok) {
    return {
      id: "container-runtime",
      label: "Container runtime",
      status: "ok",
      detail: "docker",
    };
  }
  const podman = probe("podman", ["info"]);
  if (podman.ok) {
    return {
      id: "container-runtime",
      label: "Container runtime",
      status: "ok",
      detail: "podman",
    };
  }
  return {
    id: "container-runtime",
    label: "Container runtime",
    status: "missing",
    detail: "neither docker nor podman responds",
    hint: "Install Docker Desktop or start the daemon, then re-run this check.",
  };
}

function checkGateway(): CheckResult {
  const r = probe("openshell", ["gateway", "list", "-o", "json"]);
  if (!r.ok) {
    return {
      id: "gateway",
      label: "OpenShell gateway",
      status: "missing",
      detail: "no gateway registered",
      hint: "openshell gateway add http://127.0.0.1:18080 --local --name local && openshell gateway select local",
    };
  }
  // Parsing best-effort — output shape can change across versions.
  const out = r.stdout.trim();
  if (!out || out === "[]" || out === "null") {
    return {
      id: "gateway",
      label: "OpenShell gateway",
      status: "missing",
      detail: "list is empty",
      hint: "openshell gateway add http://127.0.0.1:18080 --local --name local && openshell gateway select local",
    };
  }
  return { id: "gateway", label: "OpenShell gateway", status: "ok", detail: "registered" };
}

// OpenShell 0.0.47 prints colorized output that wraps fields like
// "Provider:" in ANSI escape sequences. Strip them before regex matching,
// otherwise `\S+` captures `\033[0m` as the "value".
const ANSI_REGEX = /\x1B\[[0-?]*[ -/]*[@-~]/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

/** Parse the human-readable `openshell provider list` table. v0.0.47 has
 *  no `-o json` flag on this subcommand, so we count non-blank lines:
 *  header alone → no providers; header + ≥1 data row → providers exist. */
export function parseProviderListOutput(stdout: string): { hasProviders: boolean } {
  const lines = stripAnsi(stdout)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return { hasProviders: lines.length >= 2 };
}

/** Parse `openshell inference get` output. Looks at the first section
 *  (Gateway inference) since that's the one the Privacy Router uses to
 *  route inference.local traffic. Returns empty fields when neither a
 *  Provider nor Model line appears — "Not configured" sections naturally
 *  produce that result without a special case. */
export function parseInferenceGetOutput(stdout: string): {
  provider?: string;
  model?: string;
} {
  // Scope to the Gateway inference section so a "Not configured" System
  // inference block doesn't accidentally satisfy the regex.
  const clean = stripAnsi(stdout);
  const gatewaySection = clean.split(/^\s*System inference:/im)[0];
  const provider = /Provider:\s*(\S+)/.exec(gatewaySection)?.[1];
  const model = /Model:\s*(\S+)/.exec(gatewaySection)?.[1];
  return { provider, model };
}

function checkProvider(): CheckResult {
  const r = probe("openshell", ["provider", "list"]);
  if (!r.ok) {
    return {
      id: "provider",
      label: "Inference provider",
      status: "missing",
      detail: "openshell provider list failed",
      hint: "openshell provider create --name <name> --type <anthropic|openai|nvidia> --from-existing",
    };
  }
  const { hasProviders } = parseProviderListOutput(r.stdout);
  if (!hasProviders) {
    return {
      id: "provider",
      label: "Inference provider",
      status: "missing",
      detail: "no providers configured",
      hint: "openshell provider create --name <name> --type <anthropic|openai|nvidia> --from-existing",
    };
  }
  return {
    id: "provider",
    label: "Inference provider",
    status: "ok",
    detail: "at least one provider registered",
  };
}

function checkInferenceRouting(): CheckResult {
  const r = probe("openshell", ["inference", "get"]);
  if (!r.ok) {
    return {
      id: "inference-routing",
      label: "Inference routing",
      status: "missing",
      detail: "openshell inference get failed",
      hint: "openshell inference set --provider <name> --model <model> --timeout 300",
    };
  }
  const { provider, model } = parseInferenceGetOutput(r.stdout);
  if (!provider || !model) {
    return {
      id: "inference-routing",
      label: "Inference routing",
      status: "missing",
      detail: "no provider/model pinned",
      hint: "openshell inference set --provider <name> --model <model> --timeout 300",
    };
  }
  return {
    id: "inference-routing",
    label: "Inference routing",
    status: "ok",
    detail: `${provider} / ${model}`,
  };
}

function checkImage(image: string, id: string, label: string, buildHint: string): CheckResult {
  const r = probe("docker", ["image", "inspect", image]);
  if (!r.ok) {
    return { id, label, status: "missing", detail: "not built", hint: buildHint };
  }
  return { id, label, status: "ok", detail: "present" };
}

/** Interpret the result of a sandbox-creation probe. The OpenShell CLI
 *  exits 0 even when provisioning times out, so we look at output content
 *  rather than just the exit code. Catches the case where the gateway is
 *  up but no compute driver is registered — the symptom we hit in e2e
 *  testing on 2026-05-23. */
export function interpretSandboxProbeResult(result: ProbeResult): CheckResult {
  const combined = `${result.stdout}\n${result.stderr}`;
  // Driver-missing manifests as either:
  //  (a) the CLI printing its own "supervisor relay" timeout after ~300s
  //  (b) our 45s probe killing the CLI before it gets a chance to print
  // Both mean the same thing: no compute driver picked up the request.
  if (
    result.timedOut ||
    /supervisor relay|DependenciesNotReady|provisioning timed out/i.test(combined)
  ) {
    return {
      id: "compute-driver",
      label: "Compute driver",
      status: "missing",
      detail: "sandbox provisioning hangs — no compute driver",
      hint: "Restart the OpenShell service: `brew services restart nvidia/openshell/openshell`. If sandboxes still hang, the openshell-driver-vm may need separate setup — see https://github.com/NVIDIA/OpenShell.",
    };
  }
  if (result.ok) {
    return {
      id: "compute-driver",
      label: "Compute driver",
      status: "ok",
      detail: "sandbox provisions",
    };
  }
  const firstError =
    combined
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /^(error|✗)/i.test(l)) ?? "";
  return {
    id: "compute-driver",
    label: "Compute driver",
    status: "missing",
    detail: firstError.slice(0, 120) || `sandbox create failed (exit ${result.exitCode ?? "?"})`,
    hint: "Run `openshell sandbox create --from sportsclaw:latest --name probe --no-keep -- true` to see the full error.",
  };
}

function checkComputeDriver(): CheckResult {
  // Random name so concurrent doctor runs don't collide.
  const name = `sc-doctor-${Math.random().toString(36).slice(2, 10)}`;
  // `--no-keep` auto-deletes after the command exits cleanly, but if
  // provisioning hangs we never reach that exit and the sandbox lingers in
  // Provisioning forever. 45s probe timeout: longer than typical provisioning,
  // shorter than the gateway's 300s patience.
  const result = probe(
    "openshell",
    ["sandbox", "create", "--no-keep", "--name", name, "--from", "sportsclaw:latest", "--", "true"],
    45_000,
  );
  // Best-effort cleanup. Always run — even on success, just in case --no-keep
  // didn't fire. spawnSync ignores its own non-zero exits via stdio: ignore.
  spawnSync("openshell", ["sandbox", "delete", name], {
    timeout: 10_000,
    stdio: "ignore",
  });
  return interpretSandboxProbeResult(result);
}

function checkApiKey(): CheckResult {
  const candidates = [
    { name: "ANTHROPIC_API_KEY", prov: "anthropic" },
    { name: "OPENAI_API_KEY", prov: "openai" },
    { name: "NVIDIA_API_KEY", prov: "nvidia" },
  ];
  for (const c of candidates) {
    if ((process.env[c.name] ?? "").trim().length > 0) {
      return {
        id: "api-key",
        label: "Provider API key",
        status: "ok",
        detail: `${c.name} set (${c.prov})`,
      };
    }
  }
  return {
    id: "api-key",
    label: "Provider API key",
    status: "warn",
    detail: "none of ANTHROPIC_API_KEY / OPENAI_API_KEY / NVIDIA_API_KEY set",
    hint: "Export one of those env vars before running `openshell provider create --from-existing`.",
  };
}

// ---------------------------------------------------------------------------
// Doctor — public surface (exported for testing the formatter)
// ---------------------------------------------------------------------------

export function runChecks(opts: { probe?: boolean } = {}): DoctorReport {
  const results: CheckResult[] = [
    checkOpenshellCli(),
    checkContainerRuntime(),
    checkGateway(),
    checkProvider(),
    checkInferenceRouting(),
    checkImage(
      "sportsclaw:latest",
      "image-base",
      "sportsclaw:latest image",
      "docker build -t sportsclaw:latest .",
    ),
    checkImage(
      "sportsclaw-openshell:latest",
      "image-openshell",
      "sportsclaw-openshell:latest image",
      "docker build -t sportsclaw-openshell:latest -f openshell/Dockerfile .",
    ),
    checkApiKey(),
  ];
  // Active probe is opt-in: it creates a real (short-lived) sandbox and adds
  // up to 45s to doctor runtime. The other checks are passive and finish
  // in well under a second.
  if (opts.probe) {
    results.push(checkComputeDriver());
  }
  const allOk = results.every((r) => r.status === "ok");
  return { results, allOk };
}

const MARKERS: Record<CheckStatus, string> = {
  ok: pc.green("✓"),
  missing: pc.red("✗"),
  warn: pc.yellow("!"),
};

/** Pretty-print a DoctorReport to stdout. */
export function formatReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(pc.bold("sportsclaw openshell doctor"));
  lines.push("");
  const labelWidth = Math.max(...report.results.map((r) => r.label.length), 16);
  for (const r of report.results) {
    const marker = MARKERS[r.status];
    const label = r.label.padEnd(labelWidth + 2);
    const detail = r.detail ? pc.dim(r.detail) : "";
    lines.push(`  ${marker} ${label}${detail}`);
    if (r.status !== "ok" && r.hint) {
      lines.push(`      ${pc.dim("→")} ${r.hint}`);
    }
  }
  lines.push("");
  if (report.allOk) {
    lines.push(pc.green("All checks passed."));
    lines.push(
      pc.dim(
        "Create a sandbox with: openshell sandbox create --from sportsclaw-openshell:latest --policy openshell/policy.yaml --name <name>",
      ),
    );
  } else {
    const failing = report.results.filter((r) => r.status !== "ok").length;
    lines.push(
      pc.yellow(`${failing} check${failing === 1 ? "" : "s"} need attention.`) +
        " Run " +
        pc.bold("sportsclaw openshell setup") +
        " to fix interactively.",
    );
  }
  return lines.join("\n");
}

async function runDoctor(opts: { json: boolean; probe: boolean }): Promise<void> {
  const report = runChecks({ probe: opts.probe });
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }
  process.exit(report.allOk ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Setup wizard
// ---------------------------------------------------------------------------

function shellOut(cmd: string, args: string[], opts: { allowFailure?: boolean } = {}): boolean {
  console.log(pc.dim(`$ ${cmd} ${args.join(" ")}`));
  const out = spawnSync(cmd, args, { stdio: "inherit" });
  if (out.status !== 0 && !opts.allowFailure) {
    console.error(pc.red(`Command failed: ${cmd} ${args.join(" ")} (exit ${out.status})`));
    return false;
  }
  return out.status === 0;
}

async function confirm(rl: ReturnType<typeof createInterface>, prompt: string): Promise<boolean> {
  const answer = (await rl.question(`${prompt} [Y/n] `)).trim().toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}

async function ask(rl: ReturnType<typeof createInterface>, prompt: string, def?: string): Promise<string> {
  const suffix = def ? ` [${def}]` : "";
  const v = (await rl.question(`${prompt}${suffix}: `)).trim();
  return v || def || "";
}

async function fixOpenshellCli(rl: ReturnType<typeof createInterface>): Promise<boolean> {
  console.log(pc.bold("\nOpenShell CLI is not installed."));
  console.log(pc.dim("Source: https://github.com/NVIDIA/OpenShell"));
  if (!(await confirm(rl, "Install it now via the official install.sh?"))) {
    console.log(pc.yellow("Skipped — install manually before continuing."));
    return false;
  }
  // The official one-liner pipes curl into sh. We replicate via spawn so
  // the user sees the output.
  return shellOut("sh", ["-c", "curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh"]);
}

async function fixGateway(rl: ReturnType<typeof createInterface>): Promise<boolean> {
  console.log(pc.bold("\nNo OpenShell gateway registered."));
  if (!(await confirm(rl, "Register a local gateway at http://127.0.0.1:18080?"))) {
    return false;
  }
  if (!shellOut("openshell", ["gateway", "add", "http://127.0.0.1:18080", "--local", "--name", "local"])) {
    return false;
  }
  return shellOut("openshell", ["gateway", "select", "local"]);
}

async function fixProvider(rl: ReturnType<typeof createInterface>): Promise<boolean> {
  console.log(pc.bold("\nNo inference provider configured."));
  console.log("Which provider?");
  console.log("  1) anthropic  (uses ANTHROPIC_API_KEY)");
  console.log("  2) openai     (uses OPENAI_API_KEY)");
  console.log("  3) nvidia     (uses NVIDIA_API_KEY, NVIDIA API Catalog)");
  const choice = await ask(rl, "Pick 1/2/3", "1");
  const map: Record<string, { type: string; env: string; defaultModel: string }> = {
    "1": { type: "anthropic", env: "ANTHROPIC_API_KEY", defaultModel: "claude-opus-4-6" },
    "2": { type: "openai", env: "OPENAI_API_KEY", defaultModel: "gpt-4.1" },
    "3": { type: "nvidia", env: "NVIDIA_API_KEY", defaultModel: "nvidia/nemotron-3-super-120b" },
  };
  const pick = map[choice];
  if (!pick) {
    console.log(pc.red(`Unknown choice ${JSON.stringify(choice)}.`));
    return false;
  }
  if (!(process.env[pick.env] ?? "").trim()) {
    console.log(
      pc.yellow(
        `${pick.env} is not set in your environment. Export it first, then re-run setup.`,
      ),
    );
    return false;
  }
  const name = (await ask(rl, "Provider record name", `${pick.type}-prod`)).trim();
  if (!shellOut("openshell", ["provider", "create", "--name", name, "--type", pick.type, "--from-existing"])) {
    return false;
  }
  const model = await ask(rl, "Model to pin", pick.defaultModel);
  return shellOut("openshell", [
    "inference", "set", "--provider", name, "--model", model, "--timeout", "300",
  ]);
}

async function fixBaseImage(rl: ReturnType<typeof createInterface>): Promise<boolean> {
  console.log(pc.bold("\nsportsclaw:latest image not built."));
  console.log(pc.dim("This builds the root sportsclaw image. Takes several minutes."));
  if (!(await confirm(rl, "Build it now?"))) return false;
  return shellOut("docker", ["build", "-t", "sportsclaw:latest", "."]);
}

async function fixOpenshellImage(rl: ReturnType<typeof createInterface>): Promise<boolean> {
  console.log(pc.bold("\nsportsclaw-openshell:latest image not built."));
  console.log(pc.dim("Thin downstream image layering a sandbox user onto sportsclaw:latest."));
  if (!(await confirm(rl, "Build it now?"))) return false;
  return shellOut("docker", ["build", "-t", "sportsclaw-openshell:latest", "-f", "openshell/Dockerfile", "."]);
}

interface ScaffoldOpts {
  jobId: string;
  personaText: string;
  provider: "anthropic" | "openai";
  model: string;
  intervalMs: number;
}

/** Build the JSON content for a scaffolded openshell-enabled job config. */
export function buildScaffoldConfig(opts: ScaffoldOpts): string {
  const cfg = {
    jobId: opts.jobId,
    label: `${opts.jobId} (OpenShell)`,
    intervalMs: opts.intervalMs,
    personaText: opts.personaText,
    provider: opts.provider,
    model: opts.model,
    openshell: {},
  };
  return JSON.stringify(cfg, null, 2) + "\n";
}

async function offerScaffold(rl: ReturnType<typeof createInterface>): Promise<void> {
  console.log(pc.bold("\nScaffold a starter job config?"));
  if (!(await confirm(rl, "Create a sample openshell-enabled job in ~/.sportsclaw/operator/?"))) {
    return;
  }
  const jobId = (await ask(rl, "Job id (filename basename)", "openshell-tv")).trim();
  if (!/^[A-Za-z0-9._-]+$/.test(jobId)) {
    console.log(pc.red(`Invalid jobId ${JSON.stringify(jobId)}.`));
    return;
  }
  const filePath = operatorConfigPath(jobId);
  if (fs.existsSync(filePath)) {
    console.log(pc.yellow(`${filePath} already exists — not overwriting.`));
    return;
  }
  fs.mkdirSync(operatorConfigDir(), { recursive: true });
  const provider = ((await ask(rl, "Provider (anthropic/openai)", "anthropic")).trim() as "anthropic" | "openai");
  const defaultModel = provider === "openai" ? "gpt-4.1" : "claude-opus-4-6";
  const model = (await ask(rl, "Model id", defaultModel)).trim();
  const personaText =
    (await ask(rl, "Persona (one-line, will be embedded in the system prompt)",
      "You are SportsClaw, an autonomous broadcast editor.")).trim();
  const content = buildScaffoldConfig({
    jobId,
    personaText,
    provider: provider === "openai" ? "openai" : "anthropic",
    model,
    intervalMs: 60_000,
  });
  fs.writeFileSync(filePath, content, "utf8");
  console.log(pc.green(`Wrote ${filePath}`));
  console.log(
    pc.dim("Validate with: sportsclaw operate --validate " + jobId),
  );
}

async function runSetup(): Promise<void> {
  console.log(pc.bold("sportsclaw openshell setup"));
  console.log("");
  let report = runChecks();
  console.log(formatReport(report));
  console.log("");
  if (report.allOk) {
    console.log(pc.green("Nothing to fix."));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await offerScaffold(rl);
    } finally {
      rl.close();
    }
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // Sequential dependency: CLI → runtime → gateway → provider → inference → image.
    // We re-check after each fix because earlier fixes can unblock later ones.
    const fixers: Array<{ id: string; fn: () => Promise<boolean> }> = [
      { id: "openshell-cli", fn: () => fixOpenshellCli(rl) },
      {
        id: "container-runtime",
        fn: async () => {
          console.log(pc.yellow("Docker / Podman must be started manually — install Docker Desktop or run `sudo systemctl start docker`, then re-run this wizard."));
          return false;
        },
      },
      { id: "gateway", fn: () => fixGateway(rl) },
      { id: "provider", fn: () => fixProvider(rl) },
      { id: "image-base", fn: () => fixBaseImage(rl) },
      { id: "image-openshell", fn: () => fixOpenshellImage(rl) },
    ];

    for (const fx of fixers) {
      report = runChecks();
      const failing = report.results.find((r) => r.id === fx.id && r.status !== "ok");
      if (!failing) continue;
      const ok = await fx.fn();
      if (!ok) {
        console.log(pc.yellow(`Skipping remaining steps — fix \"${fx.id}\" first, then re-run.`));
        return;
      }
    }

    report = runChecks();
    console.log("");
    console.log(formatReport(report));
    console.log("");
    if (report.allOk) {
      await offerScaffold(rl);
      console.log("");
      console.log(pc.green("Setup complete."));
      console.log(pc.dim("Next: openshell sandbox create --from sportsclaw-openshell:latest --policy openshell/policy.yaml --name <name>"));
      console.log(pc.dim("Then:  openshell sandbox upload <name> ~/.sportsclaw/operator/<jobId>.json /sandbox/.sportsclaw/operator/<jobId>.json"));
      console.log(pc.dim("And:   openshell sandbox exec -n <name> -- node /app/dist/index.js operate --job <jobId> --once"));
    } else {
      console.log(pc.yellow("Some checks still fail. Re-run the wizard after fixing them manually."));
    }
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printOpenshellHelp(): void {
  console.log([
    "sportsclaw openshell — optional NVIDIA OpenShell helpers",
    "",
    "Usage:",
    "  sportsclaw openshell doctor           Diagnose prereqs, print remediation hints",
    "  sportsclaw openshell doctor --probe   Add a live sandbox-provisioning probe (~45s)",
    "  sportsclaw openshell doctor --json    Machine-readable doctor output",
    "  sportsclaw openshell setup            Interactive wizard: install, gateway, provider, image, scaffold",
    "",
    "Both subcommands shell out to the `openshell` binary and `docker`; nothing is",
    "imported as a library. OpenShell remains optional at install for everyone else.",
    "",
    "Background: openshell/README.md  |  docs/openshell-integration-plan.md",
  ].join("\n"));
}

// ---------------------------------------------------------------------------
// Public entry — dispatcher
// ---------------------------------------------------------------------------

export async function cmdOpenshell(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    printOpenshellHelp();
    return;
  }
  switch (sub) {
    case "doctor":
      return runDoctor({
        json: rest.includes("--json"),
        probe: rest.includes("--probe"),
      });
    case "setup":
      return runSetup();
    default:
      console.error(`Unknown openshell subcommand: ${sub}`);
      printOpenshellHelp();
      process.exit(2);
  }
}
