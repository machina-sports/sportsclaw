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

## Benchmark runs (`sportsclaw bench`)

Run a JSONL dataset headlessly. Each case is one line and one run, and the output is one JSON line per case. The runner produces evidence only; scoring belongs to the evaluator (e.g. Arena).

```bash
sportsclaw bench cases.jsonl --out results.jsonl --temperature 0 --seed 7
```

Dataset lines: `{"id": "nba-001", "prompt": "…", "system_prompt": "optional", "skills": ["nba"], "metadata": {…}}`. Blank lines are ignored. `skills` is the tool scope for the `raw-tools` arm.

| Option | Effect |
| --- | --- |
| `--out <file>` | Write results to a file (default: stdout) |
| `--limit <n>` | Run the first *n* valid cases; the rest are counted `not_run` |
| `--arm routed\|raw-tools\|direct\|routed-oracle` | Harness per case (default `routed`, see below) |
| `--case-timeout <s>` | Abort a case after *s* seconds and record it as `timeout` (default 300) |
| `--tools <a,b>` | Routed arm only: offer exactly these tools. Unknown names abort before any case runs |
| `--all-tools` | Routed arm only: no allowlist, so built-in tools (files, commands, installs) are offered too |
| `--system-prompt <text>` | Caller prompt for cases without their own `system_prompt` |
| `--temperature`, `--seed` | Sampling pins, as in a normal query |

**Arms.** Compare the same model with and without the harness:
- `routed`: the full sportsclaw engine (routing, verification, evidence gate).
- `raw-tools`: a minimal tool loop with a neutral prompt that offers only the data tools of the case's `skills`. It has no routing, memory or verification. A case without `skills` is recorded `invalid`.
- `direct`: the same minimal loop with no tools.
- `routed-oracle` (diagnostic): the full engine, offered only the case's `skills` tools. Comparing it with `routed` isolates routing loss; comparing it with `raw-tools` isolates the rest of the pipeline. The allowlist is set per case, so `bench_start` shows none and each case's `config_sha256` covers it.

Every arm uses the same sampling pins, turn and token budgets, case timeout, and 30,000-character tool-output cap, and each has its own `config_sha256`.

**Tool surface.** By default the routed arm offers only data tools (installed sport schemas and MCP tools), never the built-in side-effecting tools. Account and order tools (`polymarket-trading`) are always excluded. Without installed sports this falls back to the generic `sports_query` tool, and the runner warns. Run `sportsclaw init --all` first, or pin the surface with `--tools`. Bench runs never enable trading or `--yolo`.

**Isolation.** Each case starts from an empty conversation, with no user id and therefore no memory.

**Output lines.**
- `bench_start`: dataset path, SHA-256, line counts, and the run configuration with its `config_sha256` (see the manifest above).
- `case`: `status` is `ok`, `halted` (the model asked the user a question), `error`, `timeout`, `invalid` or `duplicate`. Each line also carries the `arm`, answer, error, `latency_ms`, `cold` (true for the first executed case), `timing` (`total_ms`, `tool_ms_sum`, `phases`), token `usage`, `tool_calls` (name, success, duration), `config_sha256`, the observed `run` trace, and passthrough `metadata`. Dataset problems are emitted first and carry their `line` number.
- `bench_summary`: counts that add up to the number of dataset lines, wall time, and token totals.

The exit code is 0 when the runner finishes, whatever the per-case outcomes are. It is 1 for setup failures: unreadable dataset, bad options, missing credentials, or unknown tools.
