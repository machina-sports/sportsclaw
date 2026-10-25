"""watch-decision-v1 on POST /api/watch-intent (docker/relay/watch_intent_api.py).

The same route, auth-first order, flag, byte cap, body deadline, shared
concurrency slot and no-store envelope as watch-intent-v1, plus exact-schema
validation of the alternate Jev contract in both directions. The legacy
contract is unchanged. The last case drives the real handler and buffered()
into the compiled worker with no credential, so no network is reached.

Run: python3 docker/relay/test_watch_decision.py (stdlib only; aiohttp is stubbed).
"""
import asyncio
import json
import os
import shutil
import sys
import types
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


class _Response:
    def __init__(self, data, status=200, headers=None):
        self.data = data
        self.status = status
        self.headers = dict(headers or {})


class _Router:
    def __init__(self):
        self.routes = []

    def add_post(self, path, handler):
        self.routes.append(("POST", path, handler))


class _Application(dict):
    def __init__(self):
        super().__init__()
        self.router = _Router()


_aiohttp = types.ModuleType("aiohttp")
_aiohttp.web = types.SimpleNamespace(
    Request=object, Response=_Response, Application=_Application,
    json_response=lambda data, status=200, headers=None: _Response(data, status, headers),
)
sys.modules["aiohttp"] = _aiohttp
sys.path.insert(0, str(HERE))
import watch_intent_api as api  # noqa: E402

REAL_BUFFERED = api.buffered

D = "watch-decision-v1"
LEGACY = "watch-intent-v1"
MODEL = "jev-1.14.0"
NODE_BIN = "/usr/bin/node"
ENTRY = "/app/dist/index.js"
BUILD_ENV = {"PATH": "/usr/bin", "SPORTSCLAW_WATCH_INTENT_ENABLED": "true"}
PRIVATE = "acct_5150"

CANDIDATES = [
    {"id": "pub_fx_chelsea_arsenal_20261025", "label": "Chelsea vs Arsenal · Premier League"},
    {"id": "pub_take_lakers_clutch", "label": "Lakers clutch moments · NBA"},
]
INTENT = {"contract": D, "stage": "intent", "text": "Watch the Chelsea game for me", "locale": "en"}
TARGET = {"contract": D, "stage": "target", "text": "follow the Lakers clutch take", "locale": "en",
          "candidates": CANDIDATES}
INTENT_OK = {"contract": D, "ok": True, "stage": "intent", "intent": "follow", "model": MODEL,
             "confidence": 0.99, "margin": 0.98}
TARGET_OK = {"contract": D, "ok": True, "stage": "target",
             "selection": {"status": "selected", "targetId": "pub_take_lakers_clutch"},
             "model": MODEL, "confidence": 0.93, "margin": 0.84}
LEGACY_BODY = {"contract": LEGACY, "text": "follow the Lakers clutch take", "locale": "en",
               "eligible": {"takes": [{"id": "take_lakers_clutch", "label": "Lakers"}], "subscriptions": []}}
LEGACY_OK = {"contract": LEGACY, "ok": True, "intent": {"action": "follow", "targetId": "take_lakers_clutch"}}


class _Content:
    def __init__(self, chunks):
        self._chunks = list(chunks)
        self.reads = 0

    async def readany(self):
        self.reads += 1
        return self._chunks.pop(0) if self._chunks else b""


class Req:
    def __init__(self, app, chunks=(), content_length=None):
        self.app = app
        self.content = _Content(chunks)
        self.content_length = content_length
        self.headers = {}


def raw(body):
    return json.dumps(body, ensure_ascii=False).encode("utf-8")


def compact(body):
    return json.dumps(body, ensure_ascii=False, separators=(",", ":"))


def allow(_request):
    return None


def denier(_request):
    return _Response({"status": False, "error": "unauthorized"}, 401)


def recorder(stdout=None, returncode=0, error=None):
    calls = []

    async def fake_buffered(cmd, env, timeout, stdin=None):
        calls.append({"cmd": list(cmd), "env": dict(env), "timeout": timeout,
                      "stdin": None if stdin is None else stdin.decode("utf-8")})
        if error is not None:
            raise error
        payload = stdout if stdout is not None else (json.dumps(INTENT_OK) + "\n").encode()
        return payload, b"worker stderr: " + PRIVATE.encode(), returncode

    api.buffered = fake_buffered
    return calls


