"""slip-turn-v1 — stdlib mirror of the engine's slip wire (src/slip-output.ts).

The relay validates an opt-in slip before spawning the engine and verifies the
engine's typed result before reporting success. Deliberately free of any
aiohttp import, like skills_catalog.py, so it is testable without the web stack.

    SlipTurnInput  {contract, requestText, context: slip-revision-v1 | None}
    SlipTurnResult {contract, inputHash, decision: slip-decision-v1 | None}

Parsers return a fresh copy or None and never raise. The hash is SHA-256 of
json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False), equal to
hashSlipTurnInput in the engine. Gates come from the server environment only.
"""

import hashlib
import json
import os
import re

TURN_CONTRACT = "slip-turn-v1"
CHANGE_CONTRACT = "slip-change-v1"
REVISION_CONTRACT = "slip-revision-v1"
DECISION_CONTRACT = "slip-decision-v1"
DECISION_MODEL = "jev-1.14.0"

MAX_REQUEST_CHARS = 4000
MAX_WIRE_BYTES = 65536
MAX_LEGS = 64
MAX_FIELD_CHARS = 160
MAX_QUOTED_CHARS = 80
MAX_UNRESOLVED = 16

_ACTIONS = {"create", "append", "remove", "replace", "confirm", "review", "clarify"}
_FORMATS = {"decimal", "american", "fractional", "unknown"}
_SOURCES = {"user_text", "user_image", "agent_suggestion"}
_REASONS = {"disabled", "invalid_request", "invalid_response", "inference_unavailable", "timeout", "aborted"}
_SLIP_ID = re.compile(r"slp_[A-Za-z0-9_-]{22}")
_REVISION_ID = re.compile(r"slr_[A-Za-z0-9_-]{22}")
_LEG_ID = re.compile(r"sll_[A-Za-z0-9_-]{22}")
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_LEG_KEYS = ("event", "market", "selection", "period", "line", "quotedOdds", "source", "unresolved")
_CHANGE_KEYS = ("contract", "action", "baseRevisionId", "targetLegIds", "legs", "unresolved")
_REVISION_KEYS = ("contract", "slipId", "revisionId", "parentRevisionId", "status", "legs", "unresolved")


class _Invalid(ValueError):
    pass


def slip_enabled(env=None) -> bool:
    """Mirror of slipDecisionsEnabled in src/slip-decision.ts."""
    env = os.environ if env is None else env
    watch_native = env.get("SPORTSCLAW_WATCH_INTENT_NATIVE_CONFIG")
    slip_native = env.get("SPORTSCLAW_SLIP_NATIVE_ONLY")
    return (env.get("SPORTSCLAW_SLIP_ENABLED") == "true"
            and env.get("SPORTSCLAW_SLIP_JEV_DATA_POLICY") == "cloud_allowed"
            and not watch_native
            and slip_native in (None, "", "false"))


def _js_len(text: str) -> int:
    """String length in UTF-16 units, as JavaScript counts it."""
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def _well_formed(text: str) -> bool:
    try:
        text.encode("utf-8")
        return True
    except UnicodeEncodeError:
        return False


def _exact(value, keys) -> dict:
    if not isinstance(value, dict) or set(value) != set(keys) or len(value) != len(keys):
        raise _Invalid()
    return value


def _text(value, limit: int) -> str:
    if (not isinstance(value, str) or not value.strip() or _js_len(value) > limit
            or _CONTROL.search(value) or not _well_formed(value)):
        raise _Invalid()
    return value


def _nullable_text(value, limit: int):
    return None if value is None else _text(value, limit)


def _list(value, limit: int, item) -> list:
    if not isinstance(value, list) or len(value) > limit:
        raise _Invalid()
    return [item(entry) for entry in value]


def _unresolved(value) -> list:
    return _list(value, MAX_UNRESOLVED, lambda entry: _text(entry, MAX_FIELD_CHARS))


def _id(value, pattern) -> str:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise _Invalid()
    return value


def _wire_bytes(value) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def _leg(value, extra=()) -> dict:
    raw = _exact(value, _LEG_KEYS + tuple(extra))
    event = _nullable_text(raw["event"], MAX_FIELD_CHARS)
    market = _nullable_text(raw["market"], MAX_FIELD_CHARS)
    selection = _nullable_text(raw["selection"], MAX_FIELD_CHARS)
    if event is None and market is None and selection is None:
        raise _Invalid()
    odds = None
    if raw["quotedOdds"] is not None:
        quoted = _exact(raw["quotedOdds"], ("value", "format"))
        if not isinstance(quoted["format"], str) or quoted["format"] not in _FORMATS:
            raise _Invalid()
        odds = {"value": _text(quoted["value"], MAX_QUOTED_CHARS), "format": quoted["format"]}
    source = raw["source"]
    if not isinstance(source, str) or source not in _SOURCES:
        raise _Invalid()
    if source == "agent_suggestion" and odds is not None:
        raise _Invalid()
    return {"event": event, "market": market, "selection": selection,
            "period": _nullable_text(raw["period"], MAX_FIELD_CHARS),
            "line": _nullable_text(raw["line"], MAX_FIELD_CHARS),
            "quotedOdds": odds, "source": source, "unresolved": _unresolved(raw["unresolved"])}


