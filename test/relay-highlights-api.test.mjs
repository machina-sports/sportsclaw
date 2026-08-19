/**
 * Relay highlights job API — typed async job lifecycle contract
 *
 * Exercises the real handlers in docker/relay/relay_server.py (backed by
 * docker/relay/highlights_jobs.py) with a stubbed aiohttp module and a fake
 * SportsClaw CLI, following the same driver pattern as
 * relay-skills-catalog.test.mjs. Covers:
 *
 *   - strict JSON validation with clear 4xx errors (no stack traces);
 *   - fail-closed X-Auth-Token authentication (503 without a server secret,
 *     401 on missing/mismatched tokens, query endpoints untouched);
 *   - bounded retention: terminal-job TTL cleanup at startup and before
 *     creation, storage quota refusal (507), active jobs never deleted,
 *     deletion contained to the jobs root;
 *   - unguessable job IDs;
 *   - media-root allowlisting: traversal, arbitrary host paths and symlink
 *     escapes rejected;
 *   - create/status/cancel/artifacts lifecycle with file-backed persistence
 *     and relay-restart visibility;
 *   - cancellation terminates the subprocess and lands in a terminal state;
 *   - bounded queue/concurrency (configurable via env);
 *   - the relay invokes the typed `highlights run` subcommand (same core as
 *     the CLI) with argv, never a shell;
 *   - artifacts return metadata/paths, never base64 video;
 *   - the pre-existing query endpoints stay registered.
 */

import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const relayDir = join(repoRoot, "docker/relay");
const PYTHON = process.env.PYTHON_PATH || "python3";
const TEST_TOKEN = "test-highlights-token-0123456789";

// --- Fake SportsClaw CLI ------------------------------------------------------
// Stands in for `node /app/dist/index.js`. Records argv, then behaves per
// FAKE_CLI_MODE: "success" writes a manifest to --output, "sleep" blocks (for
// cancellation/queue tests), "fail" exits nonzero.

const FAKE_CLI = `
import json, os, subprocess, sys, time

argv_log = os.environ.get("FAKE_ARGV_LOG")
if argv_log:
    with open(argv_log, "a") as handle:
        handle.write(json.dumps(sys.argv[1:]) + "\\n")

env_log = os.environ.get("FAKE_ENV_LOG")
if env_log:
    with open(env_log, "a") as handle:
        handle.write(json.dumps({
            "HIGHLIGHTS_MAX_JOB_OUTPUT_BYTES":
                os.environ.get("HIGHLIGHTS_MAX_JOB_OUTPUT_BYTES"),
        }) + "\\n")

args = sys.argv[1:]
req_path = args[args.index("--request") + 1]
out_path = args[args.index("--output") + 1]

mode = os.environ.get("FAKE_CLI_MODE", "success")

if mode == "sleep":
    # Mirror the real topology: relay -> Node CLI -> FFmpeg. The grandchild
    # must die with the job on cancel/timeout, not just this parent.
    grandchild = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(120)"]
    )
    pid_file = os.environ.get("FAKE_PID_FILE")
    if pid_file:
        with open(pid_file, "a") as handle:
            handle.write(json.dumps(
                {"parent": os.getpid(), "grandchild": grandchild.pid}
            ) + "\\n")
    time.sleep(120)
    sys.exit(0)

if mode == "fail":
    with open(out_path, "w") as handle:
        json.dump({"state": "failed", "error": "synthetic failure"}, handle)
    sys.exit(1)

with open(req_path) as handle:
    request = json.load(handle)

os.makedirs(request["outputDir"], exist_ok=True)
clips = []
for i, action in enumerate(request["actions"]):
    clip_path = os.path.join(request["outputDir"], f"clip_{i + 1}.mp4")
    with open(clip_path, "wb") as handle:
        handle.write(b"synthetic-clip-bytes")
    clips.append({
        "actionId": action["actionId"],
        "provenance": action["provenance"],
        "file": clip_path,
        "startSec": 0, "endSec": 5, "durationSec": 5,
        "ffprobe": {"durationSec": 5, "formatName": "mov,mp4"},
    })
manifest = {
    "version": 1, "state": "succeeded",
    "event": request["event"], "rights": request["rights"],
    "source": dict(request["source"], ffprobe={"durationSec": 60, "formatName": "mov,mp4"}),
    "windows": [], "clips": clips,
}
with open(out_path, "w") as handle:
    json.dump(manifest, handle)
`;

// --- Scenario driver ----------------------------------------------------------
// Stubs aiohttp, imports relay_server, and runs one named scenario against the
// real handlers. Prints a single JSON line with the scenario result.

