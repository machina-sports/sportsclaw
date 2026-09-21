"""POST /api/decide — authenticated, bounded typed-decision passthrough.

The relay already runs a generative engine; this is not it. A decision request
never starts the SportsClaw CLI, MCP, memory or a generative model: it spawns a
single short-lived Node worker (``decision-relay.js``, a neighbour of the engine
entrypoint) that reads the body on stdin and writes one typed result on stdout.

Everything except the body is server configuration. The caller supplies exactly
``state`` and ``questions``; transport, provider, model, credential, data policy
and timeouts are fixed here and cannot be set from the request.

The endpoint is authenticated with the same token gate as the rest of the relay
API and stays disabled until cloud egress is explicitly opted into, so a default
deployment exposes it as unavailable rather than as a working egress path.

Nothing about a request, an answer or a child error is logged: a decision body
is caller data and a provider error is not a public protocol.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

from aiohttp import web

from query_runtime import buffered

# Mirrors MAX_RELAY_BODY_BYTES in src/decision-relay.ts. The worker enforces the
# same bound again; this one keeps an oversized body from ever being buffered.
MAX_DECISION_BODY_BYTES = 32 * 1024
# Outlives the worker's own 8s decision deadline, so a normal timeout is
# reported by the worker as a typed result and this is only the backstop.
DECISION_PROCESS_TIMEOUT_SEC = 10
DECISION_WORKER_FILENAME = "decision-relay.js"
DATA_POLICY_ENV = "SPORTSCLAW_DECISION_DATA_POLICY"
DECISION_ROUTE = "/api/decide"

_NO_STORE = {"Cache-Control": "no-store"}


def data_policy(env: dict | None = None) -> str:
    """Server-side cloud consent. Anything unrecognized is `local_only`."""
    value = (env if env is not None else os.environ).get(DATA_POLICY_ENV, "")
    return "cloud_allowed" if value == "cloud_allowed" else "local_only"


def decision_enabled(env: dict | None = None) -> bool:
    return data_policy(env) == "cloud_allowed"


def worker_path(entry: str) -> str:
    """The decision worker ships beside the engine entrypoint in the image."""
    return str(Path(entry).resolve().parent / DECISION_WORKER_FILENAME)


def _error(message: str, status: int) -> web.Response:
    return web.json_response(
        {"status": False, "error": message}, status=status, headers=dict(_NO_STORE)
    )


async def _read_bounded(request, limit: int) -> bytes | None:
    """Stream the body with a hard cap; `None` means the cap was exceeded."""
    declared = request.content_length
    if declared is not None and declared > limit:
        return None
    chunks, total = [], 0
    while True:
        chunk = await request.content.readany()
        if not chunk:
            return b"".join(chunks)
        total += len(chunk)
        if total > limit:
            return None
        chunks.append(chunk)


def _decision_body(raw: bytes) -> bytes:
    """Accept a JSON object carrying exactly `state` and `questions`.

    Re-serialized from the two recognized fields, so nothing else in the
    caller's JSON can reach the worker even if a future parser were laxer.
    """
    try:
        body = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("request body must be a JSON object") from exc
    if not isinstance(body, dict):
        raise ValueError("request body must be a JSON object")
    if set(body) != {"state", "questions"}:
        raise ValueError("request body must contain exactly state and questions")
    return json.dumps({"state": body["state"], "questions": body["questions"]}).encode()


def _typed_result(stdout: bytes) -> dict:
    """The worker's single-line typed result, or a raise for anything else."""
    result = json.loads(stdout.decode("utf-8"))
    if not isinstance(result, dict) or not isinstance(result.get("ok"), bool):
        raise ValueError("untyped worker output")
    if not isinstance(result.get("receipt"), dict):
        raise ValueError("untyped worker output")
    if result["ok"] and (not isinstance(result.get("answers"), dict) or not isinstance(result.get("model"), str)):
        raise ValueError("untyped worker output")
    if not result["ok"] and not isinstance(result.get("reasonCode"), str):
        raise ValueError("untyped worker output")
    return result


def make_decision_handler(
    *,
    auth_error,
    node_bin: str,
    entry: str,
    build_env,
    max_concurrency: int,
    timeout: int = DECISION_PROCESS_TIMEOUT_SEC,
):
    """Build the /api/decide handler from the relay's existing primitives."""
    command = [node_bin, worker_path(entry)]

    async def decide(request: web.Request) -> web.Response:
        denied = auth_error(request)
        if denied is not None:
            denied.headers["Cache-Control"] = "no-store"
            return denied
        if not decision_enabled():
            return _error("decision API is disabled by data policy", 503)

        try:
            raw = await asyncio.wait_for(_read_bounded(request, MAX_DECISION_BODY_BYTES), timeout=5)
        except asyncio.TimeoutError:
            return _error("request body timed out", 408)
        if raw is None:
            return _error(
                f"request body exceeds {MAX_DECISION_BODY_BYTES} bytes", 413
            )
        try:
            body = _decision_body(raw)
        except ValueError as error:
            return _error(str(error), 400)

        app = request.app
        # No await between inspection and increment: admission is atomic on the
        # event loop, matching the existing query guard.
        if app.get("active_queries", 0) >= max_concurrency:
            return _error("query capacity exhausted", 429)
        app["active_queries"] = app.get("active_queries", 0) + 1
        try:
            stdout, _stderr, returncode = await buffered(
                command, build_env(), timeout, body
            )
        except asyncio.TimeoutError:
            return _error("decision timed out", 504)
        except (ValueError, OSError):
            return _error("decision failed", 502)
        finally:
            app["active_queries"] -= 1

        if returncode != 0:
            return _error("decision failed", 502)
        try:
            result = _typed_result(stdout)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            return _error("decision failed", 502)
        # A typed refusal is a successful transaction with an unsuccessful
        # outcome: the caller MUST inspect `ok` rather than the HTTP status.
        return web.json_response(result, headers=dict(_NO_STORE))

    return decide


def register_decision_routes(app, **kwargs) -> None:
    app.router.add_post(DECISION_ROUTE, make_decision_handler(**kwargs))
