"""Relay artifact contract — `artifact-turn-v1` through the real relay handlers.

Covers docker/relay/artifact_contract.py (stdlib-only mirror of the engine wire
in src/artifact-output.ts) and its use by relay_server.query_sync /
query_stream / capabilities:

  - strict ArtifactTurnInput / ArtifactTurnResult / artifact-v1 validation,
    including UTF-16 title length, UTF-8 HTML size and control characters;
  - the server gate and caller-history requirement are checked before any
    subprocess is spawned; streams refuse artifacts;
  - the artifact input rides on the child's stdin, never argv or the
    environment; legacy requests are unchanged;
  - success requires exactly one result echoing this request's nonce;
    missing, malformed, duplicate or unrequested artifact output fails closed;
  - artifact titles and HTML never reach the relay logs.

aiohttp is stubbed and the SportsClaw CLI is a fake Python script that records
argv/stdin and prints scripted NDJSON. No Docker, network or credentials.
Run: cd docker/relay && python3 -m unittest test_artifact_contract
"""

import asyncio
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN = "relay-artifact-test-token-0123456"
GATE = "SPORTSCLAW_ARTIFACTS_ENABLED"

FAKE_CLI = r'''
import json, os, sys
args = sys.argv[1:]
if args[:2] == ["list", "--json"]:
    print(json.dumps({k: [] for k in ("defaultSports", "optionalSports",
                                      "defaultSupport", "optionalSupport", "unknown")}))
    sys.exit(0)
stdin = sys.stdin.read() if "--history-stdin" in args else None
with open(os.environ["FAKE_LOG"], "a", encoding="utf-8") as handle:
    handle.write(json.dumps({
        "argv": args,
        "stdin": stdin,
        "env_leaks": sorted(k for k, v in os.environ.items() if "PRIVATE" in v),
    }) + "\n")
with open(os.environ["FAKE_STDOUT"], encoding="utf-8") as handle:
    sys.stdout.write(handle.read())
'''

NONCE = "nonce_PRIVATEabc123456"
TURN = {"contract": "artifact-turn-v1", "nonce": NONCE}
HTML = "<!doctype html><html><head><title>PRIVATE_TITLE</title></head><body><h1>PRIVATE_HTML é😀</h1></body></html>"
ARTIFACT = {"contract": "artifact-v1", "title": "PRIVATE_TITLE Flamengo x Palmeiras", "mimeType": "text/html", "html": HTML}
HISTORY = [{"role": "user", "content": "earlier"}, {"role": "assistant", "content": "Noted."}]
PROSE = "Built the comparison report."
PRIVATE_MARKERS = ("PRIVATE_TITLE", "PRIVATE_HTML")


def copy(value):
    return json.loads(json.dumps(value))


def result(artifact=None, reason=None, nonce=NONCE, **extra):
    return dict({"contract": "artifact-turn-v1", "nonce": nonce, "artifact": copy(artifact), "reasonCode": reason}, **extra)


def body(artifact_input=None, **extra):
    return dict({"prompt": "Compare Flamengo and Palmeiras", "history_mode": "caller", "history": copy(HISTORY),
                 "artifact": copy(TURN) if artifact_input is None else artifact_input}, **extra)


relay_server = None
artifact_contract = None
WORK = None


class _Response:
    def __init__(self, data, status=200, headers=None):
        self.data = data
        self.status = status
        self.headers = headers or {}


def setUpModule():
    global relay_server, artifact_contract, WORK
    WORK = tempfile.mkdtemp(prefix="sportsclaw-relay-artifact-")
    os.makedirs(os.path.join(WORK, "dist"))
    with open(os.path.join(WORK, "dist", "index.py"), "w", encoding="utf-8") as handle:
        handle.write(FAKE_CLI)
    with open(os.path.join(WORK, "package.json"), "w", encoding="utf-8") as handle:
        json.dump({"version": "0.0.0-test"}, handle)
    os.environ.update({
        "SPORTSCLAW_BIN": sys.executable,
        "SPORTSCLAW_ENTRY": os.path.join(WORK, "dist", "index.py"),
        "AGENTS_API_TOKEN": TOKEN,
        "HIGHLIGHTS_JOBS_ROOT": os.path.join(WORK, "jobs"),
        "HIGHLIGHTS_MEDIA_ROOT": os.path.join(WORK, "media"),
        "FAKE_LOG": os.path.join(WORK, "fake.log"),
        "FAKE_STDOUT": os.path.join(WORK, "fake.out"),
    })
    web = types.SimpleNamespace(
        Request=object, Response=_Response, StreamResponse=object, Application=dict,
        json_response=lambda data, status=200, headers=None: _Response(data, status, headers),
        HTTPBadRequest=Exception, run_app=None,
    )
    aiohttp = types.ModuleType("aiohttp")
    aiohttp.web = web
    sys.modules["aiohttp"] = aiohttp
    sys.path.insert(0, HERE)
    import relay_server as relay  # noqa: E402
    import artifact_contract as contract  # noqa: E402
    relay_server, artifact_contract = relay, contract


