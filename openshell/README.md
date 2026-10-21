# SportsClaw × NVIDIA OpenShell (0.1.x)

Runbook for running a SportsClaw operator daemon inside an [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) sandbox, calling the model provider's **native** API with a credential supplied by an attached OpenShell provider.

Tested against OpenShell **0.1.5** only. `sportsclaw openshell doctor` reports 0.1.5 as ok, newer stable 0.1.x as an unqualified warning, and rejects prereleases, 0.0.x and 0.2+.

OpenShell is **optional**. Omit the `openshell` block (or set `"enabled": false`) and SportsClaw uses direct LLM calls exactly as before — no OpenShell binary, gateway, probe or environment change is involved. Nothing in this directory is on the default code path.

Background: `../docs/openshell-integration-plan.md` (current design). `../docs/openshell-research.md` is **historical** 0.0.x research (managed Privacy Router) and does not describe current behavior.

---

## How it works in 0.1.x

OpenShell 0.1 removed the managed inference route (`inference.local`, `openshell inference ...`). Access now comes from **provider profiles** and **per-sandbox provider attachments**:

| Concern | Owner |
|---|---|
| Credential value + refresh | OpenShell provider instance (never enters the sandbox) |
| Allowed hosts/ports/paths/binaries | Provider profile (`providers/*.yaml`) + sandbox policy |
| Which sandbox gets access | `--provider` at create, or `sandbox provider attach` |
| Base URL, model id, API mode, timeout | The SportsClaw job config |

The workload receives an opaque placeholder in the profile's credential env var (e.g. `NVIDIA_API_KEY`). SportsClaw sends that value to the native endpoint; OpenShell's proxy substitutes the real credential only at an endpoint the profile authorizes. Attachment does not select or restrict the model.

