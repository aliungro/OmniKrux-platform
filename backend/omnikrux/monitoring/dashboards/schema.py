"""The dashboard document (schemaVersion 1) and its validation.

A hand-written walker over plain JSON values, so the problem copy and order are exact and the
browser's walker can follow it field for field. Both run the same case file.

Order of problems: each object's fields in the schema table's order (a nested object's problems
come at its field's place), then that object's unknown keys in code-point order.
"""

import copy
import json
import math
import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from omnikrux.monitoring.alerts.rule_expr import (
    LOG_QUERY_COPY,
    RuleExprError,
    is_log_query,
    parse_duration,
    substitute,
    variable_defaults,
)
from omnikrux.monitoring.alerts.types import (
    ALERT_PANEL_TYPES,
    EVERY_CHOICES,
    MAX_CHANNEL_LABELS,
    MAX_FOR_SECONDS,
    MAX_NOTIFY,
    SEVERITIES,
)

OwnerKind = Literal["project", "group"]

SCHEMA_VERSION = 1
GRID_COLUMNS = 24
MAX_PANELS = 100
MAX_QUERIES = 10
MAX_VARIABLES = 20
MAX_THRESHOLDS = 10
MAX_DOCUMENT_BYTES = 1_000_000
MAX_PROBLEMS = 50
PANEL_TYPES = ("timeseries", "stat", "gauge", "bar", "table", "logs")
UNITS = ("none", "short", "percent", "percentunit", "s", "ms", "bytes", "Bps", "reqps", "cores")
REFRESH_CHOICES = (None, "10s", "30s", "1m", "5m", "15m", "1h")
DEFAULT_SIZES = {
    "timeseries": (12, 8),
    "stat": (6, 4),
    "gauge": (6, 6),
    "bar": (12, 8),
    "table": (12, 8),
    "logs": (24, 10),
}
BUILTIN_VARIABLES = ("__interval", "__rate_interval", "__range")

DEFAULT_TIME = {"from": "now-6h", "to": "now"}
SOURCE_TYPES = ("prometheus", "loki")
THRESHOLD_COLORS = ("ok", "warn", "bad")
MAX_VARIABLE_VALUES = 100

_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,39}")
_LABEL = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_PANEL_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,39}")
_REF = re.compile(r"[A-Z]")
_REL_TIME = re.compile(r"now-([0-9]+)([smhdw])")
_ABS_TIME = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")
_USED = re.compile(r"\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))")
_CONTACT_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")
_UNIT_SECONDS = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}

_TIME_COPY = 'Use "now", "now-<number><s|m|h|d|w>", or a UTC time like 2026-11-19T10:00:00Z.'
_NAME_COPY = (
    "Use letters, digits and _, starting with a letter or _, at most 40 characters, "
    "not starting with __."
)
_ID_COPY = "Use 1 to 40 lower-case letters, digits or dashes, starting with a letter or digit."
_GROUP_ID_COPY = 'In a group dashboard each project uses its own source, so "id" must be null.'

_MISSING = object()


@dataclass(frozen=True)
class Problem:
    path: str
    message: str


class DashboardInvalid(ValueError):
    def __init__(self, problems: tuple[Problem, ...]):
        self.problems = problems
        first = problems[0]
        super().__init__(f"{first.path}: {first.message}")


class _Walk:
    def __init__(self, owner_kind: OwnerKind):
        self.owner_kind = owner_kind
        self.problems: list[Problem] = []

    def add(self, path: str, message: str) -> None:
        if len(self.problems) < MAX_PROBLEMS:
            self.problems.append(Problem(path, message))


def _at(path: str, key: str | int) -> str:
    if isinstance(key, int):
        return f"{path}[{key}]"
    return f"{path}.{key}" if path else key


def _tidy(n: float) -> int | float:
    return int(n) if isinstance(n, float) and n.is_integer() else n


def _is_number(v: object) -> bool:
    return isinstance(v, int | float) and not isinstance(v, bool)


def _number(w: _Walk, raw: object, path: str) -> int | float | None:
    if not _is_number(raw):
        w.add(path, "Expected a number.")
        return None
    if isinstance(raw, float) and not math.isfinite(raw):
        w.add(path, "Expected a finite number.")
        return None
    if isinstance(raw, int) and not _fits_a_double(raw):
        # The browser reads such a number as Infinity: refused the same way on both sides.
        w.add(path, "Expected a finite number.")
        return None
    return _tidy(raw)


