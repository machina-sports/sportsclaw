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
