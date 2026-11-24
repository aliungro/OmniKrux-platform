"""The alert adapter: M4's panel alert in exports, imports and Grafana conversions.

Every M4 `panel.alert` field name used by import and export lives in this module. M4 has no
standalone alert validator: an alert is checked by `validate_dashboard` on a one-panel document
built around the panel, and only the problems under that panel's alert count.

What the adapter never carries:
- contact point ids or settings across instances: an export names contact points, an import maps
  the names onto this instance's ids;
- the tool engine into an import: imported alerts run on OmniKrux's own engine;
- a rule's pause: it is run state in the rule store, not part of `panel.alert`.
"""

import copy
from collections.abc import Mapping, Sequence

from omnikrux.monitoring.alerts.rule_expr import duration_text, parse_duration
from omnikrux.monitoring.alerts.types import ALERT_PANEL_TYPES, MAX_FOR_SECONDS, SEVERITIES
from omnikrux.monitoring.dashboards.schema import (
    SCHEMA_VERSION,
    DashboardInvalid,
    Problem,
    validate_dashboard,
)
from omnikrux.monitoring.transfer.types import AlertDraft, SkippedItem

_ALERT_PATH = "panels[0].alert"
_DEFAULT_SEVERITY = "warning"

# What an update from source takes from the source; everything else on a panel's alert stays as
# the user set it here: who it tells (`notify`), where it runs (`engine`, `channel`) and how
# often it is checked (`every`, which a Grafana draft doesn't carry).
_FROM_SOURCE = ("name", "query", "of", "op", "threshold", "for", "severity", "message")

_RUNS_IN_THE_TOOL = (
    "Imported alerts run on OmniKrux's own engine. Switch it in the panel's Alert tab."
)
_CONTACT_POINT_UNKNOWN = "It doesn't exist here. Pick contact points in the panel's Alert tab."
_CONTACT_POINT_UNNAMED = "The file doesn't name it. Pick contact points in the panel's Alert tab."
_SEVERITY_CHANGED = "OmniKrux uses critical, warning or info; it is warning here."
_QUERY_MISSING = "Its query isn't one of the panel's queries."


def _reducer_copy(reducer: str) -> str:
    return f"It uses {reducer} over the values; OmniKrux alerts check the latest value."


def _wait_copy(seconds: int) -> str:
    return f"It waits {duration_text(seconds)}; OmniKrux alerts wait at most 24h."


def _does_not_fit(message: str) -> str:
    return f"It doesn't fit OmniKrux alerts: {message}"


# --- the alert check ------------------------------------------------------------------------


def _is_alert_path(path: str) -> bool:
    return path == _ALERT_PATH or path.startswith((_ALERT_PATH + ".", _ALERT_PATH + "["))


def _check_panel(panel: object) -> dict:
    """The parts of `panel` an alert check reads (its type and queries), placed so nothing
    else about the panel can crowd the alert's problems out of the validator's list."""
    out: dict = {"id": "p-1", "title": "", "layout": {"x": 0, "y": 0, "w": 12, "h": 8}}
    if isinstance(panel, dict):
        if "type" in panel:
            out["type"] = panel["type"]
        out["queries"] = panel.get("queries", [])
    return out


def _check_doc(alert: object, panel: dict, variables: Sequence) -> dict:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "title": "Alert check",
        "variables": list(variables),
        "panels": [panel | {"alert": alert}],
    }


def _normalised(alert: object, panel: object, variables: Sequence) -> dict:
    """The alert as M4 stores it, or `DashboardInvalid` with only the alert's problems."""
    try:
        checked = validate_dashboard(
            _check_doc(alert, _check_panel(panel), variables), owner_kind="project"
        )
        return checked["panels"][0]["alert"]
    except DashboardInvalid as err:
        mine = tuple(p for p in err.problems if _is_alert_path(p.path))
        if mine:
            raise DashboardInvalid(mine) from None
        whole = tuple(Problem(_ALERT_PATH, p.message) for p in err.problems if p.path == "")
        if whole:  # the document as a whole was refused, so the alert wasn't checked
            raise DashboardInvalid(whole) from None
    # The alert passed, but problems elsewhere (a query using a variable the caller didn't
    # pass, say) keep validate_dashboard from answering. Normalise it beside a plain panel
    # with the same type and the one query it names: nothing else there can be refused.
    kind = panel.get("type") if isinstance(panel, dict) else None
    plain = {
        "id": "p-1",
        "type": kind if kind in ALERT_PANEL_TYPES else "timeseries",
        "title": "",
        "layout": {"x": 0, "y": 0, "w": 12, "h": 8},
        "queries": [
            {"ref": alert["query"], "source": {"type": "prometheus", "id": None}, "expr": "up"}
        ],
    }
    checked = validate_dashboard(_check_doc(alert, plain, ()), owner_kind="project")
    return checked["panels"][0]["alert"]


