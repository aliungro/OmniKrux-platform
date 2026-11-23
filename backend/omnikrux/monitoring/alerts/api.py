"""Alert routes: the rules of projects and groups, where each runs, the overview, and the dry run.

Every change to a rule writes its audit record first ("no audit, no change": 503 and nothing
stored when it can't be written), then the rule (in a transaction that takes the write lock
before it checks the scope and the contact points), then its targets (`AlertSync`), then
finishes the record. Records name the rule, its scope and settings, never its query text.

Refusals answer `{"detail": {"code", "message"}}` (plus `field` for a value that can't be used,
and `current_version` for a stale save). `POST /alerts/dry-run` changes nothing (it stores
nothing, sends nothing), so it writes no audit record."""

from __future__ import annotations

import asyncio
import copy
import re
import string
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from omnikrux.actions.pipeline import PlanOut
from omnikrux.audit.store import actor_of
from omnikrux.monitoring.alerts.contact_points.types import ContactPoint, ContactPointType
from omnikrux.monitoring.alerts.dry_run import (
    FOR_DURATION,
    GROUP_SOURCE,
    DryRunIn,
    DryRunOut,
    DryRunRefused,
    dry_run,
    wrong_type_copy,
)
from omnikrux.monitoring.alerts.engine import engine_note, no_source_copy
from omnikrux.monitoring.alerts.rule_expr import (
    LOG_QUERY_COPY,
    RuleExprError,
    duration_text,
    eval_expr,
    expr_without_document,
    is_log_query,
    parse_duration,
    render_message,
    substitute,
    variable_defaults,
)
from omnikrux.monitoring.alerts.silences import (
    CREATED_BY,
    AlertmanagerFailed,
    AlertmanagerSilences,
    NewSilence,
    Silence,
    SilenceInvalid,
    ToolSilence,
    UnknownSilence,
    check_silence,
    matchers_text,
    silence_state,
)
from omnikrux.monitoring.alerts.silences import matches as silence_matches
from omnikrux.monitoring.alerts.store import (
    HistoryKind,
    InstanceRecord,
    Origin,
    RuleChanged,
    RuleRecord,
    RuleSpec,
    TargetRecord,
    UnknownRule,
    UnknownTarget,
    loading_copy,
)
from omnikrux.monitoring.alerts.sync import (
    CONTACT_POINT_GONE,
    GONE_PROJECT,
    UNKNOWN_CAPABILITY,
    AlertChange,
    AlertChangeOut,
    cluster_name,
    where,
)
from omnikrux.monitoring.alerts.sync import change_out as _change_out
from omnikrux.monitoring.alerts.tool.channels import ChannelsUnreadable, read_channels
from omnikrux.monitoring.alerts.tool.prometheus_rule import TransientRefusal, wanted_mode
from omnikrux.monitoring.alerts.types import (
    ALERT_PANEL_TYPES,
    EVERY_CHOICES,
    MAX_CHANNEL_LABELS,
    MAX_FOR_SECONDS,
    MAX_NOTIFY,
    ChannelPick,
    Condition,
    Engine,
    Of,
    Op,
    ScopeKind,
    Severity,
    TargetState,
    ToolKind,
    ToolState,
    worst,
)
from omnikrux.monitoring.audit import begin_change, finish_change
from omnikrux.monitoring.dashboards.api import (
    DASHBOARD_GONE,
    READ_ONLY,
    DashboardOut,
    check_document,
    check_notify,
    dashboard_error,
    dashboard_out,
    owner_of,
    reconcile_alerts,
    save_document,
)
from omnikrux.monitoring.dashboards.ready_made import parse_ready_id
from omnikrux.monitoring.dashboards.schema import MAX_QUERIES
from omnikrux.monitoring.dashboards.store import DashboardRecord, UnknownDashboard, VersionConflict
from omnikrux.monitoring.models import (
    AlertRuleRow,
    ContactPointRow,
    GroupRecord,
    ProjectRecord,
    lock_first,
)
from omnikrux.monitoring.models import now as now_utc
from omnikrux.monitoring.projects.types import (
    REVIEW_CHANGED,
    Group,
    Project,
    UnknownGroup,
    UnknownProject,
    review_token,
)
from omnikrux.monitoring.query.run import NOT_LINKED, QUERY_LENGTH, SOURCE_GONE
from omnikrux.monitoring.query.series import MAX_QUERY_CHARS
from omnikrux.monitoring.services import MonitoringServices
from omnikrux.monitoring.sources.capability import CapabilityUnknown
from omnikrux.monitoring.sources.prometheus_operator import NOT_SERVED, NOT_SERVED_OTHER
from omnikrux.monitoring.sources.transport import SourceUnreachable
from omnikrux.monitoring.sources.types import QUERYABLE_TYPES, NameTaken, SourceConfig

router = APIRouter(prefix="/alerts")

RuleErrorCode = Literal[
    "invalid_rule", "rule_changed", "not_found", "unknown_scope", "panel_rule", "tool_rule"
]

# -- copy --------------------------------------------------------------------------------------

RULE_GONE = "That alert rule no longer exists."
UNKNOWN_SCOPE = "That project or group no longer exists."
PANEL_RULE = 'This rule belongs to the panel "{panel}" on "{dashboard}". Change it there.'
TOOL_RULE = "This rule runs in the tool, which keeps checking it. Silence it instead."
NAME_COPY = "Use 1 to 120 characters, without line breaks."
MESSAGE_COPY = "Use at most 500 characters."
NOTIFY_MAX = "At most 10 contact points."
NOTIFY_ONCE = "Each contact point only once."
CHANNEL_ONLY_TOOL = "A channel is only for alerts that run in the tool."
RECEIVER_COPY = "Use 1 to 200 characters."
LABELS_MAX = "At most 10 labels."
LABEL_NAME = "Use a label name: letters, digits and _, not starting with a digit."
LABEL_VALUE = "Use at most 200 characters."
NO_ALERTMANAGER = (
    "Notifications go wherever this Prometheus's Alertmanager sends them. "
    "Link its Alertmanager to pick a channel."
)
NOT_SAVED = "The rule couldn't be saved. Try again."
NOT_REMOVED = "The rule couldn't be removed. Try again."
NOT_CHECKED_OFF = "Not checked yet: OmniKrux's checks are off."
NOT_SAVED_SILENCE = "The silence couldn't be saved. Try again."
NOT_REMOVED_SILENCE = "The silence couldn't be ended. Try again."
TARGETS_BEHIND = (
    "The rule was saved, but where it runs couldn't be brought up to date. "
    "OmniKrux tries again when it restarts."
)
OTHER_OWNER = "That panel is on a dashboard of another project or group."
HAS_ALERT = "That panel already has an alert."
ON_A_PANEL = "This rule already belongs to a panel."
QUERIES_FULL = "That panel already has 10 queries."
PANEL_GONE = "That panel no longer exists."
NO_ALERT_HERE = "A {kind} panel can't have an alert. Use a time series, stat, gauge or bar panel."
GONE_GROUP = "A removed group"
PANEL_GONE_TITLE = "a panel that was removed"
DASHBOARD_GONE_TITLE = "a dashboard that was removed"

MAX_NAME = 120
MAX_MESSAGE = 500
MAX_RECEIVER = 200
MAX_HISTORY = 500
_SEVERITY_ORDER = {"critical": 0, "warning": 1, "info": 2}
_LABEL = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


