"""Routes for dashboards: list, create, read, save, delete, versions, restore and copy.

Every change is audited before it is made (no audit, no change) and finished once it is known
how it ended; audit details hold owners, versions and counts, never the document. Every refusal
answers `detail = {"code": DashboardErrorCode, "message": plain words}`, with `problems` for an
invalid document and `current_version` for a version conflict. Bodies are read here, not by
FastAPI, so that a body of the wrong shape is refused in the same words (FastAPI's own 422 would
be a list of errors). Only the 503 of an audit log that can't be written stays M1's string.

A panel's alert is part of its dashboard's document: after every create, save and restore, the
rules of the dashboard's panels are brought in line with what was saved (`AlertSync`), and the
answer says what that did in the tools (`alert_changes`); a delete leaves its panels' rules as
page rules; a copy never copies an alert."""

import copy
import json
import logging
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from omnikrux.monitoring.alerts.sync import AlertChangeOut
from omnikrux.monitoring.audit import begin_change, finish_change
from omnikrux.monitoring.dashboards.ready_made import (
    DESCRIPTIONS,
    NEED_METRIC,
    NEED_NOTE,
    NEEDS,
    TITLES,
    Need,
    ReadyKey,
    build_ready_made,
    parse_ready_id,
    project_ready_keys,
    ready_id,
)
from omnikrux.monitoring.dashboards.schema import (
    OwnerKind,
    adapt_sources,
    panel_count,
)
from omnikrux.monitoring.dashboards.store import (
    DashboardRecord,
    DashboardSummary,
    Origin,
    UnknownDashboard,
    UnknownVersion,
    VersionConflict,
    VersionRecord,
)
from omnikrux.monitoring.dashboards.writes import (
    DASHBOARD_GONE,
    NOT_SAVED,
    READ_ONLY,  # noqa: F401 (other modules write dashboards with it: `alerts/api.py`)
    check_document,  # noqa: F401 (as READ_ONLY)
    check_notify,  # noqa: F401 (as READ_ONLY)
    create_dashboard_audited,
    dashboard_error,
    dashboard_gone,
    dashboard_record,
    name_taken,
    owner_details,
    owner_of,
    reconcile_alerts,
    refuse_ready_made,
    save_audited,
    version_conflict,
)
from omnikrux.monitoring.models import ContactPointRow, lock_first
from omnikrux.monitoring.projects.types import Project, UnknownProject
from omnikrux.monitoring.services import MonitoringServices
from omnikrux.monitoring.sources.connector import QueryRejected
from omnikrux.monitoring.sources.health import SECRETS_UNREADABLE
from omnikrux.monitoring.sources.transport import SourceUnreachable
from omnikrux.monitoring.sources.types import NameTaken, SourceConfig

VERSION_GONE = "That version of the dashboard no longer exists."
NOT_REMOVED = "The dashboard couldn't be removed. Try again."
CANT_READ_ALL = "OmniKrux couldn't read every metric name, so it can't tell what's missing."
# Metric names read to tell which exporters report; well past a large Prometheus.
NAME_LIMIT = 100_000

# What a body of the wrong shape is told, by field. Never the value sent.
NOT_JSON = "The request body isn't valid JSON. Correct it and try again."
NOT_AN_OBJECT = "Send the request as a JSON object."
SPEC_NOT_AN_OBJECT = "Send the dashboard as a JSON object."
OWNER_KIND_CHOICE = 'Choose "project" or "group" as the owner kind.'
OWNER_ID_NEEDED = "Choose the project or group by its id."
VERSION_NUMBER = "Send the version you started from as a whole number."
FROM_ID_NEEDED = "Choose the dashboard to copy by its id."
TITLE_TEXT = "Use 1 to 120 characters, without line breaks."
FIELD_UNKNOWN = "The request has a field OmniKrux doesn't use. Remove it and try again."
FIELD_INVALID = "A field has a value that can't be used. Check the request and try again."
_FIELD_WORDS = {
    "owner_kind": OWNER_KIND_CHOICE,
    "owner_id": OWNER_ID_NEEDED,
    "base_version": VERSION_NUMBER,
    "from_id": FROM_ID_NEEDED,
    "title": TITLE_TEXT,
}

