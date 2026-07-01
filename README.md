<p align="center">
  <img src="assets/logo.jpg" alt="sportsclaw" width="500">
</p>

# sportsclaw

A CLI and bot scaffold that connects any LLM to live sports data via [sports-skills](https://sports-skills.sh).

**[sportsclaw.gg](https://sportsclaw.gg/)** — Official site & docs.

---

### What is sportsclaw?

sportsclaw is a TypeScript CLI and bot scaffold that connects any LLM to deterministic Python sports data — scores, odds, standings, play-by-play, player stats — through the [`sports-skills`](https://sports-skills.sh) package. It works with Anthropic, Google (Gemini), and OpenAI models via the [Vercel AI SDK](https://sdk.vercel.ai). ~5,200 lines of TypeScript total, with the core agent loop at ~80 lines.

### What can you build with it?

sportsclaw gives you a working sports AI agent in minutes. Here's what people build:

- **Discord/Telegram bots** — Deploy a sports bot to your server that answers questions like "What are today's NBA scores?" or "Show me the Premier League table" with real data, not hallucinated guesses. Built-in listeners for both platforms.
- **Fantasy football assistants** — Build a personal agent that pulls player stats, injury reports, matchup data, and news across NFL, NBA, MLB, NHL, and more to help you make lineup decisions.
- **Real-time F1 alerts** — Use the `fastf1` skill to pull qualifying results, lap times, and race data. Pipe it into Telegram or Discord for your group chat.
- **Sports betting dashboards** — Combine live odds from `kalshi` and `polymarket` with real game data from `nfl-data` or `football-data` to spot value. The agent pulls both sides — actual stats and market prices — in one query.
- **Multi-sport news digests** — The `sports-news` skill aggregates headlines across leagues. Build a morning briefing bot that summarizes what happened overnight across the sports you care about.
- **Custom CLI tools** — Run one-shot queries from your terminal: `sportsclaw "Who leads the Premier League in goals?"` and get a sourced answer in seconds.

### Why sportsclaw?

**Readable codebase.** ~5,200 lines of TypeScript built on the Vercel AI SDK. The core agent loop is ~220 lines. Easy to fork, extend, or learn from.

**Data comes from Python, not the LLM.** sportsclaw calls deterministic Python functions ([`sports-skills`](https://sports-skills.sh)) to fetch scores, standings, and stats. The LLM decides *what* to look up, but the data itself comes from ESPN, FastF1, Kalshi, and other real sources — not from the model's training data. This eliminates hallucinated scores and stats.

**Failure-aware tool loop.** If the same tool call (same tool + same args) fails in a turn, sportsclaw skips repeated retries for that exact call and moves on to other data paths.

**Zero API keys for the data layer.** You need an `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY` / `GEMINI_API_KEY`) for the reasoning model, but every sports data skill works completely out of the box with zero API keys required for the data layer — no ESPN API key, no paid data subscriptions, no OAuth setup. Install `sports-skills` via pip and you're done.

**Working agent in 5 minutes.** Install, set one env var, run a query:

```bash
curl -fsSL https://sportsclaw.gg/install.sh | bash
export ANTHROPIC_API_KEY=sk-...   # or OPENAI_API_KEY / GEMINI_API_KEY

sportsclaw "What are today's NFL scores?"
```

**Already use Claude Code?** If you have a Claude Code Max / Pro subscription, you can skip the Anthropic API key and reuse that session:

```bash
sportsclaw login claude   # picks up the session your `claude` CLI is already signed into
sportsclaw "What are today's NFL scores?"
```

This reads tokens from your existing Claude Code install (macOS Keychain or `~/.claude/.credentials.json`) and refreshes them as needed — your `claude` CLI keeps working. Revert any time with `sportsclaw logout claude`. `ANTHROPIC_API_KEY` (if set in the environment) always wins over the OAuth session.

For an interactive conversation, start chat mode:

```bash
sportsclaw chat
```

If something isn't working, run the built-in diagnostic:

```bash
sportsclaw doctor
```

Optional routing controls (defaults shown):

```bash
export SPORTSCLAW_ROUTER_STRATEGY=provider_fast
export SPORTSCLAW_ROUTER_MODEL=<provider-fast-model-id>   # optional override
export SPORTSCLAW_ROUTING_MAX_SKILLS=2
export SPORTSCLAW_ROUTING_ALLOW_SPILLOVER=1
```

Or use it as a library:

```typescript
import { sportsclawEngine } from "sportsclaw-engine-core";

const engine = new sportsclawEngine();
const answer = await engine.run("Who leads the Premier League?");
```

**Docker in one command.** Ship the whole thing — Node.js engine + Python data layer — as a single container:

```bash
docker build -t sportsclaw .
docker run --rm -e ANTHROPIC_API_KEY=sk-... sportsclaw "Who won the Super Bowl?"  # or pass OPENAI_API_KEY / GEMINI_API_KEY
```

### Models & endpoints

sportsclaw works with **Anthropic**, **OpenAI**, and **Google** out of the box. Set `OPENAI_BASE_URL` to point at any OpenAI-compatible endpoint and it routes correctly: reasoning models (`gpt-5*` / `o1*` / `o3*`) use the **Responses API** — required by hosted gateways like **Azure AI Foundry** — while self-hosted chat models (**NVIDIA NIM**, **vLLM**) use `/chat/completions`. For sandboxed, policy-routed inference, run inside [NVIDIA OpenShell](openshell/README.md).

### Connect a Machina pod (licensed data & durable loops)

A connected [Machina](https://machina.gg) pod adds licensed, real-time feeds and production SLAs alongside the built-in keyless data. Connect one in a command:

```bash
sportsclaw machina connect             # mints a durable key via machina-cli and wires the pod
# or bring your own MCP URL:
sportsclaw mcp add <url> --name machina --token <key>
```

A connected pod can also run a **durable agentic loop** — sportsclaw delegates long, multi-step, resumable tasks to it (they survive interruptions, async waits, and restarts) and reads the result back. See [Durable Task Delegation](https://sportsclaw.gg/advanced/durable-loop) for details.

### When should you use it?

sportsclaw is built for:

- **Personal hacking** — You want a sports agent that actually works, not a research project. Get answers from real data in your terminal or a script.
- **Discord and Telegram communities** — Deploy a bot that your group can ask sports questions. Built-in listeners handle the wiring; you just add your bot token.
- **Prototyping sports AI products** — Test whether an AI sports feature is viable before building infrastructure. sportsclaw gives you the agent loop and data access so you can focus on the product idea.
- **Learning how agents work** — The core loop is ~220 lines on the Vercel AI SDK. Read it, modify it, extend it.

### Optional: Pluggable memory backends

By default, memory is stored in local files (`~/.sportsclaw/memory/`) — zero setup. For multi-tenant relay deployments you can switch to Machina pod documents, and for semantic, long-horizon memory that learns over time you can route memory through a [Vectorize Hindsight](https://github.com/vectorize-io/hindsight) server:

```bash
export SPORTSCLAW_MEMORY_PROVIDER=hindsight   # file (default) | pod | hindsight
```

Hindsight works against OpenAI/Anthropic/Gemini or a fully local Ollama/LM Studio backend, and can run as an offline sidecar inside an OpenShell sandbox. See [`docs/hindsight-memory.md`](docs/hindsight-memory.md) for setup and configuration.

### Optional: Run inside NVIDIA OpenShell

For deployments that want sandboxed execution and policy-enforced LLM routing, SportsClaw operator daemons can run inside an [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) sandbox with calls routed through the Privacy Router. **This is opt-in via the job config** — direct LLM calls remain the default for everyone else. See [`openshell/README.md`](openshell/README.md) for the runbook and [`docs/openshell-integration-plan.md`](docs/openshell-integration-plan.md) for the integration design.

### Built-in Sports Data Skills

sportsclaw ships with **20 skills** out of the box, powered by [`sports-skills`](https://sports-skills.sh):

- **Sports data** — `football` `nfl` `nba` `nhl` `mlb` `wnba` `tennis` `cfb` `cbb` `golf` `f1` `cricket` `volleyball` `xctf`
- **Prediction markets & analysis** — `kalshi` `polymarket` `markets` (unified ESPN ↔ Kalshi ↔ Polymarket) `betting` (de-vig, edge, Kelly, arbitrage)
- **Utility** — `news` `metadata` (team/player logos & badges)

Skills are auto-discovered from the installed `sports-skills` package, so the set stays in sync as it grows. When a free public API rate-limits a request, results carry an `upgrade` signal and sportsclaw surfaces the licensed / real-time option via [`sports-skills premium`](https://docs.machina.gg/).

> **[sports-skills.sh](https://sports-skills.sh)** — Full documentation for all built-in skills.

### Inspiration & Acknowledgements

sportsclaw's execution engine draws direct inspiration from [NanoClaw](https://github.com/qwibitai/nanoclaw/), [pi.dev](https://pi.dev), [OpenClaw](https://github.com/anthropics/openclaw), and [NemoClaw](https://github.com/NVIDIA/NemoClaw). Built on the [Vercel AI SDK](https://sdk.vercel.ai) for multi-provider LLM support. The interactive CLI setup and reasoning spinner are powered by [@clack/prompts](https://github.com/natemoo-re/clack).

### Questions?

Join the community on Discord to discuss sportsclaw, sports-skills, and building AI agents for sports: [Join the Machina Sports Discord](https://discord.gg/CU5KmQWHD9)

---
*Built by the [Machina Sports](https://machina.gg) team.*
