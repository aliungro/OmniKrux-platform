"""Alert rules on disk, with where each runs (its targets), the series that are pending or firing
(instances) and what happened (history, bounded by `prune`).

A rule is versioned: every change that alters what the rule says writes the next version, and a
change that names the version it started from is refused (`RuleChanged`) when another landed
since. A rule's targets are one per project of its scope; `put_targets` brings them in line with
what the rule wants now and says what changed.

Every write runs in its own transaction and commits, unless the caller passes its `session`
(then the caller commits once, at the end of its operation)."""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any, Literal

from sqlalchemy import Select, delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from omnikrux.monitoring.alerts.types import (
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
)
from omnikrux.monitoring.models import (
    AlertHistoryRow,
    AlertInstanceRow,
    AlertRuleRow,
    AlertTargetRow,
    DashboardRow,
    DeliveryRow,
    SilenceRow,
    lock_first,
    now,
    utc,
    writing,
)

HistoryKind = Literal[
    "firing",
    "resolved",
    "cant_check",
    "checking_again",
    "error",
    "applied",
    "apply_failed",
    "removed",
]
Origin = Literal["page", "panel"]

# How much history and how many deliveries are kept (`AlertStore.prune`).
KEEP_FOR = timedelta(days=7)
HISTORY_PER_TARGET = 500
HISTORY_TOTAL = 20_000
DELIVERIES_TOTAL = 5000

# What a target that runs in a tool says until the tool's state is first read: never "OK".
LOADING = "Loading in {tool}…"
TOOL_WORDS = {"prometheus_rule": "Prometheus", "loki_ruler": "Loki"}

RULE_CHANGED = (
    "This rule was changed somewhere else since you opened it (version {current}). Open it again."
)


class UnknownRule(KeyError):
    pass


class UnknownTarget(KeyError):
    pass


class RuleChanged(Exception):
    """The rule is no longer at the version the change started from; nothing changed."""

    def __init__(self, current: int) -> None:
        super().__init__(RULE_CHANGED.format(current=current))
        self.current = current


# -- records -----------------------------------------------------------------------------------


@dataclass(frozen=True)
class RuleSpec:
    """Everything a caller sets on a rule."""

    name: str
    scope_kind: ScopeKind
    scope_id: str
    source_type: Literal["prometheus", "loki"]
    source_id: str | None
    expr: str
    condition: Condition
    severity: Severity = "warning"
    message: str = ""
    contact_point_ids: tuple[str, ...] = ()
    engine: Engine = "omnikrux"
    channel: ChannelPick | None = None
    origin: Origin = "page"
    dashboard_id: str | None = None
    panel_id: str | None = None


@dataclass(frozen=True)
class RuleRecord:
    id: str
    name: str
    scope_kind: ScopeKind
    scope_id: str
    source_type: Literal["prometheus", "loki"]
    source_id: str | None
    expr: str
    condition: Condition
    severity: Severity
    message: str
    contact_point_ids: tuple[str, ...]
    engine: Engine
    channel: ChannelPick | None
    paused: bool
    origin: Origin
    dashboard_id: str | None
    panel_id: str | None
    version: int
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class RuleRef:
    """A rule named in a review (frozen: it enters the review's token)."""

    id: str
    name: str


@dataclass(frozen=True)
class ToolObject:
    """The object that holds a target's rule in its tool: a PrometheusRule in a cluster, or a
    Loki ruler group."""

    kind: ToolKind
    source_id: str
    cluster_id: str | None
    namespace: str
    name: str


@dataclass(frozen=True)
class TargetSpec:
    """Where and how a rule runs for one project."""

    project_id: str
    engine: Engine
    engine_note: str | None
    source_id: str | None
    eval_expr: str
    rule_text: str
    tool_kind: ToolKind | None = None


@dataclass(frozen=True)
class TargetRecord:
    id: str
    rule_id: str
    project_id: str
    engine: Engine
    engine_note: str | None
    source_id: str | None
    eval_expr: str
    rule_text: str
    state: TargetState
    state_since: datetime
    message: str | None
    last_eval_at: datetime | None
    next_eval_at: datetime | None
    failures: int
    tool_kind: ToolKind | None
    tool_object: ToolObject | None
    tool_state: ToolState | None
    tool_message: str | None
    applied_version: int | None
    leaving: bool
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class TargetDiff:
    """What `put_targets` did: targets added and changed, and every target now leaving."""

    added: tuple[str, ...] = ()
    changed: tuple[str, ...] = ()
    leaving: tuple[str, ...] = ()


