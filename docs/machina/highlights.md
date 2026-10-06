---
title: Highlight jobs (preview)
description: The relay's typed, rights-gated job API that turns play-by-play into clip windows, with SHA-256 receipts for every clip.
---

# Highlight jobs <Badge type="warning" text="preview" />

The relay can turn play-by-play into video clips: you hand it a source video, the game's actions and a
sync anchor, and it plans clip windows, extracts them with FFmpeg and returns a manifest. It is the
same deterministic core the `sportsclaw clip` CLI uses, exposed as a bounded async job API.

::: warning Preview
Highlight jobs ship in `relay-v0.29.5` and later, but they are not generally available on Machina
projects yet: the relay needs a highlights token provisioned before any route answers. Treat the
contract below as stable V1 and the rollout as in progress.
:::

## The API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/highlights/jobs` | Create a job — strict validation, `202` with a `job_id` |
| `GET` | `/api/highlights/jobs/{job_id}` | Status: `queued`, `running`, `succeeded`, `failed` or `canceled` |
| `POST` | `/api/highlights/jobs/{job_id}/cancel` | Stop the job; it always lands in a terminal state |
| `GET` | `/api/highlights/jobs/{job_id}/artifacts` | Clip manifest and file paths — never base64 video |

Every route requires `X-Auth-Token` to match the relay's `HIGHLIGHTS_API_TOKEN`, compared in constant
time. The gate fails closed: no token on the relay returns `503`, a missing or wrong token returns
`401`. The query endpoints don't use this token.

## Rights come first

A request carries typed evidence for the event, the rights and every action's provenance:

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

The relay checks that the evidence is present and that the caller is authenticated — nothing more. On
Machina, the project's Client API is the authority that decides whether footage may be clipped.

Validation fails closed with a `4xx`: missing rights, event, actions or sync anchor; unsupported clock
semantics (only `elapsed-ascending` in V1); unknown fields; and any `source_path` outside the
allowlisted media root, including traversal, absolute host paths and symlink escapes.

## How clips are planned

Candidate windows are taken in a fixed order: importance, then action time, then ID. Only actions that
share at least 90% of the shorter window with the primary one are merged into it, and overlaps are
never chained transitively. A merged clip spans the union of its windows, so every action keeps the
context it asked for, and lists each merged action with its provenance.

## Integrity receipts

Each successful manifest records `sha256` and `sizeBytes` for the source and for every clip, computed
from the actual media in bounded memory. The CLI pins the resolved source and checks its identity and
bytes before and after extraction; if anything changed, the run fails and removes only its own clips.

Receipts prove which bytes were cut. They don't upload footage, grant rights, rank clips or approve
delivery. Old manifests without hashes are historical records, not verified receipts — run the
extraction again from an approved source instead of filling in hashes by hand.

## Limits and retention

| Variable | Default | Meaning |
| --- | --- | --- |
| `HIGHLIGHTS_MAX_CONCURRENCY` | `1` | Jobs running at once |
| `HIGHLIGHTS_MAX_QUEUE` | `8` | Queued plus running jobs; overflow returns `429` |
| `HIGHLIGHTS_JOB_TIMEOUT` | `900` | Seconds per job |
| `HIGHLIGHTS_JOB_TTL_SEC` | `86400` | Terminal jobs older than this are deleted |
| `HIGHLIGHTS_MAX_STORAGE_BYTES` | 10 GiB | Over the cap after cleanup, new jobs get `507` |
| `HIGHLIGHTS_MAX_JOB_OUTPUT_BYTES` | 2 GiB | Per-job byte budget, enforced while FFmpeg streams |

Job state persists as `job.json` in each job's workspace, so a restarted relay can still answer status
and artifact queries. A job found unfinished after a restart is reported as `failed`, never left
`running`.

## Not in V1

Model-based ranking, rendered reels, vertical (9:16) tracking, signed-URL media download, HLS/DASH or
live ingest, and automatic publishing are deliberately out of scope for this version.
