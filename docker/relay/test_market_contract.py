"""Relay market contract — `market-turn-v1` through the real relay handlers.

Covers docker/relay/market_contract.py (stdlib-only mirror of the engine's
market card wire) and its use by relay_server.query_sync / query_stream /
capabilities:

  - strict MarketTurnInput / MarketTurnResult / market-card-v1 validation,
    including exact keys, UTF-16 lengths, control characters, lone
    surrogates and booleans never passing as numbers; `checkedAt` is
    required with cards and with `none_found`, and refused with `denied`;
  - the server gate and caller-history requirement are checked before any
    subprocess is spawned; streams refuse market requests;
  - the market input rides on the child's stdin, never argv or the
    environment, beside an artifact and/or slip input; legacy requests are
    unchanged;
  - success requires exactly one result echoing this request's nonce;
    missing, malformed, duplicate or unrequested market output fails closed;
  - market questions and outcome names never reach the relay logs.

aiohttp is stubbed and the SportsClaw CLI is a fake Python script that records
argv/stdin and prints scripted NDJSON. No Docker, network or credentials.
Run: cd docker/relay && python3 -m unittest test_market_contract
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
TOKEN = "relay-market-test-token-01234567"
GATE = "SPORTSCLAW_MARKET_CARDS_ENABLED"
ARTIFACT_GATE = "SPORTSCLAW_ARTIFACTS_ENABLED"
SLIP_GATES = {"SPORTSCLAW_SLIP_ENABLED": "true", "SPORTSCLAW_SLIP_JEV_DATA_POLICY": "cloud_allowed"}
OTHER_GATES = (ARTIFACT_GATE, *SLIP_GATES, "SPORTSCLAW_SLIP_NATIVE_ONLY", "SPORTSCLAW_WATCH_INTENT_NATIVE_CONFIG")

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
TURN = {"contract": "market-turn-v1", "nonce": NONCE}
CARD = {
    "contract": "market-card-v1", "venue": "polymarket", "id": "0xabc_123-DEF",
    "question": "PRIVATE_QUESTION Will Flamengo beat Palmeiras? é😀",
    "slug": "will-flamengo-beat-palmeiras", "eventSlug": "bra-fla-pal-2026-11-29", "status": "active",
    "outcomes": [{"name": "PRIVATE_OUTCOME Yes", "price": 0.62}, {"name": "No", "price": 0.38}],
    "volume": 152340.5, "liquidity": 20411, "gameStartTime": "2026-11-29 21:30:00+00",
    "readAt": "2026-11-27T14:03:22.418Z",
}
SPARSE = dict(CARD, id="2", slug="", eventSlug=None, status="closed", volume=None, liquidity=None,
              gameStartTime=None, outcomes=[{"name": "A", "price": 0}, {"name": "B", "price": 1},
                                            {"name": "C", "price": 0.5}, {"name": "D", "price": 0.25}])
HISTORY = [{"role": "user", "content": "earlier"}, {"role": "assistant", "content": "Noted."}]
PROSE = "Flamengo are favored at 62 percent."
PRIVATE_MARKERS = ("PRIVATE_QUESTION", "PRIVATE_OUTCOME")

ARTIFACT_TURN = {"contract": "artifact-turn-v1", "nonce": "nonce_artifact_abc12345"}
ARTIFACT_RESULT = dict(ARTIFACT_TURN, artifact=None, reasonCode=None)
SLIP_TURN = {"contract": "slip-turn-v1", "requestText": "Make me a slip", "context": None}


def copy(value):
    return json.loads(json.dumps(value))


def card(**changes):
    return dict(copy(CARD), **changes)


def without(value, key):
    return {k: v for k, v in value.items() if k != key}


def outcomes(*replacement):
    return [*replacement, {"name": "No", "price": 0.38}]


CHECKED_AT = "2026-11-27T14:03:25.007Z"
_DEFAULT = object()


def result(markets=(), reason=None, nonce=NONCE, checked=_DEFAULT, **extra):
    """A result; by default checkedAt is set exactly when the shape requires one (cards or none_found)."""
    if checked is _DEFAULT:
        checked = CHECKED_AT if markets or reason == "none_found" else None
    return dict({"contract": "market-turn-v1", "nonce": nonce, "markets": copy(list(markets)), "reasonCode": reason,
                 "checkedAt": checked}, **extra)


def body(market_input=None, **extra):
    return dict({"prompt": "Who is favored, Flamengo or Palmeiras?", "history_mode": "caller",
                 "history": copy(HISTORY), "market": copy(TURN) if market_input is None else market_input}, **extra)


relay_server = None
market_contract = None
slip_contract = None
WORK = None


class _Response:
    def __init__(self, data, status=200, headers=None):
        self.data = data
        self.status = status
        self.headers = headers or {}


def setUpModule():
    global relay_server, market_contract, slip_contract, WORK
    WORK = tempfile.mkdtemp(prefix="sportsclaw-relay-market-")
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
    import market_contract as contract  # noqa: E402
    import slip_contract as slips  # noqa: E402
    relay_server, market_contract, slip_contract = relay, contract, slips


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
        self._saved = {key: os.environ.get(key) for key in (GATE, *OTHER_GATES)}
        for key in self._saved:
            os.environ.pop(key, None)
        for name in ("FAKE_LOG", "FAKE_STDOUT"):
            open(os.environ[name], "w").close()

    def tearDown(self):
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

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
            self.assertNotIn("market", response.data)
        return response


class MarketContractWire(RelayCase):
    def test_gate_reads_only_the_exact_true_value(self):
        self.assertTrue(market_contract.market_cards_enabled({GATE: "true"}))
        for env in ({}, {GATE: "1"}, {GATE: "TRUE"}, {GATE: ""}, {ARTIFACT_GATE: "true"}):
            with self.subTest(env=env):
                self.assertFalse(market_contract.market_cards_enabled(env))

    def test_valid_cards_and_turn(self):
        self.assertEqual(market_contract.parse_market_turn_input(copy(TURN)), TURN)
        self.assertEqual(market_contract.parse_market_card(copy(CARD)), CARD)
        self.assertEqual(market_contract.parse_market_card(copy(SPARSE)), SPARSE)
        for label, value in {
            "id at 64 chars": card(id="a" * 64),
            "question at 300 UTF-16 units": card(question="😀" * 150),
            "slug at 200 chars": card(slug="a" * 200, eventSlug="b" * 200),
            "outcome name at 80 UTF-16 units": card(outcomes=outcomes({"name": "é" * 80, "price": 1})),
            "integer price and totals": card(outcomes=outcomes({"name": "Yes", "price": 1}), volume=0, liquidity=0),
            "game start at 40 chars": card(gameStartTime="x" * 40),
            "inactive": card(status="inactive"),
        }.items():
            with self.subTest(label):
                self.assertEqual(market_contract.parse_market_card(copy(value)), value)

    def test_parsers_return_fresh_copies(self):
        source = copy(CARD)
        parsed = market_contract.parse_market_card(source)
        parsed["outcomes"][0]["price"] = 0.99
        parsed["outcomes"].append({"name": "Draw", "price": 0})
        self.assertEqual(source, CARD)
        wrapped = result([source])
        turn = market_contract.parse_market_turn_result(wrapped, TURN)
        self.assertIsNot(turn["markets"], wrapped["markets"])
        self.assertIsNot(turn["markets"][0], source)

    def test_invalid_turn_inputs(self):
        for label, value in {
            "wrong contract": dict(TURN, contract="market-turn-v2"),
            "artifact contract": dict(TURN, contract="artifact-turn-v1"),
            "short nonce": dict(TURN, nonce="abc"),
            "nonce over 64": dict(TURN, nonce="a" * 65),
            "nonce with slash": dict(TURN, nonce="a" * 20 + "/x"),
            "nonce with trailing newline": dict(TURN, nonce="a" * 20 + "\n"),
            "nonce not a string": dict(TURN, nonce=1234567890123456),
            "owner override": dict(TURN, ownerId="acct_5150"),
            "enable override": dict(TURN, enabled=True),
            "missing nonce": {"contract": "market-turn-v1"},
            "missing contract": {"nonce": NONCE},
            "not an object": "markets please",
            "a list": [TURN],
            "null": None,
        }.items():
            with self.subTest(label):
                self.assertIsNone(market_contract.parse_market_turn_input(value))

    def test_cards_need_exact_keys(self):
        for key in CARD:
            with self.subTest(missing=key):
                self.assertIsNone(market_contract.parse_market_card(without(CARD, key)))
        for label, value in {
            "extra url": card(url="https://polymarket.com/event/abc"),
            "extra token ids": card(clobTokenIds=["1", "2"]),
            "not an object": "card",
            "a list": [CARD],
            "null": None,
        }.items():
            with self.subTest(label):
                self.assertIsNone(market_contract.parse_market_card(value))

    def test_invalid_card_fields(self):
        for label, value in {
            "wrong contract": card(contract="market-card-v2"),
            "wrong venue": card(venue="kalshi"),
            "empty id": card(id=""),
            "id over 64": card(id="a" * 65),
            "id with slash": card(id="abc/def"),
            "id with trailing newline": card(id="abc\n"),
            "id not a string": card(id=12345),
            "blank question": card(question="   "),
            "empty question": card(question=""),
            "question over 300 UTF-16 units": card(question="😀" * 151),
            "question with newline": card(question="a\nb"),
            "question with C1 control": card(question="a\x85b"),
            "question with lone surrogate": dict(CARD, question="a\ud800b"),
            "question not a string": card(question=["Will it?"]),
            "slug over 200": card(slug="a" * 201),
            "slug with uppercase": card(slug="Will-Flamengo"),
            "slug with underscore": card(slug="will_flamengo"),
            "slug null": card(slug=None),
            "empty event slug": card(eventSlug=""),
            "event slug over 200": card(eventSlug="a" * 201),
            "event slug with slash": card(eventSlug="event/abc"),
            "event slug not a string": card(eventSlug=7),
            "unknown status": card(status="resolved"),
            "status not a string": card(status=["active"]),
            "status null": card(status=None),
            "negative volume": card(volume=-1),
            "volume as string": card(volume="152340.5"),
            "volume NaN": dict(CARD, volume=float("nan")),
            "volume infinite": dict(CARD, volume=float("inf")),
            "volume beyond a double": dict(CARD, volume=10 ** 400),
            "negative liquidity": card(liquidity=-0.01),
            "liquidity as list": card(liquidity=[1]),
            "empty game start": card(gameStartTime=""),
            "game start over 40": card(gameStartTime="x" * 41),
            "game start with control": card(gameStartTime="2026-11-29\t21:30"),
            "game start not a string": card(gameStartTime=1795987800),
            "readAt without millis": card(readAt="2026-11-27T14:03:22Z"),
            "readAt with offset": card(readAt="2026-11-27T14:03:22.418+00:00"),
            "readAt with trailing newline": card(readAt="2026-11-27T14:03:22.418Z\n"),
            "readAt with non-ASCII digits": card(readAt="２０２６-11-27T14:03:22.418Z"),
            "readAt null": card(readAt=None),
            "readAt epoch": card(readAt=1795789402418),
        }.items():
            with self.subTest(label):
                self.assertIsNone(market_contract.parse_market_card(value))

    def test_invalid_outcomes(self):
        yes = {"name": "Yes", "price": 0.62}
        for label, value in {
            "one outcome": [yes],
            "no outcomes": [],
            "five outcomes": [dict(yes, name=str(index)) for index in range(5)],
            "not a list": {"Yes": 0.62, "No": 0.38},
            "null": None,
            "outcome not an object": outcomes("Yes"),
            "missing price": outcomes({"name": "Yes"}),
            "missing name": outcomes({"price": 0.62}),
            "extra token id": outcomes(dict(yes, tokenId="123")),
            "blank name": outcomes(dict(yes, name=" ")),
            "name over 80 UTF-16 units": outcomes(dict(yes, name="😀" * 41)),
            "name with control": outcomes(dict(yes, name="Y\x00es")),
            "name with lone surrogate": outcomes(dict(yes, name="Yes\udfff")),
            "name not a string": outcomes(dict(yes, name=1)),
            "price above one": outcomes(dict(yes, price=1.01)),
            "negative price": outcomes(dict(yes, price=-0.01)),
            "price as string": outcomes(dict(yes, price="0.62")),
            "price null": outcomes(dict(yes, price=None)),
            "price NaN": outcomes(dict(yes, price=float("nan"))),
            "price infinite": outcomes(dict(yes, price=float("inf"))),
        }.items():
            with self.subTest(label):
                self.assertIsNone(market_contract.parse_market_card(dict(CARD, outcomes=value)))

    def test_booleans_never_pass_as_numbers(self):
        for label, value in {
            "price true": dict(CARD, outcomes=outcomes({"name": "Yes", "price": True})),
            "price false": dict(CARD, outcomes=outcomes({"name": "Yes", "price": False})),
            "volume true": dict(CARD, volume=True),
            "volume false": dict(CARD, volume=False),
            "liquidity true": dict(CARD, liquidity=True),
            "liquidity false": dict(CARD, liquidity=False),
        }.items():
            with self.subTest(label):
                self.assertIsNone(market_contract.parse_market_card(value))

    def test_results_bind_to_the_nonce(self):
        parse = market_contract.parse_market_turn_result
        self.assertEqual(parse(result([CARD]), TURN), result([CARD]))
        self.assertEqual(parse(result([CARD, SPARSE, card(id="3")]), TURN)["markets"], [CARD, SPARSE, card(id="3")])
        self.assertEqual(parse(result(), TURN), result())
        self.assertEqual(parse(result(reason="denied"), TURN), result(reason="denied"))
        self.assertEqual(parse(result(reason="none_found"), TURN), result(reason="none_found"))
        self.assertEqual(parse(result(checked=CHECKED_AT), TURN), result(checked=CHECKED_AT),
                         "no cards and no reason, after a polymarket call")
        self.assertEqual(set(parse(result(), TURN)), {"contract", "nonce", "markets", "reasonCode", "checkedAt"})
        for label, value in {
            "missing checkedAt": without(result([CARD]), "checkedAt"),
            "missing checkedAt without cards": without(result(), "checkedAt"),
            "cards with null checkedAt": result([CARD], checked=None),
            "cards with none_found": result([CARD], reason="none_found"),
            "none_found with null checkedAt": result(reason="none_found", checked=None),
            "denied with checkedAt": result(reason="denied", checked=CHECKED_AT),
            "checkedAt without millis": result(checked="2026-11-27T14:03:25Z"),
            "checkedAt with offset": result(checked="2026-11-27T14:03:25.007+00:00"),
            "checkedAt with trailing newline": result(checked=CHECKED_AT + "\n"),
            "checkedAt with non-ASCII digits": result(checked="２０２６-11-27T14:03:25.007Z"),
            "checkedAt empty": result(checked=""),
            "checkedAt epoch": result(checked=1795789405007),
            "checkedAt false": result(checked=False),
            "none_found with bad checkedAt": result(reason="none_found", checked="today"),
            "cards with bad checkedAt": result([CARD], checked="today"),
            "other nonce": result([CARD], nonce="nonce_other12345678"),
            "wrong contract": result([CARD], contract="artifact-turn-v1"),
            "markets with reason": result([CARD], reason="denied"),
            "unknown reason": result(reason="no_markets"),
            "reason not a string": result(reason=["denied"]),
            "reason false": result(reason=False),
            "four markets": result([card(id=str(index)) for index in range(4)]),
            "duplicate ids": result([CARD, card(question="Another question?")]),
            "invalid card": result([card(venue="kalshi")]),
            "one invalid card among valid": result([CARD, card(id="2", readAt="yesterday")]),
            "markets null": dict(result(), markets=None),
            "markets as object": dict(result(), markets={"0": CARD}),
            "missing markets": without(result(), "markets"),
            "missing reasonCode": without(result([CARD]), "reasonCode"),
            "extra url": result([CARD], url="https://polymarket.com"),
            "extra artifact": result([CARD], artifact=None),
            "not an object": "no markets",
            "null": None,
        }.items():
            with self.subTest(label):
                self.assertIsNone(parse(value, TURN))

    def test_results_need_a_valid_input(self):
        for label, turn_input in {
            "missing input": None,
            "invalid nonce": dict(TURN, nonce="x"),
            "artifact input": dict(TURN, contract="artifact-turn-v1"),
        }.items():
            with self.subTest(label):
                self.assertIsNone(market_contract.parse_market_turn_result(result([CARD]), turn_input))


class MarketGates(RelayCase):
    def test_disabled_server_refuses_before_spawning(self):
        response = self.query(body())
        self.assertEqual(response.status, 503)
        self.assertEqual(response.data["error"], "market contract unavailable")
        self.assertEqual(self.spawned(), [])

    def test_other_gates_and_the_body_never_enable_market_cards(self):
        os.environ[ARTIFACT_GATE] = "true"
        os.environ.update(SLIP_GATES)
        for label, request_body in {
            "artifact gate only": body(),
            "body flag": body(market_cards_enabled=True),
            "body env": body(env={GATE: "true"}),
        }.items():
            with self.subTest(label):
                self.assertEqual(self.query(request_body).status, 503)
        self.assertEqual(self.spawned(), [])

    def test_requires_caller_history_and_valid_input(self):
        self.enable()
        for label, request_body, error in [
            ("engine history", body(history_mode="engine"), None),
            ("no history", without(body(), "history"), "market requires history_mode caller with history"),
            ("invalid input", body(dict(TURN, nonce="x")), "invalid market"),
            ("null input", dict(body(), market=None), "invalid market"),
        ]:
            with self.subTest(label):
                response = self.query(request_body)
                self.assertEqual(response.status, 400)
                if error is not None:
                    self.assertEqual(response.data["error"], error)
        self.assertEqual(self.spawned(), [])

    def test_stream_refuses_market_requests(self):
        self.enable()
        response = self.call(relay_server.query_stream, body())
        self.assertEqual(response.status, 400)
        self.assertEqual(self.spawned(), [])

    def test_capabilities_advertise_only_when_enabled(self):
        self.assertNotIn("market_contract", self.call(relay_server.capabilities, {}).data)
        os.environ[ARTIFACT_GATE] = "true"
        self.assertNotIn("market_contract", self.call(relay_server.capabilities, {}).data)
        self.enable()
        data = self.call(relay_server.capabilities, {}).data
        self.assertEqual(data["market_contract"], "market-turn-v1")
        self.assertEqual(data["artifact_contract"], "artifact-turn-v1")


class MarketSync(RelayCase):
    def test_market_cards_ride_beside_the_text(self):
        self.enable()
        self.child_prints({"type": "result", "text": PROSE, "market": result([CARD, SPARSE])})
        response = self.query(body())
        self.assertEqual(response.status, 200)
        self.assertEqual(response.data["text"], PROSE)
        self.assertEqual(response.data["market"], result([CARD, SPARSE]))
        self.assertNotIn("report_verification", response.data)
        [child] = self.spawned()
        self.assertIn("--history-stdin", child["argv"])
        self.assertEqual(json.loads(child["stdin"]), {"history": HISTORY, "market": TURN}, "the input rides on stdin")
        self.assertNotIn(NONCE, " ".join(child["argv"]), "never in argv")
        self.assertEqual(child["env_leaks"], [], "never in the environment")

    def test_no_markets_and_refusals_pass_through(self):
        self.enable()
        for label, market in {
            "nothing cited, no polymarket call": result(),
            "nothing cited, after a polymarket call": result(checked=CHECKED_AT),
            "denied": result(reason="denied"),
            "none found": result(reason="none_found"),
        }.items():
            with self.subTest(label):
                self.child_prints({"type": "result", "text": PROSE, "market": market})
                response = self.query(body())
                self.assertEqual(response.status, 200)
                self.assertEqual(response.data["market"], market)

    def test_missing_or_bad_acknowledgements_fail_closed(self):
        self.enable()
        for label, events in {
            "missing": [{"type": "result", "text": PROSE}],
            "null": [{"type": "result", "text": PROSE, "market": None}],
            "other nonce": [{"type": "result", "text": PROSE, "market": result([CARD], nonce="nonce_other12345678")}],
            "invalid card": [{"type": "result", "text": PROSE, "market": result([card(venue="kalshi")])}],
            "boolean price": [{"type": "result", "text": PROSE,
                               "market": result([card(outcomes=outcomes({"name": "Yes", "price": True}))])}],
            "duplicate ids": [{"type": "result", "text": PROSE, "market": result([CARD, CARD])}],
            "markets with reason": [{"type": "result", "text": PROSE, "market": result([CARD], reason="denied")}],
            "old shape without checkedAt": [{"type": "result", "text": PROSE,
                                             "market": without(result([CARD]), "checkedAt")}],
            "cards with null checkedAt": [{"type": "result", "text": PROSE, "market": result([CARD], checked=None)}],
            "none_found with null checkedAt": [{"type": "result", "text": PROSE,
                                                "market": result(reason="none_found", checked=None)}],
            "denied with checkedAt": [{"type": "result", "text": PROSE,
                                       "market": result(reason="denied", checked=CHECKED_AT)}],
            "duplicate results": [{"type": "result", "text": PROSE, "market": result([CARD])},
                                  {"type": "result", "text": PROSE, "market": result([CARD])}],
        }.items():
            with self.subTest(label):
                self.child_prints(*events)
                response = self.query(body())
                self.assertEqual(response.status, 502)
                self.assertEqual(response.data["error"], "market acknowledgement missing or invalid")

    def test_unrequested_market_is_refused(self):
        self.child_prints({"type": "result", "text": PROSE, "market": result([CARD])})
        response = self.query(without(body(), "market"))
        self.assertEqual(response.status, 502)
        self.assertEqual(response.data["error"], "unrequested market result")

    def test_market_rides_with_artifact_and_slip(self):
        self.enable()
        os.environ[ARTIFACT_GATE] = "true"
        os.environ.update(SLIP_GATES)
        slip_result = {"contract": "slip-turn-v1", "inputHash": slip_contract.hash_slip_turn_input(SLIP_TURN),
                       "decision": None}
        request_body = body(artifact=copy(ARTIFACT_TURN), slip=copy(SLIP_TURN))
        self.child_prints({"type": "result", "text": PROSE, "market": result([CARD]),
                           "artifact": ARTIFACT_RESULT, "slip": slip_result})
        response = self.query(request_body)
        self.assertEqual(response.status, 200)
        self.assertEqual(response.data["market"], result([CARD]))
        self.assertEqual(response.data["artifact"], ARTIFACT_RESULT)
        self.assertEqual(response.data["slip"], slip_result)
        [child] = self.spawned()
        self.assertEqual(json.loads(child["stdin"]),
                         {"history": HISTORY, "slip": SLIP_TURN, "artifact": ARTIFACT_TURN, "market": TURN})

    def test_envelopes_are_acknowledged_independently(self):
        self.enable()
        os.environ[ARTIFACT_GATE] = "true"
        request_body = body(artifact=copy(ARTIFACT_TURN))
        for label, event, error in [
            ("market missing", {"artifact": ARTIFACT_RESULT}, "market acknowledgement missing or invalid"),
            ("artifact missing", {"market": result([CARD])}, "artifact acknowledgement missing or invalid"),
            ("nonces swapped", {"market": result([CARD], nonce=ARTIFACT_TURN["nonce"]), "artifact": ARTIFACT_RESULT},
             "market acknowledgement missing or invalid"),
        ]:
            with self.subTest(label):
                self.child_prints(dict({"type": "result", "text": PROSE}, **event))
                response = self.query(request_body)
                self.assertEqual(response.status, 502)
                self.assertEqual(response.data["error"], error)
                self.assertNotIn("artifact", response.data)

    def test_one_gate_off_refuses_the_whole_request(self):
        self.enable()
        response = self.query(body(artifact=copy(ARTIFACT_TURN)))
        self.assertEqual(response.status, 503)
        self.assertEqual(response.data["error"], "artifact contract unavailable")
        self.assertEqual(self.spawned(), [])

    def test_legacy_requests_unchanged(self):
        self.child_prints({"type": "result", "text": PROSE})
        response = self.query({"prompt": "Who won?"})
        self.assertEqual(response.status, 200)
        self.assertEqual(set(response.data), {"status", "text", "user_id", "elapsed_ms"})
        [child] = self.spawned()
        self.assertIsNone(child["stdin"])


if __name__ == "__main__":
    unittest.main()
