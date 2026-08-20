"""
highlights_jobs — bounded async job manager for the relay highlights API.

Stdlib-only (like skills_catalog.py) so it is unit-testable without aiohttp.
Each job:

  1. is validated strictly (types, required fields, allowlisted media root);
  2. gets an unguessable ID and an isolated workspace under the jobs root;
  3. launches the SportsClaw typed subcommand with argv (never a shell):
       <cmd_prefix> highlights run --request <job>/request.json \
                                   --output  <job>/output.json
  4. persists job.json under its workspace so status/artifacts survive a
     relay restart (jobs found non-terminal on disk with no live process are
     surfaced as failed, never stuck "running").

Concurrency is bounded by an asyncio semaphore; total in-flight jobs
(queued + running) are bounded by max_queue. Cancellation terminates the
subprocess and always lands in a terminal state.
"""

import asyncio
import json
import os
import re
import secrets
import shutil
import signal
import stat
import time
from datetime import datetime, timezone


TERMINAL_STATES = {"succeeded", "failed", "canceled"}
DEFAULT_JOB_TTL_SEC = 24 * 60 * 60
DEFAULT_MAX_STORAGE_BYTES = 10 * 1024 ** 3
# Hard per-job output budget enforced by the TypeScript extraction core;
# must match DEFAULT_MAX_JOB_OUTPUT_BYTES in src/highlights/run.ts.
DEFAULT_MAX_JOB_OUTPUT_BYTES = 2 * 1024 ** 3
SUPPORTED_CLOCK_SEMANTICS = "elapsed-ascending"
MAX_ACTIONS = 500
MAX_CANDIDATES_CEILING = 20
DEFAULT_WINDOW = {"preRollSec": 8, "postRollSec": 12, "maxCandidates": 5}
SOURCE_COPY_CHUNK_BYTES = 1024 * 1024
PROCESS_TERM_GRACE_SEC = 1.0
PROCESS_KILL_TIMEOUT_SEC = 5.0

_JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")


class JobError(Exception):
    """Base error — `status` is the HTTP status the relay should return."""
    status = 500


class JobValidationError(JobError):
    status = 400


class JobNotFoundError(JobError):
    status = 404


class JobStateError(JobError):
    status = 409


class JobQueueFullError(JobError):
    status = 429


class JobStorageFullError(JobError):
    status = 507


# ---------------------------------------------------------------------------
# Strict request validation (snake_case API → camelCase core request)
# ---------------------------------------------------------------------------

def _require_dict(value, field, allowed, required):
    if not isinstance(value, dict):
        raise JobValidationError(f"{field} must be an object")
    unknown = sorted(set(value) - set(allowed))
    if unknown:
        raise JobValidationError(f"{field}: unknown field(s): {', '.join(unknown)}")
    missing = sorted(set(required) - set(value))
    if missing:
        raise JobValidationError(f"{field}: missing required field(s): {', '.join(missing)}")
    return value


def _require_str(value, field):
    if not isinstance(value, str) or not value.strip():
        raise JobValidationError(f"{field} must be a non-empty string")
    return value


def _require_num(value, field, minimum=0):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < minimum:
        raise JobValidationError(f"{field} must be a number >= {minimum}")
    return value


def _require_int(value, field, minimum, maximum=None):
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise JobValidationError(f"{field} must be an integer >= {minimum}")
    if maximum is not None and value > maximum:
        raise JobValidationError(f"{field} must be <= {maximum}")
    return value


