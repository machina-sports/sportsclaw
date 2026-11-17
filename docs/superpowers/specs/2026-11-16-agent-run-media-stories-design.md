# SportsClaw runs the story: media jobs, clock maps, timelines and checks

Status: approved by André on 16 Nov 2026. Lines marked **(my call)** are choices Claude made that André has not confirmed.

## Why

In the basketball demo, SportsClaw makes one decision per story (what to search for, whether to follow a player). Everything after that is a fixed pipeline in the demo's `server.py`: facts, writing, checking, voice, following, rendering. The deck and the talk say the agent does the work. Today it decides what to make and the studio makes it.

André wants SportsClaw itself to run a story from request to finished video, built from parts any sport or customer can reuse. The basketball demo should become one use of those parts, not a pipeline hard-coded beside the engine.

## Goals

1. The agent runs every step of a media story as tool calls: find, ground, follow, write, check, speak, render.
2. The engine parts are generic: no sport, model or look is named in engine code.
3. A sport-specific skill (a portable skill) supplies the models, the vision questions, the checks and the look.
4. The order and the checks are enforced by the engine, not by the prompt. A story cannot be rendered from unchecked lines.
5. It works inside OpenShell: the agent is sandboxed, GPU work runs on the host behind a named door.
6. Proven on a second sport before it is called generic.

## Non-goals

- Live or real-time streams. Sources are finished files.
- Cloud or URL sources. Local files only, as the highlights core is today.
- A general workflow language (YAML pipelines, DAG editors).
- Scheduling across several GPUs or machines.
- Training or fine-tuning.
- A new UI. The demo studio stays the UI.

## Anti-goals (it has failed if)

- Engine code contains "basketball", "NBA", "jersey" or a model name.
- The model ever receives footage bytes or file contents it did not need, or writes files itself.
- Ordering or checking depends on the prompt being obeyed.
- A script that the operator did not approve runs.
- The model or a skill skill can switch the rights check off. Only the operator can.
- The demo gets slower or flakier on stage than it is today.

## What exists today (verified on SportsClaw main, 0.30.1)

- **Tools:** Sports Skills data tools, `hostTools` (functions the embedding app supplies), MCP, and portable skills: `skill_read_reference` and `skill_run_script`. Scripts are approved by sha256 in `SPORTSCLAW_SKILL_SCRIPT_ALLOWLIST` and killed after 30 seconds.
- **Model roles:** `eyes`, `brain`, `writer`, `hands`, routed to `openshell`, `nim`, `api` or `mock`. Runs accept video, audio and image attachments.
- **Speech:** `inference.speech`, text to WAV, routes `nim`, `api`, `mock`; wire formats `riva` (HTTP form) and `openai`.
- **Checks:** `groundingCheck` (`off`/`flag`/`withhold`): numbers in an answer must appear in this run's evidence. An optional evidence verifier.
- **Highlights core** (`src/highlights/`): validate → probe → plan → extract → verify → manifest, no model calls. Requires a `RightsAuthorization` with `clearedForClipping: true`. Maps game clock to video with one fixed `SyncAnchor` and supports only `elapsed-ascending` clocks. Exposed as `sportsclaw clip`, `sportsclaw highlights run` and the relay's `/api/highlights/jobs` (queued/running/succeeded/failed/canceled). It is not a tool the agent can call.
- **Also:** receipts per model call, a run manifest, subagents, a task bus, artifact output (HTML).

## Approaches considered

**A. More host tools in the demo.** Keep the pipeline in `server.py` and expose each step as a `hostTool`. Fast, and the agent would call every step. But nothing becomes reusable: the next sport copies `server.py`. Rejected: it does not meet goal 2.

**B. Generic engine primitives plus a skill skill (chosen, my call).** Add four small engine parts (media jobs, clock map, story timeline, claim checks). Sport-specific work lives in a portable skill whose scripts run as jobs. The agent composes them. This is the smallest design in which the second sport is a new skill, not new engine code.