def _fits_a_double(n: int) -> bool:
    try:
        float(n)
    except OverflowError:
        return False
    return True


def _whole(w: _Walk, raw: object, path: str, lo: int, hi: int, message: str) -> int | None:
    n = _number(w, raw, path)
    if n is None:
        return None
    if int(n) != n or not lo <= n <= hi:
        w.add(path, message)
        return None
    return int(n)


def _text(w: _Walk, raw: object, path: str) -> str | None:
    if not isinstance(raw, str):
        w.add(path, "Expected text.")
        return None
    return raw


def _boolean(w: _Walk, raw: object, path: str) -> bool | None:
    if not isinstance(raw, bool):
        w.add(path, "Expected true or false.")
        return None
    return raw


def _list(w: _Walk, raw: object, path: str) -> list | None:
    if not isinstance(raw, list):
        w.add(path, "Expected a list.")
        return None
    return raw


def _object(w: _Walk, raw: object, path: str) -> dict | None:
    if not isinstance(raw, dict):
        w.add(path, "Expected an object.")
        return None
    return raw


def _enum(w: _Walk, raw: object, path: str, choices: tuple[str, ...], message: str | None = None):
    text = _text(w, raw, path)
    if text is None:
        return None
    if text not in choices:
        w.add(path, message or f"Use one of: {', '.join(choices)}.")
        return None
    return text


def _unknown(w: _Walk, raw: dict, path: str, known: tuple[str, ...]) -> None:
    for key in sorted(k for k in raw if k not in known):
        w.add(_at(path, key), f'Unknown field "{key}".')


def _required(w: _Walk, raw: dict, path: str, key: str):
    if key not in raw:
        w.add(_at(path, key), "Required.")
    return raw.get(key, _MISSING)


def _has_control(text: str) -> bool:
    return any(unicodedata.category(c) == "Cc" for c in text)


def _short_text(w: _Walk, raw: object, path: str, lo: int, message: str) -> str | None:
    """Single-line text of lo to 120 characters; surrounding whitespace is trimmed."""
    text = _text(w, raw, path)
    if text is None:
        return None
    if _has_control(text):
        w.add(path, message)
        return None
    text = text.strip()
    if not lo <= len(text) <= 120:
        w.add(path, message)
        return None
    return text


def _long_text(w: _Walk, raw: object, path: str, limit: int, message: str) -> str | None:
    text = _text(w, raw, path)
    if text is None:
        return None
    if len(text) > limit:
        w.add(path, message)
        return None
    return text


def variables_used(text: str) -> list[str]:
    """Names used as $name or ${name}, in order, without duplicates."""
    seen: list[str] = []
    for m in _USED.finditer(text):
        name = m.group(1) or m.group(2)
        if name not in seen:
            seen.append(name)
    return seen


# --- time ---------------------------------------------------------------------------------


def _time_point(w: _Walk, raw: object, path: str) -> str | None:
    text = _text(w, raw, path)
    if text is None:
        return None
    if text == "now" or _REL_TIME.fullmatch(text):
        return text
    if _ABS_TIME.fullmatch(text):
        try:
            datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            pass
        else:
            return text
    w.add(path, _TIME_COPY)
    return None


def _relative_offset(text: str) -> int | None:
    """Seconds back from now, or None for an absolute time."""
    if text == "now":
        return 0
    m = _REL_TIME.fullmatch(text)
    return int(m.group(1)) * _UNIT_SECONDS[m.group(2)] if m else None


def _time(w: _Walk, raw: object, path: str) -> dict:
    if raw is _MISSING:
        return dict(DEFAULT_TIME)
    obj = _object(w, raw, path)
    if obj is None:
        return dict(DEFAULT_TIME)
    start = _time_point(w, obj.get("from", DEFAULT_TIME["from"]), _at(path, "from"))
    end = _time_point(w, obj.get("to", DEFAULT_TIME["to"]), _at(path, "to"))
    _unknown(w, obj, path, ("from", "to"))
    if start is not None and end is not None:
        a, b = _relative_offset(start), _relative_offset(end)
        backwards = False
        if a is not None and b is not None:
            backwards = a <= b  # further back in time is earlier
        elif a is None and b is None:
            backwards = start >= end  # fixed-width UTC strings sort as times
        if backwards:
            w.add(path, "The start has to be before the end.")
    return {"from": start, "to": end}


