from __future__ import annotations

"""
sportsclaw-relay — HTTP bridge for headless SportsClaw execution.

Exposes the SportsClaw engine over HTTP so any client (web app, mobile,
Discord bot, Slack integration) can send sports queries and receive
structured responses.

The engine emits NDJSON events on stdout when piped (non-TTY):
    {"type": "start", ...}
    {"type": "progress", ...}    (tool_start, tool_finish, phase, synthesizing)
    {"type": "result", "text": "..."}
    {"type": "error", "error": "..."}

This relay forwards those events directly to the HTTP client.

Endpoints:
    GET  /health           → {"status": "ok", "service": "sportsclaw-relay"}
    GET  /api/skills       → List installed sport schemas
    POST /api/query        → Streaming NDJSON response (real-time progress)
    POST /api/query/sync   → Buffered JSON response (waits for result)
    GET  /api/agents       → List native agents
    POST /api/agents       → Create a native agent
    GET  /api/agents/{id}  → Get a native agent
    PATCH /api/agents/{id} → Update or inactivate a native agent
    POST /api/agents/delegate → One-hop query delegated to another native agent
    POST /api/highlights/jobs                     → Create a typed highlights job
    GET  /api/highlights/jobs/{job_id}            → Job status
    POST /api/highlights/jobs/{job_id}/cancel     → Cancel a job (terminal state)
    GET  /api/highlights/jobs/{job_id}/artifacts  → Manifest + clip paths (no base64)

Query body:
    {
        "prompt": "Who won the Super Bowl?",
        "user_id": "discord-12345",        // optional, enables memory
        "provider": "anthropic",           // optional, override provider
        "model": "claude-sonnet-4-5-...",  // optional, override model
        "agent_id": "analyst",             // optional, exact native agent
        "verbose": false                   // optional, enable debug output
    }
"""

import asyncio
import json
import os
import re
import secrets
import time
from functools import wraps
from pathlib import Path

from aiohttp import web

from skills_catalog import parse_catalog
from query_runtime import buffered, process, MAX_OUTPUT_BYTES
from highlights_jobs import (
    DEFAULT_JOB_TTL_SEC,
    DEFAULT_MAX_JOB_OUTPUT_BYTES,
    DEFAULT_MAX_STORAGE_BYTES,
    HighlightsJobManager,
    JobError,
)


PORT = int(os.environ.get("RELAY_PORT", 8080))
SPORTSCLAW_BIN = os.environ.get("SPORTSCLAW_BIN", "node")
SPORTSCLAW_ENTRY = os.environ.get("SPORTSCLAW_ENTRY", "/app/dist/index.js")
DEFAULT_TIMEOUT = int(os.environ.get("RELAY_TIMEOUT", 180))
MAX_QUERY_TIMEOUT = int(os.environ.get("RELAY_MAX_QUERY_TIMEOUT", 300))
MAX_QUERY_CONCURRENCY = int(os.environ.get("RELAY_MAX_QUERY_CONCURRENCY", 4))
MAX_PROMPT_CHARS = 20000
if not 1 <= DEFAULT_TIMEOUT <= MAX_QUERY_TIMEOUT or MAX_QUERY_CONCURRENCY < 1:
    raise ValueError("invalid relay query limits")
AGENT_ID_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
AGENTS_AUTH_HEADER = "X-Auth-Token"


def log(msg: str) -> None:
    print(f"[sportsclaw-relay] {msg}", flush=True)


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

async def health(request: web.Request) -> web.Response:
    """Lightweight liveness probe — no subprocess, instant response."""
    return web.json_response({
        "status": "ok",
        "service": "sportsclaw-relay",
    })


# ---------------------------------------------------------------------------
# List installed skills
# ---------------------------------------------------------------------------

