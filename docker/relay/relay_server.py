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
    GET  /api/capabilities → History contract and query limits (X-Auth-Token)
    POST /api/query        → Streaming NDJSON response (real-time progress, X-Auth-Token)
    POST /api/query/sync   → Buffered JSON response (waits for result, X-Auth-Token)

Query body:
    {
        "prompt": "Who won the Super Bowl?",
        "user_id": "discord-12345",        // optional, enables memory
        "provider": "anthropic",           // optional, override provider
        "model": "claude-sonnet-4-5-...",  // optional, override model
        "verbose": false,                  // optional, enable debug output
        "session_id": "opaque-id",         // optional, 1-128 printable chars
        "history_mode": "caller",          // optional, caller | engine
        "history": [{"role": "user", "content": "..."}]  // caller mode, /api/query/sync only
    }
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import time

from aiohttp import web

from skills_catalog import parse_catalog


PORT = int(os.environ.get("RELAY_PORT", 8080))
SPORTSCLAW_BIN = os.environ.get("SPORTSCLAW_BIN", "node")
SPORTSCLAW_ENTRY = os.environ.get("SPORTSCLAW_ENTRY", "/app/dist/index.js")
DEFAULT_TIMEOUT = int(os.environ.get("RELAY_TIMEOUT", 180))
MAX_QUERY_TIMEOUT = int(os.environ.get("RELAY_MAX_QUERY_TIMEOUT", 300))
MAX_PROMPT_CHARS = 20000
# Mirrors src/caller-history.ts.
MAX_HISTORY_ENTRIES = 40
MAX_HISTORY_CHARS = 12000
MAX_SESSION_ID_CHARS = 128
HISTORY_CONTRACT = "structured-v1"
if not 1 <= DEFAULT_TIMEOUT <= MAX_QUERY_TIMEOUT:
    raise ValueError("invalid relay query limits")
AUTH_HEADER = "X-Auth-Token"
AUTH_TOKEN_ENV = "AGENTS_API_TOKEN"


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
        proc = await asyncio.create_subprocess_exec(
            SPORTSCLAW_BIN, SPORTSCLAW_ENTRY, "list", "--json",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=_build_env(),
        )
        stdout, _stderr = await asyncio.wait_for(proc.communicate(), timeout=10)
        skills = parse_catalog(stdout.decode(), proc.returncode)
        return web.json_response({"status": True, "skills": skills})
    except Exception as e:
        # Only the parser's own message is surfaced — child stderr is never
        # forwarded to the client.
        log(f"skills: {e}")
        return web.json_response(
            {"status": False, "error": str(e)}, status=500
        )


# ---------------------------------------------------------------------------
# Internal authentication + request validation (query and capabilities)
# ---------------------------------------------------------------------------

def _auth_error(request: web.Request) -> web.Response | None:
    """Fail closed: no configured token is 503, a missing or wrong header is 401."""
    expected = os.environ.get(AUTH_TOKEN_ENV, "")
    if not expected:
        return web.json_response(
            {"status": False, "error": "relay API is unavailable — no API token is configured"},
            status=503,
        )
    supplied = request.headers.get(AUTH_HEADER, "")
    if not supplied or not secrets.compare_digest(
        supplied.encode("utf-8"), expected.encode("utf-8")
    ):
        return web.json_response(
            {"status": False, "error": f"invalid or missing {AUTH_HEADER}"}, status=401
        )
    return None


def _validate_session_id(value: object) -> None:
    """Opaque caller session id; mirrors validateSessionId in src/caller-history.ts."""
    if (not isinstance(value, str) or not value or len(value) > MAX_SESSION_ID_CHARS
            or value != value.strip() or value.startswith("-")
            or any(ord(ch) < 32 or ord(ch) == 127 for ch in value)):
        raise ValueError(f"session_id must be 1-{MAX_SESSION_ID_CHARS} printable characters")


def _validate_history(history: object) -> None:
    """Caller-owned prior turns; mirrors validateCallerHistory in src/caller-history.ts."""
    if not isinstance(history, list) or len(history) > MAX_HISTORY_ENTRIES:
        raise ValueError(f"history must be a list of at most {MAX_HISTORY_ENTRIES} entries")
    total = 0
    for entry in history:
        if (not isinstance(entry, dict) or set(entry) != {"role", "content"}
                or entry["role"] not in ("user", "assistant")
                or not isinstance(entry["content"], str) or not entry["content"].strip()):
            raise ValueError("history entries must be exactly {role: user|assistant, content: nonempty string}")
        total += len(entry["content"])
    if total > MAX_HISTORY_CHARS:
        raise ValueError(f"history content must total at most {MAX_HISTORY_CHARS} characters")


