"""A Grafana dashboard as an OmniKrux one: layout, data sources and panels (variables and alerts
are added by the next step), with everything not copied listed. Never raises; the document it
returns always passes the dashboard validator."""

import re
from datetime import UTC, datetime

from omnikrux.monitoring.dashboards.schema import (
    DEFAULT_TIME,
    MAX_PANELS,
    MAX_VARIABLES,
    REFRESH_CHOICES,
    DashboardInvalid,
    Problem,
    validate_dashboard,
)
from omnikrux.monitoring.transfer.grafana.alerts import PanelInfo, legacy_draft, unified_drafts
from omnikrux.monitoring.transfer.grafana.datasources import GrafanaContext
from omnikrux.monitoring.transfer.grafana.layout import grid_pos, place, rows_layout
from omnikrux.monitoring.transfer.grafana.panels import (
    PanelResult,
    PanelState,
    clean_text,
    convert_panel,
    prescan,
)
from omnikrux.monitoring.transfer.grafana.variables import convert_variables, datasource_variables
from omnikrux.monitoring.transfer.types import (
    AlertDraft,
    ConvertedDashboard,
    Identity,
    SkippedItem,
    SourceRefFound,
)

DEFAULT_TITLE = "Imported dashboard"
MAX_ROW_DEPTH = 50
_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,39}")
_LABEL = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_EPOCH_MS = re.compile(r"[0-9]{13}")
_PANEL_PATH = re.compile(r"panels\[(\d+)\]")
_VARIABLE_PATH = re.compile(r"variables\[(\d+)\]")
_LABEL_VALUES = re.compile(r"label_values\(.*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*$", re.DOTALL)
_PROBLEM_COPY = "The dashboard couldn't be read."


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _flatten(panels: list) -> tuple[list[tuple[dict, dict]], bool]:
    """Grafana's gridPos panels in order: row panels dropped, a collapsed row's own panels put
    where the row was. Also whether any row was seen."""
    out: list[tuple[dict, dict]] = []
    saw_row = False
    stack = [(iter(panels), 0)]
    while stack:
        it, depth = stack[-1]
        p = next(it, None)
        if p is None:
            stack.pop()
            continue
        if not isinstance(p, dict):
            continue
        if p.get("type") == "row":
            saw_row = True
            inner = p.get("panels")
            if isinstance(inner, list) and inner and depth < MAX_ROW_DEPTH:
                stack.append((iter(inner), depth + 1))
            continue
        out.append((p, grid_pos(p.get("gridPos"))))
    return out, saw_row


