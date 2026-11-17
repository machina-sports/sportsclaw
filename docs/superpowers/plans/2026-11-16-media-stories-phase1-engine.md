# Media Stories, Phase 1 (Engine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the SportsClaw agent generic tools to run a media story end to end on one machine: jobs, typed artifacts with enforced order, a clock map, an event index, drafted and checked lines, speech, a timeline and a plain renderer.

**Architecture:** A new `src/media/` module. `createMediaTools(ctx)` returns `Record<string, HostToolDef>`, and the engine adds them through the existing host-tool path when `config.media` is set. Sport-specific work arrives as job kinds declared by a portable skill and approved by the operator as a hashed bundle. Order is enforced by artifact preconditions inside each tool, never by the prompt.

**Tech Stack:** TypeScript (Node 18+, ESM), `node:test` suites in `test/*.test.mjs` that import from `../dist/`, FFmpeg/FFprobe through `src/highlights/ffmpeg.ts`, Python job scripts run as subprocesses.

**Spec:** `docs/superpowers/specs/2026-11-16-agent-run-media-stories-design.md`. Read it first. This plan covers **Phase 1, engine only**. The basketball pack and the studio switch are a second plan, in the demo repo. The media worker (Phase 2) and soccer (Phase 3) are later plans.

## Global Constraints

- Engine code contains no sport, league or model name: not "basketball", "NBA", "jersey", nor any model id.
- The model never receives file bytes. Tools return manifests, ids and small JSON facts.
- No tool input and no skill file can change `rightsCheck`, the job allowlist or an interpreter. Only operator config and environment can.
- Jobs receive no credentials. The job environment is the passthrough list in `src/skill-runtime.ts` (`PASSTHROUGH_ENV`) plus `SPORTSCLAW_ROLE_PROXY_URL` and `SPORTSCLAW_ROLE_PROXY_TOKEN`.
- Existing behaviour is unchanged when `config.media` is unset. `sportsclaw clip`, `sportsclaw highlights run` and existing `HighlightsRequest` files keep working.
- Every new test runs without a GPU, network or model: use the `mock` inference route and fixture files under `test/fixtures/media/`.
- Each new test file gets a script in `package.json`: `"test:<name>": "npm run build && node --test test/<name>.test.mjs"`.
- Tool results are JSON objects. Errors are `{ "error_code": string, "error": string }` with `isError`, matching `fail()` in `src/skill-runtime.ts`.
- Defaults (spec "my call" values): job time limit 600 s, job output budget `DEFAULT_MAX_JOB_OUTPUT_BYTES`, 12 jobs per run, 2 rewrite rounds per line, `media_job_status` wait at most 60 s.

## Review Focus

Each of these has a test in the task named.

1. **A bundle file changes after it was hashed.** The job must run the bytes that were hashed, or not run. (Task 3)
2. **An artifact's file is edited or deleted after it was registered.** Any tool given its id refuses with `artifact_changed`. (Task 2)
3. **A job runs past its time or byte budget.** It is killed, ends `failed`, and none of its partial files are registered. (Task 4)
4. **A job's manifest names a file outside its output folder** (`../`, an absolute path, a symlink out). The job fails; nothing is registered. (Task 4)
5. **A play's clock falls in no stretch of the clock map,** or in a stopped stretch shared by two plays. It is left out of the index, never guessed. (Task 6)