async def list_skills(request: web.Request) -> web.Response:
    """
    Return the installed catalog as a flat list of schema/module names.

    Reads the CLI's structured `list --json` output. Human output is categorized
    prose, so the old line scrape matched nothing and reported a successful empty
    catalog; a nonzero exit or an unparseable payload is now an error instead.
    """
    try:
        stdout, _stderr, returncode = await buffered(
            [SPORTSCLAW_BIN, SPORTSCLAW_ENTRY, "list", "--json"], _build_env(), 10)
        skills = parse_catalog(stdout.decode(), returncode)
        return web.json_response({"status": True, "skills": skills})
    except Exception as e:
        # Only the parser's own message is surfaced — child stderr is never
        # forwarded to the client.
        log(f"skills: {e}")
        return web.json_response(
            {"status": False, "error": str(e)}, status=500
        )


# ---------------------------------------------------------------------------
# Native agents
# ---------------------------------------------------------------------------

class AgentApiError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _agents_auth_error(request: web.Request) -> web.Response | None:
    expected = os.environ.get("AGENTS_API_TOKEN", "")
    if not expected:
        return web.json_response(
            {"status": False, "error": "relay API is unavailable — no API token is configured"},
            status=503,
        )
    supplied = request.headers.get(AGENTS_AUTH_HEADER, "")
    if not supplied or not secrets.compare_digest(
        supplied.encode("utf-8"), expected.encode("utf-8")
    ):
        return web.json_response(
            {"status": False, "error": f"invalid or missing {AGENTS_AUTH_HEADER}"},
            status=401,
        )
    return None


def _query_agent_auth_error(
    request: web.Request, body: dict
) -> web.Response | None:
    """Every query uses the same trusted caller boundary, including auto-routing."""
    return _agents_auth_error(request)


def query_guard(handler):
    @wraps(handler)
    async def guarded(request):
        denied = _agents_auth_error(request)
        if denied is not None:
            return denied
        try:
            body = await request.json()
            if not isinstance(body, dict):
                raise ValueError("request body must be an object")
            prompt = body.get("prompt")
            if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > MAX_PROMPT_CHARS:
                raise ValueError(f"prompt must contain 1-{MAX_PROMPT_CHARS} characters")
            timeout = body.get("timeout", DEFAULT_TIMEOUT)
            if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= MAX_QUERY_TIMEOUT:
                raise ValueError(f"timeout must be an integer between 1 and {MAX_QUERY_TIMEOUT}")
            if body.get("history_mode", "engine") not in ("caller", "engine"):
                raise ValueError("history_mode must be caller or engine")
            for key in ("user_id", "provider", "model", "system_prompt", "format", "api_key"):
                if key in body and (not isinstance(body[key], str) or len(body[key]) > MAX_PROMPT_CHARS):
                    raise ValueError(f"invalid {key}")
        except (ValueError, TypeError) as error:
            return web.json_response({"status": False, "error": str(error)}, status=400)
        app = request.app
        # No await between inspection and increment: admission is atomic on the event loop.
        if app.get("active_queries", 0) >= MAX_QUERY_CONCURRENCY:
            return web.json_response({"status": False, "error": "query capacity exhausted"}, status=429)
        app["active_queries"] = app.get("active_queries", 0) + 1
        try:
            return await handler(request)
        finally:
            app["active_queries"] -= 1
    return guarded


async def capabilities(request):
    denied = _agents_auth_error(request)
    if denied is not None:
        return denied
    try:
        stdout, _, code = await buffered(
            [SPORTSCLAW_BIN, SPORTSCLAW_ENTRY, "list", "--json"], _build_env(), 10)
        skills = parse_catalog(stdout.decode(), code)
        package = json.loads((Path(SPORTSCLAW_ENTRY).resolve().parent.parent / "package.json").read_text())
        configs = json.loads(os.environ.get("SPORTSCLAW_MCP_SERVERS", "{}"))
        mcp = [{"server": name, "allowed_tools": config.get("tools") or None,
                "policy": "allowlist" if config.get("tools") else "all_discovered"}
               for name, config in configs.items()]
        return web.json_response({
            "protocol_version": "1.0", "engine_version": package["version"],
            "build_revision": os.environ.get("SPORTSCLAW_BUILD_REVISION"),
            "skills": skills, "mcp_servers": mcp,
            "history_modes": ["engine", "caller"],
            "query": {"default_timeout_seconds": DEFAULT_TIMEOUT,
                      "max_timeout_seconds": MAX_QUERY_TIMEOUT,
                      "max_concurrency": MAX_QUERY_CONCURRENCY,
                      "max_prompt_characters": MAX_PROMPT_CHARS,
                      "max_output_bytes": MAX_OUTPUT_BYTES},
        })
    except Exception:
        return web.json_response({"status": False, "error": "capability discovery unavailable"}, status=503)


