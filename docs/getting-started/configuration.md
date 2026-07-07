# Configuration

sportsclaw needs one thing to run: a connection to an AI model. The sports data is free and
keyless — only the reasoning model requires credentials.

## Guided setup

The easiest way to configure everything is the interactive wizard:

```bash
sportsclaw config
```

It walks you through choosing a provider, picking a model, and (optionally) setting up Discord
and Telegram bots. Your settings are saved to `~/.sportsclaw/`. Run it again any time to change
things.

Want a conversational setup that also validates your bot tokens as you go? Try
`sportsclaw setup`.

## Choosing a model

sportsclaw works with four providers — bring a key from whichever you prefer:

| Provider | Models | API key |
| --- | --- | --- |
| **Anthropic** | Claude (Opus, Sonnet) | `ANTHROPIC_API_KEY` |
| **OpenAI** | GPT | `OPENAI_API_KEY` |
| **Google** | Gemini | `GEMINI_API_KEY` |
| **Azure Foundry** | Azure OpenAI (`gpt-5*`, `gpt-4o`, …) + Azure Anthropic (`claude-*`) | `AZURE_FOUNDRY_API_KEY` |

Set the key in your environment, or let `sportsclaw config` store it for you:

```bash
export ANTHROPIC_API_KEY=sk-...
```

::: tip Image generation
Generating images (matchday graphics, etc.) requires **OpenAI, Google, or Azure Foundry** —
Anthropic models can't produce images. Reading images you send the bot works on any
vision-capable model.
:::

The setup wizard ships with a curated list of common current models for each provider and always
includes **Custom model / deployment name**. Use the custom option for newly deployed Foundry
models or provider releases before the curated list catches up.

### Reasoning models & custom endpoints

Point sportsclaw at any OpenAI-compatible endpoint with `OPENAI_BASE_URL`, and it selects the
API path based on the model name:

- **Reasoning models** (`gpt-5*`, `o1*`, `o3*`) go over the **Responses API** — what hosted
  gateways like **Azure AI Foundry** (`…/openai/v1`) require for function tools + reasoning effort.
- **Self-hosted chat models** (NVIDIA NIM, vLLM) go over `/chat/completions`.
- With no `OPENAI_BASE_URL`, real OpenAI keeps its defaults.

```bash
# Azure AI Foundry — a gpt-5.5 reasoning deployment
export OPENAI_BASE_URL=https://<resource>.openai.azure.com/openai/v1
export OPENAI_API_KEY=<key>
# then pick the OpenAI provider + your model id in `sportsclaw config`

# Self-hosted (NIM / vLLM)
export OPENAI_BASE_URL=https://inference.local/v1
```

For sandboxed, policy-routed inference, see [NVIDIA OpenShell](../deployment/openshell).

### Azure Foundry (first-class provider)

The `OPENAI_BASE_URL` trick above works, but the dedicated **`azure-foundry`** provider is the
first-class way to target Microsoft Foundry / Azure OpenAI — it handles both the OpenAI-style
and Anthropic-style Foundry endpoints, picks Chat Completions vs the Responses API for you, and
supports Entra ID auth. Pick it in `sportsclaw config`, or set the environment directly:

```bash
export sportsclaw_PROVIDER=azure-foundry

# OpenAI-style deployment (gpt-5*, gpt-4o, …)
export AZURE_FOUNDRY_BASE_URL=https://<resource>.openai.azure.com/openai/v1
export AZURE_FOUNDRY_API_KEY=<key>
export sportsclaw_MODEL=gpt-5.2          # your deployment name

# Anthropic-style deployment (claude-sonnet-4-6, …)
export AZURE_FOUNDRY_BASE_URL=https://<resource>.services.ai.azure.com/anthropic
export AZURE_FOUNDRY_API_KEY=<key>
export sportsclaw_MODEL=claude-sonnet-4-6
```

**Environment variables**

| Variable | Purpose |
| --- | --- |
| `AZURE_FOUNDRY_BASE_URL` | Foundry endpoint. `…/openai/v1` → OpenAI-style; `…/anthropic` → Anthropic-style. |
| `AZURE_FOUNDRY_API_KEY` | API key (auth mode `api_key`). Sent as a bearer token. |
| `AZURE_FOUNDRY_API_MODE` | `auto` (default), `chat_completions`, `responses`, `codex_responses`, or `anthropic_messages`. |
| `AZURE_FOUNDRY_AUTH_MODE` | `api_key` (default) or `entra_id`. |
| `AZURE_FOUNDRY_SCOPE` | Entra ID token scope (default `https://ai.azure.com/.default`). |
| `AZURE_FOUNDRY_API_VERSION` | Optional `api-version` query appended to every call. |
| `AZURE_FOUNDRY_IMAGE_BASE_URL` | Optional OpenAI-style `/openai/v1` endpoint used only for image generation. Use when your text model uses an Anthropic-style endpoint. |
| `AZURE_FOUNDRY_IMAGE_MODEL` | Optional image model override. Defaults to `gpt-image-2`. |
| `AZURE_FOUNDRY_IMAGE_QUALITY` | Optional image quality. Defaults to `medium`. |

In `auto` mode the wire protocol is inferred from the base URL (`/anthropic` → Anthropic-style),
and OpenAI-style deployments route reasoning families (`gpt-5*`, `o1*`, `o3*`, `o4*`, `codex*`)
over the Responses API while other models use Chat Completions.

**Entra ID (optional).** Set `AZURE_FOUNDRY_AUTH_MODE=entra_id` to authenticate with
`DefaultAzureCredential` instead of an API key — no `AZURE_FOUNDRY_API_KEY` needed. This requires
the optional `@azure/identity` package (`npm install @azure/identity`) and an environment that
`DefaultAzureCredential` can resolve (`az login`, a managed identity, or service-principal env
vars). API-key users never need `@azure/identity`.

**Image generation.** When `sportsclaw_PROVIDER=azure-foundry`, the `generate_image` tool can use
Foundry's OpenAI-compatible Images API with `gpt-image-2`. Point `AZURE_FOUNDRY_BASE_URL` (or the
image-specific `AZURE_FOUNDRY_IMAGE_BASE_URL`) at an OpenAI-style `/openai/v1` endpoint. If your
chat model uses an Anthropic-style `/anthropic` endpoint, keep that as `AZURE_FOUNDRY_BASE_URL` and
set `AZURE_FOUNDRY_IMAGE_BASE_URL` separately.

## Reuse your Claude Code session

If you already use Claude Code, you can skip the API key entirely and reuse that login:

```bash
sportsclaw login claude
```

sportsclaw will use your existing Claude session for reasoning. To stop, run
`sportsclaw logout claude` — it won't affect Claude Code itself. An `ANTHROPIC_API_KEY` in your
environment always takes priority over this.

## Connecting chat platforms

To run a Discord or Telegram bot, add your bot tokens:

```bash
sportsclaw channels
```

Then start a bot with `sportsclaw listen discord` or `sportsclaw listen telegram`. See
**[Building Bots](../building-bots/discord)** for the full walkthrough.

## Checking your setup

```bash
sportsclaw doctor
```

`doctor` verifies your Node and Python versions, the sports data layer, your model
credentials, your installed sports, and any connected Machina premium pods — and tells you
exactly what to fix if something's off.

To connect premium data feeds, see [Machina — the premium layer](../sports-data/machina) and
[Connecting MCP Servers](../advanced/mcp).
