"""Routes for dashboards: list, create, read, save, delete, versions, restore and copy.

Every change is audited before it is made (no audit, no change) and finished once it is known
how it ended; audit details hold owners, versions and counts, never the document. Every refusal
answers `detail = {"code": DashboardErrorCode, "message": plain words}`, with `problems` for an
invalid document and `current_version` for a version conflict. Bodies are read here, not by
FastAPI, so that a body of the wrong shape is refused in the same words (FastAPI's own 422 would
be a list of errors). Only the 503 of an audit log that can't be written stays M1's string."""

import json
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, ValidationError

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
    MAX_PROBLEMS,
    DashboardInvalid,
    OwnerKind,
    Problem,
    adapt_sources,
    panel_count,
    validate_dashboard,
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
from omnikrux.monitoring.projects.types import Project, UnknownGroup, UnknownProject
from omnikrux.monitoring.services import MonitoringServices
from omnikrux.monitoring.sources.connector import QueryRejected
from omnikrux.monitoring.sources.health import SECRETS_UNREADABLE
from omnikrux.monitoring.sources.transport import SourceUnreachable
from omnikrux.monitoring.sources.types import NameTaken, SourceConfig

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
VERSION_GONE = "That version of the dashboard no longer exists."
OWNER_GONE = "That project or group no longer exists."
READ_ONLY = "Ready-made views can't be changed. Copy one to edit it."
NOT_LINKED = "This source isn't linked to {project}."
NOT_SAVED = "The dashboard couldn't be saved. Try again."
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


class RestoreIn(_Body):
    base_version: int


class DashboardCopyIn(_Body):
    """`title` None: the source's title, made unique for the owner."""

    from_id: str
    owner_kind: OwnerKind
    owner_id: str
    title: str | None = None


# --- Helpers -----------------------------------------------------------------------------------


def dashboard_error(
    status: int, code: DashboardErrorCode, message: str, **extra: object
) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message, **extra})


def _invalid(exc: DashboardInvalid) -> HTTPException:
    return dashboard_error(
        422,
        "invalid_dashboard",
        str(exc),
        problems=[{"path": p.path, "message": p.message} for p in exc.problems],
    )


def _conflict(exc: VersionConflict) -> HTTPException:
    return dashboard_error(409, "version_conflict", str(exc), current_version=exc.current)


def _taken(exc: NameTaken) -> HTTPException:
    return dashboard_error(409, "name_taken", str(exc))


def _dashboard_gone() -> HTTPException:
    return dashboard_error(404, "not_found", DASHBOARD_GONE)


def _version_gone() -> HTTPException:
    return dashboard_error(404, "not_found", VERSION_GONE)


def _owner_gone() -> HTTPException:
    return dashboard_error(404, "unknown_owner", OWNER_GONE)


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


@dataclass(frozen=True)
class Owner:
    kind: OwnerKind
    id: str
    name: str
    # The sources a project's dashboards may name; a group's name none.
    linked: frozenset[str]


async def _owner(services: MonitoringServices, kind: OwnerKind, id: str) -> Owner:
    """The owner as it is now; 404 `unknown_owner` when it is gone."""
    try:
        if kind == "project":
            project = await services.projects.get(id)
            return Owner(kind, id, project.name, frozenset(l.source_id for l in project.links))
        group = await services.groups.get(id)
        return Owner(kind, id, group.name, frozenset())
    except (UnknownProject, UnknownGroup):
        raise _owner_gone() from None


async def _owner_name(services: MonitoringServices, kind: OwnerKind, id: str) -> str:
    """The owner's name for reading or deleting a dashboard; empty when the owner is gone."""
    try:
        return (await _owner(services, kind, id)).name
    except HTTPException:
        return ""


async def _dashboard(services: MonitoringServices, id: str) -> DashboardRecord:
    try:
        return await services.dashboards.get(id)
    except UnknownDashboard:
        raise _dashboard_gone() from None


