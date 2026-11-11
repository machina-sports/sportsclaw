# Your Own Hosted Model

Run sportsclaw on a model you chose. It can run on your own Brev GPU with vLLM, or on the
hosted NVIDIA API. `sportsclaw quickstart` writes a small launch bundle into a new directory.
**It deploys nothing.** Generating the bundle makes no network calls, starts no processes, and
reads no saved config or keys. You do the deployment with Brev, vLLM and (optionally)
OpenShell's own tools.

```bash
# Any Hugging Face model id, served by vLLM on a Brev GPU you choose
sportsclaw quickstart --host brev --model <org/model> --tool-parser <parser> --out ./qs

# A model served by the NVIDIA API (https://integrate.api.nvidia.com/v1)
sportsclaw quickstart --host nim --model <served-model-id> --out ./qs
```

Accepting a model id does not mean the model is supported. The model must work with the runtime,
have a chat template, support tool calling (with the matching vLLM `--tool-call-parser`), and fit
in VRAM. The bundle's `skills/hosted-models/SKILL.md` covers these checks. The smoke job also
sends that guide to the model.

## What the bundle contains

| File | Purpose |
| --- | --- |
| `README.md` | Steps for this exact host and mode, with links to the official docs |
| `serve.sh` | Brev only. Wraps one `docker run vllm/vllm-openai`. Needs `VLLM_IMAGE` (a tag you reviewed) and `VLLM_API_KEY`. Extra arguments go to vLLM unchanged |
| `run.sh` | One `sportsclaw operate --job quickstart --once` tick. HOME is the bundle and the environment is scrubbed. It uses only `VLLM_API_KEY` (brev) or `NVIDIA_API_KEY` (nim) |
| `.sportsclaw/operator/quickstart.json` | Operator job: no sports skills, MCP or memory. The persona tells the model not to invent sports data |
| `skills/hosted-models/SKILL.md` | The portable deployment guide |

## Brev flow

1. Get approval for the cost. Then create or choose a GPU machine yourself in the
   [Brev](https://docs.nvidia.com/brev/concepts/launchables) console or CLI.
2. Run `brev refresh`. Then `scp -F ~/.brev/ssh_config ./serve.sh <brev-machine>:serve.sh`.
3. `ssh -F ~/.brev/ssh_config <brev-machine>`. Export `VLLM_IMAGE` and `VLLM_API_KEY`, then run
   `./serve.sh`. vLLM downloads the weights. Port 8000 is published on the GPU's loopback only.
4. Tunnel: `ssh -F ~/.brev/ssh_config -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8000:127.0.0.1:8000 <brev-machine>`.
5. Check `/v1/models`, then a bounded chat request, then a tool call. Then run `./run.sh`.

Some NVIDIA sports multimodal models document their own serving wrapper. Deploy them as
[NVIDIA's playbook](https://github.com/NVIDIA/sports-intelligence-playbooks/blob/4bcb551cca93b66b10c1dd14d14ad39056ffe33f/avlm/deployment/vLLM/README.md)
describes, then point sportsclaw at the same OpenAI-compatible endpoint.

## Pointing a model role at either kind of endpoint

An operator job can give each model role (`eyes`, `brain`, `hands`, `writer`) its own endpoint under
`inference.roles`. Switching a role between a model you run and a hosted service is an edit to that
one block.

```json
{
  "inference": {
    "roles": {
      "eyes":  { "route": "nim", "model": "basketball", "baseUrl": "http://127.0.0.1:8000/v1" },
      "brain": { "route": "api", "model": "<served-model-id>",
                 "baseUrl": "https://integrate.api.nvidia.com/v1", "credentialEnv": "NVIDIA_API_KEY" }
    }
  }
}
```

| Route | For | Key |
| --- | --- | --- |
| `nim` | A model server you run yourself (vLLM, a NIM container), usually on loopback | None |
| `api` | A hosted OpenAI-compatible service | Read at call time from the environment variable named by `credentialEnv` |
| `openshell` | A model reached from inside an OpenShell sandbox | Injected by the sandbox's provider profile |

`credentialEnv` is the variable's name, never the key. An `api` route requires HTTPS unless the
endpoint is on loopback, fails before any request when the variable is unset, and never falls back
to another key. A `nim` or `api` route can also carry `requestBody`: extra request fields for
server options a model needs, such as vLLM's `top_k` or `chat_template_kwargs`.

## Optional: OpenShell

Add `--openshell --image <oci-ref>` (and, for brev, an `--endpoint` the sandbox can reach) to also
generate these files:

- `provider.yaml`: binds the credential to exactly the chosen host, port and path.
- `policy.yaml`: grants no base network egress.
- `launch-openshell.sh`: imports the profile, creates the provider from your shell's credential
  with `--from-existing`, and runs one `--once` sandbox named `sportsclaw-quickstart`.

The script checks for a stable OpenShell `>=0.1.5 <0.2` (only 0.1.5 is tested). The launcher stops at the first OpenShell
command that fails. It does not issue delete or restart commands. Live gateway name-collision behavior
has not been verified for this quickstart. A sandbox cannot reach the SSH tunnel on your machine's
loopback. Use an authenticated HTTPS endpoint, or `http://host.openshell.internal:<port>` only if
you arranged that routing yourself. See [NVIDIA OpenShell](../deployment/openshell).
