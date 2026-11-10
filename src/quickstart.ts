/**
 * `sportsclaw quickstart` — offline launch bundle for a self-chosen hosted model.
 *
 *   sportsclaw quickstart --host brev|nim --model <id> --out <new-dir>
 *     [--endpoint <url>] [--served-model <id>] [--tool-parser <name>] [--revision <rev>]
 *     [--openshell --image <oci-ref>]
 *
 * Writes a README, the portable hosted-models guide, a one-shot operator job,
 * run/launch scripts and (for Brev) a thin vLLM template into a NEW directory.
 * Generation is local-only: no network calls, probes or subprocesses, and no
 * saved SportsClaw config or credential env is read. Deploying stays with the
 * operator, using Brev / vLLM / OpenShell's native tools.
 */

import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { nativeBaseUrlProblem } from "./openshell-native.js";
import { buildJobObject, buildOpenShellCommands, TESTED_OPENSHELL_VERSION } from "./openshell-cli.js";

const JOB_ID = "quickstart";
const OPENSHELL_NAME = "sportsclaw-quickstart";
const NIM_ENDPOINT = "https://integrate.api.nvidia.com/v1";
const BREV_TUNNEL_ENDPOINT = "http://127.0.0.1:8000/v1";
const HOST_BRIDGE = "host.openshell.internal";
const JOB_FILE = `.sportsclaw/operator/${JOB_ID}.json`;
const GUIDE_FILE = "skills/hosted-models/SKILL.md";

const CONTROL = /[\u0000-\u001f\u007f]/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/:+-]{0,199}$/;
const PARSER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
// scheme://host[:port][/plain/path] — no userinfo, query, fragment, wildcard,
// percent-encoding, backslash or dot segments.
const ENDPOINT_SHAPE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)*\/?$/;
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const VALUE_FLAGS = new Set([
  "--host", "--model", "--out", "--endpoint", "--image", "--served-model", "--tool-parser", "--revision",
]);
const BREV_ONLY = ["--served-model", "--tool-parser", "--revision"] as const;

export class QuickstartUsageError extends Error {}

function fail(message: string): never {
  throw new QuickstartUsageError(message);
}

export interface QuickstartOptions {
  host: "brev" | "nim";
  /** Hugging Face repo id (brev) or served API model id (nim). */
  model: string;
  /** Model id clients send; the vLLM alias for brev, `model` for nim. */
  servedModel: string;
  out: string;
  /** Normalized OpenAI-compatible base URL, no trailing slash. */
  endpoint: string;
  openshell: boolean;
  image?: string;
  toolParser?: string;
  revision?: string;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/** Name a bad argument without echoing a value (it may carry a credential). */
function describeArg(arg: string): string {
  return /^--?[A-Za-z][A-Za-z-]*$/.test(arg) ? arg : "(value redacted)";
}

export function parseQuickstartArgs(args: string[]): QuickstartOptions | "help" {
  if (args.some((a) => CONTROL.test(a))) fail("arguments must not contain control characters");
  const values = new Map<string, string>();
  let openshell = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") return "help";
    if (arg === "--openshell") {
      if (openshell) fail("duplicate option --openshell");
      openshell = true;
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) fail(`unknown argument ${describeArg(arg)}`);
    if (values.has(arg)) fail(`duplicate option ${arg}`);
    const value = args[++i];
    if (value === undefined || value === "" || value.startsWith("-")) fail(`missing value for ${arg}`);
    values.set(arg, value);
  }

  const host = values.get("--host");
  if (host === undefined) fail("--host is required (brev or nim)");
  if (host !== "brev" && host !== "nim") fail("--host must be brev or nim");
  const model = values.get("--model");
  if (model === undefined) fail("--model is required");
  if (!MODEL_ID.test(model)) fail("--model must be a model id (letters, digits and . _ / : + -)");
  const out = values.get("--out");
  if (out === undefined) fail("--out <new-directory> is required");

  if (host === "nim") {
    if (values.has("--endpoint")) fail(`--endpoint is fixed for --host nim (${NIM_ENDPOINT})`);
    for (const flag of BREV_ONLY) if (values.has(flag)) fail(`${flag} applies to --host brev only`);
  }
  const servedModel = values.get("--served-model") ?? model;
  if (!MODEL_ID.test(servedModel)) fail("--served-model must be a model id (letters, digits and . _ / : + -)");
  const toolParser = values.get("--tool-parser");
  if (toolParser !== undefined && !PARSER.test(toolParser)) fail("--tool-parser must be a vLLM parser name");
  const revision = values.get("--revision");
  if (revision !== undefined && !REVISION.test(revision)) fail("--revision must be a branch, tag or commit");