Also pinned: a caption that differs by one character from its checked line is refused (Task 10); an artifact from another source is refused (Task 2).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/media/types.ts` | Every shared type and constant below. No logic. |
| `src/media/rights.ts` | Resolve the operator's `rightsCheck` mode. |
| `src/media/artifacts.ts` | `ArtifactStore`: register, fetch with checks, per-source registry. |
| `src/media/bundle.ts` | Job-kind declarations (`jobs.json`), bundle hash, allowlist, sealed copy. |
| `src/media/jobs.ts` | `JobRunner` interface, `LocalJobRunner`, states, budgets, manifest intake. |
| `src/media/role-proxy.ts` | Loopback HTTP proxy from a job to `invokeModelRole`. |
| `src/media/clock-map.ts` | Validate a clock map; map a game clock to video seconds. |
| `src/media/event-index.ts` | Build and search an event index. |
| `src/media/lines.ts` | Facts, draft lines, check lines. |
| `src/media/timeline.ts` | Validate a story timeline against checked lines and voices. |
| `src/media/render-plain.ts` | The built-in plain renderer. |
| `src/media/tools.ts` | `createMediaTools(ctx)`: the agent-facing tools. |
| `src/media/index.ts` | Public exports. |
| Modify `src/highlights/types.ts`, `plan.ts`, `run.ts` | Rights switch; clock map in place of a sync anchor. |
| Modify `src/types.ts`, `src/engine.ts`, `src/prompts/system.ts` | `config.media`; wiring; one prompt section. |
| `docs/advanced/media-stories.md` | Operator and skill-author guide. |

---

### Task 1: Shared types and the rights switch

**Files:**
- Create: `src/media/types.ts`, `src/media/rights.ts`
- Modify: `src/highlights/types.ts`, `src/highlights/plan.ts` (`parseHighlightsRequest`), `src/highlights/run.ts` (manifest), `src/highlights/cli.ts`, `src/clipper.ts`
- Test: `test/media-rights.test.mjs`

**Interfaces — Produces:**

```ts
// src/media/types.ts
export const ARTIFACT_KINDS = ["source","clock-map","event-index","subject-tracks","subject-identity",
  "facts","lines-checked","voice","timeline","video"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];
export interface Artifact { id: string; kind: ArtifactKind; path: string; sha256: string; sizeBytes: number;
  sourceSha256?: string; runId: string; createdAt: string; facts?: Record<string, unknown>; }
export type RightsCheckMode = "require" | "off";
export interface MediaConfig { workspaceDir: string; rightsCheck?: RightsCheckMode;
  interpreters?: Record<string, string[]>;   // "<skill>/<kind>" or "default" -> argv prefix
  maxJobsPerRun?: number; }
