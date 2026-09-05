"""Offline behavioral checks: real child processes, stubbed HTTP response layer."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "docker/relay"))
class Response:
    def __init__(self, data, status=200):
        self.data, self.status = data, status
class StreamResponse:
    def __init__(self, **kwargs): self.lines = []
    async def prepare(self, request): self.request = request
    async def write(self, data):
        self.lines.append(data)
        if hasattr(self.request, "received"): self.request.received.set()
    async def write_eof(self): pass
web = types.SimpleNamespace(Request=object, Response=Response, StreamResponse=StreamResponse,
    json_response=lambda data, status=200: Response(data, status))
sys.modules["aiohttp"] = types.SimpleNamespace(web=web)
import relay_server as relay
import query_runtime as runtime

class Request:
    def __init__(self, body=None, headers=None, app=None):
        self.body = body or {"prompt": "hello"}
        self.headers = headers or {}
        self.app = app if app is not None else {}
    async def json(self):
        return self.body

class Contracts(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.old = dict(os.environ)
        os.environ["AGENTS_API_TOKEN"] = "test-only-token"
    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.old)
    def request(self, body=None, app=None):
        return Request(body, {"X-Auth-Token": "test-only-token"}, app)

    async def test_auth_all_queries(self):
        for handler in (relay.query_stream, relay.query_sync, relay.capabilities):
            self.assertEqual((await handler(Request())).status, 401)
        del os.environ["AGENTS_API_TOKEN"]
        self.assertEqual((await relay.query_sync(Request())).status, 503)

    async def test_validation_precedes_process(self):
        for extra in ({"timeout": 0}, {"timeout": True}, {"timeout": 301},
                      {"timeout": "20"}, {"history_mode": "merge"}, {"prompt": ["hello"]}):
            self.assertEqual((await relay.query_sync(self.request({"prompt": "hello", **extra}))).status, 400)
        self.assertIn("--history-mode", relay._build_cmd({"prompt": "hello", "history_mode": "caller"}))

    async def test_admission_and_release_on_cancel(self):
        app = {"active_queries": relay.MAX_QUERY_CONCURRENCY}
        self.assertEqual((await relay.query_sync(self.request(app=app))).status, 429)
        app["active_queries"] = 0
        started = asyncio.Event()
        @relay.query_guard
        async def hanging(request):
            started.set()
            await asyncio.Event().wait()
        task = asyncio.create_task(hanging(self.request(app=app)))
        await started.wait()
        self.assertEqual(app["active_queries"], 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(app["active_queries"], 0)

    async def test_capabilities_disclose_policy_not_credentials(self):
        previous, entry = relay.buffered, relay.SPORTSCLAW_ENTRY
        async def fake(*args):
            return b'{"defaultSports": ["football"], "optionalSports": [], "defaultSupport": [], "optionalSupport": [], "unknown": []}', b'', 0
        relay.buffered = fake
        relay.SPORTSCLAW_ENTRY = str(Path(__file__).resolve().parents[1] / "dist/index.js")
        os.environ["SPORTSCLAW_MCP_SERVERS"] = json.dumps({"pod": {
            "tools": ["search_workflow"], "headers": {"X-Api-Token": "do-not-disclose"}}})
        try:
            result = await relay.capabilities(self.request())
            self.assertEqual(result.status, 200)
            self.assertEqual(result.data["history_modes"], ["engine", "caller"])
            self.assertNotIn("do-not-disclose", json.dumps(result.data))
            self.assertEqual(result.data["mcp_servers"][0]["allowed_tools"], ["search_workflow"])
        finally:
            relay.buffered, relay.SPORTSCLAW_ENTRY = previous, entry

    async def test_stderr_larger_than_pipe_is_drained_and_bounded(self):
        out, err, code = await runtime.buffered([sys.executable, "-c",
            'import sys; sys.stderr.write("x" * 2000000); print("ok")'], dict(os.environ), 5)
        self.assertEqual((out, code), (b"ok\n", 0))
        self.assertEqual(len(err), runtime.MAX_STDERR_BYTES)

    async def test_timeout_and_cancel_terminate_descendants(self):
        for cancel in (False, True):
            with tempfile.TemporaryDirectory() as directory:
                marker = str(Path(directory) / "orphan-ran")
                child = f'import time; time.sleep(0.5); open({marker!r}, "w").write("bad")'
                script = f'import subprocess,sys,time; subprocess.Popen([sys.executable,"-c",{child!r}]); print("ready",flush=True); time.sleep(30)'
                async with runtime.process([sys.executable, "-c", script], dict(os.environ)) as (proc, _):
                    await proc.stdout.readline()
                    if cancel:
                        task = asyncio.create_task(proc.wait())
                        task.cancel()
                        with self.assertRaises(asyncio.CancelledError): await task
                    else:
                        with self.assertRaises(asyncio.TimeoutError):
                            await asyncio.wait_for(proc.wait(), .03)
                self.assertIsNotNone(proc.returncode)
                await asyncio.sleep(.65)
                self.assertFalse(Path(marker).exists())

    async def test_stdout_limit(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b"0123456789")
        reader.feed_eof()
        with self.assertRaises(ValueError): await runtime.drain(reader, 5)

    async def test_buffered_stdin_and_missing_result(self):
        out, _, code = await runtime.buffered([sys.executable, "-c",
            'import sys; print(sys.stdin.read())'], dict(os.environ), 3, b"agent body")
        self.assertEqual((out, code), (b"agent body\n", 0))
        previous = relay._build_cmd
        relay._build_cmd = lambda body: [sys.executable, "-c", 'print("[]")']
        try:
            result = await relay.query_sync(self.request())
            self.assertEqual(result.status, 502)
            self.assertFalse(result.data["status"])
        finally:
            relay._build_cmd = previous

    async def test_streaming_drains_stderr_and_handles_non_object_json(self):
        previous = relay._build_cmd
        relay._build_cmd = lambda body: [sys.executable, "-c",
            'import sys; sys.stderr.write("x"*2000000); print("[]"); print(\'{"type":"result","text":"ok"}\')']
        try:
            result = await relay.query_stream(self.request())
            self.assertEqual(len(result.lines), 1)
            self.assertEqual(json.loads(result.lines[0])["text"], "ok")
        finally:
            relay._build_cmd = previous

    async def test_disconnected_stream_cleans_process_group_and_admission(self):
        previous = relay._build_cmd
        with tempfile.TemporaryDirectory() as directory:
            marker = str(Path(directory) / "orphan-ran")
            child = f'import time; time.sleep(.5); open({marker!r}, "w").write("bad")'
            script = f'import subprocess,sys,time; subprocess.Popen([sys.executable,"-c",{child!r}]); print(\'{{"type":"start"}}\',flush=True); time.sleep(30)'
            relay._build_cmd = lambda body: [sys.executable, "-c", script]
            request = self.request()
            request.received = asyncio.Event()
            try:
                task = asyncio.create_task(relay.query_stream(request))
                await asyncio.wait_for(request.received.wait(), 3)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError): await task
                self.assertEqual(request.app["active_queries"], 0)
                await asyncio.sleep(.65)
                self.assertFalse(Path(marker).exists())
            finally:
                relay._build_cmd = previous

unittest.main()