router = APIRouter()
log = logging.getLogger(__name__)


# --- Shapes ------------------------------------------------------------------------------------


class DashboardOut(BaseModel):
    id: str
    owner_kind: OwnerKind
    owner_id: str
    owner_name: str
    title: str
    version: int
    spec: dict
    ready_made: bool
    # None for a ready-made view (generated on request, never stored).
    created_at: datetime | None
    updated_at: datetime | None
    # What saving the panels' alerts did in their tools (a create, save or restore); else [].
    alert_changes: list[AlertChangeOut] = []


class DashboardSummaryOut(BaseModel):
    id: str
    owner_kind: OwnerKind
    owner_id: str
    title: str
    version: int
    panel_count: int
    updated_at: datetime | None
    ready_made: bool


class VersionOut(BaseModel):
    version: int
    saved_at: datetime
    title: str
    panel_count: int
    origin: Origin
    restored_from: int | None
    copied_from: str | None


class VersionDetailOut(BaseModel):
    version: int
    saved_at: datetime
    spec: dict


class ReadyMadeOut(BaseModel):
    """A ready-made view of a project and what its data lacks. `checked` is False when the
    metric names couldn't be read (`check_message` says why); `missing` and `notes` are then
    empty, never guessed."""

    key: ReadyKey
    id: str
    title: str
    description: str
    missing: list[Need]
    notes: list[str]
    checked: bool
    check_message: str | None


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class DashboardCreateIn(_Body):
    owner_kind: OwnerKind
    owner_id: str
    spec: dict


class DashboardSaveIn(_Body):
    base_version: int
    spec: dict
    # "explore": the panel came from Explore; the audit record says so and names what was added.
    origin: Literal["editor", "explore"] = "editor"


class RestoreIn(_Body):
    base_version: int


class DashboardCopyIn(_Body):
    """`title` None: the source's title, made unique for the owner."""

    from_id: str
    owner_kind: OwnerKind
    owner_id: str
    title: str | None = None


# --- Helpers -----------------------------------------------------------------------------------


def _version_gone() -> HTTPException:
    return dashboard_error(404, "not_found", VERSION_GONE)


def _schema(model: type[BaseModel]) -> dict:
    """The body's schema for the OpenAPI document (the handler reads the body itself)."""
    return {
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": model.model_json_schema()}},
        }
    }


async def _body[Body: BaseModel](request: Request, model: type[Body]) -> Body:
    """The body as `model`; 422 in plain words when it isn't one: `invalid_dashboard` when the
    document isn't an object, `bad_request` for anything else."""
    raw = await request.body()
    try:
        data = json.loads(raw)
    except (ValueError, RecursionError):  # RecursionError: nesting too deep to read
        raise dashboard_error(422, "bad_request", NOT_JSON) from None
    if not isinstance(data, dict):
        raise dashboard_error(422, "bad_request", NOT_AN_OBJECT)
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        error = exc.errors()[0]
        field = str((error.get("loc") or ("",))[0])
        if field == "spec":
            raise dashboard_error(
                422,
                "invalid_dashboard",
                SPEC_NOT_AN_OBJECT,
                problems=[{"path": "", "message": "Expected an object."}],
            ) from None
        if error.get("type") == "extra_forbidden":
            raise dashboard_error(422, "bad_request", FIELD_UNKNOWN) from None
        raise dashboard_error(422, "bad_request", _FIELD_WORDS.get(field, FIELD_INVALID)) from None


def _owner_kind(raw: str | None) -> OwnerKind | None:
    if raw is None or raw in ("project", "group"):
        return raw  # type: ignore[return-value]
    raise dashboard_error(422, "bad_request", OWNER_KIND_CHOICE)


def _whole(raw: str | None) -> int | None:
    """A whole number of at most 9 decimal digits, or None."""
    if raw is None or not raw.isascii() or not raw.isdecimal() or len(raw) > 9:
        return None
    return int(raw)


def _services(request: Request) -> MonitoringServices:
    return request.app.state.monitoring


