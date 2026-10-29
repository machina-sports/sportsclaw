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
import math
import os
import re
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

# Alternate Jev typed contract; mirrors src/watch-decision.ts.
DECISION_CONTRACT = "watch-decision-v1"
DECISION_MODEL = "jev-1.14.0"
DECISION_MIN_CONFIDENCE = 0.8
DECISION_MIN_MARGIN = 0.15
_DECISION_LIMITS = {"text": 4000, "candidates": 100, "label": 160, "references": 10}
_DECISION_INTENTS = {"follow", "pause", "resume", "unfollow", "list_takes",
                     "list_following", "none", "clarify"}
_DECISION_STATUSES = {"selected", "no_match", "clarify"}
_DECISION_REASONS = _REASONS - {"unknown_id"}
_OPAQUE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}")


class _Invalid(ValueError):
    """A refused request, tagged with the contract its envelope must carry."""

    def __init__(self, contract: str = CONTRACT):
        super().__init__("invalid")
        self.contract = contract


def watch_intent_enabled(env: dict | None = None) -> bool:
    return (env if env is not None else os.environ).get(ENABLED_ENV, "") == "true"


def worker_path(entry: str) -> str:
    """The worker ships beside the engine entrypoint in the image."""
    return str(Path(entry).resolve().parent / WATCH_INTENT_WORKER_FILENAME)