// src/media/rights.ts
export const RIGHTS_CHECK_ENV = "SPORTSCLAW_MEDIA_RIGHTS_CHECK";
export const RIGHTS_OFF_NOTE = "off (operator)";
export function resolveRightsCheck(config?: { rightsCheck?: unknown }, env?: Record<string,string|undefined>): RightsCheckMode;
// src/highlights/plan.ts
export function parseHighlightsRequest(value: unknown, opts?: { rightsCheck?: RightsCheckMode }): HighlightsRequest;
```

`HighlightsRequest.rights` becomes optional in the type. `ClipManifest` gains `rightsCheck?: "off (operator)"`.

- [ ] **Step 1: Write the failing tests** in `test/media-rights.test.mjs`:

```js
test("defaults to require; env or config can turn it off; anything else is require", () => {
  assert.equal(resolveRightsCheck({}, {}), "require");
  assert.equal(resolveRightsCheck({ rightsCheck: "off" }, {}), "off");
  assert.equal(resolveRightsCheck({}, { SPORTSCLAW_MEDIA_RIGHTS_CHECK: "off" }), "off");
  assert.equal(resolveRightsCheck({ rightsCheck: "require" }, { SPORTSCLAW_MEDIA_RIGHTS_CHECK: "off" }), "require"); // config wins
  for (const v of ["OFF", "false", "0", "", " off "]) assert.equal(resolveRightsCheck({}, { SPORTSCLAW_MEDIA_RIGHTS_CHECK: v }), "require", v);
});
test("highlights: a request without rights fails under require and parses under off", () => {
  const { rights, ...noRights } = validRequest();           // helper copied from test/highlights-core.test.mjs
  assert.throws(() => parseHighlightsRequest(noRights), /rights/);
  assert.throws(() => parseHighlightsRequest(noRights, { rightsCheck: "require" }), /rights/);
  assert.equal(parseHighlightsRequest(noRights, { rightsCheck: "off" }).rights, undefined);
});
test("highlights: clearedForClipping false still fails under require", () => {
  assert.throws(() => parseHighlightsRequest({ ...validRequest(), rights: { ...validRequest().rights, clearedForClipping: false } }), /clearedForClipping/);
});
test("a run under off records it in the manifest", async () => { /* runHighlights on test/fixtures tiny mp4 with rightsCheck off -> manifest.rightsCheck === "off (operator)" and manifest.rights === undefined */ });
```

- [ ] **Step 2:** Run `npm run build && node --test test/media-rights.test.mjs`. Expected: FAIL, `resolveRightsCheck` not exported.
- [ ] **Step 3:** Implement. `runHighlights(request, opts?)` gains `opts.rightsCheck`; `src/highlights/cli.ts` and `src/clipper.ts` pass `resolveRightsCheck(undefined, process.env)`. Config beats env; only the exact string `off` turns it off.
- [ ] **Step 4:** Run the new file and `node --test test/highlights-core.test.mjs test/highlights-cli.test.mjs test/relay-highlights-api.test.mjs`. Expected: all PASS, existing tests untouched.
- [ ] **Step 5:** Commit: `feat(media): shared types; rights check is an operator switch`.

---

### Task 2: Artifact store

**Files:** Create `src/media/artifacts.ts`. Test: `test/media-artifacts.test.mjs`.

**Interfaces — Consumes:** `Artifact`, `ArtifactKind` (Task 1).
**Produces:**

```ts
export class ArtifactError extends Error { code: "artifact_unknown"|"artifact_wrong_kind"|"artifact_changed"|"artifact_wrong_source"|"artifact_wrong_run"; }
export class ArtifactStore {
  constructor(opts: { workspaceDir: string; runId: string });
  /** Hashes the file, records it. `shared: true` also files it in the per-source registry (prep outputs). */
  register(input: { kind: ArtifactKind; path: string; sourceSha256?: string; facts?: Record<string,unknown>; shared?: boolean }): Promise<Artifact>;
  /** Throws ArtifactError unless: known, of `kind`, file still matches sha256, and (this run, or shared for `sourceSha256`). */
  require(id: string, kind: ArtifactKind, opts?: { sourceSha256?: string }): Promise<Artifact>;
  /** Shared artifacts registered for a source, newest first. */
  forSource(sourceSha256: string, kind?: ArtifactKind): Promise<Artifact[]>;
}
```

Ids are `art_` + 16 hex chars from `crypto.randomBytes`. The registry is JSON files under `<workspaceDir>/artifacts/`; files must be inside `workspaceDir`.

- [ ] **Step 1: Failing tests:** register then `require` returns the same record; wrong kind → `artifact_wrong_kind`; unknown id → `artifact_unknown`; **append one byte to the file after registering → `artifact_changed`**; delete the file → `artifact_changed`; an artifact from run A is refused in run B (`artifact_wrong_run`) unless `shared`; **a shared artifact for source X is refused when `opts.sourceSha256` is Y (`artifact_wrong_source`)**; a path outside `workspaceDir` is refused at `register`.
- [ ] **Step 2:** Run. Expected: FAIL, module missing.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(media): artifact store with kind, hash, run and source checks`.

---

### Task 3: Job kinds and bundle approval

**Files:** Create `src/media/bundle.ts`. Test: `test/media-bundle.test.mjs`, fixtures under `test/fixtures/media/pack-ok/` (a skill folder with `SKILL.md`, `jobs.json`, `scripts/echo_job.py`, `scripts/helper.py`, `scripts/requirements.lock`).

**Produces:**