def call(body, *, auth=allow, stdout=None, returncode=0, error=None, active=0, content_length=None,
         max_concurrency=2):
    calls = recorder(stdout=stdout, returncode=returncode, error=error)
    app = _Application()
    app["active_queries"] = active
    request = Req(app, chunks=[body if isinstance(body, bytes) else raw(body)], content_length=content_length)
    handler = api.make_watch_intent_handler(
        auth_error=auth, node_bin=NODE_BIN, entry=ENTRY, build_env=lambda: dict(BUILD_ENV),
        max_concurrency=max_concurrency, timeout=7)
    response = asyncio.run(handler(request))
    return response, calls, request, app


def worker_says(payload):
    return (json.dumps(payload) + "\n").encode()


class _Base(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.get(api.ENABLED_ENV)
        os.environ[api.ENABLED_ENV] = "true"

    def tearDown(self):
        api.buffered = REAL_BUFFERED
        os.environ.pop(api.ENABLED_ENV, None)
        if self._saved is not None:
            os.environ[api.ENABLED_ENV] = self._saved

    def assertRefusal(self, response, status, reason, contract=D, label=""):
        self.assertEqual(response.status, status, f"{label}: {response.data}")
        self.assertEqual(response.headers.get("Cache-Control"), "no-store", label)
        self.assertEqual(response.data, {"contract": contract, "ok": False, "reasonCode": reason}, label)
        body = json.dumps(response.data)
        self.assertNotIn(PRIVATE, body, label)
        self.assertNotIn("worker stderr", body, label)


class AuthAndGating(_Base):
    def test_auth_runs_before_body_flag_and_slot_for_the_new_contract(self):
        os.environ.pop(api.ENABLED_ENV, None)
        response, calls, request, app = call(INTENT, auth=denier, active=5,
                                             content_length=api.MAX_WATCH_INTENT_BODY_BYTES * 4)
        self.assertEqual(response.status, 401)
        self.assertEqual(response.headers.get("Cache-Control"), "no-store")
        self.assertEqual(request.content.reads, 0)
        self.assertEqual(calls, [])
        self.assertEqual(app["active_queries"], 5)

    def test_disabled_route_refuses_before_reading_the_body(self):
        os.environ[api.ENABLED_ENV] = "1"
        response, calls, request, _ = call(INTENT)
        self.assertRefusal(response, 503, "disabled", contract=LEGACY)
        self.assertEqual(request.content.reads, 0)
        self.assertEqual(calls, [])

    def test_declared_oversize_is_refused_unread(self):
        response, calls, request, _ = call(INTENT, content_length=api.MAX_WATCH_INTENT_BODY_BYTES + 1)
        self.assertRefusal(response, 413, "invalid_request", contract=LEGACY)
        self.assertEqual(request.content.reads, 0)
        self.assertEqual(calls, [])


class RequestValidation(_Base):
    def test_intent_is_forwarded_with_exact_keys_in_server_order(self):
        reordered = {"locale": "en", "text": INTENT["text"], "stage": "intent", "contract": D}
        response, calls, _, app = call(reordered)
        self.assertEqual(response.status, 200, response.data)
        self.assertEqual(response.data, INTENT_OK)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["cmd"], [NODE_BIN, api.worker_path(ENTRY)])
        self.assertEqual(calls[0]["env"], BUILD_ENV, "no request-derived environment")
        self.assertEqual(calls[0]["stdin"], compact(INTENT))
        self.assertEqual(app.get("active_queries", 0), 0)

    def test_target_is_forwarded_with_and_without_reference_ids(self):
        for body in (TARGET, {**TARGET, "referenceIds": [CANDIDATES[0]["id"]]}):
            response, calls, _, _ = call(dict(reversed(list(body.items()))), stdout=worker_says(TARGET_OK))
            self.assertEqual(response.data, TARGET_OK)
            self.assertEqual(calls[0]["stdin"], compact(body))
            self.assertEqual(list(json.loads(calls[0]["stdin"])), list(body))

    def test_every_bound_is_accepted_at_its_limit(self):
        candidates = [{"id": "pub_fx_%03d" % i, "label": ("%03d" % i) + "L" * 157} for i in range(100)]
        body = {"contract": D, "stage": "target", "text": "t" * 4000, "locale": "pt",
                "candidates": candidates, "referenceIds": [c["id"] for c in candidates[:10]]}
        self.assertLessEqual(len(raw(body)), api.MAX_WATCH_INTENT_BODY_BYTES)
        response, calls, _, _ = call(body, stdout=worker_says({**TARGET_OK, "selection": {
            "status": "selected", "targetId": "pub_fx_099"}}))
        self.assertEqual(response.status, 200, response.data)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["stdin"], compact(body), "no truncation")

    def test_invalid_decision_bodies_are_refused_without_dispatch(self):
        many = [{"id": "pub_fx_%03d" % i, "label": "x"} for i in range(101)]
        bad = {
            "unknown stage": {**INTENT, "stage": "select"},
            "missing stage": {k: v for k, v in INTENT.items() if k != "stage"},
            "empty text": {**INTENT, "text": "  "},
            "text over 4000": {**INTENT, "text": "x" * 4001},
            "text not string": {**INTENT, "text": ["x"]},
            "locale EN": {**INTENT, "locale": "EN"},
            "locale list": {**INTENT, "locale": ["en"]},
            "intent with candidates": {**INTENT, "candidates": CANDIDATES},
            "intent with referenceIds": {**INTENT, "referenceIds": []},
            "target missing candidates": {k: v for k, v in TARGET.items() if k != "candidates"},
            "target zero candidates": {**TARGET, "candidates": []},
            "candidates not a list": {**TARGET, "candidates": {"a": "b"}},
            "101 candidates": {**TARGET, "candidates": many},
            "label over 160": {**TARGET, "candidates": [{"id": "pub_fx_a", "label": "l" * 161}]},
            "label not string": {**TARGET, "candidates": [{"id": "pub_fx_a", "label": 7}]},
            "id not string": {**TARGET, "candidates": [{"id": 7, "label": "x"}]},
            "non-opaque id": {**TARGET, "candidates": [{"id": "pub fx", "label": "x"}]},
            "duplicate id": {**TARGET, "candidates": [CANDIDATES[0], {**CANDIDATES[0], "label": "y"}]},
            "candidate private field": {**TARGET, "candidates": [{**CANDIDATES[0], "subscriptionId": "sub_1"}]},
            "11 referenceIds": {**TARGET, "candidates": many[:11], "referenceIds": [c["id"] for c in many[:11]]},
            "nonmember referenceId": {**TARGET, "referenceIds": ["pub_fx_elsewhere"]},
            "duplicate referenceId": {**TARGET, "referenceIds": [CANDIDATES[0]["id"]] * 2},
            "referenceIds not a list": {**TARGET, "referenceIds": CANDIDATES[0]["id"]},
            "legacy eligible": {**INTENT, "eligible": {"takes": [], "subscriptions": []}},
            "subscriptions": {**TARGET, "subscriptions": [{"id": "sub_1"}]},
            "history": {**INTENT, "history": []},
            "identity": {**INTENT, "userId": PRIVATE},
            "profile": {**INTENT, "profile": {}},
        }
        for key in ("model", "provider", "endpoint", "baseUrl", "apiKey", "dataPolicy", "mode", "timeoutMs"):
            bad["request-owned " + key] = {**INTENT, key: "jev-9.9.9"}
        for label, body in bad.items():
            with self.subTest(label):
                response, calls, _, app = call(body)
                self.assertRefusal(response, 400, "invalid_request", label=label)
                self.assertEqual(calls, [], label)
                self.assertEqual(app["active_queries"], 0, label)

    def test_body_over_32kib_after_reserialization_is_refused(self):
        body = {**TARGET, "candidates": [{"id": "pub_fx_%03d" % i, "label": "é" * 160} for i in range(100)]}
        self.assertGreater(len(raw(body)), api.MAX_WATCH_INTENT_BODY_BYTES)
        response, calls, _, _ = call(body)
        self.assertIn(response.status, (400, 413))
        self.assertEqual(response.data["reasonCode"], "invalid_request")
        self.assertEqual(calls, [])


