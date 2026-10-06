---
title: sportsclaw in Machina
description: How the open-source sportsclaw engine runs inside every Machina project as the sportsclaw relay, who calls it, and what is live versus rolling out.
---

# sportsclaw in Machina

<p class="sc-lead-doc">
sportsclaw is the open-source side of <a href="https://machina.gg">Machina</a>. Machina Sports builds and
maintains it, and the platform runs the same engine inside every project as the <strong>sportsclaw
relay</strong>. This page covers how the two fit together: what runs where, who calls what, and what is
live versus still rolling out.
</p>

<MachinaArchitecture />

## Two ways in

### Inside a project: the relay

When a project is created on Machina, the platform provisions it in an isolated tenant: an API,
background workers, an MCP server, Redis and a vault — and a **sportsclaw relay**. The relay is this
repository's engine running in relay mode (`docker/relay`), and it comes with:

- the **sports-skills** data layer, with 17 default skills covering sports, prediction markets, betting
  math, news and team metadata;
- a **persistent memory volume**;
- the project's **MCP server**, connected over SSE and authenticated with the project's own token;
- an **HTTP API** for Machina products and for your own services.

There is nothing to install or configure. The relay ships with the project.

### From anywhere: `sportsclaw machina connect`

Any sportsclaw install — your laptop, a Discord bot, a container — can join a Machina project as a
client:

```bash
pip install machina-cli && machina login
sportsclaw machina connect <project>
```

`machina-cli` resolves the project's MCP endpoint and mints a durable service key for sportsclaw
(`--org` picks the organization, `--probe` tests the endpoint first). The key is stored in `~/.sportsclaw/.env`, never in the config file. From then on your agent reads the
project's tools next to the keyless skills. Details and manual setup:
[Licensed data & machina-cli](/sports-data/machina).

<div class="sc-doc-grid">
  <a class="sc-doc-card" href="/getting-started/quickstart"><strong>Standalone first?</strong><span>Install sportsclaw and run your first grounded query in about a minute.</span></a>
  <a class="sc-doc-card is-machina" href="https://machina.gg"><strong>Need a project?</strong><span>Licensed data, SLAs and the platform around the relay live at machina.gg.</span></a>
</div>

## What the relay serves

The relay is a small HTTP service in front of the engine. Each request runs the engine in an isolated
child process with bounded time, output and concurrency.

| Endpoint | What it does | Access |
| --- | --- | --- |
| `GET /health` | Liveness | public |
| `GET /api/skills` | Installed skill catalog | public |
| `POST /api/query` · `POST /api/query/sync` | Run a question through the engine — streaming or blocking | `X-Auth-Token` |
| `GET /api/capabilities` | Protocol and engine version, build, skills, MCP allowlists, limits | `X-Auth-Token` |
| `/api/agents` | Create, list, update and delegate to native agents | `X-Auth-Token` |
| `POST /api/decide` | Typed Jev decisions, [disabled by default](/guide/decision-relay) | `X-Auth-Token` |
| `/api/highlights/jobs` | Highlight clipping jobs — [preview](/machina/highlights) | separate token |

Authenticated routes fail closed: no token configured on the relay means `503`, a missing or wrong
token means `401`. Prompt size, timeouts and concurrency are bounded per relay — see the
[relay contract](/advanced/relay-contract).

::: tip Relays follow releases
A project's relay runs the image it was provisioned with, and relay features ship with `relay-v*`
releases. Ask `GET /api/capabilities` for the engine version, skills and limits a relay actually runs
before you depend on a newer endpoint.
:::

## Who calls it

- **Factory** — Machina's app builder gives its coding agent a `sportsclaw_query` tool, so it can pull
  live sports data through the relay while it writes your app.
- **Broadcast and studio desks** — desk copilots send questions to the relay and read
  `/api/capabilities` to show what it can do.
- **Project connectors and workflows** — a template connector can call the relay over HTTP like any
  other service, which is how project workflows reach it.
- **Your own services** — anything that can send an authenticated HTTP request.

The relay is a service you call. Being in the same project does not, by itself, give every platform
agent sportsclaw's tools — callers opt in by calling the API.

## Memory on the platform

sportsclaw keeps durable memory per user — SOUL, fan profile, context, reflections, strategy and
conversation logs. With a Machina server connected, the default (`auto`) stores it as **project
documents** through the pod driver, isolated per user and, when native agents are selected, per agent.
Without one it falls back to local files; [Hindsight](/hindsight-memory) is an explicit opt-in.

Callers that keep their own transcript can send `history_mode: "caller"`. The relay then neither
restores nor appends its own thread for that run, while durable memory stays scoped to the `user_id`.

## Licensed data and the upgrade signal

The keyless skills read public APIs and are meant for personal, non-commercial use. Inside a project,
licensed real-time feeds arrive as the project's own MCP tools, through connectors installed from
Machina templates — the agent reads both side by side.

When a public source rate-limits or lacks a feed, the data layer attaches an `upgrade` hint. The agent
mentions the licensed path at most once per conversation, never inside automated alerts or broadcasts,
and never instead of an answer.

## Durable work: the loop-runner

Some work outlives a single exchange. When a project has the durable loop installed — the
`loop-runner` agent, provisioned with machina-cli — sportsclaw exposes a `machina_loop` tool with three
actions: `start`, `continue` and `read`.

- Every session is a document on the project, resumed by a beat, so it survives restarts and async
  waits.
- A turn only closes as idle after a code check and an independent evaluator; otherwise it is marked
  for review.
- Starting or continuing a session asks for approval in sportsclaw, and replies come back as untrusted
  data.

See [Durable Task Delegation](/advanced/durable-loop).

## Status at a glance

| Capability | Status | Notes |
| --- | --- | --- |
| Relay provisioned with every project | Live | automatic, no setup |
| Keyless sports and market skills | Live | 17 by default |
| Project MCP tools inside the agent | Live | over SSE, with the project token |
| Pod memory | Live | default when a Machina server is connected |
| Authenticated query API and `/api/capabilities` | Live | from `relay-v0.29.6` |
| Durable loop delegation | Rolling out | needs `loop-runner` on the project |
| Typed decisions (`/api/decide`) | Opt-in | disabled by default |
| Highlight jobs | Preview | rights-gated, not generally available |

## Is sportsclaw the Machina platform?

No. sportsclaw is the open-source agent engine. Machina is the platform around it: isolated tenants,
licensed data, templates, workflows, Studio, Factory, deploys and SLAs. sportsclaw runs perfectly well
without Machina, and Machina runs much more than sportsclaw. They share a team, a data layer
([sports-skills](https://sports-skills.sh)) and the engine you can read on GitHub.