def validate_panel_alert(alert: dict, panel: dict, *, variables: Sequence = ()) -> None:
    """Raise `DashboardInvalid` carrying only the problems of `alert` on `panel`.

    M4 checks a panel alert inside `validate_dashboard`; this runs that check on a one-panel
    document and keeps the problems under `panels[0].alert`. Pass the dashboard's `variables` so
    the alert's query is substituted as it will be when the rule runs."""
    _normalised(alert, panel, variables)


# --- Grafana drafts -------------------------------------------------------------------------


def _severity(draft: AlertDraft) -> tuple[str, SkippedItem | None]:
    raw = draft.severity
    if raw is None or not raw.strip():
        return _DEFAULT_SEVERITY, None
    lowered = raw.strip().lower()
    if lowered in SEVERITIES:
        return lowered, None
    return _DEFAULT_SEVERITY, SkippedItem(
        f'Alert "{draft.title}"', f"Severity {raw}", _SEVERITY_CHANGED
    )


def _query_refs(panel: dict) -> set[str]:
    queries = panel.get("queries") if isinstance(panel, dict) else None
    if not isinstance(queries, list):
        return set()
    return {q["ref"] for q in queries if isinstance(q, dict) and isinstance(q.get("ref"), str)}


def alert_from_draft(
    draft: AlertDraft, *, panel: dict, variables: Sequence = ()
) -> tuple[dict | None, SkippedItem | None]:
    """An M4 alert on OmniKrux's engine for the panel's query `draft.query_ref`.

    Answers `(alert, None)`; `(None, item)` when the draft can't become an OmniKrux alert; or
    `(alert, item)` when the alert was kept with one change said in words (its severity).
    The alert notifies no one: contact points are picked in OmniKrux. A draft's
    `window_seconds` has no place in M4's alert and changes nothing for a latest-value check."""
    where = f'Alert "{draft.title}"'
    if draft.query_ref not in _query_refs(panel):
        return None, SkippedItem(where, "The rule", _QUERY_MISSING)
    if draft.reducer != "last":
        return None, SkippedItem(where, "The rule", _reducer_copy(draft.reducer))
    seconds = max(0, int(draft.for_seconds))
    if seconds > MAX_FOR_SECONDS:
        return None, SkippedItem(where, "The rule", _wait_copy(seconds))
    severity, changed = _severity(draft)
    alert = {
        "name": draft.title,
        "query": draft.query_ref,
        "of": "each",
        "op": draft.op,
        "threshold": draft.threshold,
        "for": duration_text(seconds),
        "every": "1m",
        "severity": severity,
        "message": draft.message,
        "notify": [],
        "engine": "omnikrux",
        "channel": None,
    }
    try:
        return _normalised(alert, panel, variables), changed
    except DashboardInvalid as err:
        return None, SkippedItem(where, "The rule", _does_not_fit(err.problems[0].message))


def draft_from_alert(alert: dict) -> AlertDraft | None:
    """The draft an M4 alert answers to, or None when it uses something a draft can't hold
    (a total across series, or a shape M4 wouldn't store). Contact points, the engine and the
    check interval are OmniKrux's own settings and are not part of a draft."""
    if not isinstance(alert, dict) or alert.get("of", "each") != "each":
        return None
    name, query, op = alert.get("name"), alert.get("query"), alert.get("op")
    threshold, wait = alert.get("threshold"), alert.get("for", "5m")
    severity, message = alert.get("severity", _DEFAULT_SEVERITY), alert.get("message", "")
    if not (isinstance(name, str) and isinstance(query, str) and op in ("above", "below")):
        return None
    if isinstance(threshold, bool) or not isinstance(threshold, int | float):
        return None
    if not (isinstance(severity, str) and isinstance(message, str) and isinstance(wait, str)):
        return None
    try:
        for_seconds = parse_duration(wait)
    except ValueError:
        return None
    return AlertDraft(
        query_ref=query,
        reducer="last",
        op=op,
        threshold=threshold,
        for_seconds=for_seconds,
        title=name,
        message=message,
        severity=severity,
        window_seconds=None,
    )


