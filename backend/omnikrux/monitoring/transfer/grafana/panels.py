"""One Grafana panel as an OmniKrux panel: type, options, thresholds and queries."""

import colorsys
import math
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Literal

from omnikrux.monitoring.dashboards.schema import BUILTIN_VARIABLES, variables_used
from omnikrux.monitoring.transfer.grafana.datasources import (
    GrafanaContext,
    Ref,
    Special,
    guess_type,
    resolve,
)
from omnikrux.monitoring.transfer.types import SkippedItem, SourceRefFound

PANEL_TYPES = {
    "graph": "timeseries",
    "timeseries": "timeseries",
    "singlestat": "stat",
    "stat": "stat",
    "gauge": "gauge",
    "bargauge": "bar",
    "barchart": "bar",
    "table": "table",
    "table-old": "table",
    "logs": "logs",
}
UNIT_MAP = {
    "": "none",
    "none": "none",
    "short": "short",
    "percent": "percent",
    "percentunit": "percentunit",
    "s": "s",
    "ms": "ms",
    "bytes": "bytes",
    "Bps": "Bps",
    "reqps": "reqps",
    "dtdurations": "s",
    "dtdurationms": "ms",
    "decbytes": "bytes",
    "binBps": "Bps",
    "decBps": "Bps",
    "ops": "short",
    "rps": "short",
    "wps": "short",
    "iops": "short",
    "cps": "short",
}
PLAIN_NUMBER_UNITS = ("ops", "rps", "wps", "iops", "cps")
MAX_QUERIES = 10
MAX_THRESHOLDS = 10
_CALCS = {
    "lastNotNull": "last",
    "last": "last",
    "mean": "mean",
    "max": "max",
    "min": "min",
    "sum": "sum",
}
_VALUE_NAMES = {"current": "last", "avg": "mean", "max": "max", "min": "min", "total": "sum"}
_CALC_REASON = "OmniKrux shows last, mean, max, min or sum; it shows the last value."
_HEX = re.compile(r"#([0-9a-f]{3}|[0-9a-f]{6})")
_RGB = re.compile(r"rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,[^)]*)?\)")
_OLD_TONES = {"critical": "bad", "warning": "warn", "ok": "ok"}
_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"


@dataclass
class PanelState:
    ctx: GrafanaContext
    inputs: dict
    ds_vars: dict
    known: frozenset[str]  # the dashboard's variables an expression may use
    exprs_by_key: dict[str, list[str]]
    refs: dict[str, SourceRefFound] = field(default_factory=dict)

    def resolve(self, raw):
        return resolve(
            raw,
            ctx=self.ctx,
            inputs=self.inputs,
            ds_vars=self.ds_vars,
            default_key="grafana:default",
        )

    def source_type(self, ref: Ref) -> tuple[str, bool]:
        """The source type of a reference and whether it was only guessed from query text."""
        if ref.type in ("prometheus", "loki"):
            return ref.type, False
        return guess_type(self.exprs_by_key.get(ref.key, [])), True

    def note_ref(self, ref: Ref) -> str:
        if ref.key not in self.refs:
            kind, guessed = self.source_type(ref)
            url = next(
                (ds.url for ds in self.ctx.datasources if ref.key == f"grafana:uid:{ds.uid}"),
                None,
            )
            self.refs[ref.key] = SourceRefFound(
                ref.key,
                kind,  # type: ignore[arg-type]
                guessed,
                ref.name,
                url,
                None,
            )
        return self.refs[ref.key].type


@dataclass
class PanelResult:
    panel: dict | None
    skipped: list[SkippedItem]
    refs_used: list[str]
    legacy_alert: dict | None
    grafana_id: object


def prescan(p: dict, state: PanelState) -> list[tuple[Ref, str]]:
    """(data source, expression) of each target, to guess the source types before converting."""
    panel_ds = state.resolve(p.get("datasource"))
    targets = p.get("targets")
    out: list[tuple[Ref, str]] = []
    for t in targets if isinstance(targets, list) else []:
        if not isinstance(t, dict) or not isinstance(t.get("expr"), str):
            continue
        res = panel_ds
        if isinstance(panel_ds, Special) and panel_ds.kind == "mixed":
            res = state.resolve(t.get("datasource"))
        if isinstance(res, Ref):
            out.append((res, t["expr"]))
    return out


