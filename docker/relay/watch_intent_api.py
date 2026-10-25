"""POST /api/watch-intent — authenticated, bounded watch-intent interpretation.

A fixed-purpose seam for the shared-watch coordinator: one natural-language
request plus the caller's eligible take/subscription IDs in, one typed
``watch-intent-v1`` intent out. It never starts the SportsClaw CLI, MCP, memory
or tools: it spawns one short-lived Node worker (``watch-intent-relay.js``, a
neighbour of the engine entrypoint) that runs a single unified-inference call.

The caller supplies exactly ``contract``, ``text``, ``locale`` and
``eligible``. Provider, model, endpoint, credentials, tools, history and
timeouts are server configuration and cannot be set from the request; the
worker environment is ``build_env()`` with no request input.

Off unless SPORTSCLAW_WATCH_INTENT_ENABLED is exactly ``true``. Authentication
runs before the flag check, the body read or a concurrency slot. Nothing about
a request, an answer or a child error is logged, and every non-auth response is
the typed envelope with ``Cache-Control: no-store``.
"""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

from aiohttp import web

from query_runtime import buffered

CONTRACT = "watch-intent-v1"
WATCH_INTENT_ROUTE = "/api/watch-intent"
ENABLED_ENV = "SPORTSCLAW_WATCH_INTENT_ENABLED"
# Mirrors MAX_WATCH_INTENT_BODY_BYTES in src/watch-intent-relay.ts.
MAX_WATCH_INTENT_BODY_BYTES = 32 * 1024
# Outlives the worker's own 8s model deadline; this is only the backstop.
WATCH_INTENT_PROCESS_TIMEOUT_SEC = 12
BODY_READ_TIMEOUT_SEC = 5
WATCH_INTENT_WORKER_FILENAME = "watch-intent-relay.js"

_NO_STORE = {"Cache-Control": "no-store"}
_REQUEST_KEYS = ("contract", "text", "locale", "eligible")
_LOCALES = {"en", "pt", "es"}
_ACTIONS = {"follow", "pause", "resume", "unfollow", "list_takes",
            "list_following", "none", "ambiguous", "unsupported"}
_REASONS = {"invalid_request", "invalid_response", "unknown_id",
            "inference_unavailable", "timeout", "aborted", "disabled"}


def watch_intent_enabled(env: dict | None = None) -> bool:
    return (env if env is not None else os.environ).get(ENABLED_ENV, "") == "true"


def worker_path(entry: str) -> str:
    """The worker ships beside the engine entrypoint in the image."""
    return str(Path(entry).resolve().parent / WATCH_INTENT_WORKER_FILENAME)


def _refuse(reason_code: str, status: int) -> web.Response:
    return web.json_response(
        {"contract": CONTRACT, "ok": False, "reasonCode": reason_code},
        status=status, headers=dict(_NO_STORE),
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


def _request_body(raw: bytes) -> bytes:
    """Exactly the four contract keys, re-serialized in server-owned order.

    Deep validation (bounds, IDs, labels) is repeated by the worker; this keeps
    anything else in the caller's JSON from ever reaching it. The output is
    compact UTF-8 like the worker's own ``JSON.stringify`` (no ``\\uXXXX``
    expansion of accented text), and the worker's byte cap is enforced on what
    is actually forwarded, not only on the raw read.
    """
    try:
        body = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        raise ValueError("invalid") from exc
    if not isinstance(body, dict) or set(body) != set(_REQUEST_KEYS):
        raise ValueError("invalid")
    # Type checks precede set membership: an unhashable locale is invalid, not a TypeError.
    if (body["contract"] != CONTRACT or not isinstance(body["text"], str)
            or not isinstance(body["locale"], str) or body["locale"] not in _LOCALES
            or not isinstance(body["eligible"], dict)):
        raise ValueError("invalid")
    try:
        forwarded = json.dumps(
            {key: body[key] for key in _REQUEST_KEYS},
            ensure_ascii=False, separators=(",", ":"), allow_nan=False,
        ).encode("utf-8")
    except (UnicodeEncodeError, RecursionError) as exc:  # e.g. a lone surrogate escape
        raise ValueError("invalid") from exc
    if len(forwarded) > MAX_WATCH_INTENT_BODY_BYTES:
        raise ValueError("invalid")
    return forwarded


def _typed_result(stdout: bytes) -> dict:
    """The worker's single typed envelope, or a raise for anything else."""
    result = json.loads(stdout.decode("utf-8"))
    if not isinstance(result, dict) or result.get("contract") != CONTRACT:
        raise ValueError("untyped")
    if result.get("ok") is True:
        intent = result.get("intent")
        if set(result) != {"contract", "ok", "intent"} or not isinstance(intent, dict):
            raise ValueError("untyped")
        if set(intent) != {"action", "targetId"} or intent["action"] not in _ACTIONS:
            raise ValueError("untyped")
        if intent["targetId"] is not None and not isinstance(intent["targetId"], str):
            raise ValueError("untyped")
        return {"contract": CONTRACT, "ok": True,
                "intent": {"action": intent["action"], "targetId": intent["targetId"]}}
    if result.get("ok") is False:
        if set(result) != {"contract", "ok", "reasonCode"} or result["reasonCode"] not in _REASONS:
            raise ValueError("untyped")
        return {"contract": CONTRACT, "ok": False, "reasonCode": result["reasonCode"]}
    raise ValueError("untyped")


def make_watch_intent_handler(
    *,
    auth_error,
    node_bin: str,
    entry: str,
    build_env,
    max_concurrency: int,
    timeout: int = WATCH_INTENT_PROCESS_TIMEOUT_SEC,
):
    """Build the /api/watch-intent handler from the relay's existing primitives."""
    command = [node_bin, worker_path(entry)]

    async def watch_intent(request: web.Request) -> web.Response:
        denied = auth_error(request)
        if denied is not None:
            denied.headers["Cache-Control"] = "no-store"
            return denied
        if not watch_intent_enabled():
            return _refuse("disabled", 503)

        try:
            raw = await asyncio.wait_for(
                _read_bounded(request, MAX_WATCH_INTENT_BODY_BYTES), timeout=BODY_READ_TIMEOUT_SEC)
        except asyncio.TimeoutError:
            return _refuse("invalid_request", 408)
        if raw is None:
            return _refuse("invalid_request", 413)
        try:
            body = _request_body(raw)
        except ValueError:
            return _refuse("invalid_request", 400)

        app = request.app
        # No await between inspection and increment: admission is atomic on the
        # event loop and shared with /api/query and /api/decide.
        if app.get("active_queries", 0) >= max_concurrency:
            return _refuse("inference_unavailable", 429)
        app["active_queries"] = app.get("active_queries", 0) + 1
        try:
            stdout, _stderr, returncode = await buffered(command, build_env(), timeout, body)
        except asyncio.TimeoutError:
            return _refuse("timeout", 504)
        except (ValueError, OSError):
            return _refuse("inference_unavailable", 502)
        finally:
            app["active_queries"] -= 1

        if returncode != 0:
            return _refuse("inference_unavailable", 502)
        try:
            result = _typed_result(stdout)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, KeyError):
            return _refuse("invalid_response", 502)
        # A typed refusal is a successful transaction with an unsuccessful
        # outcome: the caller MUST inspect `ok` rather than the HTTP status.
        return web.json_response(result, headers=dict(_NO_STORE))

    return watch_intent


def register_watch_intent_routes(app, **kwargs) -> None:
    app.router.add_post(WATCH_INTENT_ROUTE, make_watch_intent_handler(**kwargs))