def _validate_action(value, field):
    _require_dict(
        value, field,
        allowed=("action_id", "provider", "period", "clock", "label", "type",
                 "importance", "provenance"),
        required=("action_id", "provider", "period", "clock", "label", "type",
                  "provenance"),
    )
    clock = _require_dict(value["clock"], f"{field}.clock",
                          allowed=("semantics", "elapsed_sec"),
                          required=("semantics", "elapsed_sec"))
    semantics = _require_str(clock["semantics"], f"{field}.clock.semantics")
    if semantics != SUPPORTED_CLOCK_SEMANTICS:
        raise JobValidationError(
            f'{field}.clock.semantics "{semantics}" is unsupported — '
            f'only "{SUPPORTED_CLOCK_SEMANTICS}" clocks are supported'
        )
    action = {
        "actionId": _require_str(value["action_id"], f"{field}.action_id"),
        "provider": _require_str(value["provider"], f"{field}.provider"),
        "period": _require_int(value["period"], f"{field}.period", 1),
        "clock": {
            "semantics": semantics,
            "elapsedSec": _require_num(clock["elapsed_sec"], f"{field}.clock.elapsed_sec"),
        },
        "label": _require_str(value["label"], f"{field}.label"),
        "type": _require_str(value["type"], f"{field}.type"),
        "provenance": _require_str(value["provenance"], f"{field}.provenance"),
    }
    if "importance" in value:
        importance = _require_num(value["importance"], f"{field}.importance")
        if importance > 100:
            raise JobValidationError(f"{field}.importance must be <= 100")
        action["importance"] = importance
    return action


def _source_components(source_path, media_root):
    """Normalize an accepted source to relative components under media_root."""
    if "\x00" in source_path:
        raise JobValidationError("source_path contains an invalid character")
    raw_parts = source_path.split(os.sep)
    is_absolute = os.path.isabs(source_path)
    if any(part == ".." for part in raw_parts) or any(
            part == "" and not (is_absolute and index == 0)
            for index, part in enumerate(raw_parts)):
        raise JobValidationError(
            "source_path must resolve under the allowlisted media root")
    media_absolute = os.path.abspath(media_root)
    if is_absolute:
        candidate = os.path.abspath(source_path)
        try:
            contained = os.path.commonpath([candidate, media_absolute]) == media_absolute
        except ValueError:
            contained = False
        if not contained:
            raise JobValidationError(
                "source_path must resolve under the allowlisted media root")
        relative_path = os.path.relpath(candidate, media_absolute)
    else:
        relative_path = os.path.normpath(source_path)
    components = relative_path.split(os.sep)
    if not components or any(part in {"", ".", ".."} for part in components):
        raise JobValidationError(
            "source_path must resolve under the allowlisted media root"
        )
    return components


def _open_source_beneath_root(media_root, components):
    """Open a source through no-follow descriptor-relative POSIX traversal."""
    required_flags = ("O_DIRECTORY", "O_NOFOLLOW")
    if (os.name != "posix" or os.open not in getattr(os, "supports_dir_fd", set())
            or any(not hasattr(os, name) for name in required_flags)):
        raise JobValidationError(
            "secure descriptor-relative source traversal is unavailable")
    common_flags = getattr(os, "O_CLOEXEC", 0) | os.O_NOFOLLOW
    current_descriptor = None
    final_descriptor = None
    try:
        current_descriptor = os.open(
            media_root, os.O_RDONLY | os.O_DIRECTORY | common_flags)
        if not stat.S_ISDIR(os.fstat(current_descriptor).st_mode):
            raise JobValidationError("media root must be a directory")
        for component in components[:-1]:
            next_descriptor = os.open(
                component,
                os.O_RDONLY | os.O_DIRECTORY | common_flags,
                dir_fd=current_descriptor,
            )
            if not stat.S_ISDIR(os.fstat(next_descriptor).st_mode):
                os.close(next_descriptor)
                raise JobValidationError("source_path ancestor must be a directory")
            os.close(current_descriptor)
            current_descriptor = next_descriptor
        final_descriptor = os.open(
            components[-1], os.O_RDONLY | common_flags,
            dir_fd=current_descriptor,
        )
        opened = os.fstat(final_descriptor)
        if not stat.S_ISREG(opened.st_mode):
            raise JobValidationError("source_path must be a regular file")
        descriptor = final_descriptor
        final_descriptor = None
        return descriptor, opened.st_size
    except JobValidationError:
        raise
    except (OSError, TypeError, NotImplementedError) as exc:
        raise JobValidationError(
            "source_path could not be securely opened under the media root") from exc
    finally:
        if final_descriptor is not None:
            os.close(final_descriptor)
        if current_descriptor is not None:
            os.close(current_descriptor)