**C. A workflow engine inside SportsClaw.** Declare the story as a pipeline the engine executes step by step. Reliable, but the agent decides nothing again, and it is a large new subsystem. Rejected: it rebuilds what `server.py` does today inside the engine, and breaks goal 1.

## Design

### 1. Media jobs

A job is long-running work on media that returns files. It generalizes the highlights job.

- **Agent tools:** `media_job_start`, `media_job_status`, `media_job_result`, `media_job_cancel`.
- **A job kind** is declared by a skill: a name, a JSON Schema for its input, the entry script, a time limit and an output budget in bytes.
- **Approval is per bundle, not per file (my call).** Today's `skill_run_script` hashes one file and runs it with `python -I` and a stripped environment. The skill's scripts import each other and need torch, OpenCV and model weights, so that cannot run them. A job kind is approved as a bundle: one sha256 over a sorted list of every file in the skill's `scripts/` folder and its dependency lockfile. The operator's allowlist holds `{skill, kind, bundleSha256}`. The interpreter or environment for a kind is named in operator config, never by the skill. Model weights and per-game data files are inputs, recorded by path and sha256 in the manifest, not part of the bundle. An unapproved or changed bundle does not exist for the agent.
- **No keys reach a job (my call).** A job gets no credentials. When a script needs a model (reading the scoreboard, reading a jersey), it calls a role proxy: a loopback URL and a one-time token the runner hands it. The engine makes the model call through its role router, so receipts are kept and model names stay in config, not in the skill. A media worker runs the same proxy with its own operator config.
- **States:** `queued`, `running`, `succeeded`, `failed`, `canceled` (the existing `HighlightsJobState`).
- **Result:** a manifest listing typed artifacts: `{id, kind, path, sha256, sizeBytes}` plus small JSON facts the agent may read (counts, coverage). The model sees the manifest, never file bytes.
- **Runners** sit behind one interface:
  - `local`: a subprocess on the same machine (phase 1).
  - `worker`: HTTP to a media worker on another host, for GPU work when the agent is in a sandbox (phase 2).
