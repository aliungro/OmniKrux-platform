"""A tool's parse and limit errors in plain words. Only recognised shapes are rewritten; any
other text passes through unchanged (it has already been scrubbed where it was read)."""

import re
from typing import Literal

Language = Literal["promql", "logql"]

UNREADABLE_AT = "The query doesn't read at line {line}, column {col}: {plain}."
RANGE_LIMIT = "This Loki answers at most {limit} per query. Pick a shorter time range."

_PROMQL = re.compile(r"(\d+):(\d+): parse error: (.+)", re.DOTALL)
_LOGQL = re.compile(r"parse error at line (\d+), col (\d+): syntax error: (.+)", re.DOTALL)
_UNKNOWN_FUNCTION = re.compile(r'unknown function with name "([^"]*)"')
_UNEXPECTED = re.compile(r'unexpected identifier "([^"]*)"', re.IGNORECASE)
_RANGE = re.compile(
    r"the query time range exceeds the limit \(query length: [^,]*, limit: ([^)]+)\)"
)
_PART = re.compile(r"(\d+)(ms|[smhdwy])")
_SECONDS = {"ms": 0.001, "s": 1, "m": 60, "h": 3600, "d": 86400, "w": 7 * 86400, "y": 365 * 86400}


def _plain(what: str) -> str:
    what = what.strip().rstrip(".")
    if what.startswith("unclosed left parenthesis"):
        return "a bracket is never closed"
    if (m := _UNKNOWN_FUNCTION.search(what)) is not None:
        return f"there is no function named {m.group(1)}"
    if (m := _UNEXPECTED.fullmatch(what)) is not None:
        return f'"{m.group(1)}" isn\'t expected there'
    if what.startswith("unexpected $end, expecting }"):
        return "the selector isn't closed with }"
    return what


def _span_words(text: str) -> str | None:
    text = text.strip()
    parts = _PART.findall(text)
    if not parts or "".join(n + u for n, u in parts) != text:
        return None
    seconds = sum(int(n) * _SECONDS[u] for n, u in parts)
    for unit, size in (("day", 86400), ("hour", 3600), ("minute", 60)):
        count = int(seconds // size)
        if count >= 1:
            return f"{count} {unit}{'' if count == 1 else 's'}"
    return None


def plain_query_error(language: Language, text: str) -> str:
    """The words for a tool's parse or range-limit error; the text itself when not recognised."""
    pattern = _PROMQL if language == "promql" else _LOGQL
    if (m := pattern.search(text)) is not None:
        return UNREADABLE_AT.format(line=m.group(1), col=m.group(2), plain=_plain(m.group(3)))
    if language == "logql" and (m := _RANGE.search(text)) is not None:
        words = _span_words(m.group(1))
        if words is not None:
            return RANGE_LIMIT.format(limit=words)
    return text