# --- sources, variables ---------------------------------------------------------------------


def _source(w: _Walk, raw: object, path: str) -> dict:
    obj = _object(w, raw, path)
    if obj is None:
        return {"type": None, "id": None}
    type_raw = _required(w, obj, path, "type")
    kind = None
    if type_raw is not _MISSING:
        kind = _enum(w, type_raw, _at(path, "type"), SOURCE_TYPES, 'Use "prometheus" or "loki".')
    sid: str | None = None
    if "id" in obj and obj["id"] is not None:
        sid = _text(w, obj["id"], _at(path, "id"))
        if sid is not None and w.owner_kind == "group":
            w.add(_at(path, "id"), _GROUP_ID_COPY)
            sid = None
    _unknown(w, obj, path, ("type", "id"))
    return {"type": kind, "id": sid}


def _variable_default(w: _Walk, raw: dict, path: str, multi: bool | None, include_all: bool | None):
    if "default" not in raw:
        return []
    p = _at(path, "default")
    value = raw["default"]
    if value == "all":
        if include_all is not True:
            w.add(p, '"all" needs includeAll: true.')
        return "all"
    items = _list(w, value, p)
    if items is None:
        return []
    if len(items) > MAX_VARIABLE_VALUES:
        w.add(p, "At most 100 values.")
    if len(items) > 1 and multi is not True:
        w.add(p, "Only a multi-value variable can start with more than one value.")
    return [_text(w, item, _at(p, i)) for i, item in enumerate(items)]


def _check_uses(
    w: _Walk,
    text: str,
    path: str,
    defined: dict[str, int],
    before: int | None,
) -> None:
    """Every $name in text is a built-in or a variable (before index `before`, when given)."""
    for name in variables_used(text):
        if name in BUILTIN_VARIABLES:
            continue
        if name not in defined:
            w.add(path, f"Uses ${name}, which isn't a variable of this dashboard.")
        elif before is not None and defined[name] >= before:
            w.add(path, f"Uses ${name}, which comes after this variable. Move {name} before it.")


def _variable(
    w: _Walk, raw: object, path: str, index: int, seen: set[str], defined: dict[str, int]
):
    obj = _object(w, raw, path)
    if obj is None:
        return None
    out: dict = {}
    name_raw = _required(w, obj, path, "name")
    name: str | None = None
    if name_raw is not _MISSING:
        name = _text(w, name_raw, _at(path, "name"))
        if name is not None:
            if not _NAME.fullmatch(name) or name.startswith("__"):
                w.add(_at(path, "name"), _NAME_COPY)
                name = None
            elif name in seen:
                w.add(_at(path, "name"), f'Another variable is already named "{name}".')
            else:
                seen.add(name)
    out["name"] = name
    label = name
    if "label" in obj:
        label = _short_text(
            w, obj["label"], _at(path, "label"), 1, "Use 1 to 120 characters, without line breaks."
        )
    out["label"] = label
    type_raw = _required(w, obj, path, "type")
    if type_raw is not _MISSING:
        _enum(w, type_raw, _at(path, "type"), ("labelValues",))
    out["type"] = "labelValues"
    src_raw = _required(w, obj, path, "source")
    out["source"] = _source(w, src_raw, _at(path, "source")) if src_raw is not _MISSING else None
    label_raw = _required(w, obj, path, "labelName")
    label_name = None
    if label_raw is not _MISSING:
        label_name = _text(w, label_raw, _at(path, "labelName"))
        if label_name is not None and not _LABEL.fullmatch(label_name):
            w.add(
                _at(path, "labelName"),
                "Use a label name: letters, digits and _, not starting with a digit.",
            )
    out["labelName"] = label_name
    match = ""
    if "match" in obj:
        text = _long_text(w, obj["match"], _at(path, "match"), 1000, "Use at most 1000 characters.")
        if text is not None:
            match = text
            _check_uses(w, text, _at(path, "match"), defined, index)
    out["match"] = match
    multi = _boolean(w, obj["multi"], _at(path, "multi")) if "multi" in obj else False
    include_all = (
        _boolean(w, obj["includeAll"], _at(path, "includeAll")) if "includeAll" in obj else False
    )
    out["multi"] = multi
    out["includeAll"] = include_all
    out["default"] = _variable_default(w, obj, path, multi, include_all)
    _unknown(
        w,
        obj,
        path,
        ("name", "label", "type", "source", "labelName", "match", "multi", "includeAll", "default"),
    )
    return out


