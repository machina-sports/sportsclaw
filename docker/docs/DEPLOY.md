# SportsClaw Relay — Deployment Guide

## Architecture

```
HTTP client → relay_server.py (aiohttp :8080) → sportsclaw CLI (--pipe) → LLM API
                                                       ├→ Python bridge → sports-skills
                                                       └→ MCP client → external APIs
```

Each tenant gets its own pod with isolated config, secrets, memory, and skill selection.

## Quick Start

```bash
# 1. Provision a new tenant overlay
./docker/relay/k8s/provision.sh acme google football,nba,betting AIzaSy...

# 2. Deploy
kubectl apply -k docker/relay/k8s/overlays/acme

# 3. Verify
kubectl get pods -n sportsclaw -l sportsclaw-user=acme
kubectl logs -n sportsclaw -l sportsclaw-user=acme

# 4. Test
kubectl port-forward -n sportsclaw svc/acme-sportsclaw-relay 8080:80
curl -s http://localhost:8080/health
```

## Docker Image

```bash
# Build
docker build -t machinasports/sportsclaw-relay:v0.9.4 -f docker/relay/Dockerfile .

# Push
docker push machinasports/sportsclaw-relay:v0.9.4
```

Image: `machinasports/sportsclaw-relay` on Docker Hub.

## Tenant Configuration

Each tenant is a Kustomize overlay under `docker/relay/k8s/overlays/<tenant>/` with three files:

```
overlays/<tenant>/
├── kustomization.yaml   ← identity, patches
├── config.env           ← non-sensitive config
└── secrets.env          ← API keys (DO NOT commit real values)
```

### config.env — Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SPORTSCLAW_SKILLS` | **yes** | — | Comma-separated active skills |
| `SPORTSCLAW_PROVIDER` | **yes** | — | LLM provider: `google`, `anthropic`, `openai` |
| `SPORTSCLAW_MODEL` | no | provider default | Model override (e.g. `gemini-2.0-flash`) |
| `SPORTSCLAW_MEMORY_DIR` | no | `/data/memory` | Persistent memory path (mapped to PVC) |
| `SPORTSCLAW_MCP_SERVERS` | no | — | MCP server connections (JSON, see below) |
| `SPORTSCLAW_SKILL_GUIDES_DIR` | no | — | Path to SKILL.md guides in container |
| `RELAY_PORT` | no | `8080` | HTTP port inside container |
| `RELAY_TIMEOUT` | no | `180` | Max query duration in seconds |
| `PYTHON_PATH` | no | `/opt/venv/bin/python3` | Python interpreter path |

**Available skills:** `football`, `nfl`, `nba`, `nhl`, `mlb`, `wnba`, `tennis`, `cfb`, `cbb`, `golf`, `f1`, `kalshi`, `polymarket`, `news`, `betting`, `markets`

### secrets.env — API Keys

| Variable | When |
|----------|------|
| `GOOGLE_GENERATIVE_AI_API_KEY` | provider = `google` |
| `ANTHROPIC_API_KEY` | provider = `anthropic` |
| `OPENAI_API_KEY` | provider = `openai` |
| `SPORTSCLAW_MCP_TOKEN_<SERVER>` | One per MCP server (uppercase, hyphens → underscores) |

Example: MCP server named `adidas-tracker` → env var `SPORTSCLAW_MCP_TOKEN_ADIDAS_TRACKER`.

### kustomization.yaml — Identity & Patches

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - ../../base

namePrefix: acme-           # all resources get this prefix

commonLabels:
  sportsclaw-user: acme     # for kubectl -l filtering

configMapGenerator:
  - name: sportsclaw-config
    namespace: sportsclaw
    envs:
      - config.env

secretGenerator:
  - name: sportsclaw-secrets
    namespace: sportsclaw
    envs:
      - secrets.env
    type: Opaque

# Pin image version (optional)
patches:
  - target:
      kind: Deployment
      name: sportsclaw-relay
    patch: |-
      - op: replace
        path: /spec/template/spec/containers/0/image
        value: machinasports/sportsclaw-relay:v0.9.4
