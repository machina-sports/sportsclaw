/**
 * `sportsclaw openshell` — doctor + setup recipe for the optional NVIDIA
 * OpenShell 0.1.x integration.
 *
 * Subcommands:
 *   sportsclaw openshell doctor          diagnose prereqs, print remediation hints
 *   sportsclaw openshell doctor --json   machine-readable output
 *     [--image <oci-ref>] [--remote] [--probe]
 *   sportsclaw openshell setup           print a guided, non-mutating recipe
 *
 * Nothing here imports OpenShell as a library; the doctor only shells out to
 * the `openshell` CLI and `docker`, and only when the user explicitly runs
 * `sportsclaw openshell doctor`. Setup is print-only: it runs no probes, never
 * provisions, takes credentials, or writes files.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import pc from "picocolors";

import { JOB_ID_PATTERN } from "./operator-config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** "skipped" = not requested (e.g. local checks under --remote); never a pass. */
export type CheckStatus = "ok" | "missing" | "warn" | "skipped";

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
  /** True when every requested (non-skipped) check has status "ok". */
  allOk: boolean;
}

// ---------------------------------------------------------------------------
// Supported OpenShell range
// ---------------------------------------------------------------------------

/** The release this integration was tested against. */
export const TESTED_OPENSHELL_VERSION = "0.1.5";
const SUPPORTED_RANGE = `>=${TESTED_OPENSHELL_VERSION} <0.2.0`;

/**
 * Extract the full version, including any prerelease suffix, from
 * `openshell --version` output (e.g. "openshell 0.1.5", "openshell 0.1.6-dev").
 */
export function parseOpenShellVersion(stdout: string): string | undefined {
  return /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(stdout)?.[1];
}

/**
 * Accepted range: stable 0.1.x from the tested patch upward. Prereleases,
 * 0.0.x (removed APIs) and 0.2+ are rejected. Only {@link TESTED_OPENSHELL_VERSION}
 * is qualified; newer accepted patches are reported as an unqualified warning.
 * ponytail: patch-only window; widen after qualifying a newer minor.
 */
export function isSupportedOpenShellVersion(version: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) return false;
  const [major, minor, patch] = m.slice(1).map(Number);
  return major === 0 && minor === 1 && patch >= 5;
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

const INSTALL_HINT =
  `Install OpenShell ${TESTED_OPENSHELL_VERSION}: https://github.com/NVIDIA/OpenShell/releases/tag/v${TESTED_OPENSHELL_VERSION}`;

/** Interpret `openshell --version`, rejecting runtimes outside the tested range. */
export function interpretVersionProbe(result: ProbeResult): CheckResult {
  const base = { id: "openshell-cli", label: "OpenShell CLI" };
  if (!result.ok) {
    return { ...base, status: "missing", detail: "not on PATH", hint: INSTALL_HINT };
  }
  const version = parseOpenShellVersion(result.stdout);
  if (!version) {
    return { ...base, status: "missing", detail: "unrecognized version output", hint: INSTALL_HINT };
  }
  if (!isSupportedOpenShellVersion(version)) {
    const hint = version.startsWith("0.0.")
      ? `OpenShell 0.0.x is incompatible. Moving to ${TESTED_OPENSHELL_VERSION} is a migration, not an in-place upgrade: ` +
        "upgrade gateway and CLI together, import provider profiles, recreate every sandbox. See openshell/README.md."
      : version.includes("-")
        ? `Prerelease builds are not supported; install the stable ${TESTED_OPENSHELL_VERSION} release.`
        : `Untested OpenShell release; use ${TESTED_OPENSHELL_VERSION} (accepted: stable ${SUPPORTED_RANGE}).`;
    return { ...base, status: "missing", detail: `openshell ${version} (unsupported; need stable ${SUPPORTED_RANGE})`, hint };
  }
  if (version !== TESTED_OPENSHELL_VERSION) {
    return {
      ...base,
      status: "warn",
      detail: `openshell ${version} (accepted but unqualified; only ${TESTED_OPENSHELL_VERSION} is tested)`,
      hint: `Qualify ${version} on a disposable sandbox before relying on it, or use ${TESTED_OPENSHELL_VERSION}.`,
    };
  }
  return { ...base, status: "ok", detail: `openshell ${version} (tested)` };
}

function checkOpenshellCli(): CheckResult {
  return interpretVersionProbe(probe("openshell", ["--version"]));
}