# --- panels -------------------------------------------------------------------------------


def _thresholds(w: _Walk, raw: object, path: str) -> list:
    items = _list(w, raw, path)
    if items is None:
        return []
    if len(items) > MAX_THRESHOLDS:
        w.add(path, "At most 10 thresholds.")
    out = []
    for i, item in enumerate(items):
        p = _at(path, i)
        obj = _object(w, item, p)
        if obj is None:
            continue
        value_raw = _required(w, obj, p, "value")
        value = None if value_raw is _MISSING else _number(w, value_raw, _at(p, "value"))
        color_raw = _required(w, obj, p, "color")
        color = None
        if color_raw is not _MISSING:
            color = _enum(w, color_raw, _at(p, "color"), THRESHOLD_COLORS, "Use ok, warn or bad.")
        _unknown(w, obj, p, ("value", "color"))
        out.append({"value": value, "color": color})
    return sorted(out, key=lambda t: t["value"] if t["value"] is not None else 0)


def _opt_number(w: _Walk, obj: dict, path: str, key: str, default):
    if key not in obj:
        return default
    if obj[key] is None:
        return None
    return _number(w, obj[key], _at(path, key))


def _opt_enum(w: _Walk, obj: dict, path: str, key: str, choices: tuple[str, ...]):
    if key not in obj:
        return choices[0]
    return _enum(w, obj[key], _at(path, key), choices)


def _opt_bool(w: _Walk, obj: dict, path: str, key: str, default: bool):
    return _boolean(w, obj[key], _at(path, key)) if key in obj else default


def _common_options(w: _Walk, obj: dict, path: str) -> dict:
    out: dict = {}
    if "unit" in obj:
        out["unit"] = _enum(
            w, obj["unit"], _at(path, "unit"), UNITS, f"Use one of: {', '.join(UNITS)}."
        )
    else:
        out["unit"] = "none"
    if "decimals" in obj and obj["decimals"] is not None:
        out["decimals"] = _whole(
            w,
            obj["decimals"],
            _at(path, "decimals"),
            0,
            6,
            "Use null or a whole number from 0 to 6.",
        )
    else:
        out["decimals"] = None
    out["thresholds"] = (
        _thresholds(w, obj["thresholds"], _at(path, "thresholds")) if "thresholds" in obj else []
    )
    return out


_COMMON_KEYS = ("unit", "decimals", "thresholds")
_OPTION_KEYS = {
    "timeseries": (*_COMMON_KEYS, "min", "max", "legend", "style"),
    "stat": (*_COMMON_KEYS, "calc", "sparkline"),
    "gauge": (*_COMMON_KEYS, "min", "max", "calc"),
    "bar": (*_COMMON_KEYS, "min", "legend", "orientation"),
    "table": (*_COMMON_KEYS, "columns", "sort"),
    "logs": ("limit", "wrap", "order"),
}
_CALCS = ("last", "mean", "max", "min", "sum")
_LEGENDS = ("bottom", "hidden")


def _table_sort(w: _Walk, raw: object, path: str):
    if raw is None:
        return None
    obj = _object(w, raw, path)
    if obj is None:
        return None
    column_raw = _required(w, obj, path, "column")
    column = None if column_raw is _MISSING else _text(w, column_raw, _at(path, "column"))
    descending = _opt_bool(w, obj, path, "descending", False)
    _unknown(w, obj, path, ("column", "descending"))
    return {"column": column, "descending": descending}