const DRIVER = `
import asyncio, json, os, sys, time, types


class _Response:
    def __init__(self, data, status=200):
        self.data = data
        self.status = status


class _Router:
    def __init__(self):
        self.routes = []

    def add_get(self, path, handler):
        self.routes.append(("GET", path, handler))

    def add_post(self, path, handler):
        self.routes.append(("POST", path, handler))


class _Application(dict):
    def __init__(self):
        super().__init__()
        self.router = _Router()


_web = types.SimpleNamespace(
    Request=object,
    Response=_Response,
    StreamResponse=object,
    Application=_Application,
    json_response=lambda data, status=200: _Response(data, status),
    run_app=None,
)
_aiohttp = types.ModuleType("aiohttp")
_aiohttp.web = _web
sys.modules["aiohttp"] = _aiohttp

sys.path.insert(0, sys.argv[1])
import relay_server


def auth_headers():
    return {"X-Auth-Token": os.environ.get("HIGHLIGHTS_API_TOKEN", "")}


class Req:
    def __init__(self, app, body=None, match_info=None, raw=None, headers=None):
        self.app = app
        self._body = body
        self._raw = raw
        self.match_info = match_info or {}
        self.headers = auth_headers() if headers is None else headers

    async def json(self):
        if self._raw is not None:
            return json.loads(self._raw)
        return self._body


def handler_for(app, method, path):
    for m, p, h in app.router.routes:
        if m == method and p == path:
            return h
    raise SystemExit(f"route not registered: {method} {path}")


def valid_body(**overrides):
    body = {
        "source_path": "match.mp4",
        "event": {"provider": "espn", "sport": "football", "event_id": "401234567"},
        "rights": {
            "rights_holder": "Machina Test League",
            "license_ref": "license/test-2026-001",
            "cleared_for_clipping": True,
        },
        "actions": [{
            "action_id": "a1", "provider": "espn", "period": 1,
            "clock": {"semantics": "elapsed-ascending", "elapsed_sec": 10},
            "label": "Goal", "type": "goal", "importance": 90,
            "provenance": "espn:pbp:401234567:a1",
        }],
        "sync_anchor": {"video_sec": 2, "clock_sec": 0},
        "window": {"pre_roll_sec": 3, "post_roll_sec": 4, "max_candidates": 5},
    }
    body.update(overrides)
    return body


async def create(app, body=None, raw=None, headers=None):
    handler = handler_for(app, "POST", "/api/highlights/jobs")
    return await handler(Req(app, body=body, raw=raw, headers=headers))


async def status(app, job_id, headers=None):
    handler = handler_for(app, "GET", "/api/highlights/jobs/{job_id}")
    return await handler(Req(app, match_info={"job_id": job_id}, headers=headers))


async def cancel(app, job_id, headers=None):
    handler = handler_for(app, "POST", "/api/highlights/jobs/{job_id}/cancel")
    return await handler(Req(app, match_info={"job_id": job_id}, headers=headers))


async def artifacts(app, job_id, headers=None):
    handler = handler_for(app, "GET", "/api/highlights/jobs/{job_id}/artifacts")
    return await handler(Req(app, match_info={"job_id": job_id}, headers=headers))


async def wait_state(app, job_id, states, timeout=20.0):
    deadline = time.monotonic() + timeout
    data = None
    while time.monotonic() < deadline:
        resp = await status(app, job_id)
        data = resp.data
        if data.get("state") in states:
            return data
        await asyncio.sleep(0.05)
    return data


def out(payload):
    print(json.dumps(payload))


def plant_job(jobs_root, job_id, state, updated_at, extra_bytes=0):
    path = os.path.join(jobs_root, job_id)
    os.makedirs(path, exist_ok=True)
    with open(os.path.join(path, "job.json"), "w") as handle:
        json.dump({"job_id": job_id, "state": state,
                   "created_at": updated_at, "updated_at": updated_at,
                   "error": None}, handle)
    if extra_bytes:
        with open(os.path.join(path, "blob.bin"), "wb") as handle:
            handle.write(b"x" * extra_bytes)
    return path


async def scenario_routes():
    app = relay_server.create_app()
    out({"routes": [[m, p] for m, p, _ in app.router.routes]})


async def scenario_validation():
    app = relay_server.create_app()
    results = []

    async def check(name, body=None, raw=None):
        resp = await create(app, body=body, raw=raw)
        results.append({
            "name": name,
            "status": resp.status,
            "error": resp.data.get("error", ""),
        })

    await check("invalid-json", raw="{nope")
    await check("non-object", raw="[1, 2, 3]")
    missing_rights = valid_body()
    del missing_rights["rights"]
    await check("missing-rights", body=missing_rights)
    await check("unknown-key", body=valid_body(surprise=1))
    await check("uncleared-rights", body=valid_body(rights={
        "rights_holder": "x", "license_ref": "y", "cleared_for_clipping": False,
    }))
    await check("unsupported-clock", body=valid_body(actions=[{
        "action_id": "a1", "provider": "espn", "period": 1,
        "clock": {"semantics": "countdown", "elapsed_sec": 10},
        "label": "Goal", "type": "goal", "provenance": "espn:pbp:1:a1",
    }]))
    await check("empty-actions", body=valid_body(actions=[]))
    missing_anchor = valid_body()
    del missing_anchor["sync_anchor"]
    await check("missing-sync-anchor", body=missing_anchor)
    await check("traversal", body=valid_body(source_path="../../etc/passwd"))
    await check("absolute-escape", body=valid_body(source_path="/etc/passwd"))
    await check("symlink-escape", body=valid_body(source_path="escape-link.mp4"))
    await check("missing-media", body=valid_body(source_path="ghost.mp4"))
    out({"results": results})


async def scenario_lifecycle():
    app = relay_server.create_app()
    created = await create(app, body=valid_body())
    job_id = created.data.get("job_id")
    final = await wait_state(app, job_id, ("succeeded", "failed", "canceled"))
    arts = await artifacts(app, job_id)
    missing = await status(app, "nonexistent-job-id")
    missing_arts = await artifacts(app, "nonexistent-job-id")

    # Relay restart: a fresh app instance must still see the job from disk.
    app2 = relay_server.create_app()
    persisted = await status(app2, job_id)

    jobs_root = os.environ["HIGHLIGHTS_JOBS_ROOT"]
    job_json = os.path.join(jobs_root, job_id, "job.json")

    # Every returned clip must exist as a regular file inside the job's
    # clips directory.
    clips_dir = os.path.realpath(os.path.join(jobs_root, job_id, "clips"))
    clip_checks = []
    for clip in (arts.data.get("manifest") or {}).get("clips", []):
        real = os.path.realpath(clip.get("file", ""))
        clip_checks.append({
            "is_file": os.path.isfile(real),
            "contained": os.path.dirname(real) == clips_dir,
        })

    out({
        "create_status": created.status,
        "create_state": created.data.get("state"),
        "job_id": job_id,
        "final": final,
        "artifacts_status": arts.status,
        "artifacts": arts.data,
        "clip_checks": clip_checks,
        "missing_status": missing.status,
        "missing_artifacts_status": missing_arts.status,
        "persisted_after_restart": persisted.data,
        "job_json_exists": os.path.exists(job_json),
    })


async def scenario_orphan():
    # A job left non-terminal on disk by a dead relay must surface honestly.
    import datetime
    jobs_root = os.environ["HIGHLIGHTS_JOBS_ROOT"]
    fresh = datetime.datetime.now(datetime.timezone.utc).isoformat()
    os.makedirs(os.path.join(jobs_root, "orphan-job-1234567890"), exist_ok=True)
    with open(os.path.join(jobs_root, "orphan-job-1234567890", "job.json"), "w") as handle:
        json.dump({"job_id": "orphan-job-1234567890", "state": "running",
                   "created_at": fresh, "updated_at": fresh}, handle)
    app = relay_server.create_app()
    resp = await status(app, "orphan-job-1234567890")
    out({"status": resp.status, "job": resp.data})


async def read_pid_entry(pid_file, timeout=10.0):
    # Wait until the fake CLI has recorded itself AND its grandchild, so the
    # kill happens against the full parent->grandchild tree.
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pid_file and os.path.exists(pid_file):
            lines = [l for l in open(pid_file).read().splitlines() if l.strip()]
            if lines:
                return json.loads(lines[-1])
        await asyncio.sleep(0.05)
    return None


async def wait_pids_dead(pids, timeout=10.0):
    # Returns the subset of pids still alive after the deadline (zombies that
    # were reaped count as dead).
    deadline = time.monotonic() + timeout
    alive = list(pids)
    while alive and time.monotonic() < deadline:
        remaining = []
        for pid in alive:
            try:
                os.kill(pid, 0)
                remaining.append(pid)
            except ProcessLookupError:
                pass
        alive = remaining
        if alive:
            await asyncio.sleep(0.05)
    return alive


async def scenario_cancel():
    app = relay_server.create_app()
    created = await create(app, body=valid_body())
    job_id = created.data.get("job_id")
    await wait_state(app, job_id, ("running",))
    pid_file = os.environ.get("FAKE_PID_FILE")
    pid_entry = await read_pid_entry(pid_file)
    cancelled = await cancel(app, job_id)
    final = await wait_state(app, job_id, ("succeeded", "failed", "canceled"))

    # The subprocess AND its grandchild must be gone after cancellation.
    parent_alive = None
    grandchild_alive = None
    if pid_entry:
        still_alive = await wait_pids_dead([pid_entry["parent"], pid_entry["grandchild"]])
        parent_alive = pid_entry["parent"] in still_alive
        grandchild_alive = pid_entry["grandchild"] in still_alive

    arts = await artifacts(app, job_id)
    cancel_again = await cancel(app, job_id)
    out({
        "cancel_status": cancelled.status,
        "final_state": final.get("state"),
        "pid_recorded": pid_entry is not None,
        "pid_alive": parent_alive,
        "grandchild_alive": grandchild_alive,
        "artifacts_status_after_cancel": arts.status,
        "cancel_idempotent_status": cancel_again.status,
        "cancel_idempotent_state": cancel_again.data.get("state"),
    })


async def scenario_cancel_during_spawn():
    # Deterministic race: cancel() lands while _run() is awaiting
    # create_subprocess_exec, before the process is registered in _procs.
    # Cancellation must wait for the spawn attempt to finish and the whole
    # process tree must still die.
    import highlights_jobs
    app = relay_server.create_app()
    real_spawn = asyncio.create_subprocess_exec
    spawn_entered = asyncio.Event()
    release_spawn = asyncio.Event()

    async def delayed_spawn(*args, **kwargs):
        spawn_entered.set()
        await release_spawn.wait()
        proc = await real_spawn(*args, **kwargs)
        # Hand the process back only after the fake CLI has recorded its full
        # parent+grandchild tree, so the kill is provably against live pids.
        await read_pid_entry(os.environ.get("FAKE_PID_FILE"))
        return proc

    highlights_jobs.asyncio.create_subprocess_exec = delayed_spawn
    try:
        created = await create(app, body=valid_body())
        job_id = created.data["job_id"]
        await asyncio.wait_for(spawn_entered.wait(), timeout=10)
        # The runner is now suspended inside the (stalled) spawn call.
        cancel_task = asyncio.create_task(cancel(app, job_id))
        await asyncio.sleep(0.2)
        cancel_returned_early = cancel_task.done()
        release_spawn.set()
        cancelled = await asyncio.wait_for(cancel_task, timeout=30)
    finally:
        highlights_jobs.asyncio.create_subprocess_exec = real_spawn

    final = await wait_state(app, job_id, ("succeeded", "failed", "canceled"))
    pid_entry = await read_pid_entry(os.environ.get("FAKE_PID_FILE"))
    parent_alive = None
    grandchild_alive = None
    if pid_entry:
        still_alive = await wait_pids_dead([pid_entry["parent"], pid_entry["grandchild"]])
        parent_alive = pid_entry["parent"] in still_alive
        grandchild_alive = pid_entry["grandchild"] in still_alive
    out({
        "cancel_status": cancelled.status,
        "cancel_returned_early": cancel_returned_early,
        "final_state": final.get("state"),
        "pid_recorded": pid_entry is not None,
        "pid_alive": parent_alive,
        "grandchild_alive": grandchild_alive,
    })


async def scenario_timeout():
    # HIGHLIGHTS_JOB_TIMEOUT is set low by the test; the sleeping job (and its
    # grandchild) must be killed and the job must land failed, not hang.
    app = relay_server.create_app()
    created = await create(app, body=valid_body())
    job_id = created.data.get("job_id")
    pid_entry = await read_pid_entry(os.environ.get("FAKE_PID_FILE"))
    final = await wait_state(app, job_id, ("succeeded", "failed", "canceled"), timeout=30.0)

    parent_alive = None
    grandchild_alive = None
    if pid_entry:
        still_alive = await wait_pids_dead([pid_entry["parent"], pid_entry["grandchild"]])
        parent_alive = pid_entry["parent"] in still_alive
        grandchild_alive = pid_entry["grandchild"] in still_alive

    out({
        "final_state": final.get("state"),
        "error": final.get("error", ""),
        "pid_recorded": pid_entry is not None,
        "pid_alive": parent_alive,
        "grandchild_alive": grandchild_alive,
    })


async def scenario_artifacts_tampered():
    # artifacts() must only ever hand out manifest clip paths that resolve
    # inside the job's clips directory and exist as regular files. Anything
    # else (tampered manifest, deleted clip, symlink escape) is a safe 500.
    app = relay_server.create_app()
    jobs_root = os.environ["HIGHLIGHTS_JOBS_ROOT"]
    secret = os.path.abspath(os.path.join(jobs_root, os.pardir, "secret-outside.mp4"))
    with open(secret, "w") as handle:
        handle.write("secret")

    def tamper_absolute(manifest, job_dir):
        manifest["clips"][0]["file"] = "/etc/passwd"

    def tamper_relative_escape(manifest, job_dir):
        manifest["clips"][0]["file"] = os.path.join(job_dir, "clips", "..", "..", "..", "secret-outside.mp4")

    def tamper_missing(manifest, job_dir):
        manifest["clips"][0]["file"] = os.path.join(job_dir, "clips", "ghost.mp4")

    def tamper_symlink(manifest, job_dir):
        link = os.path.join(job_dir, "clips", "sneaky.mp4")
        os.symlink(secret, link)
        manifest["clips"][0]["file"] = link

    def tamper_not_a_list(manifest, job_dir):
        manifest["clips"] = {"file": "/etc/passwd"}

    results = {}
    for name, tamper in [
        ("absolute-escape", tamper_absolute),
        ("relative-escape", tamper_relative_escape),
        ("missing-clip", tamper_missing),
        ("symlink-escape", tamper_symlink),
        ("clips-not-a-list", tamper_not_a_list),
    ]:
        created = await create(app, body=valid_body())
        job_id = created.data["job_id"]
        final = await wait_state(app, job_id, ("succeeded", "failed", "canceled"))
        job_dir = os.path.join(jobs_root, job_id)
        output_path = os.path.join(job_dir, "output.json")
        with open(output_path) as handle:
            manifest = json.load(handle)
        tamper(manifest, job_dir)
        with open(output_path, "w") as handle:
            json.dump(manifest, handle)
        resp = await artifacts(app, job_id)
        results[name] = {
            "pre_state": final.get("state"),
            "status": resp.status,
            "error": resp.data.get("error", ""),
            "body": json.dumps(resp.data),
        }

    out({"results": results, "secret": secret})


async def scenario_traversal_ids():
    # A crafted job_id must never be joined into a path that escapes
    # HIGHLIGHTS_JOBS_ROOT — whether it arrives as a route value or is already
    # sitting in the in-memory map.
    app = relay_server.create_app()
    jobs_root = os.environ["HIGHLIGHTS_JOBS_ROOT"]

    # Plant a fully-formed job directory OUTSIDE the jobs root that an
    # escaping "../outside-job" ID would land on.
    outside_dir = os.path.abspath(os.path.join(jobs_root, os.pardir, "outside-job"))
    os.makedirs(outside_dir, exist_ok=True)
    with open(os.path.join(outside_dir, "job.json"), "w") as handle:
        json.dump({"job_id": "../outside-job", "state": "succeeded",
                   "created_at": "2026-01-01T00:00:00Z",
                   "updated_at": "2026-01-01T00:00:00Z"}, handle)
    with open(os.path.join(outside_dir, "output.json"), "w") as handle:
        json.dump({"version": 1, "state": "succeeded",
                   "clips": [{"file": "/etc/hosts"}]}, handle)

    results = {}
    for name, call, job_id in [
        ("status-dotdot", status, "../outside-job"),
        ("status-slash", status, "a/../../outside-job"),
        ("status-abs", status, outside_dir),
        ("cancel-dotdot", cancel, "../outside-job"),
        ("artifacts-dotdot", artifacts, "../outside-job"),
    ]:
        resp = await call(app, job_id)
        results[name] = {"status": resp.status, "body": json.dumps(resp.data)}

    # Same crafted ID already present in the in-memory map (e.g. via a bug or
    # a future code path) must still fail closed, never escape the jobs root.
    manager = app["highlights_manager"]
    manager._jobs["../outside-job"] = {
        "job_id": "../outside-job", "state": "succeeded",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z", "error": None,
    }
    for name, call in [("in-memory-status", status),
                       ("in-memory-artifacts", artifacts)]:
        resp = await call(app, "../outside-job")
        results[name] = {"status": resp.status, "body": json.dumps(resp.data)}

    out({"results": results, "outside_dir": outside_dir})


async def scenario_auth():
    # Fail-closed bearer gate: every /api/highlights/* route requires the
    # X-Auth-Token header to match HIGHLIGHTS_API_TOKEN; an unset server
    # secret disables the API entirely. Query endpoints are untouched.
    app = relay_server.create_app()
    token = os.environ["HIGHLIGHTS_API_TOKEN"]
    ghost = "no-such-job-0000000000000000"
    results = {}

    async def probe(name, headers):
        checks = {}
        resp = await create(app, body=valid_body(), headers=headers)
        checks["create"] = {"status": resp.status, "body": json.dumps(resp.data)}
        job_id = resp.data.get("job_id")
        if job_id:
            await wait_state(app, job_id, ("succeeded", "failed", "canceled"))
        for route, call in (("status", status), ("cancel", cancel),
                            ("artifacts", artifacts)):
            r = await call(app, ghost, headers=headers)
            checks[route] = {"status": r.status, "body": json.dumps(r.data)}
        results[name] = checks

    await probe("valid", {"X-Auth-Token": token})
    await probe("missing-header", {})
    await probe("wrong-token", {"X-Auth-Token": token + "x"})
    await probe("empty-token", {"X-Auth-Token": ""})

    # The pre-existing query endpoints must not require the highlights token:
    # an empty body without any auth header still reaches prompt validation.
    for name, path in (("query-no-token", "/api/query"),
                       ("query-sync-no-token", "/api/query/sync")):
        handler = handler_for(app, "POST", path)
        r = await handler(Req(app, body={}, headers={}))
        results[name] = {"status": r.status, "body": json.dumps(r.data)}

    # Unset server secret: fail closed (service unavailable) on every
    # highlights route, even when the caller presents the old token.
    del os.environ["HIGHLIGHTS_API_TOKEN"]
    await probe("secret-unset", {"X-Auth-Token": token})

    out({"results": results, "token": token})


async def scenario_queue():
    app = relay_server.create_app()
    responses = []
    job_ids = []
    for _ in range(3):
        resp = await create(app, body=valid_body())
        responses.append(resp.status)
        if resp.data.get("job_id"):
            job_ids.append(resp.data["job_id"])
    overflow_error = ""
    resp = await create(app, body=valid_body())
    responses.append(resp.status)
    overflow_error = resp.data.get("error", "")
    for job_id in job_ids:
        await cancel(app, job_id)
    for job_id in job_ids:
        await wait_state(app, job_id, ("succeeded", "failed", "canceled"))
    out({"statuses": responses, "overflow_error": overflow_error})


async def scenario_retention_ttl():
    import datetime
    jobs_root = os.environ["HIGHLIGHTS_JOBS_ROOT"]
    OLD = "2020-01-01T00:00:00+00:00"
    fresh = datetime.datetime.now(datetime.timezone.utc).isoformat()

    expired = plant_job(jobs_root, "expired-terminal-000001", "succeeded", OLD)
    kept_fresh = plant_job(jobs_root, "fresh-terminal-00000001", "succeeded", fresh)
    orphan_running = plant_job(jobs_root, "expired-running-000001", "running", OLD)

    # A symlinked entry pointing outside the jobs root: cleanup must never
    # follow it and delete the target.
    outside = os.path.abspath(os.path.join(jobs_root, os.pardir, "retention-outside"))
    os.makedirs(outside, exist_ok=True)
    with open(os.path.join(outside, "job.json"), "w") as handle:
        json.dump({"job_id": "linked-job-0000000001", "state": "succeeded",
                   "created_at": OLD, "updated_at": OLD, "error": None}, handle)
    with open(os.path.join(outside, "keep.bin"), "wb") as handle:
        handle.write(b"keep-me")
    os.symlink(outside, os.path.join(jobs_root, "linked-job-0000000001"))

    app = relay_server.create_app()  # manager startup runs cleanup
    after_startup = {
        "expired_removed": not os.path.exists(expired),
        "fresh_kept": os.path.exists(kept_fresh),
        "orphan_running_removed": not os.path.exists(orphan_running),
        "outside_intact": os.path.isfile(os.path.join(outside, "keep.bin"))
                          and os.path.isfile(os.path.join(outside, "job.json")),
    }

    # Cleanup must also run before job creation, and an expired terminal job
    # must be scrubbed from disk AND the in-memory maps/task refs.
    manager = app["highlights_manager"]
    created = await create(app, body=valid_body())
    job_id = created.data["job_id"]
    await wait_state(app, job_id, ("succeeded", "failed", "canceled"))
    manager._jobs[job_id]["updated_at"] = OLD
    with open(os.path.join(jobs_root, job_id, "job.json"), "w") as handle:
        json.dump(manager._jobs[job_id], handle)
    expired2 = plant_job(jobs_root, "expired-terminal-000002", "failed", OLD)

    second = await create(app, body=valid_body())
    before_create = {
        "planted_removed": not os.path.exists(expired2),
        "job_dir_removed": not os.path.exists(os.path.join(jobs_root, job_id)),
        "in_memory_removed": job_id not in manager._jobs,
        "task_ref_removed": job_id not in manager._tasks,
    }
    gone = await status(app, job_id)
    second_id = second.data.get("job_id")
    if second_id:
        await wait_state(app, second_id, ("succeeded", "failed", "canceled"))
    out({"after_startup": after_startup, "before_create": before_create,
         "expired_status": gone.status})


async def scenario_retention_quota():
    import datetime
    jobs_root = os.environ["HIGHLIGHTS_JOBS_ROOT"]
    fresh = datetime.datetime.now(datetime.timezone.utc).isoformat()
    blob = plant_job(jobs_root, "fresh-terminal-bigblob1", "succeeded", fresh,
                     extra_bytes=5000)

    app = relay_server.create_app()
    # Storage above quota and nothing eligible for cleanup: refuse creation.
    over = await create(app, body=valid_body())

    # Once the storage hog expires, pre-create cleanup frees the space and
    # creation succeeds again.
    with open(os.path.join(blob, "job.json"), "w") as handle:
        json.dump({"job_id": "fresh-terminal-bigblob1", "state": "succeeded",
                   "created_at": "2020-01-01T00:00:00+00:00",
                   "updated_at": "2020-01-01T00:00:00+00:00", "error": None}, handle)
    ok = await create(app, body=valid_body())
    ok_id = ok.data.get("job_id")
    if ok_id:
        await wait_state(app, ok_id, ("succeeded", "failed", "canceled"))
    out({
        "over_status": over.status,
        "over_error": over.data.get("error", ""),
        "over_body": json.dumps(over.data),
        "hog_removed": not os.path.exists(blob),
        "ok_status": ok.status,
    })


async def scenario_retention_active():
    jobs_root = os.environ["HIGHLIGHTS_JOBS_ROOT"]
    OLD = "2020-01-01T00:00:00+00:00"
    app = relay_server.create_app()
    manager = app["highlights_manager"]

    running = await create(app, body=valid_body())
    running_id = running.data["job_id"]
    await wait_state(app, running_id, ("running",))
    queued = await create(app, body=valid_body())
    queued_id = queued.data["job_id"]

    # Backdate both far past the TTL — queued/running jobs must never be
    # deleted, no matter how old they look.
    for job_id in (running_id, queued_id):
        manager._jobs[job_id]["updated_at"] = OLD
        with open(os.path.join(jobs_root, job_id, "job.json"), "w") as handle:
            json.dump(manager._jobs[job_id], handle)
    expired = plant_job(jobs_root, "expired-terminal-000003", "canceled", OLD)

    third = await create(app, body=valid_body())  # triggers pre-create cleanup
    third_id = third.data.get("job_id")

    survived = {
        "cleanup_ran": not os.path.exists(expired),
        "running_dir_kept": os.path.exists(os.path.join(jobs_root, running_id)),
        "queued_dir_kept": os.path.exists(os.path.join(jobs_root, queued_id)),
        "running_state": manager._jobs.get(running_id, {}).get("state"),
        "queued_state": manager._jobs.get(queued_id, {}).get("state"),
    }
    for job_id in (running_id, queued_id, third_id):
        if job_id:
            await cancel(app, job_id)
            await wait_state(app, job_id, ("succeeded", "failed", "canceled"))
    out(survived)


async def scenario_ids():
    app = relay_server.create_app()
    a = await create(app, body=valid_body())
    b = await create(app, body=valid_body())
    ids = [a.data.get("job_id"), b.data.get("job_id")]
    for job_id in ids:
        await wait_state(app, job_id, ("succeeded", "failed", "canceled"))
    out({"ids": ids})


async def scenario_job_budget():
    # The manager's per-job output budget must never exceed the global storage
    # quota, and the clamped value must reach the job subprocess environment.
    import highlights_jobs
    app = relay_server.create_app()
    manager = app["highlights_manager"]
    created = await create(app, body=valid_body())
    job_id = created.data.get("job_id")
    final = await wait_state(app, job_id, ("succeeded", "failed", "canceled"))
    out({
        "create_status": created.status,
        "final_state": final.get("state"),
        "manager_budget": manager.max_job_output_bytes,
        "manager_storage": manager.max_storage_bytes,
        "default_budget": highlights_jobs.DEFAULT_MAX_JOB_OUTPUT_BYTES,
    })


async def scenario_job_budget_default():
    # Same checks with no configured budget: the finite default must apply.
    os.environ.pop("HIGHLIGHTS_MAX_JOB_OUTPUT_BYTES", None)
    await scenario_job_budget()


async def scenario_concurrent_storage_admission():
    # Start both admissions in the same event-loop turn. The admission lock
    # must serialize the storage+reservation check so only one can win.
    app = relay_server.create_app()
    responses = await asyncio.gather(
        create(app, body=valid_body()),
        create(app, body=valid_body()),
    )
    accepted = [r.data.get("job_id") for r in responses if r.status == 202]
    for job_id in accepted:
        await cancel(app, job_id)
        await wait_state(app, job_id, ("succeeded", "failed", "canceled"))
    out({
        "statuses": sorted(r.status for r in responses),
        "errors": [r.data.get("error", "") for r in responses],
        "workspace_count": len([
            name for name in os.listdir(os.environ["HIGHLIGHTS_JOBS_ROOT"])
            if os.path.isdir(os.path.join(os.environ["HIGHLIGHTS_JOBS_ROOT"], name))
        ]),
    })


async def scenario_startup_reconciliation():
    import datetime
    jobs_root = os.environ["HIGHLIGHTS_JOBS_ROOT"]
    OLD = "2020-01-01T00:00:00+00:00"
    fresh = datetime.datetime.now(datetime.timezone.utc).isoformat()
    stale = plant_job(jobs_root, "restart-stale-queued01", "queued", OLD)
    interrupted = plant_job(jobs_root, "restart-fresh-running1", "running", fresh)
    terminal = plant_job(jobs_root, "restart-terminal-job1", "succeeded", fresh)

    app = relay_server.create_app()
    # Inspect disk directly: no status lookup may be needed to reconcile or
    # TTL-clean a previous instance's non-terminal jobs.
    with open(os.path.join(interrupted, "job.json")) as handle:
        interrupted_record = json.load(handle)
    with open(os.path.join(terminal, "job.json")) as handle:
        terminal_record = json.load(handle)

    # Re-running reconciliation after this instance has live jobs must not
    # mistake its queued/running records for restart orphans.
    running = await create(app, body=valid_body())
    running_id = running.data["job_id"]
    await wait_state(app, running_id, ("running",))
    queued = await create(app, body=valid_body())
    queued_id = queued.data["job_id"]
    manager = app["highlights_manager"]
    manager._reconcile_persisted_jobs()
    live_states = {
        "running": manager._jobs[running_id]["state"],
        "queued": manager._jobs[queued_id]["state"],
    }
    for job_id in (running_id, queued_id):
        await cancel(app, job_id)
        await wait_state(app, job_id, ("succeeded", "failed", "canceled"))

    out({
        "stale_removed": not os.path.exists(stale),
        "interrupted_state": interrupted_record.get("state"),
        "interrupted_error": interrupted_record.get("error", ""),
        "terminal_state": terminal_record.get("state"),
        "terminal_error": terminal_record.get("error"),
        "live_states": live_states,
    })


SCENARIOS = {
    "routes": scenario_routes,
    "validation": scenario_validation,
    "lifecycle": scenario_lifecycle,
    "orphan": scenario_orphan,
    "cancel": scenario_cancel,
    "cancel_during_spawn": scenario_cancel_during_spawn,
    "timeout": scenario_timeout,
    "traversal_ids": scenario_traversal_ids,
    "artifacts_tampered": scenario_artifacts_tampered,
    "auth": scenario_auth,
    "queue": scenario_queue,
    "retention_ttl": scenario_retention_ttl,
    "retention_quota": scenario_retention_quota,
    "retention_active": scenario_retention_active,
    "ids": scenario_ids,
    "job_budget": scenario_job_budget,
    "job_budget_default": scenario_job_budget_default,
    "concurrent_storage_admission": scenario_concurrent_storage_admission,
    "startup_reconciliation": scenario_startup_reconciliation,
}

asyncio.run(SCENARIOS[sys.argv[2]]())
`;

