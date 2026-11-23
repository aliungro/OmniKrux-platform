"""Who is told what after a check of a rule OmniKrux runs.

One check of a target builds at most one `Notice` and sends it to each contact point of the rule
(grouped per rule and check). It holds the instances that are newly firing (or firing and never
told: a delivery that failed everywhere, or a silence that ended), those still firing whose last
notice is older than `REPEAT_SECONDS`, and those resolved that somebody was told about. Instances
an active silence matches are left out and marked `silenced`; nothing is sent when nothing is
left. An instance's `last_notified_at` moves only once its notice reached at least one contact
point.

Deliveries run in the background, at most `DELIVERY_CONCURRENCY` at once, each through
`senders.deliver` (its retries), so a slow contact point never holds up a check. Each delivery is
recorded (the delivery log and the contact point's last delivery) with copy that carries no
secret.

`instances_lock(target_id)` serialises the writes of a target's instances between the engine (a
check) and this notifier (marking what was told), so neither overwrites the other."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from datetime import datetime
from typing import TYPE_CHECKING, Literal

from omnikrux.monitoring.alerts.contact_points.senders import DROPPED, deliver
from omnikrux.monitoring.alerts.contact_points.types import (
    DeliveryFailed,
    Notice,
    NoticeInstance,
    UnknownContactPoint,
)
from omnikrux.monitoring.alerts.evaluate import StepResult
from omnikrux.monitoring.alerts.rule_expr import render_message
from omnikrux.monitoring.alerts.silences import Silence, silenced_by
from omnikrux.monitoring.alerts.store import InstanceRecord, RuleRecord, TargetRecord
from omnikrux.monitoring.models import now as now_utc

if TYPE_CHECKING:
    from omnikrux.monitoring.services import MonitoringServices

log = logging.getLogger(__name__)

# A firing instance is told again after this long (4 hours); so is a rule that still can't be
# checked.
REPEAT_SECONDS = 14400
# Deliveries running at once, every contact point together.
DELIVERY_CONCURRENCY = 4
# How long `drain` waits for queued deliveries (at shutdown too).
DRAIN_SECONDS = 15.0

NoticeReason = Literal["evaluation", "cant_check", "checking_again"]

# -- copy --------------------------------------------------------------------------------------

FIRING_SUMMARY = "{count} firing ({op} {threshold})."
RESOLVED_SUMMARY = "{count} resolved."
CANT_CHECK_SUMMARY = "OmniKrux couldn't check this rule {count} times in a row. {message}"
CHECKING_AGAIN_SUMMARY = "OmniKrux can check this rule again."
LINK_HINT = "See it in OmniKrux under Monitoring › Alerts."


def dedup_key(target_id: str, reason: NoticeReason) -> str:
    """One incident per target for what fires, and one for not being checked: a resolve closes
    the firing incident; a "checking again" closes the one "can't check" opened."""
    if reason == "evaluation":
        return f"omnikrux-{target_id}"
    return f"omnikrux-{target_id}-cant-check"


def _due(instance: InstanceRecord, now: datetime) -> bool:
    """Whether a firing instance is to be told: never told, or told `REPEAT_SECONDS` ago."""
    told = instance.last_notified_at
    return told is None or (now - told).total_seconds() >= REPEAT_SECONDS


def _by_labels(instance: InstanceRecord) -> list[tuple[str, str]]:
    """Instances in a message read in the order of their labels."""
    return sorted(instance.labels.items())


def _threshold(value: float) -> str:
    return f"{value:g}"


@dataclass
class _Group:
    """One notice on its way to every contact point of the rule."""

    target_id: str
    checked_at: datetime
    marks: frozenset[str]  # fingerprints told as firing
    keys: frozenset[tuple[str, str]]  # (target, fingerprint) held in flight until the end
    remaining: int
    delivered: bool = False


class _LockEntry:
    def __init__(self) -> None:
        self.lock = asyncio.Lock()
        self.users = 0


class Notifier:
    def __init__(
        self,
        services: MonitoringServices,
        *,
        sleep: Callable[[float], Awaitable[object]] = asyncio.sleep,
        clock: Callable[[], datetime] = now_utc,
    ) -> None:
        self._services = services
        self._sleep = sleep
        self._clock = clock
        self._slots = asyncio.Semaphore(DELIVERY_CONCURRENCY)
        self._tasks: set[asyncio.Task] = set()
        self._in_flight: set[tuple[str, str]] = set()
        self._locks: dict[str, _LockEntry] = {}

    # -- the per-target lock -------------------------------------------------------------------

    @asynccontextmanager
    async def instances_lock(self, target_id: str) -> AsyncIterator[None]:
        """Held while a target's instances are read and written back."""
        entry = self._locks.get(target_id)
        if entry is None:
            entry = self._locks[target_id] = _LockEntry()
        entry.users += 1
        try:
            async with entry.lock:
                yield
        finally:
            entry.users -= 1
            if entry.users == 0 and self._locks.get(target_id) is entry:
                del self._locks[target_id]

    # -- notify --------------------------------------------------------------------------------

    async def notify(
        self,
        target: TargetRecord,
        rule: RuleRecord,
        project_name: str,
        result: StepResult | None,
        kind: NoticeReason,
        now: datetime,
    ) -> None:
        """Queue what this check of `target` has to tell (see the module's words). Returns once
        the notice is queued; `drain` waits for the deliveries."""
        if kind == "evaluation":
            notice, marks = await self._evaluation_notice(target, rule, project_name, result, now)
        else:
            notice, marks = self._state_notice(target, rule, project_name, kind), frozenset()
        if notice is None or not rule.contact_point_ids:
            return
        keys = frozenset((target.id, fp) for fp in marks)
        group = _Group(
            target_id=target.id,
            checked_at=now,
            marks=marks,
            keys=keys,
            remaining=len(rule.contact_point_ids),
        )
        self._in_flight |= keys
        for cp_id in rule.contact_point_ids:
            self._spawn(self._send(cp_id, target.id, notice, group))

    async def _evaluation_notice(
        self,
        target: TargetRecord,
        rule: RuleRecord,
        project_name: str,
        result: StepResult | None,
        now: datetime,
    ) -> tuple[Notice | None, frozenset[str]]:
        silences = await self._services.silences.active(now)
        async with self.instances_lock(target.id):
            current = await self._services.alerts.instances(target.id)
            current = await self._mark_silenced(target.id, current, silences)
        firing = [
            i
            for i in current
            if i.state == "firing"
            and not i.silenced
            and (target.id, i.fingerprint) not in self._in_flight
            and _due(i, now)
        ]
        resolved = [
            r
            for r in (result.resolved if result is not None else ())
            if (r.last_notified_at is not None or (target.id, r.fingerprint) in self._in_flight)
            and not silenced_by(silences, r.labels)
        ]
        if not firing and not resolved:
            return None, frozenset()
        firing.sort(key=_by_labels)
        resolved.sort(key=_by_labels)
        still_firing = any(i.state == "firing" and not i.silenced for i in current)
        notice_kind = "firing" if firing or still_firing else "resolved"
        parts = []
        if firing:
            parts.append(
                FIRING_SUMMARY.format(
                    count=len(firing),
                    op=rule.condition.op,
                    threshold=_threshold(rule.condition.threshold),
                )
            )
        if resolved:
            parts.append(RESOLVED_SUMMARY.format(count=len(resolved)))
        instances = [self._instance(rule, i, None) for i in firing]
        instances += [self._instance(rule, r, now) for r in resolved]
        notice = Notice(
            kind=notice_kind,
            rule_name=rule.name,
            project_name=project_name,
            severity=rule.severity,
            summary=" ".join(parts),
            instances=tuple(instances),
            link_hint=LINK_HINT,
            dedup_key=dedup_key(target.id, "evaluation"),
        )
        return notice, frozenset(i.fingerprint for i in firing)

    def _state_notice(
        self,
        target: TargetRecord,
        rule: RuleRecord,
        project_name: str,
        kind: Literal["cant_check", "checking_again"],
    ) -> Notice:
        if kind == "cant_check":
            summary = CANT_CHECK_SUMMARY.format(
                count=target.failures, message=target.message or ""
            ).strip()
        else:
            summary = CHECKING_AGAIN_SUMMARY
        return Notice(
            kind=kind,
            rule_name=rule.name,
            project_name=project_name,
            severity=rule.severity,
            summary=summary,
            instances=(),
            link_hint=LINK_HINT,
            dedup_key=dedup_key(target.id, kind),
        )

    @staticmethod
    def _instance(rule: RuleRecord, i: InstanceRecord, ended: datetime | None) -> NoticeInstance:
        message = render_message(rule.message, i.labels, i.value) if rule.message else ""
        return NoticeInstance(
            labels=dict(i.labels),
            value=i.value,
            starts_at=i.fired_at or i.active_since,
            ends_at=ended,
            message=message,
        )

    async def _mark_silenced(
        self, target_id: str, current: Sequence[InstanceRecord], silences: Sequence[Silence]
    ) -> list[InstanceRecord]:
        """Each instance with `silenced` as the active silences say now; written back when that
        changed (under the instances lock)."""
        marked = [replace(i, silenced=bool(silenced_by(silences, i.labels))) for i in current]
        if any(a.silenced != b.silenced for a, b in zip(current, marked, strict=True)):
            await self._services.alerts.replace_instances(target_id, marked)
        return marked

    # -- deliveries ----------------------------------------------------------------------------

    def _spawn(self, work: Awaitable[None]) -> None:
        task = asyncio.ensure_future(work)
        self._tasks.add(task)
        task.add_done_callback(self._finished)

    def _finished(self, task: asyncio.Task) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and (exc := task.exception()) is not None:
            log.warning("A notification delivery failed unexpectedly (%s)", type(exc).__name__)

    async def _send(self, cp_id: str, target_id: str, notice: Notice, group: _Group) -> None:
        ok, message = False, None
        try:
            async with self._slots:
                ok, message = await self._attempt(cp_id, notice)
            if message is not None or ok:
                await self._record(cp_id, target_id, notice, ok, message)
        finally:
            group.delivered = group.delivered or ok
            group.remaining -= 1
            if group.remaining == 0:
                await self._close_group(group)

    async def _attempt(self, cp_id: str, notice: Notice) -> tuple[bool, str | None]:
        """(delivered, copy when not). A contact point deleted since is skipped: (False, None)."""
        try:
            cp = await self._services.contact_points.get(cp_id)
        except UnknownContactPoint:
            return False, None
        try:
            await deliver(self._services.senders, cp, notice, sleep=self._sleep)
        except DeliveryFailed as exc:
            return False, exc.message
        except Exception as exc:  # noqa: BLE001 (said in words; its own text may hold an address)
            log.warning(
                "Contact point %s (%s) failed unexpectedly: %s", cp.id, cp.type, type(exc).__name__
            )
            return False, DROPPED.format(name=cp.name)
        return True, None

    async def _record(
        self, cp_id: str, target_id: str, notice: Notice, ok: bool, message: str | None
    ) -> None:
        at = self._clock()
        try:
            await self._services.contact_points.add_delivery(
                cp_id, target_id, notice.kind, ok, message, at
            )
            await self._services.contact_points.record_delivery(cp_id, ok, message, at)
        except UnknownContactPoint:
            pass  # deleted while the notice was on its way
        except Exception as exc:  # noqa: BLE001 (the delivery itself is done; only its record is lost)
            log.warning(
                "A delivery to contact point %s wasn't recorded (%s)", cp_id, type(exc).__name__
            )

    async def _close_group(self, group: _Group) -> None:
        """Every contact point of the notice is done: mark what was told (when it reached at
        least one), then let those instances be picked again."""
        try:
            if group.delivered and group.marks:
                await self._mark_told(group)
        except Exception as exc:  # noqa: BLE001 (logged; the next check tells it again)
            log.warning("Couldn't mark target %s as told (%s)", group.target_id, type(exc).__name__)
        finally:
            self._in_flight -= group.keys

    async def _mark_told(self, group: _Group) -> None:
        alerts = self._services.alerts
        async with self.instances_lock(group.target_id):
            current = await alerts.instances(group.target_id)
            told = [
                replace(i, last_notified_at=group.checked_at)
                if i.fingerprint in group.marks
                and i.state == "firing"
                and i.fired_at is not None
                and i.fired_at <= group.checked_at
                else i
                for i in current
            ]
            if told != current:
                await alerts.replace_instances(group.target_id, told)

    async def drain(self, timeout: float = DRAIN_SECONDS) -> bool:
        """Wait for the queued deliveries, at most `timeout` seconds; whether all finished."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while self._tasks:
            left = deadline - loop.time()
            if left <= 0:
                return False
            await asyncio.wait(set(self._tasks), timeout=left)
        return True

    async def close(self) -> None:
        """Cancel the deliveries still running (after `drain`) and wait until they have
        stopped."""
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
