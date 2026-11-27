"""market-turn-v1 — stdlib mirror of the engine's market card wire.

The relay validates an opt-in market request before spawning the engine and
verifies the engine's typed result before reporting success. Free of any
aiohttp import, like artifact_contract.py, so it is testable without the web
stack.

    MarketTurnInput  {contract, nonce}
    MarketTurnResult {contract, nonce, markets: [market-card-v1] (0..3), reasonCode | None}
    market-card-v1   {contract, venue: "polymarket", id, question, slug, eventSlug,
                      status, outcomes: [{name, price}] (2..4), volume, liquidity,
                      gameStartTime, readAt}

Parsers return a fresh copy or None and never raise. The gate comes from the
server environment only: a request body can never enable market cards.
"""

import math
import os
import re

MARKET_TURN_CONTRACT = "market-turn-v1"
MARKET_CARD_CONTRACT = "market-card-v1"
VENUE = "polymarket"
MAX_MARKETS = 3
MAX_ID_CHARS = 64
MAX_QUESTION_CHARS = 300
MAX_SLUG_CHARS = 200
MIN_OUTCOMES = 2
MAX_OUTCOMES = 4
MAX_OUTCOME_NAME_CHARS = 80
MAX_GAME_START_CHARS = 40

_REASONS = {"denied"}
_STATUSES = {"active", "closed", "inactive"}
_NONCE = re.compile(r"[A-Za-z0-9_-]{16,64}")
_ID = re.compile(r"[A-Za-z0-9_-]+")
_SLUG = re.compile(r"[a-z0-9-]*")
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
# ASCII digits only, like \d in a JavaScript RegExp without the u flag.
_READ_AT = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z")
_CARD_KEYS = ("contract", "venue", "id", "question", "slug", "eventSlug", "status", "outcomes",
              "volume", "liquidity", "gameStartTime", "readAt")


def market_cards_enabled(env=None) -> bool:
    env = os.environ if env is None else env
    return env.get("SPORTSCLAW_MARKET_CARDS_ENABLED") == "true"


def _js_len(text: str) -> int:
    """String length in UTF-16 code units, like JavaScript's String.length."""
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def _well_formed(text: str) -> bool:
    """False for text with a lone surrogate (not valid Unicode)."""
    try:
        text.encode("utf-8")
        return True
    except UnicodeEncodeError:
        return False


def _exact(value, keys):
    if type(value) is not dict or len(value) != len(keys) or any(key not in value for key in keys):
        return None
    return value


def _label(value, max_chars) -> bool:
    """Display text: non-blank, bounded in UTF-16 units, no C0/C1 controls, well-formed."""
    return (type(value) is str and bool(value.strip()) and _js_len(value) <= max_chars
            and not _CONTROL.search(value) and _well_formed(value))


def _number(value, maximum=None) -> bool:
    """A real, finite, non-negative number. Booleans are never numbers."""
    if type(value) not in (int, float):
        return False
    try:
        number = float(value)
    except OverflowError:
        return False
    return math.isfinite(number) and number >= 0 and (maximum is None or number <= maximum)


def _slug(value, min_chars) -> bool:
    return type(value) is str and min_chars <= len(value) <= MAX_SLUG_CHARS and bool(_SLUG.fullmatch(value))


def _parse_outcome(value):
    raw = _exact(value, ("name", "price"))
    if raw is None or not _label(raw["name"], MAX_OUTCOME_NAME_CHARS) or not _number(raw["price"], 1):
        return None
    return {"name": raw["name"], "price": raw["price"]}


def parse_market_card(value):
    raw = _exact(value, _CARD_KEYS)
    if raw is None or raw["contract"] != MARKET_CARD_CONTRACT or raw["venue"] != VENUE:
        return None
    card_id, status, outcomes = raw["id"], raw["status"], raw["outcomes"]
    if type(card_id) is not str or len(card_id) > MAX_ID_CHARS or not _ID.fullmatch(card_id):
        return None
    if not _label(raw["question"], MAX_QUESTION_CHARS) or not _slug(raw["slug"], 0):
        return None
    if raw["eventSlug"] is not None and not _slug(raw["eventSlug"], 1):
        return None
    if type(status) is not str or status not in _STATUSES:
        return None
    if type(outcomes) is not list or not MIN_OUTCOMES <= len(outcomes) <= MAX_OUTCOMES:
        return None
    parsed = [_parse_outcome(outcome) for outcome in outcomes]
    if any(outcome is None for outcome in parsed):
        return None
    if any(raw[key] is not None and not _number(raw[key]) for key in ("volume", "liquidity")):
        return None
    start = raw["gameStartTime"]
    if start is not None and (type(start) is not str or not start or _js_len(start) > MAX_GAME_START_CHARS
                              or _CONTROL.search(start)):
        return None
    if type(raw["readAt"]) is not str or not _READ_AT.fullmatch(raw["readAt"]):
        return None
    return {"contract": MARKET_CARD_CONTRACT, "venue": VENUE, "id": card_id, "question": raw["question"],
            "slug": raw["slug"], "eventSlug": raw["eventSlug"], "status": status, "outcomes": parsed,
            "volume": raw["volume"], "liquidity": raw["liquidity"], "gameStartTime": start,
            "readAt": raw["readAt"]}


def parse_market_turn_input(value):
    raw = _exact(value, ("contract", "nonce"))
    if raw is None or raw["contract"] != MARKET_TURN_CONTRACT:
        return None
    nonce = raw["nonce"]
    if type(nonce) is not str or not _NONCE.fullmatch(nonce):
        return None
    return {"contract": MARKET_TURN_CONTRACT, "nonce": nonce}


def parse_market_turn_result(value, turn_input):
    """The result for this exact input, or None. Market cards and a reason never coexist."""
    turn = parse_market_turn_input(turn_input)
    raw = _exact(value, ("contract", "nonce", "markets", "reasonCode"))
    if turn is None or raw is None or raw["contract"] != MARKET_TURN_CONTRACT or raw["nonce"] != turn["nonce"]:
        return None
    reason = raw["reasonCode"]
    if reason is not None and (type(reason) is not str or reason not in _REASONS):
        return None
    if type(raw["markets"]) is not list or len(raw["markets"]) > MAX_MARKETS:
        return None
    markets = [parse_market_card(card) for card in raw["markets"]]
    if any(card is None for card in markets) or len({card["id"] for card in markets}) != len(markets):
        return None
    if markets and reason is not None:
        return None
    return {"contract": MARKET_TURN_CONTRACT, "nonce": turn["nonce"], "markets": markets, "reasonCode": reason}
