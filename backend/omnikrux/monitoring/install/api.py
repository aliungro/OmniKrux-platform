"""Routes under /api/monitoring/install: whether the pinned tools are here, and the install
review (a server-built plan the browser applies through `POST /api/actions/{plan_id}/apply`)."""

from __future__ import annotations

from dataclasses import asdict, replace
from typing import Annotated

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from omnikrux.actions.pipeline import PlanOut, Target, make_plan
from omnikrux.audit.store import actor_of
from omnikrux.monitoring.install.action import KIND_KEY, InstallAction, ordered
from omnikrux.monitoring.install.pins import CHARTS
from omnikrux.monitoring.install.settings import (
    Component,
    InstallSettings,
    validate_settings,
)
from omnikrux.monitoring.projects.store import UnknownProject
from omnikrux.monitoring.query.run import PROJECT_GONE
from omnikrux.monitoring.services import MonitoringServices
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


def _services(request: Request) -> MonitoringServices:
    return request.app.state.monitoring


@router.get("/tools")
async def install_tools(request: Request) -> ToolsOut:
    status = await _services(request).install_tools.status()
    return ToolsOut(
        available=status.available,
        message=status.message,
        helm_version=status.helm_version,
        charts=[
            ChartOut(key=key, version=pin.version, app_version=pin.app_version)
            for key, pin in CHARTS.items()
        ],
    )


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