```ts
export const JOB_ALLOWLIST_ENV = "SPORTSCLAW_MEDIA_JOB_ALLOWLIST";   // JSON: [{ skill, kind, bundleSha256 }]
export interface JobKindDecl { skill: string; kind: string; entry: string;       // path under scripts/
  inputSchema: Record<string, unknown>; readsSource: boolean;
  timeLimitSec?: number; maxOutputBytes?: number; produces: ArtifactKind[]; }
/** sha256 over the sorted list "<relative path>\0<file sha256>\n" of every regular file under scripts/. */
export function bundleSha256(skillDir: string): Promise<string>;
/** Kinds from <skill>/jobs.json whose (skill, kind, bundleSha256) is in the allowlist. Malformed allowlist or jobs.json -> []. */
export function approvedJobKinds(guides: ReadonlyArray<SkillGuide>, env?: Record<string,string|undefined>): Promise<JobKindDecl[]>;
/** Copies scripts/ to a fresh private temp dir, re-hashes the copy, and throws BundleError("bundle_changed") unless it equals `expected`. */
export function sealBundle(skillDir: string, expected: string): Promise<{ dir: string; dispose(): Promise<void> }>;
```

`jobs.json` is `{ "jobs": [ { kind, entry, inputSchema, readsSource, timeLimitSec?, maxOutputBytes?, produces } ] }`. `kind` matches `/^[a-z][a-z0-9-]{1,40}$/`. Symlinks under `scripts/` are refused.

- [ ] **Step 1: Failing tests:** the hash is stable and changes when any file's bytes or name change; an unlisted bundle yields no kinds; a listed one yields its kinds; a duplicate or malformed allowlist entry yields `[]` (same rule as `loadScriptPolicy`); an `entry` outside `scripts/` is dropped; **edit `helper.py` between `bundleSha256` and `sealBundle` → `bundle_changed`, and the sealed dir is removed**; a symlink in `scripts/` → refused.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(media): job kinds approved as a hashed bundle`.

---

### Task 4: Local job runner

**Files:** Create `src/media/jobs.ts`. Test: `test/media-jobs.test.mjs`, fixture scripts `ok_job.py`, `slow_job.py`, `big_job.py`, `escape_job.py`, `env_job.py` in a second fixture pack.

**Consumes:** `ArtifactStore` (Task 2), `JobKindDecl`, `sealBundle` (Task 3), `resolveRightsCheck`, `RIGHTS_OFF_NOTE` (Task 1), `HighlightsJobState`.
**Produces:**

```ts
export interface JobRecord { jobId: string; skill: string; kind: string; state: HighlightsJobState;
  startedAt: string; endedAt?: string; error?: string;
  artifacts: Artifact[]; facts: Record<string, unknown>; rightsCheck?: "off (operator)"; }
export interface JobRunner {
  start(req: { decl: JobKindDecl; skillDir: string; bundleSha256: string; input: unknown;
               source?: { path: string; sha256: string; rights?: RightsAuthorization } }): Promise<JobRecord>;
  status(jobId: string, opts?: { waitSec?: number }): Promise<JobRecord>;
  cancel(jobId: string): Promise<JobRecord>;
}
export class LocalJobRunner implements JobRunner {
  constructor(opts: { store: ArtifactStore; config: MediaConfig; env?: Record<string,string|undefined>;
                      roleProxy?: { url: string; token: string } });
}
```

**Job contract** (document it in the file header): the runner runs `<interpreter argv> <sealed dir>/<entry> --input <file.json> --out <out dir>` with cwd the sealed dir. The interpreter is `config.interpreters["<skill>/<kind>"] ?? config.interpreters.default ?? [pythonPath]`. On exit 0 the job must have written `<out dir>/manifest.json`: `{ "artifacts": [{ "kind", "file", "facts"?, "shared"? }], "facts": {} }`. Each `file` must be a regular file inside the out dir and each `kind` must be in `decl.produces`.

