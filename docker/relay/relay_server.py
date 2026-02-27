"""
sportsclaw-relay — HTTP bridge for headless SportsClaw execution.

Exposes the SportsClaw engine over HTTP so any client (web app, mobile,
Discord bot, Slack integration) can send sports queries and receive
structured responses.

Inspired by the machina-cockpit relay_server.py architecture.

Endpoints:
    GET  /health           → {"status": "ok", "service": "sportsclaw-relay"}
    GET  /api/skills       → List installed sport schemas
    POST /api/query        → Streaming NDJSON response (one-shot query)
    POST /api/query/sync   → Buffered JSON response (one-shot query)

Query body:
    {
        "prompt": "Who won the Super Bowl?",
        "user_id": "discord-12345",        // optional, enables memory
        "provider": "anthropic",           // optional, override provider
        "model": "claude-sonnet-4-5-...",  // optional, override model
        "verbose": false                   // optional, enable debug output
    }
"""

import asyncio
import json
import os
import subprocess
import time

from aiohttp import web


PORT = int(os.environ.get("RELAY_PORT", 8080))
SPORTSCLAW_BIN = os.environ.get("SPORTSCLAW_BIN", "node")
SPORTSCLAW_ENTRY = os.environ.get("SPORTSCLAW_ENTRY", "/app/dist/index.js")
DEFAULT_TIMEOUT = int(os.environ.get("RELAY_TIMEOUT", 120))


def log(msg: str) -> None:
    print(f"[sportsclaw-relay] {msg}", flush=True)


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

async def health(request: web.Request) -> web.Response:
    """Service health check with installed skills count."""
    try:
        proc = await asyncio.create_subprocess_exec(
            SPORTSCLAW_BIN, SPORTSCLAW_ENTRY, "list",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=_build_env(),
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
        lines = [
            l.strip() for l in stdout.decode().strip().splitlines()
            if l.strip().startswith("- ")
        ]
        skills_count = len(lines)
    except Exception:
        skills_count = -1

    return web.json_response({
        "status": "ok",
        "service": "sportsclaw-relay",
        "skills_installed": skills_count,
    })


# ---------------------------------------------------------------------------
# List installed skills
# ---------------------------------------------------------------------------

async def list_skills(request: web.Request) -> web.Response:
    """Return installed sport schemas."""
    try:
        proc = await asyncio.create_subprocess_exec(
            SPORTSCLAW_BIN, SPORTSCLAW_ENTRY, "list",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=_build_env(),
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
        lines = stdout.decode().strip().splitlines()
        skills = [
            l.strip().lstrip("- ").strip()
            for l in lines
            if l.strip().startswith("- ")
        ]
        return web.json_response({"status": True, "skills": skills})
    except Exception as e:
        return web.json_response(
            {"status": False, "error": str(e)}, status=500
        )


# ---------------------------------------------------------------------------
# Query — streaming NDJSON
# ---------------------------------------------------------------------------

async def query_stream(request: web.Request) -> web.StreamResponse:
    """
    Execute a SportsClaw query and stream output as NDJSON.

    The SportsClaw CLI writes its response to stdout. We capture it line by
    line and forward each as a JSON event, similar to the machina-cockpit
    relay pattern.

    Response events:
        {"type": "start", "timestamp": "...", "user_id": "..."}
        {"type": "chunk", "text": "..."}     (incremental stdout lines)
        {"type": "result", "text": "..."}    (final assembled response)
        {"type": "error", "error": "..."}    (if execution failed)
    """
    body = await request.json()
    prompt = body.get("prompt")
    if not prompt:
        return web.json_response(
            {"status": False, "error": "prompt is required"}, status=400
        )

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

    # Start event
    start_event = json.dumps({
        "type": "start",
        "timestamp": _timestamp(),
        "user_id": user_id,
    })
    await response.write(start_event.encode() + b"\n")

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )

        collected_lines: list[str] = []

        async def stream_stdout():
            async for line in proc.stdout:
                decoded = line.decode().rstrip("\n")
                if decoded:
                    collected_lines.append(decoded)
                    chunk = json.dumps({"type": "chunk", "text": decoded})
                    await response.write(chunk.encode() + b"\n")

        await asyncio.wait_for(stream_stdout(), timeout=timeout)
        await proc.wait()

        stderr_bytes = await proc.stderr.read()
        stderr_text = stderr_bytes.decode().strip() if stderr_bytes else ""

        if proc.returncode == 0:
            result_event = json.dumps({
                "type": "result",
                "text": "\n".join(collected_lines),
                "user_id": user_id,
            })
            await response.write(result_event.encode() + b"\n")
        else:
            error_event = json.dumps({
                "type": "error",
                "error": stderr_text or f"Exit code {proc.returncode}",
                "returncode": proc.returncode,
            })
            await response.write(error_event.encode() + b"\n")

        # Debug info
        if stderr_text:
            debug_event = json.dumps({
                "type": "debug",
                "stderr": stderr_text[:2000],
            })
            await response.write(debug_event.encode() + b"\n")

    except asyncio.TimeoutError:
        proc.kill()
        timeout_event = json.dumps({
            "type": "error",
            "error": f"Query timed out after {timeout}s",
        })
        await response.write(timeout_event.encode() + b"\n")
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

    Simpler than the streaming endpoint — waits for the full response
    before sending. Better for simple integrations that don't need streaming.
    """
    body = await request.json()
    prompt = body.get("prompt")
    if not prompt:
        return web.json_response(
            {"status": False, "error": "prompt is required"}, status=400
        )

    user_id = body.get("user_id", "api-anonymous")
    timeout = body.get("timeout", DEFAULT_TIMEOUT)

    cmd = _build_cmd(body)
    env = _build_env(body)
    started_at = time.monotonic()

    log(f"sync: user={user_id} prompt={prompt[:80]}")

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        stdout, stderr = await asyncio.wait_for(
            proc.communicate(), timeout=timeout
        )
        elapsed_ms = int((time.monotonic() - started_at) * 1000)

        stdout_text = stdout.decode().strip() if stdout else ""
        stderr_text = stderr.decode().strip() if stderr else ""

        if proc.returncode == 0:
            return web.json_response({
                "status": True,
                "text": stdout_text,
                "user_id": user_id,
                "elapsed_ms": elapsed_ms,
            })
        else:
            return web.json_response({
                "status": False,
                "error": stderr_text or f"Exit code {proc.returncode}",
                "stdout": stdout_text,
                "returncode": proc.returncode,
                "elapsed_ms": elapsed_ms,
            }, status=500)

    except asyncio.TimeoutError:
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
    cmd = [SPORTSCLAW_BIN, SPORTSCLAW_ENTRY, prompt]

    if body.get("verbose"):
        cmd.append("--verbose")

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
            key_map = {
                "anthropic": "ANTHROPIC_API_KEY",
                "openai": "OPENAI_API_KEY",
                "google": "GOOGLE_GENERATIVE_AI_API_KEY",
            }
            env_var = key_map.get(provider, "ANTHROPIC_API_KEY")
            env[env_var] = body["api_key"]

    return env


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------

def create_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/health", health)
    app.router.add_get("/api/skills", list_skills)
    app.router.add_post("/api/query", query_stream)
    app.router.add_post("/api/query/sync", query_sync)
    return app


if __name__ == "__main__":
    log(f"Starting on port {PORT}")
    web.run_app(create_app(), host="0.0.0.0", port=PORT)