def _validate_agent_id(agent_id: object) -> str:
    if (not isinstance(agent_id, str) or not agent_id
            or len(agent_id) > 64 or not AGENT_ID_PATTERN.fullmatch(agent_id)):
        raise AgentApiError(
            "invalid agent_id: expected a lowercase slug using letters, numbers, and single hyphens"
        )
    return agent_id


def _validate_agent_payload(body: object, *, create: bool) -> dict:
    if not isinstance(body, dict):
        raise AgentApiError("request body must be a JSON object")
    allowed = {"id", "name", "title", "body", "skills", "tags"} if create else {
        "name", "title", "body", "skills", "tags", "active"
    }
    unknown = set(body) - allowed
    if unknown:
        raise AgentApiError(f"unsupported agent fields: {', '.join(sorted(unknown))}")
    if create:
        _validate_agent_id(body.get("id"))
        for required in ("name", "body"):
            if required not in body:
                raise AgentApiError(f"{required} is required")
    if "name" in body:
        name = body["name"]
        if (not isinstance(name, str) or not name or len(name) > 80
                or name != name.strip() or any(ord(ch) < 32 for ch in name)):
            raise AgentApiError("invalid agent name")
    if "title" in body:
        title = body["title"]
        if (not isinstance(title, str) or len(title) > 120
                or title != title.strip()
                or any(ord(ch) < 32 or ord(ch) == 127 for ch in title)):
            raise AgentApiError("invalid agent title")
    if "body" in body:
        text = body["body"]
        if (not isinstance(text, str) or not text.strip()
                or len(text) > 100_000 or "\0" in text):
            raise AgentApiError("invalid agent body")
    for field in ("skills", "tags"):
        if field not in body:
            continue
        values = body[field]
        if not isinstance(values, list) or len(values) > 64:
            raise AgentApiError(f"invalid agent {field}")
        if any(not isinstance(value, str)
               or len(value) > 64
               or not AGENT_ID_PATTERN.fullmatch(value)
               for value in values):
            raise AgentApiError(f"invalid agent {field}")
        if len(values) != len(set(values)):
            raise AgentApiError(f"invalid agent {field}: duplicate values")
    if "active" in body and not isinstance(body["active"], bool):
        raise AgentApiError("invalid agent active status: expected a boolean")
    return body


async def _read_json_object(request: web.Request) -> dict:
    try:
        body = await request.json()
    except Exception as exc:
        raise AgentApiError("request body must be valid JSON") from exc
    if not isinstance(body, dict):
        raise AgentApiError("request body must be a JSON object")
    return body


async def _run_agent_cli(args: list[str], payload: dict | None = None):
    cmd = [SPORTSCLAW_BIN, SPORTSCLAW_ENTRY, "agents", *args, "--json"]
    stdin = json.dumps(payload).encode() if payload is not None else None
    try:
        stdout, stderr, returncode = await buffered(cmd, _build_env(), 10, stdin)
    except asyncio.TimeoutError as exc:
        raise AgentApiError("agent operation timed out", 504) from exc
    if returncode != 0:
        detail = stderr.decode().strip().splitlines()
        message = detail[-1] if detail else "agent operation failed"
        status = 404 if "not found" in message.lower() else 409 if "exists" in message.lower() else 400
        raise AgentApiError(message, status)
    try:
        result = json.loads(stdout.decode())
        return result["data"]
    except (json.JSONDecodeError, KeyError, TypeError) as exc:
        raise AgentApiError("agent operation returned an invalid response", 500) from exc


