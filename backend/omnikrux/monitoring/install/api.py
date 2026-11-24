"""Routes under /api/monitoring/install: whether the pinned tools are here, the install review,
the uninstall review and the review of the contact points in OmniKrux's own Alertmanager
(server-built plans the browser applies through `POST /api/actions/{plan_id}/apply`), and what a
cluster's tools look like now."""

from __future__ import annotations

from dataclasses import asdict, replace
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from omnikrux.actions.pipeline import PlanOut, Target, make_plan
from omnikrux.audit.store import actor_of
from omnikrux.monitoring.install import messages
from omnikrux.monitoring.install.action import KIND_KEY, InstallAction, ordered
from omnikrux.monitoring.install.contacts import KIND_KEY as CONTACTS_KIND_KEY
from omnikrux.monitoring.install.contacts import (
    ContactSyncAction,
    DesiredContacts,
    PlanState,
    amc_path,
    desired_contacts,
    in_sync,
    problem_words,
    read_object,
)
from omnikrux.monitoring.install.pins import CHARTS
from omnikrux.monitoring.install.settings import (
    Component,
    InstallSettings,
    validate_settings,
)
from omnikrux.monitoring.install.status import (
    InstallStatus,
    read_status,
    shipped,
    update_available,
)
from omnikrux.monitoring.install.store import InstallRecord, InstallState
from omnikrux.monitoring.install.uninstall import UninstallAction
from omnikrux.monitoring.install.values import AMC_NAME
from omnikrux.monitoring.models import now
from omnikrux.monitoring.projects.api import SourceRefOut
from omnikrux.monitoring.projects.store import UnknownProject
from omnikrux.monitoring.query.run import PROJECT_GONE
from omnikrux.monitoring.services import MonitoringServices
from omnikrux.monitoring.sources.api import FoundToolOut
from omnikrux.monitoring.sources.discovery import CLUSTER_GONE
from omnikrux.resources.kinds import object_name_problem

router = APIRouter(prefix="/install")

_DEFAULTS = InstallSettings()
# Long enough for any value a field takes; anything longer is a malformed request.
_TEXT = Annotated[str, Field(max_length=253)]


class ChartOut(BaseModel):
    key: str
    version: str
    app_version: str


class ToolsOut(BaseModel):
    available: bool
    message: str | None
    helm_version: str | None
    charts: list[ChartOut]


class ResourcesIn(BaseModel):
    """A component's resources; a field left out keeps what the settings it updates have."""

    model_config = ConfigDict(extra="forbid")

    cpu_request: _TEXT | None = None
    memory_request: _TEXT | None = None
    memory_limit: _TEXT | None = None


_RESOURCE_FIELDS = ("prometheus", "alertmanager", "loki", "alloy")


class InstallSettingsIn(BaseModel):
    """What the user can set. A field left out (or null) keeps the value of the settings it
    updates: the cluster's install record when there is one, else the defaults. Values that
    don't fit come back as problems with the plan (never a 422), so only types are checked."""

    model_config = ConfigDict(extra="forbid")

    namespace: _TEXT | None = None
    retention_days: int | None = None
    persist: bool | None = None
    prometheus_storage: _TEXT | None = None
    loki_storage: _TEXT | None = None
    alertmanager_storage: _TEXT | None = None
    prometheus: ResourcesIn | None = None
    alertmanager: ResourcesIn | None = None
    loki: ResourcesIn | None = None
    alloy: ResourcesIn | None = None

    def over(self, base: InstallSettings) -> InstallSettings:
        """`base` with every field this body sets."""
        changes: dict = {}
        for name, value in self.model_dump(exclude_none=True).items():
            if name in _RESOURCE_FIELDS:
                value = replace(getattr(base, name), **value)
            changes[name] = value
        return replace(base, **changes)


class ResourcesOut(BaseModel):
    cpu_request: str
    memory_request: str
    memory_limit: str


class InstallSettingsOut(BaseModel):
    namespace: str
    retention_days: int
    persist: bool
    prometheus_storage: str
    loki_storage: str
    alertmanager_storage: str
    prometheus: ResourcesOut
    alertmanager: ResourcesOut
    loki: ResourcesOut
    alloy: ResourcesOut

    @classmethod
    def of(cls, s: InstallSettings) -> InstallSettingsOut:
        return cls(**asdict(s))


