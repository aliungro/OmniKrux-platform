"""The audited dashboard write path: every create and save of a dashboard goes through here.

A write is checked (a valid document, only sources its project links, contact points that
exist), audited before it is made (no audit, no change), stored, and finished in the audit log
once it is known how it ended. After a write the rules of the dashboard's panels are brought in
line with it (`AlertSync`); what that did in the tools is returned with the stored record.

The routes in `dashboards/api.py` (create, copy, save) and the imports call these functions, so
an import is checked, audited and reconciled exactly as an editor's save is. Every refusal is an
`HTTPException` with `detail = {"code": DashboardErrorCode, "message": plain words}`."""

import logging
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Literal

from fastapi import HTTPException, Request

from omnikrux.audit.store import Action
from omnikrux.monitoring.alerts.sync import CONTACT_POINT_GONE, AlertChangeOut, change_out
from omnikrux.monitoring.audit import begin_change, finish_change
from omnikrux.monitoring.dashboards.ready_made import parse_ready_id
from omnikrux.monitoring.dashboards.schema import (
    MAX_PROBLEMS,
    DashboardInvalid,
    OwnerKind,
    Problem,
    panel_count,
    validate_dashboard,
)
from omnikrux.monitoring.dashboards.store import (
    DashboardRecord,
    Origin,
    UnknownDashboard,
    VersionConflict,
)
from omnikrux.monitoring.projects.types import UnknownGroup, UnknownProject
from omnikrux.monitoring.services import MonitoringServices
from omnikrux.monitoring.sources.types import NameTaken

DashboardErrorCode = Literal[
    "invalid_dashboard",
    "version_conflict",
    "name_taken",
    "not_found",
    "unknown_owner",
    "read_only",
    "bad_request",
]

DASHBOARD_GONE = "That dashboard no longer exists."
OWNER_GONE = "That project or group no longer exists."
READ_ONLY = "Ready-made views can't be changed. Copy one to edit it."
NOT_LINKED = "This source isn't linked to {project}."
NOT_SAVED = "The dashboard couldn't be saved. Try again."

log = logging.getLogger(__name__)


# --- Refusals ----------------------------------------------------------------------------------


def dashboard_error(
    status: int, code: DashboardErrorCode, message: str, **extra: object
) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message, **extra})


def invalid_dashboard(exc: DashboardInvalid) -> HTTPException:
    return dashboard_error(
        422,
        "invalid_dashboard",
        str(exc),
        problems=[{"path": p.path, "message": p.message} for p in exc.problems],
    )


def version_conflict(exc: VersionConflict) -> HTTPException:
    return dashboard_error(409, "version_conflict", str(exc), current_version=exc.current)


def name_taken(exc: NameTaken) -> HTTPException:
    return dashboard_error(409, "name_taken", str(exc))


def dashboard_gone() -> HTTPException:
    return dashboard_error(404, "not_found", DASHBOARD_GONE)


def owner_gone() -> HTTPException:
    return dashboard_error(404, "unknown_owner", OWNER_GONE)


def refuse_ready_made(id: str) -> None:
    """Ready-made views are never changed: 409 `read_only`."""
    if parse_ready_id(id) is not None:
        raise dashboard_error(409, "read_only", READ_ONLY)


# --- Checks ------------------------------------------------------------------------------------


def _services(request: Request) -> MonitoringServices:
    return request.app.state.monitoring


@dataclass(frozen=True)
class Owner:
    kind: OwnerKind
    id: str
    name: str
    # The sources a project's dashboards may name; a group's name none.
    linked: frozenset[str]


async def owner_of(services: MonitoringServices, kind: OwnerKind, id: str) -> Owner:
    """The owner as it is now; 404 `unknown_owner` when it is gone."""
    try:
        if kind == "project":
            project = await services.projects.get(id)
            return Owner(kind, id, project.name, frozenset(l.source_id for l in project.links))
        group = await services.groups.get(id)
        return Owner(kind, id, group.name, frozenset())
    except (UnknownProject, UnknownGroup):
        raise owner_gone() from None


async def dashboard_record(services: MonitoringServices, id: str) -> DashboardRecord:
    """The stored dashboard; 404 `not_found` when it is gone."""
    try:
        return await services.dashboards.get(id)
    except UnknownDashboard:
        raise dashboard_gone() from None