async def _owner_name(services: MonitoringServices, kind: OwnerKind, id: str) -> str:
    """The owner's name for reading or deleting a dashboard; empty when the owner is gone."""
    try:
        return (await owner_of(services, kind, id)).name
    except HTTPException:
        return ""


async def _ready_project(services: MonitoringServices, project_id: str) -> Project:
    try:
        return await services.projects.get(project_id)
    except UnknownProject:
        raise dashboard_gone() from None


async def _source_configs(services: MonitoringServices, project: Project) -> list[SourceConfig]:
    """The project's linked sources that still exist, in link order."""
    found = []
    for link in project.links:
        try:
            found.append(await services.sources.get(link.source_id))
        except KeyError:
            continue
    return found


async def _ready_document(services: MonitoringServices, id: str) -> tuple[Project, ReadyKey, dict]:
    """The ready-made view `id` names and the project it belongs to; 404 `not_found` when the
    project is gone or has no such view."""
    parsed = parse_ready_id(id)
    if parsed is None:
        raise dashboard_gone()
    project_id, key = parsed
    project = await _ready_project(services, project_id)
    configs = await _source_configs(services, project)
    types = {c.id: c.type for c in configs}
    if key not in project_ready_keys(project, types):
        raise dashboard_gone()
    doc = build_ready_made(key, kind=project.kind, has_loki="loki" in types.values())
    return project, key, doc


def _out(
    record: DashboardRecord, owner_name: str, alert_changes: list[AlertChangeOut] | None = None
) -> DashboardOut:
    return DashboardOut(
        id=record.id,
        owner_kind=record.owner_kind,
        owner_id=record.owner_id,
        owner_name=owner_name,
        title=record.title,
        version=record.version,
        spec=record.spec,
        ready_made=False,
        created_at=record.created_at,
        updated_at=record.updated_at,
        alert_changes=alert_changes or [],
    )


dashboard_out = _out


def _save_failure(exc: Exception) -> str:
    if isinstance(exc, (VersionConflict, NameTaken)):
        return str(exc)
    if isinstance(exc, UnknownDashboard):
        return DASHBOARD_GONE
    message = getattr(exc, "message", None)
    return message if isinstance(message, str) else NOT_SAVED


async def save_document(
    request: Request,
    current: DashboardRecord,
    owner_name: str,
    doc: dict,
    *,
    extra: dict | None = None,
    also: Callable[[AsyncSession], Awaitable[None]] | None = None,
) -> DashboardRecord:
    """Save `doc` (valid and normalised) over `current` as the editor's save does: the
    `dashboard_save` record (M2's details, plus `extra`) first, then the next version, in one
    transaction with `also` (run first, under the write lock). VersionConflict, UnknownDashboard,
    NameTaken or what `also` raises: nothing changed, and the record says why."""
    services = _services(request)
    details = owner_details(current.owner_kind, owner_name) | {
        "version": current.version + 1,
        "previous_version": current.version,
        "panels": panel_count(doc),
    }
    record = await begin_change(
        request, "dashboard_save", "dashboard", doc["title"], details | (extra or {})
    )
    try:
        async with services.sessionmaker.begin() as session:
            await lock_first(session)
            if also is not None:
                await also(session)
            saved = await services.dashboards.save(
                current.id, current.version, doc, session=session
            )
    except Exception as exc:
        await finish_change(request, record, False, _save_failure(exc))
        raise
    await finish_change(request, record, True)
    return saved


def _without_unknown_contact_points(doc: dict, known: set[str]) -> tuple[dict, list[str]]:
    """The document with every panel alert's `notify` id that isn't in `known` left out, and
    those ids (each once, in document order)."""
    out = copy.deepcopy(doc)
    gone: list[str] = []
    for panel in out.get("panels", []):
        alert = panel.get("alert") if isinstance(panel, dict) else None
        if not isinstance(alert, dict) or not isinstance(alert.get("notify"), list):
            continue
        for cp_id in alert["notify"]:
            if cp_id not in known and cp_id not in gone:
                gone.append(cp_id)
        alert["notify"] = [cp_id for cp_id in alert["notify"] if cp_id in known]
    return out, gone