function checkContainerRuntime(): CheckResult {
  const docker = probe("docker", ["info"]);
  if (docker.ok) {
    return { id: "container-runtime", label: "Container runtime", status: "ok", detail: "docker" };
  }
  const podman = probe("podman", ["info"]);
  if (podman.ok) {
    return { id: "container-runtime", label: "Container runtime", status: "ok", detail: "podman" };
  }
  return {
    id: "container-runtime",
    label: "Container runtime",
    status: "missing",
    detail: "neither docker nor podman responds",
    hint: "Install Docker Desktop or start the daemon, then re-run this check.",
  };
}

const GATEWAY_HINT =
  "Start or provision an OpenShell gateway per the OpenShell docs, then register it with " +
  "`openshell gateway add <endpoint> --name <name>` — registration points the CLI at an existing gateway; it does not start one.";

/** `openshell gateway list -o json` returns a bare JSON array. */
export function parseGatewayListJson(stdout: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout.trim() || "null");
    return Array.isArray(parsed) ? parsed.length : undefined;
  } catch {
    return undefined;
  }
}

function checkGateway(): CheckResult {
  const base = { id: "gateway", label: "OpenShell gateway" };
  const r = probe("openshell", ["gateway", "list", "-o", "json"]);
  const count = r.ok ? parseGatewayListJson(r.stdout) : undefined;
  if (count === undefined) {
    return { ...base, status: "missing", detail: "openshell gateway list failed", hint: GATEWAY_HINT };
  }
  if (count === 0) {
    return { ...base, status: "missing", detail: "no gateway registered", hint: GATEWAY_HINT };
  }
  // Registration only — not a health or provisioning check.
  return { ...base, status: "ok", detail: `${count} registered (not a health check)` };
}

/** Parse documented `openshell provider list --names` output (one name per line). */
export function parseProviderNames(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function checkProvider(): CheckResult {
  const base = { id: "provider", label: "Provider instances" };
  const hint =
    "Import a provider profile and create a provider from it — run `sportsclaw openshell setup` for the exact commands.";
  const r = probe("openshell", ["provider", "list", "--names"]);
  if (!r.ok) {
    return { ...base, status: "missing", detail: "openshell provider list failed (needs a reachable gateway)", hint };
  }
  const names = parseProviderNames(r.stdout);
  if (names.length === 0) {
    return { ...base, status: "missing", detail: "no providers (new gateways ship no profiles)", hint };
  }
  // Attachment is per sandbox; check it with `openshell sandbox provider list <sandbox>`.
  return { ...base, status: "ok", detail: names.join(", ") };
}

/** Inspect `image` with the detected runtime (docker when none responded). */
function checkImage(image: string, runtime: string): CheckResult {
  const base = { id: "image-openshell", label: `${image} image` };
  const r = probe(runtime, ["image", "inspect", image]);
  if (!r.ok) {
    return {
      ...base,
      status: "missing",
      detail: `not in local ${runtime}`,
      hint:
        `${runtime} build -t sportsclaw:latest . && ${runtime} build -t ${shq(image)} -f openshell/Dockerfile .  ` +
        "(source checkout; push to a registry the gateway can pull)",
    };
  }
  // Local presence only; the gateway's engine/registry must also be able to pull it.
  return { ...base, status: "ok", detail: `present in local ${runtime}` };
}

export const DEFAULT_DOCTOR_IMAGE = "sportsclaw-openshell:latest";

/** Interpret the result of a sandbox-creation probe. The OpenShell CLI
 *  can exit 0 even when provisioning times out, so we look at output content
 *  rather than just the exit code. */
export function interpretSandboxProbeResult(result: ProbeResult, image = DEFAULT_DOCTOR_IMAGE): CheckResult {
  const combined = `${result.stdout}\n${result.stderr}`;
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
    return { id: "compute-driver", label: "Compute driver", status: "ok", detail: "sandbox provisions" };
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
    hint: `Run \`openshell sandbox create --from ${shq(image)} --name probe --no-keep -- true\` to see the full error.`,
  };
}

function checkComputeDriver(image: string): CheckResult {
  // Random name so concurrent doctor runs don't collide.
  const name = `sc-doctor-${Math.random().toString(36).slice(2, 10)}`;
  const result = probe(
    "openshell",
    ["sandbox", "create", "--no-keep", "--name", name, "--from", image, "--", "true"],
    45_000,
  );
  // Best-effort cleanup in case --no-keep didn't fire.
  spawnSync("openshell", ["sandbox", "delete", name], { timeout: 10_000, stdio: "ignore" });
  return interpretSandboxProbeResult(result, image);
}