class ResultValidation(_Base):
    def test_valid_results_pass_through_as_200(self):
        for name, body, result in [
            ("intent clarify", INTENT, {**INTENT_OK, "intent": "clarify", "confidence": 0.59, "margin": 0.46}),
            ("intent none", INTENT, {**INTENT_OK, "intent": "none"}),
            ("target no_match", TARGET, {**TARGET_OK, "selection": {"status": "no_match", "targetId": None}}),
            ("target clarify", TARGET, {**TARGET_OK, "selection": {"status": "clarify", "targetId": None}}),
            ("typed failure", INTENT, {"contract": D, "ok": False, "reasonCode": "inference_unavailable"}),
            ("typed disabled", TARGET, {"contract": D, "ok": False, "reasonCode": "disabled"}),
        ]:
            with self.subTest(name):
                response, _, _, _ = call(body, stdout=worker_says(result))
                self.assertEqual(response.status, 200, name)
                self.assertEqual(response.data, result, name)

    def test_untyped_or_mismatched_results_are_invalid_response(self):
        target_sel = lambda status, target_id: {**TARGET_OK, "selection": {"status": status, "targetId": target_id}}  # noqa: E731
        bad = [
            ("legacy action name", INTENT, {**INTENT_OK, "intent": "ambiguous"}),
            ("probe label leaks", INTENT, {**INTENT_OK, "intent": "stop"}),
            ("extra key", INTENT, {**INTENT_OK, "userId": PRIVATE}),
            ("missing margin", INTENT, {k: v for k, v in INTENT_OK.items() if k != "margin"}),
            ("non-Jev model", INTENT, {**INTENT_OK, "model": "gpt-4o"}),
            ("other Jev version", INTENT, {**INTENT_OK, "model": "jev-1.13.0"}),
            ("decided below confidence", INTENT, {**INTENT_OK, "confidence": 0.79}),
            ("decided below margin", INTENT, {**INTENT_OK, "margin": 0.1}),
            ("selected below policy", TARGET, {**TARGET_OK, "confidence": 0.5}),
            ("no_match below policy", TARGET, {**target_sel("no_match", None), "margin": 0.05}),
            ("unhashable intent", INTENT, {**INTENT_OK, "intent": ["follow"]}),
            ("stringly confidence", INTENT, {**INTENT_OK, "confidence": "0.99"}),
            ("confidence over 1", INTENT, {**INTENT_OK, "confidence": 1.2}),
            ("confidence bool", INTENT, {**INTENT_OK, "confidence": True}),
            ("margin negative", INTENT, {**INTENT_OK, "margin": -0.1}),
            ("stage mismatch", INTENT, TARGET_OK),
            ("stage mismatch reversed", TARGET, INTENT_OK),
            ("legacy contract answer", INTENT, LEGACY_OK),
            ("model-authored target", TARGET, target_sel("selected", "pub_fx_injected")),
            ("selected without target", TARGET, target_sel("selected", None)),
            ("no_match with target", TARGET, target_sel("no_match", CANDIDATES[0]["id"])),
            ("unknown status", TARGET, target_sel("ambiguous", None)),
            ("selection extra key", TARGET, {**TARGET_OK, "selection": {**TARGET_OK["selection"], "subId": "s"}}),
            ("unknown reason", INTENT, {"contract": D, "ok": False, "reasonCode": "boom"}),
            ("raw error", INTENT, {"contract": D, "ok": False, "reasonCode": "timeout", "error": "trace"}),
        ]
        for name, body, result in bad:
            with self.subTest(name):
                response, _, _, app = call(body, stdout=worker_says(result))
                self.assertRefusal(response, 502, "invalid_response", label=name)
                self.assertEqual(app["active_queries"], 0, name)

    def test_worker_failures_use_the_request_contract_and_release_the_slot(self):
        for name, kwargs, status, reason in [
            ("timeout", {"error": asyncio.TimeoutError()}, 504, "timeout"),
            ("spawn failed", {"error": OSError("no such executable")}, 502, "inference_unavailable"),
            ("nonzero exit", {"returncode": 1}, 502, "inference_unavailable"),
            ("not json", {"stdout": b"crash " + PRIVATE.encode()}, 502, "invalid_response"),
        ]:
            with self.subTest(name):
                response, _, _, app = call(TARGET, **kwargs)
                self.assertRefusal(response, status, reason, label=name)
                self.assertEqual(app["active_queries"], 0, name)

    def test_capacity_is_shared_and_refused_without_dispatch(self):
        response, calls, _, app = call(INTENT, active=2, max_concurrency=2)
        self.assertRefusal(response, 429, "inference_unavailable")
        self.assertEqual(calls, [])
        self.assertEqual(app["active_queries"], 2)

    def test_process_backstop_outlives_the_jev_deadline(self):
        # JevDecisionClient / worker deadline is 8s.
        self.assertGreater(api.WATCH_INTENT_PROCESS_TIMEOUT_SEC, 8)
        self.assertLessEqual(api.WATCH_INTENT_PROCESS_TIMEOUT_SEC, 30)