async def _validated_body(request: web.Request) -> tuple[dict | None, web.Response | None]:
    """Authenticate, then validate the query body before any subprocess starts."""
    denied = _auth_error(request)
    if denied is not None:
        return None, denied
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
        if "session_id" in body:
            _validate_session_id(body["session_id"])
        if "history" in body:
            if body.get("history_mode") != "caller":
                raise ValueError("history requires history_mode caller")
            _validate_history(body["history"])
        for key in ("user_id", "provider", "model", "system_prompt", "format", "api_key"):
            if key in body and (not isinstance(body[key], str) or len(body[key]) > MAX_PROMPT_CHARS):
                raise ValueError(f"invalid {key}")
    except (ValueError, TypeError) as error:
        return None, web.json_response({"status": False, "error": str(error)}, status=400)
    return body, None


async def capabilities(request: web.Request) -> web.Response:
    """What this replica accepts. Clients still verify the per-response ack."""
    denied = _auth_error(request)
    if denied is not None:
        return denied
    return web.json_response({
        "protocol_version": "1.0",
        "build_revision": os.environ.get("SPORTSCLAW_BUILD_REVISION"),
        "history_modes": ["engine", "caller"],
        "history_contract": HISTORY_CONTRACT,
        "structured_history": True,
        "session_id": True,
        "query": {
            "default_timeout_seconds": DEFAULT_TIMEOUT,
            "max_timeout_seconds": MAX_QUERY_TIMEOUT,
            "max_prompt_characters": MAX_PROMPT_CHARS,
            "max_history_entries": MAX_HISTORY_ENTRIES,
            "max_history_characters": MAX_HISTORY_CHARS,
            "max_session_id_characters": MAX_SESSION_ID_CHARS,
        },
    })


# ---------------------------------------------------------------------------
# Query — streaming NDJSON (forwards engine events in real-time)
# ---------------------------------------------------------------------------

async def query_stream(request: web.Request) -> web.StreamResponse:
    """
    Execute a SportsClaw query and stream NDJSON events in real-time.

    The engine emits structured NDJSON on stdout (pipe mode). This handler
    forwards each event line directly to the HTTP client, giving consumers
    real-time visibility into routing, tool calls, and the final result.
    """
    body, denied = await _validated_body(request)
    if denied is not None:
        return denied
    if "history" in body:
        # A stream has no per-response contract ack, so a caller could not tell
        # whether this replica honored the history. Refuse rather than drop it.
        return web.json_response(
            {"status": False, "error": "structured history is only supported on /api/query/sync"},
            status=400,
        )
    prompt = body["prompt"]

    user_id = body.get("user_id", "api-anonymous")
    timeout = body.get("timeout", DEFAULT_TIMEOUT)

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
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            limit=16 * 1024 * 1024,  # 16MB line buffer (base64 images ~88KB, videos can be several MB)
        )

        async def stream_stdout():
            async for line in proc.stdout:
                decoded = line.decode().rstrip("\n")
                if not decoded:
                    continue
                # Try to parse as JSON and inject user_id
                try:
                    event = json.loads(decoded)
                    event["user_id"] = user_id
                    await response.write(json.dumps(event).encode() + b"\n")
                except json.JSONDecodeError:
                    # Non-JSON line (e.g. pip output) — wrap as debug
                    await response.write(json.dumps({
                        "type": "debug", "text": decoded,
                    }).encode() + b"\n")

        await asyncio.wait_for(stream_stdout(), timeout=timeout)
        await proc.wait()

        # If engine exited with error and no error event was emitted
        if proc.returncode != 0:
            stderr_bytes = await proc.stderr.read()
            stderr_text = stderr_bytes.decode().strip() if stderr_bytes else ""
            await response.write(json.dumps({
                "type": "error",
                "error": stderr_text or f"Exit code {proc.returncode}",
                "returncode": proc.returncode,
            }).encode() + b"\n")

    except asyncio.TimeoutError:
        proc.kill()
        await response.write(json.dumps({
            "type": "error",
            "error": f"Query timed out after {timeout}s",
        }).encode() + b"\n")
    except (ConnectionResetError, asyncio.CancelledError):
        proc.kill()

    await response.write_eof()
    return response


# ---------------------------------------------------------------------------
# Query — synchronous (buffered) response
# ---------------------------------------------------------------------------

