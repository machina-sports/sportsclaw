# Running with NVIDIA OpenShell

You can run a sportsclaw [operator job](../advanced/operator) inside an
[NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) sandbox. OpenShell enforces filesystem,
process and network policy, and keeps real provider credentials out of the agent process: the
sandbox gets an opaque placeholder, and OpenShell's proxy swaps in the real credential only at
endpoints the attached provider profile authorizes.

This integration was tested against **OpenShell 0.1.5 only**. `sportsclaw openshell doctor`
reports 0.1.5 as ok, newer stable 0.1.x as an unqualified warning, and rejects prereleases,
0.0.x and 0.2+. OpenShell is optional — jobs without an `openshell` block make direct model calls
exactly as before.

::: warning OpenShell 0.1 changed the model
0.1 removed the managed `inference.local` route and the `openshell inference` commands. Jobs now
call the provider's **native** endpoint with the credential env var injected by an attached
provider. Moving from 0.0.x is a migration (import profiles, recreate sandboxes) — see the
[runbook](https://github.com/machina-sports/sportsclaw/blob/main/openshell/README.md).
:::

## Local gateway and reference-architecture foundation

For a versioned local MicroVM gateway, authenticated access, audit export and the
remaining enterprise controls, use the
[NVIDIA reference-architecture foundation](nvidia-reference-architecture.md).
A working gateway does not by itself qualify sandbox enforcement or the full reference design.

## Check your setup

```bash
sportsclaw openshell doctor          # version gate, gateway registration, providers, image
sportsclaw openshell doctor --json   # machine-readable
sportsclaw openshell doctor --image <registry>/sportsclaw-openshell:<tag>   # image to check (default sportsclaw-openshell:latest)
sportsclaw openshell doctor --remote --image <registry>/sportsclaw-openshell:<tag>   # no local docker/podman checks
sportsclaw openshell setup           # prints the step-by-step recipe; runs nothing
```

`doctor` inspects `--image` with whichever local runtime responds (docker, else podman); the same
image is used by the opt-in `--probe` (which creates and deletes one short-lived sandbox) and named
in remediation hints. `--remote` omits the local runtime and image checks and reports them as
skipped/not checked — it does **not** verify that the gateway can pull the image or that the
runtime enforces policy. The CLI version, gateway registration and provider checks always run.
Live sandbox/runtime behaviour is not qualified by `doctor`.

`setup` is print-only: it renders shell-quoted profile lint/import, provider create and
`sandbox create --provider` commands plus a matching job config, runs no probes, never
provisions or takes credentials, and exits 0. Diagnostics (including `--json`) are `doctor` only.
The printed base policy defaults to the local-only `policy.vault.yaml`; pass
`--policy connected` (write-capable Machina MCP + public market/news egress, printed with a
warning) or `--policy vault-espn` to opt in to more. A hosted provider attachment still authorizes
external inference egress to that provider even on the local-only policy.
`openshell gateway add` only registers an existing gateway; it does not start one.
`openshell profile lint` needs an active gateway. Lint the shipped profiles against your selected
gateway before importing them; static repository checks cannot establish live compatibility.

## The steps

```bash
# 1. Import a provider profile (shipped in the npm package under openshell/providers/)
openshell profile lint -f openshell/providers/nvidia-native.yaml
openshell profile import -f openshell/providers/nvidia-native.yaml

# 2. Create a provider from the NVIDIA_API_KEY in your own shell
openshell provider create --name nvidia-native-prod --type nvidia-native --from-existing

# 3. Launch from an OCI image with the provider attached
openshell sandbox create --name sportsclaw-tv \
  --from <registry>/sportsclaw-openshell:<tag> \
  --provider nvidia-native-prod \
  --policy openshell/policy.vault.yaml \
  --upload ./tv-operator.json:/sandbox/.sportsclaw/operator/tv-operator.json \
  -- node /app/dist/index.js operate --job tv-operator --once
```

`--from` takes an image reference the gateway's engine can pull (or a rootfs tar), not a
Dockerfile. For a long-running job, add `--detach --restart-policy on-failure` and drop `--once`
so the daemon runs as the sandbox's foreground main process under OpenShell. Don't use
`sportsclaw start operator` for OpenShell jobs — it installs a host service outside any sandbox,
where the job refuses to start.

## Operator job config

```jsonc
{
  "provider": "openai",
  "model": "nvidia/nemotron-3-super-120b-a12b",
  "openshell": {
    "baseUrl": "https://integrate.api.nvidia.com/v1",  // provider-native URL
    "credentialEnv": "NVIDIA_API_KEY",                 // var declared by the attached profile
    "apiMode": "chat",                                 // or "responses" (OpenAI-style only)
    "timeoutMs": 300000
  }
}
```

Use `"credentialless": true` instead of `credentialEnv` for an unauthenticated local NIM
(`http://host.openshell.internal:8000/v1`, profile `openshell/providers/nim-local.yaml`).
`provider` may be `openai` (including OpenAI-compatible hosts) or `anthropic`, and must be set in
the job. Model roles with `route: "openshell"` take the same fields.

The job refuses to start outside an OpenShell sandbox (OpenShell sets `OPENSHELL_SANDBOX=1` in the
processes it launches) or when the sandbox did not set the credential env var. Copies of either
saved in `~/.sportsclaw/.env` or `config.json` are ignored. It never falls back to other provider
keys or a local Claude Code login, and never changes global provider env vars or the global HTTP
dispatcher. These checks are operational guards, not attestation: the environment
marker proves nothing on its own. Confirm enforcement with `openshell policy get <sandbox> --full`
and a real request from a new sandbox process.

Full runbook, policies (connected TV, private Vault, Vault + ESPN) and troubleshooting:
[`openshell/README.md`](https://github.com/machina-sports/sportsclaw/blob/main/openshell/README.md).
