# Provider & Model Pairings for OpenShell 0.1.x Mode

In OpenShell 0.1.x the job config — not the gateway — picks the endpoint, model, API mode and timeout. Each SportsClaw job (and each model role) can target a different provider; attach every provider that job needs to its sandbox. Provider attachment grants access; it does not select or restrict the model.

Every pairing needs an imported provider profile whose endpoints cover the base URL and whose `binaries` include `/usr/local/bin/node`. Do not reuse the upstream `openai`/`anthropic` example profiles for another host — import an endpoint-bearing profile under its own id.

## NVIDIA Nemotron via NVIDIA API Catalog

Profile: `providers/nvidia-native.yaml` (credential env `NVIDIA_API_KEY`).

```json
{
  "provider": "openai",
  "model": "nvidia/nemotron-3-super-120b-a12b",
  "openshell": {
    "baseUrl": "https://integrate.api.nvidia.com/v1",
    "credentialEnv": "NVIDIA_API_KEY",
    "timeoutMs": 300000
  }
}
```

`provider: "openai"` selects the OpenAI-compatible wire format. Default `apiMode` is `chat` (`/chat/completions`); set `"apiMode": "responses"` for hosts that serve `/responses`. Long reasoning phases need a generous `timeoutMs`.

## Anthropic

Write a profile under your own id (e.g. `anthropic-native`) declaring `ANTHROPIC_API_KEY` bound to `api.anthropic.com` (path `/v1/**`) with `binaries: [/usr/local/bin/node]`, then:

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "openshell": {
    "baseUrl": "https://api.anthropic.com/v1",
    "credentialEnv": "ANTHROPIC_API_KEY"
  }
}
```

`apiMode` is not valid for Anthropic (native Messages API). A local Claude Code OAuth login is never used for OpenShell jobs.

## Local NIM / vLLM (on-device GPU)

Profile: `providers/nim-local.yaml` (credentialless, `host.openshell.internal:8000`; edit the port as needed). Sandboxes reach host services through `host.openshell.internal`, not `127.0.0.1`/`localhost`.

```json
{
  "provider": "openai",
  "model": "<served model id>",
  "openshell": {
    "baseUrl": "http://host.openshell.internal:8000/v1",
    "credentialless": true
  }
}
```

## Model roles

`inference.roles.<role>` with `route: "openshell"` takes the same `baseUrl`, `credentialEnv` | `credentialless`, `apiMode`, `timeoutMs` fields and the same sandbox guard. `route: "nim"` needs no OpenShell fields and works outside a sandbox.

## What does NOT work in OpenShell mode

- **Gemini / Azure Foundry.** Not wired for OpenShell native mode; the validator rejects them when `openshell` is enabled.
- **`provider: "openai-compatible"`.** Use `provider: "openai"` with `openshell.baseUrl` instead.
