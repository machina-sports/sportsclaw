# Media Stories Phase 2: Media Worker and OpenShell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the media story with the agent inside an OpenShell sandbox, while the footage, the GPU jobs, speech and rendering stay on the host in a media worker, so the sandbox only ever sees ids, manifests and short facts.

**Architecture:** Phase 1's media tools call one `MediaBackend` interface. The local backend is phase 1's code. A new `sportsclaw media worker` command serves the local backend over HTTP on the host. A remote backend, used inside the sandbox, calls it at `host.openshell.internal`. Speech moves behind the backend too, and gains a `riva-grpc` wire format for hosted Magpie, so the gRPC call and its NVIDIA key stay on the host. A new OpenShell provider profile lets only the sandbox's Node binary reach the worker, with a bearer token.

**Tech Stack:** TypeScript (Node ≥ 22, the engine as today), `node:http`, `@grpc/grpc-js` + `@grpc/proto-loader` (new, pure JS) with NVIDIA Riva's TTS protos vendored, OpenShell 0.1.x provider profiles and policy.

**Spec:** `docs/superpowers/specs/2026-11-16-agent-run-media-stories-design.md` §1 (runners: `worker`), §6 (gRPC speech), §8 (OpenShell). Schedule: `docs/superpowers/plans/2026-11-16-media-stories-to-the-talk.md`, workstream C. Builds on phase 1 (`docs/superpowers/plans/2026-11-16-media-stories-phase1-engine.md`), which must be merged first.

## Global Constraints