- [ ] **Step 1: Failing tests:**
  - `ok_job.py` → `succeeded`, its artifact is registered with the right kind and sha256.
  - Input failing `decl.inputSchema` → start refuses with `invalid_input`; nothing runs.
  - `readsSource: true` and no rights under `require` → `rights_required`; under `off` it runs and `record.rightsCheck === "off (operator)"`.
  - **`slow_job.py` with `timeLimitSec: 1` → `failed`, error mentions the limit, no artifacts.**
  - **`big_job.py` writing past `maxOutputBytes` → killed, `failed`, no artifacts.**
  - **`escape_job.py` whose manifest names `../x`, an absolute path, and a symlink to outside → `failed`, `artifact_path`, nothing registered.**
  - A manifest kind not in `produces` → `failed`.
  - `env_job.py` prints its environment: it holds only the passthrough names plus the two role-proxy names; no name ending in `_KEY` or `_TOKEN` other than `SPORTSCLAW_ROLE_PROXY_TOKEN`.
  - The 13th job in a run with `maxJobsPerRun` unset → `job_budget`.
  - `cancel` on a running job → `canceled`; `status({ waitSec: 5 })` returns as soon as the job ends.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Reuse the kill-on-limit pattern of `runSkillScript`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(media): local job runner with budgets and manifest intake`.

---

### Task 5: Role proxy

**Files:** Create `src/media/role-proxy.ts`. Test: `test/media-role-proxy.test.mjs`.

**Consumes:** `invokeModelRole`, `ModelRoleRouterConfig` (`src/inference/model-role-router.ts`).
**Produces:**

```ts
export function startRoleProxy(opts: { inference: ModelRoleRouterConfig; allowRoles: ModelRole[];
  onReceipt?: (r: InferenceReceipt) => void }): Promise<{ url: string; token: string; close(): Promise<void> }>;
```

It listens on `127.0.0.1` on a random port. `POST /role/<role>` with header `Authorization: Bearer <token>` and JSON `{ input, system?, media?, sampling? }` returns `{ output }`. The token is 32 random bytes, valid until `close()`.

- [ ] **Step 1: Failing tests** (mock route): a valid call returns the mock output and emits one receipt; a wrong or missing token → 401; a role not in `allowRoles` → 403; a non-loopback `Host` → 403; a body over 64 MB → 413; after `close()` the port refuses connections.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5:** Commit: `feat(media): role proxy so jobs call models without keys`.

---

### Task 6: Clock map

**Files:** Create `src/media/clock-map.ts`. Modify `src/highlights/types.ts`, `src/highlights/plan.ts`. Test: `test/media-clock-map.test.mjs`.

**Produces:**

```ts
export const CLOCK_SEMANTICS = ["elapsed-ascending", "countdown-per-period"] as const;
export interface ClockStretch { videoStartSec: number; videoEndSec: number; period: number;
  clockStartSec: number; clockEndSec: number; running: boolean; }
export interface ClockMap { version: 1; semantics: (typeof CLOCK_SEMANTICS)[number]; stretches: ClockStretch[]; }
export function parseClockMap(value: unknown): ClockMap;                       // throws ClockMapError naming the field
/** Video second of (period, clockSec), or null when no running stretch contains it. */
export function clockToVideoSec(map: ClockMap, period: number, clockSec: number): number | null;
export function clockMapFromSyncAnchor(anchor: SyncAnchor): ClockMap;
```

`HighlightsRequest` gains optional `clockMap`; exactly one of `syncAnchor` or `clockMap` is required. `PBPClock.semantics` may be either value; under `countdown-per-period`, `elapsedSec` holds the clock as shown (seconds remaining in the period). `planCandidateWindows` maps through `clockToVideoSec` and drops actions that map to `null`.

- [ ] **Step 1: Failing tests:**
  - Countdown: a stretch `{video 100–160, period 2, clock 720→660, running}` maps `(2, 700)` to `120` and `(2, 650)` to `null`.
  - Ascending: `clockMapFromSyncAnchor({ videoSec: 30, clockSec: 10 })` maps `(1, 25)` to `45`, and every existing case in `test/highlights-core.test.mjs` gives the same windows as before.
  - **A stopped stretch (`running: false`, `clockStartSec === clockEndSec`) maps its clock to `null`, so two plays at the same stopped clock are both left out.**
  - **A clock between two stretches → `null`.**
  - `parseClockMap` rejects: overlapping video ranges, `videoEndSec <= videoStartSec`, a running countdown stretch whose clock rises, an unknown `semantics`, more than 20000 stretches.
  - A request with both or neither of `syncAnchor` and `clockMap` is rejected.
- [ ] **Step 2–4:** Run (FAIL), implement, run this file plus `test/highlights-core.test.mjs test/highlights-providers.test.mjs` (PASS).
- [ ] **Step 5:** Commit: `feat(media): clock map with countdown clocks; highlights accepts it`.

---

### Task 7: Event index

**Files:** Create `src/media/event-index.ts`. Test: `test/media-event-index.test.mjs`.

**Consumes:** `ClockMap`, `clockToVideoSec`, `PBPAction`, `WindowPolicy`, `DEFAULT_WINDOW_POLICY`.
**Produces:**

```ts
export interface IndexedEvent { eventId: string; actionId: string; period: number; clockSec: number;
  label: string; type: string; people: string[]; videoSec: number; startSec: number; endSec: number; }
