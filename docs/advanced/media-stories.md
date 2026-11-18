# Media Stories

sportsclaw can make a short video story from a game video: find the plays, write lines,
check them, speak them, cut and render. The agent runs every step as a tool call. The
engine enforces the order: each step takes the artifact ids that earlier steps returned
and refuses ids of the wrong kind, from another run, or whose file changed. No prompt is
trusted to keep the order.

Sport-specific work (reading the clock, indexing plays, tracking players, checking sport
claims, a custom look) lives in a [portable skill](./portable-skills.md) whose scripts run as
**media jobs**. The skill's `SKILL.md` holds the recipe in plain language; the engine code
names no sport, model or look.

With `media` unset (the default), nothing changes: no media tools, no prompt changes.

## Configuration

Operator config (`sportsclawConfig.media`):

```ts
const engine = new sportsclawEngine({
  media: {
    workspaceDir: "/srv/sportsclaw/media", // sources and everything the tools write live here
    rightsCheck: "require",                // or "off"; see Rights below
    interpreters: {                        // argv prefix per job kind; "default" for the rest
      default: ["/opt/media-venv/bin/python"],
      "my-pack/render-follow": ["/opt/gpu-venv/bin/python"],
    },
    maxJobsPerRun: 12,
    factTools: ["host_box_score"],         // extra tools whose results count as facts
    clearances: [                          // footage cleared for clipping, one entry per exact file
      { sourceSha256: "<sha256 of game.mp4>", rightsHolder: "League", licenseRef: "L-2026-114", clearedForClipping: true },
    ],
  },
  inference: {
    roles: { writer: { route: "nim", model: "…", baseUrl: "http://127.0.0.1:8000/v1" } },
    speech: { route: "nim", format: "riva", voice: "…", baseUrl: "http://127.0.0.1:9000/v1" },
  },
});
```

- `workspaceDir` — a source must resolve (after symlinks) to a regular file inside it.
  Artifacts are registered under `<workspaceDir>/artifacts/`, job files under
  `<workspaceDir>/jobs/<jobId>/`, and the tools' own files under `<workspaceDir>/story/`.
- `interpreters` — when there is no `default`, the engine's `pythonPath` is the default,
  then `python3`. A pack never names its interpreter.
- `factTools` — by default only Sports Skills data tools count as facts. Host tools and MCP
  tools count only when listed here.
- `inference.roles.writer` is needed by `story_draft_lines`, `inference.speech` by
  `speech_synthesize`. Every configured role except `brain` is reachable by jobs through the
  role proxy (below).