def _copy_source_snapshot(descriptor, source_size, destination):
    """Copy exactly the admitted bytes from an open descriptor, then rename."""
    temporary = f"{destination}.tmp"
    output_descriptor = None
    try:
        output_descriptor = os.open(
            temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        remaining = source_size
        while remaining:
            chunk = os.read(descriptor, min(SOURCE_COPY_CHUNK_BYTES, remaining))
            if not chunk:
                raise JobValidationError("source_path changed while it was being snapshotted")
            view = memoryview(chunk)
            while view:
                written = os.write(output_descriptor, view)
                view = view[written:]
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            raise JobValidationError("source_path changed while it was being snapshotted")
        os.fsync(output_descriptor)
        os.close(output_descriptor)
        output_descriptor = None
        os.replace(temporary, destination)
    except Exception:
        if output_descriptor is not None:
            os.close(output_descriptor)
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def validate_job_request(body, media_root):
    """Validate a POST /api/highlights/jobs body strictly and convert it to the
    camelCase HighlightsRequest the core consumes (outputDir added later)."""
    if not isinstance(body, dict):
        raise JobValidationError("request body must be a JSON object")
    _require_dict(
        body, "request body",
        allowed=("source_path", "event", "rights", "actions", "sync_anchor", "window"),
        required=("source_path", "event", "rights", "actions", "sync_anchor"),
    )

    source_path = _require_str(body["source_path"], "source_path")
    source_components = _source_components(source_path, media_root)

    event = _require_dict(body["event"], "event",
                          allowed=("provider", "sport", "event_id"),
                          required=("provider", "sport", "event_id"))
    rights = _require_dict(body["rights"], "rights",
                           allowed=("rights_holder", "license_ref", "cleared_for_clipping"),
                           required=("rights_holder", "license_ref", "cleared_for_clipping"))
    if rights["cleared_for_clipping"] is not True:
        raise JobValidationError(
            "rights.cleared_for_clipping must be explicitly true — media is not cleared for clipping"
        )

    if not isinstance(body["actions"], list) or not body["actions"]:
        raise JobValidationError("actions must be a non-empty array of real PBP actions")
    if len(body["actions"]) > MAX_ACTIONS:
        raise JobValidationError(f"actions must contain at most {MAX_ACTIONS} entries")
    actions = [_validate_action(a, f"actions[{i}]") for i, a in enumerate(body["actions"])]

    anchor = _require_dict(body["sync_anchor"], "sync_anchor",
                           allowed=("video_sec", "clock_sec", "period"),
                           required=("video_sec", "clock_sec"))
    sync_anchor = {
        "videoSec": _require_num(anchor["video_sec"], "sync_anchor.video_sec"),
        "clockSec": _require_num(anchor["clock_sec"], "sync_anchor.clock_sec"),
    }
    if "period" in anchor:
        sync_anchor["period"] = _require_int(anchor["period"], "sync_anchor.period", 1)

    window = dict(DEFAULT_WINDOW)
    if "window" in body:
        win = _require_dict(body["window"], "window",
                            allowed=("pre_roll_sec", "post_roll_sec", "max_candidates"),
                            required=("pre_roll_sec", "post_roll_sec", "max_candidates"))
        post_roll = _require_num(win["post_roll_sec"], "window.post_roll_sec")
        if post_roll <= 0:
            raise JobValidationError("window.post_roll_sec must be > 0")
        window = {
            "preRollSec": _require_num(win["pre_roll_sec"], "window.pre_roll_sec"),
            "postRollSec": post_roll,
            "maxCandidates": _require_int(win["max_candidates"], "window.max_candidates",
                                          1, MAX_CANDIDATES_CEILING),
        }

    return {
        "rights": {
            "rightsHolder": _require_str(rights["rights_holder"], "rights.rights_holder"),
            "licenseRef": _require_str(rights["license_ref"], "rights.license_ref"),
            "clearedForClipping": True,
        },
        "source": {"kind": "local-file", "path": os.path.join(*source_components)},
        "event": {
            "provider": _require_str(event["provider"], "event.provider"),
            "sport": _require_str(event["sport"], "event.sport"),
            "eventId": _require_str(event["event_id"], "event.event_id"),
        },
        "actions": actions,
        "syncAnchor": sync_anchor,
        "window": window,
    }


# ---------------------------------------------------------------------------
# Job manager
# ---------------------------------------------------------------------------

def _now():
    return datetime.now(timezone.utc).isoformat()


def _parse_updated_at(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


# Jobs are launched in their own session (process group) on POSIX so the whole
# tree — Node parent plus any FFmpeg grandchildren — can be signalled at once.
_USE_PROCESS_GROUPS = os.name == "posix"


def _signal_job_tree(proc, hard):
    """Signal the job's whole process group (SIGTERM, or SIGKILL when hard).

    Falls back to parent-only signalling on platforms without process-group
    support or when the group is already gone."""
    if _USE_PROCESS_GROUPS:
        try:
            os.killpg(proc.pid, signal.SIGKILL if hard else signal.SIGTERM)
            return
        except (ProcessLookupError, PermissionError, OSError):
            pass
    try:
        if hard:
            proc.kill()
        else:
            proc.terminate()
    except ProcessLookupError:
        pass


def _process_group_exists(group_id):
    if not _USE_PROCESS_GROUPS:
        return False
    try:
        os.killpg(group_id, 0)
        return True
    except ProcessLookupError:
        return False
    except (PermissionError, OSError):
        return True


async def _wait_for_job_tree_exit(proc, parent_wait, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        parent_done = parent_wait.done() or proc.returncode is not None
        group_gone = not _process_group_exists(proc.pid)
        if parent_done and group_gone:
            await parent_wait
            return True
        await asyncio.sleep(0.05)
    return False


async def _shutdown_job_tree(proc):
    """Bounded TERM→KILL shutdown, confirmed for parent and POSIX group."""
    parent_wait = asyncio.ensure_future(proc.wait())
    _signal_job_tree(proc, hard=False)
    if await _wait_for_job_tree_exit(
            proc, parent_wait, PROCESS_TERM_GRACE_SEC):
        return True

    _signal_job_tree(proc, hard=True)
    if await _wait_for_job_tree_exit(
            proc, parent_wait, PROCESS_KILL_TIMEOUT_SEC):
        return True

    # Keep the waiter attached to an unconfirmed process without producing an
    # unhandled task exception if it eventually exits after the timeout.
    parent_wait.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)
    return False


class HighlightsJobManager:
    def __init__(self, jobs_root, media_root, cmd_prefix,
                 max_concurrency=1, max_queue=8, job_timeout_sec=900, env=None,
                 job_ttl_sec=DEFAULT_JOB_TTL_SEC,
                 max_storage_bytes=DEFAULT_MAX_STORAGE_BYTES,
                 max_job_output_bytes=DEFAULT_MAX_JOB_OUTPUT_BYTES):
        self.jobs_root = os.path.realpath(jobs_root)
        self.media_root = media_root
        self.cmd_prefix = list(cmd_prefix)
        self.max_concurrency = max(1, int(max_concurrency))
        self.max_queue = max(1, int(max_queue))
        self.job_timeout_sec = int(job_timeout_sec)
        self.job_ttl_sec = max(0, int(job_ttl_sec))
        self.max_storage_bytes = max(1, int(max_storage_bytes))
        # A single accepted job must never be allowed to exceed the global
        # storage quota on its own.
        self.max_job_output_bytes = max(
            1, min(int(max_job_output_bytes), self.max_storage_bytes))
        self.env = dict(env) if env is not None else dict(os.environ)
        os.makedirs(self.jobs_root, exist_ok=True)
        os.makedirs(self.media_root, exist_ok=True)
        self._jobs = {}
        self._procs = {}
        self._tasks = {}
        # A failed group-disappearance check remains reserved even after the
        # public state becomes failed. This avoids releasing storage capacity
        # while an unconfirmed descendant may still be writing.
        self._capacity_holds = {}
        # Per-job "the spawn attempt is over" events: cancel() must never race
        # an in-flight create_subprocess_exec and leave the tree running.
        self._spawn_done = {}
        self._semaphore = asyncio.Semaphore(self.max_concurrency)
        self._admission_lock = asyncio.Lock()
        self._reconcile_persisted_jobs()
        self.cleanup()

    # --- public API ---------------------------------------------------------

    async def create(self, body):
        core_request = validate_job_request(body, self.media_root)
        async with self._admission_lock:
            self.cleanup()
            active = sum(
                1 for job in self._jobs.values()
                if job["state"] not in TERMINAL_STATES
            )
            if active >= self.max_queue:
                raise JobQueueFullError(
                    f"job queue is at capacity ({self.max_queue} in flight) — retry later"
                )

            source_descriptor, source_size = _open_source_beneath_root(
                self.media_root, core_request["source"]["path"].split(os.sep))
            # Reserve the full effective output budget for every accepted
            # non-terminal job. This intentionally double-counts bytes already
            # written by those jobs: admission stays conservative even while a
            # subprocess is growing its output between checks.
            projected_storage = (
                self._storage_bytes()
                + (active + len(self._capacity_holds) + 1) * self.max_job_output_bytes
                + source_size
            )
            if projected_storage > self.max_storage_bytes:
                os.close(source_descriptor)
                raise JobStorageFullError(
                    "highlights storage capacity is fully used or reserved — retry later"
                )

            job_id = secrets.token_urlsafe(16)
            job_dir = self._job_dir(job_id)
            try:
                os.makedirs(job_dir, mode=0o700)
                snapshot_path = os.path.join(job_dir, "source.snapshot")
                _copy_source_snapshot(source_descriptor, source_size, snapshot_path)
                core_request["source"]["path"] = snapshot_path
                core_request["outputDir"] = os.path.join(job_dir, "clips")
                _atomic_write_json(os.path.join(job_dir, "request.json"), core_request)
            except Exception:
                shutil.rmtree(job_dir, ignore_errors=True)
                raise
            finally:
                os.close(source_descriptor)

            record = {
                "job_id": job_id,
                "state": "queued",
                "created_at": _now(),
                "updated_at": _now(),
                "worker_pid": None,
                "error": None,
            }
            self._jobs[job_id] = record
            self._persist(record)
            self._spawn_done[job_id] = asyncio.Event()
            self._tasks[job_id] = asyncio.create_task(self._run(job_id))
            return self._public(record)

    def get(self, job_id):
        self.cleanup()
        record = self._load(job_id)
        return self._public(record)

    async def cancel(self, job_id):
        self.cleanup()
        record = self._load(job_id)
        if record["state"] in TERMINAL_STATES:
            return self._public(record)

        # Queued cancellation is terminal immediately because no subprocess has
        # started. Running cancellation is not terminal until the process tree
        # has actually exited, so storage/admission capacity is never released
        # while FFmpeg can still be writing.
        was_running = record["state"] == "running"
        if not was_running:
            self._set_state(job_id, "canceled", error="canceled by request")
            return self._public(self._jobs[job_id])

        spawn_done = self._spawn_done.get(job_id)
        if spawn_done is not None:
            await spawn_done.wait()
        proc = self._procs.get(job_id)
        if proc is not None:
            stopped = await _shutdown_job_tree(proc)
            if not stopped:
                self._capacity_holds[job_id] = proc.pid
                self._set_state(
                    job_id, "failed",
                    error="cancellation failed to confirm process-group shutdown",
                )
                self._procs.pop(job_id, None)
                return self._public(self._jobs[job_id])
            self._procs.pop(job_id, None)
        self._set_state(job_id, "canceled", error="canceled by request")
        return self._public(self._jobs[job_id])

    def artifacts(self, job_id):
        self.cleanup()
        record = self._load(job_id)
        if record["state"] != "succeeded":
            raise JobStateError(
                f"artifacts unavailable — job state is {record['state']}"
            )
        job_dir = self._job_dir(job_id)
        output_path = os.path.join(job_dir, "output.json")
        try:
            with open(output_path) as handle:
                manifest = json.load(handle)
        except (OSError, json.JSONDecodeError):
            raise JobError("job manifest is missing or unreadable")
        clips_dir = os.path.join(job_dir, "clips")
        _check_manifest_clips(manifest, clips_dir)
        public_manifest = json.loads(json.dumps(manifest))
        if isinstance(public_manifest.get("source"), dict):
            public_manifest["source"].pop("path", None)
        return {
            "job_id": job_id,
            "state": record["state"],
            "clips_dir": clips_dir,
            "manifest": public_manifest,
        }

    def cleanup(self):
        """Bounded retention: delete terminal jobs older than the TTL from
        disk and drop them from the in-memory maps/task refs.

        Runs at manager startup and before every job creation. Queued/running
        jobs are never touched, and deletion stays contained under jobs_root:
        entries are matched against the job-ID grammar, symlinked entries are
        skipped (never followed), and the resolved path must still be a
        direct child of the jobs root."""
        self._release_capacity_holds()
        now = datetime.now(timezone.utc)
        for job_id, real in self._direct_job_dirs():
            record = self._jobs.get(job_id)
            if record is None:
                try:
                    with open(os.path.join(real, "job.json")) as handle:
                        record = json.load(handle)
                except (OSError, json.JSONDecodeError):
                    continue
            if record.get("state") not in TERMINAL_STATES:
                continue
            task = self._tasks.get(job_id)
            if task is not None and not task.done():
                continue  # e.g. canceled while queued — let the runner finish
            if job_id in self._procs:
                continue
            if job_id in self._capacity_holds:
                continue
            updated_at = _parse_updated_at(record.get("updated_at"))
            if updated_at is None:
                continue
            if (now - updated_at).total_seconds() <= self.job_ttl_sec:
                continue
            shutil.rmtree(real, ignore_errors=True)
            self._jobs.pop(job_id, None)
            self._tasks.pop(job_id, None)
            self._procs.pop(job_id, None)
            self._spawn_done.pop(job_id, None)
            self._capacity_holds.pop(job_id, None)

    # --- internals ----------------------------------------------------------

    def _release_capacity_holds(self):
        """Release reservations only after their exact process group is gone."""
        for job_id, group_id in list(self._capacity_holds.items()):
            if not _process_group_exists(group_id):
                self._capacity_holds.pop(job_id, None)

    def _direct_job_dirs(self):
        """Yield validated direct child job directories without following links."""
        try:
            entries = list(os.scandir(self.jobs_root))
        except OSError:
            return
        for entry in entries:
            job_id = entry.name
            if not _JOB_ID_RE.match(job_id):
                continue
            try:
                if entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
                    continue
            except OSError:
                continue
            real = os.path.realpath(os.path.join(self.jobs_root, job_id))
            if os.path.dirname(real) == self.jobs_root:
                yield job_id, real

    def _reconcile_persisted_jobs(self):
        """Fail queued/running jobs left by a previous relay instance.

        Keep their prior updated_at so normal TTL cleanup can immediately
        remove an already-expired orphan. Current-instance jobs are skipped.
        """
        for job_id, real in self._direct_job_dirs():
            task = self._tasks.get(job_id)
            if job_id in self._jobs or job_id in self._procs or (
                    task is not None and not task.done()):
                continue
            path = os.path.join(real, "job.json")
            try:
                with open(path) as handle:
                    record = json.load(handle)
            except (OSError, json.JSONDecodeError):
                continue
            if record.get("job_id") != job_id or record.get("state") not in {"queued", "running"}:
                continue
            # Never signal a bare persisted PID after restart: the OS may have
            # reused it for an unrelated process. Kubernetes terminates the old
            # container/process namespace before a replacement relay starts;
            # reconciliation therefore only marks persisted metadata failed.
            # Live current-instance workers are always managed through _procs,
            # where process identity and wait semantics are retained.
            record["state"] = "failed"
            record["worker_pid"] = None
            record["error"] = "job was interrupted by a relay restart"
            _atomic_write_json(path, record)

    def _storage_bytes(self):
        """Total bytes under jobs_root without following symlinks."""
        total = 0
        for root, _dirs, files in os.walk(self.jobs_root):
            for name in files:
                try:
                    total += os.lstat(os.path.join(root, name)).st_size
                except OSError:
                    continue
        return total

    def _job_dir(self, job_id):
        """Validate the job ID before it ever touches a filesystem path — a
        crafted value (route param or in-memory key) must never escape the
        jobs root, including via a symlinked job directory."""
        if not isinstance(job_id, str) or not _JOB_ID_RE.match(job_id):
            raise JobNotFoundError("job not found")
        path = os.path.join(self.jobs_root, job_id)
        real = os.path.realpath(path)
        if os.path.dirname(real) != self.jobs_root:
            raise JobNotFoundError("job not found")
        return path

    def _load(self, job_id):
        """In-memory record, or the persisted job.json after a relay restart."""
        if not isinstance(job_id, str) or not _JOB_ID_RE.match(job_id):
            raise JobNotFoundError("job not found")
        if job_id in self._jobs:
            return self._jobs[job_id]
        path = os.path.join(self._job_dir(job_id), "job.json")
        try:
            with open(path) as handle:
                record = json.load(handle)
        except (OSError, json.JSONDecodeError):
            raise JobNotFoundError("job not found")
        if record.get("state") not in TERMINAL_STATES:
            # No live process can exist for it in this relay instance.
            record["state"] = "failed"
            record["error"] = "job was interrupted by a relay restart"
            record["updated_at"] = _now()
            _atomic_write_json(path, record)
        return record

    def _public(self, record):
        view = {
            "job_id": record["job_id"],
            "state": record["state"],
            "created_at": record["created_at"],
            "updated_at": record["updated_at"],
        }
        if record.get("error"):
            view["error"] = record["error"]
        return view

    def _set_state(self, job_id, state, error=None):
        record = self._jobs[job_id]
        record["state"] = state
        record["error"] = error
        if state in TERMINAL_STATES:
            record["worker_pid"] = None
        record["updated_at"] = _now()
        self._persist(record)

    def _persist(self, record):
        _atomic_write_json(os.path.join(self._job_dir(record["job_id"]), "job.json"), record)

    async def _run(self, job_id):
        try:
            await self._run_inner(job_id)
        finally:
            # Every exit path releases any cancel() waiting on the spawn.
            spawn_done = self._spawn_done.pop(job_id, None)
            if spawn_done is not None:
                spawn_done.set()

    async def _run_inner(self, job_id):
        async with self._semaphore:
            if self._jobs[job_id]["state"] != "queued":
                return  # canceled while waiting for a slot
            self._set_state(job_id, "running")

            job_dir = self._job_dir(job_id)
            request_path = os.path.join(job_dir, "request.json")
            output_path = os.path.join(job_dir, "output.json")
            cmd = [*self.cmd_prefix, "highlights", "run",
                   "--request", request_path, "--output", output_path]

            # The extraction core enforces the per-job output budget; hand it
            # the clamped value so a permissive inherited environment can
            # never widen it past the global storage quota.
            env = dict(self.env)
            env["HIGHLIGHTS_MAX_JOB_OUTPUT_BYTES"] = str(self.max_job_output_bytes)
            try:
                with open(os.path.join(job_dir, "stderr.log"), "wb") as stderr_log:
                    proc = await asyncio.create_subprocess_exec(
                        *cmd,
                        stdout=asyncio.subprocess.DEVNULL,
                        stderr=stderr_log,
                        env=env,
                        cwd=job_dir,
                        start_new_session=_USE_PROCESS_GROUPS,
                    )
            except Exception:
                if self._jobs[job_id]["state"] != "canceled":
                    self._set_state(job_id, "failed",
                                    error="failed to launch the highlights subprocess")
                return

            self._procs[job_id] = proc
            self._jobs[job_id]["worker_pid"] = proc.pid
            self._jobs[job_id]["updated_at"] = _now()
            self._persist(self._jobs[job_id])
            spawn_done = self._spawn_done.get(job_id)
            if spawn_done is not None:
                spawn_done.set()
            if self._jobs[job_id]["state"] == "canceled":
                # cancel() landed while the spawn was in flight — the process
                # was born already-canceled, so kill its whole tree now.
                stopped = await _shutdown_job_tree(proc)
                if not stopped:
                    self._capacity_holds[job_id] = proc.pid
                    self._set_state(
                        job_id, "failed",
                        error="cancellation failed to confirm process-group shutdown",
                    )
                self._procs.pop(job_id, None)
                return
            try:
                returncode = await asyncio.wait_for(proc.wait(), timeout=self.job_timeout_sec)
            except asyncio.TimeoutError:
                stopped = await _shutdown_job_tree(proc)
                if not stopped:
                    self._capacity_holds[job_id] = proc.pid
                if self._jobs[job_id]["state"] != "canceled":
                    self._set_state(job_id, "failed",
                                    error=(
                                        f"job timed out after {self.job_timeout_sec}s"
                                        if stopped else
                                        "job timed out and process-group shutdown could not be confirmed"
                                    ))
                return
            finally:
                self._procs.pop(job_id, None)

            if self._jobs[job_id]["state"] == "canceled":
                return
            if returncode == 0 and os.path.isfile(output_path):
                self._set_state(job_id, "succeeded")
            else:
                self._set_state(job_id, "failed", error=_failure_reason(output_path, returncode))


def _check_manifest_clips(manifest, clips_dir):
    """Fail closed (500, no path echo) unless every manifest clip resolves to
    a regular file strictly inside the job's clips directory — a tampered or
    stale manifest must never hand out arbitrary host paths."""
    clips = manifest.get("clips") if isinstance(manifest, dict) else None
    if not isinstance(clips, list):
        raise JobError("job manifest failed artifact containment checks")
    clips_real = os.path.realpath(clips_dir)
    for clip in clips:
        file_path = clip.get("file") if isinstance(clip, dict) else None
        if not isinstance(file_path, str) or "\x00" in file_path:
            raise JobError("job manifest failed artifact containment checks")
        real = os.path.realpath(file_path)
        try:
            contained = real != clips_real and os.path.commonpath([real, clips_real]) == clips_real
        except ValueError:
            contained = False
        if not contained or not os.path.isfile(real):
            raise JobError("job manifest failed artifact containment checks")


def _failure_reason(output_path, returncode):
    """Surface the core's own error message when available — never child
    stderr, which could carry environment details."""
    try:
        with open(output_path) as handle:
            output = json.load(handle)
        error = output.get("error")
        if isinstance(error, str) and error.strip():
            return error
    except (OSError, json.JSONDecodeError):
        pass
    return f"highlights subprocess exited with code {returncode}"


def _atomic_write_json(path, payload):
    tmp = f"{path}.tmp"
    with open(tmp, "w") as handle:
        json.dump(payload, handle, indent=2)
    os.replace(tmp, path)
