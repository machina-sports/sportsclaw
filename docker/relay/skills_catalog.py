"""
Structured parsing of `sportsclaw list --json` for the relay skills endpoint.

Stdlib only, and deliberately free of any aiohttp import: the relay's HTTP layer
needs aiohttp, this parsing contract does not, so it stays executable in tests
without the web dependency installed.

Why this module exists: the relay used to run `sportsclaw list` in *human* mode
and scrape lines beginning with "- ". The human renderer emits categorized,
comma-separated prose, so the scrape matched nothing and `GET /api/skills`
returned a successful *empty* catalog while the 0.29.3 canary container actually
held 20 schema files and 291 tools. Structured output is now the contract, and
anything unexpected fails loudly instead of degrading to an empty list.

The `/api/skills` response stays flat (a single `skills` array). Categories are
combined in a fixed order so the payload is deterministic across calls.
"""

import json

# Category order defines the order of the flattened response.
CATEGORY_KEYS = (
    "defaultSports",
    "optionalSports",
    "defaultSupport",
    "optionalSupport",
    "unknown",
)


class CatalogError(Exception):
    """The CLI did not produce a usable structured catalog."""


def parse_catalog(stdout: str, returncode: int = 0) -> list[str]:
    """
    Turn `sportsclaw list --json` output into a flat, deduplicated skill list.

    Names keep their first-occurrence position; duplicates across or within
    categories are dropped. Raises CatalogError on a failed child process, on
    malformed JSON, or on any category that is not an array of non-blank strings.
    """
    if returncode != 0:
        raise CatalogError(f"sportsclaw list --json exited with code {returncode}")

    try:
        payload = json.loads(stdout)
    except (TypeError, ValueError) as exc:
        raise CatalogError(f"sportsclaw list --json emitted invalid JSON: {exc}") from None

    if not isinstance(payload, dict):
        raise CatalogError(
            "sportsclaw list --json must emit a JSON object, "
            f"got {type(payload).__name__}"
        )

    skills: list[str] = []
    seen: set[str] = set()

    for key in CATEGORY_KEYS:
        if key not in payload:
            raise CatalogError(f"sportsclaw list --json is missing the '{key}' category")

        names = payload[key]
        if not isinstance(names, list):
            raise CatalogError(
                f"category '{key}' must be a JSON array, got {type(names).__name__}"
            )

        for index, name in enumerate(names):
            if not isinstance(name, str):
                raise CatalogError(
                    f"category '{key}'[{index}] must be a string, "
                    f"got {type(name).__name__}"
                )
            cleaned = name.strip()
            if not cleaned:
                raise CatalogError(f"category '{key}'[{index}] is blank")
            if cleaned in seen:
                continue
            seen.add(cleaned)
            skills.append(cleaned)

    return skills
