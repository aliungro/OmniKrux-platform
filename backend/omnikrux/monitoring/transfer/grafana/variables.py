"""Grafana template variables as OmniKrux label-values variables, listing what can't convert."""

import re
from collections.abc import Callable
from dataclasses import dataclass, field

from omnikrux.monitoring.dashboards.schema import BUILTIN_VARIABLES, MAX_VARIABLES, variables_used
from omnikrux.monitoring.transfer.grafana.datasources import DsResolution, Ref, Special
from omnikrux.monitoring.transfer.grafana.expressions import convert_expr
from omnikrux.monitoring.transfer.grafana.panels import clean_text
from omnikrux.monitoring.transfer.types import SkippedItem

_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,39}")
_LABEL = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_LABEL_VALUES = re.compile(
    r"\s*label_values\(\s*(?:(.*?)\s*,\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*", re.DOTALL
)
_MAX_VALUES = 100
_MAX_MATCH = 1000
_SPECIAL_NAMES = {"mixed": "Mixed", "grafana": "Grafana", "dashboard": "Dashboard"}


@dataclass
class VarResult:
    variables: list[dict] = field(default_factory=list)
    ds_vars: dict[str, Ref] = field(default_factory=dict)
    skipped: list[SkippedItem] = field(default_factory=list)
    refs: dict[str, Ref] = field(default_factory=dict)  # variable name -> its data source


def _text(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def datasource_variables(templating: object) -> dict[str, Ref]:
    """The dashboard's data source variables, as the references panels use them."""
    out: dict[str, Ref] = {}
    for v in _entries(templating):
        name = v.get("name")
        if v.get("type") == "datasource" and isinstance(name, str) and name:
            out[name] = Ref(f"grafana:var:{name}", _text(v.get("query")), name)
    return out


def _entries(templating: object) -> list[dict]:
    entries = templating.get("list") if isinstance(templating, dict) else templating
    return [v for v in entries if isinstance(v, dict)] if isinstance(entries, list) else []


def _query_parts(v: dict) -> tuple[str, str] | None:
    """(selector, label) of a label values query, or None when it is anything else."""
    query = v.get("query")
    if isinstance(query, dict) and isinstance(query.get("label"), str) and "stream" in query:
        stream = query.get("stream")
        label = query["label"].strip()
        if query.get("type") == 1 and _LABEL.fullmatch(label):
            return (stream.strip() if isinstance(stream, str) else ""), label
        return None
    text = query if isinstance(query, str) else None
    if text is None and isinstance(query, dict) and isinstance(query.get("query"), str):
        text = query["query"]
    if text is None and isinstance(v.get("definition"), str):
        text = v["definition"]
    m = _LABEL_VALUES.fullmatch(text) if text is not None else None
    if m is None:
        return None
    return (m.group(1) or ""), m.group(2)


def _default(v: dict, multi: bool, include_all: bool) -> tuple[object, str | None]:
    """The starting value and, when it had to be cut, the reason."""
    current = v.get("current")
    raw = None
    if isinstance(current, dict):
        raw = current.get("value", current.get("text"))
    items = raw if isinstance(raw, list) else [raw]
    values = [i for i in items if isinstance(i, str) and i != ""]
    if "$__all" in values:
        return ("all" if include_all else []), None
    if len(values) > 1 and not multi:
        return values[:1], "A variable that isn't multi-value starts with one value."
    if len(values) > _MAX_VALUES:
        return values[:_MAX_VALUES], "At most 100 values start selected."
    return values, None


def convert_variables(
    templating: object, resolve_ds: Callable[[object], DsResolution]
) -> VarResult:
    entries = _entries(templating)
    result = VarResult(ds_vars=datasource_variables(templating))
    known: set[str] = set()

    def skip(name: str, what: str, reason: str) -> None:
        result.skipped.append(SkippedItem(f"Variable ${clean_text(name)}", what, reason))

    for index, v in enumerate(entries):
        raw_name = v.get("name")
        name = raw_name if isinstance(raw_name, str) else ""
        kind = v.get("type")
        if kind == "datasource":
            continue
        if kind != "query":
            shown = clean_text(kind) or "unknown"
            article = "An" if shown[0].lower() in "aeiou" else "A"
            skip(
                name,
                f"{article} {shown} variable",
                "Only label values variables are in OmniKrux.",
            )
            continue
        if name in known:
            skip(name, "Its name", "Another variable already has this name.")
            continue
        if not _NAME.fullmatch(name) or name.startswith("__"):
            skip(
                name,
                "Its name",
                "OmniKrux variable names use letters, digits and _ and don't start with __.",
            )
            continue
        parts = _query_parts(v)
        if parts is None:
            skip(name, "Its query", "Only label_values(...) queries can become OmniKrux variables.")
            continue
        selector, label_name = parts
        res = resolve_ds(v.get("datasource"))
        plugin = None
        if isinstance(res, Special):
            plugin = _SPECIAL_NAMES.get(res.kind, res.kind)
        elif res.type is not None and res.type not in ("prometheus", "loki"):
            plugin = clean_text(res.type)
        if plugin is not None:
            skip(name, "Its data source", f"{plugin} variables aren't supported yet.")
            continue
        after = {
            n["name"] for n in entries[index:] if isinstance(n.get("name"), str)
        }  # this variable and the ones after it
        later = [n for n in variables_used(selector) if n in after and n not in known]
        later = [n for n in later if n not in BUILTIN_VARIABLES]
        if later:
            skip(name, "Its query", "It uses a variable defined after it.")
            continue
        if len(selector) > _MAX_MATCH:
            skip(name, "Its query", "Its selector is longer than 1000 characters.")
            continue
        converted = convert_expr(selector, frozenset(known))
        if converted.text is None:
            skip(name, "Its query", converted.reason or "")
            continue
        if len(result.variables) >= MAX_VARIABLES:
            skip(name, "A variable past the 20th", "A dashboard has at most 20 variables.")
            continue
        for what, reason in converted.notes:
            skip(name, what, reason)
        if isinstance(v.get("regex"), str) and v["regex"].strip():
            skip(name, "Its regex", "OmniKrux lists every value; the regex filter was dropped.")
        multi = v.get("multi") is True
        include_all = v.get("includeAll") is True
        default, cut = _default(v, multi, include_all)
        if cut:
            skip(name, "Its current value", cut)
        label = clean_text(v.get("label"))[:120].strip() or name
        builder = isinstance(v.get("query"), dict) and "stream" in v["query"]
        source_type = res.type or ("loki" if builder else "prometheus")
        result.refs[name] = res
        result.variables.append(
            {
                "name": name,
                "label": label,
                "type": "labelValues",
                "source": {"type": source_type, "id": res.key},
                "labelName": label_name,
                "match": converted.text,
                "multi": multi,
                "includeAll": include_all,
                "default": default,
            }
        )
        known.add(name)
    return result
