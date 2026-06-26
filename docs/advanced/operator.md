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
the *next* tick reads that session's verdict and injects it as a directive — e.g. *"the durable
loop flagged the previous broadcast for review: &lt;reason&gt;; correct course."* The loop persists
and resumes on its own, so a verdict is never lost.

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
