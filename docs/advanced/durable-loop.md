# Durable Task Delegation

A normal tool call is one-shot: sportsclaw asks, the tool answers, the turn ends. Some work is
bigger than that — research that spans many steps, jobs that wait on async data or human input,
tasks that should survive a restart. For those, sportsclaw can hand the work to the **Machina
durable loop** running on a connected pod, and stay responsive while the loop grinds on.

## How it works

When you connect a Machina pod that runs the durable loop (the `loop-runner` agent — see
[Machina](../sports-data/machina)), sportsclaw automatically exposes a `machina_loop` tool. The
loop lives on the pod, not in sportsclaw: every turn is persisted as a document and resumed by
the pod's beat, so it survives interruptions, async tools, and waiting on input. sportsclaw's own
loop stays fast and ephemeral — it delegates the long-running work, then reads the result back.

The agent drives three actions:

| Action | What it does |
| --- | --- |
| `start` | Begin a new durable session for a task. Returns a `session_id`. |
| `continue` | Add a follow-up message to an existing session. |
| `read` | Fetch the current state — latest reply, status, turn count. |

You don't call these yourself — the agent does, when it decides a task is better run durably. You
just ask:

```bash
sportsclaw "Delegate a durable task: track the next match and give me the pre-game analysis"
```

Starting or continuing a durable session is gated by the same approval prompt as other
side-effecting actions, so you stay in control of what gets delegated. The pod's reply is treated
as untrusted external data on the way back in.

## Requirements

- A connected Machina pod that runs the durable loop — wire one up with
  [`sportsclaw machina connect`](../sports-data/machina#connecting-machina-to-sportsclaw) (or
  `sportsclaw mcp add`). The `machina_loop` tool only appears when such a pod is connected.
- The pod must expose the loop's `execute_agent` and `search_documents` tools over MCP.

Check what's connected with `sportsclaw doctor` (it lists Machina pods) and `sportsclaw mcp list`.

::: tip Ephemeral vs durable
Use direct tools for a quick, in-the-moment answer. Reach for the durable loop when the work is
long, multi-step, or needs to outlive a single exchange.
:::