def _options(w: _Walk, raw: object, path: str, kind: str) -> dict:
    obj = _object(w, raw, path)
    if obj is None:
        return {}
    keys = _OPTION_KEYS[kind]
    out: dict = {} if kind == "logs" else _common_options(w, obj, path)
    if kind == "timeseries":
        out["min"] = _opt_number(w, obj, path, "min", None)
        out["max"] = _opt_number(w, obj, path, "max", None)
        out["legend"] = _opt_enum(w, obj, path, "legend", _LEGENDS)
        out["style"] = _opt_enum(w, obj, path, "style", ("lines", "area", "stacked"))
    elif kind == "stat":
        out["calc"] = _opt_enum(w, obj, path, "calc", _CALCS)
        out["sparkline"] = _opt_bool(w, obj, path, "sparkline", True)
    elif kind == "gauge":
        out["min"] = _opt_number(w, obj, path, "min", 0)
        out["max"] = _opt_number(w, obj, path, "max", None)
        out["calc"] = _opt_enum(w, obj, path, "calc", _CALCS)
    elif kind == "bar":
        out["min"] = _opt_number(w, obj, path, "min", None)
        out["legend"] = _opt_enum(w, obj, path, "legend", _LEGENDS)
        out["orientation"] = _opt_enum(w, obj, path, "orientation", ("horizontal", "vertical"))
    elif kind == "table":
        columns: list = []
        if "columns" in obj:
            items = _list(w, obj["columns"], _at(path, "columns"))
            if items is not None:
                columns = [_text(w, c, _at(_at(path, "columns"), i)) for i, c in enumerate(items)]
        out["columns"] = columns
        out["sort"] = _table_sort(w, obj["sort"], _at(path, "sort")) if "sort" in obj else None
    else:
        out["limit"] = (
            _whole(
                w, obj["limit"], _at(path, "limit"), 1, 1000, "Use a whole number from 1 to 1000."
            )
            if "limit" in obj
            else 100
        )
        out["wrap"] = _opt_bool(w, obj, path, "wrap", True)
        out["order"] = _opt_enum(w, obj, path, "order", ("newest", "oldest"))
    _unknown(w, obj, path, keys)
    return out


def _layout(w: _Walk, raw: object, path: str, placed: list[tuple[str, dict]], panel_id: str | None):
    obj = _object(w, raw, path)
    if obj is None:
        return None
    specs = (
        ("x", 0, 22, "Use a whole number from 0 to 22."),
        ("y", 0, 999, "Use a whole number from 0 to 999."),
        ("w", 2, 24, "Use a whole number from 2 to 24."),
        ("h", 2, 40, "Use a whole number from 2 to 40."),
    )
    values: dict[str, int | None] = {}
    for key, lo, hi, message in specs:
        value = _required(w, obj, path, key)
        values[key] = (
            None if value is _MISSING else _whole(w, value, _at(path, key), lo, hi, message)
        )
    clean = all(v is not None for v in values.values())
    if (
        values["x"] is not None
        and values["w"] is not None
        and values["x"] + values["w"] > GRID_COLUMNS
    ):
        w.add(path, "x + w can't be more than 24 (the grid is 24 columns wide).")
        clean = False
    _unknown(w, obj, path, ("x", "y", "w", "h"))
    if clean:
        x, y, ww, h = (values[k] for k in ("x", "y", "w", "h"))
        for other_id, o in placed:
            if x < o["x"] + o["w"] and o["x"] < x + ww and y < o["y"] + o["h"] and o["y"] < y + h:
                w.add(path, f'Panel "{panel_id}" overlaps panel "{other_id}". Move one of them.')
                break
        placed.append((panel_id or "", {"x": x, "y": y, "w": ww, "h": h}))
    return values


def _query(w: _Walk, raw: object, path: str, refs: set[str], defined: dict[str, int]):
    obj = _object(w, raw, path)
    if obj is None:
        return None
    ref_raw = _required(w, obj, path, "ref")
    ref = None
    if ref_raw is not _MISSING:
        ref = _text(w, ref_raw, _at(path, "ref"))
        if ref is not None:
            if not _REF.fullmatch(ref) or ref in refs:
                w.add(_at(path, "ref"), "Use a capital letter A to Z, different for each query.")
                ref = None
            else:
                refs.add(ref)
    src_raw = _required(w, obj, path, "source")
    source = _source(w, src_raw, _at(path, "source")) if src_raw is not _MISSING else None
    expr_raw = _required(w, obj, path, "expr")
    expr = None
    if expr_raw is not _MISSING:
        expr = _text(w, expr_raw, _at(path, "expr"))
        if expr is not None:
            if not 1 <= len(expr) <= 10000:
                w.add(_at(path, "expr"), "Use 1 to 10000 characters.")
                expr = None
            else:
                _check_uses(w, expr, _at(path, "expr"), defined, None)
    legend = ""
    if "legend" in obj:
        legend = _long_text(
            w, obj["legend"], _at(path, "legend"), 200, "Use at most 200 characters."
        )
    hidden = _boolean(w, obj["hidden"], _at(path, "hidden")) if "hidden" in obj else False
    _unknown(w, obj, path, ("ref", "source", "expr", "legend", "hidden"))
    return {"ref": ref, "source": source, "expr": expr, "legend": legend, "hidden": hidden}


