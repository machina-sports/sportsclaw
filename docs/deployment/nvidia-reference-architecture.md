# NVIDIA reference architecture: SportsClaw local foundation

This is a **single-user deployment foundation**, not a claim that a workstation implements the complete NVIDIA Secure Agent Workspace Reference Design. It uses OpenShell's native controls instead of adding another orchestration or policy service.

## Version and scope

- Qualify OpenShell **v0.1.5** as a coordinated CLI, gateway, compute-driver, supervisor and image deployment. The SportsClaw adapter does not accept an arbitrary future release.
- Build SportsClaw from the selected reviewed commit. Record the commit, package digest and sandbox image digest. An installed CLI, a merged source change and a running sandbox are separate states.
- Direct-provider SportsClaw remains independent of OpenShell. Explicit OpenShell jobs must fail closed before inference, tools or MCP when their runtime requirements are absent.
- The local configuration uses a CPU MicroVM on macOS ARM64. It does not claim NVIDIA GPU confidential computing, attestation, BlueField isolation or an enterprise identity provider.

## Native components

```text
Operator CLI -- authenticated TLS --> local OpenShell gateway
                                      | provider credentials (host-side)
                                      | effective policy and manual approval
                                      | audit JSONL and metrics
                                      v
                             OpenShell MicroVM supervisor
                                      |
                         SportsClaw foreground operator
                                      |
                      inspected native provider API requests
```

The gateway remains outside the workload. Each workload gets only its attached provider credentials through OpenShell's credential mediation. Do not copy real keys into images, job JSON, `--env`, launch-agent definitions or shell arguments. The injected placeholder and `OPENSHELL_SANDBOX=1` are not cryptographic attestation.

## Local gateway configuration

Use the repository file `openshell/gateway.local.toml.example`. This is a template, not a ready-to-run file.

1. Install matching official v0.1.5 binaries and verify their published archive hashes. On macOS, the VM driver needs the official Hypervisor entitlement and `e2fsprogs`; follow the versioned NVIDIA installation instructions.
2. Choose a private state directory and a versioned binary directory. Replace every `/ABSOLUTE/STATE` and `/ABSOLUTE/BIN` in the template with absolute paths. TOML does not expand shell variables.
3. Create the state directory and its `logs`, `vm` and `state` subdirectories with owner-only access. Keep certificates, private keys and database backups out of the repository.
4. Create a fresh, owner-only directory at `<state>/certgen-config`. Run `XDG_CONFIG_HOME=<state>/certgen-config openshell-gateway generate-certs --output-dir <state>/tls --server-san host.openshell.internal` for this new gateway. Scope `XDG_CONFIG_HOME` to this command only. In v0.1.5, certificate generation also writes the default `openshell` CLI alias's trust bundle under `XDG_CONFIG_HOME`, even when `--output-dir` is separate. Isolating that side effect preserves existing aliases; do not generate into another gateway's TLS directory. Install only the intended new alias's bundle in step 8.
5. Set `XDG_STATE_HOME=<state>/state` in the gateway service environment. Run `openshell-gateway config preflight --path <gateway.toml>` before starting it.
6. Start `openshell-gateway --config <gateway.toml>` under the host's service manager. Bind the API, health and metrics listeners to loopback, as in the template. Do not expose these ports publicly.
7. Register a distinct named local gateway with `openshell gateway add https://localhost:17671 --local --name sportsclaw-local-v015`.
8. Verify that the named CLI gateway's mTLS bundle matches this gateway's generated CA and client certificate. In a side-by-side Homebrew migration, `gateway add --local` can populate the new alias with the old Homebrew bundle. After registration, install the new gateway's `ca.crt`, `client/tls.crt` and `client/tls.key` as `ca.crt`, `tls.crt` and `tls.key` under the new alias's `~/.config/openshell/gateways/sportsclaw-local-v015/mtls/` directory, with owner-only permissions. Do not modify the old bundle or use `--gateway-insecure`.
9. Verify `openshell status -g sportsclaw-local-v015 -o json` and `openshell gateway info`. Check the server and driver versions, not just `openshell --version`.

The template disables unauthenticated users, operator mTLS mode, service HTTP exposure and WebSocket tunneling. It enables fail-closed policy validation. These settings do not replace enterprise user authorization.

Use an isolated new gateway for a 0.0.x migration. Back up the old database using SQLite's backup API, along with its configuration and encryption/trust material. Verify the backup before stopping the old service. Do not point the new gateway at an old database and assume an in-place upgrade works.

## Provider and audit configuration

For NVIDIA API Catalog inference, validate and import the bundled profile:

```sh
openshell profile lint -g sportsclaw-local-v015 -f openshell/providers/nvidia-native.yaml
openshell profile import -g sportsclaw-local-v015 -f openshell/providers/nvidia-native.yaml
openshell profile describe nvidia-native -g sportsclaw-local-v015
```

Create the provider using an existing approved credential supplied securely in the CLI process environment, not as a literal argument:

```sh
openshell provider create --name nvidia-prod --type nvidia-native \
  --credential NVIDIA_API_KEY -g sportsclaw-local-v015
openshell provider list --names -g sportsclaw-local-v015
```

An API Catalog provider permits public NVIDIA API egress. Do not call that workload local-only or private inference. A private NIM deployment needs an actual local NIM endpoint and a matching custom profile; the example endpoint alone is not a working NIM deployment.

Enable sandbox audit export and disable agent-authored policy proposals explicitly:

```sh
openshell settings set --global --key ocsf_json_enabled --value true --yes -g sportsclaw-local-v015
openshell settings set --global --key agent_policy_proposals_enabled --value false --yes -g sportsclaw-local-v015
openshell settings get --global --json -g sportsclaw-local-v015
```