```

## MCP Integration

Connect external MCP servers (Machina Core APIs, custom tools) by setting `SPORTSCLAW_MCP_SERVERS` in config.env:

```env
SPORTSCLAW_MCP_SERVERS={"adidas-tracker":{"url":"https://machina-podcasts-adidas-tracker.org.machina.gg/mcp/sse"}}
```

Format: `{"<server-name>": {"url": "<sse-endpoint>", "headers": {"X-Custom": "..."}}}`.

Auth token is resolved automatically from `SPORTSCLAW_MCP_TOKEN_<SERVER_NAME_UPPER>` in secrets.env. Tools are discovered at startup via `client.listTools()` and registered as `mcp__<server>__<tool>`.

## Skill Guides (Optional)

Load SKILL.md behavioral guides from git repos via initContainers. Add this patch to `kustomization.yaml`:

```yaml
patches:
  - target:
      kind: Deployment
      name: sportsclaw-relay
    patch: |-
      - op: add
        path: /spec/template/spec/initContainers
        value:
          - name: clone-skills
            image: alpine/git
            command: ["sh", "-c", "git clone --depth 1 https://github.com/machina-sports/adidas-templates.git /skill-guides/adidas"]
            volumeMounts:
              - name: skill-guides
                mountPath: /skill-guides
```

And set in config.env:

```env
SPORTSCLAW_SKILL_GUIDES_DIR=/opt/skill-guides/skills
```

## Kubernetes Resources (per tenant)

The base creates these resources (all prefixed with `<tenant>-`):

| Resource | Name | Notes |
|----------|------|-------|
| Namespace | `sportsclaw` | Shared across tenants |
| Deployment | `<tenant>-sportsclaw-relay` | 1 replica, Recreate strategy |
| Service | `<tenant>-sportsclaw-relay` | ClusterIP, port 80 → 8080 |
| PVC | `<tenant>-sportsclaw-memory` | 1Gi RWO, persistent memory |
| ConfigMap | `<tenant>-sportsclaw-config-<hash>` | From config.env |
| Secret | `<tenant>-sportsclaw-secrets-<hash>` | From secrets.env |

### Resource Limits

| | Request | Limit |
|--|---------|-------|
| CPU | 250m | 1 |
| Memory | 512Mi | 1Gi |

## Container Modes

The entrypoint supports multiple modes via the `args` field in the Deployment:

| Args | Mode | Description |
|------|------|-------------|
| `["relay"]` | HTTP API (default) | aiohttp server on `RELAY_PORT` |
| `["cli", "prompt here"]` | One-shot query | Run a single query, exit |
| `["listen", "discord"]` | Discord bot | Long-running Discord listener |
| `["listen", "telegram"]` | Telegram bot | Long-running Telegram listener |

## Operations

```bash
# Deploy / update tenant
kubectl apply -k docker/relay/k8s/overlays/<tenant>

# Force re-pull image (same tag)
kubectl rollout restart deployment/<tenant>-sportsclaw-relay -n sportsclaw

# View logs
kubectl logs -n sportsclaw -l sportsclaw-user=<tenant> -f

# Shell into pod
kubectl exec -it -n sportsclaw deploy/<tenant>-sportsclaw-relay -- bash

# Delete tenant
kubectl delete -k docker/relay/k8s/overlays/<tenant>

# List all tenants
kubectl get deployments -n sportsclaw -l managed-by=sportsclaw-kustomize

# Port-forward for local testing
kubectl port-forward -n sportsclaw svc/<tenant>-sportsclaw-relay 8080:80
```

## Network Access

The Service is `ClusterIP` (cluster-internal only). Options for external access:

1. **Ingress** — add an Ingress resource per tenant
2. **Proxy** — route through an existing gateway (e.g. organization-api)
3. **Port-forward** — for local dev/testing only

Internal DNS from other pods in the cluster:

```
http://<tenant>-sportsclaw-relay.sportsclaw.svc:80
```

## Example: Full Tenant Config (adidas)

**config.env:**
```env
SPORTSCLAW_SKILLS=football,betting
SPORTSCLAW_PROVIDER=google
SPORTSCLAW_MEMORY_DIR=/data/memory
RELAY_PORT=8080
PYTHON_PATH=/opt/venv/bin/python3
SPORTSCLAW_MCP_SERVERS={"adidas-tracker":{"url":"https://machina-podcasts-adidas-tracker.org.machina.gg/mcp/sse"}}
```

**secrets.env:**
```env
GOOGLE_GENERATIVE_AI_API_KEY=AIzaSy...
SPORTSCLAW_MCP_TOKEN_ADIDAS_TRACKER=_0TOXs48NZm...
```