def _is_loki_query(raw: object) -> bool:
    return (
        isinstance(raw, dict)
        and isinstance(raw.get("source"), dict)
        and raw["source"].get("type") == "loki"
    )


def _queries(w: _Walk, raw: object, path: str, kind: str | None, defined: dict[str, int]):
    items = _list(w, raw, path)
    if items is None:
        return []
    if kind == "logs":
        if len(items) != 1 or not _is_loki_query(items[0]):
            w.add(path, "A logs panel has exactly one Loki query.")
    elif not 1 <= len(items) <= MAX_QUERIES:
        w.add(path, "A panel has 1 to 10 queries.")
    refs: set[str] = set()
    return [_query(w, item, _at(path, i), refs, defined) for i, item in enumerate(items)]


def _alert_query(w: _Walk, raw: object, path: str, queries: list, variables: list, every: int):
    """The ref of one of this panel's queries, whose text an alert can run."""
    ref = _text(w, raw, path)
    if ref is None:
        return None
    query = next((q for q in queries if q and q["ref"] == ref), None)
    if query is None:
        w.add(path, "Use the ref of one of this panel's queries, like A.")
        return None
    expr = query["expr"]
    if expr is None:
        return ref
    if (query["source"] or {}).get("type") == "loki" and is_log_query(expr):
        w.add(path, LOG_QUERY_COPY)
        return ref
    try:
        substitute(expr, variable_defaults(variables), every)
    except RuleExprError as err:
        w.add(path, str(err))
    return ref


def _channel(w: _Walk, raw: object, path: str, engine: str | None):
    if raw is None:
        return None
    obj = _object(w, raw, path)
    if obj is None:
        return None
    if engine is not None and engine != "tool":
        w.add(path, "A channel is only for alerts that run in the tool.")
    receiver_raw = _required(w, obj, path, "receiver")
    receiver = None
    if receiver_raw is not _MISSING:
        receiver = _text(w, receiver_raw, _at(path, "receiver"))
        if receiver is not None and not 1 <= len(receiver) <= 200:
            w.add(_at(path, "receiver"), "Use 1 to 200 characters.")
            receiver = None
    labels: dict = {}
    if "labels" in obj:
        lp = _at(path, "labels")
        items = _object(w, obj["labels"], lp)
        if items is not None:
            if len(items) > MAX_CHANNEL_LABELS:
                w.add(lp, "At most 10 labels.")
            for key, value in sorted(items.items()):
                if not _LABEL.fullmatch(key):
                    w.add(
                        _at(lp, key),
                        "Use a label name: letters, digits and _, not starting with a digit.",
                    )
                    continue
                labels[key] = _long_text(w, value, _at(lp, key), 200, "Use at most 200 characters.")
    _unknown(w, obj, path, ("receiver", "labels"))
    return {"receiver": receiver, "labels": labels}


def _notify(w: _Walk, raw: object, path: str) -> list:
    items = _list(w, raw, path)
    if items is None:
        return []
    if len(items) > MAX_NOTIFY:
        w.add(path, "At most 10 contact points.")
    out: list = []
    for i, item in enumerate(items):
        p = _at(path, i)
        text = _text(w, item, p)
        if text is None:
            continue
        if not _CONTACT_ID.fullmatch(text):
            w.add(p, "Use a contact point id.")
        elif text in out:
            w.add(p, "Each contact point only once.")
        else:
            out.append(text)
    return out


def _duration(w: _Walk, raw: object, path: str) -> str | None:
    text = _text(w, raw, path)
    if text is None:
        return None
    try:
        seconds = parse_duration(text)
    except ValueError:
        seconds = -1
    if not 0 <= seconds <= MAX_FOR_SECONDS:
        w.add(path, "Use a duration from 0s to 24h, like 5m.")
        return None
    return text


_ALERT_KEYS = (
    "name",
    "query",
    "of",
    "op",
    "threshold",
    "for",
    "every",
    "severity",
    "message",
    "notify",
    "engine",
    "channel",
)