# --- small readers --------------------------------------------------------------------------


def _get(raw: object, *path: str):
    for key in path:
        if not isinstance(raw, dict):
            return None
        raw = raw.get(key)
    return raw


def _num(value: object) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    try:
        float(value)
    except OverflowError:
        return None
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def _show(value: object) -> str:
    return str(value)


def clean_text(value: object) -> str:
    if not isinstance(value, str):
        return ""
    return "".join(c for c in value if unicodedata.category(c) != "Cc").strip()


def tone_for(color: str) -> Literal["ok", "warn", "bad"] | None:
    text = color.strip().lower() if isinstance(color, str) else ""
    if "green" in text:
        return "ok"
    if "red" in text:
        return "bad"
    if "orange" in text or "yellow" in text:
        return "warn"
    rgb: tuple[int, int, int] | None = None
    m = _HEX.fullmatch(text)
    if m:
        h = m.group(1)
        h = "".join(c * 2 for c in h) if len(h) == 3 else h
        rgb = (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    else:
        m = _RGB.fullmatch(text)
        if m:
            rgb = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
    if rgb is None:
        return None
    hue, saturation, _ = colorsys.rgb_to_hsv(*(min(c, 255) / 255 for c in rgb))
    if saturation < 0.1:
        return None  # white, grey and black have no hue to read
    degrees = hue * 360
    if degrees < 20 or degrees >= 330:
        return "bad"
    if degrees < 70:
        return "warn"
    if degrees < 170:
        return "ok"
    return None


# --- options --------------------------------------------------------------------------------


def _unit(p: dict, items: list[tuple[str, str]]) -> str:
    raw = _get(p, "fieldConfig", "defaults", "unit")
    if not isinstance(raw, str) or raw == "":
        axes = p.get("yaxes")
        raw = _get(axes[0], "format") if isinstance(axes, list) and axes else None
    if not isinstance(raw, str) or raw == "":
        raw = p.get("format")
    if not isinstance(raw, str):
        return "none"
    mapped = UNIT_MAP.get(raw)
    if mapped is None:
        items.append(
            (f"Unit {clean_text(raw)}", "OmniKrux has no such unit, so values show without one.")
        )
        return "none"
    if raw in PLAIN_NUMBER_UNITS:
        items.append((f"Unit {raw}", "Shown as a plain number."))
    return mapped


def _decimals(p: dict) -> int | None:
    raw = _get(p, "fieldConfig", "defaults", "decimals")
    if raw is None:
        raw = p.get("decimals")
    n = _num(raw)
    return n if isinstance(n, int) and 0 <= n <= 6 else None


def _bad_colour(items: list[tuple[str, str]], value: object, color: object) -> None:
    items.append(
        (f"Threshold {_show(value)}", f"Its colour {clean_text(color)} isn't good, warning or bad.")
    )


def _modern_thresholds(modern: dict, items: list[tuple[str, str]]) -> list[dict]:
    if modern.get("mode") == "percentage":
        items.append(
            (
                "Percentage thresholds",
                "OmniKrux thresholds are absolute values, so these were dropped.",
            )
        )
        return []
    found: list[dict] = []
    base_color = None
    for i, step in enumerate(s for s in modern["steps"] if isinstance(s, dict)):
        value = _num(step.get("value"))
        color = step.get("color")
        if value is None:
            if i == 0:
                base_color = color
            else:
                items.append(
                    (f"Threshold {clean_text(str(step.get('value')))}", "Its value isn't a number.")
                )
            continue
        tone = tone_for(color) if isinstance(color, str) else None
        if tone is None:
            _bad_colour(items, value, color)
            continue
        found.append({"value": value, "color": tone})
    if isinstance(base_color, str) and tone_for(base_color) in ("warn", "bad"):
        first = min((t["value"] for t in found), default=None)
        what = (
            "Colour below the first threshold" if first is None else f"Colour below {_show(first)}"
        )
        items.append((what, "OmniKrux doesn't colour values below the first threshold."))
    return found


def _singlestat_thresholds(p: dict, items: list[tuple[str, str]]) -> list[dict]:
    colors = p.get("colors") if isinstance(p.get("colors"), list) else []
    found: list[dict] = []
    for i, part in enumerate(p["thresholds"].split(",")):
        try:
            value = _num(float(part))
        except ValueError:
            continue
        color = colors[i + 1] if i + 1 < len(colors) else None
        if value is None:
            continue
        tone = tone_for(color) if isinstance(color, str) else None
        if tone is None:
            _bad_colour(items, value, color)
            continue
        found.append({"value": value, "color": tone})
    return found


def _graph_thresholds(p: dict, items: list[tuple[str, str]]) -> list[dict]:
    found: list[dict] = []
    for t in p["thresholds"]:
        value = _num(t.get("value")) if isinstance(t, dict) else None
        if value is None:
            continue
        if t.get("op") == "lt":
            items.append(
                (f"Threshold {_show(value)}", "OmniKrux thresholds mark values above them.")
            )
            continue
        mode = t.get("colorMode")
        if mode == "custom":
            color = t.get("lineColor") or t.get("fillColor")
            tone = tone_for(color) if isinstance(color, str) else None
        else:
            color = mode
            tone = _OLD_TONES.get(mode) if isinstance(mode, str) else None
        if tone is None:
            _bad_colour(items, value, color)
            continue
        found.append({"value": value, "color": tone})
    return found


def _thresholds(p: dict, kind: str, items: list[tuple[str, str]]) -> list[dict]:
    modern = _get(p, "fieldConfig", "defaults", "thresholds")
    if isinstance(modern, dict) and isinstance(modern.get("steps"), list):
        found = _modern_thresholds(modern, items)
    elif kind == "stat" and isinstance(p.get("thresholds"), str):
        found = _singlestat_thresholds(p, items)
    elif isinstance(p.get("thresholds"), list):
        found = _graph_thresholds(p, items)
    else:
        found = []
    found.sort(key=lambda t: t["value"])
    for t in found[MAX_THRESHOLDS:]:
        items.append((f"Threshold {_show(t['value'])}", "A panel keeps at most 10 thresholds."))
    return found[:MAX_THRESHOLDS]


def _calc(p: dict, items: list[tuple[str, str]]) -> str:
    calcs = _get(p, "options", "reduceOptions", "calcs")
    raw = calcs[0] if isinstance(calcs, list) and calcs else None
    if raw is None:
        raw = p.get("valueName")
        if isinstance(raw, str) and raw in _VALUE_NAMES:
            return _VALUE_NAMES[raw]
        if not isinstance(raw, str) or not raw:
            return "last"
    elif isinstance(raw, str) and raw in _CALCS:
        return _CALCS[raw]
    items.append((f"Calculation {clean_text(str(raw))}", _CALC_REASON))
    return "last"


def _legend(p: dict) -> str:
    hidden = (
        _get(p, "options", "legend", "showLegend") is False
        or _get(p, "options", "legend", "displayMode") == "hidden"
        or _get(p, "legend", "show") is False
    )
    return "hidden" if hidden else "bottom"


def _options(p: dict, kind: str, items: list[tuple[str, str]], max_lines: int | None) -> dict:
    if kind == "logs":
        return {
            "limit": 100 if max_lines is None else max(1, min(1000, max_lines)),
            "wrap": bool(_get(p, "options", "wrapLogMessage")),
            "order": "oldest" if _get(p, "options", "sortOrder") == "Ascending" else "newest",
        }
    out: dict = {
        "unit": _unit(p, items),
        "decimals": _decimals(p),
        "thresholds": _thresholds(p, kind, items),
    }
    defaults = _get(p, "fieldConfig", "defaults")
    if kind == "timeseries":
        stacked = p.get("stack") is True or _get(defaults, "custom", "stacking", "mode") == "normal"
        fill = _num(_get(defaults, "custom", "fillOpacity"))
        out["style"] = "stacked" if stacked else "area" if fill and fill > 0 else "lines"
        out["legend"] = _legend(p)
        for key in ("min", "max"):
            n = _num(_get(defaults, key))
            if n is not None:
                out[key] = n
    elif kind == "stat":
        out["calc"] = _calc(p, items)
        if isinstance(p.get("sparkline"), dict) and "options" not in p:
            out["sparkline"] = p["sparkline"].get("show") is True
        else:
            out["sparkline"] = _get(p, "options", "graphMode") != "none"
    elif kind == "gauge":
        out["calc"] = _calc(p, items)
        for key, old in (("min", "minValue"), ("max", "maxValue")):
            n = _num(_get(defaults, key))
            if n is None:
                n = _num(_get(p, "gauge", old))
            if n is not None:
                out[key] = n
    elif kind == "bar":
        out["legend"] = _legend(p)
        vertical = _get(p, "options", "orientation") == "vertical"
        out["orientation"] = "vertical" if vertical else "horizontal"
        n = _num(_get(defaults, "min"))
        if n is not None:
            out["min"] = n
    else:
        out["columns"] = []
        out["sort"] = None
    return out


# --- queries --------------------------------------------------------------------------------


def _letter_for(wanted: object, used: set[str]) -> str:
    if isinstance(wanted, str) and len(wanted) == 1 and wanted in _LETTERS and wanted not in used:
        return wanted
    return next((c for c in _LETTERS if c not in used), "")


def _variable_problem(expr: str, known: frozenset[str]) -> str | None:
    """Interim: Task 6 replaces this with the full expression conversion."""
    for name in variables_used(expr):
        if name in BUILTIN_VARIABLES:
            continue
        if name.startswith("__"):
            return f"Uses ${{{name}}}, which OmniKrux doesn't have."
        if name not in known:
            return f"Uses ${{{name}}}, a Grafana variable OmniKrux couldn't copy."
    return None


def _convert_targets(p: dict, kind: str, state: PanelState, items: list[tuple[str, str]]):
    targets = p.get("targets")
    panel_ds = state.resolve(p.get("datasource"))
    mixed = isinstance(panel_ds, Special) and panel_ds.kind == "mixed"
    queries: list[dict] = []
    refs_used: list[str] = []
    used: set[str] = set()
    over_limit: list[str] = []
    loki_kept = False
    for index, t in enumerate(targets if isinstance(targets, list) else []):
        if not isinstance(t, dict):
            continue
        original = t.get("refId") if isinstance(t.get("refId"), str) and t["refId"] else None
        label = clean_text(original) or _LETTERS[index % 26]
        res = state.resolve(t.get("datasource")) if mixed else panel_ds
        if isinstance(res, Special):
            plugin = {"grafana": "Grafana", "dashboard": "Dashboard"}.get(res.kind)
            if plugin is not None:
                items.append((f"Query {label}", f"{plugin} queries aren't supported yet."))
                continue
            res = state.resolve(None)  # a target left on "Mixed" takes the default source
        if res.type is not None and res.type not in ("prometheus", "loki"):
            items.append(
                (f"Query {label}", f"{clean_text(res.type)} queries aren't supported yet.")
            )
            continue
        expr = t.get("expr")
        if not isinstance(expr, str) or not expr.strip():
            items.append((f"Query {label}", "It has no query text."))
            continue
        problem = _variable_problem(expr, state.known)
        if problem:
            items.append((f"Query {label}", problem))
            continue
        source_type = state.source_type(res)[0]
        if kind == "logs":
            if source_type != "loki":
                items.append((f"Query {label}", "A logs panel needs a Loki query."))
                continue
            if loki_kept:
                items.append(
                    (f"Query {label}", "A logs panel shows one Loki query; the first was kept.")
                )
                continue
        ref = _letter_for(original, used)
        if len(queries) >= MAX_QUERIES or not ref:
            over_limit.append(label)
            continue
        used.add(ref)
        loki_kept = loki_kept or source_type == "loki"
        legend = t.get("legendFormat")
        legend = legend if isinstance(legend, str) and legend != "__auto" else ""
        state.note_ref(res)
        refs_used.append(res.key)
        queries.append(
            {
                "ref": ref,
                "source": {"type": state.refs[res.key].type, "id": res.key},
                "expr": expr,
                "legend": legend,
                "hidden": t.get("hide") is True,
            }
        )
    if over_limit:
        items.append((f"Queries {', '.join(over_limit)}", "A panel keeps at most 10 queries."))
    return queries, refs_used


# --- the panel ------------------------------------------------------------------------------


def _filled(value: object) -> bool:
    return isinstance(value, list) and len(value) > 0


def _max_lines(p: dict) -> int | None:
    targets = p.get("targets")
    for t in targets if isinstance(targets, list) else []:
        n = _num(t.get("maxLines")) if isinstance(t, dict) else None
        if n is not None:
            return int(n)
    return None


def convert_panel(p: dict, state: PanelState) -> PanelResult:
    grafana_id = p.get("id")
    title = clean_text(p.get("title"))
    shown = title[:120].strip()
    if shown:
        where = f'Panel "{shown}"'
    elif isinstance(grafana_id, int | str) and not isinstance(grafana_id, bool) and str(grafana_id):
        where = f"Untitled panel {clean_text(str(grafana_id))}"
    else:
        where = "Untitled panel"
    items: list[tuple[str, str]] = []
    legacy = p.get("alert") if isinstance(p.get("alert"), dict) else None

    def result(panel: dict | None, refs: list[str] | None = None) -> PanelResult:
        skipped = [SkippedItem(where, w, r) for w, r in items]
        return PanelResult(panel, skipped, refs or [], legacy, grafana_id)

    lib = p.get("libraryPanel")
    if isinstance(lib, dict):
        name = clean_text(lib.get("name")) or clean_text(lib.get("uid")) or "unnamed"
        items.append(
            (
                f'Library panel "{name}"',
                "Library panels aren't copied. Unlink it in Grafana, then import again.",
            )
        )
        return result(None)
    raw_type = p.get("type")
    kind = PANEL_TYPES.get(raw_type) if isinstance(raw_type, str) else None
    if kind is None:
        items.append(
            (
                f"A {clean_text(raw_type) or 'unknown'} panel",
                "OmniKrux has no panel of this kind yet.",
            )
        )
        return result(None)
    if raw_type == "singlestat" and _get(p, "gauge", "show") is True:
        kind = "gauge"
    queries, refs_used = _convert_targets(p, kind, state, items)
    if not queries:
        items.append(
            (
                "The whole panel",
                "A logs panel needs a Loki query."
                if kind == "logs"
                else "None of its queries could be copied.",
            )
        )
        return result(None)
    options = _options(p, kind, items, _max_lines(p) if kind == "logs" else None)
    if len(title) > 120:
        items.append(("Title", "Cut to 120 characters."))
    if isinstance(p.get("repeat"), str) and p["repeat"]:
        items.append(
            (f"Repeat by ${p['repeat']}", "OmniKrux shows one panel with every value instead.")
        )
    if _filled(_get(p, "fieldConfig", "overrides")):
        items.append(
            (
                "Per-series overrides",
                "They aren't in OmniKrux; every series uses the panel's options.",
            )
        )
    if _filled(p.get("transformations")):
        items.append(
            (
                "Transformations",
                "They aren't in OmniKrux; the panel shows the query results as they are.",
            )
        )
    if _filled(p.get("links")):
        items.append(("Links", "Panel links aren't in OmniKrux."))
    if p.get("timeFrom") or p.get("timeShift"):
        items.append(
            ("Its own time range", "Panels follow the dashboard's time range in OmniKrux.")
        )
    description = p.get("description")
    panel = {
        "id": "",
        "type": kind,
        "title": shown,
        "description": description if isinstance(description, str) else "",
        "layout": {},
        "queries": queries,
        "options": options,
        "alert": None,
    }
    return result(panel, refs_used)