def _without_contact_point(doc: dict, cp_id: str) -> dict | None:
    """The document without `cp_id` in any panel alert's `notify`; None when none names it."""
    out = copy.deepcopy(doc)
    found = False
    for panel in out.get("panels", []):
        alert = panel.get("alert") if isinstance(panel, dict) else None
        if isinstance(alert, dict) and cp_id in (alert.get("notify") or []):
            alert["notify"] = [each for each in alert["notify"] if each != cp_id]
            found = True
    return out if found else None


async def drop_contact_point(request: Request, cp_id: str, cp_name: str) -> None:
    """After a contact point is deleted: save each dashboard whose panel alerts name it as a new
    version without it (`dashboard_save` with `removed_contact_point`), so the next save of that
    dashboard isn't refused for an id nobody touched. A save that lost to another save is tried
    once more on the new version; a second loss is left in the audit log (the alert's rule
    already doesn't use the contact point)."""
    services = _services(request)
    for summary in await services.dashboards.list():
        saved = False
        for attempt in range(2):
            try:
                current = await services.dashboards.get(summary.id)
            except UnknownDashboard:
                break
            doc = _without_contact_point(current.spec, cp_id)
            if doc is None:
                break
            owner_name = await _owner_name(services, current.owner_kind, current.owner_id)
            try:
                await save_document(
                    request, current, owner_name, doc, extra={"removed_contact_point": cp_name}
                )
            except VersionConflict:
                if attempt == 0:
                    continue
                log.warning(
                    "Dashboard %s still names a removed contact point: it changed twice meanwhile",
                    summary.id,
                )
            except UnknownDashboard:
                pass
            except Exception as exc:  # noqa: BLE001 (the contact point is gone; logged, audited)
                log.warning(
                    "Dashboard %s still names a removed contact point (%s)",
                    summary.id,
                    type(exc).__name__,
                )
            else:
                saved = True
            break
        if saved:
            await reconcile_alerts(services, summary.id)


def _summary_out(summary: DashboardSummary) -> DashboardSummaryOut:
    return DashboardSummaryOut(
        id=summary.id,
        owner_kind=summary.owner_kind,
        owner_id=summary.owner_id,
        title=summary.title,
        version=summary.version,
        panel_count=summary.panel_count,
        updated_at=summary.updated_at,
        ready_made=False,
    )


def _version_out(version: VersionRecord) -> VersionOut:
    return VersionOut(
        version=version.version,
        saved_at=version.saved_at,
        title=version.title,
        panel_count=version.panel_count,
        origin=version.origin,
        restored_from=version.restored_from,
        copied_from=version.copied_from,
    )


# --- Routes ------------------------------------------------------------------------------------


@router.get("/dashboards")
async def list_dashboards(
    request: Request, owner_kind: str | None = None, owner_id: str | None = None
) -> list[DashboardSummaryOut]:
    """Saved dashboards, all or one owner's, by title (any case)."""
    kind = _owner_kind(owner_kind)
    summaries = await _services(request).dashboards.list(kind, owner_id)
    return [_summary_out(s) for s in summaries]


@router.post("/dashboards", status_code=201, openapi_extra=_schema(DashboardCreateIn))
async def add_dashboard(request: Request) -> DashboardOut:
    body = await _body(request, DashboardCreateIn)
    created, changes = await create_dashboard_audited(
        request, owner_kind=body.owner_kind, owner_id=body.owner_id, spec=body.spec
    )
    owner_name = await _owner_name(_services(request), created.owner_kind, created.owner_id)
    return _out(created, owner_name, changes)