export interface EventIndex { version: 1; sourceSha256: string; events: IndexedEvent[]; skipped: { actionId: string; reason: "no_stretch" }[]; }
export function buildEventIndex(input: { sourceSha256: string; sourceDurationSec: number; clockMap: ClockMap;
  actions: (PBPAction & { people?: string[] })[]; window?: WindowPolicy }): EventIndex;
export function findEvents(index: EventIndex, q: { text?: string; people?: string[]; period?: number; type?: string; limit?: number }): IndexedEvent[];
```

`eventId` is `ev_<actionId>`. `findEvents` matches `text` case-insensitively on whole words of `label`; every given filter must match; default `limit` 12, ceiling 50; results are in game order.

- [ ] **Step 1: Failing tests:** three actions, one outside every stretch → two events and one `skipped` with `no_stretch`; windows are clamped to `[0, sourceDurationSec]`; `findEvents({ text: "three" })` matches "three pointer" but not "threesome"; `people` matches a full name exactly, case-insensitively; `limit: 500` returns at most 50.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5:** Commit: `feat(media): event index and search`.

---

### Task 8: Facts, drafting and checking lines

**Files:** Create `src/media/lines.ts`. Test: `test/media-lines.test.mjs`, fixture pack with `scripts/check_lines.py`.

**Consumes:** `unsupportedNumbers` (`src/number-grounding.ts`), `invokeModelRole`, `LocalJobRunner`, `ArtifactStore`, `RunToolResult`.
**Produces:**

```ts
export interface Fact { factId: string; toolName: string; output: string; }          // factId: "fact_<n>"
export interface DraftLine { text: string; cites: string[]; }                          // eventIds and factIds
export interface CheckedLine extends DraftLine { lineId: string; }                     // lineId: "line_<n>"
export interface LineVerdict { text: string; ok: boolean; reasons: string[]; }
export function collectFacts(results: RunToolResult[]): Fact[];                        // data-tool results only, errors left out
export function draftLines(args: { inference: ModelRoleRouterConfig; brief: string; events: IndexedEvent[];
  facts: Fact[]; maxLines: number; abortSignal?: AbortSignal; onReceipt?: (r: InferenceReceipt) => void }): Promise<DraftLine[]>;
export function checkLines(args: { lines: DraftLine[]; events: IndexedEvent[]; facts: Fact[];
  checker?: (lines: DraftLine[], evidence: { events: IndexedEvent[]; facts: Fact[] }) => Promise<LineVerdict[]> }):
  Promise<{ verdicts: LineVerdict[]; passed: CheckedLine[] }>;
