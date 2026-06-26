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

sportsclaw works with three providers — bring a key from whichever you prefer:

| Provider | Models | API key |
| --- | --- | --- |
| **Anthropic** | Claude (Opus, Sonnet) | `ANTHROPIC_API_KEY` |
| **OpenAI** | GPT | `OPENAI_API_KEY` |
| **Google** | Gemini | `GEMINI_API_KEY` |

Set the key in your environment, or let `sportsclaw config` store it for you:

```bash
export ANTHROPIC_API_KEY=sk-...
```

::: tip Image generation
Generating images (matchday graphics, etc.) requires **OpenAI or Google** — Anthropic models
can't produce images. Reading images you send the bot works on any vision-capable model.
:::

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