  const image = values.get("--image");
  if (openshell && image === undefined) fail("--image <oci-ref> is required with --openshell");
  if (!openshell && image !== undefined) fail("--image applies to --openshell only");
  if (image !== undefined && !IMAGE_REF.test(image)) fail("--image must be an OCI image reference");

  let endpoint: string;
  const rawEndpoint = values.get("--endpoint");
  if (host === "nim") {
    endpoint = NIM_ENDPOINT;
  } else if (rawEndpoint === undefined) {
    if (openshell) {
      fail(
        "--endpoint is required with --host brev --openshell: a sandbox cannot reach your loopback SSH tunnel, " +
          "so give an authenticated HTTPS endpoint or the host bridge you arranged",
      );
    }
    endpoint = BREV_TUNNEL_ENDPOINT;
  } else {
    endpoint = checkEndpoint(rawEndpoint, openshell);
  }

  return { host, model, servedModel, out, endpoint, openshell, image, toolParser, revision };
}

/** `localhost` or a real IPv4 literal in 127/8 (not a DNS name like 127.attacker.example). */
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || (isIP(hostname) === 4 && hostname.startsWith("127."));
}

/** Anything that resolves to this machine rather than a sandbox-reachable host. */
function isLocalOnly(hostname: string): boolean {
  return isLoopback(hostname) || hostname.endsWith(".localhost") || hostname === "0.0.0.0";
}

