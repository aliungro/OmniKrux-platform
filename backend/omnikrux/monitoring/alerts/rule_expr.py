"""The query text an alert runs: the panel's query with variables replaced by their defaults.

A port of the browser's `interpolate` (frontend/src/monitoring/dashboards/interpolate.ts): the
same quote-context scan, the same refusals, the same words. An alert has no viewer to choose
values, so each variable takes its default and the built-ins come from the alert's interval.
"""

import math
import re
from collections.abc import Mapping
from decimal import Decimal

from omnikrux.monitoring.alerts.types import Condition, Of

# The shortest $__rate_interval, in seconds. Same value as RATE_INTERVAL_FLOOR in
# frontend/src/monitoring/dashboards/interpolate.ts, so a chart and its alert agree.
RATE_INTERVAL_FLOOR = 240

ALL_PATTERN = ".+"

_DURATION = re.compile(r"(0|[1-9][0-9]*)(s|m|h)")
_UNIT = {"s": 1, "m": 60, "h": 3600}
_TOKEN = re.compile(r"\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))")
_BARE_SAFE = re.compile(r"[A-Za-z0-9_:.]*")
_LONE_RETURN = re.compile(r"\r(?!\n)")
_REGEX_SPECIAL = re.compile(r"[\\.^$|?*+()\[\]{}]")
_TEMPLATE = re.compile(r"\{\{(value|[A-Za-z_][A-Za-z0-9_]*)\}\}")

RANGE_COPY = "An alert can't use $__range; write the window into the query, like [5m]."
LOG_QUERY_COPY = (
    'A Loki alert needs a metric query, like sum(count_over_time({app="api"} |= "error" [5m])).'
)


def no_default_copy(name: str) -> str:
    return (
        f"Uses ${name}, which has no default value. "
        "Alerts use each variable's default, so give it one."
    )


def not_a_variable_copy(name: str) -> str:
    return f"Uses ${name}, which isn't a variable here. Write the value into the query."


def refused_copy(name: str) -> str:
    return (
        f"The value of ${name} can't be used here. Put ${name} inside double quotes in the query."
    )


def lone_return_copy(name: str) -> str:
    return (
        f"The query has a carriage return outside quotes, so ${name} can't be placed safely. "
        "Remove it, or start a new line instead."
    )


class RuleExprError(ValueError):
    """The text says why the alert's query can't be run as written."""


def parse_duration(text: str) -> int:
    m = _DURATION.fullmatch(text)
    if m is None:
        raise ValueError(f"Not a duration: {text!r}")
    return int(m.group(1)) * _UNIT[m.group(2)]


def duration_text(seconds: int) -> str:
    s = max(0, seconds)
    if s >= 3600 and s % 3600 == 0:
        return f"{s // 3600}h"
    if s >= 60 and s % 60 == 0:
        return f"{s // 60}m"
    return f"{s}s"


def escape_query_string(v: str) -> str:
    return v.replace("\\", "\\\\").replace('"', '\\"').replace("\r", "\\r").replace("\n", "\\n")


def _escape_single_quoted(v: str) -> str:
    return v.replace("\\", "\\\\").replace("'", "\\'").replace("\r", "\\r").replace("\n", "\\n")


def escape_regex(v: str) -> str:
    return _REGEX_SPECIAL.sub(lambda m: "\\" + m.group(0), v)


# A variable's default: (multi, "all" or its values).
Defaults = Mapping[str, tuple[bool, "str | list[str]"]]


def _render(name: str, variables: Defaults, quote: str | None) -> str | None:
    if name not in variables:
        return None
    multi, value = variables[name]
    regex = False
    if value == "all":
        text = ALL_PATTERN
        regex = True
    elif multi:
        regex = True
        text = "|".join(escape_regex(v) for v in value) if value else ALL_PATTERN
    else:
        if not value:
            raise RuleExprError(no_default_copy(name))
        text = value[0]
    if quote == '"':
        return escape_query_string(text)
    if quote == "'":
        return _escape_single_quoted(text)
    if quote == "`":
        if "`" in text:
            raise RuleExprError(refused_copy(name))
        return text
    if regex or _BARE_SAFE.fullmatch(text) is None:
        raise RuleExprError(refused_copy(name))
    return text


