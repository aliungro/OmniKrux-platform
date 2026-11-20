"""A project's label filter on a source, and how it reaches every selector of a query.

Isolation rests on this module: every PromQL and LogQL selector gets the project's matchers, and a
query the scanner can't read is refused rather than sent unfiltered. Where the scanner could be
unsure whether a word is a metric name, it filters it: a wrong guess then makes the tool refuse
the query, never answer it with another project's data.
"""

import json
import re
import string
from collections.abc import Iterable, Sequence
from dataclasses import asdict

from omnikrux.monitoring.projects.types import Matcher

__all__ = [
    "FilterError",
    "Matcher",
    "inject_logql",
    "inject_promql",
    "matchers_from_json",
    "matchers_json",
    "parse_matchers",
    "render_matchers",
]

BAD_FILTER = 'Use label matchers like cluster="prod-east", separated by commas.'
NO_METRIC_NAME = "A filter can't select by metric name."
UNREADABLE = "The query has an unclosed quote or bracket."
SELECTOR = (
    "The query has a selector OmniKrux can't filter. Write its label matchers separated by commas."
)


class FilterError(ValueError):
    """A filter or a query OmniKrux can't read. The message is plain words for the user."""


# --- Filters: parse, render, store -------------------------------------------------------------

_LABEL = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_OPS = ("=~", "!~", "!=", "=")  # longest first, so "=~" is never read as "=" and "~"
_UNESCAPE = {"\\": "\\", '"': '"', "n": "\n"}


def parse_matchers(text: str) -> tuple[Matcher, ...]:
    """Read `label op "value"` matchers separated by commas, optionally inside `{ }`."""
    body = text.strip()
    if body.startswith("{") and body.endswith("}"):
        body = body[1:-1]
    n = len(body)
    i = _skip_space(body, 0)
    if i == n:
        return ()
    matchers: list[Matcher] = []
    while True:
        label = _LABEL.match(body, i)
        if label is None:
            raise FilterError(BAD_FILTER)
        if label.group() == "__name__":
            raise FilterError(NO_METRIC_NAME)
        i = _skip_space(body, label.end())
        op = next((o for o in _OPS if body.startswith(o, i)), None)
        if op is None:
            raise FilterError(BAD_FILTER)
        i = _skip_space(body, i + len(op))
        value, i = _read_value(body, i)
        matchers.append(Matcher(label.group(), op, value))  # type: ignore[arg-type]
        i = _skip_space(body, i)
        if i == n:
            return tuple(matchers)
        if body[i] != ",":
            raise FilterError(BAD_FILTER)
        i = _skip_space(body, i + 1)


def _skip_space(text: str, i: int) -> int:
    while i < len(text) and text[i].isspace():
        i += 1
    return i


def _read_value(text: str, i: int) -> tuple[str, int]:
    """The double-quoted value starting at `text[i]`, unescaped, and the index just past it."""
    if i >= len(text) or text[i] != '"':
        raise FilterError(BAD_FILTER)
    chars: list[str] = []
    j = i + 1
    while j < len(text):
        c = text[j]
        if c == '"':
            return "".join(chars), j + 1
        if c == "\\":
            if j + 1 >= len(text) or text[j + 1] not in _UNESCAPE:
                raise FilterError(BAD_FILTER)
            chars.append(_UNESCAPE[text[j + 1]])
            j += 2
        else:
            chars.append(c)
            j += 1
    raise FilterError(BAD_FILTER)


def render_matchers(matchers: Iterable[Matcher]) -> str:
    """`label="value"` joined by commas, values escaped as PromQL and LogQL strings."""
    return ",".join(_render(m) for m in matchers)


def _render(m: Matcher) -> str:
    # A label or operator that isn't one would let a stored filter rewrite the query.
    if _LABEL.fullmatch(m.label) is None or m.op not in _OPS:
        raise FilterError(BAD_FILTER)
    if m.label == "__name__":
        raise FilterError(NO_METRIC_NAME)
    value = m.value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
    return f'{m.label}{m.op}"{value}"'