def _agent_error_response(error: Exception) -> web.Response:
    status = error.status if isinstance(error, AgentApiError) else 500
    message = str(error) if isinstance(error, AgentApiError) else "internal error"
    return web.json_response({"status": False, "error": message}, status=status)


async def agents_list(request: web.Request) -> web.Response:
    denied = _agents_auth_error(request)
    if denied is not None:
        return denied
    try:
        agents = await _run_agent_cli(["list", "--all"])
        return web.json_response({"status": True, "agents": agents})
    except Exception as error:
        return _agent_error_response(error)


async def agents_get(request: web.Request) -> web.Response:
    denied = _agents_auth_error(request)
    if denied is not None:
        return denied
    try:
        agent_id = _validate_agent_id(request.match_info.get("agent_id"))
        agent = await _run_agent_cli(["get", agent_id])
        return web.json_response({"status": True, "agent": agent})
    except Exception as error:
        return _agent_error_response(error)


async def agents_create(request: web.Request) -> web.Response:
    denied = _agents_auth_error(request)
    if denied is not None:
        return denied
    try:
        body = _validate_agent_payload(await _read_json_object(request), create=True)
        agent = await _run_agent_cli(["create"], body)
        return web.json_response({"status": True, "agent": agent}, status=201)
    except Exception as error:
        return _agent_error_response(error)


async def agents_patch(request: web.Request) -> web.Response:
    denied = _agents_auth_error(request)
    if denied is not None:
        return denied
    try:
        agent_id = _validate_agent_id(request.match_info.get("agent_id"))
        body = _validate_agent_payload(await _read_json_object(request), create=False)
        if "active" in body:
            if len(body) != 1 or body["active"] is not False:
                raise AgentApiError("active may only be set to false as a standalone inactivation")
            agent = await _run_agent_cli(["inactivate", agent_id])
        else:
            if not body:
                raise AgentApiError("at least one update field is required")
            agent = await _run_agent_cli(["update", agent_id], body)
        return web.json_response({"status": True, "agent": agent})
    except Exception as error:
        return _agent_error_response(error)


def _build_delegated_body(body: object) -> dict:
    if not isinstance(body, dict):
        raise AgentApiError("request body must be a JSON object")
    forbidden = {"system_prompt", "delegation_depth", "delegated", "source_chain"}
    if forbidden.intersection(body):
        raise AgentApiError("recursive delegation and delegated system_prompt are not allowed")
    prompt = body.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise AgentApiError("prompt is required")
    source_id = _validate_agent_id(body.get("source_agent_id"))
    target_id = _validate_agent_id(body.get("agent_id"))
    if source_id == target_id:
        raise AgentApiError("self-delegation is not allowed")
    delegated = {"prompt": prompt, "agent_id": target_id, "_delegated": True}
    for key in ("user_id", "provider", "model", "verbose", "format", "timeout", "api_key", "history_mode"):
        if key in body:
            delegated[key] = body[key]
    return delegated


class _DelegatedRequest:
    def __init__(self, body: dict, headers, app=None):
        self._body = body
        self.headers = headers
        self.app = app if app is not None else {}

    async def json(self) -> dict:
        return self._body


async def agents_delegate(request: web.Request) -> web.Response:
    denied = _agents_auth_error(request)
    if denied is not None:
        return denied
    try:
        original = await _read_json_object(request)
        delegated = _build_delegated_body(original)
        source = await _run_agent_cli(["get", original["source_agent_id"]])
        target = await _run_agent_cli(["get", delegated["agent_id"]])
        if not source.get("active"):
            raise AgentApiError(f'Agent "{source["id"]}" is inactive', 403)
        if not target.get("active"):
            raise AgentApiError(f'Agent "{target["id"]}" is inactive', 403)
        return await query_sync(_DelegatedRequest(delegated, request.headers, request.app))
    except Exception as error:
        return _agent_error_response(error)


