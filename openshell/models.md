# Provider & Model Pairings for OpenShell Mode

This is one supported configuration among several. The recipe in this directory works with any provider OpenShell's Privacy Router supports; the NVIDIA Nemotron + Anthropic pairing below is what the Machina Sports TV case study uses.

Per gateway, the Privacy Router exposes **one provider and one model** at a time. To switch, run `openshell inference update --provider <name> --model <id>` — propagates to running sandboxes in ~5 seconds without recreation.

## Anthropic (frontier narration)

Recommended for SportsClaw jobs that need long-form broadcast text and tool-use chains.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
openshell provider create --name anthropic-prod --type anthropic --from-existing
openshell inference set --provider anthropic-prod --model claude-opus-4-6
```

Supported Privacy Router route: `POST /v1/messages` only.

Job config:
```json
{
  "provider": "anthropic",
  "model": "claude-opus-4-6",
  "openshell": {}
}
```

## NVIDIA Nemotron via NVIDIA API Catalog (frontier, GPU-backed)

```bash
export NVIDIA_API_KEY=nv-...
openshell provider create --name nvidia-prod --type nvidia --from-existing
openshell inference set \
    --provider nvidia-prod \
    --model nvidia/nemotron-3-super-120b \
    --timeout 300
```

Supported route patterns: OpenAI-compatible (`/v1/chat/completions`, `/v1/responses`, `/v1/completions`, `/v1/models`).

For long-thinking phases, set `--timeout 300` (or higher) — Nemotron's default extended reasoning can exceed the 60s Privacy Router default and truncate mid-stream.

Job config:
```json
{
  "provider": "openai",
  "model": "nvidia/nemotron-3-super-120b",
  "openshell": {}
}
```

(`provider: "openai"` because OpenShell exposes Nemotron via the OpenAI-compatible API surface — the SDK is what matters, not the upstream vendor.)

## Nemotron-local (on-device, requires NVIDIA GPU)

For a self-hosted Nemotron via vLLM or similar:

```bash
openshell provider create \
    --name nemotron-local \
    --type openai \
    --credential OPENAI_API_KEY=empty-if-not-required \
    --config OPENAI_BASE_URL=http://host.openshell.internal:8000/v1
openshell inference set --provider nemotron-local --model nemotron-3-nano-30b
```

`host.openshell.internal` resolves from inside the sandbox to the host machine running the inference server. Avoid `127.0.0.1` / `localhost` — the request originates from the gateway, not your shell.

## Variant cheatsheet

| Variant | Where it lives | Use when |
|---|---|---|
| `nvidia/nemotron-3-super-120b` | NVIDIA API Catalog | Cloud GPU, frontier reasoning |
| `nvidia/nemotron-3-nano-30b-a3b` | NVIDIA API Catalog | Cheaper / lower latency cloud |
| Local Nemotron (`--type openai` against vLLM) | On-device GPU | Air-gapped or full-data-locality scenarios |
| `claude-opus-4-6` | Anthropic via Privacy Router | Long narration, tool chains |
| `claude-sonnet-4-5-20250514` | Anthropic via Privacy Router | Faster, cheaper Claude |

## What does NOT work in OpenShell mode

- **Gemini.** The validator rejects `provider: "google"` when `openshell` is enabled. OpenShell's Privacy Router doesn't speak Google's `generativelanguage.googleapis.com` protocol. Either drop the `openshell` block (direct calls) or pick a different provider for OpenShell jobs.
- **Multi-provider per tick.** Gateway-scoped one-provider-one-model. If a tick needs Nemotron for safety + Claude for narration, you need a host-side proxy (LiteLLM-style) that multiplexes upstreams — not shipped here.

See `../docs/openshell-research.md` §a for the Privacy Router protocol details.