async def query_sync(request: web.Request) -> web.Response:
    """
    Execute a SportsClaw query and return a single JSON response.

    Parses the engine's NDJSON output and extracts the result event.
    """
    body, denied = await _validated_body(request)
    if denied is not None:
        return denied
    prompt = body["prompt"]

    user_id = body.get("user_id", "api-anonymous")
    timeout = body.get("timeout", DEFAULT_TIMEOUT)

    cmd = _build_cmd(body)
    env = _build_env(body)
    stdin = _build_stdin(body)
    started_at = time.monotonic()

    log(f"sync: user={user_id} prompt={prompt[:80]}")

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE if stdin is not None else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )

        # Use communicate() to read ALL stdout bytes at once (no line-length
        # limit), then split by \n ourselves.  readline() enforces a 64KB
        # default StreamReader limit that truncates large base64 lines;
        # communicate() uses read() which has no such limit.
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            proc.communicate(stdin), timeout=timeout
        )
        elapsed_ms = int((time.monotonic() - started_at) * 1000)

        stdout_text = stdout_bytes.decode() if stdout_bytes else ""
        stderr_text = stderr_bytes.decode().strip() if stderr_bytes else ""

        log(f"sync: stdout={len(stdout_bytes)} bytes, "
            f"stderr={len(stderr_bytes)} bytes, "
            f"exit={proc.returncode}")

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

        if error_text:
            return web.json_response({
                "status": False,
                "error": error_text,
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
            if body.get("history_mode") == "caller" and "history" in body:
                # Bind success to this query's contract, not a different replica's capabilities.
                resp["history_contract"] = HISTORY_CONTRACT
                resp["session_id"] = body.get("session_id")
            if images:
                resp["images"] = images
                log(f"sync: returning {len(images)} image(s)")
            if videos:
                resp["videos"] = videos
                log(f"sync: returning {len(videos)} video(s)")
            return web.json_response(resp)

        # Fallback: no result event parsed
        log(f"sync: no result event found in {line_num} lines")
        if proc.returncode == 0:
            return web.json_response({
                "status": True,
                "text": "(no result event emitted by engine)",
                "user_id": user_id,
                "elapsed_ms": elapsed_ms,
            })
        else:
            return web.json_response({
                "status": False,
                "error": stderr_text or f"Exit code {proc.returncode}",
                "returncode": proc.returncode,
                "elapsed_ms": elapsed_ms,
            }, status=500)

    except asyncio.TimeoutError:
        proc.kill()
        return web.json_response({
            "status": False,
            "error": f"Query timed out after {timeout}s",
        }, status=504)


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
    if body.get("session_id") is not None:
        cmd.extend(["--session-id", body["session_id"]])
    if body.get("history_mode") is not None:
        cmd.extend(["--history-mode", body["history_mode"]])
    if body.get("history") is not None:
        cmd.append("--history-stdin")

    system_prompt = body.get("system_prompt")
    if system_prompt:
        cmd.extend(["--system-prompt", system_prompt])

    if body.get("verbose"):
        cmd.append("--verbose")

    fmt = body.get("format")
    if fmt:
        cmd.append(f"--format={fmt}")

    return cmd


def _build_stdin(body: dict) -> bytes | None:
    """Caller history (and its images) ride on the child's stdin, never argv, the environment or logs."""
    if body.get("history") is None:
        return None
    payload = {"history": body["history"]}
    if body.get("images"):
        payload["images"] = body["images"]
    return json.dumps(payload).encode()


def _build_env(body: dict | None = None) -> dict[str, str]:
    """
    Build environment for the subprocess.

    Inherits critical env vars and allows per-request overrides for
    provider, model, and user-specific API keys.
    """
    env = dict(os.environ)
    # The relay's own credential never reaches the engine or its tools.
    env.pop(AUTH_TOKEN_ENV, None)

    if body:
        if body.get("provider"):
            env["SPORTSCLAW_PROVIDER"] = body["provider"]
        if body.get("model"):
            env["SPORTSCLAW_MODEL"] = body["model"]
        if body.get("api_key"):
            # Determine the right env var based on provider
            provider = body.get("provider", env.get("SPORTSCLAW_PROVIDER", "anthropic"))
            key_map = {
                "anthropic": "ANTHROPIC_API_KEY",
                "openai": "OPENAI_API_KEY",
                "google": "GOOGLE_GENERATIVE_AI_API_KEY",
            }
            env_var = key_map.get(provider, "ANTHROPIC_API_KEY")
            env[env_var] = body["api_key"]
        if body.get("images") and body.get("history") is None:
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
    return app


if __name__ == "__main__":
    log(f"Starting on port {PORT}")
    web.run_app(create_app(), host="0.0.0.0", port=PORT)