def matchers_json(matchers: Iterable[Matcher]) -> str:
    return json.dumps([asdict(m) for m in matchers])


def matchers_from_json(text: str) -> tuple[Matcher, ...]:
    return tuple(Matcher(**m) for m in json.loads(text))


# --- Scanning: strings, comments, selectors ----------------------------------------------------

# PromQL strings: "...", '...' and raw `...`. LogQL is read by Go's text/scanner, where `'` opens a
# literal too and `//`, `/* */` are comments: skipping them as Loki does means a quote inside one
# can never hide a selector.
_QUOTES = "\"'`"
_WORD_START = frozenset(string.ascii_letters + "_:")
_WORD = _WORD_START | frozenset(string.digits)
_CLOSER_OF = {")": "(", "]": "["}
# The whitespace both lexers skip. Any other character is a token to them, so the scanner treats
# it as one too (Prometheus and Loki refuse the ones they don't know).
_SPACE = " \t\n\r"
# Where a line comment ends: Prometheus stops at "\r" or "\n", Loki (and Go's scanner) at "\n".
_PROMQL_LINE_ENDS = "\r\n"
_LOGQL_LINE_ENDS = "\n"


def _string_end(q: str, i: int) -> int:
    """Index just past the string opening at `q[i]`. A backtick string is raw: no escapes."""
    quote, j = q[i], i + 1
    while j < len(q):
        c = q[j]
        if c == quote:
            return j + 1
        j += 2 if c == "\\" and quote != "`" else 1
    raise FilterError(UNREADABLE)


def _line_end(q: str, i: int, logql: bool) -> int:
    """Index of the character that ends the line comment starting at `q[i]` (or the end)."""
    ends = _LOGQL_LINE_ENDS if logql else _PROMQL_LINE_ENDS
    j = i + 1
    while j < len(q) and q[j] not in ends:
        j += 1
    return j


def _literal_end(q: str, i: int, logql: bool) -> int | None:
    """If a string or a comment starts at `q[i]`, the index just past it; otherwise None."""
    c = q[i]
    if c in _QUOTES:
        return _string_end(q, i)
    if c == "#":
        return _line_end(q, i, logql)
    if logql and c == "/" and q.startswith("//", i):
        return _line_end(q, i, logql)
    if logql and c == "/" and q.startswith("/*", i):
        j = q.find("*/", i + 2)
        if j == -1:
            raise FilterError(UNREADABLE)
        return j + 2
    return None


# What a selector expects next: `name op "value"` items separated by commas, where a name is a
# label or a quoted name, and a quoted name alone is a metric name (Prometheus 3).
_ITEM, _OP_OR_END, _VALUE, _END = range(4)


def _selector_end(q: str, i: int, logql: bool) -> tuple[int, bool]:
    """For the `{` at `q[i]`: the index of its `}`, and whether the matchers so far need a comma
    before another one (false when the braces are empty or end with a comma).

    Anything but comma-separated matchers is refused: in MetricsQL's `{a="1" or b="2"}`, a
    matcher added at the end would filter only the last alternative."""
    j, expect = i + 1, _ITEM
    while j < len(q):
        c = q[j]
        if c in _SPACE:
            j += 1
            continue
        end = _literal_end(q, j, logql)
        if end is not None:
            if c in _QUOTES:
                if expect == _ITEM:
                    expect = _OP_OR_END
                elif expect == _VALUE:
                    expect = _END
                else:
                    raise FilterError(SELECTOR)
            j = end
            continue
        if c == "}":
            if expect == _VALUE:
                raise FilterError(SELECTOR)
            return j, expect != _ITEM
        if c in "{()[]":
            raise FilterError(UNREADABLE)
        op = next((o for o in _OPS if q.startswith(o, j)), None)
        if c == ",":
            if expect not in (_OP_OR_END, _END):
                raise FilterError(SELECTOR)
            expect, j = _ITEM, j + 1
        elif c in _WORD_START and expect == _ITEM:
            expect, j = _OP_OR_END, _run_end(q, j, _WORD)
        elif op is not None and expect == _OP_OR_END:
            expect, j = _VALUE, j + len(op)
        else:  # a bare word after a matcher, a stray operator, anything unknown
            raise FilterError(SELECTOR)
    raise FilterError(UNREADABLE)