def _sources(doc: dict) -> Iterator[tuple[str, dict]]:
    """(path, source) of every source the document names, in document order."""
    for i, variable in enumerate(doc["variables"]):
        yield f"variables[{i}].source", variable["source"]
    for i, panel in enumerate(doc["panels"]):
        for j, query in enumerate(panel["queries"]):
            yield f"panels[{i}].queries[{j}].source", query["source"]


def check_document(spec: dict, owner: Owner) -> dict:
    """The validated, normalised document for `owner`; 422 `invalid_dashboard` when it isn't
    valid or names a source the project isn't linked to."""
    try:
        doc = validate_dashboard(spec, owner_kind=owner.kind)
    except DashboardInvalid as exc:
        raise invalid_dashboard(exc) from None
    if owner.kind == "project":
        message = NOT_LINKED.format(project=owner.name)
        problems = [
            Problem(f"{path}.id", message)
            for path, source in _sources(doc)
            if source["id"] is not None and source["id"] not in owner.linked
        ]
        if problems:
            raise invalid_dashboard(DashboardInvalid(tuple(problems[:MAX_PROBLEMS])))
    return doc


async def check_notify(services: MonitoringServices, doc: dict) -> None:
    """422 `invalid_dashboard` naming each panel alert's contact point that doesn't exist."""
    named = [
        (i, j, cp_id)
        for i, panel in enumerate(doc["panels"])
        if isinstance(panel.get("alert"), dict)
        for j, cp_id in enumerate(panel["alert"].get("notify") or [])
    ]
    if not named:
        return
    known = {cp.id for cp in await services.contact_points.list()}
    problems = [
        Problem(f"panels[{i}].alert.notify[{j}]", CONTACT_POINT_GONE)
        for i, j, cp_id in named
        if cp_id not in known
    ]
    if problems:
        raise invalid_dashboard(DashboardInvalid(tuple(problems[:MAX_PROBLEMS])))


async def reconcile_alerts(
    services: MonitoringServices, dashboard_id: str, *, deleted: bool = False
) -> list[AlertChangeOut]:
    """Bring the rules of the dashboard's panels in line with it. The dashboard is already
    written: a failure here is logged, and the next start converges (`reconcile_all`)."""
    try:
        changes = await services.alert_sync.reconcile_dashboard(dashboard_id, deleted=deleted)
    except Exception as exc:  # noqa: BLE001 (the save stands; the rules converge at start)
        log.warning(
            "Bringing the alerts of dashboard %s up to date failed (%s)",
            dashboard_id,
            type(exc).__name__,
        )
        return []
    return [change_out(c) for c in changes]


# --- Audit details -----------------------------------------------------------------------------


def owner_details(owner_kind: OwnerKind, owner_name: str) -> dict:
    return {"owner": owner_kind, "owner_name": owner_name}


def alert_changes(old: dict, new: dict) -> dict[str, list[str]]:
    """The panel alerts a save adds, changes and removes, by name, for its audit record (each
    becomes, changes or removes an alert rule); only the lists that aren't empty."""

    def alerts(doc: dict) -> dict[str, dict]:
        return {
            str(p.get("id")): p["alert"]
            for p in doc.get("panels", [])
            if isinstance(p, dict) and isinstance(p.get("alert"), dict)
        }

    before, after = alerts(old), alerts(new)
    out = {
        "alerts_added": [a.get("name", "") for k, a in after.items() if k not in before],
        "alerts_changed": [
            a.get("name", "") for k, a in after.items() if k in before and before[k] != a
        ],
        "alerts_removed": [a.get("name", "") for k, a in before.items() if k not in after],
    }
    return {k: [str(n) for n in v] for k, v in out.items() if v}


# --- Writes ------------------------------------------------------------------------------------