@dataclass(frozen=True)
class InstanceRecord:
    target_id: str
    fingerprint: str
    labels: Mapping[str, str]
    state: Literal["pending", "firing"]
    active_since: datetime
    fired_at: datetime | None
    value: float | None
    last_notified_at: datetime | None
    silenced: bool = False


@dataclass(frozen=True)
class HistoryRecord:
    """`id` is None until the entry is stored. `project_id` is the target's project: the entry
    still names it once the target is gone."""

    id: int | None
    target_id: str
    rule_id: str
    project_id: str
    at: datetime
    kind: HistoryKind
    labels: Mapping[str, str] | None = field(default=None)
    value: float | None = None
    message: str | None = None


class _Keep:
    """A value left as it is (`AlertStore.set_tool`)."""


KEEP: Any = _Keep()


# -- rows to records ---------------------------------------------------------------------------


def _channel_text(channel: ChannelPick | None) -> str | None:
    if channel is None:
        return None
    return json.dumps(
        {"receiver": channel.receiver, "labels": dict(channel.labels)}, sort_keys=True
    )


def _channel(text: str | None) -> ChannelPick | None:
    if text is None:
        return None
    values = json.loads(text)
    return ChannelPick(receiver=values["receiver"], labels=dict(values["labels"]))


def _rule_values(spec: RuleSpec) -> dict[str, Any]:
    """The columns a spec sets, as stored."""
    cond = spec.condition
    return {
        "name": spec.name,
        "scope_kind": spec.scope_kind,
        "scope_id": spec.scope_id,
        "source_type": spec.source_type,
        "source_id": spec.source_id,
        "expr": spec.expr,
        "cond_of": cond.of,
        "cond_op": cond.op,
        "threshold": float(cond.threshold),
        "for_seconds": cond.for_seconds,
        "every_seconds": cond.every_seconds,
        "severity": spec.severity,
        "message": spec.message,
        "contact_point_ids": json.dumps(list(spec.contact_point_ids)),
        "engine": spec.engine,
        "channel": _channel_text(spec.channel),
        "origin": spec.origin,
        "dashboard_id": spec.dashboard_id,
        "panel_id": spec.panel_id,
    }


def _rule(row: AlertRuleRow) -> RuleRecord:
    of: Of = row.cond_of  # type: ignore[assignment]
    op: Op = row.cond_op  # type: ignore[assignment]
    return RuleRecord(
        id=row.id,
        name=row.name,
        scope_kind=row.scope_kind,  # type: ignore[arg-type]
        scope_id=row.scope_id,
        source_type=row.source_type,  # type: ignore[arg-type]
        source_id=row.source_id,
        expr=row.expr,
        condition=Condition(
            of=of,
            op=op,
            threshold=row.threshold,
            for_seconds=row.for_seconds,
            every_seconds=row.every_seconds,
        ),
        severity=row.severity,  # type: ignore[arg-type]
        message=row.message,
        contact_point_ids=tuple(json.loads(row.contact_point_ids)),
        engine=row.engine,  # type: ignore[arg-type]
        channel=_channel(row.channel),
        paused=bool(row.paused),
        origin=row.origin,  # type: ignore[arg-type]
        dashboard_id=row.dashboard_id,
        panel_id=row.panel_id,
        version=row.version,
        deleted_at=utc(row.deleted_at),
        created_at=utc(row.created_at),
        updated_at=utc(row.updated_at),
    )


def _tool_object_text(obj: ToolObject | None) -> str | None:
    if obj is None:
        return None
    return json.dumps(
        {
            "kind": obj.kind,
            "source_id": obj.source_id,
            "cluster_id": obj.cluster_id,
            "namespace": obj.namespace,
            "name": obj.name,
        }
    )


def _tool_object(text: str | None) -> ToolObject | None:
    if text is None:
        return None
    values = json.loads(text)
    return ToolObject(
        kind=values["kind"],
        source_id=values["source_id"],
        cluster_id=values["cluster_id"],
        namespace=values["namespace"],
        name=values["name"],
    )