def _change(value) -> dict:
    raw = _exact(value, _CHANGE_KEYS)
    if raw["contract"] != CHANGE_CONTRACT or not isinstance(raw["action"], str) or raw["action"] not in _ACTIONS:
        raise _Invalid()
    change = {
        "contract": CHANGE_CONTRACT, "action": raw["action"],
        "baseRevisionId": None if raw["baseRevisionId"] is None else _id(raw["baseRevisionId"], _REVISION_ID),
        "targetLegIds": _list(raw["targetLegIds"], MAX_LEGS, lambda entry: _id(entry, _LEG_ID)),
        "legs": _list(raw["legs"], MAX_LEGS, _leg),
        "unresolved": _unresolved(raw["unresolved"]),
    }
    if _wire_bytes(change) > MAX_WIRE_BYTES:
        raise _Invalid()
    return change


def _revision(value) -> dict:
    raw = _exact(value, _REVISION_KEYS)
    if raw["contract"] != REVISION_CONTRACT or raw["status"] not in ("proposed", "confirmed"):
        raise _Invalid()
    seen = set()

    def leg(entry):
        leg_id = _id(entry.get("id") if isinstance(entry, dict) else None, _LEG_ID)
        if leg_id in seen:
            raise _Invalid()
        seen.add(leg_id)
        return dict(_leg(entry, ("id",)), id=leg_id)

    legs = _list(raw["legs"], MAX_LEGS, leg)
    if not legs:
        raise _Invalid()
    revision = {
        "contract": REVISION_CONTRACT, "slipId": _id(raw["slipId"], _SLIP_ID),
        "revisionId": _id(raw["revisionId"], _REVISION_ID),
        "parentRevisionId": None if raw["parentRevisionId"] is None else _id(raw["parentRevisionId"], _REVISION_ID),
        "status": raw["status"], "legs": legs, "unresolved": _unresolved(raw["unresolved"]),
    }
    if _wire_bytes(revision) > MAX_WIRE_BYTES:
        raise _Invalid()
    return revision


def _proposal_ok(change: dict, context) -> bool:
    """Mirror of slipProposalProblem in src/slip-output.ts (True: no problem)."""
    action, base, targets, legs = change["action"], change["baseRevisionId"], change["targetLegIds"], change["legs"]
    if action == "confirm":
        return False
    if action == "create":
        return base is None and not targets and bool(legs)
    if action == "clarify":
        return not targets and not legs and base == (context["revisionId"] if context else None)
    if context is None or base != context["revisionId"]:
        return False
    known = {leg["id"] for leg in context["legs"]}
    if len(set(targets)) != len(targets) or any(target not in known for target in targets):
        return False
    if action == "append":
        return not targets and bool(legs) and len(context["legs"]) + len(legs) <= MAX_LEGS
    if action == "remove":
        return 0 < len(targets) < len(context["legs"]) and not legs
    if action == "replace":
        return len(targets) == 1 and len(legs) == 1
    return not legs  # review


def parse_slip_turn_input(value):
    """Exact SlipTurnInput, or None."""
    try:
        raw = _exact(value, ("contract", "requestText", "context"))
        text = raw["requestText"]
        if (raw["contract"] != TURN_CONTRACT or not isinstance(text, str) or not text.strip()
                or _js_len(text) > MAX_REQUEST_CHARS or not _well_formed(text)):
            return None
        turn = {"contract": TURN_CONTRACT, "requestText": text,
                "context": None if raw["context"] is None else _revision(raw["context"])}
        return turn if _wire_bytes(turn) <= MAX_WIRE_BYTES else None
    except (_Invalid, TypeError, AttributeError, UnicodeError):
        return None


def hash_slip_turn_input(value) -> str:
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _decision(value, context) -> dict:
    if not isinstance(value, dict) or value.get("contract") != DECISION_CONTRACT:
        raise _Invalid()
    if value.get("ok") is False:
        raw = _exact(value, ("contract", "ok", "reasonCode"))
        if not isinstance(raw["reasonCode"], str) or raw["reasonCode"] not in _REASONS:
            raise _Invalid()
        return {"contract": DECISION_CONTRACT, "ok": False, "reasonCode": raw["reasonCode"]}
    if value.get("ok") is not True:
        raise _Invalid()
    inner = _exact(value, ("contract", "ok", "decision"))["decision"]
    if isinstance(inner, dict) and inner.get("status") == "selected":
        raw = _exact(inner, ("status", "change", "model"))
        change = _change(raw["change"])
        if raw["model"] != DECISION_MODEL or change["action"] == "clarify" or not _proposal_ok(change, context):
            raise _Invalid()
        return {"contract": DECISION_CONTRACT, "ok": True,
                "decision": {"status": "selected", "change": change, "model": DECISION_MODEL}}
    raw = _exact(inner, ("status", "model"))
    if raw["status"] not in ("none", "clarify") or raw["model"] != DECISION_MODEL:
        raise _Invalid()
    return {"contract": DECISION_CONTRACT, "ok": True, "decision": {"status": raw["status"], "model": DECISION_MODEL}}


def parse_slip_turn_result(value, turn_input):
    """Exact SlipTurnResult answering exactly ``turn_input``, or None."""
    try:
        turn = parse_slip_turn_input(turn_input)
        if turn is None:
            return None
        raw = _exact(value, ("contract", "inputHash", "decision"))
        input_hash = hash_slip_turn_input(turn)
        if raw["contract"] != TURN_CONTRACT or raw["inputHash"] != input_hash:
            return None
        decision = None if raw["decision"] is None else _decision(raw["decision"], turn["context"])
        return {"contract": TURN_CONTRACT, "inputHash": input_hash, "decision": decision}
    except (_Invalid, TypeError, AttributeError, UnicodeError):
        return None
