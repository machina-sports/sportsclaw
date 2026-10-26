"""Relay slip contract — `slip-turn-v1` through the real relay handlers.

Covers docker/relay/slip_contract.py (stdlib-only mirror of the engine wire in
src/slip-output.ts) and its use by relay_server.query_sync / capabilities:

  - strict SlipTurnInput / SlipTurnResult validation and the canonical hash
    (sort_keys, separators=(",", ":"), ensure_ascii=False), Unicode included;
  - server-environment gates checked before any subprocess is spawned;
  - the slip rides on the child's stdin with the caller history, never argv or
    the environment; legacy requests are unchanged;
  - success requires exactly one valid result whose inputHash matches this
    request; missing, malformed, duplicate or unrequested slip output fails
    closed;
  - nothing private (request text, context IDs, answer prose) is logged.

aiohttp is stubbed and the SportsClaw CLI is a fake Python script that records
argv/stdin and prints scripted NDJSON. No Docker, network or credentials.
Run: cd docker/relay && python3 -m unittest test_slip_contract
"""

import asyncio
import contextlib
import hashlib
import io
import json
import os
import shutil
import sys
import tempfile
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN = "relay-slip-test-token-0123456789"
MODEL = "jev-1.14.0"
GATE_KEYS = ("SPORTSCLAW_SLIP_ENABLED", "SPORTSCLAW_SLIP_JEV_DATA_POLICY",
             "SPORTSCLAW_SLIP_NATIVE_ONLY", "SPORTSCLAW_WATCH_INTENT_NATIVE_CONFIG")
GATES = {"SPORTSCLAW_SLIP_ENABLED": "true", "SPORTSCLAW_SLIP_JEV_DATA_POLICY": "cloud_allowed"}

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
        "env_leaks": sorted(k for k, v in os.environ.items() if "PRIVATE" in v or "SENTINEL" in v),
    }) + "\n")
with open(os.environ["FAKE_STDOUT"], encoding="utf-8") as handle:
    sys.stdout.write(handle.read())