async def create_dashboard_audited(
    request: Request,
    *,
    owner_kind: OwnerKind,
    owner_id: str,
    spec: dict,
    origin: Origin = "created",
    copied_from: str | None = None,
    action: Action = "dashboard_add",
    details: dict | None = None,
) -> tuple[DashboardRecord, list[AlertChangeOut]]:
    """Check `spec` for the owner, audit, then store it as a new dashboard at version 1 whose
    first version records `origin` and `copied_from`; then bring its panels' rules in line.

    404 `unknown_owner` (also when the owner goes away meanwhile), 422 `invalid_dashboard`, 409
    `name_taken`; 503 when the audit record can't be written. `details` replace the default
    audit details (owner, owner name, version, panels and `copied_from`)."""
    services = _services(request)
    owner = await owner_of(services, owner_kind, owner_id)
    doc = check_document(spec, owner)
    await check_notify(services, doc)
    if details is None:
        details = owner_details(owner.kind, owner.name) | {"version": 1, "panels": panel_count(doc)}
        if copied_from is not None:
            details["copied_from"] = copied_from
    record = await begin_change(request, action, "dashboard", doc["title"], details)
    try:
        created = await services.dashboards.create(
            owner.kind, owner.id, doc, origin=origin, copied_from=copied_from
        )
    except NameTaken as exc:
        await finish_change(request, record, False, str(exc))
        raise name_taken(exc) from None
    except (UnknownProject, UnknownGroup):
        await finish_change(request, record, False, OWNER_GONE)
        raise owner_gone() from None
    except Exception:
        await finish_change(request, record, False, NOT_SAVED)
        raise
    await finish_change(request, record, True)
    return created, await reconcile_alerts(services, created.id)


async def save_dashboard_audited(
    request: Request,
    dashboard_id: str,
    *,
    base_version: int,
    spec: dict,
    origin: Origin = "saved",
    copied_from: str | None = None,
    action: Action = "dashboard_save",
    details: dict | None = None,
) -> tuple[DashboardRecord, list[AlertChangeOut]]:
    """Check `spec` for the dashboard's owner, audit, then store it as the version after
    `base_version` recording `origin` and `copied_from`; then bring its panels' rules in line.

    409 `read_only` (a ready-made view), 404 `not_found`/`unknown_owner`, 422
    `invalid_dashboard`, 409 `version_conflict` (nothing changed) or `name_taken`; 503 when the
    audit record can't be written. `details` replace the default audit details (owner, owner
    name, versions, panels and the alerts added, changed and removed)."""
    return await save_audited(
        request,
        dashboard_id,
        base_version=base_version,
        spec=spec,
        origin=origin,
        copied_from=copied_from,
        action=action,
        details=details,
    )


async def save_audited(
    request: Request,
    dashboard_id: str,
    *,
    base_version: int,
    spec: dict,
    origin: Origin = "saved",
    copied_from: str | None = None,
    action: Action = "dashboard_save",
    details: dict | None = None,
    from_explore: bool = False,
) -> tuple[DashboardRecord, list[AlertChangeOut]]:
    """`save_dashboard_audited`, and the editor's save from Explore (`from_explore`): its record
    says so and names the panels it added; it is refused before the audit when the dashboard
    moved on from `base_version`."""
    refuse_ready_made(dashboard_id)
    services = _services(request)
    current = await dashboard_record(services, dashboard_id)
    owner = await owner_of(services, current.owner_kind, current.owner_id)
    doc = check_document(spec, owner)
    await check_notify(services, doc)
    if from_explore and current.version != base_version:
        # The save would be refused: no audit record may name panels against another document.
        raise version_conflict(VersionConflict(current.version))
    if details is None:
        details = owner_details(owner.kind, owner.name) | {
            "version": base_version + 1,
            "previous_version": base_version,
            "panels": panel_count(doc),
        }
        if from_explore:
            # Versions never change: a save that goes through was made over exactly `current`'s
            # document (the store refuses it under its lock otherwise), so its panel ids are the
            # old ones.
            stored = {p.get("id") for p in current.spec.get("panels", [])}
            details |= {
                "from": "explore",
                "added_panels": [p["title"] for p in doc["panels"] if p["id"] not in stored],
            }
        details |= alert_changes(current.spec, doc)
    # The editor's save calls the store exactly as it always has; only another origin says more.
    stamp: dict = {}
    if origin != "saved":
        stamp["origin"] = origin
    if copied_from is not None:
        stamp["copied_from"] = copied_from
    record = await begin_change(request, action, "dashboard", doc["title"], details)
    try:
        saved = await services.dashboards.save(dashboard_id, base_version, doc, **stamp)
    except VersionConflict as exc:
        await finish_change(request, record, False, str(exc))
        raise version_conflict(exc) from None
    except NameTaken as exc:
        await finish_change(request, record, False, str(exc))
        raise name_taken(exc) from None
    except UnknownDashboard:
        await finish_change(request, record, False, DASHBOARD_GONE)
        raise dashboard_gone() from None
    except Exception:
        await finish_change(request, record, False, NOT_SAVED)
        raise
    await finish_change(request, record, True)
    return saved, await reconcile_alerts(services, saved.id)
