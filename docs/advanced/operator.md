# Operator Mode

Operator mode runs sportsclaw as an autonomous, time-driven agent: it wakes on a schedule,
reasons about what's happening in live sports, and publishes output on its own — no user turn
required. It's the foundation for things like an always-on broadcast or studio agent.

::: warning Advanced & evolving
Operator mode is the most advanced surface in sportsclaw and is still evolving. Most projects
should start with on-demand queries and bots.
:::

## Running a job

Operator behavior is defined as a **job**. List what's configured, then run one:

```bash
sportsclaw operate --list              # show configured jobs
sportsclaw operate --job <jobId>       # run a job continuously
sportsclaw operate --job <jobId> --once    # run a single tick
sportsclaw operate --job <jobId> --dry-run # plan a tick without publishing
```

To run a job supervised in the background:

```bash
sportsclaw start operator <jobId>
```

It then appears in `sportsclaw status` alongside your bots.

## How it differs from chat

There's no person asking — a schedule fires "ticks." On each tick the agent reviews live state,
decides whether there's anything worth saying (it can choose to stay silent), and publishes to
the destination its job defines. It keeps a running memory between ticks so it doesn't repeat
itself.

## Operator-sync: durable-loop verification

The operator has its own broadcast-safety gate, but that gate is the same process making the
decision. **Operator-sync** adds a *second, independent* check: each time a tick **publishes**,
the decision is routed to the durable **Machina harness loop**, which verifies it with its own
generator/evaluator (the loop's `loop-evaluate`, a separate model + "assume broken" posture).

Because the operator tick is synchronous but the loop is asynchronous and durable, the check is
**start-now / read-next-tick**: the tick that publishes *starts* a loop verification session, and
the *next* tick reads that session's result and injects the reviewer's **actual assessment** as a
directive — e.g. *"[loop-review] an independent reviewer assessed the previous broadcast: the
broadcast claims a fixture not present in the data."* (When the loop's own review is itself
unreliable it injects a "double-check" caution instead of trusting it.) The loop persists and
resumes on its own, so a verdict is never lost.

Enable it per job (`~/.sportsclaw/operator/<jobId>.json`):

```json
{
  "jobId": "studio",
  "intervalMs": 90000,
  "operatorSync": { "enabled": true, "persona": "loop-reasoning" }
}
```

Requirements: a connected Machina pod running the `loop-runner` agent (the same one that backs the
`machina_loop` tool — `sportsclaw mcp add <pod>/mcp/sse --token <key>`). When no loop pod is
connected, operator-sync is inert and the tick proceeds normally. The verdict directive appears on
the tick *after* a publish, so it needs at least two ticks to close the loop.

### Testing it

Operator-sync needs ≥2 ticks (start-now / read-next-tick) and its cross-tick state is in-memory,
so use the **foreground** runner — not `--once`, which is one tick per process:

```bash
# 1) connect the loop pod and enable operatorSync in the job config (above)
sportsclaw mcp add https://<org>-<project>.org.machina.gg/mcp/sse --name machina --token <token>

# 2) run the job in the foreground and watch ≥2 ticks
sportsclaw operate --job <jobId>
#   tick 1 → tick_published …            (operator-sync starts a loop verification session)
#   tick 2 → the composed context now carries the loop's assessment:
#            [loop-review] An independent reviewer assessed the previous broadcast: …
```

Look for a `[loop-review]` line (or a `[loop-verification] … double-check` caution when the loop's
own review was unreliable) entering the **next** tick after a publish. To exercise the wiring
without a pod: `npm run test:operator-sync`.

::: warning Dispatch needs the MCP redeploy
operator-sync starts the loop via MCP `execute_agent` **by name** (`loop-runner`) — the same path
as `machina_loop`. The deployed pod MCP must support agent-by-name
([machina-client-api#287](https://github.com/machina-sports/machina-client-api/issues/287)); on a
stale MCP the dispatch returns `status:error` and operator-sync stays inert (it never silently
passes). The read path (`search_documents`) is unaffected.
:::