async def _ready_project(services: MonitoringServices, project_id: str) -> Project:
    try:
        return await services.projects.get(project_id)
    except UnknownProject:
        raise _dashboard_gone() from None


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
        raise _dashboard_gone()
    project_id, key = parsed
    project = await _ready_project(services, project_id)
    configs = await _source_configs(services, project)
    types = {c.id: c.type for c in configs}
    if key not in project_ready_keys(project, types):
        raise _dashboard_gone()
    doc = build_ready_made(key, kind=project.kind, has_loki="loki" in types.values())
    return project, key, doc


def _refuse_ready_made(id: str) -> None:
    """Ready-made views are never changed: 409 `read_only`."""
    if parse_ready_id(id) is not None:
        raise dashboard_error(409, "read_only", READ_ONLY)


def _sources(doc: dict) -> Iterator[tuple[str, dict]]:
    """(path, source) of every source the document names, in document order."""
    for i, variable in enumerate(doc["variables"]):
        yield f"variables[{i}].source", variable["source"]
    for i, panel in enumerate(doc["panels"]):
        for j, query in enumerate(panel["queries"]):
            yield f"panels[{i}].queries[{j}].source", query["source"]


def _checked(spec: dict, owner: Owner) -> dict:
    """The validated, normalised document for `owner`; 422 `invalid_dashboard` when it isn't
    valid or names a source the project isn't linked to."""
    try:
        doc = validate_dashboard(spec, owner_kind=owner.kind)
    except DashboardInvalid as exc:
        raise _invalid(exc) from None
    if owner.kind == "project":
        message = NOT_LINKED.format(project=owner.name)
        problems = [
            Problem(f"{path}.id", message)
            for path, source in _sources(doc)
            if source["id"] is not None and source["id"] not in owner.linked
        ]
        if problems:
            raise _invalid(DashboardInvalid(tuple(problems[:MAX_PROBLEMS])))
    return doc


def _out(record: DashboardRecord, owner_name: str) -> DashboardOut:
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
    )


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


def _owner_details(owner_kind: OwnerKind, owner_name: str) -> dict:
    return {"owner": owner_kind, "owner_name": owner_name}


async def _add(
    request: Request,
    owner: Owner,
    doc: dict,
    *,
    origin: Origin = "created",
    copied_from: str | None = None,
) -> DashboardOut:
    """Audit, then store the new dashboard; 409 when the title is taken, 404 when the owner went
    away meanwhile."""
    services = _services(request)
    details = _owner_details(owner.kind, owner.name) | {"version": 1, "panels": panel_count(doc)}
    if copied_from is not None:
        details["copied_from"] = copied_from
    record = await begin_change(request, "dashboard_add", "dashboard", doc["title"], details)
    try:
        created = await services.dashboards.create(
            owner.kind, owner.id, doc, origin=origin, copied_from=copied_from
        )
    except NameTaken as exc:
        await finish_change(request, record, False, str(exc))
        raise _taken(exc) from None
    except (UnknownProject, UnknownGroup):
        await finish_change(request, record, False, OWNER_GONE)
        raise _owner_gone() from None
    except Exception:
        await finish_change(request, record, False, NOT_SAVED)
        raise
    await finish_change(request, record, True)
    return _out(created, owner.name)


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
    owner = await _owner(_services(request), body.owner_kind, body.owner_id)
    return await _add(request, owner, _checked(body.spec, owner))


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
        source = await _dashboard(services, body.from_id)
        spec, source_title, base = source.spec, source.title, f"{source.title} (copy)"
    owner = await _owner(services, body.owner_kind, body.owner_id)
    if body.title is not None:
        title = body.title
    else:
        title = await services.dashboards.unique_title(owner.kind, owner.id, base)
    adapted = adapt_sources(spec, owner_kind=owner.kind, linked_source_ids=owner.linked)
    doc = _checked(adapted | {"title": title}, owner)
    return await _add(request, owner, doc, origin="copied", copied_from=source_title)


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
    record = await _dashboard(services, id)
    return _out(record, await _owner_name(services, record.owner_kind, record.owner_id))