// ---------------------------------------------------------------------------
// Doctor — public surface
// ---------------------------------------------------------------------------

export interface DoctorOptions {
  /** Opt-in live sandbox-provisioning probe (creates a short-lived sandbox). */
  probe?: boolean;
  /** Omit local Docker/Podman/image checks (gateway pulls from a registry). */
  remote?: boolean;
  /** OCI image for local inspection, the probe, and remediation hints. */
  image?: string;
}

export function runChecks(opts: DoctorOptions = {}): DoctorReport {
  const image = opts.image ?? DEFAULT_DOCTOR_IMAGE;
  const skipped = "skipped (--remote): not checked; remote image pull and runtime enforcement are NOT verified";
  const cli = checkOpenshellCli();
  const runtime: CheckResult = opts.remote
    ? { id: "container-runtime", label: "Container runtime", status: "skipped", detail: skipped }
    : checkContainerRuntime();
  const results: CheckResult[] = [
    cli,
    runtime,
    checkGateway(),
    checkProvider(),
    opts.remote
      ? { id: "image-openshell", label: `${image} image`, status: "skipped", detail: skipped }
      : checkImage(image, runtime.detail === "podman" ? "podman" : "docker"),
  ];
  // Active probe is opt-in: it creates a real (short-lived) sandbox.
  if (opts.probe) {
    results.push(checkComputeDriver(image));
  }
  const allOk = results.every((r) => r.status === "ok" || r.status === "skipped");
  return { results, allOk };
}

const MARKERS: Record<CheckStatus, string> = {
  ok: pc.green("✓"),
  missing: pc.red("✗"),
  warn: pc.yellow("!"),
  skipped: pc.dim("-"),
};

/** Pretty-print a DoctorReport. */
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
  const skipped = report.results.filter((r) => r.status === "skipped").length;
  if (report.allOk) {
    lines.push(pc.green(skipped ? `All requested checks passed (${skipped} not checked).` : "All checks passed."));
    lines.push(
      pc.dim(
        "Launch with an explicit provider attachment: openshell sandbox create --from <oci-image> --provider <provider> --policy openshell/policy.vault.yaml --name <name> -- <command>  (see `sportsclaw openshell setup`)",
      ),
    );
  } else {
    const failing = report.results.filter((r) => r.status !== "ok" && r.status !== "skipped").length;
    lines.push(
      pc.yellow(`${failing} check${failing === 1 ? "" : "s"} need attention.`) +
        " Run " +
        pc.bold("sportsclaw openshell setup") +
        " for the step-by-step recipe.",
    );
  }
  return lines.join("\n");
}

