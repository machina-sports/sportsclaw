# CLI Reference

Every `sportsclaw` command, grouped by what you'll reach for most.

## Everyday

| Command | What it does |
| --- | --- |
| `sportsclaw "<question>"` | Ask a one-shot question and print a sourced answer |
| `sportsclaw chat` | Start an interactive conversation |
| `sportsclaw config` | Configure your provider, model, and integrations |
| `sportsclaw setup` | Conversational, AI-guided setup |
| `sportsclaw doctor` | Diagnose your install (incl. Machina status) and tell you what to fix |
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
| `sportsclaw machina connect [project]` | Connect a Machina premium pod (mints a durable key via machina-cli) |
| `sportsclaw mcp add <url> [--name <n>] [--token <t>]` | Connect an MCP server (also `--description`, `--timeout <ms>`) |
| `sportsclaw mcp list` | List connected MCP servers |
| `sportsclaw mcp remove <name>` | Disconnect an MCP server |
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
| `--temperature <n>` | Pin sampling temperature (0–2) on every model call of a query |
| `--seed <n>` | Pin the sampling seed (integer) where the provider supports one |
| `--help`, `-h` | Show help |

## Reproducible runs

`--temperature` and `--seed` are applied to every model call in a query: skill routing, the main loop, validation/correction passes, and subagents. Without them, nothing is sent and provider defaults apply.

With `--json`, a `manifest` line is emitted before the `result` (and before an `error`):

```json
{"type":"manifest","manifest_version":1,"config_sha256":"…","config":{"sportsclaw_version":"0.29.4","sports_skills_version":"0.33.0","provider":"openai","model":"gpt-4o-mini","sampling":{"temperature":0,"seed":7},"max_output_tokens":16384,"max_turns":25,"thinking_budget":8192,"caller_system_prompt_sha256":null,"replay_mode":"off"},"run":{"served_model_id":"…","main_system_prompt_sha256":"…","offered_tools":["…"],"tool_surface_sha256":"…","provider_warnings":[],"parallel_agents":false}}
```

- `config` holds what is fixed before the run. `config_sha256` hashes exactly this block, so equal hashes mean comparable configurations.
- `run` holds what was observed. The main system prompt carries per-query context and the date, so its hash is reported but kept out of `config_sha256`. `run` is `null` if the query ended before the main loop.
- The manifest contains hashes and names only, never prompt text or credentials.
- Providers may ignore a pin, and `provider_warnings` records it when they do. Anthropic has no seed, and it ignores temperature while extended thinking is on; set the thinking budget to 0 for pinned Claude runs.
- `replay_mode` reflects `SPORTS_SKILLS_REPLAY` (see sports-skills record/replay).