def _alert(w: _Walk, raw: object, path: str, kind: str | None, queries: list, variables: list):
    if kind is not None and kind not in ALERT_PANEL_TYPES:
        w.add(
            path,
            f"A {kind} panel can't have an alert. Use a time series, stat, gauge or bar panel.",
        )
        return None
    obj = _object(w, raw, path)
    if obj is None:
        return None
    out: dict = {}
    name_raw = _required(w, obj, path, "name")
    out["name"] = (
        None
        if name_raw is _MISSING
        else _short_text(
            w, name_raw, _at(path, "name"), 1, "Use 1 to 120 characters, without line breaks."
        )
    )
    every_raw = obj.get("every", "1m")
    every = EVERY_CHOICES.get(every_raw, 60) if isinstance(every_raw, str) else 60
    query_raw = _required(w, obj, path, "query")
    out["query"] = (
        None
        if query_raw is _MISSING
        else _alert_query(w, query_raw, _at(path, "query"), queries, variables, every)
    )
    out["of"] = _opt_enum(w, obj, path, "of", ("each", "total"))
    op_raw = _required(w, obj, path, "op")
    out["op"] = (
        None if op_raw is _MISSING else _enum(w, op_raw, _at(path, "op"), ("above", "below"))
    )
    threshold_raw = _required(w, obj, path, "threshold")
    out["threshold"] = (
        None if threshold_raw is _MISSING else _number(w, threshold_raw, _at(path, "threshold"))
    )
    out["for"] = _duration(w, obj["for"], _at(path, "for")) if "for" in obj else "5m"
    out["every"] = (
        _enum(w, obj["every"], _at(path, "every"), tuple(EVERY_CHOICES), "Use 30s, 1m or 5m.")
        if "every" in obj
        else "1m"
    )
    out["severity"] = (
        _enum(w, obj["severity"], _at(path, "severity"), SEVERITIES)
        if "severity" in obj
        else "warning"
    )
    out["message"] = (
        _long_text(w, obj["message"], _at(path, "message"), 500, "Use at most 500 characters.")
        if "message" in obj
        else ""
    )
    out["notify"] = _notify(w, obj["notify"], _at(path, "notify")) if "notify" in obj else []
    out["engine"] = _opt_enum(w, obj, path, "engine", ("omnikrux", "tool"))
    out["channel"] = (
        _channel(w, obj["channel"], _at(path, "channel"), out["engine"])
        if "channel" in obj
        else None
    )
    _unknown(w, obj, path, _ALERT_KEYS)
    return out


def _panel(
    w: _Walk,
    raw: object,
    path: str,
    ids: set[str],
    placed: list[tuple[str, dict]],
    defined: dict[str, int],
    variables: list,
):
    obj = _object(w, raw, path)
    if obj is None:
        return None
    out: dict = {}
    id_raw = _required(w, obj, path, "id")
    shown_id = id_raw if isinstance(id_raw, str) else ""
    panel_id: str | None = None
    if id_raw is not _MISSING:
        panel_id = _text(w, id_raw, _at(path, "id"))
        if panel_id is not None:
            if not _PANEL_ID.fullmatch(panel_id):
                w.add(_at(path, "id"), _ID_COPY)
                panel_id = None
            elif panel_id in ids:
                w.add(_at(path, "id"), f'Another panel already has the id "{panel_id}".')
            else:
                ids.add(panel_id)
    out["id"] = panel_id
    type_raw = _required(w, obj, path, "type")
    kind = None
    if type_raw is not _MISSING:
        kind = _enum(
            w,
            type_raw,
            _at(path, "type"),
            PANEL_TYPES,
            f"Use one of: {', '.join(PANEL_TYPES)}.",
        )
    out["type"] = kind
    title_raw = _required(w, obj, path, "title")
    out["title"] = (
        None
        if title_raw is _MISSING
        else _short_text(
            w, title_raw, _at(path, "title"), 0, "Use at most 120 characters, without line breaks."
        )
    )
    out["description"] = (
        _long_text(
            w, obj["description"], _at(path, "description"), 2000, "Use at most 2000 characters."
        )
        if "description" in obj
        else ""
    )
    layout_raw = _required(w, obj, path, "layout")
    out["layout"] = (
        None
        if layout_raw is _MISSING
        else _layout(w, layout_raw, _at(path, "layout"), placed, shown_id)
    )
    queries_raw = _required(w, obj, path, "queries")
    out["queries"] = (
        []
        if queries_raw is _MISSING
        else _queries(w, queries_raw, _at(path, "queries"), kind, defined)
    )
    if kind is None:
        out["options"] = {}  # without a valid type there is nothing to check the options against
    elif "options" in obj:
        out["options"] = _options(w, obj["options"], _at(path, "options"), kind)
    else:
        out["options"] = _options(w, {}, _at(path, "options"), kind)
    out["alert"] = (
        _alert(w, obj["alert"], _at(path, "alert"), kind, out["queries"], variables)
        if "alert" in obj and obj["alert"] is not None
        else None
    )
    _unknown(
        w,
        obj,
        path,
        ("id", "type", "title", "description", "layout", "queries", "options", "alert"),
    )
    return out