'''


def sid(prefix, tag):
    return f"{prefix}_{(tag + '0' * 22)[:22]}"


REV_ID = sid("slr", "SENTINELrev")
LEG_IDS = [sid("sll", "SENTINELlegA"), sid("sll", "SENTINELlegB")]
LEG_A = {"event": "PRIVATE_LEG Chelsea vs Arsenal", "market": "Match result", "selection": "Chelsea",
         "period": None, "line": None, "quotedOdds": {"value": "2.10", "format": "decimal"},
         "source": "user_text", "unresolved": []}
LEG_B = {"event": "Flamengo vs Palmeiras", "market": "Total goals", "selection": "Over",
         "period": None, "line": "2.5", "quotedOdds": {"value": "+120", "format": "american"},
         "source": "user_image", "unresolved": []}
SUGGESTED = {"event": "Lakers vs Celtics", "market": "Spread", "selection": "Lakers", "period": None,
             "line": "-3.5", "quotedOdds": None, "source": "agent_suggestion", "unresolved": []}
CONTEXT = {
    "contract": "slip-revision-v1", "slipId": sid("slp", "SENTINELslip"), "revisionId": REV_ID,
    "parentRevisionId": None, "status": "proposed",
    "legs": [dict(LEG_A, id=LEG_IDS[0]), dict(LEG_B, id=LEG_IDS[1])], "unresolved": [],
}
REQUEST = "PRIVATE_REQUEST drop the Flamengo leg é😀"
PROSE = "PRIVATE_PROSE Removed the Flamengo leg from your draft. No bet placed."
HISTORY = [{"role": "user", "content": "PRIVATE_HISTORY earlier"}, {"role": "assistant", "content": "Noted."}]
PRIVATE_MARKERS = ("PRIVATE_REQUEST", "PRIVATE_LEG", "PRIVATE_PROSE", "PRIVATE_HISTORY", "SENTINEL")


def copy(value):
    return json.loads(json.dumps(value))


def turn(text=REQUEST, context=CONTEXT, **extra):
    return dict({"contract": "slip-turn-v1", "requestText": text, "context": copy(context)}, **extra)


def change(action, base=None, targets=(), legs=()):
    return {"contract": "slip-change-v1", "action": action, "baseRevisionId": base,
            "targetLegIds": list(targets), "legs": copy(list(legs)), "unresolved": []}


REMOVE_B = change("remove", base=REV_ID, targets=[LEG_IDS[1]])


def oracle_hash(value):
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def selected(c):
    return {"contract": "slip-decision-v1", "ok": True,
            "decision": {"status": "selected", "change": copy(c), "model": MODEL}}


def result(slip_input, decision, **extra):
    return dict({"contract": "slip-turn-v1", "inputHash": oracle_hash(slip_input), "decision": decision}, **extra)


# ---------------------------------------------------------------------------
# Module setup: stub aiohttp, point the relay at the fake CLI, then import
# ---------------------------------------------------------------------------

relay_server = None
slip_contract = None
WORK = None


class _Response:
    def __init__(self, data, status=200, headers=None):
        self.data = data
        self.status = status
        self.headers = headers or {}


def setUpModule():
    global relay_server, slip_contract, WORK
    WORK = tempfile.mkdtemp(prefix="sportsclaw-relay-slip-")
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
    import slip_contract as contract  # noqa: E402
    relay_server, slip_contract = relay, contract


def tearDownModule():
    shutil.rmtree(WORK, ignore_errors=True)


class Req:
    def __init__(self, body):
        self._body = body
        self.app = {}
        self.headers = {"X-Auth-Token": TOKEN}

    async def json(self):
        return copy(self._body)


class RelayCase(unittest.TestCase):
    def setUp(self):
        self._saved = {k: os.environ.get(k) for k in GATE_KEYS}
        for key in GATE_KEYS:
            os.environ.pop(key, None)
        for name in ("FAKE_LOG", "FAKE_STDOUT"):
            open(os.environ[name], "w").close()

    def tearDown(self):
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def gates(self, **patch):
        os.environ.update(dict(GATES, **patch))

    def child_prints(self, *events):
        with open(os.environ["FAKE_STDOUT"], "w", encoding="utf-8") as handle:
            for event in events:
                handle.write(json.dumps(event, ensure_ascii=False) + "\n")

    def spawned(self):
        with open(os.environ["FAKE_LOG"], encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]

    def call(self, handler, body=None):
        logs = io.StringIO()
        with contextlib.redirect_stdout(logs):
            response = asyncio.run(handler(Req(body or {})))
        self.assertPrivateFree(logs.getvalue(), "relay logs")
        return response

    def query(self, body):
        response = self.call(relay_server.query_sync, body)
        if response.status != 200:
            self.assertIs(response.data.get("status"), False)
            self.assertNotIn("text", response.data, "no prose without a verified acknowledgement")
            self.assertNotIn("slip", response.data)
            self.assertPrivateFree(json.dumps(response.data, ensure_ascii=False), "error body")
            self.assertNotIn(TOKEN, json.dumps(response.data))
        return response

    def assertPrivateFree(self, text, where):
        for marker in PRIVATE_MARKERS:
            self.assertNotIn(marker, text, f"{where} must not carry {marker}")


def slip_body(slip_input=None, **extra):
    slip_input = turn() if slip_input is None else slip_input
    return dict({"prompt": slip_input.get("requestText", REQUEST) if isinstance(slip_input, dict) else REQUEST,
                 "history_mode": "caller", "history": copy(HISTORY), "slip": slip_input}, **extra)


# ---------------------------------------------------------------------------
# slip_contract: the wire itself
# ---------------------------------------------------------------------------

class SlipContractWire(RelayCase):
    def test_hash_is_canonical_sorted_utf8_json(self):
        value = turn()
        self.assertEqual(slip_contract.hash_slip_turn_input(value), oracle_hash(value))
        reordered = {"context": copy(CONTEXT), "requestText": REQUEST, "contract": "slip-turn-v1"}
        self.assertEqual(slip_contract.hash_slip_turn_input(reordered), oracle_hash(value))
        self.assertNotEqual(slip_contract.hash_slip_turn_input(turn(REQUEST + " ")), oracle_hash(value))

    def test_valid_inputs(self):
        for value in (turn(), turn("Make me a slip", None), turn("😀" * 2000, None)):
            self.assertEqual(slip_contract.parse_slip_turn_input(copy(value)), value)

    def test_invalid_inputs(self):
        cases = {
            "wrong contract": turn(contract="slip-turn-v2"),
            "extra history": turn(history=HISTORY),
            "owner override": turn(ownerId="acct_5150"),
            "missing context": {"contract": "slip-turn-v1", "requestText": REQUEST},
            "blank request": turn("   "),
            "request over 4000 UTF-16 units": turn("😀" * 2001, None),
            "unpaired surrogate": turn("Chelsea \ud800", None),
            "invalid context": turn(context=dict(copy(CONTEXT), ownerId="acct_5150")),
            "priced agent suggestion": turn(context=dict(copy(CONTEXT), legs=[
                dict(SUGGESTED, id=LEG_IDS[0], quotedOdds={"value": "1.91", "format": "decimal"})])),
            "not an object": "drop the leg",
        }
        for label, value in cases.items():
            with self.subTest(label):
                self.assertIsNone(slip_contract.parse_slip_turn_input(value))

    def test_agent_suggestion_context_without_price(self):
        context = dict(copy(CONTEXT), legs=[dict(LEG_A, id=LEG_IDS[0]), dict(SUGGESTED, id=LEG_IDS[1])])
        self.assertIsNotNone(slip_contract.parse_slip_turn_input(turn(context=context)))

    def test_results(self):
        value = turn()
        good = [
            result(value, None), result(value, selected(REMOVE_B)),
            result(value, {"contract": "slip-decision-v1", "ok": True, "decision": {"status": "clarify", "model": MODEL}}),
            result(value, {"contract": "slip-decision-v1", "ok": False, "reasonCode": "invalid_response"}),
        ]
        for item in good:
            with self.subTest(item=item["decision"]):
                self.assertEqual(slip_contract.parse_slip_turn_result(copy(item), value), item)
        bad = {
            "other request hash": result(turn("other"), None),
            "saved claim": result(value, selected(REMOVE_B), saved=True),
            "raw error": result(value, {"contract": "slip-decision-v1", "ok": False,
                                        "reasonCode": "inference_unavailable", "error": "ECONNRESET"}),
            "unknown reason": result(value, {"contract": "slip-decision-v1", "ok": False, "reasonCode": "rate_limited"}),
            "model confirm": result(value, selected(change("confirm", base=REV_ID))),
            "unknown target": result(value, selected(change("remove", base=REV_ID, targets=[sid("sll", "x")]))),
        }
        for label, item in bad.items():
            with self.subTest(label):
                self.assertIsNone(slip_contract.parse_slip_turn_result(item, value))


# ---------------------------------------------------------------------------
# relay_server: capabilities, gates, stdin, acknowledgement
# ---------------------------------------------------------------------------

class SlipRelay(RelayCase):
    def test_capabilities_report_slip_only_when_permitted(self):
        self.assertNotIn("slip_contract", self.call(relay_server.capabilities).data)
        self.gates()
        self.assertEqual(self.call(relay_server.capabilities).data.get("slip_contract"), "slip-turn-v1")
        self.gates(SPORTSCLAW_SLIP_NATIVE_ONLY="true")
        self.assertNotIn("slip_contract", self.call(relay_server.capabilities).data)

    def test_gates_refuse_before_spawning(self):
        for label, env in {
            "disabled": {},
            "local_only": dict(GATES, SPORTSCLAW_SLIP_JEV_DATA_POLICY="local_only"),
            "native-only": dict(GATES, SPORTSCLAW_SLIP_NATIVE_ONLY="true"),
            "watch native route": dict(GATES, SPORTSCLAW_WATCH_INTENT_NATIVE_CONFIG='{"route":"nim"}'),
        }.items():
            with self.subTest(label):
                for key in GATE_KEYS:
                    os.environ.pop(key, None)
                os.environ.update(env)
                self.child_prints({"type": "result", "text": PROSE, "slip": result(turn(), None)})
                self.assertNotEqual(self.query(slip_body()).status, 200)
                self.assertEqual(self.spawned(), [], "no subprocess before the gate")

    def test_invalid_requests_refuse_before_spawning(self):
        self.gates()
        cases = {
            "invalid slip": slip_body(turn(ownerId="acct_5150")),
            "unpaired surrogate": slip_body(turn("Chelsea \ud800")),
            "engine history mode": dict(slip_body(), history_mode="engine"),
            "no history mode": {k: v for k, v in slip_body().items() if k not in ("history_mode", "history")},
        }
        for label, body in cases.items():
            with self.subTest(label):
                self.assertEqual(self.query(body).status, 400)
        self.assertEqual(self.spawned(), [])

    def test_stream_refuses_slip(self):
        self.gates()
        response = self.call(relay_server.query_stream, slip_body())
        self.assertEqual(response.status, 400)
        self.assertEqual(self.spawned(), [])

    def test_valid_slip_round_trip(self):
        self.gates()
        value = turn()
        typed = result(value, selected(REMOVE_B))
        self.child_prints({"type": "start"}, {"type": "result", "text": PROSE, "slip": typed})
        response = self.query(slip_body(value))
        self.assertEqual(response.status, 200, response.data)
        self.assertIs(response.data["status"], True)
        self.assertEqual(response.data["slip"], typed)
        self.assertEqual(response.data["text"], PROSE)
        [child] = self.spawned()
        self.assertEqual(json.loads(child["stdin"]), {"history": HISTORY, "slip": value})
        argv = json.dumps(child["argv"], ensure_ascii=False)
        for marker in ("SENTINEL", "PRIVATE_LEG", "slip-turn-v1", "PRIVATE_HISTORY"):
            self.assertNotIn(marker, argv)
        self.assertEqual(child["env_leaks"], [], "slip never travels in the environment")

    def test_unacknowledged_or_mismatched_output_fails_closed(self):
        self.gates()
        value = turn()
        good = result(value, None)
        cases = {
            "missing slip": [{"type": "result", "text": PROSE}],
            "wrong hash": [{"type": "result", "text": PROSE, "slip": result(turn("other request"), None)}],
            "malformed decision": [{"type": "result", "text": PROSE,
                                    "slip": result(value, selected(change("confirm", base=REV_ID)))}],
            "duplicate result": [{"type": "result", "text": PROSE, "slip": good},
                                 {"type": "result", "text": PROSE, "slip": good}],
            "conflicting result": [{"type": "result", "text": PROSE, "slip": good},
                                   {"type": "result", "text": PROSE, "slip": result(value, selected(REMOVE_B))}],
        }
        for label, events in cases.items():
            with self.subTest(label):
                self.child_prints(*events)
                response = self.query(slip_body(value))
                self.assertNotEqual(response.status, 200)

    def test_legacy_requests_unchanged(self):
        self.child_prints({"type": "result", "text": "Chelsea won 2-1."})
        response = self.query({"prompt": "Who won?", "history_mode": "caller", "history": copy(HISTORY)})
        self.assertEqual(response.status, 200)
        self.assertNotIn("slip", response.data)
        self.assertEqual(response.data["history_contract"], "structured-v1")
        [child] = self.spawned()
        self.assertEqual(json.loads(child["stdin"]), {"history": HISTORY})

        open(os.environ["FAKE_LOG"], "w").close()
        response = self.query({"prompt": "Who won?"})
        self.assertEqual(response.status, 200)
        self.assertEqual(response.data["text"], "Chelsea won 2-1.")
        [child] = self.spawned()
        self.assertIsNone(child["stdin"])

    def test_unrequested_slip_output_fails_closed(self):
        self.gates()
        self.child_prints({"type": "result", "text": "Chelsea won 2-1.", "slip": result(turn("Who won?", None), None)})
        response = self.query({"prompt": "Who won?"})
        self.assertNotEqual(response.status, 200)


if __name__ == "__main__":
    unittest.main()
