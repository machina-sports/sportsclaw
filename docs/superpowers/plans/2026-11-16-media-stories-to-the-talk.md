# Media stories: from phase 1 to the talk (1 Dec)

**Spec:** `docs/superpowers/specs/2026-11-16-agent-run-media-stories-design.md`
**Engine plan (phase 1):** `docs/superpowers/plans/2026-11-16-media-stories-phase1-engine.md`

This is the schedule and scope plan, not a task-level plan. Each workstream below gets its own task-level plan (writing-plans) when it starts.

## What changed (16 Nov)

The deck now describes the finished system: SportsClaw runs every step (media jobs, line checks, speech, timeline, render), and the agent runs inside OpenShell with the GPU work in a media worker on the host. There is no "what ships next" slide. So the spec's fallback ("if the rehearsal is red, show today's pipeline and present this as next") is gone. Everything the deck says must run on stage on 1 Dec.

## Which slide depends on what

| Slide | Claim | Needs |
|---|---|---|
| 2 | SportsClaw found, followed, wrote, spoke, checked | Phase 1 engine + basketball-highlights skill; clip re-rendered on the new engine |
| 10 | SportsClaw runs the story; basketball is a skill skill | Phase 1 + skill |
| 11 | Agent in OpenShell sandbox; media jobs to a media worker on the host | Phase 2 (worker, provider profile, policy rule) |
| 12 | SportsClaw calls every step as a tool, runs in the sandbox | Phase 1 + phase 2 |
| 14 | Each step is a tool; nothing spoken or drawn unchecked | Phase 1 (preconditions) |

Cut line: if phase 2 slips, phase 1 + skill still makes slides 2, 10 and 14 true. Only slides 11 and 12 (the sandbox and worker) depend on phase 2. Their fallback is wording ("runs next to OpenShell"), not a different demo.

## Workstreams

### A. Engine phase 1 (SportsClaw 0.31.0), in progress

Tasks 1–4 done (types, rights switch, artifact store, bundles, local job runner). Tasks 5–10 remain: role proxy, clock map, event index, claim checks, timeline + plain renderer, tools behind `config.media`. Then a whole-branch review, PR, release (André runs `npm publish`).

Done when: the "How we will know it worked" tests in the spec pass without a GPU, and 0.31.0 is on npm.

### B. Basketball highlights skill (demo repo `machina-sports-intelligence`, plan: `docs/superpowers/plans/2026-11-16-basketball-highlights-skill.md`), starts once Task 10's tool shapes are fixed

The skill wraps scripts that already exist on demo main. No new vision code.

| Job kind | Wraps (demo main) | Produces |
|---|---|---|
| `read-clock` | `deploy/read_clock.py`, `clock_fit.py`, `index_game.py` | `clock-map`, `event-index` |
| `track-people` | `tracks_game.py` | `subject-tracks` |
| `identify-people` | `identity.py` | `subject-identity` |
| `follow-subject` | `follow.py` | `subject-tracks` (one subject) |
| `render-story` | `follow_story.py` (the cut) and `follow_reel.py` (drawing) | `video` |
| `check-lines` | the checks in `story.py` | checker verdicts |

Plus `SKILL.md` (the recipe in plain language) and `jobs.json`. The studio's `server.py` keeps the UI and calls SportsClaw instead of owning the pipeline. `studio_agent.mjs` is retired for story runs, so phase 0's "allow integrate.api.nvidia.com in studio_agent" is no longer needed. Nemotron is reached through SportsClaw's `brain` route.

Done when: on one GPU machine, "Curry threes" produces a story whose run manifest shows every step called by the agent, and the clip matches today's quality.

### C. Engine phase 2 (SportsClaw 0.32.0), starts after A merges

- The media worker: the same job runner behind a small HTTP API on the host. It enforces the same allowlist and the rights switch.
- An OpenShell provider profile and policy rule so the sandbox reaches `host.openshell.internal:<port>`, like `nim-local`.
- Speech: confirm whether hosted Magpie has an HTTP form endpoint. If not, add the gRPC wire format.
- The OpenShell image rebuilt with 0.32.0.

Done when: the B run works with the agent inside OpenShell and the sandbox never sees footage, only manifests.

### D. Talk readiness

- Re-render the slide 2 clip on the new engine and swap it into both decks (working deck: video; review copy: still).
- Docs: the QR points at sportsclaw.gg/opensource/deployment/openshell. The docs deploy is blocked on the Azure secret, so rotate it before the phase 2 docs ship.
- GPU: a Brev instance for prep and rehearsals. Show the cost before creating it and delete it after each session.

## Schedule (proposed)

| Date | Milestone |
|---|---|
| Tue 17 – Wed 18 Nov | A: Tasks 5–10, final review, PR |
| Thu 19 Nov | A: 0.31.0 released. B: skill plan written, job wrappers start |
| Fri 20 – Sat 21 Nov | B: skill runs on a GPU box end to end (unsandboxed). C: worker + policy start |
| Mon 23 Nov | C: 0.32.0 PR; Magpie wire format settled |
| **Tue 24 Nov** | **Rehearsal 1: full sandboxed run on the GPU box. Re-render slide 2. Gate for the cut line.** |
| Wed 25 – Fri 27 Nov | Fixes; Rehearsal 2 on 27 Nov; freeze (no engine changes after this) |
| Sat 28 – Mon 30 Nov | Travel; decks final; offline backup of the rendered clip on the laptop |
| Tue 1 Dec | Talk, 1:30 pm PT, booth #812 |

The gate on 24 Nov decides between: everything as written, or phase 1 + skill with slides 11 and 12 reworded. It no longer decides between the new system and today's pipeline.

## Risks

- **Time.** About 8 working days for two releases and a skill. Mitigation: B starts on Task 10's interfaces before A merges. C reuses A's runner, not a new one.
- **Agent reliability.** Nemotron must call 8–10 tools in order. Mitigation: the engine's preconditions refuse out-of-order steps. A turn limit of 16. Rehearse the exact prompt.
- **Latency.** The spec requires request-to-video within 20% of today's. Prep runs once per game, before the talk. On stage only the per-story steps run.
- **Magpie over gRPC** may add a day to C.
- **Footage** stays internal. The demo runs with the rights switch `off`, which records "off (operator)" in manifests. Clearance remains open.