```

`draftLines` makes one `writer`-role call and parses a JSON array of `{ text, cites }`; a reply that is not that shape throws `LinesError("draft_unusable")`. `checkLines` always runs: every cite must name a known event or fact (`unknown_cite`), a line needs at least one cite (`no_cite`), and every number in the line must appear in the cited evidence (`unsupported_number`, via `unsupportedNumbers`). Then the skill's checker runs, if any; a line passes only if both pass. The skill checker is the job kind named `check-lines`, run through the job runner with the lines and evidence as input; its manifest facts hold `verdicts`.

- [ ] **Step 1: Failing tests:** `collectFacts` numbers facts in order and drops error results; a line citing `ev_x` (unknown) → `unknown_cite`; a line with no cites → `no_cite`; "scores 38" citing an event whose label has no 38 → `unsupported_number`; the same line citing a fact containing 38 passes; a checker verdict `ok: false` fails a line the built-in checks passed, with its reason kept; `passed` holds only passing lines, each with a `lineId`; `draftLines` on the mock route with a canned JSON reply returns the lines, and with prose throws `draft_unusable`.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5:** Commit: `feat(media): facts, drafted lines and line checks`.

---

### Task 9: Timeline and the plain renderer

**Files:** Create `src/media/timeline.ts`, `src/media/render-plain.ts`. Test: `test/media-timeline.test.mjs` (uses the tiny mp4 fixture from the highlights tests; skips rendering when FFmpeg is absent, as those tests do).

**Produces:**

```ts
export interface TimelineSegment { kind: "clip" | "card"; eventId?: string; startSec?: number; endSec?: number;
  lineId?: string; voiceArtifactId?: string; subjectTracksArtifactId?: string;
  overlay?: Record<string, string | number>; cardSeconds?: number; }
export interface StoryTimeline { version: 1; sourceArtifactId: string; linesArtifactId?: string; segments: TimelineSegment[]; }
/** Throws TimelineError naming the segment index. Returns the timeline with each caption resolved from the checked lines. */
export function resolveTimeline(t: unknown, ctx: { lines: CheckedLine[]; sourceDurationSec: number;
  hasArtifact: (id: string, kind: ArtifactKind) => Promise<boolean> }): Promise<StoryTimeline & { captions: (string | null)[] }>;
export function renderPlain(args: { timeline: StoryTimeline & { captions: (string|null)[] }; sourcePath: string;
  voicePaths: Record<string, string>; outPath: string; abortSignal?: AbortSignal }): Promise<{ durationSec: number }>;
```

A timeline holds no caption text at all, only `lineId`s. That is what makes "no unchecked caption" structural. Limits: 1–40 segments, clip length 1–60 s, total at most 600 s.

- [ ] **Step 1: Failing tests:** a `lineId` not in the checked lines → `unknown_line`; a segment with a `lineId` but no `linesArtifactId` on the timeline → refused; **a segment object carrying a `caption` or `text` property is refused (`unknown_field`)**; a clip outside the source's duration → refused; a `voiceArtifactId` that `hasArtifact(id, "voice")` denies → refused; 41 segments → refused; a valid two-clip timeline renders a file whose FFprobe duration is within 0.5 s of the sum of its segments.
- [ ] **Step 2–4:** Run (FAIL), implement, run (PASS).
- [ ] **Step 5:** Commit: `feat(media): story timeline and a plain renderer`.

---

### Task 10: The tools, the engine wiring and the docs

**Files:** Create `src/media/tools.ts`, `src/media/index.ts`, `docs/advanced/media-stories.md`. Modify `src/types.ts` (`sportsclawConfig.media?: MediaConfig`, default unset), `src/engine.ts` (`addHostTools`), `src/prompts/system.ts`, `src/index.ts` (exports), `docs/.vitepress` sidebar. Test: `test/media-tools.test.mjs`.

**Consumes:** everything above, `synthesizeSpeech`, `probeVideo`.
**Produces:**

```ts
export interface MediaToolsContext { config: MediaConfig; guides: ReadonlyArray<SkillGuide>; inference?: ModelRoleRouterConfig;
  runId: string; getToolResults: () => RunToolResult[]; env?: Record<string,string|undefined>; onReceipt?: (r: InferenceReceipt) => void; }