let workDir;
let driverPath;
let fakeCliPath;

function freshRoots(name) {
  const jobsRoot = join(workDir, `${name}-jobs`);
  const mediaRoot = join(workDir, `${name}-media`);
  mkdirSync(jobsRoot, { recursive: true });
  mkdirSync(mediaRoot, { recursive: true });
  writeFileSync(join(mediaRoot, "match.mp4"), "not-really-video", "utf-8");
  // A symlink inside the media root pointing outside of it.
  const outside = join(workDir, `${name}-outside.mp4`);
  writeFileSync(outside, "outside", "utf-8");
  symlinkSync(outside, join(mediaRoot, "escape-link.mp4"));
  return { jobsRoot, mediaRoot };
}

function runScenario(scenario, { jobsRoot, mediaRoot, env = {} }) {
  const run = spawnSync(PYTHON, [driverPath, relayDir, scenario], {
    encoding: "utf-8",
    timeout: 120_000,
    env: {
      ...process.env,
      SPORTSCLAW_BIN: PYTHON,
      SPORTSCLAW_ENTRY: fakeCliPath,
      HIGHLIGHTS_JOBS_ROOT: jobsRoot,
      HIGHLIGHTS_MEDIA_ROOT: mediaRoot,
      HIGHLIGHTS_MAX_CONCURRENCY: "1",
      HIGHLIGHTS_MAX_QUEUE: "8",
      HIGHLIGHTS_API_TOKEN: TEST_TOKEN,
      ...env,
    },
  });
  assert.equal(
    run.status,
    0,
    `scenario ${scenario} driver must exit cleanly:\n${run.stdout ?? ""}\n${run.stderr ?? ""}`
  );
  const lines = run.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

before(() => {
  workDir = mkdtempSync(join(tmpdir(), "sportsclaw-relay-highlights-"));
  driverPath = join(workDir, "driver_jobs.py");
  fakeCliPath = join(workDir, "fake_cli.py");
  writeFileSync(driverPath, DRIVER, "utf-8");
  writeFileSync(fakeCliPath, FAKE_CLI, "utf-8");
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe("relay route registration", () => {
  it("registers the highlights job API alongside the existing query endpoints", () => {
    const { routes } = runScenario("routes", freshRoots("routes"));
    const flat = routes.map(([m, p]) => `${m} ${p}`);
    for (const expected of [
      "GET /health",
      "GET /api/skills",
      "POST /api/query",
      "POST /api/query/sync",
      "POST /api/highlights/jobs",
      "GET /api/highlights/jobs/{job_id}",
      "POST /api/highlights/jobs/{job_id}/cancel",
      "GET /api/highlights/jobs/{job_id}/artifacts",
    ]) {
      assert.ok(flat.includes(expected), `route must be registered: ${expected} (got ${flat})`);
    }
  });
});

// ---------------------------------------------------------------------------
// Strict validation + path allowlisting
// ---------------------------------------------------------------------------

describe("relay highlights job validation", () => {
  const roots = () => freshRoots(`validation-${Math.random().toString(36).slice(2, 8)}`);

  it("rejects malformed and non-conforming payloads with clear 4xx errors", () => {
    const { results } = runScenario("validation", roots());
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));

    assert.equal(byName["invalid-json"].status, 400);
    assert.match(byName["invalid-json"].error, /json/i);
    assert.equal(byName["non-object"].status, 400);
    assert.equal(byName["missing-rights"].status, 400);
    assert.match(byName["missing-rights"].error, /rights/);
    assert.equal(byName["unknown-key"].status, 400);
    assert.match(byName["unknown-key"].error, /surprise/);
    assert.equal(byName["uncleared-rights"].status, 400);
    assert.match(byName["uncleared-rights"].error, /cleared/i);
    assert.equal(byName["unsupported-clock"].status, 400);
    assert.match(byName["unsupported-clock"].error, /elapsed-ascending/);
    assert.equal(byName["empty-actions"].status, 400);
    assert.equal(byName["missing-sync-anchor"].status, 400);
    assert.match(byName["missing-sync-anchor"].error, /sync_anchor/);

    for (const r of results) {
      assert.ok(!/Traceback/.test(r.error), `no stack traces in errors: ${r.name}`);
    }
  });

  it("rejects traversal, arbitrary host paths, and symlink escapes", () => {
    const { results } = runScenario("validation", roots());
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));

    assert.equal(byName["traversal"].status, 400);
    assert.match(byName["traversal"].error, /media root|allowlist/i);
    assert.equal(byName["absolute-escape"].status, 400);
    assert.match(byName["absolute-escape"].error, /media root|allowlist/i);
    assert.equal(byName["symlink-escape"].status, 400);
    assert.equal(byName["missing-media"].status, 400);
  });

  it("never joins a crafted job ID into a path that escapes the jobs root", () => {
    const { results, outside_dir } = runScenario("traversal_ids", roots());

    for (const [name, r] of Object.entries(results)) {
      assert.equal(r.status, 404, `${name} must 404, got ${r.status}: ${r.body}`);
      assert.ok(!r.body.includes(outside_dir), `${name} must not leak the escaped path`);
      assert.ok(!r.body.includes("/etc/hosts"), `${name} must not leak planted clip paths`);
    }
  });
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe("relay highlights authentication", () => {
  it("requires a matching X-Auth-Token on every highlights route and fails closed without a server secret", () => {
    const { results, token } = runScenario("auth", freshRoots("auth"));
    const routes = ["create", "status", "cancel", "artifacts"];

    // Valid token: create is accepted; the other routes reach normal 404 lookup.
    assert.equal(results["valid"].create.status, 202);
    for (const route of ["status", "cancel", "artifacts"]) {
      assert.equal(results["valid"][route].status, 404, `valid ${route} must pass auth and 404`);
    }

    for (const name of ["missing-header", "wrong-token", "empty-token"]) {
      for (const route of routes) {
        const r = results[name][route];
        assert.equal(r.status, 401, `${name} ${route} must 401, got ${r.status}: ${r.body}`);
        assert.ok(!r.body.includes(token), `${name} ${route} must never echo the expected token`);
        assert.ok(!/Traceback/.test(r.body), `${name} ${route} must not leak stack traces`);
      }
    }

    // No server secret configured: highlights API is unavailable, fail closed.
    for (const route of routes) {
      const r = results["secret-unset"][route];
      assert.equal(r.status, 503, `secret-unset ${route} must 503, got ${r.status}: ${r.body}`);
      assert.ok(!r.body.includes(token), `secret-unset ${route} must never echo a token`);
    }

    // The existing query endpoints stay token-free (prompt validation, not auth).
    assert.equal(results["query-no-token"].status, 400);
    assert.equal(results["query-sync-no-token"].status, 400);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("relay highlights job lifecycle", () => {
  it("create → status → artifacts, with file-backed persistence and restart visibility", () => {
    const roots = freshRoots("lifecycle");
    const result = runScenario("lifecycle", roots);

    assert.equal(result.create_status, 202);
    assert.ok(result.job_id, "create must return a job_id");
    assert.equal(result.final.state, "succeeded", JSON.stringify(result.final));
    assert.equal(result.job_json_exists, true, "job.json must persist under the job root");

    assert.equal(result.artifacts_status, 200);
    const manifest = result.artifacts.manifest;
    assert.ok(manifest, "artifacts must return the manifest");
    assert.equal(manifest.event.eventId, "401234567");
    assert.equal(manifest.rights.rightsHolder, "Machina Test League");
    assert.ok(manifest.clips.length > 0);
    for (const clip of manifest.clips) {
      assert.ok(clip.file, "artifacts must return file paths/references");
      assert.ok(!("data" in clip), "artifacts must never inline base64 video");
    }
    assert.equal(result.clip_checks.length, manifest.clips.length);
    for (const check of result.clip_checks) {
      assert.equal(check.is_file, true, "every returned clip must exist as a regular file");
      assert.equal(check.contained, true, "every returned clip must live inside the job's clips dir");
    }
    // Nothing in the response may be a large inline payload.
    assert.ok(JSON.stringify(result.artifacts).length < 100_000, "artifact responses stay small");

    assert.equal(result.missing_status, 404);
    assert.equal(result.missing_artifacts_status, 404);
    assert.equal(result.persisted_after_restart.state, "succeeded", "restart must see terminal state from disk");
  });

  it("reports jobs orphaned by a relay restart as terminal, not stuck running", () => {
    const result = runScenario("orphan", freshRoots("orphan"));
    assert.equal(result.status, 200);
    assert.ok(
      ["failed", "canceled"].includes(result.job.state),
      `orphaned job must land terminal, got ${result.job.state}`
    );
    assert.match(result.job.error ?? "", /restart/i);
  });

  it("cancellation terminates the whole process tree and lands in a terminal state", () => {
    const roots = freshRoots("cancel");
    const pidFile = join(workDir, "cancel.pid");
    const result = runScenario("cancel", {
      ...roots,
      env: { FAKE_CLI_MODE: "sleep", FAKE_PID_FILE: pidFile },
    });

    assert.equal(result.cancel_status, 200);
    assert.equal(result.final_state, "canceled");
    assert.equal(result.pid_recorded, true, "the fake CLI must record its process tree");
    assert.equal(result.pid_alive, false, "the job subprocess must be dead after cancel");
    assert.equal(
      result.grandchild_alive,
      false,
      "the grandchild (FFmpeg stand-in) must be dead after cancel — killing only the Node parent leaks it"
    );
    assert.equal(result.artifacts_status_after_cancel, 409, "artifacts for a canceled job must 409");
    assert.equal(result.cancel_idempotent_status, 200, "cancel on a terminal job stays terminal");
    assert.equal(result.cancel_idempotent_state, "canceled");
  });

  it("cancellation during a stalled spawn still kills the whole process tree", () => {
    const roots = freshRoots("cancel-spawn");
    const pidFile = join(workDir, "cancel-spawn.pid");
    const result = runScenario("cancel_during_spawn", {
      ...roots,
      env: { FAKE_CLI_MODE: "sleep", FAKE_PID_FILE: pidFile },
    });

    assert.equal(result.cancel_status, 200);
    assert.equal(
      result.cancel_returned_early,
      false,
      "cancel must wait for the in-flight spawn attempt to finish before returning"
    );
    assert.equal(result.final_state, "canceled");
    assert.equal(result.pid_recorded, true, "the fake CLI must record its process tree");
    assert.equal(result.pid_alive, false, "the just-spawned subprocess must be dead after cancel");
    assert.equal(
      result.grandchild_alive,
      false,
      "the grandchild must be dead — a cancel that raced the spawn must not leak the tree"
    );
  });

  it("timeout kills the whole process tree and lands the job in failed", () => {
    const roots = freshRoots("timeout");
    const pidFile = join(workDir, "timeout.pid");
    const result = runScenario("timeout", {
      ...roots,
      env: {
        FAKE_CLI_MODE: "sleep",
        FAKE_PID_FILE: pidFile,
        HIGHLIGHTS_JOB_TIMEOUT: "2",
      },
    });

    assert.equal(result.final_state, "failed");
    assert.match(result.error, /timed out/i);
    assert.equal(result.pid_recorded, true, "the fake CLI must record its process tree");
    assert.equal(result.pid_alive, false, "the job subprocess must be dead after timeout");
    assert.equal(
      result.grandchild_alive,
      false,
      "the grandchild (FFmpeg stand-in) must be dead after timeout — killing only the Node parent leaks it"
    );
  });

  it("rejects tampered, missing, or escaped manifest clip paths with a safe server error", () => {
    const { results, secret } = runScenario("artifacts_tampered", freshRoots("tampered"));

    for (const [name, r] of Object.entries(results)) {
      assert.equal(r.pre_state, "succeeded", `${name}: job must succeed before tampering`);
      assert.equal(r.status, 500, `${name} must 500, got ${r.status}: ${r.body}`);
      assert.ok(r.error, `${name} must return an error message`);
      assert.ok(!r.body.includes("/etc/passwd"), `${name} must not echo escaped paths`);
      assert.ok(!r.body.includes(secret), `${name} must not expose host paths outside the clips dir`);
      assert.ok(!/Traceback/.test(r.body), `${name} must not leak stack traces`);
    }
  });

  it("bounds queue and concurrency via env configuration", () => {
    const roots = freshRoots("queue");
    const result = runScenario("queue", {
      ...roots,
      env: {
        FAKE_CLI_MODE: "sleep",
        HIGHLIGHTS_MAX_CONCURRENCY: "1",
        HIGHLIGHTS_MAX_QUEUE: "3",
      },
    });

    assert.deepEqual(result.statuses, [202, 202, 202, 429]);
    assert.match(result.overflow_error, /queue|capacity|busy/i);
  });

  it("issues unguessable, unique job IDs", () => {
    const { ids } = runScenario("ids", freshRoots("ids"));
    assert.notEqual(ids[0], ids[1]);
    for (const id of ids) {
      assert.ok(id.length >= 16, `job id must be long enough to be unguessable: ${id}`);
      assert.match(id, /^[A-Za-z0-9_-]+$/, "job id must be URL-safe");
    }
  });
});

// ---------------------------------------------------------------------------
// Retention & storage bounds
// ---------------------------------------------------------------------------

describe("relay highlights retention", () => {
  it("removes expired terminal jobs at startup and before creation, keeps everything else, never follows symlinks", () => {
    const result = runScenario("retention_ttl", {
      ...freshRoots("retention-ttl"),
      env: { HIGHLIGHTS_JOB_TTL_SEC: "3600" },
    });

    assert.equal(result.after_startup.expired_removed, true, "expired terminal job must be deleted at manager startup");
    assert.equal(result.after_startup.fresh_kept, true, "terminal job within the TTL must be kept");
    assert.equal(
      result.after_startup.orphan_running_removed,
      true,
      "an expired non-terminal job from a prior instance must be reconciled then TTL-cleaned"
    );
    assert.equal(result.after_startup.outside_intact, true, "cleanup must never follow a symlink out of the jobs root");

    assert.equal(result.before_create.planted_removed, true, "cleanup must also run before job creation");
    assert.equal(result.before_create.job_dir_removed, true, "an expired terminal job must be removed from disk");
    assert.equal(result.before_create.in_memory_removed, true, "…and from the in-memory job map");
    assert.equal(result.before_create.task_ref_removed, true, "…and its task ref must be dropped");
    assert.equal(result.expired_status, 404, "a cleaned-up job is gone, not resurrected");
  });

  it("rejects creation with a safe 507 while storage stays above quota, recovers after cleanup", () => {
    const roots = freshRoots("retention-quota");
    const result = runScenario("retention_quota", {
      ...roots,
      env: { HIGHLIGHTS_MAX_STORAGE_BYTES: "1000" },
    });

    assert.equal(result.over_status, 507, `over-quota create must 507, got ${result.over_status}: ${result.over_body}`);
    assert.match(result.over_error, /storage|quota/i);
    assert.ok(!result.over_body.includes(roots.jobsRoot), "quota errors must not leak host paths");
    assert.ok(!/Traceback/.test(result.over_body), "quota errors must not leak stack traces");
    assert.equal(result.hog_removed, true, "the expired storage hog must be cleaned up on the next create");
    assert.equal(result.ok_status, 202, "creation must succeed once cleanup frees the space");
  });

  it("clamps the per-job output budget to the global storage quota and injects it into the job env", () => {
    const roots = freshRoots("budget-clamp");
    const envLog = join(workDir, "budget-clamp-env.jsonl");
    const result = runScenario("job_budget", {
      ...roots,
      env: {
        FAKE_ENV_LOG: envLog,
        HIGHLIGHTS_MAX_STORAGE_BYTES: "500000",
        HIGHLIGHTS_MAX_JOB_OUTPUT_BYTES: "900000",
      },
    });

    assert.equal(result.create_status, 202);
    assert.equal(result.final_state, "succeeded");
    assert.equal(result.manager_storage, 500000);
    assert.equal(
      result.manager_budget,
      500000,
      "a configured per-job budget above the global storage quota must be clamped to it"
    );
    const recorded = JSON.parse(readFileSync(envLog, "utf-8").split("\n").filter(Boolean)[0]);
    assert.equal(
      recorded.HIGHLIGHTS_MAX_JOB_OUTPUT_BYTES,
      "500000",
      "the job subprocess must receive the clamped budget in its environment"
    );
  });

  it("applies a finite default per-job budget when none is configured", () => {
    const roots = freshRoots("budget-default");
    const envLog = join(workDir, "budget-default-env.jsonl");
    const result = runScenario("job_budget_default", { ...roots, env: { FAKE_ENV_LOG: envLog } });

    assert.equal(result.final_state, "succeeded");
    assert.ok(
      Number.isSafeInteger(result.default_budget) && result.default_budget > 0,
      "the default per-job budget must be a finite positive byte count"
    );
    assert.equal(
      result.manager_budget,
      Math.min(result.default_budget, result.manager_storage),
      "the effective budget must be the default clamped to the storage quota"
    );
    const recorded = JSON.parse(readFileSync(envLog, "utf-8").split("\n").filter(Boolean)[0]);
    assert.equal(
      recorded.HIGHLIGHTS_MAX_JOB_OUTPUT_BYTES,
      String(result.manager_budget),
      "the job subprocess must receive the effective budget in its environment"
    );
  });

  it("serializes concurrent storage admission and reserves each accepted job budget", () => {
    const result = runScenario("concurrent_storage_admission", {
      ...freshRoots("concurrent-storage"),
      env: {
        FAKE_CLI_MODE: "sleep",
        HIGHLIGHTS_MAX_STORAGE_BYTES: "5000",
        HIGHLIGHTS_MAX_JOB_OUTPUT_BYTES: "3000",
      },
    });

    assert.deepEqual(result.statuses, [202, 507], JSON.stringify(result));
    assert.equal(result.workspace_count, 1, "a rejected admission must not create a workspace");
    assert.ok(result.errors.some((error) => /storage|capacity|quota|reserved/i.test(error)));
  });

  it("reconciles restart orphans at startup before TTL cleanup without touching terminal or live jobs", () => {
    const result = runScenario("startup_reconciliation", {
      ...freshRoots("startup-reconciliation"),
      env: {
        FAKE_CLI_MODE: "sleep",
        HIGHLIGHTS_JOB_TTL_SEC: "3600",
        HIGHLIGHTS_MAX_CONCURRENCY: "1",
      },
    });

    assert.equal(result.stale_removed, true, "expired restart orphan must be removed without a status read");
    assert.equal(result.interrupted_state, "failed");
    assert.match(result.interrupted_error, /restart|interrupt/i);
    assert.equal(result.terminal_state, "succeeded");
    assert.equal(result.terminal_error, null);
    assert.deepEqual(result.live_states, { running: "running", queued: "queued" });
  });

  it("never deletes queued or running jobs, no matter how stale their timestamps look", () => {
    const result = runScenario("retention_active", {
      ...freshRoots("retention-active"),
      env: {
        FAKE_CLI_MODE: "sleep",
        HIGHLIGHTS_JOB_TTL_SEC: "1",
        HIGHLIGHTS_MAX_CONCURRENCY: "1",
      },
    });

    assert.equal(result.cleanup_ran, true, "the planted expired terminal job proves cleanup actually ran");
    assert.equal(result.running_dir_kept, true, "a running job must never be deleted");
    assert.equal(result.queued_dir_kept, true, "a queued job must never be deleted");
    assert.equal(result.running_state, "running");
    assert.equal(result.queued_state, "queued");
  });
});

// ---------------------------------------------------------------------------
// Same core + no shell interpolation (source contract)
// ---------------------------------------------------------------------------

describe("relay execution path contract", () => {
  it("invokes the typed `highlights run` subcommand — the same core as the CLI", () => {
    const roots = freshRoots("argv");
    const argvLog = join(workDir, "argv-log.jsonl");
    runScenario("lifecycle", { ...roots, env: { FAKE_ARGV_LOG: argvLog } });

    const argvLines = readFileSync(argvLog, "utf-8").split("\n").filter(Boolean);
    assert.ok(argvLines.length > 0, "the job must launch the CLI");
    const argv = JSON.parse(argvLines[0]);
    assert.equal(argv[0], "highlights");
    assert.equal(argv[1], "run");
    assert.ok(argv.includes("--request"), "must pass --request <file>");
    assert.ok(argv.includes("--output"), "must pass --output <file>");
  });

  it("never builds shell command strings", () => {
    for (const file of ["relay_server.py", "highlights_jobs.py"]) {
      const source = readFileSync(join(relayDir, file), "utf-8");
      assert.ok(!/create_subprocess_shell/.test(source), `${file}: no shell subprocess`);
      assert.ok(!/shell\s*=\s*True/.test(source), `${file}: no shell=True`);
    }
  });
});