async function runDoctor(args: string[]): Promise<void> {
  const i = args.indexOf("--image");
  const image = i === -1 ? undefined : args[i + 1];
  // Validate before any probe runs; the image only ever travels as an argv element.
  if (i !== -1 && (image === undefined || image === "" || image.startsWith("-"))) usageError("Missing value for --image");
  const json = args.includes("--json");
  const report = runChecks({ probe: args.includes("--probe"), remote: args.includes("--remote"), image });
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
  }
  process.exit(report.allOk ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Setup recipe (non-mutating)
// ---------------------------------------------------------------------------

interface ScaffoldOpts {
  jobId: string;
  personaText: string;
  provider: "anthropic" | "openai";
  model: string;
  intervalMs: number;
  baseUrl: string;
  credentialEnv?: string;
  credentialless?: boolean;
}

/** Build the JSON content for an openshell-enabled job config. */
export function buildScaffoldConfig(opts: ScaffoldOpts): string {
  const cfg = {
    jobId: opts.jobId,
    label: `${opts.jobId} (OpenShell)`,
    intervalMs: opts.intervalMs,
    personaText: opts.personaText,
    provider: opts.provider,
    model: opts.model,
    openshell: {
      baseUrl: opts.baseUrl,
      ...(opts.credentialless ? { credentialless: true } : { credentialEnv: opts.credentialEnv }),
    },
  };
  return JSON.stringify(cfg, null, 2) + "\n";
}

export interface SetupRecipeOpts {
  profileFile: string;
  profileId: string;
  providerName: string;
  /** OCI image reference the gateway's container engine can pull. */
  image: string;
  sandboxName: string;
  policyFile: string;
  credentialless?: boolean;
  /** Operator job id; defaults to "openshell-op". */
  jobId?: string;
}

/** POSIX single-quote one shell word. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The ordered 0.1.x commands to bring up a SportsClaw operator sandbox. Every
 * user/config/path value is POSIX-quoted so the text runs as printed. The
 * daemon runs as the sandbox's foreground main process under OpenShell's
 * restart policy — not via `sportsclaw start operator` (a host service manager).
 */
export function buildSetupRecipe(o: SetupRecipeOpts): string {
  const jobId = o.jobId ?? "openshell-op";
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new Error(`Invalid job id ${JSON.stringify(jobId)}: must match ${JOB_ID_PATTERN.source}.`);
  }
  const jobFile = `./${jobId}.json`;
  const sandboxCreate = [
    `openshell sandbox create --name ${shq(o.sandboxName)} --from ${shq(o.image)}`,
    `--provider ${shq(o.providerName)} --policy ${shq(o.policyFile)}`,
    `--upload ${shq(`${jobFile}:/sandbox/.sportsclaw/operator/${jobId}.json`)}`,
    `--detach --restart-policy on-failure -- node /app/dist/index.js operate --job ${shq(jobId)}`,
  ].join(" \\\n  ");
  return [
    "# 0. Gateway: start/provision it per the OpenShell docs. `openshell gateway add` only registers an existing one.",
    "",
    "# 1. Validate and import the provider profile (both need the active gateway; lint does not register).",
    `openshell profile lint -f ${shq(o.profileFile)}`,
    `openshell profile import -f ${shq(o.profileFile)}`,
    "",
    o.credentialless
      ? "# 2. Create the provider instance (credentialless profile)."
      : "# 2. Create the provider instance. --from-existing reads the profile's credential env var from THIS shell.",
    `openshell provider create --name ${shq(o.providerName)} --type ${shq(o.profileId)}` +
      (o.credentialless ? "" : " --from-existing"),
    "",
    "# 3. Build an OCI image and push it where the gateway's engine can pull it (source checkout).",
    "#    docker build -t sportsclaw:latest . && docker build -t <image> -f openshell/Dockerfile . && docker push <image>",
    "",
    `# 4. Save the job config (see below) as ${jobFile}, then launch with the provider attached.`,
    sandboxCreate,
    "",
    "# 5. Verify attachment and the effective policy (provider-derived endpoints included).",
    `openshell sandbox provider list ${shq(o.sandboxName)}`,
    `openshell policy get ${shq(o.sandboxName)} --full`,
    "",
    "# Attach to an already-running sandbox instead (new processes pick it up):",
    `#   openshell sandbox provider attach ${shq(o.sandboxName)} ${shq(o.providerName)} --wait`,
  ].join("\n");
}

/** Base sandbox policies shipped in openshell/. `vault` is the strict default. */
const POLICIES: Record<string, { file: string; note?: string }> = {
  vault: { file: "policy.vault.yaml" },
  "vault-espn": {
    file: "policy.vault-espn.yaml",
    note: "Policy vault-espn adds read-only public ESPN egress for the Python skills.",
  },
  connected: {
    file: "policy.yaml",
    note:
      "WARNING: policy connected grants write-capable Machina MCP access (cloud pods) plus public " +
      "market/news/sports egress (ESPN, Kalshi, Polymarket) and the TV overlay/tail routes. Use it only for " +
      "the connected Sports TV workload.",
  },
};

const PROFILES: Record<string, {
  file: string;
  id: string;
  provider: "openai";
  baseUrl: string;
  model: string;
  credentialEnv?: string;
  credentialless?: boolean;
  /** What attaching this provider adds to the effective policy. */
  boundary: string;
}> = {
  "nvidia-native": {
    file: "nvidia-native.yaml",
    id: "nvidia-native",
    provider: "openai",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    model: "nvidia/nemotron-3-super-120b-a12b",
    credentialEnv: "NVIDIA_API_KEY",
    boundary:
      "Privacy boundary: attaching this hosted provider authorizes external inference egress to " +
      "integrate.api.nvidia.com (prompts leave the box), even though the base policy is local-only.",
  },
  "nim-local": {
    file: "nim-local.yaml",
    id: "sportsclaw-nim-local",
    provider: "openai",
    baseUrl: "http://host.openshell.internal:8000/v1",
    model: "<served-model-id>",
    credentialless: true,
    boundary: "Privacy boundary: this provider reaches only host.openshell.internal:8000 (a host-local NIM).",
  },
};

const SETUP_FLAGS = ["--profile", "--policy", "--provider-name", "--image", "--sandbox", "--job"] as const;

function usageError(message: string): never {
  console.error(message);
  printOpenshellHelp();
  process.exit(2);
}