@router.post("/dashboards/copy", status_code=201, openapi_extra=_schema(DashboardCopyIn))
async def copy_dashboard(request: Request) -> DashboardOut:
    """A copy of a dashboard for any owner, with the sources that owner can't use set to its own
    first source of the type (`null`)."""
    services = _services(request)
    body = await _body(request, DashboardCopyIn)
    if parse_ready_id(body.from_id) is not None:
        _, _, spec = await _ready_document(services, body.from_id)
        source_title, base = spec["title"], spec["title"]  # a ready-made view isn't "a copy"
    else:
        source = await dashboard_record(services, body.from_id)
        spec, source_title, base = source.spec, source.title, f"{source.title} (copy)"
    owner = await owner_of(services, body.owner_kind, body.owner_id)
    if body.title is not None:
        title = body.title
    else:
        title = await services.dashboards.unique_title(owner.kind, owner.id, base)
    adapted = adapt_sources(spec, owner_kind=owner.kind, linked_source_ids=owner.linked)
    for panel in adapted.get("panels", []):
        if isinstance(panel, dict):
            panel["alert"] = None  # an alert is its panel's alone: a copy starts without one
    created, changes = await create_dashboard_audited(
        request,
        owner_kind=owner.kind,
        owner_id=owner.id,
        spec=adapted | {"title": title},
        origin="copied",
        copied_from=source_title,
    )
    return _out(created, owner.name, changes)


@router.get("/dashboards/{id}")
async def get_dashboard(id: str, request: Request) -> DashboardOut:
    services = _services(request)
    if parse_ready_id(id) is not None:
        project, _, spec = await _ready_document(services, id)
        return DashboardOut(
            id=id,
            owner_kind="project",
            owner_id=project.id,
            owner_name=project.name,
            title=spec["title"],
            version=0,
            spec=spec,
            ready_made=True,
            created_at=None,
            updated_at=None,
        )
    record = await dashboard_record(services, id)
    return _out(record, await _owner_name(services, record.owner_kind, record.owner_id))


@router.put("/dashboards/{id}", openapi_extra=_schema(DashboardSaveIn))
async def save_dashboard(id: str, request: Request) -> DashboardOut:
    """Save the document as the next version; 409 (nothing changed) when another save landed
    since `base_version`."""
    refuse_ready_made(id)
    body = await _body(request, DashboardSaveIn)
    saved, changes = await save_audited(
        request,
        id,
        base_version=body.base_version,
        spec=body.spec,
        from_explore=body.origin == "explore",
    )
    owner_name = await _owner_name(_services(request), saved.owner_kind, saved.owner_id)
    return _out(saved, owner_name, changes)


@router.delete("/dashboards/{id}", status_code=204)
async def remove_dashboard(id: str, request: Request, version: str | None = None) -> Response:
    """Delete the dashboard and every version of it; 409 (nothing changed) when it is no longer
    at `version`."""
    refuse_ready_made(id)
    services = _services(request)
    base = _whole(version)
    if base is None:
        raise dashboard_error(422, "bad_request", VERSION_NUMBER)
    current = await dashboard_record(services, id)
    try:
        versions = len(await services.dashboards.versions(id))
    except UnknownDashboard:
        raise dashboard_gone() from None
    owner_name = await _owner_name(services, current.owner_kind, current.owner_id)
    details = owner_details(current.owner_kind, owner_name) | {"versions": versions}
    record = await begin_change(request, "dashboard_remove", "dashboard", current.title, details)
    try:
        await services.dashboards.delete(id, base)
    except VersionConflict as exc:
        await finish_change(request, record, False, str(exc))
        raise version_conflict(exc) from None
    except UnknownDashboard:
        await finish_change(request, record, False, DASHBOARD_GONE)
        raise dashboard_gone() from None
    except Exception:
        await finish_change(request, record, False, NOT_REMOVED)
        raise
    await finish_change(request, record, True)
    # Its panels' rules run on as page rules.
    await reconcile_alerts(services, id, deleted=True)
    return Response(status_code=204)


@router.get("/dashboards/{id}/versions")
async def list_versions(id: str, request: Request) -> list[VersionOut]:
    """Every version of the dashboard, newest first."""
    try:
        versions = await _services(request).dashboards.versions(id)
    except UnknownDashboard:
        raise dashboard_gone() from None
    return [_version_out(v) for v in versions]


async def _version(services: MonitoringServices, id: str, v: str) -> tuple[VersionRecord, dict]:
    number = _whole(v)
    try:
        if number is None:
            await services.dashboards.versions(id)  # an unknown dashboard says so first
            raise UnknownVersion(v)
        return await services.dashboards.version(id, number)
    except UnknownDashboard:
        raise dashboard_gone() from None
    except UnknownVersion:
        raise _version_gone() from None


