# CLI Reference

Every `sportsclaw` command, grouped by what you'll reach for most.

## Everyday

| Command | What it does |
| --- | --- |
| `sportsclaw "<question>"` | Ask a one-shot question and print a sourced answer |
| `sportsclaw chat` | Start an interactive conversation |
| `sportsclaw config` | Configure your provider, model, and integrations |
| `sportsclaw setup` | Conversational, AI-guided setup |
| `sportsclaw doctor` | Diagnose your install and tell you what to fix |
| `sportsclaw health` | Report overall system status |
| `sportsclaw login claude` | Reuse your existing Claude Code session |
| `sportsclaw logout claude` | Stop using the Claude Code session |

## Sports

| Command | What it does |
| --- | --- |
| `sportsclaw init` | Choose and install sports interactively |
| `sportsclaw init --all` | Pre-install all sports at once |
| `sportsclaw add <sport>` | Install one sport (e.g. `nfl`, `nba`) |
| `sportsclaw remove <sport>` | Remove a sport |
| `sportsclaw list` | List installed sports |

## Bots & daemons

| Command | What it does |
| --- | --- |
| `sportsclaw channels` | Set up Discord & Telegram bot tokens |
| `sportsclaw listen <platform>` | Run a bot in the foreground (`discord` / `telegram`) |
| `sportsclaw start <platform>` | Run a bot in the background |
| `sportsclaw stop <platform>` | Stop a background bot |
| `sportsclaw restart <platform>` | Restart a background bot |
| `sportsclaw status` | Show what's running |
| `sportsclaw logs <platform> [--lines N]` | Tail a bot's logs |

## Advanced

| Command | What it does |
| --- | --- |
| `sportsclaw mcp add <url>` | Connect an MCP server |
| `sportsclaw mcp list` / `remove <name>` | List / disconnect MCP servers |
| `sportsclaw watch <sport> <command>` | Watch a data endpoint for changes |
| `sportsclaw operate --list` | List configured operator jobs |
| `sportsclaw operate --job <id>` | Run an operator job |
| `sportsclaw start operator <id>` | Run an operator job in the background |

## Global options

| Flag | Effect |
| --- | --- |
| `--verbose`, `-v` | Show detailed logs |
| `--json` | Emit structured NDJSON (for scripting) |
| `--yolo` | Skip approval prompts |
| `--help`, `-h` | Show help |
