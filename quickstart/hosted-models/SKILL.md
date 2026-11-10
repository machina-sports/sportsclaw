---
name: hosted-models
description: Deploy a self-chosen model behind an OpenAI-compatible endpoint (Brev + vLLM, or the hosted NVIDIA API) and connect SportsClaw to it, verifying each step and reporting only what was actually observed.
---

# Hosted models for SportsClaw

Use this guide to put a model you chose behind an OpenAI-compatible `/v1` endpoint and point
SportsClaw at it. `sportsclaw quickstart` only writes files. It deploys nothing, so every step
below is done by the operator with the platform's own tools.

## 1. Check the model and runtime fit

- Any Hugging Face model id is accepted, but that is not support. Confirm on the model card
  that the chosen runtime serves it (vLLM for `serve.sh`), that it has a chat template, and
  that it does tool calling. If it does, find the matching vLLM `--tool-call-parser`. There
  is no universal parser.
- Estimate VRAM for weights, KV cache and context length before choosing a GPU. Pass
  model-specific vLLM flags (for example `--max-model-len`) as extra `serve.sh` arguments.
- Do not add `--trust-remote-code` unless you reviewed that model's code.
- Some NVIDIA sports multimodal (video/audio) models document their own serving wrapper.
  Use NVIDIA's published deployment for them, for example
  https://github.com/NVIDIA/sports-intelligence-playbooks/blob/4bcb551cca93b66b10c1dd14d14ad39056ffe33f/avlm/deployment/vLLM/README.md,
  then connect SportsClaw to the same OpenAI-compatible endpoint. Whether the model is good
  enough for your data is something you validate. It is not guaranteed.

## 2. Get approval before spending

GPU machines bill while they run. Get the user's explicit approval for the instance type and
the expected cost before you create or start anything. Never pick an instance type or host
for them; use placeholders until they decide.

## 3. Deploy with native tools

- **Brev:** create or choose the GPU machine in the Brev console or CLI
  (https://docs.nvidia.com/brev/). Then run `brev refresh`, copy `serve.sh` with
  `scp -F ~/.brev/ssh_config`, and start it over `ssh -F ~/.brev/ssh_config`. vLLM downloads
  the weights itself. Brev can also run NVIDIA NIM containers
  (https://docs.nvidia.com/brev/guides/inference-deployment/deploying-nims). An NGC key
  for pulling containers is different from an API inference key.
- **NVIDIA API (nim):** use a model id served at `https://integrate.api.nvidia.com/v1` and an
  `NVIDIA_API_KEY`.
- Keep keys out of command lines, shell history, files and chat. Read them with
  `read -rs NAME && export NAME`.

## 4. Verify the endpoint in order

Stop at the first failure and report it.

1. `GET /v1/models` with the bearer key. The served model id must be listed.
2. A bounded chat request: small `max_tokens` and a short timeout.
3. A tool call: one trivial function. Confirm the response has a structured `tool_calls`
   entry, not JSON in plain text. If not, fix the tool parser or chat template.
4. Run `./run.sh` (direct) or `./launch-openshell.sh` (OpenShell). It is one `--once` tick
   with no sports tools, memory or MCP, so it tests only the model route.

## 5. Privacy and network controls

- The default Brev path keeps vLLM on the GPU's loopback and reaches it through an SSH
  tunnel. Do not publish port 8000 or bind SSH forwards to all interfaces.
- Prompts sent to a hosted API leave your machine. Tell the user before using one.
- With OpenShell, the sandbox can only reach the endpoint named in the provider profile, and
  the base policy grants no other egress. A loopback tunnel on your laptop is not reachable
  from a sandbox. Use an authenticated HTTPS endpoint, or a host bridge you set up yourself.

## 6. Report the actual state

Say exactly which steps ran and what each one returned: the machine, the image tag or digest,
the served model id, `/models`, chat, the tool call, and the `--once` exit code. Say which
steps were skipped. Never claim a deployment, GPU, or tool-calling support you did not observe.