- Node engine, Python scripts, as today. No new runtime. New npm dependencies are allowed only for gRPC (`@grpc/grpc-js`, `@grpc/proto-loader`), and must be pure JS.
- The sandbox never receives footage, frames, audio or host file paths. Worker responses carry artifact ids, kinds, sha256, sizes, facts and receipts only.
- The worker enforces the same job allowlist and rights switch as the local runner, from its own operator config. Nothing the sandbox sends can change `rightsCheck`, interpreters or the allowlist.
- No keys cross into the sandbox for speech. The hosted Magpie key is read on the host from the variable `inference.speech.credentialEnv` names, and never appears in responses, receipts or logs.
- The worker requires a bearer token on every request and binds only the address the operator gives. No default `0.0.0.0`.
- Existing behaviour is unchanged when `media.runner` is unset or `"local"`: phase 1's tests pass unmodified.
- Tests run without a GPU, without network and without OpenShell: the worker and a fake gRPC TTS server run in-process on loopback.
- Hosted Magpie today: server `grpc.nvcf.nvidia.com:443`, metadata `function-id: 877104f7-e885-42b9-8de8-f6e4c6303969` and `authorization: Bearer <key>`, `LINEAR_PCM`, 44100 Hz, mono (from the demo's `tts.py`). These are config values, not constants in code.

## Review Focus

1. The worker restarts mid-run. Job ids from before the restart return `unknown_job`, not a hang, and the agent can start the job again. Test in Task 3.
2. The sandbox sends a path (`media_source_open`) that escapes the worker's workspace (`../`, absolute, symlink). Refused with `source_outside`, exactly as locally. Test in Task 3.
3. A slow GPU job with `waitSec` near the cap while the HTTP client's own timeout is shorter. The client timeout is always above the cap, so a wait never surfaces as a network error. Test in Task 4.
4. Magpie answers with an error or an empty audio stream. `speech_synthesize` returns a tool error naming the line, and no `voice` artifact is registered. Test in Task 2.
5. A response that would carry a host path, such as an artifact's `path` or an error message quoting a file. Stripped or replaced before it leaves the worker. Test in Task 3 (scan every response body in the chain test for the workspace path).

---

### Task 1: `MediaBackend` interface, local backend extracted (no behaviour change)

**Files:** Create `src/media/backend.ts`, `src/media/backend-local.ts`. Modify `src/media/tools.ts` so every tool calls the backend. Test: `test/media-backend.test.mjs`; phase 1's `test/media-tools.test.mjs` must pass unchanged.

**Interfaces — Produces:**

```ts
export interface ArtifactRef { id: string; kind: ArtifactKind; sha256: string; sizeBytes: number; facts?: Record<string, unknown> }
export interface MediaBackend {
  openSource(a: { path: string; rights?: RightsAuthorization }): Promise<{ source: ArtifactRef; durationSec: number; shared: ArtifactRef[] }>;
  startJob(a: { skill: string; kind: string; input: unknown; sourceArtifactId?: string }): Promise<{ jobId: string }>;
  jobStatus(a: { jobId: string; waitSec?: number }): Promise<{ state: HighlightsJobState; artifacts: ArtifactRef[]; facts: Record<string, unknown>; error?: string }>;
  cancelJob(a: { jobId: string }): Promise<{ state: HighlightsJobState }>;
  readEventIndex(id: string): Promise<EventIndex>;
  putFacts(facts: Fact[]): Promise<ArtifactRef>;
  readFacts(id: string): Promise<Fact[]>;
  checkLines(a: { indexArtifactId: string; factsArtifactId?: string; lines: DraftLine[]; skill?: string }): Promise<{ verdicts: LineVerdict[]; checked: ArtifactRef }>;
  synthesize(a: { linesArtifactId: string; lineIds: string[]; voice?: string }): Promise<ArtifactRef[]>;
  buildTimeline(timeline: unknown): Promise<ArtifactRef>;
  render(a: { timelineArtifactId: string; renderer?: string }): Promise<{ video: ArtifactRef; durationSec: number }>;
  receipts(): InferenceReceipt[];   // model calls made inside the backend since the last call (drained)
  dispose(): Promise<void>;
}
export class MediaBackendError extends Error { code: string }   // tools map it to { error_code, message }
```

`draftLines` stays in the tools (it is a `writer` call the agent's side makes); the backend gives it events and facts. The `rewrite_limit` counter stays in the tools, per run.

- [ ] **Step 1: Failing test:** `createLocalBackend(ctx)` exposes every method above. One round trip per method on the fixture pack returns `ArtifactRef`s with no `path` property.
- [ ] **Step 2:** Run `npm run test:media-backend`. Expected: FAIL (module missing).
- [ ] **Step 3:** Move the file-touching work out of `tools.ts` into `backend-local.ts` behind the interface. Tools keep schemas, error mapping, `mediaSteps` and the rewrite counter.
- [ ] **Step 4:** Run `npm run test:media-backend` and `npm run test:media-tools`. Expected: PASS, with `media-tools` unmodified.
- [ ] **Step 5:** Commit `refactor(media): tools call a MediaBackend; local backend is phase 1's code`.

---

### Task 2: `riva-grpc` speech format

**Files:** Create `src/inference/speech-riva-grpc.ts`, `vendor/riva/proto/riva_tts.proto`, `vendor/riva/proto/riva_audio.proto` (from `nvidia-riva/common`, Apache-2.0, with LICENSE and source commit noted). Modify `src/inference/speech.ts` (`SPEECH_FORMATS` gains `"riva-grpc"`; config gains `functionId?: string`). Add the dependencies to `package.json`, and add `vendor/riva/proto` to the package `files`. Test: `test/speech-riva-grpc.test.mjs`.

**Interfaces — Produces:** `inference.speech` config `{ route: "api", format: "riva-grpc", baseUrl: "grpc.nvcf.nvidia.com:443", functionId, voice, language, credentialEnv: "NVIDIA_API_KEY" }`. `synthesizeSpeech` returns the same `SpeechResult` (WAV) as today.

- [ ] **Step 1: Failing tests** against an in-process `@grpc/grpc-js` server implementing `RivaSpeechSynthesis.Synthesize`, using an insecure loopback channel when `baseUrl` is loopback:
  - It sends metadata `function-id` and `authorization: Bearer <key>`, plus `text`, `voice_name`, `language_code`, `sample_rate_hz: 44100`, `encoding: LINEAR_PCM`. The returned PCM is wrapped as a mono 16-bit 44.1 kHz WAV whose duration matches the sample count.
  - Server error `UNAUTHENTICATED` → `SpeechRouteError` with code `auth`, and the key is absent from the message.
  - Empty audio → `SpeechRouteError("empty_audio")` (Review Focus 4).
  - A non-loopback `baseUrl` without TLS is refused at config validation. `functionId` is required when `baseUrl` is not loopback.
- [ ] **Step 2:** Run `npm run test:speech-riva-grpc`. Expected: FAIL.
- [ ] **Step 3:** Implement with `@grpc/proto-loader` loading the vendored protos at runtime, using a TLS channel for non-loopback hosts and the `SPEECH_LIMITS` timeout and byte cap.
- [ ] **Step 4:** Run the new test and the existing speech tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(speech): riva-grpc format for hosted Magpie`.

---

### Task 3: The media worker

**Files:** Create `src/media/worker.ts`. Modify `src/index.ts` (new subcommand `sportsclaw media worker --config <file> --listen <host:port>`, with the token read from env `SPORTSCLAW_MEDIA_WORKER_TOKEN`). Test: `test/media-worker.test.mjs`.

**Interfaces — Produces:** HTTP/1.1 JSON API. Every request needs `Authorization: Bearer <token>` (constant-time compare, as in the role proxy). Body cap 1 MiB.

| Route | Backend call |
|---|---|
| `POST /v1/source/open` | `openSource` |
| `POST /v1/jobs` | `startJob` |
| `GET /v1/jobs/:id?waitSec=` | `jobStatus` (waitSec capped at 60) |
| `POST /v1/jobs/:id/cancel` | `cancelJob` |
| `GET /v1/artifacts/:id/event-index`, `GET /v1/artifacts/:id/facts` | `readEventIndex`, `readFacts` |
| `POST /v1/facts` | `putFacts` |
| `POST /v1/lines/check` | `checkLines` |
| `POST /v1/speech` | `synthesize` |
| `POST /v1/timeline` | `buildTimeline` |
| `POST /v1/render` | `render` |

Each response is `{ ok: true, result, receipts }` or `{ ok: false, error_code, message }`. One worker serves one run at a time. `POST /v1/runs` returns a `runId` and resets per-run state (job count, artifacts' run scope), and every other route needs header `X-Run-Id`. The worker runs its own role proxy for job scripts from its own `inference` config.

- [ ] **Step 1: Failing tests** (worker started in-process on `127.0.0.1:0` with the phase 1 fixture pack):
  - No token or a wrong token → 401. A missing or unknown `X-Run-Id` → 409 `unknown_run`.
  - `--listen 0.0.0.0:...` is refused at startup unless `--allow-all-interfaces` is passed.
  - `media_source_open` with `../x.mp4`, an absolute path outside the workspace, or a symlink out → `source_outside` (Review Focus 2).
  - A job id from a previous worker instance → `unknown_job` (Review Focus 1).
  - The rights switch comes only from the worker's config. A request body containing `rightsCheck` → 400 `unknown_field`.
  - Error messages for missing files name the artifact id, never the path.
- [ ] **Step 2:** Run `npm run test:media-worker`. Expected: FAIL.
- [ ] **Step 3:** Implement on `node:http` over the local backend. Strip `path` from every `ArtifactRef`, and replace any occurrence of the workspace path in error text with `<workspace>`.
- [ ] **Step 4:** Run the new test. Expected: PASS.
- [ ] **Step 5:** Commit `feat(media): media worker serves the backend over HTTP`.

---

### Task 4: Remote backend and the `worker` runner config

**Files:** Create `src/media/backend-remote.ts`. Modify `src/media/types.ts` (`MediaConfig.runner?: "local" | "worker"`, `MediaConfig.worker?: { url: string; tokenEnv: string }`), `src/media/tools.ts` (pick the backend from config), `src/schema.ts` (validation). Test: `test/media-remote.test.mjs`.

- [ ] **Step 1: Failing tests:**
  - **Phase 1's whole chain through the worker:** open → job → find → facts → draft → check → speak → timeline → render, using the remote backend against the in-process worker, with the same assertions as phase 1's chain test. `mediaSteps` is identical in shape, and every receipt from the worker appears in the run's receipts.
  - **No host path leaks:** every HTTP response body in that run is scanned for the workspace's absolute path and for any byte sequence of the source file's first 4 KiB, and neither is found (Review Focus 5).
  - **Waiting outlasts the cap:** the client's HTTP timeout is `waitSec + 30 s`. A job that takes 59 s with `waitSec: 60` returns state `running` or `succeeded`, never a network error (Review Focus 3, using fake timers).
  - **Config errors:** `runner: "worker"` without `worker.url`, or with `tokenEnv` naming an unset variable → a config error at startup, not at the first tool call.
- [ ] **Step 2:** Run `npm run test:media-remote`. Expected: FAIL.
- [ ] **Step 3:** Implement with `fetch`. The token is read from `process.env[tokenEnv]` when the backend is created, and never logged. Create a run (`POST /v1/runs`) at backend creation, and drop it on `dispose`.
- [ ] **Step 4:** Run the new test and `npm test`. Expected: PASS, with phase 1's suites unchanged.
- [ ] **Step 5:** Commit `feat(media): remote backend, media.runner = "worker"`.

---

### Task 5: OpenShell profile, policy and recipe

**Files:** Create `openshell/providers/media-worker.yaml`. Modify `openshell/policy.yaml` (comment block only: how to attach the profile), `src/openshell-cli.ts` (the recipe the CLI prints gains an optional `--profile media-worker` step and the job config block), `openshell/Dockerfile` (no footage tools in the image: assert that `ffmpeg` is absent), `docs/deployment/openshell.md`, `docs/advanced/media-stories.md`. Test: extend `test/openshell-recipes.test.mjs`.

**Interfaces — Produces:**

```yaml
id: sportsclaw-media-worker
display_name: Media worker (SportsClaw)
description: Host-local SportsClaw media worker; footage stays on the host
category: tools
credentials:
  - name: worker_token
    env_vars: [SPORTSCLAW_MEDIA_WORKER_TOKEN]
    required: true
    auth_style: bearer
    header_name: authorization
endpoints:
  - host: host.openshell.internal
    port: 8686
    path: /v1/**
    protocol: rest
    access: read-write
    enforcement: enforce
binaries:
  - /usr/local/bin/node
```

Sandbox job config: `"media": { "runner": "worker", "worker": { "url": "http://host.openshell.internal:8686", "tokenEnv": "SPORTSCLAW_MEDIA_WORKER_TOKEN" } }`. Host: `sportsclaw media worker --config host-media.json --listen <bridge IP>:8686`.

- [ ] **Step 1: Failing tests:**
  - The profile parses as YAML, its id matches what the recipe references, and its only endpoint is `host.openshell.internal:8686` under `/v1/**` for Node only.
  - The printed recipe with `--media-worker` includes `profile import -f openshell/providers/media-worker.yaml`, `provider create --name media-worker --type sportsclaw-media-worker --from-existing`, and `--profile media-worker` on sandbox create. Without the flag it is unchanged (snapshot).
  - The Dockerfile installs no `ffmpeg`.
- [ ] **Step 2:** Run `npm run test:openshell-recipes`. Expected: FAIL.
- [ ] **Step 3:** Implement, and write the docs: the host and sandbox diagram, the two configs, the worker command, the token, and that speech runs on the worker.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(openshell): media-worker provider profile and recipe`.

---

### Task 6: Live check on the GPU box (manual, gated by the schedule)

Not a code task. It needs OpenShell installed on the GPU box, plus a Brev instance whose cost is shown and approved before creating it and which is deleted after use.

- [ ] `openshell profile lint -f openshell/providers/media-worker.yaml` passes against the live gateway (the repo's profiles have never been linted live; do `nim-local` and `nvidia-native` too).
- [ ] Start the worker on the host bridge address with the basketball-highlights skill approved. Create the sandbox with `--profile nvidia-native --profile media-worker`. Run "Curry threes".
- [ ] Pass when: the story renders; `openshell policy get <sandbox> --full` shows egress only to `integrate.api.nvidia.com`, `host.openshell.internal:8686` and the Sports Skills data hosts; and `sandbox exec ... ls /sandbox /tmp` shows no video or audio files.
- [ ] Record the rehearsal timing against phase 1 unsandboxed (within 20%).

---

## Self-review notes

- Spec §1 `worker` runner → Tasks 3–4. §6 gRPC → Task 2, confirmed needed (hosted Magpie is gRPC over NVCF). §8 OpenShell profile and policy → Task 5. "The sandbox never sees footage" → Global Constraints + Task 4's leak scan + Task 6.
- Decision beyond the spec: speech runs on the worker, so the gRPC call and the Magpie key stay on the host. The spec left open where speech runs under a sandbox.
- Depends on the final shape of phase 1's `tools.ts` (Task 10). Check Task 1's interface against it before dispatching.
- Release: version 0.32.0 after Task 5, with the OpenShell image rebuilt. npm publish is André's.