def _time_text(value: object) -> object:
    """An ISO time with fractions or an epoch-milliseconds string as YYYY-MM-DDTHH:MM:SSZ."""
    if not isinstance(value, str):
        return value
    text = value.strip()
    try:
        if _EPOCH_MS.fullmatch(text):
            when = datetime.fromtimestamp(int(text) / 1000, UTC)
        elif re.match(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T", text):
            when = datetime.fromisoformat(text)
            when = when.replace(tzinfo=UTC) if when.tzinfo is None else when.astimezone(UTC)
        else:
            return text
    except (ValueError, OverflowError, OSError):
        return text
    return when.strftime("%Y-%m-%dT%H:%M:%SZ")


def _time(raw: object, items: list[tuple[str, str]]) -> dict:
    if not isinstance(raw, dict):
        return dict(DEFAULT_TIME)
    start = _time_text(raw.get("from", DEFAULT_TIME["from"]))
    end = _time_text(raw.get("to", DEFAULT_TIME["to"]))
    try:
        probe = {"schemaVersion": 1, "title": "x", "time": {"from": start, "to": end}}
        validate_dashboard(probe, owner_kind="project")
    except DashboardInvalid:
        items.append(
            (
                f"Time range {clean_text(str(start))} to {clean_text(str(end))}",
                "OmniKrux can't read it, so the dashboard shows the last 6 hours.",
            )
        )
        return dict(DEFAULT_TIME)
    return {"from": start, "to": end}


def _refresh(raw: object, items: list[tuple[str, str]]) -> str | None:
    if raw is None or raw is False or raw == "":
        return None
    if isinstance(raw, str) and raw in REFRESH_CHOICES:
        return raw
    items.append(
        (
            f"Auto-refresh every {clean_text(str(raw))}",
            "OmniKrux offers 10s, 30s, 1m, 5m, 15m and 1h, so auto-refresh is off.",
        )
    )
    return None


def _title(raw: object, items: list[tuple[str, str]]) -> str:
    text = clean_text(raw)
    if len(text) > 120:
        items.append(("Title", "Cut to 120 characters."))
        text = text[:120].strip()
    return text or DEFAULT_TITLE


def _dashboard_items(d: dict, items: list[tuple[str, str]]) -> None:
    if isinstance(d.get("links"), list) and d["links"]:
        items.append(("Links", "Dashboard links aren't in OmniKrux."))
    if isinstance(d.get("tags"), list) and d["tags"]:
        items.append(("Tags", "OmniKrux dashboards have no tags."))
    annotations = d.get("annotations")
    entries = annotations.get("list") if isinstance(annotations, dict) else None
    for a in entries if isinstance(entries, list) else []:
        if (
            isinstance(a, dict)
            and not a.get("builtIn")
            and a.get("enable", a.get("enabled")) is not False
        ):
            items.append(("Annotations", "They aren't in OmniKrux yet."))
            break
    tz = d.get("timezone")
    if isinstance(tz, str) and tz not in ("", "browser"):
        items.append((f"Time zone {clean_text(tz)}", "Times show in your browser's time zone."))


def _id_of(grafana_id: object) -> str | None:
    if _is_int(grafana_id) or (isinstance(grafana_id, str) and grafana_id):
        return str(grafana_id)
    return None


def convert_grafana(value: object, ctx: GrafanaContext, *, key: str) -> ConvertedDashboard:
    try:
        return _convert(value, ctx, key)
    except Exception:  # noqa: BLE001 - a converter that raises would sink a whole import
        return ConvertedDashboard(
            key=key,
            title=DEFAULT_TITLE,
            doc=None,
            refs=(),
            skipped=(),
            alerts=(),
            problems=(Problem("", _PROBLEM_COPY),),
            identity=Identity("grafana", None, None),
        )


def _convert(value: object, ctx: GrafanaContext, key: str) -> ConvertedDashboard:
    d = value if isinstance(value, dict) else {}
    dash_items: list[tuple[str, str]] = []
    title = _title(d.get("title"), dash_items)
    uid = d.get("uid")
    identity = Identity(
        "grafana",
        uid if isinstance(uid, str) and uid else None,
        d.get("version") if _is_int(d.get("version")) else None,
    )

    raw_inputs = d.get("__inputs")
    inputs = {
        i["name"]: i
        for i in (raw_inputs if isinstance(raw_inputs, list) else [])
        if isinstance(i, dict) and isinstance(i.get("name"), str) and i.get("type") == "datasource"
    }
    ds_vars = {name: ref.type for name, ref in datasource_variables(d.get("templating")).items()}
    state = PanelState(ctx, inputs, ds_vars, frozenset(), exprs_by_key={})

    panels = d.get("panels")
    saw_row = False
    if isinstance(panels, list) and panels:
        flat, saw_row = _flatten(panels)
    else:
        rows = d.get("rows") if isinstance(d.get("rows"), list) else []
        flat = rows_layout(rows)
        saw_row = any(
            isinstance(r, dict) and r.get("showTitle") is True and clean_text(r.get("title"))
            for r in rows
        )
    if saw_row:
        dash_items.append(("Rows", "OmniKrux has no rows; their panels were kept in order."))
    _dashboard_items(d, dash_items)
    doc_time = _time(d.get("time"), dash_items)
    refresh = _refresh(d.get("refresh"), dash_items)
    description = d.get("description")
    description = description[:2000] if isinstance(description, str) else ""

    for p, _ in flat:
        for ref, expr in prescan(p, state):
            state.exprs_by_key.setdefault(ref.key, []).append(expr)

    var_result = convert_variables(d.get("templating"), state.resolve)
    for v in var_result.variables:
        v["source"]["type"] = state.note_ref(var_result.refs[v["name"]])
    state.known = frozenset(v["name"] for v in var_result.variables)

    results: list[tuple[PanelResult, dict]] = []
    for p, layout in flat:
        r = convert_panel(p, state)
        results.append((r, layout))
    survivors = [(i, lay) for i, (r, lay) in enumerate(results) if r.panel is not None]
    placed: list[tuple[PanelResult, dict]] = []
    placed_indexes = set()
    for i, lay in place(survivors):
        placed.append((results[i][0], lay))
        placed_indexes.add(i)

    skipped: list[SkippedItem] = [SkippedItem("Dashboard", w, r) for w, r in dash_items]
    skipped.extend(var_result.skipped)
    for i, (r, _) in enumerate(results):
        skipped.extend(r.skipped)
        if r.panel is not None and i not in placed_indexes:
            skipped.append(
                SkippedItem(
                    _where({"panel": r.panel, "result": r}),
                    "The whole panel",
                    "It couldn't be converted: layout: There is no room left for it on the dashboard.",
                )
            )
    if len(placed) > MAX_PANELS:
        skipped.append(
            SkippedItem(
                "Dashboard", "Panels after the 100th", "A dashboard has at most 100 panels."
            )
        )
        placed = placed[:MAX_PANELS]

    entries: list[dict] = []  # panel documents with their layout and ids in final order
    for n, (r, lay) in enumerate(placed, start=1):
        panel = r.panel
        panel["id"] = f"p-{n}"
        panel["layout"] = lay
        panel["description"] = panel["description"][:2000]
        entries.append({"panel": panel, "result": r})

    variables = var_result.variables

    ctx_doc = {"title": title, "description": description, "time": doc_time, "refresh": refresh}
    doc, problems = _validated(ctx_doc, variables, entries, skipped)

    final_panels = doc["panels"] if doc else []
    used_keys: list[str] = []
    for p in final_panels:
        for q in p["queries"]:
            if q["source"]["id"] not in used_keys:
                used_keys.append(q["source"]["id"])
    for v in doc["variables"] if doc else []:
        if v["source"]["id"] not in used_keys:
            used_keys.append(v["source"]["id"])
    refs: tuple[SourceRefFound, ...] = tuple(state.refs[k] for k in used_keys if k in state.refs)
    sources = [(e["panel"]["id"], _id_of(e["result"].grafana_id)) for e in entries]
    ids = [g for _, g in sources if g is not None]
    panel_sources = (
        tuple((pid, g) for pid, g in sources if g is not None and ids.count(g) == 1) if doc else ()
    )
    alerts: list[tuple[str, AlertDraft]] = []
    if doc:
        kept = {e["panel"]["id"] for e in entries}
        alerts, alert_items = _alerts(entries, kept, ctx, identity)
        skipped.extend(alert_items)
    return ConvertedDashboard(
        key=key,
        title=doc["title"] if doc else title,
        doc=doc,
        refs=refs,
        skipped=tuple(skipped),
        alerts=tuple(alerts),
        problems=problems,
        identity=identity,
        panel_sources=panel_sources,
    )


def _alerts(entries: list[dict], kept: set[str], ctx: GrafanaContext, identity: Identity):
    """One alert per panel, in panel order: the old panel alert first, then unified rules."""
    alerts: dict[str, AlertDraft] = {}
    items: list[SkippedItem] = []
    infos: dict[str, PanelInfo] = {}
    for e in entries:
        r: PanelResult = e["result"]
        gid = _id_of(r.grafana_id)
        if gid is not None and gid not in infos:
            infos[gid] = PanelInfo(e["panel"]["id"], e["panel"]["title"], r.ref_map, r.raw_exprs)
        if r.legacy_alert is not None:
            draft, found = legacy_draft(r.legacy_alert, r.ref_map)
            items.extend(found)
            _keep(alerts, items, e["panel"]["id"], draft)
    if ctx.alert_rules is not None and identity.ref is not None:
        mine = [
            rule
            for rule in ctx.alert_rules
            if isinstance(rule, dict)
            and isinstance(rule.get("annotations"), dict)
            and rule["annotations"].get("__dashboardUid__") == identity.ref
        ]
        drafts, found = unified_drafts(mine, infos)
        items.extend(found)
        for panel_id, draft in drafts:
            _keep(alerts, items, panel_id, draft)
    if ctx.alert_rules_note:
        items.append(SkippedItem("Dashboard", "Grafana alert rules", ctx.alert_rules_note))
    order = [e["panel"]["id"] for e in entries]
    return [(pid, alerts[pid]) for pid in order if pid in alerts], items


def _keep(alerts: dict[str, AlertDraft], items: list[SkippedItem], panel_id: str, draft) -> None:
    if draft is None:
        return
    if panel_id in alerts:
        items.append(
            SkippedItem(
                f'Alert "{draft.title}"',
                "The rule",
                "The panel already has an alert; OmniKrux panels have one.",
            )
        )
        return
    alerts[panel_id] = draft


def _where(entry: dict) -> str:
    title = entry["panel"]["title"]
    if title:
        return f'Panel "{title}"'
    return f"Untitled panel {_id_of(entry['result'].grafana_id) or ''}".strip()


def _validated(head: dict, variables: list[dict], entries: list[dict], skipped: list[SkippedItem]):
    """The normalised document: a panel or field the validator names is dropped or reset."""
    head = dict(head)
    variables = list(variables)
    for _ in range(len(entries) + 60):
        raw = {
            "schemaVersion": 1,
            **head,
            "variables": variables,
            "panels": [e["panel"] for e in entries],
        }
        try:
            return validate_dashboard(raw, owner_kind="project"), ()
        except DashboardInvalid as err:
            bad: set[int] = set()
            fixed = False
            for problem in err.problems:
                m = _PANEL_PATH.match(problem.path)
                if m and int(m.group(1)) < len(entries):
                    bad.add(int(m.group(1)))
                    fixed = True
                    continue
                first = problem.path.split(".")[0].split("[")[0]
                if first == "title":
                    head["title"], fixed = DEFAULT_TITLE, True
                elif first == "description":
                    head["description"], fixed = "", True
                elif first == "time":
                    head["time"], fixed = dict(DEFAULT_TIME), True
                elif first == "refresh":
                    head["refresh"], fixed = None, True
                elif first == "variables":
                    m = _VARIABLE_PATH.match(problem.path)
                    if m and int(m.group(1)) < len(variables):
                        variables[int(m.group(1))] = None  # type: ignore[call-overload]
                    else:
                        variables = variables[:MAX_VARIABLES]
                    variables = [v for v in variables if v is not None]
                    fixed = True
                elif problem.path == "" and "1 MB" in problem.message and entries:
                    bad.update(
                        range(max(0, len(entries) - max(1, len(entries) // 10)), len(entries))
                    )
                    fixed = True
            if not fixed:
                return None, err.problems
            first_problem: dict[int, Problem] = {}
            for problem in err.problems:
                m = _PANEL_PATH.match(problem.path)
                if m:
                    first_problem.setdefault(int(m.group(1)), problem)
            for index in sorted(bad, reverse=True):
                e = entries.pop(index)
                problem = first_problem.get(index, err.problems[0])
                skipped.append(
                    SkippedItem(
                        _where(e),
                        "The whole panel",
                        f"It couldn't be converted: {problem.path}: {problem.message}",
                    )
                )
    return None, (Problem("", _PROBLEM_COPY),)