The gateway's own OCSF file is configured separately in TOML. Its writer is asynchronous and best-effort. Observe queue utilization, dropped records and write failures at the loopback metrics endpoint. Local daily rotation is not durable enterprise retention or a SIEM integration. Add an approved external collector and alerts before making that claim.

## Workload launch and acceptance

Use the existing [OpenShell deployment recipe](openshell.md), with the selected gateway and explicit image/provider/policy. Keep the operator as the canonical foreground process; use `--detach --restart-policy on-failure`, not a host retry loop around `sandbox exec`.

Use `--approval-mode manual` and `--no-auto-providers` during qualification. Review the effective policy after provider attachment. Profiles add endpoints to the authored policy; an apparently private YAML file can gain public egress through a hosted provider.

For a local MicroVM, `sandbox create --from` also accepts a rootfs tar produced from the selected image. This avoids publishing a development image to a registry. This upload uses caller-supplied driver configuration, which the gateway template **disables**. Obtain gateway-owner approval before temporarily setting `allow_driver_config = true` under `[openshell.drivers.vm]`; keep resource admission enabled, scope the change to the isolated test gateway, and restore it after the test. Do not silently bypass a rejected import. Use sandbox names of at most 19 characters for this release.

Preserve the image digest and rootfs digest together. Do not attach host home directories, Docker sockets, gateway state or credential stores to a workload.

The driver-config gate also applies when the gateway restarts imported workloads. Complete the disposable test and delete its sandbox **before** restoring the restriction and restarting the gateway. A successful temporary rootfs import is not a restart-safe persistent deployment. A persistent workload needs a separately approved launch path and a verified restart test.

### macOS MicroVM filesystem qualification

With a restrictive host service umask, v0.1.5 can copy host directory modes into generated guest disks. A guest overlay `/upper` with mode `0700` can prevent the non-root boundary from reading `/proc/self/status`. Bootstrap directories `/opt/openshell` and `/opt/openshell/bin` with mode `0700` can then prevent execution of the Landlock qualification child. These failures occur before the workload's filesystem policy is applied; widening that policy does not repair them.

Inspect the affected guest inodes read-only before proposing a correction. If confirmed, obtain approval, preserve a sparse or copy-on-write backup, and normalize only the affected guest runtime directories to root-owned `0755`. Check filesystem integrity afterward. Retain owner-only host files, private guest state, TLS, capability dropping, Landlock and seccomp. Cached-image repair is a local workaround, not an upstream fix; regenerating the cache requires requalification.

Check runtime warnings as well as successful inference. A missing cgroup `pids.max` means a cgroup PID limit was not verified. Do not describe resource admission or another process limit as proof of that control.

Acceptance requires observed results from the selected running sandbox:

- SportsClaw's installed version and package match the reviewed build.
- A permitted model request succeeds through the native NVIDIA endpoint, with its actual response recorded separately from fixtures.
- The workload cannot read the real provider credential; the trusted gateway substitutes it at the approved endpoint.
- Required filesystem paths work; writes outside the writable set fail. Confirm the runtime actually applied the policy paths.
- A forbidden network destination and a forbidden method/path at an allowed endpoint are denied. Confirm the denials in audit evidence.
- MCP calls use only approved endpoints and methods. A successful generic HTTP request is not an MCP protocol test.
- Manual approval cannot be bypassed by the agent. Provider revocation and sandbox stop/restart behave as intended.
- The daemon remains healthy, audit failures are observable, and rollback state is recoverable.

Do not label profile lint, a healthy gateway or a fixture model response as completion of this checklist. Keep a non-secret deployment receipt outside the public repository with exact versions, digests, evidence paths and untested gates.

## Enterprise controls still needed

Before deploying shared or sensitive workloads, select and qualify the relevant controls from NVIDIA's reference design:

- Enterprise identity, workload identity, ownership and scoped authorization. Single-user mTLS is not SSO or a multi-tenant authorization model.
- Approved and versioned policy distribution, human approval and revocation. A local editable TOML file is not signed, centrally governed policy.
- Auditable delegated access to enterprise systems. Credentials and network permission alone do not authorize consequential business actions.
- Approved image supply chain and update/rollback process. Use immutable image references for a qualified deployment.
- Network segmentation, approved data residency and egress boundaries. Local loopback binding is not a corporate perimeter.
- Central audit collection, retention, loss alerts and incident response. Local JSONL is only a source.
- The appropriate CPU/GPU isolation tier, hardware attestation and confidential-computing controls where the deployment requires them. These cannot be manufactured by a SportsClaw configuration flag.

Do not add a second policy engine or control plane merely to reproduce features already provided by OpenShell. Integrate the enterprise systems that actually exist, under their own approval boundaries.

## Primary sources

- [NVIDIA announcement](https://nvidianews.nvidia.com/news/openshell-reference-architecture)
- [Secure Agent Workspace Reference Design](https://docs.nvidia.com/enterprise-reference-architectures/secure-agent-workspace-reference-design/latest/)
- [OpenShell v0.1.5 release](https://github.com/NVIDIA/OpenShell/releases/tag/v0.1.5)
- [v0.1.5 gateway configuration](https://github.com/NVIDIA/OpenShell/blob/v0.1.5/docs/how-it-works/gateways/configuration.mdx)
- [v0.1.5 support matrix](https://github.com/NVIDIA/OpenShell/blob/v0.1.5/docs/about/support-matrix.mdx)
- [v0.1.5 native inference](https://github.com/NVIDIA/OpenShell/blob/v0.1.5/docs/how-it-works/inference.mdx)
- [v0.1.5 OCSF export](https://github.com/NVIDIA/OpenShell/blob/v0.1.5/docs/observability/ocsf-json-export.mdx)