class SettingProblemOut(BaseModel):
    field: str
    message: str


class FactsOut(BaseModel):
    default_storage_class: str | None
    kube_version: str


class InstallPlanIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cluster_id: str = Field(min_length=1, max_length=200)
    components: list[Component] = Field(min_length=1, max_length=2)
    settings: InstallSettingsIn | None = None
    project_id: str | None = Field(default=None, min_length=1, max_length=200)

    @field_validator("components")
    @classmethod
    def _distinct(cls, value: list[Component]) -> list[Component]:
        if len(set(value)) != len(value):
            raise ValueError("Each component can be asked for once.")
        return value


class InstallPlanOut(BaseModel):
    plan: PlanOut
    settings: InstallSettingsOut
    problems: list[SettingProblemOut]
    facts: FactsOut


class ContactsOut(BaseModel):
    """How OmniKrux's contact points stand in its own Alertmanager: `none` (nothing to route and
    nothing applied), `in_sync` (what is applied is what OmniKrux wants), `needs_review` (that
    changed since), `failed` (it can't be worked out, or the last apply failed: `message`).
    `contact_points` and `rules` count what OmniKrux wants there now."""

    state: Literal["none", "in_sync", "needs_review", "failed"]
    message: str | None
    applied_at: datetime | None
    contact_points: int
    rules: int


class ContactsSyncReviewOut(BaseModel):
    kind: Literal["review"]
    plan: PlanOut


class ContactsSyncDoneOut(BaseModel):
    kind: Literal["done"]
    contacts: ContactsOut


class InstallOut(BaseModel):
    namespace: str
    components: list[Component]
    settings: InstallSettingsOut
    state: InstallState
    message: str | None
    job_id: str | None
    charts: dict[str, str]  # chart key -> the version installed
    shipped: dict[str, str]  # chart key -> the version this OmniKrux ships
    update_available: bool
    sources: dict[str, SourceRefOut | None]  # prometheus, alertmanager, loki
    contacts: ContactsOut


class WorkloadOut(BaseModel):
    kind: str
    name: str
    label: str
    ready: int
    desired: int
    why: str | None


class ReleaseOut(BaseModel):
    release: str
    label: str
    chart: str
    version: str | None
    status: str  # Helm's, or "missing" when Helm has no record of it
    revision: int | None
    deployed_at: datetime | None
    workloads: list[WorkloadOut]


class InstallStatusOut(BaseModel):
    cluster_id: str
    cluster_name: str
    tools: ToolsOut
    install: InstallOut | None
    releases: list[ReleaseOut]
    others: list[FoundToolOut]  # Prometheus, Loki and Alertmanager the user runs elsewhere
    checked_at: datetime
    problem: str | None


class UninstallPlanIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    delete_data: bool = False


def _services(request: Request) -> MonitoringServices:
    return request.app.state.monitoring


async def _tools_out(services: MonitoringServices) -> ToolsOut:
    status = await services.install_tools.status()
    return ToolsOut(
        available=status.available,
        message=status.message,
        helm_version=status.helm_version,
        charts=[
            ChartOut(key=key, version=pin.version, app_version=pin.app_version)
            for key, pin in CHARTS.items()
        ],
    )


def contacts_out(
    record: InstallRecord, desired: DesiredContacts | None, problem: str | None = None
) -> ContactsOut:
    """The record's contact points against what OmniKrux wants now (`desired`; None with
    `problem` when that can't be worked out)."""
    applied_at = record.contacts_applied_at
    if desired is None:
        return ContactsOut(
            state="failed", message=problem, applied_at=applied_at, contact_points=0, rules=0
        )
    counts = {"contact_points": len(desired.contact_points), "rules": len(desired.rules)}
    if desired.amc is None and record.contacts_digest is None:
        return ContactsOut(state="none", message=None, applied_at=applied_at, **counts)
    if in_sync(desired, record):
        return ContactsOut(state="in_sync", message=None, applied_at=applied_at, **counts)
    if record.contacts_message is not None:
        return ContactsOut(
            state="failed", message=record.contacts_message, applied_at=applied_at, **counts
        )
    return ContactsOut(state="needs_review", message=None, applied_at=applied_at, **counts)


