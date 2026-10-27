"""artifact-turn-v1 — stdlib mirror of the engine's artifact wire (src/artifact-output.ts).

The relay validates an opt-in artifact request before spawning the engine and
verifies the engine's typed result before reporting success. Free of any
aiohttp import, like slip_contract.py, so it is testable without the web stack.

    ArtifactTurnInput  {contract, nonce}
    ArtifactTurnResult {contract, nonce, artifact: artifact-v1 | None, reasonCode | None}
    artifact-v1        {contract, title, mimeType: "text/html", html}

Parsers return a fresh copy or None and never raise. The gate comes from the
server environment only: a request body can never enable artifacts.
"""

import os
import re

TURN_CONTRACT = "artifact-turn-v1"
ARTIFACT_CONTRACT = "artifact-v1"
MIME_TYPE = "text/html"
MAX_TITLE_CHARS = 120
MAX_HTML_BYTES = 262144

_REASONS = {"denied", "invalid_artifact", "conflicting_artifact", "evidence_unverified"}
_NONCE = re.compile(r"[A-Za-z0-9_-]{16,64}")
_TITLE_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
# C0/C1 controls except tab, line feed and carriage return.
_HTML_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")


def artifacts_enabled(env=None) -> bool:
    env = os.environ if env is None else env
    return env.get("SPORTSCLAW_ARTIFACTS_ENABLED") == "true"


def _js_len(text: str) -> int:
    """String length in UTF-16 code units, like JavaScript's String.length."""
    return len(text.encode("utf-16-le")) // 2


def _utf8_bytes(text: str):
    """UTF-8 size, or None for text with a lone surrogate (not valid Unicode)."""
    try:
        return len(text.encode("utf-8"))
    except UnicodeEncodeError:
        return None


def _exact(value, keys):
    if type(value) is not dict or len(value) != len(keys) or any(key not in value for key in keys):
        return None
    return value


def parse_artifact(value):
    raw = _exact(value, ("contract", "title", "mimeType", "html"))
    if raw is None or raw["contract"] != ARTIFACT_CONTRACT or raw["mimeType"] != MIME_TYPE:
        return None
    title, html = raw["title"], raw["html"]
    if (type(title) is not str or not title.strip() or _js_len(title) > MAX_TITLE_CHARS
            or _TITLE_CONTROL.search(title) or _utf8_bytes(title) is None):
        return None
    if type(html) is not str or not html.strip() or _HTML_CONTROL.search(html):
        return None
    size = _utf8_bytes(html)
    if size is None or size > MAX_HTML_BYTES:
        return None
    return {"contract": ARTIFACT_CONTRACT, "title": title, "mimeType": MIME_TYPE, "html": html}


def parse_artifact_turn_input(value):
    raw = _exact(value, ("contract", "nonce"))
    if raw is None or raw["contract"] != TURN_CONTRACT:
        return None
    nonce = raw["nonce"]
    if type(nonce) is not str or not _NONCE.fullmatch(nonce):
        return None
    return {"contract": TURN_CONTRACT, "nonce": nonce}


def parse_artifact_turn_result(value, turn_input):
    """The result for this exact input, or None. An artifact and a reason never coexist."""
    turn = parse_artifact_turn_input(turn_input)
    raw = _exact(value, ("contract", "nonce", "artifact", "reasonCode"))
    if turn is None or raw is None or raw["contract"] != TURN_CONTRACT or raw["nonce"] != turn["nonce"]:
        return None
    reason = raw["reasonCode"]
    if reason is not None and (type(reason) is not str or reason not in _REASONS):
        return None
    if raw["artifact"] is None:
        return {"contract": TURN_CONTRACT, "nonce": turn["nonce"], "artifact": None, "reasonCode": reason}
    artifact = parse_artifact(raw["artifact"])
    if artifact is None or reason is not None:
        return None
    return {"contract": TURN_CONTRACT, "nonce": turn["nonce"], "artifact": artifact, "reasonCode": None}