def tearDownModule():
    shutil.rmtree(WORK, ignore_errors=True)


class Req:
    def __init__(self, request_body):
        self._body = request_body
        self.app = {}
        self.headers = {"X-Auth-Token": TOKEN}

    async def json(self):
        return copy(self._body)


class RelayCase(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.get(GATE)
        os.environ.pop(GATE, None)
        for name in ("FAKE_LOG", "FAKE_STDOUT"):
            open(os.environ[name], "w").close()

    def tearDown(self):
        if self._saved is None:
            os.environ.pop(GATE, None)
        else:
            os.environ[GATE] = self._saved

    def enable(self):
        os.environ[GATE] = "true"

    def child_prints(self, *events):
        with open(os.environ["FAKE_STDOUT"], "w", encoding="utf-8") as handle:
            for event in events:
                handle.write(json.dumps(event, ensure_ascii=False) + "\n")

    def spawned(self):
        with open(os.environ["FAKE_LOG"], encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]

    def call(self, handler, request_body):
        logs = io.StringIO()
        with contextlib.redirect_stdout(logs):
            response = asyncio.run(handler(Req(request_body)))
        for marker in PRIVATE_MARKERS:
            self.assertNotIn(marker, logs.getvalue(), f"relay logs must not carry {marker}")
        return response

    def query(self, request_body):
        response = self.call(relay_server.query_sync, request_body)
        if response.status != 200:
            self.assertIs(response.data.get("status"), False)
            self.assertNotIn("text", response.data, "no prose without a verified acknowledgement")
            self.assertNotIn("artifact", response.data)
        return response


class ArtifactContractWire(RelayCase):
    def test_valid_artifact_and_turn(self):
        self.assertEqual(artifact_contract.parse_artifact_turn_input(copy(TURN)), TURN)
        self.assertEqual(artifact_contract.parse_artifact(copy(ARTIFACT)), ARTIFACT)
        tabbed = dict(ARTIFACT, html="<html>\r\n\t<body>ok</body>\n</html>")
        self.assertEqual(artifact_contract.parse_artifact(copy(tabbed)), tabbed)
        title = "é" * 120
        self.assertIsNotNone(artifact_contract.parse_artifact(dict(ARTIFACT, title=title)))

    def test_invalid_turn_inputs(self):
        for label, value in {
            "wrong contract": dict(TURN, contract="artifact-turn-v2"),
            "short nonce": dict(TURN, nonce="abc"),
            "nonce with slash": dict(TURN, nonce="a" * 20 + "/x"),
            "owner override": dict(TURN, ownerId="acct_5150"),
            "missing nonce": {"contract": "artifact-turn-v1"},
            "not an object": "artifact please",
        }.items():
            with self.subTest(label):
                self.assertIsNone(artifact_contract.parse_artifact_turn_input(value))

    def test_invalid_artifacts(self):
        big = "<p>" + "x" * artifact_contract.MAX_HTML_BYTES + "</p>"
        multibyte = "😀" * (artifact_contract.MAX_HTML_BYTES // 4 + 1)
        for label, value in {
            "wrong mime": dict(ARTIFACT, mimeType="text/plain"),
            "wrong contract": dict(ARTIFACT, contract="artifact-v2"),
            "extra url": dict(ARTIFACT, url="https://reports.example/abc"),
            "missing html": {k: v for k, v in ARTIFACT.items() if k != "html"},
            "blank html": dict(ARTIFACT, html="  \n"),
            "html over byte limit": dict(ARTIFACT, html=big),
            "html over byte limit in UTF-8 only": dict(ARTIFACT, html=multibyte),
            "NUL in html": dict(ARTIFACT, html="<p>a\x00b</p>"),
            "lone surrogate": dict(ARTIFACT, html="<p>\ud800</p>"),
            "title too long (UTF-16 units)": dict(ARTIFACT, title="😀" * 61),
            "title with newline": dict(ARTIFACT, title="a\nb"),
            "blank title": dict(ARTIFACT, title=" "),
            "html not a string": dict(ARTIFACT, html=["<p>"]),
        }.items():
            with self.subTest(label):
                self.assertIsNone(artifact_contract.parse_artifact(value))

    def test_results_bind_to_the_nonce(self):
        self.assertEqual(artifact_contract.parse_artifact_turn_result(result(ARTIFACT), TURN)["artifact"], ARTIFACT)
        self.assertEqual(artifact_contract.parse_artifact_turn_result(result(), TURN)["artifact"], None)
        self.assertEqual(artifact_contract.parse_artifact_turn_result(result(reason="denied"), TURN)["reasonCode"], "denied")
        for label, value in {
            "other nonce": result(ARTIFACT, nonce="nonce_other12345678"),
            "artifact with reason": result(ARTIFACT, reason="invalid_artifact"),
            "unknown reason": result(reason="published"),
            "invalid artifact": result(dict(ARTIFACT, mimeType="image/svg+xml")),
            "extra url": result(ARTIFACT, url="https://reports.example/abc"),
        }.items():
            with self.subTest(label):
                self.assertIsNone(artifact_contract.parse_artifact_turn_result(value, TURN))


class ArtifactGates(RelayCase):
    def test_disabled_server_refuses_before_spawning(self):
        response = self.query(body())
        self.assertEqual(response.status, 503)
        self.assertEqual(self.spawned(), [])

    def test_requires_caller_history_and_valid_input(self):
        self.enable()
        for label, request_body in {
            "engine history": body(history_mode="engine"),
            "no history": {k: v for k, v in body().items() if k != "history"},
            "invalid input": body(dict(TURN, nonce="x")),
        }.items():
            with self.subTest(label):
                self.assertEqual(self.query(request_body).status, 400)
        self.assertEqual(self.spawned(), [])

    def test_stream_refuses_artifacts(self):
        self.enable()
        response = self.call(relay_server.query_stream, body())
        self.assertEqual(response.status, 400)
        self.assertEqual(self.spawned(), [])

    def test_capabilities_advertise_only_when_enabled(self):
        self.assertNotIn("artifact_contract", self.call(relay_server.capabilities, {}).data)
        self.enable()
        self.assertEqual(self.call(relay_server.capabilities, {}).data["artifact_contract"], "artifact-turn-v1")


class ArtifactSync(RelayCase):
    def test_submitted_artifact_rides_beside_the_text(self):
        self.enable()
        self.child_prints({"type": "result", "text": PROSE, "artifact": result(ARTIFACT)})
        response = self.query(body())
        self.assertEqual(response.status, 200)
        self.assertEqual(response.data["text"], PROSE)
        self.assertEqual(response.data["artifact"]["artifact"], ARTIFACT)
        [child] = self.spawned()
        self.assertEqual(json.loads(child["stdin"])["artifact"], TURN, "the input rides on stdin")
        self.assertNotIn(NONCE, " ".join(child["argv"]), "never in argv")
        self.assertEqual(child["env_leaks"], [], "never in the environment")

    def test_no_artifact_and_refusals_pass_through(self):
        self.enable()
        for reason in (None, "denied", "invalid_artifact", "conflicting_artifact", "evidence_unverified"):
            with self.subTest(reason):
                self.child_prints({"type": "result", "text": PROSE, "artifact": result(reason=reason)})
                response = self.query(body())
                self.assertEqual(response.status, 200)
                self.assertEqual(response.data["artifact"], result(reason=reason))

    def test_missing_or_bad_acknowledgements_fail_closed(self):
        self.enable()
        for label, events in {
            "missing": [{"type": "result", "text": PROSE}],
            "other nonce": [{"type": "result", "text": PROSE, "artifact": result(ARTIFACT, nonce="nonce_other12345678")}],
            "invalid html": [{"type": "result", "text": PROSE, "artifact": result(dict(ARTIFACT, html=""))}],
            "duplicate results": [{"type": "result", "text": PROSE, "artifact": result(ARTIFACT)},
                                  {"type": "result", "text": PROSE, "artifact": result(ARTIFACT)}],
        }.items():
            with self.subTest(label):
                self.child_prints(*events)
                self.assertEqual(self.query(body()).status, 502)

    def test_unrequested_artifact_is_refused(self):
        self.child_prints({"type": "result", "text": PROSE, "artifact": result(ARTIFACT)})
        request_body = {k: v for k, v in body().items() if k != "artifact"}
        self.assertEqual(self.query(request_body).status, 502)

    def test_legacy_requests_unchanged(self):
        self.child_prints({"type": "result", "text": PROSE})
        response = self.query({"prompt": "Who won?"})
        self.assertEqual(response.status, 200)
        self.assertEqual(response.data["text"], PROSE)
        self.assertNotIn("artifact", response.data)
        [child] = self.spawned()
        self.assertIsNone(child["stdin"])


if __name__ == "__main__":
    unittest.main()