async def _require_active_query_agent(body: dict) -> None:
    if body.get("agent_id") is None:
        return
    agent_id = _validate_agent_id(body["agent_id"])
    agent = await _run_agent_cli(["get", agent_id])
    if not agent.get("active"):
        raise AgentApiError(f'Agent "{agent_id}" is inactive', 403)


# ---------------------------------------------------------------------------
# Query — streaming NDJSON (forwards engine events in real-time)
# ---------------------------------------------------------------------------

@query_guard
async def query_stream(request: web.Request) -> web.StreamResponse:
    """
    Execute a SportsClaw query and stream NDJSON events in real-time.

    The engine emits structured NDJSON on stdout (pipe mode). This handler
    forwards each event line directly to the HTTP client, giving consumers
    real-time visibility into routing, tool calls, and the final result.
    """
    body = await request.json()
    prompt = body.get("prompt")
    if not prompt:
        return web.json_response(
            {"status": False, "error": "prompt is required"}, status=400
        )

    user_id = body.get("user_id", "api-anonymous")
    timeout = body.get("timeout", DEFAULT_TIMEOUT)

    denied = _query_agent_auth_error(request, body)
    if denied is not None:
        return denied

    try:
        await _require_active_query_agent(body)
    except Exception as error:
        return _agent_error_response(error)

    cmd = _build_cmd(body)
    env = _build_env(body)

    log(f"stream: user={user_id} prompt={prompt[:80]}")

    response = web.StreamResponse(
        status=200,
        headers={
            "Content-Type": "application/x-ndjson",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
    await response.prepare(request)

    try:
        async with process(cmd, env) as (proc, stderr):
            async def stream_stdout():
                size = 0
                async for line in proc.stdout:
                    size += len(line)
                    if size > MAX_OUTPUT_BYTES:
                        raise ValueError("query output exceeds configured limit")
                    decoded = line.decode(errors="replace").rstrip("\n")
                    if not decoded:
                        continue
                    try:
                        event = json.loads(decoded)
                        if not isinstance(event, dict):
                            continue
                        event["user_id"] = user_id
                        await response.write(json.dumps(event).encode() + b"\n")
                    except json.JSONDecodeError:
                        # Child diagnostics are not a public protocol or credential-safe output.
                        continue
                await proc.wait()
                await stderr
            await asyncio.wait_for(stream_stdout(), timeout=timeout)
            if proc.returncode != 0:
                await response.write(json.dumps({
                    "type": "error", "error": "Query engine failed",
                    "returncode": proc.returncode,
                }).encode() + b"\n")

    except asyncio.TimeoutError:
        await response.write(json.dumps({
            "type": "error",
            "error": f"Query timed out after {timeout}s",
        }).encode() + b"\n")
    except (ConnectionResetError, asyncio.CancelledError):
        raise
    except (ValueError, OSError):
        await response.write(json.dumps({"type": "error", "error": "Query engine failed"}).encode() + b"\n")

    await response.write_eof()
    return response


# ---------------------------------------------------------------------------
# Query — synchronous (buffered) response
# ---------------------------------------------------------------------------

@query_guard
async def query_sync(request: web.Request) -> web.Response:
    """
    Execute a SportsClaw query and return a single JSON response.

    Parses the engine's NDJSON output and extracts the result event.
    """
    body = await request.json()
    prompt = body.get("prompt")
    if not prompt:
        return web.json_response(
            {"status": False, "error": "prompt is required"}, status=400
        )

    user_id = body.get("user_id", "api-anonymous")
    timeout = body.get("timeout", DEFAULT_TIMEOUT)

    denied = _query_agent_auth_error(request, body)
    if denied is not None:
        return denied

    try:
        await _require_active_query_agent(body)
    except Exception as error:
        return _agent_error_response(error)

    cmd = _build_cmd(body)
    env = _build_env(body)
    started_at = time.monotonic()

    log(f"sync: user={user_id} prompt={prompt[:80]}")

    try:
        stdout_bytes, stderr_bytes, returncode = await buffered(cmd, env, timeout)
        elapsed_ms = int((time.monotonic() - started_at) * 1000)

        stdout_text = stdout_bytes.decode() if stdout_bytes else ""
        stderr_text = stderr_bytes.decode().strip() if stderr_bytes else ""

        log(f"sync: stdout={len(stdout_bytes)} bytes, "
            f"stderr={len(stderr_bytes)} bytes, "
            f"exit={returncode}")

        # Parse NDJSON lines from engine output
        result_text = None
        error_text = None
        images = []
        videos = []
        line_num = 0
        parse_failures = 0

        for raw_line in stdout_text.split("\n"):
            decoded = raw_line.strip()
            if not decoded:
                continue
            line_num += 1
            try:
                event = json.loads(decoded)
                if not isinstance(event, dict):
                    parse_failures += 1
                    continue
                etype = event.get("type")
                if etype == "result":
                    result_text = event.get("text", "")
                elif etype == "error":
                    error_text = event.get("error", "Unknown error")
                elif etype == "image":
                    images.append({
                        "data": event.get("data", ""),
                        "mimeType": event.get("mimeType", "image/png"),
                        "prompt": event.get("prompt", ""),
                    })
                    log(f"sync: parsed image event, "
                        f"data length={len(event.get('data', ''))}")
                elif etype == "video":
                    videos.append({
                        "data": event.get("data", ""),
                        "mimeType": event.get("mimeType", "video/mp4"),
                        "prompt": event.get("prompt", ""),
                    })
                else:
                    log(f"sync: line {line_num} type={etype}")
            except json.JSONDecodeError as exc:
                parse_failures += 1
                log(f"sync: line {line_num} PARSE FAIL "
                    f"len={len(decoded)} err={exc}")
                continue

        if parse_failures:
            log(f"sync: {parse_failures} NDJSON line(s) failed to parse")

        if error_text or returncode != 0:
            return web.json_response({
                "status": False,
                "error": error_text or "Query engine failed",
                "user_id": user_id,
                "elapsed_ms": elapsed_ms,
            }, status=500)

        if result_text is not None:
            resp = {
                "status": True,
                "text": result_text,
                "user_id": user_id,
                "elapsed_ms": elapsed_ms,
            }
            if images:
                resp["images"] = images
                log(f"sync: returning {len(images)} image(s)")
            if videos:
                resp["videos"] = videos
                log(f"sync: returning {len(videos)} video(s)")
            return web.json_response(resp)

        # Fallback: no result event parsed
        log(f"sync: no result event found in {line_num} lines")
        if returncode == 0:
            return web.json_response({
                "status": False,
                "error": "Query completed without a result event",
                "user_id": user_id,
                "elapsed_ms": elapsed_ms,
            }, status=502)
        else:
            return web.json_response({
                "status": False,
                "error": "Query engine failed",
                "returncode": returncode,
                "elapsed_ms": elapsed_ms,
            }, status=500)

    except asyncio.TimeoutError:
        return web.json_response({
            "status": False,
            "error": f"Query timed out after {timeout}s",
        }, status=504)
    except (ValueError, OSError):
        return web.json_response({"status": False, "error": "Query engine failed"}, status=502)


# ---------------------------------------------------------------------------
# Highlights job API — typed async jobs over the deterministic clipping core
# ---------------------------------------------------------------------------

HIGHLIGHTS_AUTH_HEADER = "X-Auth-Token"


def _highlights_auth_error(request: web.Request) -> web.Response | None:
    """Fail-closed bearer gate for every /api/highlights/* route.

    Core API provisions HIGHLIGHTS_API_TOKEN into the relay's environment and
    Client API sends it as X-Auth-Token. Without a configured secret the
    highlights API is unavailable (503); a missing or mismatched token is 401.
    Rights/provenance in the request body remain typed evidence supplied by
    the authenticated project caller — Client API is the authoritative
    rights/canonical gate, the relay enforces presence plus caller identity.
    """
    expected = os.environ.get("HIGHLIGHTS_API_TOKEN", "")
    if not expected:
        return web.json_response(
            {"status": False,
             "error": "highlights API is unavailable — no API token is configured"},
            status=503,
        )
    supplied = request.headers.get(HIGHLIGHTS_AUTH_HEADER, "")
    if not supplied or not secrets.compare_digest(
        supplied.encode("utf-8"), expected.encode("utf-8")
    ):
        return web.json_response(
            {"status": False,
             "error": f"invalid or missing {HIGHLIGHTS_AUTH_HEADER}"},
            status=401,
        )
    return None


async def highlights_create(request: web.Request) -> web.Response:
    """POST /api/highlights/jobs — validate strictly and enqueue a job."""
    denied = _highlights_auth_error(request)
    if denied is not None:
        return denied
    manager = request.app["highlights_manager"]
    try:
        body = await request.json()
    except Exception:
        return web.json_response(
            {"status": False, "error": "request body must be valid JSON"}, status=400
        )
    try:
        job = await manager.create(body)
        return web.json_response({"status": True, **job}, status=202)
    except JobError as e:
        return web.json_response({"status": False, "error": str(e)}, status=e.status)
    except Exception as e:
        # Never leak stack traces or internals to the client.
        log(f"highlights create: {type(e).__name__}: {e}")
        return web.json_response({"status": False, "error": "internal error"}, status=500)


async def highlights_status(request: web.Request) -> web.Response:
    """GET /api/highlights/jobs/{job_id} — persisted job state."""
    denied = _highlights_auth_error(request)
    if denied is not None:
        return denied
    manager = request.app["highlights_manager"]
    try:
        job = manager.get(request.match_info.get("job_id", ""))
        return web.json_response({"status": True, **job})
    except JobError as e:
        return web.json_response({"status": False, "error": str(e)}, status=e.status)
    except Exception as e:
        log(f"highlights status: {type(e).__name__}: {e}")
        return web.json_response({"status": False, "error": "internal error"}, status=500)


async def highlights_cancel(request: web.Request) -> web.Response:
    """POST /api/highlights/jobs/{job_id}/cancel — terminate and finalize."""
    denied = _highlights_auth_error(request)
    if denied is not None:
        return denied
    manager = request.app["highlights_manager"]
    try:
        job = await manager.cancel(request.match_info.get("job_id", ""))
        return web.json_response({"status": True, **job})
    except JobError as e:
        return web.json_response({"status": False, "error": str(e)}, status=e.status)
    except Exception as e:
        log(f"highlights cancel: {type(e).__name__}: {e}")
        return web.json_response({"status": False, "error": "internal error"}, status=500)


async def highlights_artifacts(request: web.Request) -> web.Response:
    """GET /api/highlights/jobs/{job_id}/artifacts — manifest and clip paths.

    Returns metadata and filesystem references only, never inline video bytes.
    """
    denied = _highlights_auth_error(request)
    if denied is not None:
        return denied
    manager = request.app["highlights_manager"]
    try:
        artifacts = manager.artifacts(request.match_info.get("job_id", ""))
        return web.json_response({"status": True, **artifacts})
    except JobError as e:
        return web.json_response({"status": False, "error": str(e)}, status=e.status)
    except Exception as e:
        log(f"highlights artifacts: {type(e).__name__}: {e}")
        return web.json_response({"status": False, "error": "internal error"}, status=500)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _timestamp() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _build_cmd(body: dict) -> list[str]:
    """Build the sportsclaw CLI command from the request body."""
    prompt = body["prompt"]
    cmd = [SPORTSCLAW_BIN, SPORTSCLAW_ENTRY, "--pipe", prompt]

    user_id = body.get("user_id")
    if user_id:
        cmd.extend(["--user", user_id])
    if body.get("history_mode") is not None:
        cmd.extend(["--history-mode", body["history_mode"]])

    agent_id = body.get("agent_id")
    if agent_id is not None:
        cmd.extend(["--agent", _validate_agent_id(agent_id)])

    if body.get("_delegated") is True:
        cmd.append("--delegated")

    system_prompt = body.get("system_prompt")
    if system_prompt:
        cmd.extend(["--system-prompt", system_prompt])

    if body.get("verbose"):
        cmd.append("--verbose")

    fmt = body.get("format")
    if fmt:
        cmd.append(f"--format={fmt}")

    return cmd


def _build_env(body: dict | None = None) -> dict[str, str]:
    """
    Build environment for the subprocess.

    Inherits critical env vars and allows per-request overrides for
    provider, model, and user-specific API keys.
    """
    env = dict(os.environ)

    if body:
        if body.get("provider"):
            env["SPORTSCLAW_PROVIDER"] = body["provider"]
        if body.get("model"):
            env["SPORTSCLAW_MODEL"] = body["model"]
        if body.get("api_key"):
            # Determine the right env var based on provider
            provider = body.get("provider", env.get("SPORTSCLAW_PROVIDER", "anthropic"))
            # Mirrors PROVIDER_API_KEY_ENV in src/config.ts. A provider missing
            # here silently lands the caller's key in ANTHROPIC_API_KEY, so the
            # run authenticates with the wrong credential instead of failing.
            key_map = {
                "anthropic": "ANTHROPIC_API_KEY",
                "openai": "OPENAI_API_KEY",
                "google": "GOOGLE_GENERATIVE_AI_API_KEY",
                "azure-foundry": "AZURE_FOUNDRY_API_KEY",
            }
            env_var = key_map.get(provider)
            if env_var is None:
                raise web.HTTPBadRequest(
                    text=json.dumps({
                        "status": False,
                        "error": f"unsupported provider for api_key override: {provider}",
                    }),
                    content_type="application/json",
                )
            env[env_var] = body["api_key"]
        if body.get("images"):
            env["SPORTSCLAW_INBOUND_IMAGES"] = json.dumps(body["images"])

    return env


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------

def create_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/health", health)
    app.router.add_get("/api/skills", list_skills)
    app.router.add_get("/api/capabilities", capabilities)
    app.router.add_post("/api/query", query_stream)
    app.router.add_post("/api/query/sync", query_sync)
    app.router.add_get("/api/agents", agents_list)
    app.router.add_post("/api/agents", agents_create)
    app.router.add_post("/api/agents/delegate", agents_delegate)
    app.router.add_get("/api/agents/{agent_id}", agents_get)
    app.router.add_patch("/api/agents/{agent_id}", agents_patch)

    app["highlights_manager"] = HighlightsJobManager(
        jobs_root=os.environ.get("HIGHLIGHTS_JOBS_ROOT", "/data/highlights-jobs"),
        media_root=os.environ.get("HIGHLIGHTS_MEDIA_ROOT", "/data/media"),
        cmd_prefix=[SPORTSCLAW_BIN, SPORTSCLAW_ENTRY],
        max_concurrency=int(os.environ.get("HIGHLIGHTS_MAX_CONCURRENCY", 1)),
        max_queue=int(os.environ.get("HIGHLIGHTS_MAX_QUEUE", 8)),
        job_timeout_sec=int(os.environ.get("HIGHLIGHTS_JOB_TIMEOUT", 900)),
        job_ttl_sec=int(os.environ.get("HIGHLIGHTS_JOB_TTL_SEC", DEFAULT_JOB_TTL_SEC)),
        max_storage_bytes=int(os.environ.get("HIGHLIGHTS_MAX_STORAGE_BYTES",
                                             DEFAULT_MAX_STORAGE_BYTES)),
        max_job_output_bytes=int(os.environ.get("HIGHLIGHTS_MAX_JOB_OUTPUT_BYTES",
                                                DEFAULT_MAX_JOB_OUTPUT_BYTES)),
    )
    app.router.add_post("/api/highlights/jobs", highlights_create)
    app.router.add_get("/api/highlights/jobs/{job_id}", highlights_status)
    app.router.add_post("/api/highlights/jobs/{job_id}/cancel", highlights_cancel)
    app.router.add_get("/api/highlights/jobs/{job_id}/artifacts", highlights_artifacts)
    return app


if __name__ == "__main__":
    log(f"Starting on port {PORT}")
    web.run_app(create_app(), host="0.0.0.0", port=PORT, handler_cancellation=True)