async def _contacts(services: MonitoringServices, record: InstallRecord) -> ContactsOut:
    if record.alertmanager_source_id is None:
        return ContactsOut(
            state="none",
            message=None,
            applied_at=record.contacts_applied_at,
            contact_points=0,
            rules=0,
        )
    try:
        desired = await desired_contacts(services, record)
    except Exception as exc:  # noqa: BLE001 (said in words; never a value)
        return contacts_out(record, None, problem_words(exc, record))
    return contacts_out(record, desired)


async def _install_out(services: MonitoringServices, record: InstallRecord) -> InstallOut:
    sources: dict[str, SourceRefOut | None] = {}
    for kind in ("prometheus", "alertmanager", "loki"):
        source_id = getattr(record, f"{kind}_source_id")
        try:
            source = await services.sources.get(source_id) if source_id else None
        except KeyError:
            source = None
        sources[kind] = SourceRefOut(id=source.id, name=source.name) if source else None
    return InstallOut(
        namespace=record.namespace,
        components=list(record.components),
        settings=InstallSettingsOut.of(record.settings),
        state=record.state,
        message=record.message,
        job_id=record.job_id,
        charts=dict(record.charts),
        shipped=shipped(record),
        update_available=update_available(record),
        sources=sources,
        contacts=await _contacts(services, record),
    )


async def _status_out(services: MonitoringServices, status: InstallStatus) -> InstallStatusOut:
    record = status.record
    return InstallStatusOut(
        cluster_id=status.cluster_id,
        cluster_name=status.cluster_name,
        tools=await _tools_out(services),
        install=await _install_out(services, record) if record is not None else None,
        releases=[
            ReleaseOut(
                release=r.release,
                label=r.label,
                chart=r.chart,
                version=r.version,
                status=r.status,
                revision=r.revision,
                deployed_at=r.deployed_at,
                workloads=[
                    WorkloadOut(
                        kind=w.kind,
                        name=w.name,
                        label=w.label,
                        ready=w.ready,
                        desired=w.desired,
                        why=w.why,
                    )
                    for w in r.workloads
                ],
            )
            for r in status.releases
        ],
        others=[
            FoundToolOut(
                type=t.type,
                state=t.state,
                namespace=t.namespace,
                service=t.service,
                port=t.port,
                scheme=t.scheme,
                version=t.version,
                message=t.message,
                existing_source_id=t.existing_source_id,
                detail=t.detail,
            )
            for t in status.others
        ],
        checked_at=status.checked_at,
        problem=status.problem,
    )


@router.get("/clusters/{cluster_id}")
async def install_status(cluster_id: str, request: Request) -> InstallStatusOut:
    """The cluster's monitoring tools, read live now (`checked_at`); a read that fails gives
    `problem` in words and no releases."""
    state = request.app.state
    services = _services(request)
    try:
        status = await read_status(
            services, cluster_id, connections=state.connections, registry=state.registry
        )
    except KeyError:
        raise HTTPException(status_code=404, detail=CLUSTER_GONE) from None
    return await _status_out(services, status)


@router.post("/clusters/{cluster_id}/uninstall/plan")
async def plan_uninstall(
    cluster_id: str, request: Request, body: UninstallPlanIn | None = None
) -> PlanOut:
    """The uninstall review of what OmniKrux installed in the cluster."""
    state = request.app.state
    services = _services(request)
    try:
        await state.registry.get(cluster_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=CLUSTER_GONE) from None
    record = await services.installs.get(cluster_id)
    if record is None:
        raise HTTPException(status_code=404, detail=messages.NOT_INSTALLED)
    return await make_plan(
        state,
        actor=actor_of(request),
        action="uninstall",
        handler=UninstallAction(services, state),
        target=Target(
            cluster_id=cluster_id, kind_key=KIND_KEY, namespace=None, name=record.namespace
        ),
        params={"delete_data": body.delete_data if body is not None else False},
    )


