"""Rules that run in a Loki ruler: OmniKrux writes and removes them itself, at once, with no
review step (a Loki ruler is an outside tool, not a cluster), and writes an audit record before
each change ("no audit, no change": when the record can't be written nothing is sent, and the
target reads "failed" with why).

Each target is one rule group in the ruler's namespace `omnikrux`, named `omnikrux-<target id>`
(`rule_group`, the same group a PrometheusRule holds), so groups never collide between projects
and each project's group carries only that project's filter.

A write that the ruler took is "in sync" only while the rule and the target are still what was
written (checked under the write lock, as for a PrometheusRule): a save that lands meanwhile
hands the target over again, and that write comes after this one. A write whose outcome isn't
known (no answer, a timeout, a 5xx) still records the group on the target ("possibly written"),
so a later removal never forgets it. A passing refusal (429, 409) changes nothing in the ruler and
leaves the target as it was (only a target that read "in sync" for an older version stops
reading so). A removal that the ruler answered with 404 counts as done.

`after_change` is the `ToolSync` Task 8 hands Loki targets to; `AlertSync.remove_from_loki` relies
on its contract (see there): on a copy of a target marked leaving it removes the group and never
deletes the stored target unless that target is itself leaving (then the target goes, and a
deleted rule left without targets with it)."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

import yaml

from omnikrux.audit.store import (
    LOCAL_ACTOR,
    Action,
    AppAuditEntry,
    AuditUnavailable,
    Outcome,
    no_audit_message,
)
from omnikrux.monitoring.alerts.rule_expr import same_query_text
from omnikrux.monitoring.alerts.store import (
    HistoryKind,
    HistoryRecord,
    RuleRecord,
    TargetRecord,
    ToolObject,
    UnknownRule,
    UnknownTarget,
    mark_unread,
)
from omnikrux.monitoring.alerts.sync import TOOL_FAILED, AlertChange, in_loki, project_name
from omnikrux.monitoring.alerts.tool.prometheus_rule import group_name, rule_group
from omnikrux.monitoring.models import AlertRuleRow, AlertTargetRow, lock_first, now
from omnikrux.monitoring.sources.connector import status_message, tool_text
from omnikrux.monitoring.sources.transport import SourceUnreachable, TransportResponse
from omnikrux.monitoring.sources.types import SourceConfig

if TYPE_CHECKING:
    from omnikrux.monitoring.services import MonitoringServices

log = logging.getLogger(__name__)

NAMESPACE = "omnikrux"
RULES_PATH = "/loki/api/v1/rules"
WRITE_SECONDS = 15.0
YAML = "application/yaml"
# Failures after which the ruler may have made the change anyway.
UNKNOWN_CODES = frozenset({"timeout", "unreachable"})

# -- copy --------------------------------------------------------------------------------------

WRITE_FAILED = "Couldn't write the rule to {source}: {message}"
REMOVE_FAILED = "Couldn't remove the rule from {source}: {message}"
WRITTEN = "Wrote rule group {namespace}/{group} to {source}."
REMOVED = "Removed rule group {namespace}/{group} from {source}."
ALREADY_GONE = "Rule group {namespace}/{group} was already gone from {source}."
BUSY = "{source} is busy (HTTP {status}). Try again in a moment."
SOURCE_GONE = (
    "This rule's Loki source no longer exists. Link a Loki source to the project again, or run "
    "the rule in OmniKrux."
)
SOURCE_GONE_FORGOTTEN = (
    "The Loki source that held rule group {namespace}/{group} no longer exists in OmniKrux, so "
    "it couldn't be removed there. Remove it in Loki if it still runs."
)


@dataclass(frozen=True)
class _Outcome:
    ok: bool
    message: str | None = None  # why not, in words (without the "Couldn't …" lead)
    unknown: bool = False  # the ruler may have made the change anyway
    transient: bool = False  # a passing refusal: nothing changed, and trying again works
    gone_already: bool = False  # a removal found nothing to remove


@dataclass(frozen=True)
class _Place:
    source_id: str | None
    namespace: str
    group: str


def runs_in_loki(target: TargetRecord) -> bool:
    return not target.leaving and target.engine == "tool" and target.tool_kind == "loki_ruler"


def _classify(got: TransportResponse, name: str, *, removal: bool) -> _Outcome:
    status = got.status
    if 200 <= status < 300:
        return _Outcome(ok=True)
    if removal and status == 404:
        return _Outcome(ok=True, gone_already=True)
    if status in (409, 429):
        return _Outcome(ok=False, message=BUSY.format(source=name, status=status), transient=True)
    said = tool_text(got.body) if status in (400, 422) else ""
    return _Outcome(ok=False, message=said or status_message(name, status), unknown=status >= 500)


class LokiRuler:
    def __init__(self, services: MonitoringServices) -> None:
        self._services = services
        self._locks: dict[str, asyncio.Lock] = {}
        self._waiting: dict[str, int] = {}

    @asynccontextmanager
    async def _lock(self, target_id: str) -> AsyncIterator[None]:
        """One write or removal of a target at a time, in the order they were asked for."""
        lock = self._locks.setdefault(target_id, asyncio.Lock())
        self._waiting[target_id] = self._waiting.get(target_id, 0) + 1
        try:
            async with lock:
                yield
        finally:
            self._waiting[target_id] -= 1
            if not self._waiting[target_id]:
                del self._waiting[target_id]
                del self._locks[target_id]

    # -- the ToolSync --------------------------------------------------------------------------

    async def after_change(self, target: TargetRecord, rule: RuleRecord) -> AlertChange | None:
        """Write or remove the target's group at once. A copy marked leaving (`remove_from_loki`)
        is removed as given; otherwise the target and its rule are read again under the target's
        lock, so the newest of them is what reaches the ruler."""
        if target.leaving:
            return await self.remove(target, rule)
        async with self._lock(target.id):
            alerts = self._services.alerts
            try:
                fresh = await alerts.get_target(target.id)
                rule = await alerts.get_rule(fresh.rule_id)
            except (UnknownTarget, UnknownRule):
                return None
            if runs_in_loki(fresh) and rule.deleted_at is None:
                return await self._write(fresh, rule)
            return await self._remove(fresh, rule)

    async def write(self, target: TargetRecord, rule: RuleRecord) -> AlertChange:
        """Write the target's group to its Loki ruler (audited as `loki_rule_write`)."""
        async with self._lock(target.id):
            return await self._write(target, rule)

    async def remove(self, target: TargetRecord, rule: RuleRecord) -> AlertChange | None:
        """Remove the target's group from the ruler that holds it (audited as
        `loki_rule_remove`; a 404 counts as removed)."""
        async with self._lock(target.id):
            return await self._remove(target, rule)

    # -- writing -------------------------------------------------------------------------------

    async def _write(self, target: TargetRecord, rule: RuleRecord) -> AlertChange:
        services = self._services
        source = await self._source(target.source_id)
        if source is None:
            return await self._failed_write(target, rule, SOURCE_GONE, _Outcome(ok=False))
        old = target.tool_object
        if old is not None and old.kind == "loki_ruler" and old.source_id != source.id:
            # It moved to another Loki: its group leaves the old one first (two rulers would
            # both fire it).
            moved, words = await self._remove_group(target, rule, self._place(target))
            if not moved.ok:
                await self._mark_failed(target, words, moved)
                return await self._change(target, rule, "failed", words)
            try:
                target = await services.alerts.set_tool(
                    target.id,
                    tool_state=target.tool_state,
                    tool_message=target.tool_message,
                    tool_object=None,
                    applied_version=None,
                )
            except UnknownTarget:
                return await self._change(target, rule, "removed")
        group = rule_group(rule, target)
        details = {"source": source.name, "namespace": NAMESPACE, "group": group["name"]}
        try:
            record = await self._begin("loki_rule_write", rule, details)
        except AuditUnavailable as exc:
            message = no_audit_message(exc)
            return await self._failed_write(target, rule, message, _Outcome(ok=False))
        body = yaml.safe_dump(group, sort_keys=False, allow_unicode=True).encode()
        outcome = await self._send(
            source, "POST", f"{RULES_PATH}/{NAMESPACE}", body=body, removal=False
        )
        obj = ToolObject(
            kind="loki_ruler",
            source_id=source.id,
            cluster_id=None,
            namespace=NAMESPACE,
            name=group["name"],
        )
        if not outcome.ok:
            message = WRITE_FAILED.format(source=source.name, message=outcome.message)
            await self._finish(record, "unknown" if outcome.unknown else "failed", message)
            return await self._failed_write(target, rule, message, outcome, obj=obj)
        await self._finish(record, "succeeded")
        try:
            await self._settle(target, rule, obj)
            await self._history(
                target,
                "applied",
                WRITTEN.format(namespace=NAMESPACE, group=obj.name, source=source.name),
            )
        except UnknownTarget:
            log.warning("Alert target %s went while its Loki rule was written", target.id)
        return await self._change(target, rule, "written")

    async def _settle(self, target: TargetRecord, rule: RuleRecord, obj: ToolObject) -> None:
        """The ruler holds the group for this version of the rule: record it, in one transaction
        holding the write lock. In sync only while the rule is still at that version and the
        target still runs in this Loki with the same text (else a newer save has handed it over
        again, and that write follows). A target the tool hasn't been read for yet reads
        "waiting", never "OK". UnknownTarget."""
        services = self._services
        async with services.sessionmaker.begin() as session:
            await lock_first(session)
            rule_row = await session.get(AlertRuleRow, rule.id)
            row = await session.get(AlertTargetRow, target.id)
            if row is None:
                raise UnknownTarget(target.id)
            same = (
                rule_row is not None
                and rule_row.deleted_at is None
                and rule_row.version == rule.version
                and not row.leaving
                and row.engine == "tool"
                and row.tool_kind == "loki_ruler"
                and row.source_id == obj.source_id
                and same_query_text(row.rule_text, target.rule_text)
            )
            mark_unread(row, now())
            await services.alerts.set_tool(
                target.id,
                tool_state="in_sync" if same else "needs_review",
                tool_message=None,
                tool_object=obj,
                applied_version=rule.version,
                session=session,
            )

    async def _failed_write(
        self,
        target: TargetRecord,
        rule: RuleRecord,
        message: str,
        outcome: _Outcome,
        *,
        obj: ToolObject | None = None,
    ) -> AlertChange:
        """The write didn't happen; when it may have, the group is recorded as possibly
        written, so a later removal never forgets it."""
        if outcome.unknown and obj is not None:
            try:
                await self._services.alerts.set_tool(
                    target.id,
                    tool_state=target.tool_state,
                    tool_message=target.tool_message,
                    tool_object=obj,
                    applied_version=rule.version,
                )
            except UnknownTarget:
                pass
        await self._mark_failed(target, message, outcome)
        return await self._change(target, rule, "failed", message)

    # -- removing ------------------------------------------------------------------------------

    def _place(self, target: TargetRecord) -> _Place:
        obj = target.tool_object
        if obj is not None and obj.kind == "loki_ruler":
            return _Place(obj.source_id, obj.namespace, obj.name)
        return _Place(target.source_id, NAMESPACE, group_name(target.id))

    async def _remove(self, target: TargetRecord, rule: RuleRecord) -> AlertChange | None:
        if not in_loki(target):
            return await self._gone(target, rule)
        outcome, words = await self._remove_group(target, rule, self._place(target))
        if not outcome.ok:
            stored = await self._stored(target.id)
            # A copy taken out before an owner's delete leaves the stored target as it is (the
            # delete stops, and nothing changed); so does a passing refusal.
            if stored is not None and (stored.leaving or not runs_in_loki(stored)):
                await self._mark_failed(stored, words, outcome)
            return await self._change(target, rule, "failed", outcome.message)
        return await self._gone(target, rule)

    async def _remove_group(
        self, target: TargetRecord, rule: RuleRecord, place: _Place
    ) -> tuple[_Outcome, str]:
        """Take the group out of its ruler; history and the audit record say how it went. The
        outcome, and the failure in full words (`REMOVE_FAILED`)."""
        source = await self._source(place.source_id)
        if source is None:
            # OmniKrux can't reach that ruler any more: the group is forgotten, in words.
            words = SOURCE_GONE_FORGOTTEN.format(namespace=place.namespace, group=place.group)
            await self._history(target, "removed", words)
            return _Outcome(ok=True), words
        details = {"source": source.name, "namespace": place.namespace, "group": place.group}
        try:
            record = await self._begin("loki_rule_remove", rule, details)
        except AuditUnavailable as exc:
            # No audit, no change: nothing is sent, and the target says why in those words.
            message = no_audit_message(exc)
            return _Outcome(ok=False, message=message), message
        outcome = await self._send(
            source, "DELETE", f"{RULES_PATH}/{place.namespace}/{place.group}", removal=True
        )
        if not outcome.ok:
            words = REMOVE_FAILED.format(source=source.name, message=outcome.message)
            await self._finish(record, "unknown" if outcome.unknown else "failed", words)
            return outcome, words
        template = ALREADY_GONE if outcome.gone_already else REMOVED
        words = template.format(namespace=place.namespace, group=place.group, source=source.name)
        await self._finish(record, "succeeded", words if outcome.gone_already else None)
        await self._history(target, "removed", words)
        return outcome, words

    async def _mark_failed(self, target: TargetRecord, message: str, outcome: _Outcome) -> None:
        """A change in the ruler didn't happen: the target reads "failed" with why, and its
        history says so. A passing refusal leaves it as it was (only "in sync" stops)."""
        alerts = self._services.alerts
        try:
            if outcome.transient:
                if target.tool_state == "in_sync":
                    await alerts.set_tool(target.id, tool_state="needs_review", tool_message=None)
                return
            await alerts.set_tool(target.id, tool_state="failed", tool_message=message)
            await self._history(target, "apply_failed", message)
        except UnknownTarget:
            pass

    async def _gone(self, target: TargetRecord, rule: RuleRecord) -> AlertChange | None:
        """Nothing of the target is in a ruler (any more): a stored target that is leaving goes
        (with its deleted rule when it was the last); one that runs elsewhere now forgets its
        group; a copy taken out before an owner's delete changes nothing stored."""
        stored = await self._stored(target.id)
        if stored is not None and stored.leaving:
            await self._services.alert_sync.forget_target(stored)
            return await self._change(target, rule, "removed")
        if stored is None or target.leaving:
            return await self._change(target, rule, "removed")
        if (
            stored.tool_object is not None
            or stored.applied_version is not None
            or (stored.tool_state is not None and not runs_in_loki(stored))
        ):
            try:
                await self._services.alerts.set_tool(
                    stored.id,
                    tool_state=None,
                    tool_message=None,
                    tool_object=None,
                    applied_version=None,
                )
            except UnknownTarget:
                return None
            return await self._change(target, rule, "removed")
        return None

    # -- shared --------------------------------------------------------------------------------

    async def _send(
        self,
        source: SourceConfig,
        method: Literal["POST", "DELETE"],
        path: str,
        *,
        removal: bool,
        body: bytes | None = None,
    ) -> _Outcome:
        try:
            transport = self._services.transports.for_source(source)
            got = await transport.request(
                method,
                path,
                timeout=WRITE_SECONDS,
                body=body,
                content_type=YAML if body is not None else None,
            )
        except SourceUnreachable as exc:
            return _Outcome(ok=False, message=exc.message, unknown=exc.code in UNKNOWN_CODES)
        except Exception as exc:  # noqa: BLE001 (a fault in OmniKrux; logged by type only)
            log.warning("A Loki ruler request failed unexpectedly (%s)", type(exc).__name__)
            return _Outcome(ok=False, message=TOOL_FAILED, unknown=True)
        return _classify(got, source.name, removal=removal)

    async def _source(self, source_id: str | None) -> SourceConfig | None:
        if source_id is None:
            return None
        try:
            source = await self._services.sources.get(source_id)
        except KeyError:
            return None
        return source if source.type == "loki" else None

    async def _stored(self, target_id: str) -> TargetRecord | None:
        try:
            return await self._services.alerts.get_target(target_id)
        except UnknownTarget:
            return None

    async def _begin(self, action: Action, rule: RuleRecord, details: dict) -> int:
        return await self._services.audit.begin_app(
            AppAuditEntry(
                actor=LOCAL_ACTOR,
                app="monitoring",
                action=action,
                kind="loki_rule",
                name=rule.name,
                details=details,
            )
        )

    async def _finish(self, record: int, outcome: Outcome, message: str | None = None) -> None:
        await self._services.audit.finish(record, outcome, message)

    async def _history(self, target: TargetRecord, kind: HistoryKind, message: str) -> None:
        await self._services.alerts.add_history(
            [
                HistoryRecord(
                    id=None,
                    target_id=target.id,
                    rule_id=target.rule_id,
                    project_id=target.project_id,
                    at=now(),
                    kind=kind,
                    message=message,
                )
            ]
        )

    async def _change(
        self,
        target: TargetRecord,
        rule: RuleRecord,
        kind: Literal["written", "failed", "removed"],
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
            tool="loki_ruler",
        )