def _insert(q: str, inserts: list[tuple[int, str]]) -> str:
    out: list[str] = []
    last = 0
    for pos, text in inserts:
        out += [q[last:pos], text]
        last = pos
    out.append(q[last:])
    return "".join(out)


def _selector_insert(q: str, i: int, logql: bool, rendered: str) -> tuple[int, tuple[int, str]]:
    end, needs_comma = _selector_end(q, i, logql)
    return end, (end, ("," if needs_comma else "") + rendered)


# --- PromQL ------------------------------------------------------------------------------------

_NUMBER = frozenset(string.ascii_letters + string.digits + "_.")  # 0.95, 1e3, 0x1f, 5m, 1h30m
_DIGITS = frozenset(string.digits)  # ASCII only: str.isdigit() also accepts "²" and "٣"
_OPERATOR_PAIRS = ("==", "!=", ">=", "<=", "=~", "!~")
_OPERATOR_CHARS = "+-*/%^=!<>~"

_LITERALS = frozenset({"inf", "nan"})
_BINARY_WORDS = frozenset({"and", "or", "unless", "atan2"})
_GROUPING = frozenset({"by", "without"})
_MODIFIERS = frozenset({"bool", "on", "ignoring", "group_left", "group_right"})
_LABEL_LIST_AFTER = _GROUPING | frozenset({"on", "ignoring", "group_left", "group_right"})

# What the scanner expects next. Prometheus also reads a keyword as a metric name where an
# operand belongs (`rate(offset[5m])`), so keywords count as keywords only where they can be.
_OPERAND = 0  # start, after "(", ",", "@", "offset" or a unary sign
_AFTER_BINARY = 1  # after a binary operator or its modifiers: an operand or a modifier
_AFTER_OPERAND = 2  # after a value: an operator or a keyword


def inject_promql(query: str, matchers: Sequence[Matcher]) -> str:
    """The query with `matchers` added to every series selector."""
    if not matchers:
        return query
    rendered = render_matchers(matchers)
    q, n = query, len(query)
    inserts: list[tuple[int, str]] = []
    open_brackets: list[str] = []
    state = _OPERAND
    i = 0
    while i < n:
        start, c = i, q[i]
        in_range = "[" in open_brackets  # ranges and subquery steps: never a selector
        literal_end = _literal_end(q, i, logql=False)
        if literal_end is not None:
            if c != "#":
                state = _AFTER_OPERAND
            i = literal_end
        elif c in _SPACE:
            i += 1
        elif c in "([":
            open_brackets.append(c)
            state = _OPERAND
            i += 1
        elif c in ")]":
            if not open_brackets or open_brackets.pop() != _CLOSER_OF[c]:
                raise FilterError(UNREADABLE)
            state = _AFTER_OPERAND
            i += 1
        elif c == "{":
            if in_range:
                raise FilterError(UNREADABLE)
            i, insert = _selector_insert(q, i, False, rendered)
            inserts.append(insert)
            state = _AFTER_OPERAND
            i += 1
        elif c == "}":
            raise FilterError(UNREADABLE)
        elif c in _DIGITS or (c == "." and i + 1 < n and q[i + 1] in _DIGITS):
            i = _run_end(q, i, _NUMBER)
            state = _AFTER_OPERAND
        elif c in _WORD_START:
            end = _run_end(q, i, _WORD)
            if in_range:
                i = end
            else:
                i, state = _word(q, i, end, state, rendered, inserts)
        elif c in _OPERATOR_CHARS:
            i += 2 if q.startswith(_OPERATOR_PAIRS, i) else 1
            state = _AFTER_BINARY if state == _AFTER_OPERAND else _OPERAND
        else:  # ",", "@", and anything Prometheus itself refuses: an operand comes next
            state = _OPERAND
            i += 1
        _check_progress(start, i)
    if open_brackets:
        raise FilterError(UNREADABLE)
    return _insert(q, inserts)