def substitute(
    text: str, variables: Defaults, every_seconds: int, *, unknown_refused: bool = False
) -> str:
    """`text` with the built-ins from the interval and variables from their defaults.

    Raises RuleExprError for $__range, a single-value variable without a default, and any value
    that can't be placed where its variable sits. A `$name` that isn't a variable stays as
    written, or, with `unknown_refused`, is refused too.
    """
    out: list[str] = []
    quote: str | None = None
    i = 0
    lone_return = False
    placed: str | None = None
    n = len(text)
    while i < n:
        c = text[i]
        if quote is None and c == "#":
            nl = text.find("\n", i)
            end = n if nl == -1 else nl
            if _LONE_RETURN.search(text[i : end + 1]):
                lone_return = True
            out.append(text[i:end])
            i = end
            continue
        if quote is None and c == "\r" and text[i + 1 : i + 2] != "\n":
            lone_return = True
        if c == "$":
            m = _TOKEN.match(text, i)
            if m:
                name = m.group(1) or m.group(2)
                if name == "__interval":
                    rendered: str | None = duration_text(every_seconds)
                elif name == "__rate_interval":
                    rendered = duration_text(max(4 * every_seconds, RATE_INTERVAL_FLOOR))
                elif name == "__range":
                    raise RuleExprError(RANGE_COPY)
                elif unknown_refused and name not in variables:
                    raise RuleExprError(not_a_variable_copy(name))
                else:
                    rendered = _render(name, variables, quote)
                    if rendered is not None and placed is None:
                        placed = name
                out.append(m.group(0) if rendered is None else rendered)
                i += len(m.group(0))
                continue
        if quote in ('"', "'"):
            if c == "\\" and i + 1 < n:
                out.append(c + text[i + 1])
                i += 2
                continue
            if c == quote:
                quote = None
        elif quote == "`":
            if c == "`":
                quote = None
        elif c in ('"', "'", "`"):
            quote = c
        out.append(c)
        i += 1
    if lone_return and placed is not None:
        raise RuleExprError(lone_return_copy(placed))
    return "".join(out)


def expr_without_document(text: str, every_seconds: int) -> str:
    """A query written on its own (a page rule, a dry run), ready to run at the interval: the
    built-ins placed as `rule_expr` places them; any other `$name` is refused, since no document
    gives it a value. Raises RuleExprError."""
    return substitute(text, {}, every_seconds, unknown_refused=True)


def variable_defaults(variables: list) -> dict[str, tuple[bool, "str | list[str]"]]:
    """Each variable's default, from a dashboard document's `variables` list."""
    out: dict[str, tuple[bool, str | list[str]]] = {}
    for v in variables:
        if not isinstance(v, dict) or not isinstance(v.get("name"), str):
            continue
        default = v.get("default", [])
        if default != "all":
            default = (
                [d for d in default if isinstance(d, str)] if isinstance(default, list) else []
            )
        out.setdefault(v["name"], (bool(v.get("multi", False)), default))
    return out


def rule_expr(doc: dict, panel: dict) -> str:
    """The panel alert's query text, ready to run at the alert's interval."""
    alert = panel.get("alert")
    if not isinstance(alert, dict):
        raise RuleExprError("This panel has no alert.")
    query = next((q for q in panel.get("queries", []) if q.get("ref") == alert.get("query")), None)
    if query is None:
        raise RuleExprError("Use the ref of one of this panel's queries, like A.")
    every = parse_duration(alert.get("every", "1m"))
    return substitute(query["expr"], variable_defaults(doc.get("variables", [])), every)


def _number_text(value: float) -> str:
    text = repr(float(value))
    return text.removesuffix(".0")


def _in_raw_after(line: str, inside: bool) -> bool:
    """Whether a backtick raw string is still open at the end of `line` (open at its start when
    `inside`). Double and single quotes end on their line; `#` outside quotes starts a comment."""
    quote: str | None = "`" if inside else None
    i, n = 0, len(line)
    while i < n:
        c = line[i]
        if quote == "`":
            if c == "`":
                quote = None
        elif quote is not None:
            if c == "\\":
                i += 1
            elif c == quote:
                quote = None
        elif c == "#":
            break
        elif c in "\"'`":
            quote = c
        i += 1
    return quote == "`"


