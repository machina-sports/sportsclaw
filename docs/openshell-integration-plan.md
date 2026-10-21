# OpenShell integration plan (0.1.x native inference)

Current design for SportsClaw's optional NVIDIA OpenShell integration. Runbook:
[`openshell/README.md`](https://github.com/machina-sports/sportsclaw/blob/main/openshell/README.md).
The 0.0.x managed-route design (Privacy Router at `inference.local`, `openshell inference set`)
is **historical**: OpenShell 0.1 removed it, and `docs/openshell-research.md` describes that
earlier model only.

## Status

- Tested against OpenShell **0.1.5** only. `sportsclaw openshell doctor` reports 0.1.5 as ok and
  newer stable 0.1.x as an unqualified warning; prereleases (`-rc`, `-dev`), 0.2+ and 0.0.x are
  rejected (0.0.x with migration guidance).
- Verified with mocked HTTP endpoints and unit tests only. No live gateway, sandbox, profile lint,
  credential substitution or native inference has been exercised; `openshell profile lint` needs
  an active gateway.

## Decisions

**D1 — Optional and inert by default.** No `openshell` block (or `enabled: false`) means the
existing direct provider, auth, CLI, bot and operator behavior. That path runs no OpenShell
binary, Docker, gateway call, probe or environment change. OpenShell is never an npm dependency.

**D2 — Native endpoint per job.** An enabled job sets `provider` (`anthropic` or `openai`),
`openshell.baseUrl` (provider-native URL), and either `credentialEnv` (the env var the attached
provider profile injects) or `credentialless: true` (an unauthenticated local endpoint).
Optional: `apiMode` (`chat` default, or `responses`; OpenAI-style only) and `timeoutMs` (default
300000). Model roles with `route: "openshell"` use the same fields. OpenAI-compatible custom hosts
use `provider: "openai"` and an endpoint-bearing profile, so the normal `OPENAI_*` and
`openai-compatible` config is left alone.

**D3 — Fail closed before inference.** The job is rejected up front, before sink, tool and MCP
setup, when any of these holds:
- the config is malformed;
- `baseUrl` is `inference.local` in any casing or with a trailing dot;
- `baseUrl` embeds credentials, a query string or a fragment (errors never echo the URL);
- `OPENSHELL_SANDBOX` is not `"1"`, the value OpenShell injects into the workload processes it
  launches;
- the credential env var was not set by the workload environment.

The CLI hydrates `process.env` from `~/.sportsclaw/.env` and `config.json` at startup
(`applyConfigToEnv`), and direct jobs keep relying on that. Hydration records which values it
wrote (`src/env-provenance.ts`); the OpenShell resolver treats those as unset for the marker and
the credential, while values the sandbox actually injected (or a caller later sets, or passes in an
explicit env object) stay eligible. This covers foreground `operate`, model roles in mixed jobs, and
library callers that run `applyConfigToEnv` first. There is no fallback to other provider keys,
Claude Code OAuth or an unsandboxed endpoint. OAuth users don't need to log out.

OpenShell jobs run as the sandbox's foreground main process (`sandbox create ... -- node
/app/dist/index.js operate --job <id>`, with `--detach --restart-policy on-failure` for long
runs). `sportsclaw start operator` installs a host service (launchd/systemd/Task Scheduler); its
child has only `PATH`/`HOME`, is not sandboxed, and an OpenShell job fails closed there. No
workload secrets are written into service files.

**D4 — No global side effects.** The model client is built per job with an explicit base URL,
key, request mode and timeout (default 300000 ms). OpenShell clients share one lazy,
module-private undici `Agent` with bounded keep-alive (10 s idle, 60 s max), so ambient global
dispatchers never carry them and repeated clients reuse sockets; credentials stay per request.
Bare native endpoints (NIM model roles) keep the ambient fetch, including any process-wide proxy
agent, and add a timeout only when configured. OpenShell jobs never write
`OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL` and never install a global dispatcher. The pre-existing
`HTTPS_PROXY` dispatcher stays for non-OpenShell operator jobs only. Node TLS verification is
unchanged; OpenShell's CA reaches Node via `NODE_EXTRA_CA_CERTS`.

**D5 — Guards are not attestation.** `OPENSHELL_SANDBOX=1` and the `inferenceRoute` TickEvent
field are operational signals and configuration metadata. OpenShell enforces network policy,
credential binding and isolation. Prove those with `openshell policy get <sandbox> --full`, real
requests and denial tests, not with SportsClaw output. Provider attachment does not restrict
model choice.

**D6 — Opt-in CLI, non-mutating setup.** Each subcommand only runs when the user invokes it:
- `doctor` checks the version gate, gateway registration (`gateway list -o json`, a bare
  array), providers (`provider list --names`) and the local image, with truthful exit codes.
- `setup` is print-only (no probes, exit 0): it renders the POSIX-quoted profile lint/import,
  provider create, and `sandbox create --from <OCI image> --provider <name>` recipe plus a job
  config, validating the job id. The base policy defaults to the strict `policy.vault.yaml`;
  `--policy vault-espn|connected` opts in to more, and `connected` prints a permission warning.
  The output also names the hosted provider's external inference egress.

Gateway registration (`gateway add`) is not provisioning.

**D7 — Recipes ship as static files.** The npm package includes `openshell/`:
- provider profiles `nvidia-native` (hosted, `NVIDIA_API_KEY`) and `sportsclaw-nim-local`
  (credentialless, `host.openshell.internal`), both limited to `/usr/local/bin/node`;
- sandbox policies (version 1): connected TV, private Vault, and Vault + read-only ESPN;
- the image Dockerfile, with a non-root `sandbox` user and `HOME=/sandbox`.

"Private" holds only as composed: attached profiles add their endpoints to the effective policy.

## Migration from 0.0.x

1. Record the old provider, model and timeout.
2. Back up gateway state (gateway config moves to schema 2) and plan rollback.
3. Upgrade gateway and CLI together.
4. Import profiles under new ids and create replacement providers from the original credential
   source.
5. Update job configs to D2.
6. Delete and recreate every pre-upgrade sandbox, attaching only the providers each one needs.

## Out of scope / separate qualification

- Signed policy release, OCSF/SIEM export (opt-in, best-effort upstream) and MCP tool-level
  scoping are enterprise deployment decisions.
- Moving `landlock.compatibility` to `hard_requirement` is a posture choice, and both modes skip
  missing paths.
- Before any production use, qualify on a disposable Linux sandbox at 0.1.5:
  - native inference with the intended model;
  - opaque credentials;
  - denied hosts and tools;
  - retained human approvals;
  - detach and revocation;
  - restart and recovery;
  - effective-policy capture;
  - rollback.
