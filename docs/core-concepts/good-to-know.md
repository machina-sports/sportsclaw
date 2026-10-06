---
title: Good to know
description: The defaults, limits and trade-offs behind sportsclaw — what it will and won't do, and where each rule is enforced.
---

# Good to know

<p class="sc-lead-doc">
sportsclaw makes a few deliberate trade-offs. Most of them exist so an answer about a live game can be
trusted. This page collects them in one place, with links to the details.
</p>

## Data

### Grounded, not guessed

The model decides *what* to look up; the numbers come from deterministic Python in
[sports-skills](https://sports-skills.sh), not from the model's training data. If the agent only has a
team or player name, it looks up the ID before it fetches stats.

### Keyless isn't licensed

The built-in skills read public APIs (ESPN, Kalshi, Polymarket and others) with no keys. Those sources
are meant for **personal, non-commercial** use and can rate-limit. Commercial and production workloads
need licensed data — that's the [Machina](/machina/) layer.

### The upgrade hint never nags

When a public source runs out, the data layer may attach an `upgrade` hint. The agent mentions the
licensed path at most once per conversation, never in automated alerts or broadcasts, and never
instead of an answer. The data layer decides when to send it, not the agent.

### Sports install on first use

sportsclaw knows how to reach 14 sports but installs each one the first time you ask about it.
`sportsclaw init --all` installs everything up front.

### Big results are queried, not cut

A tool result over the size cap is kept whole for the turn, and the model gets an overview plus a
`query_tool_result` tool to filter, sort and aggregate the rows. Identical successful calls within a
turn come from a cache instead of hitting the source again.

## Answers

### The fact-check flags, it doesn't rewrite

After drafting, a fact-check compares the answer with the raw tool output. On our own benchmark
(Sports Agent Bench), automatically correcting flagged drafts broke more correct answers than it fixed.
So the default checker now **keeps the draft and records the flagged claims** in the run trace
(`verification.outcome: "flagged"`).

The [opt-in Jev verifier](/guide/jev-evidence-verifier) keeps a correct-and-recheck flow and needs
explicit cloud consent.

### Failed tools aren't evidence

If a tool fails during a turn, its data is absent. The answer is held to what actually came back, and a
claim that only the failed tool could have supported doesn't pass as fact.

### A route isn't a result

The router picks which skills a question needs — two at most by default
(`SPORTSCLAW_ROUTING_MAX_SKILLS`). A routing decision says nothing about whether the selected tools
succeeded; only the tool results do.

## Safety

### Track, not trade

Placing or cancelling orders, buying or selling, and touching wallets or balances are blocked twice:
when tools are offered to the model and again before any tool runs. Every bot and server deployment is
hard read-only. Only the local owner, in their own terminal, can opt into trading tools — and only when
a skill actually exposes them. See [Read-Only by Default](/core-concepts/safety-and-trading).

### Side effects need a yes

Writing files, running shell commands and starting or continuing a durable session wait for explicit
approval. You can approve an action once or for the session.

### MCP means every tool

A connected MCP server exposes **all** of its tools to the agent, writes included — there is no
read/write classification. Pin a `tools` allowlist on the server entry to register only the tools you
name. See [Connecting MCP Servers](/advanced/mcp#restricting-a-server-to-specific-tools).

### Loop replies are untrusted

A reply from the durable loop is written by the pod's own model, so sportsclaw treats it as external
data, never as instructions.

## Opt-in means opt-in

These are off until you turn them on, and the defaults don't change when they ship:

| Feature | Turn it on with | Notes |
| --- | --- | --- |
| [Jev capability routing](/guide/capability-routing) | `SPORTSCLAW_ROUTING_PROVIDER=jev` | also needs `SPORTSCLAW_ROUTING_DATA_POLICY=cloud_allowed` |
| [Jev evidence verification](/guide/jev-evidence-verifier) | `SPORTSCLAW_EVIDENCE_VERIFIER=jev` | also needs `SPORTSCLAW_EVIDENCE_DATA_POLICY=cloud_allowed` |
| [Decision relay](/guide/decision-relay) | `SPORTSCLAW_DECISION_DATA_POLICY=cloud_allowed` on the relay | answers `503` until enabled |
| [NVIDIA OpenShell](/deployment/openshell) | the job config | direct model calls stay the default |
| [Hindsight memory](/hindsight-memory) | `SPORTSCLAW_MEMORY_PROVIDER=hindsight` | file memory is the default |

Any feature that sends data to a third-party cloud asks for explicit consent through a data-policy
setting; nothing is sent by default.

## Running a relay

### Limits are per relay

Prompts are capped at 20,000 characters, query timeouts at 300 seconds (180 by default), and each
relay runs at most 4 queries at once — the rest get an immediate `429`. Responses are bounded to
32 MiB. These limits are per relay instance, not distributed quotas. See the
[relay contract](/advanced/relay-contract).

### Relays follow releases

Relay images are built from this repository on `relay-v*` tags, and a deployed relay keeps the image it
was given until it's upgraded. `GET /api/capabilities` reports the protocol version, engine version,
build revision, skills, MCP allowlists and limits a relay actually runs. It requires the relay token,
and it arrived in `relay-v0.29.6`.

### Who owns the transcript

By default the engine keeps the conversation thread. A caller that manages its own history sends
`history_mode: "caller"`: the engine then starts fresh each run, while durable memory — profile,
reflections, strategy — stays scoped to the `user_id`.

## Maturity

### Operator mode is evolving

Operator mode — scheduled, autonomous publishing — is the most advanced surface and still changes.
Start with on-demand queries and bots.

### Momentum isn't live-certified yet

The momentum pipeline (market price swings turned into cards) has passed its offline and synthetic tests, but no sport
is live-certified yet. See [Momentum Certification](/sports-data/momentum-certification) for the
evidence behind each row.

### Built and rolling out

The [durable loop](/advanced/durable-loop) and [highlight jobs](/machina/highlights) are built and
tested, and are rolling out on Machina projects. Their pages say what is needed to use them today.