- **Rights check, an operator switch (André's decision):** the operator must be able to run this on any video. One setting, `media.rightsCheck`, with `require` or `off`, set in operator config or by `SPORTSCLAW_MEDIA_RIGHTS_CHECK`. It is never a tool input and never set by a skill, so the model cannot change it.
  - `require` (the default **(my call)**, and what the highlights core does today): a job that reads source media needs a `RightsAuthorization` with `clearedForClipping: true`, and fails closed without one.
  - `off`: no authorization is needed. Every manifest from that run records `rightsCheck: "off (operator)"`, so the output shows it was made without one.
  - The same switch applies to `sportsclaw clip`, `sportsclaw highlights run` and the relay job API, so there is one rule, not two.
- **Budgets:** per-job time and bytes; per-run job count. Finite defaults, as the highlights core has.

### 2. Typed artifacts and enforced order

Every job output and every check produces an artifact with an id. Tools take artifact ids as inputs and the engine validates them: the artifact exists, is of the required kind, was produced in this run or is registered for this source (matched by the source's sha256), and its file still has the recorded sha256.

This is how order is enforced. Rendering needs a timeline; a timeline needs checked lines; checked lines need a check receipt. No prompt is involved.

Artifact kinds in v1 **(my call)**: `source`, `clock-map`, `event-index`, `subject-tracks`, `subject-identity`, `facts`, `lines-checked`, `voice`, `timeline`, `video`.

### 3. Clock map

Replaces the single `SyncAnchor` with a map from video time to game time.

- **Shape:** an ordered list of stretches `{videoStartSec, videoEndSec, period, clockStartSec, clockEndSec, running}`, plus `semantics`: `elapsed-ascending` or `countdown-per-period`.
- **Sources:** supplied by the caller, or built by a job (the skill's script asks the `eyes` role to read the scoreboard at a fixed step and fits running and stopped stretches).
- **Highlights core:** `planCandidateWindows` accepts a clock map or a sync anchor. A sync anchor is the one-stretch case, so existing requests keep working.
- **Event index:** aligning a clock map with play-by-play actions gives an `event-index` artifact: each action with its video window. `media_find_events` searches it (by text, people, period, type) and returns short rows the model can read.

### 4. Story timeline and rendering

- **Timeline:** a typed document: an ordered list of segments. A segment is a clip window on a source, with optional subject track, caption, voice artifact, and a data overlay (score before and after, clock). Cards (title, outro) are segments without a source.
- **Tool:** `story_timeline_build` validates a timeline and stores it as an artifact. It refuses captions that are not in a `lines-checked` artifact from this run.
- **Rendering is a job.** The engine ships one plain renderer (cut, caption, voice, using the existing FFmpeg wrapper). A skill can supply another renderer kind that reads the same timeline (the demo's follow-and-crop look).

### 4a. Prepared once, used per story (my call)

Reading the clock, indexing, tracking everyone and identifying them take minutes to an hour per game. They run once per game, as jobs the agent can start ("prepare this game"), and their artifacts are registered against the source's sha256 by the runner when the job succeeds. A story run finds them in that registry and does not repeat them. Per story the agent runs: find, facts, follow the subject on the chosen plays, write, check, speak, timeline, render. "The agent runs every step" means both: it starts the prep, and it runs the story.

### 5. Claim checks

Extends `groundingCheck` from "numbers in the answer" to "lines against evidence", with the checker supplied by the skill.

- **Writing (my call):** `story_draft_lines` makes one `writer`-role call with the evidence for this run and returns draft lines. The agent chooses the plays, the angle and when to redraft; the writer role does the wording. This keeps today's quality (a dedicated writing call with a full facts prompt) and keeps the turn count low.
- **Evidence:** every line cites what backs it: event ids from the event index, or fact ids. A `facts` artifact holds the data-tool results of this run (standings, season stats, next game), so a hook or outro that cites no play is still checkable.
- **Tool:** `story_check_lines` takes draft lines with their citations and returns per-line verdicts and a `lines-checked` artifact holding only the lines that passed.
- **Whole-script checks** (enough plays, flow, the hook names someone who is in the story) belong to the skill's checker, alongside its per-line checks.
- **Checkers:** the engine's number check always runs. A skill may add a deterministic checker script (approved like any script) for claims such as tie or lead, made or missed, and names.
- **Failure:** a refused line comes back with the reason, so the agent can rewrite it. A limit on rewrite rounds **(my call: 2)**, then the line is dropped or replaced by a line built from the facts.

### 6. Speech as a tool

`speech_synthesize` exposes `inference.speech` to the agent: lines in, `voice` artifacts out. It only accepts lines from a `lines-checked` artifact. Add a wire format for hosted Riva over gRPC if the hosted Magpie service has no HTTP form endpoint; the builder confirms which.

### 7. The agent loop

- The story agent's model must be a reliable tool caller. For the demo this is the hosted Nemotron NIM as `brain`, not the basketball model.
- The skill's `SKILL.md` gives the recipe in plain language. The engine's preconditions make the recipe safe to get wrong.
- Raise the turn limit for story runs **(my call: 16)** and give job tools a wait option so a status check does not cost a turn per second.
- Every step lands in the run manifest: tool, inputs, artifact ids, receipts for each model call.

### 8. OpenShell

- The agent and Sports Skills run in the sandbox, as today.
- GPU work runs in a media worker on the host. The sandbox reaches it at `host.openshell.internal:<port>` through a provider profile and a policy rule, like `nim-local`.
- The worker enforces the same allowlist and rights checks. The sandbox never sees footage; it sees manifests.

### 9. The basketball-highlights skill

A portable skill (first home: the demo repo; **my call**), built from the demo's existing scripts:

| Job kind | From | Produces |
|---|---|---|
| read clock | `deploy/read_clock.py`, `clock_fit.py`, `index_game.py` | `clock-map`, `event-index` |
| track people | `tracks_game.py` | `subject-tracks` |
| identify people | `identity.py` | `subject-identity` |
| follow subject | `follow.py` | `subject-tracks` (one subject) |
| render follow story | `follow_story.py` (the cut), `follow_reel.py` (drawing) | `video` |
| check lines | `story.py` checks | checker script |

The demo's `server.py` keeps the studio UI and stops owning the pipeline.

## Phases and releases

**Phase 0, now, no engine change.** Reword the deck to match what runs. Move the studio agent to Nemotron: `studio_agent.mjs` refuses any model endpoint that is not loopback, on purpose. Allow exactly one more, `https://integrate.api.nvidia.com`, with the key read from a named environment variable, as `brain.py` already does for the story writer **(my call)**. In the sandbox this becomes the `nvidia-native` provider, so the agent never holds the key.

**Phase 1, SportsClaw 0.31.0.** Media jobs with the local runner, typed artifacts and preconditions, clock map with countdown clocks, event index and `media_find_events`, `story_check_lines`, `speech_synthesize`, `story_timeline_build`, the plain renderer. The basketball-highlights skill. The studio's agent runs all steps on one machine.

**Phase 2, 0.32.0.** The media worker and its runner, the OpenShell provider profile and policy rule, the gRPC speech format if needed. The demo runs with the agent sandboxed.

**Phase 3, 0.33.0.** A second sport (soccer, from `machina-avlm-soccer`; **my call**) built as a skill with no engine change. Fold the relay's `/api/highlights/jobs` into media jobs. Docs.

**The talk (1 Dec) (decided by André, 16 Nov).** The deck describes the finished system, so phases 1 and 2 and the basketball-highlights skill ship before the talk. There is no fallback to today's pipeline. A full sandboxed rehearsal on 24 Nov is the gate: if phase 2 is not ready, the demo runs phase 1 + skill unsandboxed and slides 11–12 are reworded. Schedule: `docs/superpowers/plans/2026-11-16-media-stories-to-the-talk.md`. Phase 0's studio_agent change is dropped, because SportsClaw replaces the studio agent for story runs.

**Each release:** npm publish (André), GitHub release, the OpenShell image rebuilt, docs. The docs site deploy is blocked on the Azure secret; fix that first or the docs do not ship.

## Constraints

- Node engine, Python scripts, as today. No new runtime.
- Existing highlights requests, `sportsclaw clip` and the relay API keep working through phase 2.
- No footage, stills or keys in the repo, in receipts or in manifests sent to a model.
- Tests for every engine part run without a GPU, using the `mock` route and fixture artifacts.

## How we will know it worked

- One story run's manifest shows the agent called every step, with artifact ids chaining find → follow → draft → check → voice → timeline → render.
- Rendering with an unchecked caption fails in a test, whatever the prompt says.
- The soccer skill ships without a diff in `src/` beyond bug fixes.
- The demo's time from request to video is within 20% of today's.

## Decided by André

- **Rights check is an operator switch** (16 Nov): it can be turned off so any video can be used. The demo runs with it `off`. Whether a given video may be shown or published stays the operator's responsibility; the switch does not clear footage.
- **Clearance comes from the operator side, never the model** (16 Nov): `media_source_open` takes no `rights` input. Under `require`, a source needs a clearance whose `sourceSha256` matches its bytes, from operator config (`media.clearances`) or from the app that starts the run. The model cannot clear a video.
- **Prep jobs outlive the run** (16 Nov): reading the clock and tracking take 60–90 minutes, longer than a run can wait. A job kind declared `"prep": true` keeps running after the run that started it, on a runner the engine owns; when it finishes, its outputs are registered for that source and the next story run finds them. A long-lived host calls `engine.closeMedia()` on shutdown.

## Left to the builder

- Exact tool input schemas and artifact file layout.
- Where job state lives (the durable store the task bus uses is the obvious candidate).
- How a skill declares job kinds (a `jobs.json` beside `SKILL.md` is the obvious candidate).
- Worker protocol details.
- Whether hosted Magpie needs gRPC.