@router.put("/dashboards/{id}", openapi_extra=_schema(DashboardSaveIn))
async def save_dashboard(id: str, request: Request) -> DashboardOut:
    """Save the document as the next version; 409 (nothing changed) when another save landed
    since `base_version`."""
    _refuse_ready_made(id)
    services = _services(request)
    body = await _body(request, DashboardSaveIn)
    current = await _dashboard(services, id)
    owner = await _owner(services, current.owner_kind, current.owner_id)
    doc = _checked(body.spec, owner)
    details = _owner_details(owner.kind, owner.name) | {
        "version": body.base_version + 1,
        "previous_version": body.base_version,
        "panels": panel_count(doc),
    }
    record = await begin_change(request, "dashboard_save", "dashboard", doc["title"], details)
    try:
        saved = await services.dashboards.save(id, body.base_version, doc)
    except VersionConflict as exc:
        await finish_change(request, record, False, str(exc))
        raise _conflict(exc) from None
    except NameTaken as exc:
        await finish_change(request, record, False, str(exc))
        raise _taken(exc) from None
    except UnknownDashboard:
        await finish_change(request, record, False, DASHBOARD_GONE)
        raise _dashboard_gone() from None
    except Exception:
        await finish_change(request, record, False, NOT_SAVED)
        raise
    await finish_change(request, record, True)
    return _out(saved, owner.name)


@router.delete("/dashboards/{id}", status_code=204)
async def remove_dashboard(id: str, request: Request, version: str | None = None) -> Response:
    """Delete the dashboard and every version of it; 409 (nothing changed) when it is no longer
    at `version`."""
    _refuse_ready_made(id)
    services = _services(request)
    base = _whole(version)
    if base is None:
        raise dashboard_error(422, "bad_request", VERSION_NUMBER)
    current = await _dashboard(services, id)
    try:
        versions = len(await services.dashboards.versions(id))
    except UnknownDashboard:
        raise _dashboard_gone() from None
    owner_name = await _owner_name(services, current.owner_kind, current.owner_id)
    details = _owner_details(current.owner_kind, owner_name) | {"versions": versions}
    record = await begin_change(request, "dashboard_remove", "dashboard", current.title, details)
    try:
        await services.dashboards.delete(id, base)
    except VersionConflict as exc:
        await finish_change(request, record, False, str(exc))
        raise _conflict(exc) from None
    except UnknownDashboard:
        await finish_change(request, record, False, DASHBOARD_GONE)
        raise _dashboard_gone() from None
    except Exception:
        await finish_change(request, record, False, NOT_REMOVED)
        raise
    await finish_change(request, record, True)
    return Response(status_code=204)


@router.get("/dashboards/{id}/versions")
async def list_versions(id: str, request: Request) -> list[VersionOut]:
    """Every version of the dashboard, newest first."""
    try:
        versions = await _services(request).dashboards.versions(id)
    except UnknownDashboard:
        raise _dashboard_gone() from None
    return [_version_out(v) for v in versions]


async def _version(services: MonitoringServices, id: str, v: str) -> tuple[VersionRecord, dict]:
    number = _whole(v)
    try:
        if number is None:
            await services.dashboards.versions(id)  # an unknown dashboard says so first
            raise UnknownVersion(v)
        return await services.dashboards.version(id, number)
    except UnknownDashboard:
        raise _dashboard_gone() from None
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
    _refuse_ready_made(id)
    services = _services(request)
    body = await _body(request, RestoreIn)
    current = await _dashboard(services, id)
    old, _ = await _version(services, id, v)
    details = {"from_version": old.version, "version": body.base_version + 1}
    record = await begin_change(request, "dashboard_restore", "dashboard", old.title, details)
    try:
        restored = await services.dashboards.restore(id, old.version, body.base_version)
    except VersionConflict as exc:
        await finish_change(request, record, False, str(exc))
        raise _conflict(exc) from None
    except NameTaken as exc:
        await finish_change(request, record, False, str(exc))
        raise _taken(exc) from None
    except UnknownDashboard:
        await finish_change(request, record, False, DASHBOARD_GONE)
        raise _dashboard_gone() from None
    except UnknownVersion:
        await finish_change(request, record, False, VERSION_GONE)
        raise _version_gone() from None
    except Exception:
        await finish_change(request, record, False, NOT_SAVED)
        raise
    await finish_change(request, record, True)
    owner_name = await _owner_name(services, current.owner_kind, current.owner_id)
    return _out(restored, owner_name)


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
