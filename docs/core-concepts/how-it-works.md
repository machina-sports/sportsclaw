# How It Works

You ask a question in plain language. sportsclaw turns that into the right data lookups, runs
them against live sources, and writes an answer grounded in what it found.

## The loop, in plain terms

1. **You ask.** "Who's leading the Premier League, and what are the title odds?"
2. **The agent picks tools.** It decides it needs current standings and prediction-market
   prices, and calls the right data skills for each.
3. **Data is fetched live.** Those skills pull real results from sources like ESPN and
   Polymarket — no made-up numbers.
4. **You get one answer.** The agent synthesizes everything into a single, sourced response.

Because the data comes from real lookups rather than the model's memory, answers stay current
and don't drift into hallucination. If the agent needs a specific team or player and only has a
name, it looks up the ID first instead of guessing.

## Grounded, not guessed

This is the core idea: an LLM on its own will happily invent a score. sportsclaw doesn't let it
answer from memory for anything it can look up. Live scores, standings, schedules, player
stats, odds, and news all come from real data skills the agent is required to call.

Those skills are provided by **[sports-skills](https://sports-skills.sh)** — the open Python
data layer that the installer provisions automatically. It's the source of every sport and
market sportsclaw can reach; see the full catalog at [sports-skills.sh](https://sports-skills.sh).

## Asking about a sport for the first time

sportsclaw ships knowing how to reach 14 sports, but it only installs the ones you use. The
first time you ask about, say, cricket, it installs that skill in a couple of seconds and then
answers. To load everything at once:

```bash
sportsclaw init --all
```

You can manage installed sports directly with `sportsclaw add <sport>`,
`sportsclaw remove <sport>`, and `sportsclaw list`.

## Where it runs

The same engine powers every surface:

- **CLI** — `sportsclaw "…"` for one-shot answers, `sportsclaw chat` for a conversation.
- **Bots** — long-running Discord and Telegram listeners.
- **Embedded** — import the engine into your own TypeScript app.
- **Docker** — package the whole thing (engine + data layer) into one image.

## Bring your own model

sportsclaw is model-agnostic. Point it at Anthropic, OpenAI, Google, or Azure Foundry and the loop works the
same way — see **[Configuration](../getting-started/configuration)**.