def _target(row: AlertTargetRow) -> TargetRecord:
    return TargetRecord(
        id=row.id,
        rule_id=row.rule_id,
        project_id=row.project_id,
        engine=row.engine,  # type: ignore[arg-type]
        engine_note=row.engine_note,
        source_id=row.source_id,
        eval_expr=row.eval_expr,
        rule_text=row.rule_text,
        state=row.state,  # type: ignore[arg-type]
        state_since=utc(row.state_since),
        message=row.message,
        last_eval_at=utc(row.last_eval_at),
        next_eval_at=utc(row.next_eval_at),
        failures=row.failures,
        tool_kind=row.tool_kind,  # type: ignore[arg-type]
        tool_object=_tool_object(row.tool_object),
        tool_state=row.tool_state,  # type: ignore[arg-type]
        tool_message=row.tool_message,
        applied_version=row.applied_version,
        leaving=bool(row.leaving),
        created_at=utc(row.created_at),
        updated_at=utc(row.updated_at),
    )


def _target_values(spec: TargetSpec) -> dict[str, Any]:
    return {
        "engine": spec.engine,
        "engine_note": spec.engine_note,
        "source_id": spec.source_id,
        "eval_expr": spec.eval_expr,
        "rule_text": spec.rule_text,
        "tool_kind": spec.tool_kind,
    }


def _instance(row: AlertInstanceRow) -> InstanceRecord:
    return InstanceRecord(
        target_id=row.target_id,
        fingerprint=row.fingerprint,
        labels=json.loads(row.labels),
        state=row.state,  # type: ignore[arg-type]
        active_since=utc(row.active_since),
        fired_at=utc(row.fired_at),
        value=row.value,
        last_notified_at=utc(row.last_notified_at),
        silenced=bool(row.silenced),
    )


def _history(row: AlertHistoryRow) -> HistoryRecord:
    return HistoryRecord(
        id=row.id,
        target_id=row.target_id,
        rule_id=row.rule_id,
        project_id=row.project_id,
        at=utc(row.at),
        kind=row.kind,  # type: ignore[arg-type]
        labels=json.loads(row.labels) if row.labels is not None else None,
        value=row.value,
        message=row.message,
    )


def _by_name(rules: list[RuleRecord]) -> list[RuleRecord]:
    return sorted(rules, key=lambda r: (r.name.casefold(), r.id))


def _refs(rows: Sequence[tuple[str, str]]) -> tuple[RuleRef, ...]:
    unique = {id: name for id, name in rows}
    return tuple(
        sorted(
            (RuleRef(id, name) for id, name in unique.items()),
            key=lambda r: (r.name.casefold(), r.id),
        )
    )


def loading_copy(tool_kind: str | None) -> str:
    return LOADING.format(tool=TOOL_WORDS.get(tool_kind or "", "the tool"))


def mark_unread(row: AlertTargetRow, moment: datetime) -> None:
    """A target that runs in a tool and whose state was never read from it is "waiting" with
    `Loading in {tool}…`, never "OK" (`put_targets`, and both tools' apply)."""
    if row.engine != "tool" or row.last_eval_at is not None:
        return
    if row.state != "waiting":
        row.state = "waiting"
        row.state_since = moment
    row.message = loading_copy(row.tool_kind)


async def _rule_row(session: AsyncSession, id: str) -> AlertRuleRow:
    row = await session.get(AlertRuleRow, id)
    if row is None:
        raise UnknownRule(id)
    return row


async def _live_rule_row(session: AsyncSession, id: str) -> AlertRuleRow:
    """The rule, unless it is deleted (being removed): UnknownRule then too."""
    row = await _rule_row(session, id)
    if row.deleted_at is not None:
        raise UnknownRule(id)
    return row


async def _target_row(session: AsyncSession, id: str) -> AlertTargetRow:
    row = await session.get(AlertTargetRow, id)
    if row is None:
        raise UnknownTarget(id)
    return row


async def _delete_targets(session: AsyncSession, ids: Sequence[str]) -> None:
    """Targets and their instances; their history stays until `prune` (or the rule) takes it."""
    if not ids:
        return
    await session.execute(delete(AlertInstanceRow).where(AlertInstanceRow.target_id.in_(ids)))
    await session.execute(delete(AlertTargetRow).where(AlertTargetRow.id.in_(ids)))