# --- the document ---------------------------------------------------------------------------


def _document_bytes(raw: object) -> int:
    try:
        text = json.dumps(raw, ensure_ascii=False, separators=(",", ":"))
        return len(text.encode("utf-8", errors="surrogatepass"))
    except (TypeError, ValueError, RecursionError):
        return 0


def validate_dashboard(raw: object, *, owner_kind: OwnerKind) -> dict:
    """The normalised document, or `DashboardInvalid` with up to 50 problems in document order."""
    if _document_bytes(raw) > MAX_DOCUMENT_BYTES:
        raise DashboardInvalid((Problem("", "The dashboard is larger than 1 MB."),))
    w = _Walk(owner_kind)
    doc = _document(w, raw)
    if w.problems:
        raise DashboardInvalid(tuple(w.problems))
    return doc


def _document(w: _Walk, raw: object) -> dict:
    obj = _object(w, raw, "")
    if obj is None:
        return {}
    version = _required(w, obj, "", "schemaVersion")
    if version is not _MISSING and not (_is_number(version) and version == SCHEMA_VERSION):
        w.add("schemaVersion", "This OmniKrux reads dashboards with schemaVersion 1.")
    out: dict = {"schemaVersion": SCHEMA_VERSION}
    title_raw = _required(w, obj, "", "title")
    out["title"] = (
        None
        if title_raw is _MISSING
        else _short_text(w, title_raw, "title", 1, "Use 1 to 120 characters, without line breaks.")
    )
    out["description"] = (
        _long_text(w, obj["description"], "description", 2000, "Use at most 2000 characters.")
        if "description" in obj
        else ""
    )
    out["time"] = _time(w, obj.get("time", _MISSING), "time")
    if "refresh" in obj:
        refresh = obj["refresh"]
        if refresh not in REFRESH_CHOICES:
            w.add("refresh", "Use null or one of 10s, 30s, 1m, 5m, 15m, 1h.")
            refresh = None
        out["refresh"] = refresh
    else:
        out["refresh"] = None

    defined: dict[str, int] = {}
    var_items = obj.get("variables", [])
    if "variables" in obj and _list(w, var_items, "variables") is None:
        var_items = []
    for i, item in enumerate(var_items):
        if isinstance(item, dict) and isinstance(item.get("name"), str):
            defined.setdefault(item["name"], i)
    if len(var_items) > MAX_VARIABLES:
        w.add("variables", "A dashboard has at most 20 variables.")
    seen: set[str] = set()
    out["variables"] = [
        _variable(w, item, _at("variables", i), i, seen, defined)
        for i, item in enumerate(var_items)
    ]

    panel_items = obj.get("panels", [])
    if "panels" in obj and _list(w, panel_items, "panels") is None:
        panel_items = []
    if len(panel_items) > MAX_PANELS:
        w.add("panels", "A dashboard has at most 100 panels.")
    ids: set[str] = set()
    placed: list[tuple[str, dict]] = []
    out["panels"] = [
        _panel(w, item, _at("panels", i), ids, placed, defined, out["variables"])
        for i, item in enumerate(panel_items)
    ]
    _unknown(
        w,
        obj,
        "",
        ("schemaVersion", "title", "description", "time", "refresh", "variables", "panels"),
    )
    return out


def adapt_sources(doc: dict, *, owner_kind: OwnerKind, linked_source_ids: frozenset[str]) -> dict:
    """A copy with every source id this owner cannot use set to None."""
    out = copy.deepcopy(doc)

    def adapt(source: dict) -> None:
        if owner_kind == "group" or source.get("id") not in linked_source_ids:
            source["id"] = None

    for variable in out.get("variables", []):
        adapt(variable["source"])
    for panel in out.get("panels", []):
        for query in panel.get("queries", []):
            adapt(query["source"])
    return out


def empty_dashboard(title: str) -> dict:
    return validate_dashboard(
        {"schemaVersion": SCHEMA_VERSION, "title": title}, owner_kind="project"
    )


def panel_count(doc: dict) -> int:
    return len(doc["panels"])
