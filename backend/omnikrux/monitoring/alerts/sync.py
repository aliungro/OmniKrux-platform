"""Where each rule runs: one target per project of its scope, kept in line with the projects, their
links and what their sources' tools can run.

`desired(rule)` says what the targets should be now: for each project of the scope, its source of
the rule's type (the rule's own source for a project rule when that project links it, else the
project's first linked source of the type), the engine (the tool when the rule asks for it and the
source's tool can run rules, else OmniKrux with the reason why not), the query OmniKrux runs
(`eval_expr`: `run_query` adds the project's filter) and the rule text a tool runs (the condition
wrapped first, then that project's filter injected into every selector). A project's text never
carries another project's filter, and a rule never reads another project's source.

`reconcile_rule` writes what `desired` says (`AlertStore.put_targets`) and then:
- a target with no source of the type is `error` with the engine's copy at once (never "OK");
- a leaving target with nothing in a tool goes at once; one with an object in a tool, and every
  added or changed target that runs in a tool (or still has an object there), is handed to the
  `ToolSync`, which reviews, writes or removes it (Tasks 10 and 11; until then a stub marks it
  `needs_review`);
- a deleted rule is purged once its last target is gone.

Reconciles of one rule never overlap (a lock per rule), so the last one to start reads the newest
projects and links; the write checks the rule didn't change in between (under `lock_first`).

`reconcile_dashboard` keeps the rules of a dashboard's panels in step with its document: a panel
with an alert has its rule (created or updated from the document), a panel whose alert was taken
off loses its rule, and a rule whose panel (or whole dashboard) is gone stays as a page rule. The
dashboard write and the rule writes are separate transactions; the reconcile is idempotent and
runs again at every start (`reconcile_all`), so a crash in between converges."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Iterable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING, Literal, Protocol

from pydantic import BaseModel
from sqlalchemy import select

from omnikrux.monitoring.alerts.engine import no_source_copy
from omnikrux.monitoring.alerts.rule_expr import (
    RuleExprError,
    condition_expr,
    eval_expr,
    parse_duration,
    rule_expr,
)
from omnikrux.monitoring.alerts.store import (
    RuleRecord,
    RuleSpec,
    TargetRecord,
    TargetSpec,
    UnknownRule,
    UnknownTarget,
)
from omnikrux.monitoring.alerts.types import (
    EVERY_CHOICES,
    ChannelPick,
    Condition,
    ScopeKind,
    ToolKind,
)
from omnikrux.monitoring.dashboards.store import UnknownDashboard
from omnikrux.monitoring.models import AlertRuleRow, DashboardRow, ProjectRecord, lock_first, now
from omnikrux.monitoring.projects.types import (
    Link,
    Project,
    UnknownGroup,
    UnknownProject,
)
from omnikrux.monitoring.query.filters import FilterError, inject_logql, inject_promql
from omnikrux.monitoring.sources.capability import CapabilityUnknown
from omnikrux.monitoring.sources.connector import AlertingCapability
from omnikrux.monitoring.sources.types import QUERYABLE_TYPES, SourceConfig

if TYPE_CHECKING:
    from omnikrux.clusters.registry import ClusterRegistry
    from omnikrux.monitoring.services import MonitoringServices

log = logging.getLogger(__name__)

AlertChangeKind = Literal["review", "written", "failed", "removed"]

UNKNOWN_CAPABILITY = "Couldn't check whether {source} can run rules: {message}"
TOOL_FAILED = "OmniKrux couldn't bring this rule up to date in the tool. Try again."
CONTACT_POINT_GONE = "That contact point no longer exists. Pick another."
LOKI_REMOVAL_FAILED = 'Couldn\'t remove the rule "{name}" from Loki: {message} Nothing was deleted.'
GONE_PROJECT = "A removed project"
WHERE: dict[str, str] = {
    "prometheus_rule": "in Prometheus",
    "loki_ruler": "in Loki",
}
WHERE_OMNIKRUX = "checked by OmniKrux"
# How often a reconcile reads again when the rule changed while it worked out the targets.
ATTEMPTS = 3


# Capabilities read in one pass over many rules (`reconcile_all`): each source is asked at most
# once, failures included, so one unreachable source costs one timeout per pass.
Memo = dict[str, "AlertingCapability | CapabilityUnknown"]
_AGAIN = object()


async def _uncancelled[T](work: Awaitable[T]) -> T:
    """Run `work` to its end even when the caller is cancelled meanwhile (the caller's
    cancellation is raised once it has finished)."""
    task = asyncio.ensure_future(work)
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await asyncio.wait({task})
        raise


def where(target: TargetRecord) -> str:
    """Where the target runs, in words."""
    if target.engine == "tool" and target.tool_kind is not None:
        return WHERE[target.tool_kind]
    return WHERE_OMNIKRUX


@dataclass(frozen=True)
class AlertChange:
    """What a change of a rule did to one target in its tool (or that the target went)."""

    target_id: str
    rule_id: str
    rule_name: str
    project_id: str
    project_name: str
    kind: AlertChangeKind
    message: str | None


class AlertChangeOut(BaseModel):
    """An `AlertChange` in an answer (a rule's change, a dashboard's save)."""

    target_id: str
    rule_id: str
    rule_name: str
    project_id: str
    project_name: str
    kind: AlertChangeKind
    message: str | None


def change_out(change: AlertChange) -> AlertChangeOut:
    return AlertChangeOut(
        target_id=change.target_id,
        rule_id=change.rule_id,
        rule_name=change.rule_name,
        project_id=change.project_id,
        project_name=change.project_name,
        kind=change.kind,
        message=change.message,
    )


class LokiRemovalFailed(Exception):
    """A rule couldn't be removed from a Loki ruler; the owner's delete stops."""

    def __init__(self, name: str, message: str) -> None:
        super().__init__(LOKI_REMOVAL_FAILED.format(name=name, message=message))
        self.message = str(self)


def in_loki(target: TargetRecord) -> bool:
    """Whether something of the target is (or may be) in a Loki ruler."""
    if target.tool_object is not None:
        return target.tool_object.kind == "loki_ruler"
    return target.tool_kind == "loki_ruler" and target.applied_version is not None


def in_cluster(target: TargetRecord) -> bool:
    """Whether the target is applied in a cluster (a PrometheusRule)."""
    return target.tool_kind == "prometheus_rule" and target.applied_version is not None


async def cluster_name(
    services: MonitoringServices, registry: ClusterRegistry, target: TargetRecord
) -> str | None:
    """The name of the cluster that holds the target's object (or its source's cluster); None
    when OmniKrux doesn't know it."""
    cluster_id = target.tool_object.cluster_id if target.tool_object is not None else None
    if cluster_id is None and target.source_id is not None:
        try:
            source = await services.sources.get(target.source_id)
        except KeyError:
            source = None
        if source is not None and source.cluster is not None:
            cluster_id = source.cluster.cluster_id
    if cluster_id is None:
        return None
    try:
        return (await registry.get(cluster_id)).name
    except KeyError:
        return None