@router.post("/clusters/{cluster_id}/contacts/sync")
async def sync_contacts(
    cluster_id: str, request: Request
) -> ContactsSyncReviewOut | ContactsSyncDoneOut:
    """Bring the contact points in OmniKrux's own Alertmanager in line: the answer is the review
    of the AlertmanagerConfig and its Secret (a plan applied through
    `POST /api/actions/{plan_id}/apply`), or `done` when what is applied is what OmniKrux
    wants. 409 in words when there is no Alertmanager OmniKrux installed there, or the contact
    points can't be sent to it; nothing is written then."""
    state = request.app.state
    services = _services(request)
    try:
        await state.registry.get(cluster_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=CLUSTER_GONE) from None
    record = await services.installs.get(cluster_id)
    if record is None:
        raise HTTPException(status_code=404, detail=messages.NOT_INSTALLED)
    if record.alertmanager_source_id is None:
        raise HTTPException(status_code=409, detail=messages.NO_ALERTMANAGER)
    try:
        desired = await desired_contacts(services, record)
    except Exception as exc:  # noqa: BLE001 (in words: the secret rule, an unreadable secret)
        raise HTTPException(status_code=409, detail=problem_words(exc, record)) from None
    if in_sync(desired, record):
        return ContactsSyncDoneOut(kind="done", contacts=contacts_out(record, desired))
    mode = "delete" if desired.amc is None else "upsert"
    exists = await _amc_exists(state, cluster_id, record.namespace)
    if mode == "delete" and exists is False:
        # Nothing is left in the cluster to remove: the record says so.
        record = await services.installs.set_contacts(
            cluster_id, digest=None, message=None, at=now()
        )
        return ContactsSyncDoneOut(kind="done", contacts=contacts_out(record, desired))
    if exists is None:  # the plan reads it again and says why it can't
        exists = record.contacts_digest is not None
    action = "delete" if mode == "delete" else ("edit" if exists else "create")
    plan = await make_plan(
        PlanState(state),
        actor=actor_of(request),
        action=action,
        handler=ContactSyncAction(services),
        target=Target(
            cluster_id=cluster_id,
            kind_key=CONTACTS_KIND_KEY,
            namespace=record.namespace,
            name=AMC_NAME,
        ),
        params={"mode": mode, "exists": exists},
    )
    return ContactsSyncReviewOut(kind="review", plan=plan)


async def _amc_exists(state, cluster_id: str, namespace: str) -> bool | None:
    """Whether OmniKrux's AlertmanagerConfig is in the namespace; None when the cluster can't
    tell now (the plan reads it again and answers in words)."""
    try:
        async with state.connections.api(cluster_id) as api:
            return await read_object(api, amc_path(namespace)) is not None
    except Exception:  # noqa: BLE001 (the plan reads it again and answers in words)
        return None


@router.get("/tools")
async def install_tools(request: Request) -> ToolsOut:
    return await _tools_out(_services(request))


@router.post("/plan")
async def plan_install(body: InstallPlanIn, request: Request) -> InstallPlanOut:
    state = request.app.state
    services = _services(request)
    try:
        await state.registry.get(body.cluster_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=CLUSTER_GONE) from None
    if body.project_id is not None:
        try:
            await services.projects.get(body.project_id)
        except UnknownProject:
            raise HTTPException(status_code=404, detail=PROJECT_GONE) from None
    record = await services.installs.get(body.cluster_id)
    # The settings start from the record's (what is installed), else the defaults; a body
    # changes only the fields it sets.
    settings = record.settings if record is not None else InstallSettings()
    if body.settings is not None:
        settings = body.settings.over(settings)
    # What is installed stays installed: the plan covers the record's components too.
    components = ordered([*(record.components if record else ()), *body.components])
    problems = validate_settings(settings)
    # A namespace that can't be one never reaches an API path: the (blocked) plan is made for
    # the namespace OmniKrux already uses, or the default.
    name = settings.namespace
    if object_name_problem(name, name) is not None:
        name = record.namespace if record is not None else _DEFAULTS.namespace
    plan = await make_plan(
        state,
        actor=actor_of(request),
        action="install",
        handler=InstallAction(services, state),
        target=Target(cluster_id=body.cluster_id, kind_key=KIND_KEY, namespace=None, name=name),
        params={
            "components": components,
            "settings": asdict(settings),
            "project_id": body.project_id,
        },
    )
    stored = state.plans.peek(plan.plan_id)
    kept = stored.planned.state if stored is not None else {}
    return InstallPlanOut(
        plan=plan,
        settings=InstallSettingsOut.of(settings),
        problems=[SettingProblemOut(field=p.field, message=p.message) for p in problems],
        facts=FactsOut(
            default_storage_class=kept.get("default_storage_class"),
            kube_version=kept.get("kube_version", ""),
        ),
    )