/** Validate a Brev endpoint. Errors never include the value. */
function checkEndpoint(raw: string, openshell: boolean): string {
  const bad = (why: string): never => fail(`--endpoint ${why}`);
  if (raw.includes("@")) bad("must not embed credentials");
  if (raw.includes("?") || raw.includes("#")) bad("must not include a query string or fragment");
  if (/[*%]/.test(raw)) bad("must not contain wildcards or percent-encoding");
  if (!ENDPOINT_SHAPE.test(raw)) bad("must look like https://host[:port]/api/base with a plain path");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return bad("is not a valid URL");
  }
  const hostname = url.hostname.toLowerCase();
  if (!hostname.split(".").every((label) => HOST_LABEL.test(label))) bad("has an invalid host name");
  const https = url.protocol === "https:";
  if (openshell) {
    if (isLocalOnly(hostname)) bad("must be reachable from the sandbox (not localhost/loopback)");
    if (!https && hostname !== HOST_BRIDGE) bad(`must use https (plain http only for ${HOST_BRIDGE})`);
    const problem = nativeBaseUrlProblem(raw);
    if (problem) bad(problem);
  } else if (!https && !isLoopback(hostname)) {
    bad("must use https for a remote host (plain http only for a loopback tunnel)");
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

// ---------------------------------------------------------------------------
// Bundle rendering (pure)
// ---------------------------------------------------------------------------

export interface BundleFile {
  path: string;
  content: string;
  mode: 0o600 | 0o700;
}

/** POSIX single-quote one shell word. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Reject malformed bearer keys before a child can trim or substitute them. */
function requireKey(name: string, message: string): string[] {
  return [
    "# Bearer keys must be nonempty printable ASCII without whitespace.",
    "# Fix the locale so Unicode whitespace cannot bypass byte classification.",
    "export LC_ALL=C",
    `if [[ ! "\${${name}:-}" =~ ^[!-~]+$ ]]; then`,
    `  echo ${shq(message)} >&2; exit 2`,
    "fi",
  ];
}

function credentialEnv(o: QuickstartOptions): "NVIDIA_API_KEY" | "VLLM_API_KEY" {
  return o.host === "nim" ? "NVIDIA_API_KEY" : "VLLM_API_KEY";
}

function guideBody(guide: string): string {
  return guide.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

export function buildQuickstartJob(o: QuickstartOptions, guide: string): Record<string, unknown> {
  const personaText = [
    "You are SportsClaw running a one-shot readiness check of a newly connected model for the operator.",
    `Route: ${o.host === "nim" ? "NVIDIA API" : "Brev/vLLM"}${o.openshell ? " inside an OpenShell sandbox" : ""}, model "${o.servedModel}".`,
    "No sports data tools, MCP servers or memory are loaded in this run. Do not invent scores, odds, schedules, injuries or any other sports facts.",
    "Reply in at most five short plain-text lines: confirm you received this request, name the configured model id, " +
      "and say that this proves only a basic chat round-trip; the bounded tool-call check and the operator's own data/quality " +
      "validation from the guide below are still required.",
    "",
    "Operator deployment guide (reference only; it is not a request for you to perform these steps):",
    "",
    guideBody(guide),
  ].join("\n");
  const route = o.openshell
    ? ({ provider: "openai", openshell: { baseUrl: o.endpoint, credentialEnv: credentialEnv(o) } } as const)
    : ({ provider: "openai-compatible" } as const);
  return {
    ...buildJobObject({
      jobId: JOB_ID,
      label: `Hosted-model quickstart (${o.host}${o.openshell ? ", OpenShell" : ""})`,
      intervalMs: 300_000,
      personaText,
      model: o.servedModel,
      ...route,
    }),
    // Smoke-run bounds layered on the shared core (no core field is overridden).
    inferenceTimeoutMs: 120_000,
    maxSteps: 2,
    maxOutputTokens: 1024,
    persistence: false,
    enableMemoryTools: false,
    skills: [],
    rootDir: `~/.sportsclaw/operator/${JOB_ID}`,
    tickPrompt: "Readiness check at {timestamp}. Answer as your role instructs, in plain text. Do not reply [SILENT].",
  };
}

function renderServe(o: QuickstartOptions): string {
  const vllmArgs = [
    `--model ${shq(o.model)}`,
    `--served-model-name ${shq(o.servedModel)}`,
    "--host 0.0.0.0 --port 8000",
    ...(o.revision ? [`--revision ${shq(o.revision)}`] : []),
    ...(o.toolParser ? [`--enable-auto-tool-choice --tool-call-parser ${shq(o.toolParser)}`] : []),
    '"$@"',
  ];
  return [
    "#!/usr/bin/env bash",
    "# Generated by `sportsclaw quickstart`. Thin vLLM template: run it ON the Brev GPU machine.",
    "# One foreground container: Ctrl-C stops it and --rm removes it. It provisions, restarts and",
    "# cleans up nothing else, and it is not a GPU or model-compatibility claim.",
    "#",
    "# Required env: VLLM_IMAGE    official vllm/vllm-openai tag or digest you reviewed",
    "#               VLLM_API_KEY  clients must send it as the bearer token",
    "# Optional env: HF_TOKEN      gated/private Hugging Face repos",
    "# Extra arguments go to vLLM unchanged, e.g. ./serve.sh --max-model-len 32768",
    "# (add --trust-remote-code only after reviewing that model's code).",
    "set -euo pipefail",
    "",
    'if [ -z "${VLLM_IMAGE:-}" ]; then',
    '  echo "serve.sh: set VLLM_IMAGE to the vllm/vllm-openai tag or digest you reviewed (https://docs.vllm.ai/en/stable/deployment/docker/)." >&2',
    "  exit 2",
    "fi",
    ...requireKey("VLLM_API_KEY", "serve.sh: VLLM_API_KEY is not set or blank; export it first (read -rs VLLM_API_KEY && export VLLM_API_KEY)."),
    'mkdir -p "$HOME/.cache/huggingface"',
    "",
    "# Published on the GPU's loopback only; reach it through an SSH tunnel (README.md).",
    "exec docker run --rm --gpus all --shm-size 4g \\",
    "  -p 127.0.0.1:8000:8000 \\",
    "  --env HF_TOKEN --env VLLM_API_KEY \\",
    '  -v "$HOME/.cache/huggingface:/root/.cache/huggingface" \\',
    '  "$VLLM_IMAGE" \\',
    vllmArgs.map((a) => `  ${a}`).join(" \\\n"),
    "",
  ].join("\n");
}

function renderRun(o: QuickstartOptions): string {
  if (o.openshell) {
    return [
      "#!/usr/bin/env bash",
      "# Generated by `sportsclaw quickstart` (OpenShell mode).",
      'echo "run.sh: this job runs only inside an OpenShell sandbox. Use ./launch-openshell.sh (see README.md)." >&2',
      "exit 2",
      "",
    ].join("\n");
  }
  const cred = credentialEnv(o);
  const hint = o.host === "nim" ? "Export your NVIDIA API key" : "Export the same key serve.sh started vLLM with";
  return [
    "#!/usr/bin/env bash",
    "# Generated by `sportsclaw quickstart`. One direct smoke run: a single operator tick, then exit.",
    "# HOME is this bundle and the environment is scrubbed, so saved SportsClaw config, MCP",
    "# servers, sports skills and other provider keys from your shell are not used.",
    "set -euo pipefail",
    'qs_here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"',
    'cd -- "$qs_here"',
    "",
    ...requireKey(cred, `run.sh: ${cred} is not set or blank. ${hint}; there is no fallback.`),
    "# Capture what the run needs, then unset every exported variable.",
    `export -n qs_here qs_key qs_path 2>/dev/null || true`,
    `qs_key="$${cred}"`,
    'qs_path="$PATH"',
    'while IFS= read -r qs_name; do unset "$qs_name" 2>/dev/null || true; done < <(compgen -e)',
    'export PATH="$qs_path" HOME="$qs_here"',
    `export OPENAI_COMPATIBLE_BASE_URL=${shq(o.endpoint)}`,
    'export OPENAI_COMPATIBLE_API_KEY="$qs_key"',
    "export SPORTSCLAW_SKILLS=''",
    "unset qs_key qs_path",
    `exec sportsclaw operate --job ${JOB_ID} --once`,
    "",
  ].join("\n");
}

function renderLaunch(o: QuickstartOptions): string {
  const cred = credentialEnv(o);
  const cmds = buildOpenShellCommands({
    profileFile: "./provider.yaml",
    profileId: OPENSHELL_NAME,
    providerName: OPENSHELL_NAME,
    image: o.image ?? "",
    sandboxName: OPENSHELL_NAME,
    policyFile: "./policy.yaml",
    jobId: JOB_ID,
    jobFile: `./${JOB_FILE}`,
    once: true,
  });
  return [
    "#!/usr/bin/env bash",
    "# Generated by `sportsclaw quickstart`. One-shot OpenShell launch: imports the",
    `# ${OPENSHELL_NAME} provider profile, creates the provider from ${cred} in THIS shell`,
    "# (never on a command line), and runs one operator tick in a new sandbox.",
    "# Needs a registered gateway and an image you built and pushed. Stops at the first failing",
    "# openshell command (set -e) and never deletes or reuses anything.",
    "set -euo pipefail",
    'cd -- "$(dirname -- "${BASH_SOURCE[0]}")"',
    "",
    ...requireKey(cred, `launch-openshell.sh: ${cred} is not set or blank; export it in this shell first (provider create --from-existing reads it here).`),
    "",
    "unsupported() {",
    `  echo "launch-openshell.sh: need stable OpenShell >=${TESTED_OPENSHELL_VERSION} <0.2.0 (tested: ${TESTED_OPENSHELL_VERSION}); found \${version:-none}." >&2`,
    "  exit 2",
    "}",
    "version=\"$(openshell --version 2>/dev/null | grep -Eo '[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?' | head -n 1 || true)\"",
    'case "$version" in',
    `  ${TESTED_OPENSHELL_VERSION}) ;;`,
    "  0.1.*)",
    '    patch="${version#0.1.}"',
    '    case "$patch" in ""|*[!0-9]*) unsupported ;; esac',
    `    [ "$patch" -ge ${TESTED_OPENSHELL_VERSION.split(".")[2]} ] || unsupported`,
    `    echo "launch-openshell.sh: warning: OpenShell $version is accepted but unqualified; only ${TESTED_OPENSHELL_VERSION} is tested." >&2`,
    "    ;;",
    "  *) unsupported ;;",
    "esac",
    "",
    cmds.profileLint,
    cmds.profileImport,
    cmds.providerCreate,
    cmds.sandboxCreate,
    "",
  ].join("\n");
}

function renderProvider(o: QuickstartOptions): string {
  const url = new URL(o.endpoint);
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const cred = credentialEnv(o);
  return [
    `# OpenShell 0.1.x provider profile generated by \`sportsclaw quickstart\` (tested: ${TESTED_OPENSHELL_VERSION}).`,
    `# Binds ${cred} to exactly this endpoint for the Node binary. Attaching it ADDS this`,
    "# egress to the sandbox's effective policy. No secret values live here.",
    "",
    `id: ${OPENSHELL_NAME}`,
    "display_name: SportsClaw hosted-model quickstart",
    "description: OpenAI-compatible inference endpoint chosen with sportsclaw quickstart",
    "category: inference",
    "inference_capable: true",
    "",
    "credentials:",
    "  - name: api_key",
    `    description: Bearer key for the ${o.host === "nim" ? "NVIDIA API" : "vLLM server"}`,
    `    env_vars: [${cred}]`,
    "    required: true",
    "    auth_style: bearer",
    "    header_name: authorization",
    "",
    "discovery:",
    "  credentials: [api_key]",
    "",
    "endpoints:",
    `  - host: ${url.hostname}`,
    `    port: ${port}`,
    `    path: ${url.pathname.replace(/\/+$/, "")}/**`,
    "    protocol: rest",
    "    access: read-write",
    "    enforcement: enforce",
    "",
    "binaries:",
    "  - /usr/local/bin/node",
    "",
  ].join("\n");
}

function renderPolicy(): string {
  return [
    "# OpenShell 0.1.x base policy generated by `sportsclaw quickstart`.",
    `# No base network egress: the only route is the one the attached ${OPENSHELL_NAME}`,
    "# provider profile adds. Confirm with `openshell policy get <sandbox> --full`.",
    "",
    "version: 1",
    "",
    "filesystem_policy:",
    "  read_only:",
    "    - /app/dist",
    "    - /app/node_modules",
    "    - /app/package.json",
    "  read_write:",
    "    - /sandbox",
    "    - /tmp",
    "",
    "landlock:",
    "  compatibility: best_effort",
    "",
    "process:",
    "  run_as_user: sandbox",
    "  run_as_group: sandbox",
    "",
    "network_policies: {}",
    "",
  ].join("\n");
}

const LINKS = [
  "- vLLM Docker deployment: https://docs.vllm.ai/en/stable/deployment/docker/",
  "- Brev launchables and GPU machines: https://docs.nvidia.com/brev/concepts/launchables",
  "- NIM containers on Brev: https://docs.nvidia.com/brev/guides/inference-deployment/deploying-nims",
  "- NVIDIA sports multimodal serving: https://github.com/NVIDIA/sports-intelligence-playbooks/blob/4bcb551cca93b66b10c1dd14d14ad39056ffe33f/avlm/deployment/vLLM/README.md",
  `- OpenShell ${TESTED_OPENSHELL_VERSION}: https://github.com/NVIDIA/OpenShell/releases/tag/v${TESTED_OPENSHELL_VERSION}`,
];

function renderReadme(o: QuickstartOptions): string {
  const cred = credentialEnv(o);
  const tunnel = o.host === "brev" && o.endpoint === BREV_TUNNEL_ENDPOINT;
  const verify = `printf 'Authorization: Bearer %s\\n' "$${cred}" | curl -sS -H @- ${o.endpoint}/models`;
  const lines: string[] = [
    `# SportsClaw hosted-model quickstart (${o.host}${o.openshell ? ", OpenShell" : ", direct"})`,
    "",
    `Model: \`${o.model}\`${o.servedModel !== o.model ? ` served as \`${o.servedModel}\`` : ""}. Endpoint: \`${o.endpoint}\`.`,
    "",
    "Writing this bundle deployed, started and contacted nothing. It is a starting point,",
    "not proof that the model runs: any model id is accepted, but the model must be supported by",
    "the runtime, must have a chat template and tool calling, and must fit in the GPU's VRAM",
    "(weights + KV cache). Read `skills/hosted-models/SKILL.md` first. The smoke job sends",
    "that guide to the model too.",
    "",
    "Use `read -rs NAME && export NAME` for keys so they stay out of shell history and command lines.",
    "",
  ];

  if (o.host === "brev") {
    lines.push(
      "## 1. Serve the model on a Brev GPU",
      "",
      "1. Get approval for the cost, then create or choose a GPU machine yourself in the Brev",
      "   console or CLI. Pick an instance with enough VRAM. Below, `<brev-machine>` is that",
      "   machine's name.",
      "2. `brev refresh` to update `~/.brev/ssh_config`.",
      "3. `scp -F ~/.brev/ssh_config ./serve.sh <brev-machine>:serve.sh`",
      "4. `ssh -F ~/.brev/ssh_config <brev-machine>`, then on the GPU machine:",
      "",
      "   ```bash",
      "   export VLLM_IMAGE=vllm/vllm-openai:<tag-or-digest-you-reviewed>",
      "   read -rs VLLM_API_KEY && export VLLM_API_KEY   # a new random key",
      "   read -rs HF_TOKEN && export HF_TOKEN           # only for gated/private repos",
      "   ./serve.sh                                     # extra vLLM flags go after it",
      "   ```",
      "",
      "   vLLM downloads the weights. The container publishes port 8000 on the GPU's loopback only.",
      "",
    );
    if (tunnel) {
      lines.push(
        "5. On your machine, open the tunnel in its own terminal:",
        "",
        "   ```bash",
        "   ssh -F ~/.brev/ssh_config -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8000:127.0.0.1:8000 <brev-machine>",
        "   ```",
        "",
      );
    } else {
      lines.push(
        `5. Make \`${o.endpoint}\` reach the vLLM server yourself, for example with an authenticated`,
        "   HTTPS gateway. Do not publish port 8000 or bind SSH forwards to all interfaces.",
        "",
      );
    }
  } else {
    lines.push(
      "## 1. Get an NVIDIA API key",
      "",
      `Use a key for ${NIM_ENDPOINT} and a model id it serves. An NGC key for pulling NIM`,
      "containers is a different credential. Prompts sent to this hosted API leave your machine.",
      "",
    );
  }

  lines.push(
    "## 2. Verify the endpoint",
    "",
    "```bash",
    verify,
    "```",
    "",
    "The served model id must be listed. Then send one bounded chat request and one tool call",
    "(the guide, step 4) before you rely on the agent.",
    "",
  );

  if (!o.openshell) {
    lines.push(
      "## 3. Run one agent tick",
      "",
      "```bash",
      `read -rs ${cred} && export ${cred}`,
      "./run.sh",
      "```",
      "",
      "`run.sh` runs `sportsclaw operate --job quickstart --once` with HOME set to this bundle and",
      "a scrubbed environment. No sports tools, MCP or memory are loaded, and it never falls back",
      "to other keys. Exit code 0 means the model answered.",
      "",
    );
  } else {
    lines.push(
      "## 3. Run one tick in OpenShell",
      "",
      `Tested with OpenShell ${TESTED_OPENSHELL_VERSION} only; stable >=${TESTED_OPENSHELL_VERSION} <0.2.0 is accepted with a warning.`,
      "",
      "1. Register a gateway (`sportsclaw openshell doctor` checks prerequisites).",
      "2. Build and push the image yourself from a source checkout:",
      "   `docker build -t sportsclaw:latest . && docker build -t <image> -f openshell/Dockerfile . && docker push <image>`.",
      "   The image must run `/app/dist/index.js` with `HOME=/sandbox`. The job is uploaded to",
      `   \`/sandbox/${JOB_FILE}\`.`,
      `3. \`read -rs ${cred} && export ${cred}\`, then \`./launch-openshell.sh\`.`,
      "",
      "`policy.yaml` grants no network egress. `provider.yaml` adds exactly the endpoint above",
      `and injects \`${cred}\` for the Node binary. The job refuses to run outside a sandbox, and`,
      "`run.sh` refuses too.",
      "",
    );
    if (o.host === "brev") {
      lines.push(
        "A sandbox cannot reach an SSH tunnel on your machine's loopback. Use an authenticated",
        `HTTPS endpoint, or \`http://${HOST_BRIDGE}:<port>\` only if you arranged the gateway host's`,
        "routing to the vLLM server yourself. Never bind SSH forwards to all interfaces.",
        "",
      );
    }
    lines.push(
      "The launcher stops at the first failing `openshell` command and never deletes or reuses anything.",
      `If a previous run left a \`${OPENSHELL_NAME}\` profile, provider or sandbox, inspect it with`,
      "OpenShell's own commands before you decide what to do. How a live gateway handles that",
      "name collision has not been verified.",
      "",
    );
  }

  lines.push(
    "## Scope",
    "",
    "Nothing here provisions machines, manages accounts, downloads weights or restarts services.",
    "GPU machines bill while they run; manage their lifecycle in the Brev console.",
    "",
    "## Sources",
    "",
    ...LINKS,
    "",
  );
  return lines.join("\n");
}

export function buildQuickstartBundle(o: QuickstartOptions, guide: string): BundleFile[] {
  const files: BundleFile[] = [
    { path: "README.md", content: renderReadme(o), mode: 0o600 },
    { path: GUIDE_FILE, content: guide, mode: 0o600 },
    { path: JOB_FILE, content: JSON.stringify(buildQuickstartJob(o, guide), null, 2) + "\n", mode: 0o600 },
    { path: "run.sh", content: renderRun(o), mode: 0o700 },
  ];
  if (o.host === "brev") files.push({ path: "serve.sh", content: renderServe(o), mode: 0o700 });
  if (o.openshell) {
    files.push(
      { path: "provider.yaml", content: renderProvider(o), mode: 0o600 },
      { path: "policy.yaml", content: renderPolicy(), mode: 0o600 },
      { path: "launch-openshell.sh", content: renderLaunch(o), mode: 0o700 },
    );
  }
  return files;
}

// ---------------------------------------------------------------------------
// Writing (the only I/O besides reading the packaged guide)
// ---------------------------------------------------------------------------

/** Create `out` (must not exist) and write every file into it; returns the absolute root. */
export function writeQuickstartBundle(out: string, files: BundleFile[]): string {
  const root = path.resolve(out);
  try {
    // Non-recursive: the parent must exist; any existing entry (dir, file, symlink) is refused.
    fs.mkdirSync(root, { mode: 0o700 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") fail(`refusing to write: ${root} already exists (choose a new directory)`);
    if (code === "ENOENT") fail(`the parent directory of ${root} does not exist`);
    throw err;
  }
  fs.chmodSync(root, 0o700);
  const dirs = [...new Set(files.flatMap((f) => {
    const parts = f.path.split("/").slice(0, -1);
    return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
  }))].sort((a, b) => a.split("/").length - b.split("/").length);
  for (const dir of dirs) {
    const abs = path.join(root, dir);
    fs.mkdirSync(abs, { mode: 0o700 });
    fs.chmodSync(abs, 0o700);
  }
  for (const f of files) {
    const abs = path.join(root, f.path);
    fs.writeFileSync(abs, f.content, { mode: f.mode, flag: "wx" });
    fs.chmodSync(abs, f.mode);
  }
  return root;
}

function readPackagedGuide(): string {
  // Shipped in the npm package next to dist/ (package.json "files").
  return fs.readFileSync(fileURLToPath(new URL("../quickstart/hosted-models/SKILL.md", import.meta.url)), "utf8");
}

function printQuickstartHelp(): void {
  console.log([
    "sportsclaw quickstart — write an offline launch bundle for a hosted model (deploys nothing)",
    "",
    "Usage:",
    "  sportsclaw quickstart --host brev|nim --model <id> --out <new-dir> [options]",
    "",
    "  --host brev|nim         brev: your Brev GPU + vLLM (serve.sh); nim: hosted NVIDIA API",
    "  --model <id>            Hugging Face repo id (brev) or served API model id (nim)",
    "  --out <new-dir>         Directory to create; must not exist",
    "  --endpoint <url>        brev only. Default http://127.0.0.1:8000/v1 (SSH tunnel)",
    "  --served-model <id>     brev only. vLLM --served-model-name (default: --model)",
    "  --tool-parser <name>    brev only. vLLM --tool-call-parser for this model (none is universal)",
    "  --revision <rev>        brev only. Hugging Face revision passed to vLLM",
    "  --openshell             Run the job in an OpenShell sandbox (optional; needs --image,",
    "                          and for brev an explicit sandbox-reachable --endpoint)",
    "  --image <oci-ref>       OpenShell image you built and pushed",
    "",
    "Generation only writes files: no network, no subprocesses, no saved config or credentials read.",
    "See README.md in the bundle and docs/getting-started/hosted-models.md.",
  ].join("\n"));
}

export async function cmdQuickstart(args: string[]): Promise<void> {
  try {
    const opts = parseQuickstartArgs(args);
    if (opts === "help") {
      printQuickstartHelp();
      return;
    }
    const files = buildQuickstartBundle(opts, readPackagedGuide());
    const root = writeQuickstartBundle(opts.out, files);
    console.log(`Wrote ${root}:`);
    for (const f of files) console.log(`  ${f.path}`);
    console.log("Nothing was deployed, started or contacted. Next: read README.md in that directory.");
  } catch (err) {
    if (!(err instanceof QuickstartUsageError)) throw err;
    console.error(`sportsclaw quickstart: ${err.message}`);
    console.error("Run `sportsclaw quickstart --help` for usage.");
    process.exitCode = 2;
  }
}
