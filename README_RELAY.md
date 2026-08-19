# SportsClaw Relay Pub/Sub

The Sprint 2 live game architecture now uses `@agent-relay/sdk`.

### Core Flow:
1. `GameMonitor` (`src/game-monitor.ts`) polls the ESPN API. When the score/spread changes, it broadcasts a `GAME_UPDATE` JSON payload to the `#live-games` Relay channel.
2. `GamePresenter` (`src/game-presenter.ts`) listens to `#live-games`.
3. When it catches a delta, it splits the logic:
   - **Discord:** Triggers a `PATCH` webhook to silently update the existing Embed card in-place.
   - **Telegram:** Triggers `editMessageText` to update the inline keyboard message.

### Testing the POC:
```bash
npm run build
node dist/test-relay.js
```

## Highlights Job API (docker relay) — V1

The HTTP relay container (`docker/relay/relay_server.py`) exposes a typed,
bounded async job API over the deterministic highlights core
(`src/highlights/*`). Each job runs `sportsclaw highlights run --request
<json> --output <json>` — the exact same core the `sportsclaw clip` CLI uses.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/highlights/jobs` | Create a job (strict validation, `202` + `job_id`) |
| `GET` | `/api/highlights/jobs/{job_id}` | Job status (`queued`/`running`/`succeeded`/`failed`/`canceled`) |
| `POST` | `/api/highlights/jobs/{job_id}/cancel` | Terminate the subprocess; always lands terminal |
| `GET` | `/api/highlights/jobs/{job_id}/artifacts` | Clip manifest + file paths (never base64 video) |

The pre-existing `/health`, `/api/skills`, `/api/query`, and `/api/query/sync`
endpoints are unchanged.

### Authentication (required)

Every `/api/highlights/*` route requires the `X-Auth-Token` header to match
the relay's `HIGHLIGHTS_API_TOKEN` secret (compared with
`secrets.compare_digest`). The gate fails closed:

- `HIGHLIGHTS_API_TOKEN` unset on the relay → `503` (highlights API
  unavailable) for every highlights request;
- missing, empty, or mismatched `X-Auth-Token` → `401`.

**Core API must provision `HIGHLIGHTS_API_TOKEN` into the relay container's
environment, and Client API must send it as `X-Auth-Token` on every
highlights call.** This repository changes neither Core nor Client.

Rights and provenance fields in the job body remain typed evidence supplied
by the authenticated project caller: **Client API is the authoritative
rights/canonical gate**; the relay enforces that the evidence is present and
that the caller is authenticated, nothing more. The query endpoints
(`/api/query*`, `/api/skills`, `/health`) are not affected by this token.

### Request body (snake_case)

```json
{
  "source_path": "match.mp4",
  "event": { "provider": "espn", "sport": "football", "event_id": "401234567" },
  "rights": { "rights_holder": "…", "license_ref": "…", "cleared_for_clipping": true },
  "actions": [{
    "action_id": "a1", "provider": "espn", "period": 1,
    "clock": { "semantics": "elapsed-ascending", "elapsed_sec": 754 },
    "label": "Goal", "type": "goal", "importance": 95,
    "provenance": "espn:pbp:401234567:a1"
  }],
  "sync_anchor": { "video_sec": 120, "clock_sec": 0 },
  "window": { "pre_roll_sec": 8, "post_roll_sec": 12, "max_candidates": 5 }
}
```

Validation fails closed with `4xx`: missing rights/event/actions/sync anchor,
unsupported clock semantics (only `elapsed-ascending` in V1), unknown fields,
and any `source_path` that does not resolve under the allowlisted media root
(traversal, absolute host paths, and symlink escapes are all rejected).

### Configuration (env)

| Variable | Default | Meaning |
|---|---|---|
| `HIGHLIGHTS_JOBS_ROOT` | `/data/highlights-jobs` | Per-job isolated workspaces (file-backed job state) |
| `HIGHLIGHTS_MEDIA_ROOT` | `/data/media` | Allowlisted root for input media |
| `HIGHLIGHTS_MAX_CONCURRENCY` | `1` | Concurrent job subprocesses |
| `HIGHLIGHTS_MAX_QUEUE` | `8` | Max in-flight (queued + running) jobs; overflow → `429` |
| `HIGHLIGHTS_JOB_TIMEOUT` | `900` | Per-job timeout in seconds |
| `HIGHLIGHTS_API_TOKEN` | *(none — required)* | Shared secret for `X-Auth-Token`; unset → all highlights routes return `503` |
| `HIGHLIGHTS_JOB_TTL_SEC` | `86400` (24h) | Terminal jobs older than this are removed from disk and memory |
| `HIGHLIGHTS_MAX_STORAGE_BYTES` | `10737418240` (10 GiB) | Storage cap for the jobs root; still above it after cleanup → create returns `507` |
| `HIGHLIGHTS_MAX_JOB_OUTPUT_BYTES` | `2147483648` (2 GiB) | Hard per-job output budget enforced by the extraction core (preflight estimate + cumulative actual bytes); clamped to `HIGHLIGHTS_MAX_STORAGE_BYTES` |

### Retention

Cleanup runs at relay startup and before every job creation: terminal
(`succeeded`/`failed`/`canceled`) jobs older than `HIGHLIGHTS_JOB_TTL_SEC` are
deleted — workspace, clips, and in-memory refs. Queued/running jobs are never
deleted. If total storage under the jobs root still exceeds
`HIGHLIGHTS_MAX_STORAGE_BYTES` after cleanup, job creation is refused with a
`507` until retention frees space. Deletion is contained to the jobs root and
never follows symlinked entries.

Job state persists as `job.json` under each job workspace, so a restarted
relay can still answer status/artifact queries; jobs found non-terminal after
a restart are reported as `failed`, never stuck `running`.

### Implemented in V1 vs deferred

Implemented: deterministic PBP→video window planning, FFmpeg/FFprobe
extraction with manifest evidence, rights/authorization gating, bounded async
jobs, cancellation, file-backed persistence.

Deferred (explicitly **not** in V1): Gemini/LLM ranking, HyperFrames/Remotion
rendering, vertical (9:16) tracking, signed-URL/object-store media download,
HLS/DASH/live ingest, and automatic publishing.