@router.get("/dashboards/{id}/versions/{v}")
async def get_version(id: str, v: str, request: Request) -> VersionDetailOut:
    version, spec = await _version(_services(request), id, v)
    return VersionDetailOut(version=version.version, saved_at=version.saved_at, spec=spec)


@router.post("/dashboards/{id}/versions/{v}/restore", openapi_extra=_schema(RestoreIn))
async def restore_version(id: str, v: str, request: Request) -> DashboardOut:
    """Save an earlier version's document as the next version; 409 (nothing changed) when
    another save landed since `base_version`."""
    refuse_ready_made(id)
    services = _services(request)
    body = await _body(request, RestoreIn)
    current = await dashboard_record(services, id)
    old, old_spec = await _version(services, id, v)
    details: dict = {"from_version": old.version, "version": body.base_version + 1}
    # A panel alert of that version may name a contact point deleted since: it is left out (the
    # record names its id), so the editor's next save isn't refused for an id nobody touched.
    known = {cp.id for cp in await services.contact_points.list()}
    gone = _without_unknown_contact_points(old_spec, known)[1]
    if gone:
        details["removed_contact_point"] = gone
    record = await begin_change(request, "dashboard_restore", "dashboard", old.title, details)
    try:
        async with services.sessionmaker.begin() as session:
            await lock_first(session)
            known_now = set(await session.scalars(select(ContactPointRow.id)))
            restored = await services.dashboards.restore(
                id,
                old.version,
                body.base_version,
                session=session,
                transform=lambda spec: _without_unknown_contact_points(spec, known_now)[0],
            )
    except VersionConflict as exc:
        await finish_change(request, record, False, str(exc))
        raise version_conflict(exc) from None
    except NameTaken as exc:
        await finish_change(request, record, False, str(exc))
        raise name_taken(exc) from None
    except UnknownDashboard:
        await finish_change(request, record, False, DASHBOARD_GONE)
        raise dashboard_gone() from None
    except UnknownVersion:
        await finish_change(request, record, False, VERSION_GONE)
        raise _version_gone() from None
    except Exception:
        await finish_change(request, record, False, NOT_SAVED)
        raise
    await finish_change(request, record, True)
    owner_name = await _owner_name(services, current.owner_kind, current.owner_id)
    return _out(restored, owner_name, await reconcile_alerts(services, restored.id))


@router.get("/projects/{id}/ready-made")
async def ready_made_views(id: str, request: Request) -> list[ReadyMadeOut]:
    """The project's ready-made views, each with what its data lacks. The metric names are read
    once, from the project's first Prometheus source with that link's filter."""
    services = _services(request)
    project = await _ready_project(services, id)
    configs = await _source_configs(services, project)
    keys = project_ready_keys(project, {c.id: c.type for c in configs})
    if not keys:
        return []
    names, message = await _metric_names(services, project, configs)
    views = []
    for key in keys:
        missing: list[Need] = []
        if names is not None:
            missing = [n for n in NEEDS[key] if NEED_METRIC[n] not in names]
        views.append(
            ReadyMadeOut(
                key=key,
                id=ready_id(project.id, key),
                title=TITLES[key],
                description=DESCRIPTIONS[key],
                missing=missing,
                notes=[NEED_NOTE[n] for n in missing],
                checked=names is not None,
                check_message=message,
            )
        )
    return views


async def _metric_names(
    services: MonitoringServices, project: Project, configs: list[SourceConfig]
) -> tuple[set[str] | None, str | None]:
    """(every metric name, None), or (None, why they couldn't be read)."""
    source = next(c for c in configs if c.type == "prometheus")
    link = next(link for link in project.links if link.source_id == source.id)
    if source.secrets_unreadable:
        return None, SECRETS_UNREADABLE
    connector = services.connectors.get(source.type)
    try:
        catalog = await connector.describe_fields(
            services.transports.for_source(source), matchers=link.matchers, limit=NAME_LIMIT
        )
    except (SourceUnreachable, QueryRejected) as exc:
        return None, exc.message
    if catalog.truncated:  # never say "isn't reporting" about names that weren't all read
        return None, CANT_READ_ALL
    return {m.name for m in catalog.metrics}, None