SportsClaw's OpenShell job mode:
- requires `provider` (`anthropic` or `openai`), `openshell.baseUrl`, and `openshell.credentialEnv` — or `credentialless: true` for an unauthenticated local endpoint;
- reads the credential only from that env var as the sandbox injected it — never a fixed dummy key, other provider keys, Claude Code OAuth (no logout needed), or values saved in `~/.sportsclaw/.env` / `config.json` (those are ignored for the credential and the sandbox marker);
- refuses to start unless `OPENSHELL_SANDBOX=1`, the marker OpenShell injects into sandbox workload processes, and fails before any MCP/tool setup when a prerequisite is missing;
- builds the model client from the job config with a request timeout (default 300 s) on a private, shared HTTP pool; it never rewrites `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL` or the global fetch dispatcher, and never retries outside the sandbox path;
- keeps Node TLS verification on (OpenShell's CA arrives via `NODE_EXTRA_CA_CERTS`).

`OPENSHELL_SANDBOX=1` and the `inferenceRoute` field on TickEvents are operational signals, **not attestation**. Network policy, credential binding and isolation are enforced by the OpenShell runtime; verify them there (see *Verify*).

Gemini and Azure Foundry are not wired for OpenShell mode. For an OpenAI-compatible custom host use `provider: "openai"` plus an endpoint-bearing profile for that host.

---

## Prerequisites

- An OpenShell 0.1.5 gateway that is running and selected. `openshell gateway add <endpoint> --name <name>` **registers** an existing gateway; it does not start or provision one. Fresh gateways ship **no** provider profiles.
- A container runtime to build the image, and a registry the gateway's engine can pull from (`--from` takes an image reference or rootfs tar, not a Dockerfile).
- Linux sandboxes need Landlock ABI v3+ (mandatory baseline in both compatibility modes; on macOS this is the Linux VM's kernel).

Upgrading from 0.0.x is a **migration**: upgrade gateway and CLI together, import profiles under new ids, create replacement providers from the original credential source, and delete/recreate every pre-upgrade sandbox. Back up gateway state (gateway config is schema version 2) and plan rollback first.

---

## Quickstart

```bash
sportsclaw openshell doctor     # version gate, gateway registration, providers, local image
sportsclaw openshell doctor --image <registry>/sportsclaw-openshell:<tag> [--remote] [--probe]
sportsclaw openshell setup      # prints the exact recipe below + a job config; runs nothing
```

`doctor --image` (default `sportsclaw-openshell:latest`) selects the image inspected locally (docker, or podman when only podman responds), used by the opt-in `--probe` sandbox create/cleanup, and named in hints. `--remote` skips the local docker/podman and image checks and marks them skipped/not checked; it does not verify remote pull or runtime enforcement. CLI, gateway and provider checks always run. Live sandbox/runtime behaviour is not qualified.

`setup` is print-only: it runs no `openshell`/`docker` probes (that is `doctor`'s job, including `doctor --json`) and exits 0 once the recipe renders. Every value in the printed commands is shell-quoted. Options: `--profile nvidia-native|nim-local`, `--policy vault|vault-espn|connected` (default `vault`, local-only; `connected` prints a warning because it grants write-capable Machina MCP and public market/news egress), `--provider-name`, `--image`, `--sandbox`, `--job`.

Run the daemon as the sandbox's foreground main process (`sandbox create ... --detach --restart-policy on-failure -- node /app/dist/index.js operate --job <jobId>`), so OpenShell owns its lifecycle. Do **not** use `sportsclaw start operator` for OpenShell jobs: that installs a host service (launchd/systemd/Task Scheduler) outside any sandbox, and the job will refuse to start there.

Manual equivalent (hosted NVIDIA API Catalog):

1. **Import the provider profile** (both commands need the active gateway; `lint` does not register):
   ```bash
   openshell profile lint -f openshell/providers/nvidia-native.yaml
   openshell profile import -f openshell/providers/nvidia-native.yaml
   ```
2. **Create the provider** from your shell's `NVIDIA_API_KEY`:
   ```bash
   openshell provider create --name nvidia-native-prod --type nvidia-native --from-existing
   ```
3. **Build and push the image** (source checkout):
   ```bash
   docker build -t sportsclaw:latest .
   docker build -t <registry>/sportsclaw-openshell:<tag> -f openshell/Dockerfile .
   docker push <registry>/sportsclaw-openshell:<tag>
   ```
4. **Write the job config** `./tv-operator.json`:
   ```json
   {
     "jobId": "tv-operator",
     "intervalMs": 60000,
     "personaText": "...",
     "provider": "openai",
     "model": "nvidia/nemotron-3-super-120b-a12b",
     "openshell": {
       "baseUrl": "https://integrate.api.nvidia.com/v1",
       "credentialEnv": "NVIDIA_API_KEY",
       "apiMode": "chat",
       "timeoutMs": 300000
     }
   }
   ```
   `apiMode` is `chat` (default) or `responses` (OpenAI-style only). For Anthropic use `"provider": "anthropic"`, `"baseUrl": "https://api.anthropic.com/v1"` and a profile that declares `ANTHROPIC_API_KEY` for that host.
5. **Launch with the provider attached:**
   ```bash
   openshell sandbox create --name sportsclaw-op \
     --from <registry>/sportsclaw-openshell:<tag> \
     --provider nvidia-native-prod \
     --policy openshell/policy.vault.yaml \
     --upload ./tv-operator.json:/sandbox/.sportsclaw/operator/tv-operator.json \
     --detach --restart-policy on-failure \
     -- node /app/dist/index.js operate --job tv-operator
   ```
   `policy.vault.yaml` is the strict, local-only base; the attached provider adds only its own inference endpoint. Swap in `openshell/policy.yaml` only for the connected Sports TV workload (write-capable Machina MCP + public market/news egress). For a one-off check, create without `--detach` and run `-- node /app/dist/index.js operate --job tv-operator --once`. The image sets `HOME=/sandbox`, which is why the job config is uploaded under `/sandbox/.sportsclaw/operator/`.

To attach a provider to a running sandbox: `openshell sandbox provider attach <sandbox> <provider> --wait`, then start a **new** process (running processes don't gain env vars). Detach with `... detach ... --wait` to revoke.

### Local NIM (credentialless)

`providers/nim-local.yaml` targets `host.openshell.internal:8000` (sandboxes cannot use `localhost` for host services). Create the provider without `--from-existing`, and use `"openshell": { "baseUrl": "http://host.openshell.internal:8000/v1", "credentialless": true }`.

---

## Verify

```bash
openshell sandbox provider list sportsclaw-op
openshell policy get sportsclaw-op --full     # effective policy incl. provider-derived endpoints
```

A successful native request from a new sandbox process is what confirms endpoint policy, binary attribution, credential substitution and DNS. A `credential_endpoint_mismatch` in the logs means policy admitted the request but the profile does not bind the credential to that endpoint. The startup banner's `inference=openshell(<baseUrl>)` is configuration, not proof.

---

## Policies

| File | Posture |
|---|---|
| `policy.yaml` | Connected Sports TV: cloud Machina MCP, ESPN, Kalshi, Polymarket, overlay/tail routes. |
| `policy.vault.yaml` | Private Athlete Vault: only local client-api, pod MCP SSE and tail-bus routes on the host bridge. |
| `policy.vault-espn.yaml` | Connected Vault: `policy.vault.yaml` + read-only ESPN egress for the Python skills. |

All are sandbox policy `version: 1`. SportsClaw never applies a policy; `sportsclaw openshell setup` prints `policy.vault.yaml` unless you pass `--policy vault-espn|connected`.

**Private means private as composed.** Attached provider profiles add their endpoints to the effective policy: attaching `nvidia-native` adds public egress to `integrate.api.nvidia.com`. Keep the Vault local by attaching only a host-local profile (e.g. `nim-local`) and check `policy get --full`.

Filesystem notes (0.1.5):
- With `filesystem_policy` present, `include_workdir` defaults to false, so the policies list `/sandbox`, `/tmp` and `/app/.sportsclaw` explicitly.
- When the effective policy has any network rule, OpenShell adds baseline paths it can find (`/usr`, `/lib`, `/etc`, `/app`, ... read-only; `/tmp`, `/dev/null` read-write) without changing paths you list.
- Both `best_effort` and `hard_requirement` skip individual missing paths; `hard_requirement` is not proof every path applied. Check the `Landlock ruleset built` counts. Changing `best_effort` is a security-posture decision.
- `process.run_as_user/run_as_group` must be `sandbox` or a non-root numeric id and cannot change via a policy update; filesystem/landlock/process changes need a recreated sandbox.

Policy field reference: [OpenShell 0.1.5 policy schema](https://github.com/NVIDIA/OpenShell/blob/v0.1.5/docs/how-it-works/policies/schema.mdx).

---

## Before production

Mocks and route labels cannot qualify a deployment. Qualify on a disposable Linux sandbox at the pinned release: native inference with the intended model, opaque credential handling, denied hosts/tools, retained human approvals for consequential writes, detach/revocation, restart/recovery, effective-policy capture, rollback. Signed policies, OCSF/SIEM export (opt-in, best-effort) and MCP tool-level scoping are separate enterprise deployment decisions, not part of this package.

---

## Troubleshooting

- **`OpenShell mode requires running inside an OpenShell sandbox`** — the job started outside a sandbox (for example via `sportsclaw start operator`, which is a host service). Run it as the sandbox main process (`openshell sandbox create ... -- <cmd>`) or via `openshell sandbox exec`, or set `"openshell": {"enabled": false}`. A marker saved in `~/.sportsclaw/.env` is ignored.
- **`OpenShell credential env NVIDIA_API_KEY is not set by the sandbox`** — no attached provider supplies that variable to this process (copies saved in `~/.sportsclaw/.env` or `config.json` don't count). Attach it (`--wait`) and start a new process; check the profile's `env_vars`.
- **Doctor warns `accepted but unqualified`** — a newer stable 0.1.x than the tested 0.1.5. Qualify it before relying on it.
- **`openshell.baseUrl must not use inference.local`** — a 0.0.x config. Set the provider's native URL and import a profile for it.
- **403 `credential_endpoint_mismatch` / policy denied** — the profile's endpoints or `binaries` don't cover the request (`/usr/local/bin/node` for SportsClaw). If a gateway global policy override is active, it suppresses provider-derived layers.
- **Doctor says `openshell 0.0.x (unsupported)`** — see the migration notes above.

### macOS Homebrew 0.0.47: sandboxes stuck in Provisioning (historical)

On 0.0.47 Homebrew installs the service wrapper skipped the gateway `jwt/` material ([NVIDIA/OpenShell#1523](https://github.com/NVIDIA/OpenShell/issues/1523)); `doctor --probe` reports `sandbox provisioning hangs — no compute driver`. The 0.0.47 workaround was copying `/opt/homebrew/var/openshell/tls/jwt` into `~/.local/state/openshell/homebrew/tls/` and restarting the service. Re-check against your 0.1.x install before applying.

---

## Files in this directory

| File | Purpose |
|---|---|
| `README.md` | This runbook. |
| `Dockerfile` | Sandbox image (non-root `sandbox` user), layered on the root `Dockerfile`. |
| `providers/nvidia-native.yaml` | Hosted NVIDIA API Catalog profile: `NVIDIA_API_KEY` bound to `integrate.api.nvidia.com`, Node only. |
| `providers/nim-local.yaml` | Credentialless host-local NIM profile. |
| `policy.yaml` | Connected Sports TV policy. |
| `policy.vault.yaml` | Private Athlete Vault policy. |
| `policy.vault-espn.yaml` | Vault + read-only ESPN. |
| `models.md` | Provider/model pairing notes. |

These recipes ship in the npm package (`node_modules/sportsclaw-engine-core/openshell/`). Installing SportsClaw never installs OpenShell; the profiles have not been linted against a live gateway in this repository.