# --- exports and imports --------------------------------------------------------------------


def export_alert(alert: dict | None, *, contact_point_names: Mapping[str, str]) -> dict | None:
    """The alert as an export file carries it: unchanged, except that each contact point id in
    `notify` becomes `{"name": …}`. An id not in `contact_point_names` is left out (the contact
    point is gone), so passing an empty mapping exports `notify: []`. Names only: never a
    contact point's settings or secrets."""
    if alert is None:
        return None
    out = copy.deepcopy(alert)
    notify = alert.get("notify")
    if isinstance(notify, list):
        out["notify"] = [
            {"name": contact_point_names[cp]}
            for cp in notify
            if isinstance(cp, str) and cp in contact_point_names
        ]
    return out


def _named(entry: object) -> str | None:
    if isinstance(entry, dict) and isinstance(entry.get("name"), str):
        return entry["name"]
    return None


def import_alert(
    alert: dict,
    *,
    panel: dict,
    panel_title: str,
    contact_points_by_name: Mapping[str, str],
    variables: Sequence = (),
) -> tuple[dict | None, list[SkippedItem]]:
    """An exported alert as this instance stores it, with what changed in words.

    The alert runs on OmniKrux's own engine (a tool-run alert loses its channel); contact point
    names map to this instance's ids, and names it doesn't know are left out. Then M4's check
    runs; a refusal answers None. Never raises on a hostile shape."""
    where = f'Alert on panel "{panel_title}"'
    skipped: list[SkippedItem] = []
    out: object = alert
    if isinstance(alert, dict):
        out = copy.deepcopy(alert)
        if out.get("engine") == "tool":
            out["engine"] = "omnikrux"
            out.pop("channel", None)
            skipped.append(SkippedItem(where, "Runs in the tool", _RUNS_IN_THE_TOOL))
        notify = out.get("notify")
        if isinstance(notify, list):
            ids: list[str] = []
            for entry in notify:
                name = _named(entry)
                if name is None:
                    skipped.append(SkippedItem(where, "A contact point", _CONTACT_POINT_UNNAMED))
                elif name not in contact_points_by_name:
                    skipped.append(
                        SkippedItem(where, f'Contact point "{name}"', _CONTACT_POINT_UNKNOWN)
                    )
                elif contact_points_by_name[name] not in ids:
                    ids.append(contact_points_by_name[name])
            out["notify"] = ids
    try:
        return _normalised(out, panel, variables), skipped
    except DashboardInvalid as err:
        skipped.append(SkippedItem(where, "The alert", _does_not_fit(err.problems[0].message)))
        return None, skipped


# --- update from source ---------------------------------------------------------------------


def merge_alert(current: dict | None, incoming: dict | None) -> dict | None:
    """A panel's alert after an update from source.

    The alert's definition (name, query, condition, wait, severity, message) comes from the
    source; who it tells, where it runs and how often it is checked stay as the panel's current
    alert has them. No current alert: the source's alert as it is. No incoming alert: None (the
    update removes it, and a tool-run alert's removal goes through its review)."""
    if incoming is None:
        return None
    out = copy.deepcopy(incoming)
    if current is None:
        return out
    kept = {k: copy.deepcopy(v) for k, v in current.items() if k not in _FROM_SOURCE}
    taken = {k: v for k, v in out.items() if k in _FROM_SOURCE}
    return kept | taken


def count_alerts(doc: dict) -> int:
    """How many panels of a dashboard document have an alert."""
    panels = doc.get("panels") if isinstance(doc, dict) else None
    if not isinstance(panels, list):
        return 0
    return sum(1 for p in panels if isinstance(p, dict) and p.get("alert") is not None)
