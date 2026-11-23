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
projects and links; the write checks the rule didn't change in between (under `lock_first`)."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, Protocol

from sqlalchemy import select

from omnikrux.monitoring.alerts.engine import no_source_copy
from omnikrux.monitoring.alerts.rule_expr import condition_expr, eval_expr
from omnikrux.monitoring.alerts.store import (
    RuleRecord,
    TargetRecord,
    TargetSpec,
    UnknownRule,
    UnknownTarget,
)
from omnikrux.monitoring.alerts.types import ScopeKind, ToolKind
from omnikrux.monitoring.models import AlertRuleRow, ProjectRecord, lock_first, now
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
    from omnikrux.monitoring.services import MonitoringServices

log = logging.getLogger(__name__)

AlertChangeKind = Literal["review", "written", "failed", "removed"]

UNKNOWN_CAPABILITY = "Couldn't check whether {source} can run rules: {message}"
TOOL_FAILED = "OmniKrux couldn't bring this rule up to date in the tool. Try again."
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