def tidy_query(expr: str) -> str:
    """The query as it is wrapped: without the blank space around it or blank lines inside it,
    so a rule written over a few lines reads as one in its tool (`(count(up)\n) > 0`). A blank
    line inside a backtick raw string is part of its value and stays."""
    out: list[str] = []
    inside = False
    for line in expr.strip().split("\n"):
        if inside or line.strip():
            out.append(line)
        inside = _in_raw_after(line, inside)
    return "\n".join(out)


def _word(c: str) -> bool:
    return c.isalnum() or c in "_:."


def query_shape(text: str) -> str:
    """The text with its spacing made plain: white space outside strings and comments dropped,
    except one space between two word characters (`a or b` stays apart from `aorb`). Strings and
    comments are kept as written; a comment still ends its line."""
    out: list[str] = []
    space = False
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in " \t\r\n":
            space = True
            i += 1
            continue
        if c == "#":
            end = text.find("\n", i)
            end = n if end == -1 else end
            out.append(text[i:end].rstrip() + "\n")
            space = False
            i = end
            continue
        if c in "\"'`":
            j = i + 1
            while j < n and text[j] != c:
                j += 2 if c != "`" and text[j] == "\\" else 1
            token = text[i : j + 1]
        else:
            token = c
        if space and out and _word(out[-1][-1]) and _word(token[0]):
            out.append(" ")
        space = False
        out.append(token)
        i += len(token)
    return "".join(out)


def same_query_text(a: str, b: str) -> bool:
    """Whether two rule texts are the same query, whatever their spacing (a text stored before
    queries were tidied, and the same query tidied)."""
    return a == b or query_shape(a) == query_shape(b)


def condition_expr(expr: str, cond: Condition) -> str:
    """The rule's condition. A line feed ends the operand, so a `#` comment at the end of the
    query can't swallow what the wrapper adds after it."""
    sign = ">" if cond.op == "above" else "<"
    text = tidy_query(expr)
    left = f"sum({text}\n)" if cond.of == "total" else f"({text}\n)"
    return f"{left} {sign} {_number_text(cond.threshold)}"


def eval_expr(expr: str, of: Of) -> str:
    text = tidy_query(expr)
    return f"sum({text}\n)" if of == "total" else text


def is_log_query(expr: str) -> bool:
    return expr.strip().startswith("{")


def _message_parts(message: str):
    """The message left to right: ("name", label or "value") for a placeholder, else ("text", s).

    A `{{` or `}}` that isn't part of a placeholder is its own text part, scanned from the left
    like the browser does, so both readings of `{{{value}}}` agree.
    """
    i = 0
    while i < len(message):
        m = _TEMPLATE.match(message, i)
        if m:
            yield "name", m.group(1)
            i = m.end()
        elif message.startswith(("{{", "}}"), i):
            yield "text", message[i : i + 2]
            i += 2
        else:
            yield "text", message[i]
            i += 1


def to_prometheus_template(message: str) -> str:
    """The message as a Prometheus annotation template.

    Only {{name}} and {{value}} become template actions. Every other `{{` or `}}` is written as
    a Go string action, so the notification shows the text as typed and no other action (such as
    `query`, which would run PromQL unfiltered) can run.
    """
    out: list[str] = []
    for kind, part in _message_parts(message):
        if kind == "name":
            out.append("{{ $value }}" if part == "value" else "{{ $labels." + part + " }}")
        elif part in ("{{", "}}"):
            out.append('{{ "' + part + '" }}')
        else:
            out.append(part)
    return "".join(out)


def _three_digits(value: float) -> str:
    """Three significant digits, written out in full: never an exponent."""
    text = f"{value:.3g}"
    if "e" in text:
        return format(Decimal(text), "f")
    return text


def render_message(message: str, labels: Mapping[str, str], value: float | None) -> str:
    out: list[str] = []
    for kind, part in _message_parts(message):
        if kind == "text":
            out.append(part)
        elif part == "value":
            shown = "–" if value is None or not math.isfinite(value) else _three_digits(value)
            out.append(shown)
        else:
            out.append(labels.get(part, ""))
    return "".join(out)
