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

None of these is a tool input: the model cannot change the workspace, the rights switch, the
interpreters or the allowlist.

### Environment variables

| Variable | What it does |
|---|---|
| `SPORTSCLAW_MEDIA_JOB_ALLOWLIST` | JSON list of `{ "skill", "kind", "bundleSha256" }`. Only these job kinds exist for the agent. Malformed or duplicated entries deny everything. |
| `SPORTSCLAW_MEDIA_RIGHTS_CHECK` | `off` turns the rights check off when `media.rightsCheck` is not set. Any other value means `require`. |

Skills are found as for portable skills (`SPORTSCLAW_SKILL_GUIDES_DIR`).

## The tools

| Tool | Input | Requires | Returns |
|---|---|---|---|
| `media_source_open` | `{ path, rights? }` | a file inside `workspaceDir` | `sourceArtifactId`, `sha256`, `durationSec` (null if it cannot be probed), and `shared`: artifacts already prepared for this source |
| `media_job_start` | `{ skill, kind, input, sourceArtifactId? }` | an approved kind; artifact ids in `input` (see `x-artifact-kind`) | `jobId` |
| `media_job_status` | `{ jobId, waitSec? }` | a job of this run; `waitSec` is capped at 60 | state, artifact ids and facts when done |
| `media_job_cancel` | `{ jobId }` | a job of this run | state |
| `media_find_events` | `{ indexArtifactId, text?, people?, period?, type?, limit? }` | `event-index` | rows: `eventId`, `period`, `clock`, `label`, `people` |
| `story_facts_collect` | `{}` | — | `facts` artifact id, fact ids with tool names |
| `story_draft_lines` | `{ indexArtifactId, eventIds, factsArtifactId?, brief, maxLines? }` | `event-index`, `facts`, a writer role | draft lines (not an artifact) |
| `story_check_lines` | `{ indexArtifactId, factsArtifactId?, lines }` | `event-index`, `facts` | verdicts, a `lines-checked` artifact of the lines that passed, `rewritesLeft` |
| `speech_synthesize` | `{ linesArtifactId, lineIds, voice? }` | `lines-checked`; `inference.speech` | one `voice` artifact id per line |
| `story_timeline_build` | `{ timeline }` | every artifact id it names | `timeline` artifact id |
| `story_render` | `{ timelineArtifactId, renderer? }` | `timeline`; `renderer` is `"plain"` or an approved `<skill>/<kind>` that reads the source and produces `video` | `video` artifact id, duration |

The tools are built for each run and follow `toolAllowlist` like host tools; a host tool may
not reuse one of these names. When they are offered, the system prompt gains a short section
naming them and pointing to the skill's `SKILL.md` for the recipe.

A refused call returns `{ "error_code", "message" }` as its tool result, for example
`artifact_wrong_kind`, `artifact_wrong_run`, `artifact_changed`, `unknown_kind`,
`unknown_line`, `bad_index`, `rewrite_limit`, `rights_required`, `source_outside`.

Rules the engine enforces:

- **Checked lines only.** A timeline names captions by `lineId`, never by text, and the text
  comes from the exact `lines-checked` artifact the timeline names. Speech takes only lines
  from a `lines-checked` artifact. A line that failed the check has no `lineId`.
- **Rewrites.** A run gets three `story_check_lines` calls (the first and two rewrite
  rounds); the fourth returns `rewrite_limit`.
- **Timelines.** `story_timeline_build` and `story_render` use only a timeline that the
  engine resolved, with the source's probed duration; a source whose duration cannot be read
  cannot be timed (`source_duration_unknown`).
- **Event index.** `media_find_events` reads a job-made `event-index` artifact and refuses
  (`bad_index`) one that is not exactly `{ version: 1, sourceSha256, events, skipped }` for
  the source, with each event exactly `{ eventId, actionId, period, clockSec, label, type,
  people, videoSec, startSec, endSec }`.
- **Prepared once.** Artifacts a job marks `shared` are registered for the source's sha256.
  A later run that opens the same file sees them in `shared` and can use them.

Every successful call is recorded on the run trace as `mediaSteps`
(`{ tool, artifactIds, jobId? }`, in call order), next to `numberGrounding`, so a run shows
the agent ran each step.

### Line checks

A line passes only if every built-in check passes **and** the skill's checker, if any, says
ok:

- each cite names an event in the index or a fact; a line has at least one cite;
- every number in the line appears in the evidence it cites.

The engine's number check is the same as the answer number check, with its limits: it skips
one-digit numbers, ordinals ("4th"), tokens such as "Q4", and the number words one to nine.
Sport claims — made or missed, tie or lead, who did it — belong to the skill's
`check-lines` job. The engine runs that job when the skill whose job made the index (in this
run) has an approved `check-lines` kind; for an index prepared in an earlier run, the one
approved skill with a `check-lines` kind (if several have one, the check is refused with
`checker_ambiguous`). The model cannot choose the checker. The job gets
`{ lines, evidence: { events, facts } }` and must write `facts.verdicts`: one
`{ text, ok, reasons }` per line, in order. A checker that fails, times out or answers
anything else fails every line.

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
- **`x-artifact-kind`.** In `inputSchema`, a property with `"x-artifact-kind": "<kind>"`
  holds an artifact id (type `string`) or a list of ids (type `array`). Before the job
  starts, each id must exist, be of that kind, come from this run (or be shared for the
  job's source) and still match its sha256; then it appears in `artifacts` with its path. A
  `source` annotation is allowed only on a kind that reads the source.
- Limits: `timeLimitSec` (default 600) and `maxOutputBytes` for everything under `out/`. Over
  a limit, or on cancel, the process group is killed.
- On exit 0 the job writes `out/manifest.json`:
  `{ "artifacts": [{ "kind", "file", "facts"?, "shared"? }], "facts": {} }`. Each file must be
  a regular file inside `out/`, and each kind must be in the kind's `produces`.
- A renderer kind (`story_render` with `renderer: "<skill>/<kind>"`) must read the source and
  produce `video`. Its input is `{ "timeline": <resolved timeline, with captions> }`, and
  `artifacts` holds the source, the `lines-checked` artifact, and every voice and
  subject-tracks artifact the timeline names.

### Role proxy

When `inference` has roles, the engine starts a loopback proxy for the run. A job calls
`POST $SPORTSCLAW_ROLE_PROXY_URL/role/<role>` with `Authorization: Bearer
$SPORTSCLAW_ROLE_PROXY_TOKEN` and `{ input, system?, media?, sampling? }`, and gets
`{ output }`. The engine makes the call through its role router, so receipts are kept and
model names stay in config. A failed call answers 502 with
`{ "error": "model call failed: <error code>" }` and logs nothing: provider text is never
passed on. The proxy closes when the run ends.

## Rights

`media.rightsCheck` (or `SPORTSCLAW_MEDIA_RIGHTS_CHECK`) is an operator switch, never a tool
input:

- `require` (default): a job that reads the source, and the plain renderer, need the source
  opened with `rights: { rightsHolder, licenseRef, clearedForClipping: true }`; otherwise
  they refuse (`rights_required`).
- `off`: no authorization is needed. Job records and rendered videos say
  `rightsCheck: "off (operator)"`.

Whether a video may be shown or published stays the operator's responsibility; the switch
does not clear footage.