class RuleRefused(Exception):
    def __init__(
        self,
        status: int,
        code: RuleErrorCode,
        message: str,
        *,
        field: str | None = None,
        current_version: int | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code: RuleErrorCode = code
        self.message = message
        self.field = field
        self.current_version = current_version

    def http(self) -> HTTPException:
        detail: dict = {"code": self.code, "message": self.message}
        if self.field is not None:
            detail["field"] = self.field
        if self.current_version is not None:
            detail["current_version"] = self.current_version
        return HTTPException(status_code=self.status, detail=detail)


def _invalid(message: str, field: str) -> RuleRefused:
    return RuleRefused(422, "invalid_rule", message, field=field)


# -- shapes ------------------------------------------------------------------------------------


class ScopeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: ScopeKind
    id: str = Field(min_length=1)


class SourceRefIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["prometheus", "loki"]
    id: str | None = None


class ConditionIn(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, populate_by_name=True)

    of: Of = "each"
    op: Op
    threshold: float
    for_: str = Field("5m", alias="for")
    every: Literal["30s", "1m", "5m"] = "1m"


class ChannelIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    receiver: str
    labels: dict[str, str] = Field(default_factory=dict)


class RuleIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    scope: ScopeIn
    source: SourceRefIn
    expr: str  # 1 to 10000 characters, refused in words by `_spec`
    condition: ConditionIn
    severity: Severity = "warning"
    message: str = ""
    contact_point_ids: list[str] = Field(default_factory=list)
    engine: Engine = "omnikrux"
    channel: ChannelIn | None = None


class RuleSaveIn(RuleIn):
    base_version: int


class InstanceOut(BaseModel):
    labels: dict[str, str]
    state: Literal["pending", "firing"]
    active_since: datetime
    fired_at: datetime | None
    value: float | None
    silenced: bool
    message: str | None


class TargetOut(BaseModel):
    id: str
    project_id: str
    project_name: str
    engine: Engine
    tool: ToolKind | None
    where: str
    engine_note: str | None
    state: TargetState
    state_since: datetime
    last_eval_at: datetime | None
    message: str | None
    eval_expr: str
    rule_text: str
    tool_state: ToolState | None
    tool_message: str | None
    leaving: bool
    instances: list[InstanceOut]
    # The tool that holds (or may hold) a copy of the target's rule, whatever checks it now: a
    # Loki group or PrometheusRule left behind after a move to OmniKrux stays visible.
    tool_copy: ToolKind | None = None


class PanelLinkOut(BaseModel):
    dashboard_id: str
    dashboard_title: str
    panel_id: str
    panel_title: str


class ScopeOut(BaseModel):
    kind: ScopeKind
    id: str
    name: str


class ConditionOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    of: Of
    op: Op
    threshold: float
    for_: str = Field(alias="for")
    every: str


class ContactPointRefOut(BaseModel):
    id: str
    name: str
    type: ContactPointType


class ChannelPickOut(BaseModel):
    receiver: str
    labels: dict[str, str]


class RuleOut(BaseModel):
    id: str
    name: str
    scope: ScopeOut
    source_type: Literal["prometheus", "loki"]
    source_id: str | None
    expr: str
    condition: ConditionOut
    severity: Severity
    message: str
    contact_points: list[ContactPointRefOut]
    engine: Engine
    channel: ChannelPickOut | None
    paused: bool
    origin: Origin
    panel: PanelLinkOut | None
    state: TargetState
    firing_since: datetime | None
    targets: list[TargetOut]
    removing: bool
    version: int
    created_at: datetime
    updated_at: datetime


class RuleChangeOut(BaseModel):
    rule: RuleOut | None
    changes: list[AlertChangeOut]


class HistoryOut(BaseModel):
    at: datetime
    kind: HistoryKind
    project_name: str
    labels: dict[str, str] | None
    value: float | None
    message: str | None


class FiringOut(BaseModel):
    rule_id: str
    rule_name: str
    target_id: str
    project_id: str
    project_name: str
    severity: Severity
    since: datetime
    instances: int
    summary: str
    where: str


class EngineOut(BaseModel):
    enabled: bool
    running: bool
    last_tick_at: datetime | None
    rules: int
    behind: int
    note: str


class CountsOut(BaseModel):
    rules: int
    firing: int
    pending: int
    cant_check: int
    not_applied: int


class OverviewOut(BaseModel):
    counts: CountsOut
    firing: list[FiringOut]
    by_project: dict[str, int]
    by_group: dict[str, int]
    engine: EngineOut


class CapabilityOut(BaseModel):
    project_id: str
    project_name: str
    source_id: str | None
    source_name: str | None
    tool: ToolKind | None
    reason: str | None


class TargetRefOut(BaseModel):
    target_id: str
    project_name: str
    cluster_name: str | None


class RuleDeleteReviewOut(BaseModel):
    id: str
    name: str
    panel: PanelLinkOut | None
    cluster_removals: list[TargetRefOut]
    loki_removals: list[TargetRefOut]
    token: str


class SourceRefOut(BaseModel):
    id: str
    name: str


class AttachIn(BaseModel):
    """The panel to attach a page rule to, and the dashboard's version it was read at."""

    model_config = ConfigDict(extra="forbid")

    dashboard_id: str
    panel_id: str
    base_version: int


class AttachOut(BaseModel):
    dashboard: DashboardOut
    rule: RuleOut


class PanelAlertStateOut(BaseModel):
    rule_id: str
    name: str
    state: TargetState
    since: datetime | None


class ChannelOut(BaseModel):
    receiver: str
    labels: dict[str, str]
    usable: bool
    reason: str | None


class ChannelsOut(BaseModel):
    alertmanager: SourceRefOut | None
    channels: list[ChannelOut]
    message: str | None


# -- reading -----------------------------------------------------------------------------------


def _services(request: Request) -> MonitoringServices:
    return request.app.state.monitoring


@dataclass
class _Names:
    """What the answers name, read once per request."""

    projects: dict[str, Project]
    groups: dict[str, Group]
    contact_points: dict[str, ContactPoint]
    checks_on: bool = True  # whether the engine runs (it reads the tools too)

    def project(self, id: str) -> str:
        project = self.projects.get(id)
        return project.name if project is not None else GONE_PROJECT

    def scope(self, kind: ScopeKind, id: str) -> str:
        if kind == "project":
            return self.project(id)
        group = self.groups.get(id)
        return group.name if group is not None else GONE_GROUP


async def _names(services: MonitoringServices, *, contact_points: bool = True) -> _Names:
    return _Names(
        projects={p.id: p for p in await services.projects.list()},
        groups={g.id: g for g in await services.groups.list()},
        contact_points=(
            {cp.id: cp for cp in await services.contact_points.list()} if contact_points else {}
        ),
        checks_on=services.engine.enabled,
    )


def never_read(target: TargetRecord) -> bool:
    """A target that runs in a tool whose state has never been read from the tool."""
    return target.engine == "tool" and target.last_eval_at is None


def shown_state(target: TargetRecord, rule: RuleRecord) -> TargetState:
    """The state a target shows. A target in a tool that isn't in sync there is "not applied"
    unless what the tool reports is worse; one whose state was never read from the tool is at
    least "waiting", never "OK"; a paused rule's OmniKrux targets are "paused"."""
    if target.engine == "tool":
        state = target.state
        if never_read(target) and state == "ok":
            state = "waiting"
        if target.tool_state != "in_sync":
            return worst((state, "not_applied"))
        return state
    if rule.paused:
        return "paused"
    return target.state


def shown_message(target: TargetRecord, checks_on: bool) -> str | None:
    """What a target says: a never-read tool target in sync says it is loading, or, with
    OmniKrux's checks off (nothing reads the tools then), that it isn't checked yet. One that
    isn't in sync in its tool says why (its tool's words): nothing is loading there."""
    if never_read(target):
        if target.tool_state != "in_sync":
            return target.tool_message
        return loading_copy(target.tool_kind) if checks_on else NOT_CHECKED_OFF
    return target.message


def _rule_state(rule: RuleRecord, targets: list[TargetRecord]) -> TargetState:
    """The worst state of the targets that still belong to the rule (all of them while it is
    being removed). A rule without targets (a group without projects, or targets not worked out
    yet) is checked nowhere: "no data", never "ok"."""
    staying = [t for t in targets if not t.leaving] or targets
    if not staying:
        return "paused" if rule.paused else "no_data"
    return worst(shown_state(t, rule) for t in staying)


def _instance_out(rule: RuleRecord, i: InstanceRecord) -> InstanceOut:
    return InstanceOut(
        labels=dict(i.labels),
        state=i.state,
        active_since=i.active_since,
        fired_at=i.fired_at,
        value=i.value,
        silenced=i.silenced,
        message=render_message(rule.message, i.labels, i.value) if rule.message else None,
    )


def _tool_copy(target: TargetRecord) -> ToolKind | None:
    """The tool a copy of the target's rule is (or may be) in; None when nothing was put there."""
    if target.tool_object is not None:
        return target.tool_object.kind
    return target.tool_kind if target.applied_version is not None else None


def _target_out(
    rule: RuleRecord, target: TargetRecord, instances: list[InstanceRecord], names: _Names
) -> TargetOut:
    return TargetOut(
        id=target.id,
        project_id=target.project_id,
        project_name=names.project(target.project_id),
        engine=target.engine,
        tool=target.tool_kind if target.engine == "tool" else None,
        where=where(target),
        engine_note=target.engine_note,
        state=shown_state(target, rule),
        state_since=target.state_since,
        last_eval_at=target.last_eval_at,
        message=shown_message(target, names.checks_on),
        eval_expr=target.eval_expr,
        rule_text=target.rule_text,
        tool_state=target.tool_state,
        tool_message=target.tool_message,
        leaving=target.leaving,
        instances=[_instance_out(rule, i) for i in instances],
        tool_copy=_tool_copy(target),
    )


async def _panel_link(services: MonitoringServices, rule: RuleRecord) -> PanelLinkOut | None:
    if rule.origin != "panel" or rule.dashboard_id is None or rule.panel_id is None:
        return None
    try:
        dashboard = await services.dashboards.get(rule.dashboard_id)
    except UnknownDashboard:
        return PanelLinkOut(
            dashboard_id=rule.dashboard_id,
            dashboard_title=DASHBOARD_GONE_TITLE,
            panel_id=rule.panel_id,
            panel_title=PANEL_GONE_TITLE,
        )
    panel = next(
        (
            p
            for p in dashboard.spec.get("panels", [])
            if isinstance(p, dict) and p.get("id") == rule.panel_id
        ),
        None,
    )
    title = panel.get("title") if isinstance(panel, dict) else None
    return PanelLinkOut(
        dashboard_id=dashboard.id,
        dashboard_title=dashboard.title,
        panel_id=rule.panel_id,
        panel_title=title if isinstance(title, str) and title else PANEL_GONE_TITLE,
    )


def _condition_out(cond: Condition) -> ConditionOut:
    every = next((k for k, v in EVERY_CHOICES.items() if v == cond.every_seconds), "1m")
    return ConditionOut(
        of=cond.of,
        op=cond.op,
        threshold=cond.threshold,
        for_=duration_text(cond.for_seconds),
        every=every,
    )


async def _rule_out(
    services: MonitoringServices,
    rule: RuleRecord,
    names: _Names,
    targets: list[TargetRecord] | None = None,
) -> RuleOut:
    alerts = services.alerts
    if targets is None:
        targets = await alerts.targets(rule_id=rule.id)
    targets = sorted(targets, key=lambda t: (names.project(t.project_id).casefold(), t.project_id))
    outs: list[TargetOut] = []
    firing_at: list[datetime] = []
    for target in targets:
        instances = await alerts.instances(target.id)
        outs.append(_target_out(rule, target, instances, names))
        if not target.leaving:
            firing_at += [i.fired_at or i.active_since for i in instances if i.state == "firing"]
            if shown_state(target, rule) == "firing" and not instances:
                firing_at.append(target.state_since)
    state = _rule_state(rule, targets)
    contact_points = [
        ContactPointRefOut(id=cp.id, name=cp.name, type=cp.type)
        for id in rule.contact_point_ids
        if (cp := names.contact_points.get(id)) is not None
    ]
    channel = (
        ChannelPickOut(receiver=rule.channel.receiver, labels=dict(rule.channel.labels))
        if rule.channel is not None
        else None
    )
    return RuleOut(
        id=rule.id,
        name=rule.name,
        scope=ScopeOut(
            kind=rule.scope_kind, id=rule.scope_id, name=names.scope(rule.scope_kind, rule.scope_id)
        ),
        source_type=rule.source_type,
        source_id=rule.source_id,
        expr=rule.expr,
        condition=_condition_out(rule.condition),
        severity=rule.severity,
        message=rule.message,
        contact_points=contact_points,
        engine=rule.engine,
        channel=channel,
        paused=rule.paused,
        origin=rule.origin,
        panel=await _panel_link(services, rule),
        state=state,
        firing_since=min(firing_at) if state == "firing" and firing_at else None,
        targets=outs,
        removing=rule.deleted_at is not None,
        version=rule.version,
        created_at=rule.created_at,
        updated_at=rule.updated_at,
    )


async def _live_rule(services: MonitoringServices, id: str) -> RuleRecord:
    """The rule, unless it is gone or being removed: 404 `not_found`."""
    try:
        rule = await services.alerts.get_rule(id)
    except UnknownRule:
        raise RuleRefused(404, "not_found", RULE_GONE).http() from None
    if rule.deleted_at is not None:
        raise RuleRefused(404, "not_found", RULE_GONE).http()
    return rule


# -- checking a rule ---------------------------------------------------------------------------


def _name(raw: str) -> str:
    if any(c in raw for c in "\r\n") or any(ord(c) < 32 or ord(c) == 127 for c in raw):
        raise _invalid(NAME_COPY, "name")
    name = raw.strip()
    if not 1 <= len(name) <= MAX_NAME:
        raise _invalid(NAME_COPY, "name")
    return name


def _channel(body: RuleIn) -> ChannelPick | None:
    if body.channel is None:
        return None
    if body.engine != "tool":
        raise _invalid(CHANNEL_ONLY_TOOL, "channel")
    receiver = body.channel.receiver
    if not 1 <= len(receiver) <= MAX_RECEIVER:
        raise _invalid(RECEIVER_COPY, "channel")
    labels = body.channel.labels
    if len(labels) > MAX_CHANNEL_LABELS:
        raise _invalid(LABELS_MAX, "channel")
    for key, value in labels.items():
        if _LABEL.fullmatch(key) is None:
            raise _invalid(LABEL_NAME, "channel")
        if len(value) > MAX_RECEIVER:
            raise _invalid(LABEL_VALUE, "channel")
    return ChannelPick(receiver=receiver, labels=dict(sorted(labels.items())))


def _contact_point_ids(body: RuleIn) -> tuple[str, ...]:
    ids = body.contact_point_ids
    if len(ids) > MAX_NOTIFY:
        raise _invalid(NOTIFY_MAX, "contact_point_ids")
    if len(set(ids)) != len(ids):
        raise _invalid(NOTIFY_ONCE, "contact_point_ids")
    return tuple(ids)


async def _spec(services: MonitoringServices, body: RuleIn) -> RuleSpec:
    """The rule as stored, or a refusal naming the field. The query is stored with the built-ins
    placed (`$__interval`, `$__rate_interval`); any other `$name` is refused."""
    name = _name(body.name)
    cond_in = body.condition
    every = EVERY_CHOICES[cond_in.every]
    try:
        for_seconds = parse_duration(cond_in.for_)
    except ValueError:
        for_seconds = -1
    if not 0 <= for_seconds <= MAX_FOR_SECONDS:
        raise _invalid(FOR_DURATION, "for")
    if not 1 <= len(body.expr) <= MAX_QUERY_CHARS:
        raise _invalid(QUERY_LENGTH, "query")
    if body.source.type == "loki" and is_log_query(body.expr):
        raise _invalid(LOG_QUERY_COPY, "query")
    try:
        expr = expr_without_document(body.expr, every)
    except RuleExprError as exc:
        raise _invalid(str(exc), "query") from None
    if not 1 <= len(expr) <= MAX_QUERY_CHARS or len(eval_expr(expr, cond_in.of)) > MAX_QUERY_CHARS:
        raise _invalid(QUERY_LENGTH, "query")
    if len(body.message) > MAX_MESSAGE:
        raise _invalid(MESSAGE_COPY, "message")
    contact_points = _contact_point_ids(body)
    known = {cp.id for cp in await services.contact_points.list()}
    if any(id not in known for id in contact_points):
        raise _invalid(CONTACT_POINT_GONE, "contact_point_ids")
    channel = _channel(body)
    await _check_source(services, body)
    return RuleSpec(
        name=name,
        scope_kind=body.scope.kind,
        scope_id=body.scope.id,
        source_type=body.source.type,
        source_id=body.source.id,
        expr=expr,
        condition=Condition(cond_in.of, cond_in.op, cond_in.threshold, for_seconds, every),
        severity=body.severity,
        message=body.message,
        contact_point_ids=contact_points,
        engine=body.engine,
        channel=channel,
    )


async def _check_source(services: MonitoringServices, body: RuleIn) -> None:
    """A group rule runs on each project's first source of the type; a project rule may name one
    of its linked sources of the type."""
    if body.scope.kind == "group":
        if body.source.id is not None:
            raise _invalid(GROUP_SOURCE, "source")
        try:
            await services.groups.get(body.scope.id)
        except UnknownGroup:
            raise RuleRefused(404, "unknown_scope", UNKNOWN_SCOPE).http() from None
        return
    try:
        project = await services.projects.get(body.scope.id)
    except UnknownProject:
        raise RuleRefused(404, "unknown_scope", UNKNOWN_SCOPE).http() from None
    if body.source.id is None:
        return
    if not any(link.source_id == body.source.id for link in project.links):
        raise _invalid(NOT_LINKED, "source")
    try:
        source = await services.sources.get(body.source.id)
    except KeyError:
        raise _invalid(SOURCE_GONE, "source") from None
    if source.type != body.source.type or source.type not in QUERYABLE_TYPES:
        raise _invalid(wrong_type_copy(body.source.type), "source")


async def _locked_checks(session: AsyncSession, spec: RuleSpec) -> None:
    """Inside the write transaction (after `lock_first`): the scope and every contact point are
    still there, so a delete can't land between the check and the write."""
    if spec.scope_kind == "project":
        found = await session.scalar(
            select(ProjectRecord.id).where(ProjectRecord.id == spec.scope_id)
        )
    else:
        found = await session.scalar(select(GroupRecord.id).where(GroupRecord.id == spec.scope_id))
    if found is None:
        raise RuleRefused(404, "unknown_scope", UNKNOWN_SCOPE)
    if spec.contact_point_ids:
        known = set(
            await session.scalars(
                select(ContactPointRow.id).where(ContactPointRow.id.in_(spec.contact_point_ids))
            )
        )
        if any(id not in known for id in spec.contact_point_ids):
            raise _invalid(CONTACT_POINT_GONE, "contact_point_ids")


def _threshold_text(value: float) -> str:
    return repr(float(value)).removesuffix(".0")


def _details(spec: RuleSpec, services_names: _Names) -> dict:
    """The audit details: names and settings, never the query text."""
    cond = spec.condition
    every = next((k for k, v in EVERY_CHOICES.items() if v == cond.every_seconds), "1m")
    words = f"{cond.op} {_threshold_text(cond.threshold)} for {duration_text(cond.for_seconds)}"
    words = f"{'total ' if cond.of == 'total' else ''}{words} every {every}"
    return {
        "scope": spec.scope_kind,
        "scope_name": services_names.scope(spec.scope_kind, spec.scope_id),
        "engine": spec.engine,
        "severity": spec.severity,
        "condition": words,
        "contact_points": [
            services_names.contact_points[id].name
            for id in spec.contact_point_ids
            if id in services_names.contact_points
        ],
    }


async def _panel_refusal(services: MonitoringServices, rule: RuleRecord) -> RuleRefused | None:
    link = await _panel_link(services, rule)
    if link is None:
        return None
    return RuleRefused(
        409,
        "panel_rule",
        PANEL_RULE.format(panel=link.panel_title, dashboard=link.dashboard_title),
    )


# -- routes: rules -----------------------------------------------------------------------------


@router.get("/rules")
async def list_rules(
    request: Request, scope_kind: ScopeKind | None = None, scope_id: str | None = None
) -> list[RuleOut]:
    """The rules, or a scope's; a deleted rule still removing its targets shows `removing`."""
    services = _services(request)
    rules = await services.alerts.list_rules(
        scope_kind=scope_kind, scope_id=scope_id, include_deleted=True
    )
    names = await _names(services)
    by_rule: dict[str, list[TargetRecord]] = {}
    for target in await services.alerts.targets():
        by_rule.setdefault(target.rule_id, []).append(target)
    return [
        await _rule_out(services, rule, names, by_rule.get(rule.id, []))
        for rule in rules
        if rule.deleted_at is None or by_rule.get(rule.id)
    ]


@router.get("/rules/{id}")
async def get_rule(id: str, request: Request) -> RuleOut:
    services = _services(request)
    try:
        rule = await services.alerts.get_rule(id)
    except UnknownRule:
        raise RuleRefused(404, "not_found", RULE_GONE).http() from None
    return await _rule_out(services, rule, await _names(services))


@router.get("/rules/{id}/history")
async def rule_history(
    id: str, request: Request, limit: int = Query(50, ge=1, le=MAX_HISTORY)
) -> list[HistoryOut]:
    """What happened to the rule, newest first. Entries of targets that are gone keep their
    project's name; they are history, never a current state."""
    services = _services(request)
    try:
        await services.alerts.get_rule(id)
    except UnknownRule:
        raise RuleRefused(404, "not_found", RULE_GONE).http() from None
    names = await _names(services, contact_points=False)
    return [
        HistoryOut(
            at=e.at,
            kind=e.kind,
            project_name=names.project(e.project_id),
            labels=dict(e.labels) if e.labels is not None else None,
            value=e.value,
            message=e.message,
        )
        for e in await services.alerts.history(rule_id=id, limit=limit)
    ]


async def _finish_with_targets(
    request: Request, record: int, rule_id: str, *, changed: bool
) -> list[AlertChange]:
    """Bring the saved rule's targets up to date and finish the audit record."""
    try:
        changes = await _services(request).alert_sync.reconcile_rule(rule_id, changed=changed)
    except Exception:
        await finish_change(request, record, False, TARGETS_BEHIND)
        raise
    await finish_change(request, record, True)
    return changes


@router.post("/rules", status_code=201)
async def add_rule(body: RuleIn, request: Request) -> RuleChangeOut:
    services = _services(request)
    try:
        spec = await _spec(services, body)
    except RuleRefused as exc:
        raise exc.http() from None
    names = await _names(services)
    record = await begin_change(
        request, "alert_rule_add", "alert_rule", spec.name, _details(spec, names)
    )
    try:
        async with services.sessionmaker.begin() as session:
            await lock_first(session)
            await _locked_checks(session, spec)
            rule = await services.alerts.create_rule(spec, session=session)
    except RuleRefused as exc:
        await finish_change(request, record, False, exc.message)
        raise exc.http() from None
    except Exception:
        await finish_change(request, record, False, NOT_SAVED)
        raise
    changes = await _finish_with_targets(request, record, rule.id, changed=False)
    rule = await services.alerts.get_rule(rule.id)
    return RuleChangeOut(
        rule=await _rule_out(services, rule, names),
        changes=[_change_out(c) for c in changes],
    )


@router.put("/rules/{id}")
async def save_rule(id: str, body: RuleSaveIn, request: Request) -> RuleChangeOut:
    services = _services(request)
    rule = await _live_rule(services, id)
    try:
        if (refusal := await _panel_refusal(services, rule)) is not None:
            raise refusal
        if rule.version != body.base_version:
            raise _stale(rule.version)
        spec = await _spec(services, body)
    except RuleRefused as exc:
        raise exc.http() from None
    names = await _names(services)
    record = await begin_change(
        request, "alert_rule_change", "alert_rule", spec.name, _details(spec, names)
    )
    try:
        async with services.sessionmaker.begin() as session:
            await lock_first(session)
            await _locked_checks(session, spec)
            current = await services.alerts.get_rule(id)
            if current.deleted_at is not None:
                raise RuleRefused(404, "not_found", RULE_GONE)
            if current.origin == "panel":
                raise _PanelRule
            await services.alerts.update_rule(
                id, spec, base_version=body.base_version, session=session
            )
    except _PanelRule:
        refusal = await _panel_refusal(services, await services.alerts.get_rule(id))
        refusal = refusal or RuleRefused(409, "panel_rule", RULE_GONE)
        await finish_change(request, record, False, refusal.message)
        raise refusal.http() from None
    except RuleChanged as exc:
        await finish_change(request, record, False, str(exc))
        raise _stale(exc.current).http() from None
    except UnknownRule:
        await finish_change(request, record, False, RULE_GONE)
        raise RuleRefused(404, "not_found", RULE_GONE).http() from None
    except RuleRefused as exc:
        await finish_change(request, record, False, exc.message)
        raise exc.http() from None
    except Exception:
        await finish_change(request, record, False, NOT_SAVED)
        raise
    changes = await _finish_with_targets(request, record, id, changed=True)
    return RuleChangeOut(
        rule=await _rule_out(services, await services.alerts.get_rule(id), names),
        changes=[_change_out(c) for c in changes],
    )


class _PanelRule(Exception):
    """The rule became a panel's while the save waited."""


def _stale(current: int) -> RuleRefused:
    return RuleRefused(409, "rule_changed", str(RuleChanged(current)), current_version=current)


@router.post("/rules/{id}/pause")
async def pause_rule(id: str, request: Request) -> RuleOut:
    """Stop checking the rule (OmniKrux's checks only: a tool keeps checking what runs in it)."""
    services = _services(request)
    rule = await _live_rule(services, id)
    targets = await services.alerts.targets(rule_id=id)
    if any(t.engine == "tool" and not t.leaving for t in targets):
        raise RuleRefused(409, "tool_rule", TOOL_RULE).http()
    names = await _names(services)
    if rule.paused:
        return await _rule_out(services, rule, names)
    record = await begin_change(
        request,
        "alert_rule_change",
        "alert_rule",
        rule.name,
        {
            "scope": rule.scope_kind,
            "scope_name": names.scope(rule.scope_kind, rule.scope_id),
            "paused": True,
        },
    )
    try:
        paused = await services.alerts.set_paused(id, True)
    except UnknownRule:
        await finish_change(request, record, False, RULE_GONE)
        raise RuleRefused(404, "not_found", RULE_GONE).http() from None
    except Exception:
        await finish_change(request, record, False, NOT_SAVED)
        raise
    await finish_change(request, record, True)
    return await _rule_out(services, paused, names)


@router.post("/rules/{id}/resume")
async def resume_rule(id: str, request: Request) -> RuleOut:
    """Check the rule again. Its targets are brought up to date first and the rule is written
    last, so the engine sees a change since each target's last check (no pending timer counts
    the paused time)."""
    services = _services(request)
    rule = await _live_rule(services, id)
    names = await _names(services)
    if not rule.paused:
        return await _rule_out(services, rule, names)
    record = await begin_change(
        request,
        "alert_rule_change",
        "alert_rule",
        rule.name,
        {
            "scope": rule.scope_kind,
            "scope_name": names.scope(rule.scope_kind, rule.scope_id),
            "paused": False,
        },
    )
    try:
        await services.alert_sync.reconcile_rule(id)
        resumed = await services.alerts.set_paused(id, False)
    except UnknownRule:
        await finish_change(request, record, False, RULE_GONE)
        raise RuleRefused(404, "not_found", RULE_GONE).http() from None
    except Exception:
        await finish_change(request, record, False, NOT_SAVED)
        raise
    await finish_change(request, record, True)
    return await _rule_out(services, resumed, names)


# -- routes: delete ----------------------------------------------------------------------------


async def _delete_review(request: Request, rule: RuleRecord) -> RuleDeleteReviewOut:
    """What deleting the rule does: OmniKrux targets (and anything never written to a tool) go
    at once; a Loki ruler rule is removed from the ruler; a `PrometheusRule` in a cluster needs
    its own review, and the rule stays (being removed) until it is gone."""
    services, registry = _services(request), request.app.state.registry
    names = await _names(services, contact_points=False)
    cluster: list[TargetRefOut] = []
    loki: list[TargetRefOut] = []
    for target in await services.alerts.targets(rule_id=rule.id):
        if target.tool_object is None and target.applied_version is None:
            continue
        kind = target.tool_object.kind if target.tool_object is not None else target.tool_kind
        ref = TargetRefOut(
            target_id=target.id,
            project_name=names.project(target.project_id),
            cluster_name=(
                await cluster_name(services, registry, target) if kind != "loki_ruler" else None
            ),
        )
        (loki if kind == "loki_ruler" else cluster).append(ref)
    panel = await _panel_link(services, rule)
    review = {
        "id": rule.id,
        "name": rule.name,
        "version": rule.version,
        "panel": panel.model_dump() if panel is not None else None,
        "cluster_removals": [r.model_dump() for r in cluster],
        "loki_removals": [r.model_dump() for r in loki],
    }
    return RuleDeleteReviewOut(
        id=rule.id,
        name=rule.name,
        panel=panel,
        cluster_removals=cluster,
        loki_removals=loki,
        token=review_token(review),
    )


@router.get("/rules/{id}/delete-review")
async def rule_delete_review(id: str, request: Request) -> RuleDeleteReviewOut:
    return await _delete_review(request, await _live_rule(_services(request), id))


async def _tombstone(services: MonitoringServices, session: AsyncSession, rule: RuleRecord) -> None:
    """Inside a locked transaction: the rule, still at the version reviewed, is marked deleted
    and its targets leaving (its reconcile removes them)."""
    current = await session.get(AlertRuleRow, rule.id)
    if current is None or current.deleted_at is not None:
        raise RuleRefused(404, "not_found", RULE_GONE)
    if current.version != rule.version:
        raise RuleRefused(409, "rule_changed", REVIEW_CHANGED)
    await services.alerts.tombstone_rule(rule.id, session=session)
    await services.alerts.put_targets(rule.id, [], session=session)


async def _panel_dashboard(
    services: MonitoringServices, rule: RuleRecord
) -> DashboardRecord | None:
    """The dashboard whose panel still carries the rule's alert, if any."""
    if rule.origin != "panel" or rule.dashboard_id is None:
        return None
    try:
        board = await services.dashboards.get(rule.dashboard_id)
    except UnknownDashboard:
        return None
    return board if _panel_of(board.spec, rule.panel_id, with_alert=True) is not None else None


def _panel_of(doc: dict, panel_id: str | None, *, with_alert: bool = False) -> dict | None:
    for panel in doc.get("panels", []):
        if isinstance(panel, dict) and panel.get("id") == panel_id:
            if with_alert and not isinstance(panel.get("alert"), dict):
                return None
            return panel
    return None


async def _remove_panel_alert(request: Request, rule: RuleRecord, board: DashboardRecord) -> None:
    """Save the rule's dashboard with the panel's `alert: null` (based on its current version,
    once more on the next one if another save landed meanwhile) and mark the rule deleted, in
    one transaction. RuleRefused. Holds the dashboard's alert lock, so a reconcile of an earlier
    save of it can't work from a document read before this write."""
    services = _services(request)
    async with services.alert_sync.dashboard_lock(board.id):
        await _remove_panel_alert_locked(request, rule, board)


async def _remove_panel_alert_locked(
    request: Request, rule: RuleRecord, board: DashboardRecord
) -> None:
    services = _services(request)

    async def also(session: AsyncSession) -> None:
        await _tombstone(services, session, rule)

    for attempt in range(2):
        doc = copy.deepcopy(board.spec)
        panel = _panel_of(doc, rule.panel_id, with_alert=True)
        if panel is None:  # its alert was taken off meanwhile: nothing left to save
            async with services.sessionmaker.begin() as session:
                await lock_first(session)
                await also(session)
            return
        panel["alert"] = None
        owner_name = await _scope_name(services, board.owner_kind, board.owner_id)
        try:
            await save_document(request, board, owner_name, doc, also=also)
            return
        except VersionConflict:
            if attempt:
                raise RuleRefused(409, "rule_changed", REVIEW_CHANGED) from None
        except UnknownDashboard:
            pass
        try:
            board = await services.dashboards.get(board.id)
        except UnknownDashboard:  # deleted meanwhile: the rule is a page rule now
            raise RuleRefused(409, "rule_changed", REVIEW_CHANGED) from None
    raise RuleRefused(409, "rule_changed", REVIEW_CHANGED)


async def _scope_name(services: MonitoringServices, kind: ScopeKind, id: str) -> str:
    """The owner's name as M2's records write it (empty when it is gone)."""
    try:
        if kind == "project":
            return (await services.projects.get(id)).name
        return (await services.groups.get(id)).name
    except (UnknownProject, UnknownGroup):
        return ""


@router.delete("/rules/{id}")
async def delete_rule(id: str, token: str, request: Request) -> RuleChangeOut:
    """Delete the rule as its review showed. A panel's rule is part of its dashboard: the
    dashboard is saved with that panel's alert taken off (`dashboard_save`), and the rule goes."""
    services = _services(request)
    rule = await _live_rule(services, id)
    review = await _delete_review(request, rule)
    if review.token != token:
        raise RuleRefused(409, "rule_changed", REVIEW_CHANGED).http()
    names = await _names(services, contact_points=False)
    record = await begin_change(
        request,
        "alert_rule_remove",
        "alert_rule",
        rule.name,
        {
            "scope": rule.scope_kind,
            "scope_name": names.scope(rule.scope_kind, rule.scope_id),
            "cluster_removals": [r.project_name for r in review.cluster_removals],
            "loki_removals": [r.project_name for r in review.loki_removals],
        },
    )
    board = await _panel_dashboard(services, rule)
    try:
        if board is not None:
            await _remove_panel_alert(request, rule, board)
        else:
            async with services.sessionmaker.begin() as session:
                await lock_first(session)
                await _tombstone(services, session, rule)
    except RuleRefused as exc:
        await finish_change(request, record, False, exc.message)
        raise exc.http() from None
    except UnknownRule:
        await finish_change(request, record, False, RULE_GONE)
        raise RuleRefused(404, "not_found", RULE_GONE).http() from None
    except HTTPException as exc:  # the dashboard's own record couldn't be written
        await finish_change(request, record, False, NOT_REMOVED)
        raise exc from None
    except Exception:
        await finish_change(request, record, False, NOT_REMOVED)
        raise
    changes = await _finish_with_targets(request, record, id, changed=False)
    if board is not None:
        await reconcile_alerts(services, board.id)
    try:
        left = await services.alerts.get_rule(id)
    except UnknownRule:
        out = None
    else:
        out = await _rule_out(services, left, await _names(services))
    return RuleChangeOut(rule=out, changes=[_change_out(c) for c in changes])


# -- routes: tools -----------------------------------------------------------------------------


class SyncReviewOut(BaseModel):
    kind: Literal["review"]
    plan: PlanOut


class SyncDoneOut(BaseModel):
    kind: Literal["done"]
    target: TargetOut | None  # None: the target went (its object was removed)


async def _done(services: MonitoringServices, target_id: str, rule: RuleRecord) -> SyncDoneOut:
    try:
        target = await services.alerts.get_target(target_id)
    except UnknownTarget:
        return SyncDoneOut(kind="done", target=None)
    names = await _names(services, contact_points=False)
    instances = await services.alerts.instances(target.id)
    return SyncDoneOut(kind="done", target=_target_out(rule, target, instances, names))


@router.post("/targets/{target_id}/sync")
async def sync_target(target_id: str, request: Request) -> SyncReviewOut | SyncDoneOut:
    """Bring the target's tool in line with it. A PrometheusRule is a cluster change: the answer
    is its review (a plan of the action pipeline, applied through `POST /api/actions/{id}/apply`),
    or `done` when nothing is left to do. A refusal is the pipeline's answer, and the target
    reads "failed" with its words. A Loki ruler rule is written (or removed) again at once, with
    its own audit record; the answer is `done` with the target as it reads after (it says
    "failed" and why when the ruler refused)."""
    services = _services(request)
    try:
        target = await services.alerts.get_target(target_id)
        rule = await services.alerts.get_rule(target.rule_id)
    except (UnknownTarget, UnknownRule):
        raise RuleRefused(404, "not_found", RULE_GONE).http() from None
    kind = target.tool_object.kind if target.tool_object is not None else target.tool_kind
    if kind == "loki_ruler":
        await services.alert_sync.hand_over(target, rule)
        return await _done(services, target.id, rule)
    mode = wanted_mode(target)
    if mode is None or (mode == "upsert" and target.tool_state == "in_sync"):
        return await _done(services, target.id, rule)
    try:
        plan = await services.prometheus_rules.review(
            request.app.state, actor=actor_of(request), target=target, rule=rule, mode=mode
        )
    except TransientRefusal:
        raise  # a passing reason: the target stays as it was, and the answer says try again
    except HTTPException as exc:
        detail = exc.detail
        message = detail.get("message") if isinstance(detail, dict) else str(detail)
        try:
            await services.alerts.set_tool(
                target.id, tool_state="failed", tool_message=str(message)
            )
        except UnknownTarget:
            pass
        raise
    if plan is None:
        return await _done(services, target.id, rule)
    return SyncReviewOut(kind="review", plan=plan)


# -- routes: panels ----------------------------------------------------------------------------


def _alert_of(rule: RuleRecord, ref: str) -> dict:
    """The panel alert that says what the rule says, reading the query `ref`."""
    cond = rule.condition
    every = next((k for k, v in EVERY_CHOICES.items() if v == cond.every_seconds), "1m")
    return {
        "name": rule.name,
        "query": ref,
        "of": cond.of,
        "op": cond.op,
        "threshold": cond.threshold,
        "for": duration_text(cond.for_seconds),
        "every": every,
        "severity": rule.severity,
        "message": rule.message,
        "notify": list(rule.contact_point_ids),
        "engine": rule.engine,
        "channel": (
            {"receiver": rule.channel.receiver, "labels": dict(rule.channel.labels)}
            if rule.channel is not None
            else None
        ),
    }


def _query_ref(doc: dict, panel: dict, rule: RuleRecord) -> str:
    """The ref of the panel's query that reads what the rule reads (the same source and the same
    text, as written or once its variables and built-ins are placed); else the rule's query is
    added to the panel as the next free ref. RuleRefused when the panel has no room."""
    queries: list = panel.setdefault("queries", [])
    wanted = {"type": rule.source_type, "id": rule.source_id}
    defaults = variable_defaults(doc.get("variables", []))
    for query in queries:
        if not isinstance(query, dict) or (query.get("source") or {}) != wanted:
            continue
        text = query.get("expr")
        if text == rule.expr:
            return query["ref"]
        try:
            if substitute(text, defaults, rule.condition.every_seconds) == rule.expr:
                return query["ref"]
        except (RuleExprError, TypeError):
            continue
    if len(queries) >= MAX_QUERIES:
        raise _invalid(QUERIES_FULL, "panel")
    used = {q.get("ref") for q in queries if isinstance(q, dict)}
    ref = next(c for c in string.ascii_uppercase if c not in used)
    queries.append(
        {"ref": ref, "source": dict(wanted), "expr": rule.expr, "legend": "", "hidden": False}
    )
    return ref


@router.post("/rules/{id}/attach")
async def attach_rule(id: str, body: AttachIn, request: Request) -> AttachOut:
    """Make a page rule the alert of a panel of its own project's or group's dashboard: the
    dashboard is saved (as the editor saves it, from `base_version`) with the alert on that panel,
    and the rule becomes the panel's, in one transaction."""
    services = _services(request)
    rule = await _live_rule(services, id)
    try:
        if rule.origin != "page":
            raise await _panel_refusal(services, rule) or RuleRefused(409, "panel_rule", ON_A_PANEL)
    except RuleRefused as exc:
        raise exc.http() from None
    if parse_ready_id(body.dashboard_id) is not None:
        raise dashboard_error(409, "read_only", READ_ONLY)
    try:
        board = await services.dashboards.get(body.dashboard_id)
    except UnknownDashboard:
        raise dashboard_error(404, "not_found", DASHBOARD_GONE) from None
    if board.version != body.base_version:
        conflict = VersionConflict(board.version)
        raise dashboard_error(409, "version_conflict", str(conflict), current_version=board.version)
    doc = copy.deepcopy(board.spec)
    try:
        if (board.owner_kind, board.owner_id) != (rule.scope_kind, rule.scope_id):
            raise _invalid(OTHER_OWNER, "panel")
        panel = _panel_of(doc, body.panel_id)
        if panel is None:
            raise _invalid(PANEL_GONE, "panel")
        kind = panel.get("type")
        if kind not in ALERT_PANEL_TYPES:
            raise _invalid(NO_ALERT_HERE.format(kind=kind), "panel")
        if panel.get("alert") is not None:
            raise _invalid(HAS_ALERT, "panel")
        panel["alert"] = _alert_of(rule, _query_ref(doc, panel, rule))
    except RuleRefused as exc:
        raise exc.http() from None
    owner = await owner_of(services, board.owner_kind, board.owner_id)
    doc = check_document(doc, owner)
    await check_notify(services, doc)
    panel_title = panel.get("title") or PANEL_GONE_TITLE
    record = await begin_change(
        request,
        "alert_rule_change",
        "alert_rule",
        rule.name,
        {
            "scope": rule.scope_kind,
            "scope_name": owner.name,
            "attached_to": {"dashboard": board.title, "panel": panel_title},
        },
    )

    async def also(session: AsyncSession) -> None:
        row = await session.get(AlertRuleRow, id)
        if row is None or row.deleted_at is not None:
            raise RuleRefused(404, "not_found", RULE_GONE)
        if row.version != rule.version:
            raise _stale(row.version)
        if row.origin != "page":
            raise RuleRefused(409, "panel_rule", ON_A_PANEL)
        await services.alerts.attach_rule(id, board.id, body.panel_id, session=session)

    try:
        # The dashboard's alert lock: a reconcile of an earlier save can't work from a document
        # read before this write (and detach or delete the rule just attached).
        async with services.alert_sync.dashboard_lock(board.id):
            saved = await save_document(request, board, owner.name, doc, also=also)
    except RuleRefused as exc:
        if exc.code == "panel_rule":
            exc = await _panel_refusal(services, await services.alerts.get_rule(id)) or exc
        await finish_change(request, record, False, exc.message)
        raise exc.http() from None
    except VersionConflict as exc:
        await finish_change(request, record, False, str(exc))
        raise dashboard_error(
            409, "version_conflict", str(exc), current_version=exc.current
        ) from None
    except NameTaken as exc:
        await finish_change(request, record, False, str(exc))
        raise dashboard_error(409, "name_taken", str(exc)) from None
    except UnknownDashboard:
        await finish_change(request, record, False, DASHBOARD_GONE)
        raise dashboard_error(404, "not_found", DASHBOARD_GONE) from None
    except Exception:
        await finish_change(request, record, False, NOT_SAVED)
        raise
    await finish_change(request, record, True)
    changes = await reconcile_alerts(services, saved.id)
    attached = await services.alerts.get_rule(id)
    return AttachOut(
        dashboard=dashboard_out(saved, owner.name, changes),
        rule=await _rule_out(services, attached, await _names(services)),
    )


async def _state_since(
    services: MonitoringServices, rule: RuleRecord, targets: list[TargetRecord], state: TargetState
) -> datetime | None:
    """Since when the rule shows `state`: the earliest of its targets that show it (for firing,
    the earliest firing series)."""
    if state == "paused":
        return rule.updated_at
    staying = [t for t in targets if not t.leaving] or targets
    times: list[datetime] = []
    for target in staying:
        if shown_state(target, rule) != state:
            continue
        if state == "firing":
            firing = [
                i.fired_at or i.active_since
                for i in await services.alerts.instances(target.id)
                if i.state == "firing"
            ]
            times += firing or [target.state_since]
        else:
            times.append(target.state_since)
    return min(times, default=None)


@router.get("/panel-states")
async def panel_states(dashboard_id: str, request: Request) -> dict[str, PanelAlertStateOut]:
    """The state of each panel's alert on the dashboard, by panel id: the worst of its targets."""
    services = _services(request)
    out: dict[str, PanelAlertStateOut] = {}
    for rule in await services.alerts.rules_for_dashboard(dashboard_id):
        if rule.panel_id is None or rule.panel_id in out:
            continue
        targets = await services.alerts.targets(rule_id=rule.id)
        state = _rule_state(rule, targets)
        out[rule.panel_id] = PanelAlertStateOut(
            rule_id=rule.id,
            name=rule.name,
            state=state,
            since=await _state_since(services, rule, targets, state),
        )
    return out


# -- routes: the overview ----------------------------------------------------------------------


def duration_words(seconds: float) -> str:
    """`12 min`, `3 h 5 min`, `2 d 4 h`; under a minute `under 1 min`."""
    total = int(max(0, seconds) // 60)
    if total < 1:
        return "under 1 min"
    days, rest = divmod(total, 1440)
    hours, minutes = divmod(rest, 60)
    if days:
        return f"{days} d {hours} h" if hours else f"{days} d"
    if hours:
        return f"{hours} h {minutes} min" if minutes else f"{hours} h"
    return f"{minutes} min"


def firing_summary(
    rule: RuleRecord, firing: list[InstanceRecord], since: datetime, now: datetime
) -> str:
    """The first firing instance's message, or how many series fire; then for how long and the
    severity unless critical (the colour says so)."""
    first = min(firing, key=lambda i: (i.fired_at or i.active_since, i.fingerprint), default=None)
    if rule.message and first is not None:
        text = render_message(rule.message, first.labels, first.value)
    else:
        text = f"{len(firing)} series firing"
    text = f"{text} · for {duration_words((now - since).total_seconds())}"
    if rule.severity != "critical":
        text = f"{text} · {rule.severity}"
    return text


@router.get("/overview")
async def overview(request: Request) -> OverviewOut:
    """Counts of rules by state, every firing target (critical first, then the longest firing),
    firing targets per project and per group rule, and how the engine is doing."""
    services = _services(request)
    alerts = services.alerts
    moment = now_utc()
    rules = await alerts.list_rules()
    by_rule: dict[str, list[TargetRecord]] = {}
    for target in await alerts.targets():
        by_rule.setdefault(target.rule_id, []).append(target)
    names = await _names(services, contact_points=False)
    counts = {"rules": len(rules), "firing": 0, "pending": 0, "cant_check": 0, "not_applied": 0}
    firing: list[FiringOut] = []
    by_project: dict[str, int] = {}
    by_group: dict[str, int] = {}
    for rule in rules:
        targets = by_rule.get(rule.id, [])
        state = _rule_state(rule, targets)
        if state in ("firing", "pending", "not_applied"):
            counts[state] += 1
        elif state in ("unreachable", "error"):
            counts["cant_check"] += 1
        for target in targets:
            if target.leaving or shown_state(target, rule) != "firing":
                continue
            instances = [i for i in await alerts.instances(target.id) if i.state == "firing"]
            since = min(
                (i.fired_at or i.active_since for i in instances), default=target.state_since
            )
            firing.append(
                FiringOut(
                    rule_id=rule.id,
                    rule_name=rule.name,
                    target_id=target.id,
                    project_id=target.project_id,
                    project_name=names.project(target.project_id),
                    severity=rule.severity,
                    since=since,
                    instances=len(instances),
                    summary=firing_summary(rule, instances, since, moment),
                    where=where(target),
                )
            )
            by_project[target.project_id] = by_project.get(target.project_id, 0) + 1
            if rule.scope_kind == "group":
                by_group[rule.scope_id] = by_group.get(rule.scope_id, 0) + 1
    firing.sort(key=lambda f: (_SEVERITY_ORDER[f.severity], f.since, f.rule_name, f.project_name))
    status = services.engine.status(moment)
    return OverviewOut(
        counts=CountsOut(**counts),
        firing=firing,
        by_project=by_project,
        by_group=by_group,
        engine=EngineOut(
            enabled=status.enabled,
            running=status.running,
            last_tick_at=status.last_tick_at,
            rules=status.rules,
            behind=status.behind,
            note=engine_note(status),
        ),
    )


# -- routes: what can run where ----------------------------------------------------------------


@router.get("/capabilities")
async def capabilities(
    request: Request,
    scope_kind: ScopeKind,
    scope_id: str,
    source_type: Literal["prometheus", "loki"],
    source_id: str | None = None,
) -> list[CapabilityOut]:
    """For each project of the scope, the source a rule would read and whether its tool can run
    the rule (and why not)."""
    services = _services(request)
    sync = services.alert_sync
    try:
        if scope_kind == "project":
            await services.projects.get(scope_id)
        else:
            await services.groups.get(scope_id)
    except (UnknownProject, UnknownGroup):
        raise RuleRefused(404, "unknown_scope", UNKNOWN_SCOPE).http() from None
    if source_id is not None:
        if scope_kind == "group":
            raise _invalid(GROUP_SOURCE, "source").http()
        project = await services.projects.get(scope_id)
        if not any(link.source_id == source_id for link in project.links):
            raise RuleRefused(404, "not_found", NOT_LINKED).http()
    projects = await sync.scope_projects(scope_kind, scope_id)
    probe = _probe_rule(scope_kind, scope_id, source_type, source_id)
    out: list[CapabilityOut] = []
    for project in projects:
        found = await sync.source_for(probe, project)
        if found is None:
            out.append(
                CapabilityOut(
                    project_id=project.id,
                    project_name=project.name,
                    source_id=None,
                    source_name=None,
                    tool=None,
                    reason=no_source_copy(project.name, source_type),
                )
            )
            continue
        source, _ = found
        tool: ToolKind | None = None
        try:
            capability = await services.capabilities.get(source)
        except CapabilityUnknown as exc:
            reason: str | None = UNKNOWN_CAPABILITY.format(source=source.name, message=exc.message)
        else:
            tool, reason = capability.tool_engine, capability.reason
            if reason == NOT_SERVED.format(source=source.name):
                other = await _served_other(services, project, source.id)
                if other is not None:
                    reason = NOT_SERVED_OTHER.format(source=source.name, other=other)
        out.append(
            CapabilityOut(
                project_id=project.id,
                project_name=project.name,
                source_id=source.id,
                source_name=source.name,
                tool=tool,
                reason=reason,
            )
        )
    return out


async def _served_other(services, project, source_id: str) -> str | None:
    """The name of another Prometheus the project links that the Prometheus Operator runs (so
    a rule on it can run in Prometheus); None when there is none, or it can't be told now."""
    for link in project.links:
        if link.source_id == source_id:
            continue
        try:
            other = await services.sources.get(link.source_id)
        except KeyError:
            continue
        if other.type != "prometheus":
            continue
        try:
            capability = await services.capabilities.get(other)
        except CapabilityUnknown:
            continue
        if capability.tool_engine == "prometheus_rule":
            return other.name
    return None


def _probe_rule(
    scope_kind: ScopeKind,
    scope_id: str,
    source_type: Literal["prometheus", "loki"],
    source_id: str | None,
) -> RuleRecord:
    """A rule as `source_for` reads one: only the scope and the source matter."""
    moment = now_utc()
    return RuleRecord(
        id="",
        name="",
        scope_kind=scope_kind,
        scope_id=scope_id,
        source_type=source_type,
        source_id=source_id if scope_kind == "project" else None,
        expr="",
        condition=Condition("each", "above", 0.0, 0, 60),
        severity="warning",
        message="",
        contact_point_ids=(),
        engine="tool",
        channel=None,
        paused=False,
        origin="page",
        dashboard_id=None,
        panel_id=None,
        version=0,
        deleted_at=None,
        created_at=moment,
        updated_at=moment,
    )


@router.get("/channels")
async def channels(project_id: str, request: Request) -> ChannelsOut:
    """The notification channels of the project's Alertmanager (its first linked one), for a
    rule that runs in the tool."""
    services = _services(request)
    try:
        project = await services.projects.get(project_id)
    except UnknownProject:
        raise RuleRefused(404, "unknown_scope", UNKNOWN_SCOPE).http() from None
    for link in project.links:
        try:
            source = await services.sources.get(link.source_id)
        except KeyError:
            continue
        if source.type != "alertmanager":
            continue
        ref = SourceRefOut(id=source.id, name=source.name)
        try:
            found = await read_channels(services.transports.for_source(source), source.name)
        except (ChannelsUnreadable, SourceUnreachable) as exc:
            return ChannelsOut(alertmanager=ref, channels=[], message=exc.message)
        return ChannelsOut(
            alertmanager=ref,
            channels=[
                ChannelOut(
                    receiver=c.receiver, labels=dict(c.labels), usable=c.usable, reason=c.reason
                )
                for c in found
            ],
            message=None,
        )
    return ChannelsOut(alertmanager=None, channels=[], message=NO_ALERTMANAGER)


# -- routes: the dry run -----------------------------------------------------------------------


@router.post("/dry-run")
async def dry_run_route(body: DryRunIn, request: Request) -> DryRunOut:
    """How often the condition would have fired over the window, per project and merged."""
    try:
        return await dry_run(request.app.state.monitoring, body, time.time())
    except DryRunRefused as exc:
        raise HTTPException(
            status_code=exc.status, detail={"code": exc.code, "message": exc.message}
        ) from None


# -- routes: silences --------------------------------------------------------------------------
#
# Silences live in OmniKrux (they mute what OmniKrux checks and tells) or in a linked
# Alertmanager (they mute what the tools send there). Adding or ending one writes its audit record
# first, with no review step ("no audit, no change"); the page asks before it ends one.

SILENCE_GONE = "That silence no longer exists."
ALERTMANAGER_GONE = "That Alertmanager no longer exists."
NEEDS_ALERTMANAGER = "Say which Alertmanager holds the silence."
WHERE_OMNIKRUX_WORDS = "OmniKrux"
WHERE_ALERTMANAGER_WORDS = "Alertmanager · {source}"
EXPIRED_FOR = 24 * 3600
PREVIEW_RULES = 5
CONCURRENT_AM_READS = 8


class OmniKruxWhereIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["omnikrux"]


class AlertmanagerWhereIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["alertmanager"]
    source_id: str = Field(min_length=1)


class SilenceIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    where: OmniKruxWhereIn | AlertmanagerWhereIn = Field(discriminator="kind")
    matchers: str  # parsed by `parse_matchers`; refused in words by `check_silence`
    starts_at: datetime | None = None
    ends_at: datetime
    comment: str  # 1 to 500 characters, refused in words by `check_silence`


class SilenceWhereOut(BaseModel):
    kind: Literal["omnikrux", "alertmanager"]
    source_id: str | None
    source_name: str | None


class SilenceOut(BaseModel):
    id: str
    where: SilenceWhereOut
    matchers: str
    starts_at: datetime
    ends_at: datetime
    comment: str
    created_by: str
    state: Literal["active", "pending", "expired"]
    affects: int | None


class SilenceProblemOut(BaseModel):
    source_name: str
    message: str


class SilencesOut(BaseModel):
    silences: list[SilenceOut]
    problems: list[SilenceProblemOut]


class SilencePreviewOut(BaseModel):
    affects: int
    rules: list[str]


def _silence_error(status: int, code: str, message: str, field: str | None = None) -> HTTPException:
    detail: dict = {"code": code, "message": message}
    if field is not None:
        detail["field"] = field
    return HTTPException(status_code=status, detail=detail)


def _checked(body: SilenceIn, moment: datetime) -> NewSilence:
    """The silence the body asks for; 422 `invalid_silence` in words. Every pattern is guarded
    alike (T7's `pattern_problem`), an Alertmanager's too: OmniKrux matches it itself in a
    preview, in the event loop, against label values cut at 256 characters."""
    try:
        return check_silence(body.matchers, body.starts_at, body.ends_at, body.comment, now=moment)
    except SilenceInvalid as exc:
        raise _silence_error(422, "invalid_silence", exc.message, exc.field) from None


async def _alertmanager(services: MonitoringServices, source_id: str) -> SourceConfig:
    """The Alertmanager source; 404 `not_found` when there is none by that id."""
    try:
        source = await services.sources.get(source_id)
    except KeyError:
        source = None
    if source is None or source.type != "alertmanager":
        raise _silence_error(404, "not_found", ALERTMANAGER_GONE)
    return source


def _am_client(services: MonitoringServices, source: SourceConfig) -> AlertmanagerSilences:
    return AlertmanagerSilences(services.transports.for_source(source), source.name)


async def _linked_alertmanagers(services: MonitoringServices) -> list[SourceConfig]:
    """Every Alertmanager linked to a project, by name."""
    found: dict[str, SourceConfig] = {}
    for project in await services.projects.list():
        for link in project.links:
            if link.source_id in found:
                continue
            try:
                source = await services.sources.get(link.source_id)
            except KeyError:
                continue
            if source.type == "alertmanager":
                found[source.id] = source
    return sorted(found.values(), key=lambda s: (s.name.casefold(), s.id))


async def _checked_instances(
    services: MonitoringServices,
) -> list[tuple[RuleRecord, InstanceRecord]]:
    """The pending and firing instances of every target OmniKrux checks (an OmniKrux silence
    mutes only those), with their rules."""
    alerts = services.alerts
    rules = {r.id: r for r in await alerts.list_rules()}
    found: list[tuple[RuleRecord, InstanceRecord]] = []
    for target in await alerts.targets():
        rule = rules.get(target.rule_id)
        if rule is None or target.engine != "omnikrux" or target.leaving:
            continue
        found += [(rule, i) for i in await alerts.instances(target.id)]
    return found


def _probe_silence(silence: NewSilence) -> Silence:
    return Silence(
        id="",
        matchers=silence.matchers,
        starts_at=silence.starts_at,
        ends_at=silence.ends_at,
        comment=silence.comment,
        created_by="",
        created_at=silence.starts_at,
        expired_at=None,
    )


def _omnikrux_out(s: Silence, moment: datetime, affects: int | None) -> SilenceOut:
    return SilenceOut(
        id=s.id,
        where=SilenceWhereOut(kind="omnikrux", source_id=None, source_name=None),
        matchers=matchers_text(s.matchers),
        starts_at=s.starts_at,
        ends_at=s.ended_at,
        comment=s.comment,
        created_by=s.created_by,
        state=silence_state(s.starts_at, s.ended_at, moment),
        affects=affects,
    )


def _tool_out(s: ToolSilence, source: SourceConfig) -> SilenceOut:
    return SilenceOut(
        id=s.id,
        where=SilenceWhereOut(kind="alertmanager", source_id=source.id, source_name=source.name),
        matchers=matchers_text(s.matchers),
        starts_at=s.starts_at,
        ends_at=s.ends_at,
        comment=s.comment,
        created_by=s.created_by,
        state=s.state,
        affects=None,
    )


@router.get("/silences")
async def list_silences(request: Request) -> SilencesOut:
    """OmniKrux's silences and every linked Alertmanager's, newest first; ended ones only from
    the last 24 hours. An Alertmanager that can't be read is a problem in words; it never hides
    the others. `affects` counts the instances an OmniKrux silence matches now."""
    services = _services(request)
    moment = now_utc()
    since = moment - timedelta(seconds=EXPIRED_FOR)
    instances = await _checked_instances(services)
    out: list[SilenceOut] = []
    for s in await services.silences.list(include_expired_since=since):
        state = silence_state(s.starts_at, s.ended_at, moment)
        affects = (
            None
            if state == "expired"
            else sum(1 for _, i in instances if silence_matches(s, i.labels))
        )
        out.append(_omnikrux_out(s, moment, affects))
    problems: list[SilenceProblemOut] = []
    managers = await _linked_alertmanagers(services)
    slots = asyncio.Semaphore(CONCURRENT_AM_READS)

    async def read(source: SourceConfig) -> list[ToolSilence] | AlertmanagerFailed:
        async with slots:
            try:
                return await _am_client(services, source).list(moment)
            except AlertmanagerFailed as exc:
                return exc

    # At once (bounded), so one Alertmanager that doesn't answer costs one timeout in all.
    for source, held in zip(
        managers, await asyncio.gather(*(read(m) for m in managers)), strict=True
    ):
        if isinstance(held, AlertmanagerFailed):
            problems.append(SilenceProblemOut(source_name=source.name, message=held.message))
            continue
        out += [_tool_out(s, source) for s in held if s.state != "expired" or s.ends_at >= since]
    out.sort(key=lambda s: (s.starts_at, s.id), reverse=True)
    return SilencesOut(silences=out, problems=problems)


@router.post("/silences/preview")
async def preview_silence(body: SilenceIn, request: Request) -> SilencePreviewOut:
    """What the silence would mute now: the active instances it matches (OmniKrux's checks for an
    OmniKrux silence; the Alertmanager's alerts for one there) and the first 5 rules by name."""
    services = _services(request)
    silence = _probe_silence(_checked(body, now_utc()))
    names: set[str] = set()
    affects = 0
    if isinstance(body.where, AlertmanagerWhereIn):
        source = await _alertmanager(services, body.where.source_id)
        try:
            found = await _am_client(services, source).alerts()
        except AlertmanagerFailed as exc:
            raise _silence_error(exc.status, "unreachable", exc.message) from None
        for alert in found:
            labels = alert.get("labels")
            if not isinstance(labels, dict):
                continue
            labels = {str(k): str(v) for k, v in labels.items()}
            if silence_matches(silence, labels):
                affects += 1
                if labels.get("alertname"):
                    names.add(labels["alertname"])
    else:
        for rule, instance in await _checked_instances(services):
            if silence_matches(silence, instance.labels):
                affects += 1
                names.add(rule.name)
    rules = sorted(names, key=lambda n: (n.casefold(), n))[:PREVIEW_RULES]
    return SilencePreviewOut(affects=affects, rules=rules)


@router.post("/silences", status_code=201)
async def add_silence(body: SilenceIn, request: Request) -> SilenceOut:
    """Add a silence in OmniKrux or in the Alertmanager named (created by "OmniKrux" there). Its
    audit record is written first; an Alertmanager's refusal passes through in its words."""
    services = _services(request)
    moment = now_utc()
    silence = _checked(body, moment)
    source: SourceConfig | None = None
    if isinstance(body.where, AlertmanagerWhereIn):
        source = await _alertmanager(services, body.where.source_id)
    text = matchers_text(silence.matchers)
    where_words = (
        WHERE_ALERTMANAGER_WORDS.format(source=source.name)
        if source is not None
        else WHERE_OMNIKRUX_WORDS
    )
    record = await begin_change(
        request,
        "silence_add",
        "silence",
        text,
        {"where": where_words, "matchers": text, "ends_at": silence.ends_at.isoformat()},
    )
    if source is None:
        try:
            stored = await services.silences.create(
                silence.matchers,
                silence.starts_at,
                silence.ends_at,
                silence.comment,
                actor_of(request),
            )
        except SilenceInvalid as exc:
            await finish_change(request, record, False, exc.message)
            raise _silence_error(422, "invalid_silence", exc.message, exc.field) from None
        except Exception:
            await finish_change(request, record, False, NOT_SAVED_SILENCE)
            raise
        await finish_change(request, record, True)
        instances = await _checked_instances(services)
        affects = sum(1 for _, i in instances if silence_matches(stored, i.labels))
        return _omnikrux_out(stored, now_utc(), affects)
    try:
        silence_id = await _am_client(services, source).create(silence)
    except AlertmanagerFailed as exc:
        await request.app.state.audit.finish(
            record, "unknown" if exc.unknown else "failed", exc.message
        )
        code = "refused" if exc.status == 422 else "unreachable"
        raise _silence_error(exc.status, code, exc.message) from None
    await finish_change(request, record, True)
    return SilenceOut(
        id=silence_id,
        where=SilenceWhereOut(kind="alertmanager", source_id=source.id, source_name=source.name),
        matchers=text,
        starts_at=silence.starts_at,
        ends_at=silence.ends_at,
        comment=silence.comment,
        created_by=CREATED_BY,
        state=silence_state(silence.starts_at, silence.ends_at, now_utc()),
        affects=None,
    )


@router.delete("/silences/{kind}/{id}", status_code=204)
async def remove_silence(
    kind: Literal["omnikrux", "alertmanager"],
    id: str,
    request: Request,
    source_id: str | None = None,
) -> Response:
    """End a silence now: OmniKrux's is expired (it stays listed for a day), an Alertmanager's is
    expired there. Its audit record is written first."""
    services = _services(request)
    if kind == "omnikrux":
        try:
            held = await services.silences.get(id)
        except UnknownSilence:
            raise _silence_error(404, "not_found", SILENCE_GONE) from None
        text = matchers_text(held.matchers)
        record = await begin_change(
            request,
            "silence_remove",
            "silence",
            text,
            {"where": WHERE_OMNIKRUX_WORDS, "matchers": text},
        )
        try:
            await services.silences.expire(id, now_utc())
        except UnknownSilence:
            await finish_change(request, record, False, SILENCE_GONE)
            raise _silence_error(404, "not_found", SILENCE_GONE) from None
        except Exception:
            await finish_change(request, record, False, NOT_REMOVED_SILENCE)
            raise
        await finish_change(request, record, True)
        return Response(status_code=204)
    if not source_id:
        raise _silence_error(422, "invalid_silence", NEEDS_ALERTMANAGER, "source_id")
    source = await _alertmanager(services, source_id)
    client = _am_client(services, source)
    # The silence is looked up first: an id it doesn't hold answers 404 with no audit record.
    try:
        held = await client.find(id, now_utc())
    except AlertmanagerFailed as exc:
        code = {404: "not_found", 422: "refused"}.get(exc.status, "unreachable")
        raise _silence_error(exc.status, code, exc.message) from None
    text = matchers_text(held.matchers)
    record = await begin_change(
        request,
        "silence_remove",
        "silence",
        text,
        {"where": WHERE_ALERTMANAGER_WORDS.format(source=source.name), "matchers": text},
    )
    try:
        await client.expire(id)
    except AlertmanagerFailed as exc:
        await request.app.state.audit.finish(
            record, "unknown" if exc.unknown else "failed", exc.message
        )
        code = {404: "not_found", 422: "refused"}.get(exc.status, "unreachable")
        raise _silence_error(exc.status, code, exc.message) from None
    await finish_change(request, record, True)
    return Response(status_code=204)
