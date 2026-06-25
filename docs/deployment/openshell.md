# Running with NVIDIA OpenShell

You can run sportsclaw inside an [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell)
sandbox — a hardened, policy-enforced environment where the agent's model calls route through
OpenShell's **Privacy Router** instead of going straight to a provider. The sandbox injects
credentials and enforces egress policy, so your API keys never live inside the agent process.

::: tip When to use it
Reach for OpenShell when you're running sportsclaw unattended (a bot or an
[operator job](../advanced/operator)) and want credential isolation, policy-controlled network
egress, and a reproducible sandbox — common for broadcasters, sportsbooks, and teams with
compliance requirements.
:::

## Check your setup

The fastest way to see what's missing is the built-in doctor:

```bash
sportsclaw openshell doctor          # diagnose prerequisites + print fixes
sportsclaw openshell doctor --json   # machine-readable
```

It checks, in order: the OpenShell CLI, a registered gateway, a configured provider, the active
inference target, and whether a sandbox actually provisions — and prints the exact remediation
command for anything that's off.

## Guided setup

```bash
sportsclaw openshell setup
```

An interactive wizard that walks you through everything below. If you'd rather do it by hand,
the steps are:

**1. Install the OpenShell CLI**

```bash
curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh
```

**2. Register and select a gateway**

```bash
openshell gateway add http://127.0.0.1:18080 --local --name local
openshell gateway select local
```

**3. Create a provider** (reusing your existing keys)

```bash
openshell provider create --name claude --type anthropic --from-existing
```

`--type` is one of `anthropic`, `openai`, or `nvidia`.

**4. Point inference at it**

```bash
openshell inference set --provider claude --model claude-opus-4-6 --timeout 300
```

Re-run `sportsclaw openshell doctor` to confirm everything is green.

## Running sportsclaw in a sandbox

Create a sandbox from your sportsclaw image (add `--gpu` if you're running a local model), then
start the agent inside it:

```bash
openshell sandbox create --from <your-sportsclaw-image> --name sportsclaw
openshell sandbox exec -n sportsclaw -- sportsclaw listen discord
```

Inside the sandbox, point your model provider at the Privacy Router and use a placeholder key —
OpenShell injects the real credentials and enforces policy:

```bash
OPENAI_BASE_URL=https://inference.local/v1
```

`https://inference.local` is reachable **only from inside the sandbox**; it is never exposed to
the host.

## Operator jobs

If you run sportsclaw as an autonomous [operator](../advanced/operator), opt a job into the
Privacy Router by adding an `openshell` block to its config:

```jsonc
{
  "openshell": {
    "enabled": true,
    "baseUrl": "https://inference.local/v1"
  }
}
```

With that set, the operator daemon routes its model calls through OpenShell on every tick.
