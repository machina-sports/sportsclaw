"""Bounded subprocess lifecycle shared by query and discovery endpoints."""
import asyncio
import os
import signal
from contextlib import asynccontextmanager

MAX_OUTPUT_BYTES = 32 * 1024 * 1024
MAX_STDERR_BYTES = 64 * 1024


async def drain(reader, limit, *, truncate=False):
    chunks, size = [], 0
    while True:
        chunk = await reader.read(65536)
        if not chunk:
            return b"".join(chunks)
        if size + len(chunk) > limit and not truncate:
            raise ValueError("query output exceeds configured limit")
        if size < limit:
            chunks.append(chunk[:limit - size])
        size += len(chunk)


async def stop(proc):
    # Each child owns a new session, so this never signals the relay's group.
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    await proc.wait()


@asynccontextmanager
async def process(cmd, env, *, with_stdin=False):
    spawn = asyncio.create_task(asyncio.create_subprocess_exec(
        *cmd, env=env, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE, start_new_session=True,
        stdin=asyncio.subprocess.PIPE if with_stdin else None,
        limit=MAX_OUTPUT_BYTES,
    ))
    try:
        proc = await asyncio.shield(spawn)
    except asyncio.CancelledError:
        proc = await spawn
        await stop(proc)
        raise
    stderr = asyncio.create_task(drain(proc.stderr, MAX_STDERR_BYTES, truncate=True))
    try:
        yield proc, stderr
    finally:
        # Shield cleanup from the HTTP handler's cancellation. Always reap.
        cleanup = asyncio.create_task(stop(proc))
        try:
            await asyncio.shield(cleanup)
        except asyncio.CancelledError:
            await cleanup
            raise
        finally:
            stderr.cancel()
            await asyncio.gather(stderr, return_exceptions=True)


async def buffered(cmd, env, timeout, stdin=None):
    async with process(cmd, env, with_stdin=stdin is not None) as (proc, stderr):
        async def collect():
            if stdin is not None:
                proc.stdin.write(stdin)
                await proc.stdin.drain()
                proc.stdin.close()
            stdout = await drain(proc.stdout, MAX_OUTPUT_BYTES)
            await proc.wait()
            return stdout, await stderr, proc.returncode
        return await asyncio.wait_for(collect(), timeout)