/** Print-only: renders the recipe; runs no openshell/docker probes (use `doctor`). */
async function runSetup(args: string[]): Promise<void> {
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    if (!(SETUP_FLAGS as readonly string[]).includes(name)) usageError(`Unknown setup option: ${name}`);
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) usageError(`Missing value for ${name}`);
    opts[name] = value;
  }
  const profileKey = opts["--profile"] ?? "nvidia-native";
  const profile = PROFILES[profileKey];
  if (!profile) usageError(`Unknown --profile ${JSON.stringify(profileKey)}. Use one of: ${Object.keys(PROFILES).join(", ")}.`);
  const policyKey = opts["--policy"] ?? "vault";
  const policy = POLICIES[policyKey];
  if (!policy) usageError(`Unknown --policy ${JSON.stringify(policyKey)}. Use one of: ${Object.keys(POLICIES).join(", ")}.`);
  const jobId = opts["--job"] ?? "openshell-op";
  if (!JOB_ID_PATTERN.test(jobId)) usageError(`Invalid --job ${JSON.stringify(jobId)}: must match ${JOB_ID_PATTERN.source}.`);
  const providerName = opts["--provider-name"] ?? `${profileKey}-prod`;
  const image = opts["--image"] ?? "<registry>/sportsclaw-openshell:<tag>";
  const sandboxName = opts["--sandbox"] ?? "sportsclaw-op";
  // Recipes ship in the npm package next to dist/.
  const recipesDir = fileURLToPath(new URL("../openshell/", import.meta.url));

  console.log(pc.bold(`OpenShell setup recipe (${profileKey}, policy ${policyKey}) — review, then run yourself:`));
  console.log(pc.dim(`Tested with OpenShell ${TESTED_OPENSHELL_VERSION} only. Run \`sportsclaw openshell doctor\` to check prerequisites.`));
  console.log("");
  console.log(
    buildSetupRecipe({
      profileFile: `${recipesDir}providers/${profile.file}`,
      profileId: profile.id,
      providerName,
      image,
      sandboxName,
      policyFile: `${recipesDir}${policy.file}`,
      credentialless: profile.credentialless,
      jobId,
    }),
  );
  console.log("");
  console.log(profile.boundary);
  if (policy.note) console.log(policy.note);
  console.log("");
  console.log(pc.bold(`# ${jobId}.json`));
  console.log(
    buildScaffoldConfig({
      jobId,
      personaText: "You are SportsClaw, an autonomous broadcast editor.",
      provider: profile.provider,
      model: profile.model,
      intervalMs: 60_000,
      baseUrl: profile.baseUrl,
      credentialEnv: profile.credentialEnv,
      credentialless: profile.credentialless,
    }),
  );
  console.log(
    pc.dim(
      "Nothing above was executed. Environment markers and route labels are operational checks only; " +
        "network policy and credential enforcement belong to the OpenShell runtime.",
    ),
  );
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printOpenshellHelp(): void {
  console.log([
    `sportsclaw openshell — optional NVIDIA OpenShell helpers (tested: ${TESTED_OPENSHELL_VERSION} only; accepted: stable ${SUPPORTED_RANGE})`,
    "",
    "Usage:",
    "  sportsclaw openshell doctor           Diagnose prereqs, print remediation hints",
    "  sportsclaw openshell doctor --probe   Add a live sandbox-provisioning probe (~45s)",
    "  sportsclaw openshell doctor --json    Machine-readable doctor output",
    "      [--image <oci-ref>]  Image to inspect locally, probe, and name in hints (default sportsclaw-openshell:latest)",
    "      [--remote]           Skip local docker/podman + image checks (reported as not checked, not verified)",
    "  sportsclaw openshell setup            Print a setup recipe (print-only; runs nothing)",
    "      [--profile nvidia-native|nim-local] [--policy vault|vault-espn|connected]",
    "      [--provider-name <name>] [--image <oci-ref>] [--sandbox <name>] [--job <jobId>]",
    "      Default policy: vault (local-only). connected adds write-capable MCP + public egress.",
    "",
    "doctor shells out to `openshell`; local `docker`/`podman` checks are skipped with --remote. Setup only prints commands.",
    "OpenShell remains optional at install for everyone else.",
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
      return runDoctor(rest);
    case "setup":
      return runSetup(rest);
    default:
      console.error(`Unknown openshell subcommand: ${sub}`);
      printOpenshellHelp();
      process.exit(2);
  }
}
