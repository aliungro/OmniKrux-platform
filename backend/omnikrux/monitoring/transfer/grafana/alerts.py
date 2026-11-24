"""Grafana alerts (the old per-panel kind and unified rules) as OmniKrux alert drafts."""

import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

from omnikrux.monitoring.transfer.grafana.panels import clean_text
from omnikrux.monitoring.transfer.types import AlertDraft, SkippedItem

_REDUCERS = {
    "avg": "mean",
    "mean": "mean",
    "last": "last",
    "max": "max",
    "min": "min",
    "sum": "sum",
}
_OPS = {"gt": "above", "lt": "below"}
_EXPRESSION_TYPES = ("reduce", "threshold", "classic_conditions", "math", "resample", "sql")
_DURATION = re.compile(r"(\d+)\s*([smhdw])")
_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}
_MAX_SECONDS = 10**9
_DEFAULT_TITLE = "Imported alert"
_NOT_EXPRESSIBLE = "OmniKrux alerts check above or below a value."
_NO_DATA = "OmniKrux shows a rule that has no data as can't check; it doesn't alert or stay quiet."
_ON_ERROR = "OmniKrux shows a rule that can't be checked as can't check; it doesn't alert."
_QUERY_MISSING = "Its query isn't one of the panel's queries."
_NOT_A_THRESHOLD = "It doesn't check a value above or below a threshold."


@dataclass(frozen=True)
class PanelInfo:
    new_id: str | None
    title: str
    refs: Mapping[str, str] = field(default_factory=dict)  # Grafana refId -> new ref
    raw_exprs: Mapping[str, str] = field(default_factory=dict)  # Grafana refId -> raw expr


def _seconds(value: object) -> int | None:
    """A duration like "5m" or "1h30m" in seconds, or None when it isn't one."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return min(int(value), _MAX_SECONDS) if math.isfinite(value) and value >= 0 else None
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if text.isdigit():
        return min(int(text), _MAX_SECONDS)
    total = 0
    position = 0
    for m in _DURATION.finditer(text):
        if text[position : m.start()].strip():
            return None
        total += int(m.group(1)) * _UNITS[m.group(2)]
        position = m.end()
    if position == 0 or text[position:].strip():
        return None
    return min(total, _MAX_SECONDS)


def _title(raw: object) -> str:
    return clean_text(raw)[:120].strip() or _DEFAULT_TITLE


def _note(value: object) -> str | None:
    text = clean_text(value) if isinstance(value, str) else ""
    return text or None


def _finite(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value) if math.isfinite(value) else None


def _collapse(text: object) -> str:
    return " ".join(text.split()) if isinstance(text, str) else ""


def _dicts(raw: object) -> list[dict]:
    return [d for d in raw if isinstance(d, dict)] if isinstance(raw, list) else []


def _obj(raw: object) -> dict:
    return raw if isinstance(raw, dict) else {}


def _checks(kind: object) -> str:
    return f"It checks {clean_text(kind) or 'something else'}; {_NOT_EXPRESSIBLE}"


def _uses(name: object) -> str:
    shown = clean_text(name) or "something else"
    return f"It uses {shown}; OmniKrux alerts use last, mean, max, min or sum."


def _conditions(n: int) -> str:
    return f"It has {n} conditions; OmniKrux alerts have one."


def _read_condition(cond: dict) -> tuple[str, str, float] | str:
    """(reducer, op, threshold) of a classic condition, or the reason it can't convert."""
    evaluator = _obj(cond.get("evaluator"))
    kind = evaluator.get("type")
    if kind not in _OPS:
        return _checks(kind)
    name = _obj(cond.get("reducer")).get("type")
    if name not in _REDUCERS:
        return _uses(name)
    params = evaluator.get("params")
    value = _finite(params[0]) if isinstance(params, list) and params else None
    if value is None:
        return "Its threshold isn't a number."
    return _REDUCERS[name], _OPS[kind], value


def _states(where: str, no_data: object, on_error: object) -> list[SkippedItem]:
    items: list[SkippedItem] = []
    if isinstance(no_data, str) and no_data.lower().replace("_", "") not in ("nodata", ""):
        items.append(SkippedItem(where, f"No data state {clean_text(no_data)}", _NO_DATA))
    if isinstance(on_error, str) and on_error.lower() not in ("alerting", "error", ""):
        items.append(SkippedItem(where, f"Error state {clean_text(on_error)}", _ON_ERROR))
    return items


def legacy_draft(
    alert: dict, panel_refs: Mapping[str, str]
) -> tuple[AlertDraft | None, list[SkippedItem]]:
    title = _title(alert.get("name"))
    where = f'Alert "{title}"'
    items: list[SkippedItem] = []
    if isinstance(alert.get("notifications"), list) and alert["notifications"]:
        items.append(
            SkippedItem(
                where,
                "Notification channels",
                "Grafana's notification channels aren't copied. "
                "Pick contact points in the panel's Alert tab.",
            )
        )
    items.extend(_states(where, alert.get("noDataState"), alert.get("executionErrorState")))

    def refuse(reason: str) -> tuple[None, list[SkippedItem]]:
        return None, [SkippedItem(where, "The rule", reason), *items]

    conditions = _dicts(alert.get("conditions"))
    if len(conditions) != 1:
        return refuse(_conditions(len(conditions)))
    cond = conditions[0]
    if cond.get("type") != "query":
        return refuse(_checks(cond.get("type")))
    read = _read_condition(cond)
    if isinstance(read, str):
        return refuse(read)
    reducer, op, threshold = read
    params = _obj(cond.get("query")).get("params")
    params = params if isinstance(params, list) else []
    ref = panel_refs.get(params[0]) if params and isinstance(params[0], str) else None
    if ref is None:
        return refuse(_QUERY_MISSING)
    draft = AlertDraft(
        ref,
        reducer,  # type: ignore[arg-type]
        op,  # type: ignore[arg-type]
        threshold,
        _seconds(alert.get("for")) or 0,
        title,
        _note(alert.get("message")),
        None,
        _seconds(params[1]) if len(params) > 1 else None,
    )
    return draft, items