def _refuse(reason_code: str, status: int, contract: str = CONTRACT) -> web.Response:
    return web.json_response(
        {"contract": contract, "ok": False, "reasonCode": reason_code},
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


def _js_len(text: str) -> int:
    """String length as the worker's JavaScript ``.length`` counts it (UTF-16 units)."""
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def _text(value, limit: int) -> bool:
    return isinstance(value, str) and bool(value.strip()) and _js_len(value) <= limit


def _decision_request(body: dict) -> dict:
    """Exact ``watch-decision-v1`` request, rebuilt in server-owned key order."""
    invalid = _Invalid(DECISION_CONTRACT)
    stage = body.get("stage")
    if stage == "intent":
        keys = ("contract", "stage", "text", "locale")
    elif stage == "target":
        keys = ("contract", "stage", "text", "locale", "candidates") + (
            ("referenceIds",) if "referenceIds" in body else ())
    else:
        raise invalid
    if set(body) != set(keys) or not _text(body["text"], _DECISION_LIMITS["text"]):
        raise invalid
    if not isinstance(body["locale"], str) or body["locale"] not in _LOCALES:
        raise invalid
    out = {"contract": DECISION_CONTRACT, "stage": stage, "text": body["text"], "locale": body["locale"]}
    if stage == "intent":
        return out
    candidates = body["candidates"]
    if not isinstance(candidates, list) or not 1 <= len(candidates) <= _DECISION_LIMITS["candidates"]:
        raise invalid
    ids = []
    for item in candidates:
        if not isinstance(item, dict) or set(item) != {"id", "label"}:
            raise invalid
        cid, label = item["id"], item["label"]
        if not isinstance(cid, str) or not _OPAQUE_ID.fullmatch(cid) or cid in ids:
            raise invalid
        if not _text(label, _DECISION_LIMITS["label"]):
            raise invalid
        ids.append(cid)
    out["candidates"] = [{"id": item["id"], "label": item["label"]} for item in candidates]
    if "referenceIds" in body:
        refs = body["referenceIds"]
        if not isinstance(refs, list) or len(refs) > _DECISION_LIMITS["references"]:
            raise invalid
        if any(not isinstance(r, str) or r not in ids for r in refs) or len(set(refs)) != len(refs):
            raise invalid
        out["referenceIds"] = list(refs)
    return out


def _request_body(raw: bytes) -> tuple[dict, bytes]:
    """The validated request and its forwarded bytes.

    Legacy: exactly the four contract keys. ``watch-decision-v1``: its exact
    schema and bounds. Deep validation is repeated by the worker; this keeps
    anything else in the caller's JSON from ever reaching it. The output is
    compact UTF-8 like the worker's own ``JSON.stringify`` (no ``\\uXXXX``
    expansion of accented text), and the worker's byte cap is enforced on what
    is actually forwarded, not only on the raw read. Refusals raise ``_Invalid``
    carrying the declared contract, legacy when none is recognizable.
    """
    try:
        body = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        raise _Invalid() from exc
    if isinstance(body, dict) and isinstance(body.get("contract"), str) and body["contract"] == DECISION_CONTRACT:
        request = _decision_request(body)
    else:
        if not isinstance(body, dict) or set(body) != set(_REQUEST_KEYS):
            raise _Invalid()
        # Type checks precede set membership: an unhashable locale is invalid, not a TypeError.
        if (body["contract"] != CONTRACT or not isinstance(body["text"], str)
                or not isinstance(body["locale"], str) or body["locale"] not in _LOCALES
                or not isinstance(body["eligible"], dict)):
            raise _Invalid()
        request = {key: body[key] for key in _REQUEST_KEYS}
    try:
        forwarded = json.dumps(
            request, ensure_ascii=False, separators=(",", ":"), allow_nan=False,
        ).encode("utf-8")
    except (UnicodeEncodeError, RecursionError, ValueError) as exc:  # e.g. a lone surrogate escape
        raise _Invalid(request["contract"]) from exc
    if len(forwarded) > MAX_WATCH_INTENT_BODY_BYTES:
        raise _Invalid(request["contract"])
    return request, forwarded


def _unit(value) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("untyped")
    if not 0 <= value <= 1:
        raise ValueError("untyped")
    return value


def _typed_decision(stdout: bytes, request: dict) -> dict:
    """The worker's ``watch-decision-v1`` envelope, checked against the request."""
    result = json.loads(stdout.decode("utf-8"))
    if not isinstance(result, dict) or result.get("contract") != DECISION_CONTRACT:
        raise ValueError("untyped")
    if result.get("ok") is False:
        reason = result.get("reasonCode")
        if set(result) != {"contract", "ok", "reasonCode"} or not isinstance(reason, str) \
                or reason not in _DECISION_REASONS:
            raise ValueError("untyped")
        return {"contract": DECISION_CONTRACT, "ok": False, "reasonCode": reason}
    if result.get("ok") is not True:
        raise ValueError("untyped")
    stage = request["stage"]
    field = "intent" if stage == "intent" else "selection"
    if set(result) != {"contract", "ok", "stage", field, "model", "confidence", "margin"}:
        raise ValueError("untyped")
    if result["stage"] != stage or result["model"] != DECISION_MODEL:
        raise ValueError("untyped")
    confidence, margin = _unit(result["confidence"]), _unit(result["margin"])
    if stage == "intent":
        value = result["intent"]
        if not isinstance(value, str) or value not in _DECISION_INTENTS:
            raise ValueError("untyped")
        # Ordinary chat grants no watch action, so it needs no action threshold.
        decided = value not in ("clarify", "none")
    else:
        selection = result["selection"]
        if not isinstance(selection, dict) or set(selection) != {"status", "targetId"}:
            raise ValueError("untyped")
        status, target_id = selection["status"], selection["targetId"]
        if not isinstance(status, str) or status not in _DECISION_STATUSES:
            raise ValueError("untyped")
        if status == "selected":
            if not isinstance(target_id, str) or target_id not in {c["id"] for c in request["candidates"]}:
                raise ValueError("untyped")
        elif target_id is not None:
            raise ValueError("untyped")
        value = {"status": status, "targetId": target_id}
        decided = status != "clarify"
    # A decided outcome below the policy gates is not a valid worker answer.
    if decided and (confidence < DECISION_MIN_CONFIDENCE or margin < DECISION_MIN_MARGIN):
        raise ValueError("untyped")
    return {"contract": DECISION_CONTRACT, "ok": True, "stage": stage, field: value,
            "model": DECISION_MODEL, "confidence": confidence, "margin": margin}


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
            parsed, body = _request_body(raw)
        except _Invalid as exc:
            return _refuse("invalid_request", 400, exc.contract)
        contract = parsed["contract"]

        app = request.app
        # No await between inspection and increment: admission is atomic on the
        # event loop and shared with /api/query and /api/decide.
        if app.get("active_queries", 0) >= max_concurrency:
            return _refuse("inference_unavailable", 429, contract)
        app["active_queries"] = app.get("active_queries", 0) + 1
        try:
            stdout, _stderr, returncode = await buffered(command, build_env(), timeout, body)
        except asyncio.TimeoutError:
            return _refuse("timeout", 504, contract)
        except (ValueError, OSError):
            return _refuse("inference_unavailable", 502, contract)
        finally:
            app["active_queries"] -= 1

        if returncode != 0:
            return _refuse("inference_unavailable", 502, contract)
        try:
            result = (_typed_decision(stdout, parsed) if contract == DECISION_CONTRACT
                      else _typed_result(stdout))
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError, KeyError, TypeError):
            return _refuse("invalid_response", 502, contract)
        # A typed refusal is a successful transaction with an unsuccessful
        # outcome: the caller MUST inspect `ok` rather than the HTTP status.
        return web.json_response(result, headers=dict(_NO_STORE))

    return watch_intent


def register_watch_intent_routes(app, **kwargs) -> None:
    app.router.add_post(WATCH_INTENT_ROUTE, make_watch_intent_handler(**kwargs))