class AlertStore:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sessionmaker = sessionmaker

    # -- rules: reading ------------------------------------------------------------------------

    async def list_rules(
        self,
        *,
        scope_kind: ScopeKind | None = None,
        scope_id: str | None = None,
        include_deleted: bool = False,
    ) -> list[RuleRecord]:
        """Every rule, or a scope kind's, or one scope's; by name (any case). Deleted rules
        (still removing their targets) only with `include_deleted`."""
        query = select(AlertRuleRow)
        if scope_kind is not None:
            query = query.where(AlertRuleRow.scope_kind == scope_kind)
        if scope_id is not None:
            query = query.where(AlertRuleRow.scope_id == scope_id)
        if not include_deleted:
            query = query.where(AlertRuleRow.deleted_at.is_(None))
        async with self._sessionmaker() as session:
            rows = await session.scalars(query)
            return _by_name([_rule(row) for row in rows])

    async def get_rule(self, id: str) -> RuleRecord:
        """The rule, deleted or not. UnknownRule."""
        async with self._sessionmaker() as session:
            return _rule(await _rule_row(session, id))

    async def rule_for_panel(self, dashboard_id: str, panel_id: str) -> RuleRecord | None:
        """The (not deleted) rule that belongs to that panel, if any."""
        async with self._sessionmaker() as session:
            row = await session.scalar(
                select(AlertRuleRow)
                .where(
                    AlertRuleRow.dashboard_id == dashboard_id,
                    AlertRuleRow.panel_id == panel_id,
                    AlertRuleRow.deleted_at.is_(None),
                )
                .order_by(AlertRuleRow.created_at)
                .limit(1)
            )
            return _rule(row) if row is not None else None

    async def rules_for_dashboard(self, dashboard_id: str) -> list[RuleRecord]:
        """The (not deleted) rules of that dashboard's panels, oldest first."""
        async with self._sessionmaker() as session:
            rows = await session.scalars(
                select(AlertRuleRow)
                .where(
                    AlertRuleRow.dashboard_id == dashboard_id,
                    AlertRuleRow.deleted_at.is_(None),
                )
                .order_by(AlertRuleRow.created_at, AlertRuleRow.id)
            )
            return [_rule(row) for row in rows]

    # -- rules: writing ------------------------------------------------------------------------

    async def create_rule(
        self, spec: RuleSpec, *, session: AsyncSession | None = None
    ) -> RuleRecord:
        """A new rule at version 1, not paused."""
        moment = now()
        row = AlertRuleRow(
            id=uuid.uuid4().hex,
            **_rule_values(spec),
            paused=False,
            version=1,
            deleted_at=None,
            created_at=moment,
            updated_at=moment,
        )
        async with writing(self._sessionmaker, session) as s:
            s.add(row)
            await s.flush()
            return _rule(row)

    async def update_rule(
        self,
        id: str,
        spec: RuleSpec,
        *,
        base_version: int | None,
        session: AsyncSession | None = None,
    ) -> RuleRecord:
        """Write `spec` as the next version when something changed (else the rule stays at its
        version). With `base_version`, the rule must still be at it. UnknownRule, RuleChanged
        (nothing changed). A deleted rule reads as UnknownRule."""
        values = _rule_values(spec)
        async with self._locked(session) as s:
            row = await _live_rule_row(s, id)
            current = row.version
            if base_version is not None and current != base_version:
                raise RuleChanged(current)
            if all(getattr(row, key) == value for key, value in values.items()):
                return _rule(row)
            result = await s.execute(
                update(AlertRuleRow)
                .where(AlertRuleRow.id == id, AlertRuleRow.version == current)
                .values(**values, version=AlertRuleRow.version + 1, updated_at=now())
                .execution_options(synchronize_session=False)
            )
            if result.rowcount == 0:
                await s.refresh(row)
                raise RuleChanged(row.version)
            await s.refresh(row)
            return _rule(row)

    async def set_paused(self, id: str, paused: bool) -> RuleRecord:
        """Pause or resume the rule (its version stays: what the rule says is unchanged).
        UnknownRule."""
        async with self._sessionmaker.begin() as session:
            row = await _rule_row(session, id)
            if bool(row.paused) != paused:
                row.paused = paused
                row.updated_at = now()
            await session.flush()
            return _rule(row)

    async def detach_rule(self, id: str, *, session: AsyncSession | None = None) -> RuleRecord:
        """The rule no longer belongs to a panel: a page rule from now on, at its next version.
        UnknownRule."""
        async with self._locked(session) as s:
            row = await _rule_row(s, id)
            if row.origin != "page" or row.dashboard_id is not None or row.panel_id is not None:
                row.origin = "page"
                row.dashboard_id = None
                row.panel_id = None
                row.version = row.version + 1
                row.updated_at = now()
            await s.flush()
            return _rule(row)

    async def attach_rule(
        self, id: str, dashboard_id: str, panel_id: str, *, session: AsyncSession | None = None
    ) -> RuleRecord:
        """The page rule becomes that panel's rule, at its next version. UnknownRule (deleted
        too); ValueError when it already belongs to a panel."""
        async with self._locked(session) as s:
            row = await _live_rule_row(s, id)
            if row.origin != "page" or row.dashboard_id is not None or row.panel_id is not None:
                raise ValueError("The rule already belongs to a panel.")
            row.origin = "panel"
            row.dashboard_id = dashboard_id
            row.panel_id = panel_id
            row.version = row.version + 1
            row.updated_at = now()
            await s.flush()
            return _rule(row)

    async def tombstone_rule(self, id: str, *, session: AsyncSession | None = None) -> None:
        """Mark the rule deleted; it stays (out of `list_rules`) until `purge_rule` removes it
        once its targets are gone. UnknownRule."""
        async with self._locked(session) as s:
            row = await _rule_row(s, id)
            if row.deleted_at is None:
                row.deleted_at = now()
                row.updated_at = row.deleted_at

    async def purge_rule(self, id: str, *, session: AsyncSession | None = None) -> bool:
        """Remove the rule and its history when it has no targets left; whether it was removed.
        UnknownRule."""
        async with self._locked(session) as s:
            await _rule_row(s, id)
            left = await s.scalar(
                select(func.count()).select_from(AlertTargetRow).where(AlertTargetRow.rule_id == id)
            )
            if left:
                return False
            await s.execute(delete(AlertHistoryRow).where(AlertHistoryRow.rule_id == id))
            await s.execute(delete(AlertRuleRow).where(AlertRuleRow.id == id))
            return True

    # -- targets -------------------------------------------------------------------------------

    async def targets(
        self, *, rule_id: str | None = None, project_id: str | None = None
    ) -> list[TargetRecord]:
        """Every target, or a rule's, or a project's; oldest first."""
        query = select(AlertTargetRow)
        if rule_id is not None:
            query = query.where(AlertTargetRow.rule_id == rule_id)
        if project_id is not None:
            query = query.where(AlertTargetRow.project_id == project_id)
        query = query.order_by(AlertTargetRow.created_at, AlertTargetRow.id)
        async with self._sessionmaker() as session:
            return [_target(row) for row in await session.scalars(query)]

    async def get_target(self, id: str) -> TargetRecord:
        async with self._sessionmaker() as session:
            return _target(await _target_row(session, id))

    async def put_targets(
        self, rule_id: str, specs: Sequence[TargetSpec], *, session: AsyncSession | None = None
    ) -> TargetDiff:
        """Bring the rule's targets in line with `specs` (one per project): a new project gets a
        target (state "ok", checked at once), a changed one is updated (and checked at once;
        a leaving one that is wanted again stays), and the targets of projects no longer
        wanted are marked leaving; the caller removes them. A target whose engine or source
        changes starts over: state "ok", no failures, no instances (nothing stale stays shown).

        UnknownRule; for a deleted rule too, unless `specs` is empty (that only marks its
        targets leaving). ValueError when two specs name one project."""
        projects = [spec.project_id for spec in specs]
        if len(set(projects)) != len(projects):
            raise ValueError("Each project can have only one target per rule.")
        moment = now()
        added: list[str] = []
        changed: list[str] = []
        restarted: list[str] = []
        async with self._locked(session) as s:
            if specs:
                await _live_rule_row(s, rule_id)
            else:
                await _rule_row(s, rule_id)
            rows = list(
                await s.scalars(
                    select(AlertTargetRow)
                    .where(AlertTargetRow.rule_id == rule_id)
                    .order_by(AlertTargetRow.created_at, AlertTargetRow.id)
                )
            )
            by_project = {row.project_id: row for row in rows}
            wanted = set()
            for spec in specs:
                wanted.add(spec.project_id)
                values = _target_values(spec)
                row = by_project.get(spec.project_id)
                if row is None:
                    row = AlertTargetRow(
                        id=uuid.uuid4().hex,
                        rule_id=rule_id,
                        project_id=spec.project_id,
                        **values,
                        state="ok",
                        state_since=moment,
                        message=None,
                        last_eval_at=None,
                        next_eval_at=None,
                        failures=0,
                        tool_object=None,
                        tool_state=None,
                        tool_message=None,
                        applied_version=None,
                        leaving=False,
                        created_at=moment,
                        updated_at=moment,
                    )
                    mark_unread(row, moment)
                    s.add(row)
                    by_project[spec.project_id] = row
                    added.append(row.id)
                    continue
                if row.leaving or any(getattr(row, k) != v for k, v in values.items()):
                    if row.engine != spec.engine or row.source_id != spec.source_id:
                        row.state = "ok"
                        row.state_since = moment
                        row.message = None
                        row.last_eval_at = None
                        row.failures = 0
                        restarted.append(row.id)
                    for key, value in values.items():
                        setattr(row, key, value)
                    mark_unread(row, moment)
                    row.leaving = False
                    row.next_eval_at = None
                    row.updated_at = moment
                    changed.append(row.id)
            leaving: list[str] = []
            for row in rows:
                if row.project_id in wanted:
                    continue
                if not row.leaving:
                    row.leaving = True
                    row.updated_at = moment
                leaving.append(row.id)
            if restarted:
                await s.execute(
                    delete(AlertInstanceRow).where(AlertInstanceRow.target_id.in_(restarted))
                )
            await s.flush()
        return TargetDiff(added=tuple(added), changed=tuple(changed), leaving=tuple(leaving))

    async def delete_target(self, id: str, *, session: AsyncSession | None = None) -> None:
        """Remove the target and its instances. UnknownTarget."""
        async with writing(self._sessionmaker, session) as s:
            await _target_row(s, id)
            await _delete_targets(s, [id])

    async def set_eval(
        self,
        target_id: str,
        *,
        state: TargetState,
        message: str | None,
        at: datetime,
        next_eval_at: datetime | None,
        failures: int,
        session: AsyncSession | None = None,
    ) -> None:
        """Record a check's result; `state_since` moves only when the state changes.
        UnknownTarget."""
        async with writing(self._sessionmaker, session) as s:
            row = await _target_row(s, target_id)
            if row.state != state:
                row.state = state
                row.state_since = at
            row.message = message
            row.last_eval_at = at
            row.next_eval_at = next_eval_at
            row.failures = failures
            row.updated_at = now()

    async def set_tool(
        self,
        target_id: str,
        *,
        tool_state: ToolState | None,
        tool_message: str | None,
        tool_object: ToolObject | None = KEEP,
        applied_version: int | None = KEEP,
        session: AsyncSession | None = None,
    ) -> TargetRecord:
        """Record where the target stands in its tool; `tool_object` and `applied_version` stay
        as they are unless given (None clears them). UnknownTarget."""
        async with writing(self._sessionmaker, session) as s:
            row = await _target_row(s, target_id)
            row.tool_state = tool_state
            row.tool_message = tool_message
            if tool_object is not KEEP:
                row.tool_object = _tool_object_text(tool_object)
            if applied_version is not KEEP:
                row.applied_version = applied_version
            row.updated_at = now()
            await s.flush()
            return _target(row)

    async def due_targets(self, now: datetime) -> list[TargetRecord]:
        """The targets OmniKrux checks that are due at `now`: not leaving, of a rule neither
        paused nor deleted, never checked or with `next_eval_at` at or before `now`. Those never
        checked first, then the longest overdue."""
        query = (
            select(AlertTargetRow)
            .join(AlertRuleRow, AlertRuleRow.id == AlertTargetRow.rule_id)
            .where(
                AlertTargetRow.engine == "omnikrux",
                AlertTargetRow.leaving.is_(False),
                AlertRuleRow.paused.is_(False),
                AlertRuleRow.deleted_at.is_(None),
                or_(AlertTargetRow.next_eval_at.is_(None), AlertTargetRow.next_eval_at <= now),
            )
            .order_by(
                AlertTargetRow.next_eval_at.is_not(None),
                AlertTargetRow.next_eval_at,
                AlertTargetRow.id,
            )
        )
        async with self._sessionmaker() as session:
            return [_target(row) for row in await session.scalars(query)]

    # -- instances and history -----------------------------------------------------------------

    async def instances(self, target_id: str) -> list[InstanceRecord]:
        """The target's pending and firing series, by fingerprint."""
        async with self._sessionmaker() as session:
            rows = await session.scalars(
                select(AlertInstanceRow)
                .where(AlertInstanceRow.target_id == target_id)
                .order_by(AlertInstanceRow.fingerprint)
            )
            return [_instance(row) for row in rows]

    async def replace_instances(
        self,
        target_id: str,
        items: Sequence[InstanceRecord],
        *,
        session: AsyncSession | None = None,
    ) -> None:
        """The target's instances become `items` (each item's own `target_id` is ignored)."""
        async with writing(self._sessionmaker, session) as s:
            await s.execute(delete(AlertInstanceRow).where(AlertInstanceRow.target_id == target_id))
            s.add_all(
                AlertInstanceRow(
                    target_id=target_id,
                    fingerprint=item.fingerprint,
                    labels=json.dumps(dict(item.labels), sort_keys=True),
                    state=item.state,
                    active_since=item.active_since,
                    fired_at=item.fired_at,
                    value=item.value,
                    last_notified_at=item.last_notified_at,
                    silenced=item.silenced,
                )
                for item in items
            )
            await s.flush()

    async def add_history(
        self, entries: Sequence[HistoryRecord], *, session: AsyncSession | None = None
    ) -> None:
        """Append entries (their `id` is ignored: the store numbers them)."""
        if not entries:
            return
        async with writing(self._sessionmaker, session) as s:
            s.add_all(
                AlertHistoryRow(
                    target_id=e.target_id,
                    rule_id=e.rule_id,
                    project_id=e.project_id,
                    at=e.at,
                    kind=e.kind,
                    labels=(
                        json.dumps(dict(e.labels), sort_keys=True) if e.labels is not None else None
                    ),
                    value=e.value,
                    message=e.message,
                )
                for e in entries
            )
            await s.flush()

    async def history(
        self, *, rule_id: str, project_id: str | None = None, limit: int = 50
    ) -> list[HistoryRecord]:
        """The rule's history, or its history in one project, newest first."""
        query = select(AlertHistoryRow).where(AlertHistoryRow.rule_id == rule_id)
        if project_id is not None:
            query = query.where(AlertHistoryRow.project_id == project_id)
        async with self._sessionmaker() as session:
            rows = await session.scalars(
                query.order_by(AlertHistoryRow.at.desc(), AlertHistoryRow.id.desc()).limit(limit)
            )
            return [_history(row) for row in rows]

    async def prune(self, now: datetime) -> int:
        """Drop history older than 7 days, then the oldest beyond 500 per target and beyond
        20 000 in all; drop deliveries older than 7 days, then the oldest beyond 5000; drop
        silences that ended (or were expired) more than 7 days ago. How many rows went."""
        cutoff = now - KEEP_FOR
        removed = 0
        async with self._sessionmaker.begin() as session:
            removed += await _delete_count(
                session, delete(AlertHistoryRow).where(AlertHistoryRow.at < cutoff)
            )
            ranked = select(
                AlertHistoryRow.id,
                func.row_number()
                .over(
                    partition_by=AlertHistoryRow.target_id,
                    order_by=(AlertHistoryRow.at.desc(), AlertHistoryRow.id.desc()),
                )
                .label("n"),
            ).subquery()
            removed += await _delete_count(
                session,
                delete(AlertHistoryRow).where(
                    AlertHistoryRow.id.in_(
                        select(ranked.c.id).where(ranked.c.n > HISTORY_PER_TARGET)
                    )
                ),
            )
            removed += await _delete_count(
                session,
                delete(AlertHistoryRow).where(
                    AlertHistoryRow.id.in_(
                        _beyond(
                            select(AlertHistoryRow.id).order_by(
                                AlertHistoryRow.at.desc(), AlertHistoryRow.id.desc()
                            ),
                            HISTORY_TOTAL,
                        )
                    )
                ),
            )
            removed += await _delete_count(
                session, delete(DeliveryRow).where(DeliveryRow.at < cutoff)
            )
            removed += await _delete_count(
                session,
                delete(DeliveryRow).where(
                    DeliveryRow.id.in_(
                        _beyond(
                            select(DeliveryRow.id).order_by(
                                DeliveryRow.at.desc(), DeliveryRow.id.desc()
                            ),
                            DELIVERIES_TOTAL,
                        )
                    )
                ),
            )
            removed += await _delete_count(
                session,
                delete(SilenceRow).where(
                    or_(
                        SilenceRow.expired_at < cutoff,
                        SilenceRow.expired_at.is_(None) & (SilenceRow.ends_at < cutoff),
                    )
                ),
            )
        return removed

    # -- owners --------------------------------------------------------------------------------

    async def rule_refs(
        self, kind: ScopeKind, id: str, *, session: AsyncSession
    ) -> tuple[tuple[RuleRef, ...], tuple[RuleRef, ...]]:
        """(alert_rules, cluster_rules) for an owner's delete review, read in the caller's
        session (a delete recomputes them in its own transaction). `alert_rules`: the rules that
        go with the owner (its own and its dashboards' panel rules, deleted ones still removing
        included). `cluster_rules`: rules with a target of the owner that is applied in a
        cluster (a PrometheusRule): those have to be removed first, each through its review."""
        owned = await self._owned_rule_rows(session, kind, id)
        alert_rules = _refs([(row.id, row.name) for row in owned])
        applied = (
            select(AlertRuleRow.id, AlertRuleRow.name)
            .join(AlertTargetRow, AlertTargetRow.rule_id == AlertRuleRow.id)
            .where(
                AlertTargetRow.tool_kind == "prometheus_rule",
                AlertTargetRow.applied_version.is_not(None),
            )
        )
        if kind == "project":
            applied = applied.where(AlertTargetRow.project_id == id)
        else:
            applied = applied.where(AlertRuleRow.id.in_([row.id for row in owned]))
        cluster_rules = _refs([(rid, name) for rid, name in await session.execute(applied)])
        return alert_rules, cluster_rules

    async def delete_owned(
        self, kind: ScopeKind, id: str, *, session: AsyncSession
    ) -> list[RuleRef]:
        """Inside the owner's delete transaction (`session`; it commits): delete the owner's
        rules (its own and its dashboards' panel rules) with their targets, instances and
        history, and, for a project, its targets in other (group) rules. Call it before the
        dashboards' `delete_owned`. Returns the rules deleted."""
        owned = await self._owned_rule_rows(session, kind, id)
        rule_ids = [row.id for row in owned]
        target_ids: list[str] = []
        if rule_ids:
            target_ids += list(
                await session.scalars(
                    select(AlertTargetRow.id).where(AlertTargetRow.rule_id.in_(rule_ids))
                )
            )
        if kind == "project":
            target_ids += list(
                await session.scalars(
                    select(AlertTargetRow.id).where(AlertTargetRow.project_id == id)
                )
            )
        target_ids = sorted(set(target_ids))
        if target_ids:
            await session.execute(
                delete(AlertHistoryRow).where(AlertHistoryRow.target_id.in_(target_ids))
            )
            await _delete_targets(session, target_ids)
        if kind == "project":
            # Its history in other rules too, also of targets removed earlier.
            await session.execute(delete(AlertHistoryRow).where(AlertHistoryRow.project_id == id))
        if rule_ids:
            await session.execute(
                delete(AlertHistoryRow).where(AlertHistoryRow.rule_id.in_(rule_ids))
            )
            await session.execute(delete(AlertRuleRow).where(AlertRuleRow.id.in_(rule_ids)))
        return list(_refs([(row.id, row.name) for row in owned]))

    async def _owned_rule_rows(
        self, session: AsyncSession, kind: ScopeKind, id: str
    ) -> list[AlertRuleRow]:
        dashboards = select(DashboardRow.id).where(
            DashboardRow.owner_kind == kind, DashboardRow.owner_id == id
        )
        rows = await session.scalars(
            select(AlertRuleRow).where(
                or_(
                    (AlertRuleRow.scope_kind == kind) & (AlertRuleRow.scope_id == id),
                    AlertRuleRow.dashboard_id.in_(dashboards),
                )
            )
        )
        return list(rows)

    # -- sessions ------------------------------------------------------------------------------

    @asynccontextmanager
    async def _locked(self, session: AsyncSession | None) -> AsyncIterator[AsyncSession]:
        """The caller's session, or a new transaction that takes SQLite's write lock before it
        reads (what it reads can't change before it writes)."""
        if session is not None:
            yield session
            return
        async with self._sessionmaker.begin() as own:
            await lock_first(own)
            yield own


def _beyond(ordered: Select, keep: int) -> Select:
    """What `ordered` selects after its first `keep` rows."""
    return ordered.offset(keep)


async def _delete_count(session: AsyncSession, statement) -> int:
    result = await session.execute(statement.execution_options(synchronize_session=False))
    return result.rowcount or 0