def _unified_draft(rule: dict, info: PanelInfo) -> tuple[AlertDraft | None, list[SkippedItem]]:
    ga = _obj(rule.get("grafana_alert"))
    title = _title(ga.get("title"))
    where = f'Alert "{title}"'
    annotations = _obj(rule.get("annotations"))
    items = _states(where, ga.get("no_data_state"), ga.get("exec_err_state"))
    if ga.get("is_paused") is True:
        items.append(
            SkippedItem(where, "It is paused in Grafana", "OmniKrux imports alerts as active.")
        )

    def refuse(reason: str) -> tuple[None, list[SkippedItem]]:
        return None, [SkippedItem(where, "The rule", reason), *items]

    data = _dicts(ga.get("data"))
    nodes = {d["refId"]: d for d in data if isinstance(d.get("refId"), str)}

    def model(node: dict) -> dict:
        return _obj(node.get("model"))

    def is_expression(node: dict) -> bool:
        return (
            node.get("datasourceUid") == "__expr__" or model(node).get("type") in _EXPRESSION_TYPES
        )

    queries = [d for d in data if not is_expression(d)]
    if len(queries) > 1:
        return refuse(f"It combines {len(queries)} queries.")
    if not queries:
        return refuse(_QUERY_MISSING)
    query = queries[0]
    condition = ga.get("condition")
    node = nodes.get(condition) if isinstance(condition, str) else None
    if node is None:
        node = next((d for d in reversed(data) if is_expression(d)), None)
    reducer: str | None = None
    op: str | None = None
    threshold: float | None = None
    classic_ref: str | None = None
    for _ in range(20):
        if node is None or node is query:
            break
        m = model(node)
        kind = m.get("type")
        if kind == "threshold":
            conds = _dicts(m.get("conditions"))
            if len(conds) != 1:
                return refuse(_conditions(len(conds)))
            evaluator = _obj(conds[0].get("evaluator"))
            if evaluator.get("type") not in _OPS:
                return refuse(_checks(evaluator.get("type")))
            params = evaluator.get("params")
            threshold = _finite(params[0]) if isinstance(params, list) and params else None
            if threshold is None:
                return refuse("Its threshold isn't a number.")
            op = _OPS[evaluator["type"]]
        elif kind == "reduce":
            if m.get("reducer") not in _REDUCERS:
                return refuse(_uses(m.get("reducer")))
            reducer = _REDUCERS[m["reducer"]]
        elif kind == "classic_conditions":
            conds = _dicts(m.get("conditions"))
            if len(conds) != 1:
                return refuse(_conditions(len(conds)))
            read = _read_condition(conds[0])
            if isinstance(read, str):
                return refuse(read)
            reducer, op, threshold = read
            p = _obj(conds[0].get("query")).get("params")
            classic_ref = p[0] if isinstance(p, list) and p and isinstance(p[0], str) else None
            break
        else:
            return refuse(_checks(kind or "an expression"))
        source = m.get("expression")
        node = nodes.get(source) if isinstance(source, str) else None
    if op is None or threshold is None:
        return refuse(_NOT_A_THRESHOLD)
    wanted = _collapse(model(query).get("expr"))
    match = next(
        (
            r
            for r, expr in info.raw_exprs.items()
            if wanted and _collapse(expr) == wanted and r in info.refs
        ),
        None,
    )
    if match is None or (classic_ref is not None and classic_ref != query.get("refId")):
        return refuse(_QUERY_MISSING)
    severity = _obj(rule.get("labels")).get("severity")
    draft = AlertDraft(
        info.refs[match],
        reducer or "last",  # type: ignore[arg-type]
        op,  # type: ignore[arg-type]
        threshold,
        _seconds(rule.get("for")) or 0,
        title,
        _note(annotations.get("summary")) or _note(annotations.get("description")),
        severity.strip() if isinstance(severity, str) and severity.strip() else None,
        None,
    )
    return draft, items


def unified_drafts(
    rules: Sequence[dict], panels: Mapping[str, PanelInfo]
) -> tuple[list[tuple[str, AlertDraft]], list[SkippedItem]]:
    out: list[tuple[str, AlertDraft]] = []
    skipped: list[SkippedItem] = []
    for rule in rules:
        if not isinstance(rule, dict):
            continue
        panel_id = _obj(rule.get("annotations")).get("__panelId__")
        usable = isinstance(panel_id, str | int) and not isinstance(panel_id, bool)
        info = panels.get(str(panel_id)) if usable else None
        if info is None or info.new_id is None:
            title = _title(_obj(rule.get("grafana_alert")).get("title"))
            skipped.append(SkippedItem(f'Alert "{title}"', "The rule", "Its panel wasn't copied."))
            continue
        draft, items = _unified_draft(rule, info)
        skipped.extend(items)
        if draft is not None:
            out.append((info.new_id, draft))
    return out, skipped