def panel_rule_spec(
    doc: dict,
    panel: dict,
    *,
    owner_kind: ScopeKind,
    owner_id: str,
    dashboard_id: str,
    contact_points: Iterable[str],
) -> RuleSpec:
    """The rule a panel's alert says, scoped to the dashboard's owner and reading the source of
    the alert's query. Contact points that no longer exist are left out. RuleExprError when the
    alert's query can't be run as written (a saved document never has one)."""
    alert = panel["alert"]
    query = next((q for q in panel.get("queries", []) if q.get("ref") == alert.get("query")), None)
    if query is None:
        raise RuleExprError("Use the ref of one of this panel's queries, like A.")
    source = query.get("source") or {}
    source_type = source.get("type")
    if source_type not in ("prometheus", "loki"):
        raise RuleExprError("The alert's query has no source type.")
    every = EVERY_CHOICES.get(alert.get("every") or "1m", 60)
    try:
        for_seconds = parse_duration(alert.get("for") or "5m")
    except ValueError:
        raise RuleExprError("Use a duration from 0s to 24h, like 5m.") from None
    known = set(contact_points)
    channel = alert.get("channel")
    return RuleSpec(
        name=alert["name"],
        scope_kind=owner_kind,
        scope_id=owner_id,
        source_type=source_type,
        source_id=source.get("id") if owner_kind == "project" else None,
        expr=rule_expr(doc, panel),
        condition=Condition(
            of=alert.get("of") or "each",
            op=alert["op"],
            threshold=float(alert["threshold"]),
            for_seconds=for_seconds,
            every_seconds=every,
        ),
        severity=alert.get("severity") or "warning",
        message=alert.get("message") or "",
        contact_point_ids=tuple(id for id in alert.get("notify") or () if id in known),
        engine=alert.get("engine") or "omnikrux",
        channel=(
            ChannelPick(receiver=channel["receiver"], labels=dict(channel.get("labels") or {}))
            if isinstance(channel, dict)
            else None
        ),
        origin="panel",
        dashboard_id=dashboard_id,
        panel_id=panel["id"],
    )


