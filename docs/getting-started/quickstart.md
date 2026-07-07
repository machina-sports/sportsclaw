# Quickstart

From nothing to your first answer in about a minute.

## 1. Install

```bash
curl -fsSL https://sportsclaw.gg/install.sh | bash
```

This installs the `sportsclaw` command, the sports data layer, and a process manager for
running bots in the background. You'll need **Node.js 18+** and **Python 3.9+** already on your
machine — the installer checks for both and tells you how to get them if they're missing.

::: details Prefer to install manually?
```bash
npm install -g sportsclaw-engine-core pm2
python3 -m pip install --upgrade sports-skills
```
:::

## 2. Connect a model

sportsclaw uses your AI model to do the reasoning — the sports data itself is free and needs
no key. Pick one:

```bash
# Use an API key from Anthropic, OpenAI, Google, or Azure Foundry:
export ANTHROPIC_API_KEY=sk-...

# …or, if you already use Claude Code, reuse that session:
sportsclaw login claude
```

Prefer a guided setup? Run `sportsclaw config` and it'll walk you through choosing a provider
and model. See **[Configuration](./configuration)** for all the options.

## 3. Ask

```bash
sportsclaw "What are today's NFL scores?"
```

That's it. The agent figures out which data it needs, fetches it live, and answers:

```ansi
❯ sportsclaw "What are today's NFL scores?"

  ◒  Thinking…
  ✓  fetched NFL scores

  Here are today's NFL results:
  • Chiefs 27, Raiders 20 (Final)
  • Eagles 31, Cowboys 17 (Final)
  • Lions at Packers — 8:20pm ET
```

The first time you ask about a sport, sportsclaw installs it on the spot (a couple of
seconds). To pre-install everything up front, run `sportsclaw init --all`.

## Keep going

```bash
sportsclaw chat
```

`chat` opens an interactive session — ask follow-ups, dig into odds, compare teams.

## What's next

- **[Configuration](./configuration)** — choose your model, manage providers, set up bots
- **[How It Works](../core-concepts/how-it-works)** — what the engine is doing under the hood
- **[Building a Discord bot](../building-bots/discord)** — put it in front of your community