- `clearances` — see [Rights](#rights).

None of these is a tool input: the model cannot change the workspace, the rights switch, the
clearances, the interpreters or the allowlist.

### Environment variables

| Variable | What it does |
|---|---|
| `SPORTSCLAW_MEDIA_JOB_ALLOWLIST` | JSON list of `{ "skill", "kind", "bundleSha256" }`. Only these job kinds exist for the agent. Malformed or duplicated entries deny everything. |
| `SPORTSCLAW_MEDIA_RIGHTS_CHECK` | `off` turns the rights check off when `media.rightsCheck` is not set. Any other value means `require`. `sportsclaw clip`, `sportsclaw highlights run` and the relay's highlights jobs follow this variable only: `media.rightsCheck` and `media.clearances` apply to the media story tools. |

Skills are found as for portable skills (`SPORTSCLAW_SKILL_GUIDES_DIR`).

## The tools

| Tool | Input | Requires | Returns |
|---|---|---|---|
| `media_source_open` | `{ path }` (anything else: `unknown_field`) | a file inside `workspaceDir` | `sourceArtifactId`, `sha256`, `durationSec` (null if it cannot be probed), and `shared`: artifacts already prepared for this source |
| `media_job_start` | `{ skill, kind, input, sourceArtifactId? }` | an approved kind that is not a renderer (`renderer_only`); artifact ids in `input` (see `x-artifact-kind`) | `jobId` (and `prep: true` for a [prep job](#prep-jobs)) |
| `media_job_status` | `{ jobId, waitSec? }` | a job of this run, or a prep job of any run on this engine; `waitSec` is capped at 60 | state, artifact ids and facts when done |
| `media_job_cancel` | `{ jobId }` | as `media_job_status` | state |
| `media_find_events` | `{ indexArtifactId, text?, people?, period?, type?, limit? }` | `event-index` | rows: `eventId`, `period`, `clock`, `label`, `people`, `type`, and where the play is in the video: `videoSec` and its clip window `startSec`–`endSec` |
| `story_facts_collect` | `{}` | — | `facts` artifact id, fact ids with tool names |
| `story_draft_lines` | `{ indexArtifactId, eventIds, factsArtifactId?, brief, maxLines? }` | `event-index`, `facts`, a writer role | draft lines (not an artifact), and `writingGuide`: the skill whose [writing guide](#the-writing-guide) the writer was given, when there is one |
| `story_check_lines` | `{ indexArtifactId, factsArtifactId?, lines }` | `event-index`; `facts` is optional (without it a line can cite only events) | verdicts, a `lines-checked` artifact of the lines that passed, `rewritesLeft`, and `checker`: the checker that ran (`<skill>/check-lines` or `built-in`) |
| `speech_synthesize` | `{ linesArtifactId, lineIds, voice? }` | `lines-checked`; `inference.speech` | one `voice` artifact id per line |
| `story_timeline_build` | `{ timeline }` | every artifact id it names | `timeline` artifact id |
| `story_render` | `{ timelineArtifactId, renderer?, input? }` | `timeline`; `renderer` is `"plain"` or an approved `<skill>/<kind>` that reads the source and produces `video`; `input` only for a skill renderer (see [Renderers](#renderers)) | `video` artifact id, duration |

The tools are built for each run and follow `toolAllowlist` like host tools; a host tool may
not reuse one of these names. When they are offered, the system prompt gains a short section
naming them and pointing to the skill's `SKILL.md` for the recipe.

A refused call returns `{ "error_code", "message" }` as its tool result, for example
`artifact_wrong_kind`, `artifact_wrong_run`, `artifact_changed`, `unknown_kind`,
`unknown_line`, `bad_index`, `rewrite_limit`, `rights_required`, `source_outside`,
`artifact_not_minted`, `renderer_only`, `clip_not_event`, `unknown_event`, `prep_busy`,
`writing_guide_ambiguous`.

What the model sees of an error is bounded:

- A failed writer call returns `model_call_failed` and a failed speech call `speech_failed`,
  each with `code`, the router's error code (`auth`, `timeout`, `rate_limited`, …), and never
  the provider's text, which can echo a key.
- Any other unexpected error returns `failed` with a generic message.
- Absolute paths in a message (from the filesystem, a spawn, a job's stderr) are replaced by
  `<path>`.
- A job's view (`media_job_status`, `media_job_cancel`) caps its `error` at 2 KiB and each
  `facts` object's JSON at 8 KiB (cut to a string), and says `truncated: true` when it cut
  anything.

Rules the engine enforces:

- **Checked lines only.** A timeline names captions by `lineId`, never by text, and the text
  comes from the exact `lines-checked` artifact the timeline names. Speech takes only lines
  from a `lines-checked` artifact. A line that failed the check has no `lineId`.
- **Made by the tools only.** `facts`, `lines-checked`, `voice` and `timeline` artifacts are
  accepted only if these tools registered them in the same run (`artifact_not_minted`
  otherwise): not from a job, not from an earlier run, not from the shared registry. A job
  kind whose `produces` names one of them is invalid and never offered.
- **Overlays are presentation only.** A segment's `overlay` (score, clock, names) is not
  checked against anything. A renderer must not draw overlay values as claims: numbers shown
  on screen come from the record (the event index or the facts), not from the overlay.
- **Rewrites.** A run gets three `story_check_lines` calls (the first and two rewrite
  rounds); the fourth returns `rewrite_limit`.
- **Timelines.** `story_timeline_build` and `story_render` use only a timeline that the
  engine resolved, with the source's probed duration; a source whose duration cannot be read
  cannot be timed (`source_duration_unknown`).
- **Clips by play.** A clip may name its play with `eventId` instead of `startSec`/`endSec`:
  the engine takes the window from the event index the timeline's `lines-checked` artifact was
  checked against. A clip that gives both must lie within the event's window plus or minus
  5 seconds (`clip_not_event`). An `eventId` that is not in that index is `unknown_event`; a
  clip with an `eventId` needs a `linesArtifactId` (`missing_lines_artifact`). The resolved
  timeline, and what a renderer gets, always has `startSec` and `endSec` on every clip.
- **Event index.** `media_find_events` reads a job-made `event-index` artifact and refuses
  (`bad_index`) one that is not exactly `{ version: 1, sourceSha256, events, skipped }` for
  the source, with each event exactly `{ eventId, actionId, period, clockSec, label, type,
  people, videoSec, startSec, endSec }`.
- **Prepared once.** Artifacts a job marks `shared` (and every artifact of a
  [prep job](#prep-jobs)) are registered for the source's sha256. A later run that opens the
  same file sees them in `shared` and can use them. Under `rightsCheck: "require"`, a shared
  `video` or `subject-tracks` artifact from an earlier run is used only if this run has a
  clearance for its source (`rights_required` otherwise).

Every call is recorded on the run trace as `mediaSteps`
(`{ tool, artifactIds, jobId?, input }`, in call order; `input` is the call's arguments with
every string cut to 200 characters; `story_check_lines` steps also name the `checker` that
ran), next to `numberGrounding`, so a run shows the agent ran
each step and which ids each step took. A refused call is a step too, with `refused: "<error_code>"`
(for example `job_budget`, `bundle_changed`, `prep_busy`) and no artifact ids, so a run where the
model claims it started a job that was refused shows the refusal; the tool metrics count it as a
failed call. The receipts of the tools' model calls (the writer,
speech, and every role-proxy call a job makes) are on the trace as `mediaReceipts`. The run
manifest writes both as `run.media_steps` (null when the run had no media tools) and
`run.media_receipts` (null when there were none). Receipts are metadata only: route, model
id, status, latency; never text.

### Line checks

A line passes only if every built-in check passes **and** the skill's checker, if any, says
ok:

- each cite names an event in the index or a fact; a line has at least one cite;
- every number in the line appears in the evidence it cites.

An event's evidence is its clock as the writer is shown it (`period 4 0:15`), its label and
its people, so "with 15 seconds left" can be backed by the play it cites.

The engine's number check is the same as the answer number check, with its limits: it skips
one-digit numbers, ordinals ("4th"), tokens such as "Q4", and the number words one to nine.
Sport claims — made or missed, tie or lead, who did it — belong to the skill's
`check-lines` job. The engine runs that job when the skill whose job made the index (in this
run) has an approved `check-lines` kind; for an index prepared in an earlier run, the one
approved skill with a `check-lines` kind (if several have one, the check is refused with
`checker_ambiguous`). The model cannot choose the checker. The job gets
`{ lines, evidence: { events, facts } }` and must write `facts.verdicts`: one
`{ text, ok, reasons }` per line, in order. A checker that fails, times out or answers
anything else fails every line; a verdict `ok: false` with no reasons gets the reason
`checker_refused`.

## Media jobs

A skill declares job kinds in `jobs.json` beside `SKILL.md`:

```json
{
  "jobs": [
    { "kind": "make-index", "entry": "make_index.py", "readsSource": true,
      "produces": ["clock-map", "event-index"], "timeLimitSec": 3600,
      "inputSchema": { "type": "object", "properties": { "gameId": { "type": "string" } } } },
    { "kind": "follow", "entry": "follow.py", "readsSource": true, "produces": ["subject-tracks"],
      "inputSchema": { "type": "object", "properties": {
        "index": { "type": "string", "x-artifact-kind": "event-index" },
        "eventIds": { "type": "array", "items": { "type": "string" } } } } }
  ]
}
```

### The writing guide

A skill's rules for the story writer (how many lines, how long, what not to say) do not depend
on the agent copying them into `brief`. Put them in a text file under `scripts/` and name it
at the top of `jobs.json`:

```json
{ "writingGuide": "writing-guide.md", "jobs": [ ... ] }
```

- `story_draft_lines` puts the file's text into the writer prompt word for word, after the
  brief and before the plays and facts, whatever the brief says. `brief` is then only the
  story's angle, and the tool's description tells the agent so.
- The file is under `scripts/`, so the bundle hash covers it: editing the guide needs a new
  approval, like editing a script. It may be at most 4000 characters.
- Whose guide is used is chosen as the [line checker](#line-checks) is: the skill whose job
  made the index in this run; for an index prepared in an earlier run, the one approved skill
  that declares a guide (if several do, the call is refused with `writing_guide_ambiguous`).
  The model cannot choose it. The call's result names the skill as `writingGuide`.
- A declared guide that cannot be used (not a plain path under `scripts/`, missing, blank or
  too long) makes `jobs.json` unusable: the skill has no job kinds until it is fixed.
- With no guide declared, the writer prompt is unchanged. The engine has no writing rules of
  its own. Engine 0.31.0 ignores the key.

### Approval: a bundle hash

A kind runs only if `(skill, kind, bundleSha256)` is in `SPORTSCLAW_MEDIA_JOB_ALLOWLIST`. The
hash covers every file under the skill's `scripts/` and its `jobs.json`, so any edit to
either needs a new approval. Compute it with:

```bash
sportsclaw media bundle-hash /opt/sportsclaw/skills/my-pack
```

```bash
export SPORTSCLAW_MEDIA_JOB_ALLOWLIST='[{"skill":"my-pack","kind":"make-index","bundleSha256":"<hash>"}]'
```

Kinds that are not approved are not shown to the model at all.

### What `inputSchema` enforces

The engine checks a job's input against a small subset of JSON Schema, nothing more:

- the top-level `type` (default `object`; the input must be an object);
- `required`: each listed key is present;
- `properties.<key>.type` for each key present: `string`, `number` (finite), `integer`,
  `boolean`, `array` or `object`;
- `additionalProperties: false`: no key outside `properties`.

Everything else (`items`, `enum`, `minimum`, nested `properties`, formats) is not checked: a
job must validate what it relies on. `x-artifact-kind` is the engine's own annotation (below).

### The job contract

- The bundle is copied to a private temp dir and re-hashed for each job; the copy runs, never
  the live skill dir.
- Command: `<interpreter> <sealed>/scripts/<entry> --input <input.json> --out <out dir>`, in
  its own process group, with only the pass-through environment plus
  `SPORTSCLAW_ROLE_PROXY_URL` and `SPORTSCLAW_ROLE_PROXY_TOKEN`. No keys.
- `input.json`:

  ```json
  {
    "input": { "...": "the validated input" },
    "source": { "path": "/abs/path/game.mp4", "sha256": "…" },
    "artifacts": { "art_0123456789abcdef": { "kind": "event-index", "path": "/abs/…", "sha256": "…" } }
  }
  ```

  `source` is there only for `readsSource` kinds. `artifacts` is always there (`{}` when
  none): every artifact the input names, already checked.
- **`status.json`.** When a job ends (succeeded, failed or canceled) the engine writes
  `<workspaceDir>/jobs/<jobId>/status.json`, before `media_job_status` reports the end:

  ```json
  { "jobId": "job_…", "state": "failed", "errorCode": "time_limit", "error": "the job exceeded …", "endedAt": "2026-11-17T…Z" }
  ```

  `errorCode` and `error` are there only when the job did not succeed (`"canceled"` for a
  cancel). Job state otherwise lives in the engine's memory, so a poller outside the engine
  (a studio waiting on a prep job) reads this file to learn a job died without waiting out its
  own time limit. No file means the job is still running (or the engine stopped before it
  ended).
- **`x-artifact-kind`.** In `inputSchema`, a property with `"x-artifact-kind": "<kind>"`
  holds an artifact id (type `string`) or a list of ids (type `array`). Before the job
  starts, each id must exist, be of that kind, come from this run (or be shared for the
  job's source) and still match its sha256; then it appears in `artifacts` with its path. A
  `source` annotation is allowed only on a kind that reads the source.
- **One source per job.** Every `source` id in a job's input must be the job's own source:
  an artifact with the same sha256 as `sourceArtifactId` (for a renderer: the timeline's
  source). Another source, or a `source` annotation without a `sourceArtifactId`, is refused
  with `source_mismatch` (whatever the rights setting), and no job starts. The job's clearance
  covers its own source's bytes only.
- Limits: `timeLimitSec` (default 600) and `maxOutputBytes` for everything under `out/`. Over
  a limit, or on cancel, the process group is killed.
- On exit 0 the job writes `out/manifest.json`:
  `{ "artifacts": [{ "kind", "file", "facts"?, "shared"? }], "facts": {} }`. Each file must be
  a regular file inside `out/`, and each kind must be in the kind's `produces`. `produces` may
  not name `facts`, `lines-checked`, `voice` or `timeline` (only the story tools make those);
  a declaration that does is dropped. A job's small results go in the manifest's `facts`
  object instead.

### Renderers

A renderer is a kind that reads the source and produces `video`. It runs only through
`story_render` with `renderer: "<skill>/<kind>"`; `media_job_start` refuses any kind whose
`produces` includes `video` (`renderer_only`), so a renderer never gets captions the engine
did not take from checked lines.

Its input is `{ "timeline": <resolved timeline, with captions>, ...input }`, where `input` is
`story_render`'s optional `input` object (for example `{ "espnEventId": "401585601" }`).
`timeline` is reserved: an `input` that has it is refused. The merged object is validated
against the renderer kind's `inputSchema`, and its `x-artifact-kind` ids are checked as for any
job (one source per job). `artifacts` holds those, the source, the `lines-checked` artifact,
and every voice and subject-tracks artifact the timeline names. The plain renderer takes no
`input`.

### Prep jobs

Per-game work (reading the clock, indexing plays, tracking and identifying players) can take
an hour. A kind declared `"prep": true` is a **prep job**:

```json
{ "kind": "make-index", "entry": "make_index.py", "readsSource": true, "prep": true,
  "produces": ["clock-map", "event-index"], "inputSchema": { "type": "object" } }
```

`prep` is allowed only on a kind that reads the source and whose every `produces` kind is
`clock-map`, `event-index`, `subject-tracks` or `subject-identity`; any other declaration with
`prep` is dropped. A prep job:

- runs on the engine, not the run: an engine-wide runner and role proxy, started with the first
  prep job from the engine's `media` and `inference` config. The job has its own role-proxy token,
  revoked when the job ends, and the proxy does not keep the process alive by itself;
- is **not** cancelled when the run that started it ends (the run's other jobs are);
- registers every artifact it makes as `shared` for the source when it succeeds, so a later run
  that opens the same file finds it in `shared`;
- can be read and cancelled by its `jobId` (`media_job_status`, `media_job_cancel`) from any
  later run on the same engine;
- is limited per run (a run may start `maxJobsPerRun` prep jobs, counted apart from its other
  jobs) and per engine: at most 4 prep jobs run at once, and the next start is refused with
  `prep_busy`.

Receipts of a prep job's role-proxy calls go to the starting run's trace (`mediaReceipts`) while
that run lasts. After it ends they collect on the engine; `engine.mediaPrepReceipts()` returns
them and empties the list.

A long-lived host (the studio) calls `await engine.closeMedia()` on shutdown: it cancels
running prep jobs and closes their role proxy. Without it, prep jobs run until they finish or
hit their time limit. A prep job started after `closeMedia()` starts the runner again.

### Role proxy

When `inference` has roles, the engine starts a loopback proxy for the run. A job calls
`POST $SPORTSCLAW_ROLE_PROXY_URL/role/<role>` with `Authorization: Bearer
$SPORTSCLAW_ROLE_PROXY_TOKEN` and `{ input, system?, media?, sampling? }`, and gets
`{ output }`. The engine makes the call through its role router, so receipts are kept and
model names stay in config. A failed call answers 502 with
`{ "error": "model call failed: <error code>" }` and logs nothing: provider text is never
passed on. The proxy closes when the run ends. Prep jobs use the engine's own proxy, which
`closeMedia()` closes, with a token per job.

## Rights

`media.rightsCheck` (or `SPORTSCLAW_MEDIA_RIGHTS_CHECK`) is an operator switch, never a tool
input:

- `require` (default): reading the source (a job kind that reads it, a skill renderer, the
  plain renderer) needs a **clearance** for that source; otherwise the call is refused with
  `rights_required`. The job record (`media_job_status`) and the rendered video carry the
  authorization used (`rights: { rightsHolder, licenseRef }`).
- `off`: no clearance is needed. Job records and rendered videos say
  `rightsCheck: "off (operator)"`.

**The model cannot clear a video.** No tool takes a rights input. A clearance comes from one of
two places, both outside the model:

- operator config, `media.clearances` (as in the example above), for footage cleared for every
  run;
- the app starting a run, `RunOptions.mediaClearances`, for that run only:

  ```ts
  await engine.runDetailed("Make a story of the fourth quarter.", {
    mediaClearances: [{ sourceSha256, rightsHolder: "League", licenseRef: "L-2026-114", clearedForClipping: true }],
  });
  ```

The two lists are merged. A clearance is `{ sourceSha256, rightsHolder, licenseRef,
clearedForClipping, territories? }`; a malformed one is a configuration error (the engine or the
run refuses to start), and only one with `clearedForClipping: true` clears.

**A clearance is tied to the exact bytes.** It names the file's sha256, not its path or name, so
a re-encoded, trimmed or otherwise changed file is a different source and needs its own
clearance. Get the sha256 with `shasum -a 256 game.mp4`, or from `media_source_open`'s result.

Whether a video may be shown or published stays the operator's responsibility; the switch
does not clear footage.
