# Machina — the premium layer

sportsclaw's built-in coverage comes from **[sports-skills](https://sports-skills.sh)** — the
open, keyless data layer. It's free and ideal for development and personal use. When you need
**licensed data, real-time and zero-latency feeds, production SLAs, or packaged agent
workflows**, you step up to the **[Machina Sports](https://machina.gg)** platform.

## Open vs. premium

|                | sports-skills (built in)                          | Machina (premium)                                            |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| **Data**       | Public APIs (ESPN, Kalshi, Polymarket…), keyless  | Licensed real-time feeds, betting odds, zero-latency streams |
| **Best for**   | Personal use, prototyping                         | Commercial / production, with SLAs and support               |
| **Workflows**  | You build them                                    | Packaged "templates" you install                             |
| **Access**     | Bundled with sportsclaw                            | `machina-cli` + a per-project Machina MCP server             |

::: tip Licensing
The open sports-skills rely on third-party public APIs and are intended for **personal,
non-commercial** use. For commercial or production workloads with licensed data, use Machina.
:::

## The Machina skill

The `machina` skill is published in the same **[sports-skills catalog](https://sports-skills.sh)**
as the open skills — it's the gateway to the premium platform. It's **prompt-only**: it fetches
no data itself. Instead it tells the agent how to use the separate **`machina-cli`** and how to
connect to a per-project Machina MCP server.

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

Premium live data is served through a per-project **Machina MCP server** that runs on Machina
infrastructure (not by `machina-cli`). Because sportsclaw is an
[MCP client](../advanced/mcp), you connect it directly:

1. **Install a template** — `machina template install <name>` provisions the workflow
   server-side and returns the MCP URL (and any required headers) in its JSON output.
2. **Add it to sportsclaw** — `sportsclaw mcp add <url>` (see
   [Connecting MCP Servers](../advanced/mcp)).
3. **Ask as usual** — the agent now reads Machina's licensed, real-time feeds through that MCP
   server, right alongside the built-in sports-skills.

Learn more at **[machina.gg](https://machina.gg)**.