class LegacyUnchanged(_Base):
    def test_legacy_request_and_result_still_round_trip(self):
        response, calls, _, _ = call(LEGACY_BODY, stdout=worker_says(LEGACY_OK))
        self.assertEqual(response.data, LEGACY_OK)
        self.assertEqual(calls[0]["stdin"], compact(LEGACY_BODY))

    def test_legacy_request_rejects_a_decision_answer(self):
        response, _, _, _ = call(LEGACY_BODY, stdout=worker_says(INTENT_OK))
        self.assertRefusal(response, 502, "invalid_response", contract=LEGACY)

    def test_legacy_request_cannot_carry_decision_fields(self):
        response, calls, _, _ = call({**LEGACY_BODY, "stage": "intent"})
        self.assertRefusal(response, 400, "invalid_request", contract=LEGACY)
        self.assertEqual(calls, [])


class CompiledWorkerInterop(_Base):
    """Actual handler + actual buffered() + compiled worker. No credential: no egress."""

    def run_real(self, body, extra_env):
        node = os.environ.get("WD_NODE_BIN") or shutil.which("node")
        self.assertTrue(node, "node is required")
        entry = REPO / "dist" / "index.js"
        self.assertTrue((REPO / "dist" / "watch-intent-relay.js").exists(), "build first")
        env = {"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "/tmp"),
               "SPORTSCLAW_WATCH_INTENT_ENABLED": "true", **extra_env}
        api.buffered = REAL_BUFFERED
        app = _Application()
        handler = api.make_watch_intent_handler(
            auth_error=allow, node_bin=node, entry=str(entry), build_env=lambda: dict(env),
            max_concurrency=2, timeout=30)
        response = asyncio.run(handler(Req(app, chunks=[raw(body)])))
        self.assertEqual(app.get("active_queries", 0), 0)
        return response

    def test_missing_credential_is_typed_unavailable(self):
        response = self.run_real(TARGET, {"SPORTSCLAW_WATCH_JEV_ENABLED": "true",
                                          "SPORTSCLAW_WATCH_JEV_DATA_POLICY": "cloud_allowed"})
        self.assertEqual(response.status, 200, response.data)
        self.assertEqual(response.data, {"contract": D, "ok": False, "reasonCode": "inference_unavailable"})

    def test_local_only_policy_is_typed_disabled(self):
        response = self.run_real(INTENT, {"SPORTSCLAW_WATCH_JEV_ENABLED": "true",
                                          "SPORTSCLAW_WATCH_JEV_DATA_POLICY": "local_only"})
        self.assertEqual(response.status, 200, response.data)
        self.assertEqual(response.data, {"contract": D, "ok": False, "reasonCode": "disabled"})


if __name__ == "__main__":
    unittest.main()
