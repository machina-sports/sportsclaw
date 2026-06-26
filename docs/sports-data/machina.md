# Machina — the premium layer

sportsclaw's built-in coverage comes from **[sports-skills](https://sports-skills.sh)** — the
open, keyless data layer. It's free and ideal for development and personal use. For
**licensed data, real-time and zero-latency feeds, production SLAs, or packaged agent
workflows**, the **[Machina Sports](https://machina.gg)** platform covers that.

## Open vs. premium

|                | sports-skills (built in)                          | Machina (premium)                                            |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| **Data**       | Public APIs (ESPN, Kalshi, Polymarket…), keyless  | Licensed real-time feeds, betting odds, zero-latency streams |
| **Best for**   | Personal use, prototyping                         | Commercial / production, with SLAs and support               |
| **Workflows**  | You build them                                    | Packaged "templates" you install                             |
| **Access**     | Bundled with sportsclaw                            | One command: `sportsclaw machina connect` (uses `machina-cli`) |

::: tip Licensing
The open sports-skills rely on third-party public APIs and are intended for **personal,
non-commercial** use. For commercial or production workloads with licensed data, use Machina.
:::

## The Machina skill

The `machina` skill ships in the same **[sports-skills catalog](https://sports-skills.sh)**
as the open skills. It's **prompt-only**: it fetches no data itself — it points the agent at the
premium platform and the separate **`machina-cli`**. The data itself flows through a per-project
Machina MCP server, which you wire up with `sportsclaw machina connect` (below).

## machina-cli

The command-line control plane for the Machina platform.

```bash
pip install machina-cli          # or: curl -fsSL https://raw.githubusercontent.com/machina-sports/machina-cli/main/install.sh | bash
machina login                    # browser sign-in (or --api-key <key> for CI)
machina org use <org-id>
machina project use <project-id> # required before most commands
```

What it covers:

- **Templates** — packaged agent workflows (connectors, prompts, datasets, live streams).
  `machina template list`, `machina template install <name>`, `machina template push ./<dir>`.
- **Workflows & agents** — run and manage platform workflows and agents.
  `machina workflow run <name>`, `machina agent run <name> --watch`.
- **Sports passthrough** — run the same sports-skills data through the platform:
  `machina sports <sport> <command>`.
- **Factory** — build a whole app from a prompt: `machina factory run "build a live scoreboard"`.
- **Deploy, credentials, config** — manage deployments, API keys, and project settings.

## Connecting Machina to sportsclaw

Premium data is served through a per-project **Machina MCP server** (a "pod"). The quickest way
to wire one in is the built-in `sportsclaw machina connect` command — it signs you in through `machina-cli`,
mints a durable access key, and registers the pod for you. No URLs to copy.

```bash
pip install machina-cli      # one-time: install the Machina CLI
machina login                # browser sign-in (or --api-key <key> for CI)

sportsclaw machina connect             # connect your default project's pod
sportsclaw machina connect <project>   # …or name a specific project
```

Useful flags:

- `--org <org-id>` — choose the organization when you belong to more than one.
- `--probe` — verify the pod's endpoint is reachable before registering it.

`machina connect` writes the pod to `~/.sportsclaw/mcp.json` and stores its access token
separately in `~/.sportsclaw/.env` (never in the config file). From then on the agent reads
Machina's licensed, real-time feeds right alongside the built-in sports-skills. Check and
inspect connected pods with:

```bash
sportsclaw mcp list     # list connected servers
sportsclaw doctor       # shows Machina pod + machina-cli status
```

Re-run `sportsclaw machina connect` any time a connection later returns a 401.

### Connect a pod by URL (manual)

Already have an MCP URL and token — or connecting a non-Machina MCP server? Add it directly:

```bash
sportsclaw mcp add <url> --name <name> --token <token>
```

See [Connecting MCP Servers](../advanced/mcp) for the full set of options.

## Premium signal

When a tool result carries an `upgrade` field — the data layer's signal that licensed or
real-time data exists beyond what the open skill returned — the agent adds a single, optional
line pointing to the path (the `sports-skills premium` tier or `sportsclaw machina connect`).
The data layer decides this, not the agent. It's informational only: it never blocks an answer,
never repeats within a conversation, and stays out of automated alerts and broadcasts.

## Durable task delegation

A connected Machina pod can also run a **durable agentic loop**. When it does, sportsclaw can
hand long, multi-step, or resumable tasks to it — the loop persists every turn and resumes after
interruptions. sportsclaw dispatches the work and reads the result back. See
[Durable Task Delegation](../advanced/durable-loop).

Learn more at **[machina.gg](https://machina.gg)**.