export function createMediaTools(ctx: MediaToolsContext): Promise<{ tools: Record<string, HostToolDef>; dispose(): Promise<void> }>;
```

Tools and their preconditions:

| Tool | Input | Requires | Returns |
|---|---|---|---|
| `media_source_open` | `{ path, rights? }` | file inside `workspaceDir` | `source` artifact id, duration, and the shared artifacts already registered for it |
| `media_job_start` | `{ skill, kind, input, sourceArtifactId? }` | an approved kind; artifact ids inside `input` are checked against the kind's schema annotations | `jobId` |
| `media_job_status` | `{ jobId, waitSec? }` | — | state, artifact ids and facts when done |
| `media_job_cancel` | `{ jobId }` | — | state |
| `media_find_events` | `{ indexArtifactId, text?, people?, period?, type?, limit? }` | `event-index` | rows: eventId, period, clock, label, people |
| `story_facts_collect` | `{}` | — | `facts` artifact id, fact ids with tool names |
| `story_draft_lines` | `{ indexArtifactId, eventIds, factsArtifactId?, brief, maxLines? }` | `event-index`, `facts` | draft lines (not an artifact) |
| `story_check_lines` | `{ indexArtifactId, factsArtifactId?, lines }` | `event-index`, `facts` | verdicts; `lines-checked` artifact id; `rewritesLeft` |
| `speech_synthesize` | `{ linesArtifactId, lineIds, voice? }` | `lines-checked`; `inference.speech` configured | one `voice` artifact id per line |
| `story_timeline_build` | `{ timeline }` | every id it names | `timeline` artifact id |
| `story_render` | `{ timelineArtifactId, renderer? }` | `timeline`; `renderer` is `"plain"` or an approved `<skill>/<kind>` that `produces` `video` | `video` artifact id, duration |

`story_check_lines` counts calls per run: after the 3rd call (2 rewrite rounds) it returns `error_code: "rewrite_limit"`. The engine wiring: when `config.media` is set, `createMediaTools` output is merged into the map `addHostTools` builds, with the same name-collision error; `dispose` runs when the run ends. Every successful media tool call appends `{ tool, artifactIds, jobId? }` to `mediaSteps` on the run trace that `runDetailed` returns (next to `numberGrounding`), which is the spec's record that the agent ran each step. The system prompt gains one short section listing the tools and saying the skill's `SKILL.md` holds the recipe (only when the tools are offered).

- [ ] **Step 1: Failing tests** (mock routes, a fixture pack with `make_index` and `check-lines` kinds, the tiny mp4):
  - **The whole chain, called as the agent would:** open source → start `make_index` job → find events → collect facts → draft → check → speak → build timeline → render plain. The final result is a `video` artifact, and `mediaSteps` lists the tools in the order called, each with the artifact ids it produced.
  - **Order is enforced:** `speech_synthesize` with a `lineId` that failed the check → `unknown_line`; `story_timeline_build` naming a `lines-checked` id from another run → `artifact_wrong_run`; `story_render` with an `event-index` id → `artifact_wrong_kind`.
  - `media_job_start` for a kind whose bundle is not in the allowlist → `unknown_kind`, and the tool list given to the model contains no trace of it.
  - No tool's JSON Schema has a property named `rightsCheck`, `interpreter` or `allowlist`.
  - The 4th `story_check_lines` call → `rewrite_limit`.
  - With `config.media` unset, the engine's tool map has none of these names (assert against `listToolNames()`).
  - A grep test: no file under `src/media/` matches `/basketball|nba|jersey|nemotron|magpie/i`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement the tools, the wiring and the prompt section.
- [ ] **Step 4:** Run `npm test`. Expected: every suite passes; the count rises by the new tests only.
- [ ] **Step 5:** Write `docs/advanced/media-stories.md`: what the tools are, the `media` config block, the two environment variables, the job contract from Task 4, how to compute a bundle hash (`sportsclaw media bundle-hash <skill dir>` — add this one subcommand in `src/index.ts`, printing `bundleSha256`), and the rights switch. Add it to the docs sidebar.
- [ ] **Step 6:** Commit: `feat(media): agent tools for media stories, wired behind config.media`.

---

## After this plan

- Version bump to 0.31.0 and release happen only after the demo repo's plan (the basketball pack) runs a full story on these tools.
- Not in this plan, by design: the media worker and OpenShell profile (Phase 2), the gRPC speech format (Phase 2, if needed), folding the relay job API into media jobs and the soccer pack (Phase 3).