class ToolSync(Protocol):
    async def after_change(self, target: TargetRecord, rule: RuleRecord) -> AlertChange | None:
        """Bring the target's tool in line with it: called for added, changed and leaving
        (`target.leaving`) targets that run in a tool or still have an object there."""
        ...


async def project_name(services: MonitoringServices, project_id: str) -> str:
    try:
        return (await services.projects.get(project_id)).name
    except UnknownProject:
        return GONE_PROJECT


class ReviewEveryChange:
    """The `ToolSync` until the tool engines land (Tasks 10 and 11): nothing is written into a
    tool; every change waits for a review."""

    def __init__(self, services: MonitoringServices) -> None:
        self._services = services

    async def after_change(self, target: TargetRecord, rule: RuleRecord) -> AlertChange | None:
        try:
            await self._services.alerts.set_tool(
                target.id, tool_state="needs_review", tool_message=None
            )
        except UnknownTarget:
            return None
        return AlertChange(
            target_id=target.id,
            rule_id=rule.id,
            rule_name=rule.name,
            project_id=target.project_id,
            project_name=await project_name(self._services, target.project_id),
            kind="review",
            message=None,
        )


def _injector(source: SourceConfig):
    return inject_logql if source.type == "loki" else inject_promql


class AlertSync:
    def __init__(self, services: MonitoringServices, *, tool_sync: ToolSync | None = None) -> None:
        self._services = services
        self.tool_sync: ToolSync = (
            tool_sync if tool_sync is not None else ReviewEveryChange(services)
        )
        self._locks: dict[str, asyncio.Lock] = {}
        self._waiting: dict[str, int] = {}

    # -- what the targets should be ------------------------------------------------------------

    async def scope_projects(self, kind: ScopeKind, id: str) -> list[Project]:
        """The projects of a scope (a group's members by name); none when the scope is gone."""
        projects = self._services.projects
        if kind == "project":
            try:
                return [await projects.get(id)]
            except UnknownProject:
                return []
        try:
            group = await self._services.groups.get(id)
        except UnknownGroup:
            return []
        found: list[Project] = []
        for member in group.project_ids:
            try:
                found.append(await projects.get(member))
            except UnknownProject:
                continue
        return sorted(found, key=lambda p: (p.name.casefold(), p.id))

    async def source_for(
        self, rule: RuleRecord, project: Project
    ) -> tuple[SourceConfig, Link] | None:
        """The project's source for the rule, with its link (whose filter the rule gets): the
        rule's own source for a project rule when the project links it, else the first linked
        source of the rule's type. Never an Alertmanager or another type."""

        async def usable(link: Link) -> SourceConfig | None:
            try:
                source = await self._services.sources.get(link.source_id)
            except KeyError:
                return None
            if source.type != rule.source_type or source.type not in QUERYABLE_TYPES:
                return None
            return source

        if rule.scope_kind == "project" and rule.source_id is not None:
            for link in project.links:
                if link.source_id == rule.source_id and (source := await usable(link)):
                    return source, link
        for link in project.links:
            if source := await usable(link):
                return source, link
        return None

    async def desired(
        self,
        rule: RuleRecord,
        current: Sequence[TargetRecord] | None = None,
        *,
        memo: Memo | None = None,
    ) -> list[TargetSpec]:
        """One spec per project of the rule's scope (none for a deleted rule). `current` (the
        rule's targets now; read when not given) keeps a tool target in its tool while the tool's
        capability can't be read, instead of moving it to OmniKrux on a passing failure."""
        if rule.deleted_at is not None:
            return []
        if current is None:
            current = await self._services.alerts.targets(rule_id=rule.id)
        now_at = {t.project_id: t for t in current if not t.leaving}
        specs: list[TargetSpec] = []
        for project in await self.scope_projects(rule.scope_kind, rule.scope_id):
            specs.append(await self._spec(rule, project, now_at.get(project.id), memo))
        return specs

    async def _capability(self, source: SourceConfig, memo: Memo | None) -> AlertingCapability:
        """The source's capability; CapabilityUnknown. With `memo`, asked once per pass."""
        if memo is not None and source.id in memo:
            known = memo[source.id]
            if isinstance(known, CapabilityUnknown):
                raise known
            return known
        try:
            capability = await self._services.capabilities.get(source)
        except CapabilityUnknown as exc:
            if memo is not None:
                memo[source.id] = exc
            raise
        if memo is not None:
            memo[source.id] = capability
        return capability

    async def _spec(
        self,
        rule: RuleRecord,
        project: Project,
        existing: TargetRecord | None,
        memo: Memo | None = None,
    ) -> TargetSpec:
        cond = rule.condition
        checked = eval_expr(rule.expr, cond.of)
        found = await self.source_for(rule, project)
        if found is None:
            return TargetSpec(
                project_id=project.id,
                engine="omnikrux",
                engine_note=None,
                source_id=None,
                eval_expr=checked,
                rule_text="",
            )
        source, link = found
        problem: str | None = None
        try:
            # Wrapped first, then filtered: every selector of the final text gets the filter.
            rule_text = _injector(source)(condition_expr(rule.expr, cond), link.matchers)
        except FilterError as exc:
            rule_text, problem = "", str(exc)
        engine: Literal["omnikrux", "tool"] = "omnikrux"
        tool_kind: ToolKind | None = None
        note: str | None = None
        if rule.engine == "tool":
            if problem is not None:
                note = problem
            else:
                try:
                    capability = await self._capability(source, memo)
                except CapabilityUnknown as exc:
                    if (
                        existing is not None
                        and existing.engine == "tool"
                        and existing.source_id == source.id
                        and existing.tool_kind is not None
                    ):
                        engine, tool_kind = "tool", existing.tool_kind
                    else:
                        note = UNKNOWN_CAPABILITY.format(source=source.name, message=exc.message)
                else:
                    if capability.tool_engine is not None:
                        engine, tool_kind = "tool", capability.tool_engine
                    else:
                        note = capability.reason
        return TargetSpec(
            project_id=project.id,
            engine=engine,
            engine_note=note,
            source_id=source.id,
            eval_expr=checked,
            rule_text=rule_text,
            tool_kind=tool_kind,
        )

    # -- writing them --------------------------------------------------------------------------

    @asynccontextmanager
    async def _lock(self, rule_id: str) -> AsyncIterator[None]:
        lock = self._locks.setdefault(rule_id, asyncio.Lock())
        self._waiting[rule_id] = self._waiting.get(rule_id, 0) + 1
        try:
            async with lock:
                yield
        finally:
            self._waiting[rule_id] -= 1
            if not self._waiting[rule_id]:
                del self._waiting[rule_id]
                del self._locks[rule_id]

    async def reconcile_rule(
        self, rule_id: str, *, changed: bool = False, memo: Memo | None = None
    ) -> list[AlertChange]:
        """Bring the rule's targets in line with `desired` and hand tool work to the ToolSync.
        `changed`: what the rule says changed (a save), so every target in a tool is handed over
        too, even one whose own fields stayed the same. Nothing for a rule that is gone.

        Cancelling it never lands between writing the targets and handing them to the tool
        sync: that part runs to its end first."""
        async with self._lock(rule_id):
            alerts = self._services.alerts
            for attempt in range(ATTEMPTS):
                try:
                    rule = await alerts.get_rule(rule_id)
                except UnknownRule:
                    return []
                specs = await self.desired(rule, await alerts.targets(rule_id=rule_id), memo=memo)
                last = attempt == ATTEMPTS - 1
                done = await _uncancelled(self._write(rule, specs, changed=changed, last=last))
                if done is not _AGAIN:
                    return done
            return []

    async def _write(self, rule: RuleRecord, specs: list[TargetSpec], *, changed: bool, last: bool):
        """Write the targets (or `_AGAIN` when the rule changed meanwhile and this isn't the last
        try; the last one writes what it worked out: the specs don't depend on anything that
        changes without a reconcile of its own), then remove, mark and hand over what that
        changed."""
        services = self._services
        alerts = services.alerts
        rule_id = rule.id
        async with services.sessionmaker.begin() as session:
            await lock_first(session)
            row = await session.get(AlertRuleRow, rule_id)
            if row is None:
                return []
            moved = row.version != rule.version or (row.deleted_at is None) != (
                rule.deleted_at is None
            )
            if moved and not last:
                return _AGAIN  # changed meanwhile: work it out again from what it is now
            if row.deleted_at is not None:
                specs = []
            # A project deleted meanwhile gets no target.
            ids = [s.project_id for s in specs]
            alive = set(
                await session.scalars(select(ProjectRecord.id).where(ProjectRecord.id.in_(ids)))
            )
            specs = [s for s in specs if s.project_id in alive]
            diff = await alerts.put_targets(rule_id, specs, session=session)
        try:
            rule = await alerts.get_rule(rule_id)
        except UnknownRule:  # its owner was deleted meanwhile, with its targets
            return []
        targets = {t.id: t for t in await alerts.targets(rule_id=rule_id)}
        changes: list[AlertChange] = []
        await self._mark_without_source(rule, targets.values())
        told: set[str] = set()
        for target_id in diff.leaving:
            target = targets.get(target_id)
            if target is None:
                continue
            told.add(target_id)
            if target.tool_object is None and target.applied_version is None:
                # Nothing of it is in a tool: it goes at once.
                if await self._delete(target):
                    changes.append(await self._change(target, rule, "removed"))
            elif change := await self._tell(target, rule):
                changes.append(change)
        handed = list(diff.added) + list(diff.changed)
        if changed:
            handed += [t.id for t in targets.values() if not t.leaving]
        for target_id in handed:
            target = targets.get(target_id)
            if target is None or target_id in told or target.leaving:
                continue
            told.add(target_id)
            in_tool = target.engine == "tool" or target.tool_object is not None
            if in_tool and (change := await self._tell(target, rule)):
                changes.append(change)
        if rule.deleted_at is not None:
            try:
                await alerts.purge_rule(rule_id)
            except UnknownRule:
                pass
        return sorted(changes, key=lambda c: (c.project_name.casefold(), c.target_id))

    async def _mark_without_source(self, rule: RuleRecord, targets) -> None:
        """A target with no source of the type can't be checked: it says so at once (the engine
        says the same at every check), never "OK"."""
        for target in targets:
            if target.leaving or target.engine != "omnikrux" or target.source_id is not None:
                continue
            message = no_source_copy(
                await project_name(self._services, target.project_id), rule.source_type
            )
            if target.state == "error" and target.message == message:
                continue
            try:
                await self._services.alerts.set_eval(
                    target.id,
                    state="error",
                    message=message,
                    at=now(),
                    next_eval_at=target.next_eval_at,
                    failures=target.failures,
                )
            except UnknownTarget:
                continue

    async def _delete(self, target: TargetRecord) -> bool:
        """Remove the target (and its instances), under the notifier's lock of its instances so
        a delivery finishing meanwhile can't write them back."""
        async with self._services.notifier.instances_lock(target.id):
            try:
                await self._services.alerts.delete_target(target.id)
            except UnknownTarget:
                return False
        return True

    async def _tell(self, target: TargetRecord, rule: RuleRecord) -> AlertChange | None:
        try:
            return await self.tool_sync.after_change(target, rule)
        except Exception as exc:  # noqa: BLE001 (the rule is saved; the target says it failed)
            log.warning(
                "Bringing alert target %s up to date in its tool failed (%s)",
                target.id,
                type(exc).__name__,
            )
            return await self._change(target, rule, "failed", TOOL_FAILED)

    async def _change(
        self,
        target: TargetRecord,
        rule: RuleRecord,
        kind: AlertChangeKind,
        message: str | None = None,
    ) -> AlertChange:
        return AlertChange(
            target_id=target.id,
            rule_id=rule.id,
            rule_name=rule.name,
            project_id=target.project_id,
            project_name=await project_name(self._services, target.project_id),
            kind=kind,
            message=message,
        )

    # -- panel alerts --------------------------------------------------------------------------

    def dashboard_lock(self, dashboard_id: str):
        """Held while the rules of a dashboard's panels are worked out and written, so two
        reconciles of one dashboard never both create a panel's rule."""
        return self._lock(f"dashboard:{dashboard_id}")

    async def reconcile_dashboard(
        self, dashboard_id: str, *, deleted: bool = False, memo: Memo | None = None
    ) -> list[AlertChange]:
        """Bring the rules of the dashboard's panels in line with its document as stored now:
        each panel with an alert has its rule (origin "panel", scoped to the dashboard's owner,
        the query from `rule_expr`), created or updated, then reconciled; a rule whose panel has
        no alert any more is deleted (the dashboard's save was the ask); a rule whose panel is
        gone, or whose dashboard is deleted (`deleted`, or no longer found), is detached and
        runs on as a page rule. Idempotent."""
        services = self._services
        alerts = services.alerts
        changes: list[AlertChange] = []
        async with self.dashboard_lock(dashboard_id):
            record = None
            if not deleted:
                try:
                    record = await services.dashboards.get(dashboard_id)
                except UnknownDashboard:
                    record = None
            rules: dict[str, RuleRecord] = {}
            extra: list[RuleRecord] = []  # a second rule for one panel (never made; kept safe)
            for rule in await alerts.rules_for_dashboard(dashboard_id):
                if rule.panel_id is None or rule.panel_id in rules:
                    extra.append(rule)
                else:
                    rules[rule.panel_id] = rule
            panels: dict[str, dict] = {}
            if record is not None:
                panels = {
                    p["id"]: p
                    for p in record.spec.get("panels", [])
                    if isinstance(p, dict) and isinstance(p.get("id"), str)
                }
            touched: list[tuple[str, bool]] = []
            for rule in extra + [r for pid, r in rules.items() if pid not in panels]:
                if await self._detach(rule.id):
                    touched.append((rule.id, False))
            for panel_id, rule in rules.items():
                panel = panels.get(panel_id)
                taken_off = panel is not None and panel.get("alert") is None
                if taken_off and await self._remove_panel_rule(rule.id):
                    touched.append((rule.id, False))
            if record is not None:
                known = [cp.id for cp in await services.contact_points.list()]
                for panel in panels.values():
                    if not isinstance(panel.get("alert"), dict):
                        continue
                    try:
                        spec = panel_rule_spec(
                            record.spec,
                            panel,
                            owner_kind=record.owner_kind,
                            owner_id=record.owner_id,
                            dashboard_id=dashboard_id,
                            contact_points=known,
                        )
                    except (RuleExprError, KeyError, TypeError, ValueError) as exc:
                        log.warning(
                            "The alert of a panel of dashboard %s can't run (%s)",
                            dashboard_id,
                            type(exc).__name__,
                        )
                        continue
                    written = await self._upsert_panel_rule(dashboard_id, spec)
                    if written is not None:
                        touched.append(written)
        for rule_id, changed in touched:
            changes += await self.reconcile_rule(rule_id, changed=changed, memo=memo)
        return sorted(changes, key=lambda c: (c.project_name.casefold(), c.rule_name, c.target_id))

    async def _detach(self, rule_id: str) -> bool:
        try:
            await self._services.alerts.detach_rule(rule_id)
        except UnknownRule:
            return False
        return True

    async def _remove_panel_rule(self, rule_id: str) -> bool:
        """Mark the rule deleted and its targets leaving (as `DELETE /alerts/rules/{id}` does);
        its reconcile removes them."""
        alerts = self._services.alerts
        async with self._services.sessionmaker.begin() as session:
            await lock_first(session)
            row = await session.get(AlertRuleRow, rule_id)
            if row is None or row.deleted_at is not None:
                return False
            await alerts.tombstone_rule(rule_id, session=session)
            await alerts.put_targets(rule_id, [], session=session)
        return True

    async def _upsert_panel_rule(
        self, dashboard_id: str, spec: RuleSpec
    ) -> tuple[str, bool] | None:
        """Write the panel's rule (in one transaction that reads it again under the write lock):
        (its id, whether an existing rule changed), or None when the dashboard went meanwhile."""
        alerts = self._services.alerts
        async with self._services.sessionmaker.begin() as session:
            await lock_first(session)
            if await session.get(DashboardRow, dashboard_id) is None:
                return None
            row = await session.scalar(
                select(AlertRuleRow)
                .where(
                    AlertRuleRow.dashboard_id == dashboard_id,
                    AlertRuleRow.panel_id == spec.panel_id,
                    AlertRuleRow.deleted_at.is_(None),
                )
                .order_by(AlertRuleRow.created_at, AlertRuleRow.id)
                .limit(1)
            )
            if row is None:
                created = await alerts.create_rule(spec, session=session)
                return created.id, False
            before = row.version
            updated = await alerts.update_rule(row.id, spec, base_version=None, session=session)
            return updated.id, updated.version != before

    # -- owners that go away -------------------------------------------------------------------

    async def remove_from_loki(self, targets: Iterable[TargetRecord]) -> None:
        """Before an owner's delete: remove from its Loki ruler every target that has (or may
        have) a rule there. LokiRemovalFailed (with the rule's name and why) at the first that
        can't be removed; the delete then stops."""
        alerts = self._services.alerts
        for target in targets:
            if not in_loki(target):
                continue
            try:
                rule = await alerts.get_rule(target.rule_id)
            except UnknownRule:
                continue
            try:
                change = await self.tool_sync.after_change(replace(target, leaving=True), rule)
            except Exception as exc:  # noqa: BLE001 (reported in words; nothing is deleted)
                log.warning(
                    "Removing alert target %s from Loki failed (%s)", target.id, type(exc).__name__
                )
                raise LokiRemovalFailed(rule.name, TOOL_FAILED) from None
            if change is not None and change.kind == "failed":
                raise LokiRemovalFailed(rule.name, change.message or TOOL_FAILED)

    async def cluster_names(
        self, registry: ClusterRegistry, rule_ids: Iterable[str], project_id: str | None = None
    ) -> list[str]:
        """The clusters where those rules are applied (in `project_id` only, when given), by
        name; an unknown cluster isn't named."""
        names: set[str] = set()
        for rule_id in rule_ids:
            for target in await self._services.alerts.targets(rule_id=rule_id):
                if project_id is not None and target.project_id != project_id:
                    continue
                if in_cluster(target) and (
                    name := await cluster_name(self._services, registry, target)
                ):
                    names.add(name)
        return sorted(names, key=str.casefold)

    async def reconcile_scope(self, kind: ScopeKind, id: str) -> list[AlertChange]:
        """Every rule of that project or group; for a project, also every rule of a group it is
        in (its target there follows its links too)."""
        alerts = self._services.alerts
        rules = await alerts.list_rules(scope_kind=kind, scope_id=id)
        if kind == "project":
            for group in await self._services.groups.list():
                if id in group.project_ids:
                    rules += await alerts.list_rules(scope_kind="group", scope_id=group.id)
        changes: list[AlertChange] = []
        for rule_id in dict.fromkeys(r.id for r in rules):
            changes += await self.reconcile_rule(rule_id)
        return changes

    async def reconcile_all(self) -> None:
        """Every rule, deleted ones still removing their targets included (at startup, after the
        migrations; see `MonitoringServices.start_alerts`). Each source's capability is asked at
        most once in the pass. A rule that fails is logged and left for the next start, the
        others carry on, and nothing in here ever stops the app."""
        try:
            memo: Memo = {}
            # Panel rules first: a dashboard saved (or deleted) just before a stop gets its rules.
            boards = [d.id for d in await self._services.dashboards.list()]
            gone = {
                r.dashboard_id
                for r in await self._services.alerts.list_rules()
                if r.dashboard_id is not None and r.dashboard_id not in boards
            }
            for dashboard_id in boards + sorted(gone):
                try:
                    await self.reconcile_dashboard(
                        dashboard_id, deleted=dashboard_id in gone, memo=memo
                    )
                except Exception as exc:  # noqa: BLE001 (the others carry on; logged by type)
                    log.warning(
                        "Bringing the alerts of dashboard %s up to date failed (%s)",
                        dashboard_id,
                        type(exc).__name__,
                    )
            for rule in await self._services.alerts.list_rules(include_deleted=True):
                try:
                    await self.reconcile_rule(rule.id, memo=memo)
                except Exception as exc:  # noqa: BLE001 (the others carry on; logged by type)
                    log.warning(
                        "Bringing alert rule %s's targets up to date failed (%s)",
                        rule.id,
                        type(exc).__name__,
                    )
        except Exception as exc:  # noqa: BLE001 (startup goes on; logged by type)
            log.warning("Bringing alert rules up to date failed (%s)", type(exc).__name__)