def _run_end(q: str, i: int, chars: frozenset[str]) -> int:
    """Past the run of `chars` starting at `i`, which must hold at least one of them."""
    j = i
    while j < len(q) and q[j] in chars:
        j += 1
    _check_progress(i, j)
    return j


def _check_progress(before: int, after: int) -> None:
    # Every scanner step moves forward; a step that wouldn't is refused instead of looping.
    if after <= before:
        raise FilterError(UNREADABLE)


def _skip_blank(q: str, i: int) -> int:
    """Past spaces and `#` comments."""
    while i < len(q):
        if q[i] in _SPACE:
            i += 1
        elif q[i] == "#":
            i = _line_end(q, i, logql=False)
        else:
            break
    return i


def _label_list_end(q: str, i: int) -> int:
    """Past the `( label, ... )` list that may follow `by`, `on` and the like at `i`; `i` itself
    when none follows. Anything but label names and strings inside it is refused."""
    j = _skip_blank(q, i)
    if j >= len(q) or q[j] != "(":
        return i
    j += 1
    while j < len(q):
        end = _literal_end(q, j, logql=False)
        if end is not None:
            j = end
        elif q[j] == ")":
            return j + 1
        elif q[j] in "([{}]":
            raise FilterError(UNREADABLE)
        else:
            j += 1
    raise FilterError(UNREADABLE)


def _word(
    q: str, start: int, end: int, state: int, rendered: str, inserts: list[tuple[int, str]]
) -> tuple[int, int]:
    """Read the word `q[start:end]`; returns where scanning goes on and the next state."""
    word = q[start:end].lower()
    if word in _LITERALS:
        return end, _AFTER_OPERAND
    if state == _AFTER_OPERAND:
        if word in _BINARY_WORDS:
            return end, _AFTER_BINARY
        if word == "offset":
            return end, _OPERAND
        if word in _GROUPING:
            return _label_list_end(q, end), _AFTER_OPERAND
    if state != _OPERAND and word in _MODIFIERS:
        if word in _LABEL_LIST_AFTER:
            end = _label_list_end(q, end)
        return end, _AFTER_BINARY
    # An operand: a function or aggregation, the metric name of a `{...}` selector (the braces
    # get the matchers when the scan reaches them), or a bare metric name.
    following = _skip_blank(q, end)
    if following < len(q) and q[following] in "({":
        return end, _AFTER_OPERAND
    if _grouping_then_call(q, following):  # sum by (job) (...)
        return end, _AFTER_OPERAND
    inserts.append((end, "{" + rendered + "}"))
    return end, _AFTER_OPERAND


def _grouping_then_call(q: str, i: int) -> bool:
    """Whether `by (...) (` or `without (...) (` starts at `i`."""
    if i >= len(q) or q[i] not in _WORD_START:
        return False
    end = _run_end(q, i, _WORD)
    if q[i:end].lower() not in _GROUPING:
        return False
    after = _label_list_end(q, end)
    if after == end:
        return False
    following = _skip_blank(q, after)
    return following < len(q) and q[following] == "("


# --- LogQL -------------------------------------------------------------------------------------


def inject_logql(query: str, matchers: Sequence[Matcher]) -> str:
    """The query with `matchers` added to every stream selector."""
    if not matchers:
        return query
    rendered = render_matchers(matchers)
    q = query
    inserts: list[tuple[int, str]] = []
    open_brackets: list[str] = []
    i = 0
    while i < len(q):
        start, c = i, q[i]
        literal_end = _literal_end(q, i, logql=True)
        if literal_end is not None:
            i = literal_end
        elif c == "{":
            i, insert = _selector_insert(q, i, True, rendered)
            inserts.append(insert)
            i += 1
        elif c == "}":
            raise FilterError(UNREADABLE)
        elif c in "([":
            open_brackets.append(c)
            i += 1
        elif c in ")]":
            if not open_brackets or open_brackets.pop() != _CLOSER_OF[c]:
                raise FilterError(UNREADABLE)
            i += 1
        else:
            i += 1
        _check_progress(start, i)
    if open_brackets:
        raise FilterError(UNREADABLE)
    return _insert(q, inserts)
