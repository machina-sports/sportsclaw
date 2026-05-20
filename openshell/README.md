# SportsClaw × NVIDIA OpenShell

Runbook for running a SportsClaw operator daemon inside an [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) sandbox with LLM calls routed through OpenShell's Privacy Router.

OpenShell is **optional**. If you're not running on NVIDIA infra (or just don't want the sandbox layer), omit the `openshell` block from your job config and SportsClaw uses direct LLM calls exactly as before. Nothing in this directory is on the default code path.

For the rationale, integration design, and risk register, see:
- `../docs/openshell-research.md` — Phase 0 research findings.
- `../docs/openshell-integration-plan.md` — Phase 1 design + decisions.

---

## What this gives you

- LLM calls routed through OpenShell's Privacy Router (`https://inference.local`) instead of direct calls to Anthropic / OpenAI.
- Sandboxed execution with declarative YAML policies for filesystem, network, and process layers.
- Credential isolation — provider API keys live in the gateway, not in the sandbox.
- Per-call routing visibility via `openshell logs <sandbox> --tail` plus `inferenceRoute` fields on every TickEvent.

What this does **not** give you:
- Multi-provider routing in a single tick. Per-gateway, OpenShell exposes one provider + one model. If your job needs Anthropic for narration *and* Nemotron for safety in the same tick, you need NemoClaw-style LiteLLM-on-host (not shipped here).
- Gemini routing. The Privacy Router doesn't speak Google's `generativelanguage.googleapis.com` protocol. Pick `anthropic` or `openai` for an OpenShell-enabled job (validator enforces this).

---

## Prerequisites

- A supported host: macOS (Apple Silicon), Linux, or Windows WSL 2.
- A container runtime: Docker or Podman.
- OpenShell installed:
  ```bash
  curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh
  ```
- A SportsClaw job config under `~/.sportsclaw/operator/<jobId>.json` (see `examples/operator-jobs/` in the repo root).

---

## Easy path — bundled wizard

```bash
sportsclaw openshell doctor    # diagnose what's installed and what's missing
sportsclaw openshell setup     # interactive: install, gateway, provider, image build, config scaffold
```

The wizard shells out to `openshell` and `docker` for each step and asks before doing anything destructive. It does **not** create the sandbox or run the daemon for you — those are still explicit OpenShell commands so the runtime stays the user's mental model. After `setup` finishes, jump to step 5 of the manual quickstart below.

---

## Manual quickstart

1. **Start an OpenShell gateway** (one-time per machine):
   ```bash
   openshell gateway add http://127.0.0.1:18080 --local --name local
   openshell gateway select local
   ```

2. **Configure your inference provider.** Anthropic example:
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   openshell provider create --name anthropic-prod --type anthropic --from-existing
   openshell inference set --provider anthropic-prod --model claude-opus-4-6
   ```
   Long-thinking models can exceed the 60s default timeout — add `--timeout 300` if you see truncated responses. See `models.md` for provider/model picks.

3. **Build the SportsClaw sandbox image:**
   ```bash
   docker build -t sportsclaw-openshell:latest -f openshell/Dockerfile .
   ```

4. **Add `openshell` block to your job config** (`~/.sportsclaw/operator/<jobId>.json`):
   ```json
   {
     "jobId": "tv-operator",
     "intervalMs": 60000,
     "personaText": "...",
     "provider": "anthropic",
     "model": "claude-opus-4-6",
     "openshell": {}
   }
   ```
   An empty `openshell: {}` block enables the feature with provider-appropriate defaults (`baseUrl: "https://inference.local"` for Anthropic).

5. **Launch the sandbox with the SportsClaw image and policy:**
   ```bash
   openshell sandbox create \
       --from sportsclaw-openshell:latest \
       --policy openshell/policy.yaml \
       --name sportsclaw-tv
   ```

6. **Run a single tick to verify routing:**
   ```bash
   openshell sandbox exec -n sportsclaw-tv -- \
       node dist/index.js operate --job tv-operator --once
   ```
   The startup banner should include `inference=openshell(https://inference.local)`. Every TickEvent emitted by the daemon carries an `inferenceRoute` field with `via: "openshell"`.

7. **Watch routing in OpenShell's log:**
   ```bash
   openshell logs sportsclaw-tv --tail
   ```
   You should see `inference.local` requests with the policy decision and upstream model resolution.

---

## Policy customization

`policy.yaml` in this directory is a starting point. It allows:
- Read-only access to standard system paths.
- Read/write to `/sandbox` and `/tmp`.
- Outbound HTTPS to the configured tail-server, image-generation endpoints, and YouTube Live (commented placeholders — uncomment and edit).
- Inference traffic routes through `inference.local` (handled separately by the Privacy Router, not by `network_policies`).

To pull and edit the active policy on a running sandbox:
```bash
openshell policy get sportsclaw-tv -o yaml > current-policy.yaml
# ... edit ...
openshell policy set sportsclaw-tv --policy current-policy.yaml
```

`network_policies` is hot-reloadable (~5s). `filesystem_policy`, `landlock`, and `process` are static — changing them requires sandbox recreation.

For policy field reference, see [OpenShell Policy Schema](https://github.com/NVIDIA/OpenShell/blob/main/docs/reference/policy-schema.mdx).

---

## Troubleshooting

**`OpenShell mode: cannot resolve "inference.local"`** at startup — the launcher's DNS probe is reporting that you're not inside an OpenShell sandbox. Either run via `openshell sandbox exec` / `openshell sandbox connect`, or set `"openshell": {"enabled": false}` to disable.

**`policy_denied` 403 from the gateway** — a network call is hitting a host that isn't in `network_policies`. Either add it to the policy or route inference via `inference.local` (`openshell inference set ...`).

**LLM call returns 4xx like `unsupported_method`** — the Privacy Router only serves the routes its configured provider supports (Anthropic → `/v1/messages` only; OpenAI-compatible → `/v1/chat/completions` and friends). Confirm `cfg.provider` matches the gateway's configured provider.

**Tick latency longer than 60s** — Privacy Router default per-call timeout is 60s. For long-thinking Nemotron or Claude with extended reasoning, raise it: `openshell inference set ... --timeout 300`.

**`openshell sandbox create --from sportsclaw-openshell:latest` fails to find the image** — the build step (step 3 above) didn't run, or you're targeting a remote gateway. The CLI uses the local Docker daemon for `--from <image>`; remote gateways need a registry reference instead.

---

## Files in this directory

| File | Purpose |
|---|---|
| `README.md` | This runbook. |
| `Dockerfile` | Sandbox image, layered on the root `Dockerfile`. |
| `policy.yaml` | Reference OpenShell policy (network + filesystem + process). |
| `models.md` | Suggested provider/model pairings + Nemotron variant table. |

Per [D4](../docs/openshell-integration-plan.md), this directory lives in the engine repo as static recipe files. It ships in the npm release but contributes nothing to the install path and is inert unless a job config opts in.
