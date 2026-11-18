"""The audit log: who did what, on which cluster, when, and how it ended.

Every change goes through `AuditLog.begin` before it is made ("no audit, no change": a failure
raises `AuditUnavailable` and the change isn't made) and `finish` once it is known how it ended.
Records never hold secret values: callers pass key names, never the values."""

import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal, Protocol

from pydantic import BaseModel
from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.requests import HTTPConnection

from omnikrux.audit.models import AuditRecord
from omnikrux.clusters.registry import ClusterInfo

log = logging.getLogger(__name__)

LOCAL_ACTOR = "local"

Action = Literal[
    "edit",
    "scale",
    "restart",
    "rollback",
    "delete",
    "evict",
    "cordon",
    "uncordon",
    "drain",
    "shell",
    "debug_container",
    "node_shell",
    "port_forward",
    "secret_reveal",
    "cluster_add",
    "cluster_remove",
    "cloud_account_add",
    "cloud_account_remove",
]
Outcome = Literal["started", "succeeded", "failed", "ended", "unknown"]
STARTED: Outcome = "started"

INTERRUPTED = "The console stopped before this finished."
NO_AUDIT = "Nothing was changed: the audit log can't be written ({reason})."
UNKNOWN_PROVIDER = "unknown"
MAX_MESSAGE = 2000
MAX_REASON = 200


def actor_of(conn: HTTPConnection) -> str:
    """Who is acting: always the single local user until logins arrive (Plan 5)."""
    return LOCAL_ACTOR


@dataclass
class AuditEntry:
    actor: str
    action: Action
    cluster_id: str
    namespace: str | None
    kind: str
    name: str | None
    details: dict | None = None
    diff: str | None = None
    cluster_name: str | None = None
    provider: str | None = None


class AuditUnavailable(Exception):
    """The record couldn't be written; `reason` says why in a few words."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def no_audit_message(exc: AuditUnavailable) -> str:
    return NO_AUDIT.format(reason=exc.reason)


def _reason(exc: BaseException) -> str:
    """A database error in the driver's own words (never the SQL or its parameters)."""
    source = getattr(exc, "orig", None) or exc
    lines = str(source).strip().splitlines()
    return (lines[0] if lines else type(source).__name__)[:MAX_REASON]


def _cap(message: str | None) -> str | None:
    return message[:MAX_MESSAGE] if message else message


def _now() -> datetime:
    return datetime.now(UTC)


def _utc(moment: datetime | None) -> datetime | None:
    """SQLite hands datetimes back without their zone; they were written in UTC."""
    if moment is None or moment.tzinfo is not None:
        return moment
    return moment.replace(tzinfo=UTC)


class ClusterLookup(Protocol):
    async def get(self, cluster_id: str) -> ClusterInfo: ...


class AuditOut(BaseModel):
    id: int
    started_at: datetime
    finished_at: datetime | None
    actor: str
    action: str
    cluster_id: str
    cluster_name: str
    provider: str
    namespace: str | None
    kind: str
    name: str | None
    outcome: str
    message: str | None
    diff: str | None
    details: dict | None


class AuditPage(BaseModel):
    records: list[AuditOut]  # newest first
    next_before: int | None  # pass as `before` for the next page; None: this is the last


def _out(row: AuditRecord) -> AuditOut:
    return AuditOut(
        id=row.id,
        started_at=_utc(row.started_at),
        finished_at=_utc(row.finished_at),
        actor=row.actor,
        action=row.action,
        cluster_id=row.cluster_id,
        cluster_name=row.cluster_name,
        provider=row.provider,
        namespace=row.namespace,
        kind=row.kind,
        name=row.name,
        outcome=row.outcome,
        message=row.message,
        diff=row.diff,
        details=json.loads(row.details) if row.details else None,
    )


class AuditLog:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession], registry: ClusterLookup):
        self._sessionmaker = sessionmaker
        self._registry = registry

    async def begin(self, entry: AuditEntry) -> int:
        """Write a `started` record and return its id. The cluster's name and provider are
        snapshotted (its id stands in for an unknown cluster). Raises AuditUnavailable."""
        try:
            try:
                info = await self._registry.get(entry.cluster_id)
                cluster_name, provider = info.name, str(info.provider.value)
            except KeyError:
                cluster_name, provider = entry.cluster_id, UNKNOWN_PROVIDER
            row = AuditRecord(
                started_at=_now(),
                finished_at=None,
                actor=entry.actor,
                action=entry.action,
                cluster_id=entry.cluster_id,
                cluster_name=cluster_name if entry.cluster_name is None else entry.cluster_name,
                provider=provider if entry.provider is None else entry.provider,
                namespace=entry.namespace,
                kind=entry.kind,
                name=entry.name,
                outcome=STARTED,
                message=None,
                diff=entry.diff,
                details=(
                    json.dumps(entry.details, ensure_ascii=False)  # searchable as written
                    if entry.details is not None
                    else None
                ),
            )
            async with self._sessionmaker() as session:
                session.add(row)
                await session.commit()
            return row.id
        except Exception as exc:
            reason = _reason(exc)
            log.warning("Could not write the audit record for %s (%s)", entry.action, reason)
            raise AuditUnavailable(reason) from exc

    async def finish(self, record_id: int, outcome: Outcome, message: str | None = None) -> bool:
        """Record how a `started` record ended. Never raises: a failure is logged as a WARNING,
        and so is a record that isn't open (it keeps how it first finished).
        Returns whether this call finished it."""
        try:
            async with self._sessionmaker() as session:
                result = await session.execute(
                    update(AuditRecord)
                    .where(AuditRecord.id == record_id, AuditRecord.outcome == STARTED)
                    .values(outcome=outcome, message=_cap(message), finished_at=_now())
                )
                await session.commit()
        except Exception as exc:  # noqa: BLE001 (the change already happened; say so in the log)
            log.warning(
                "Could not finish audit record %s as %s (%s)", record_id, outcome, _reason(exc)
            )
            return False
        if result.rowcount == 0:
            log.warning("Audit record %s isn't open; not finished as %s", record_id, outcome)
            return False
        return True

    async def finish_open(
        self,
        *,
        action: Action,
        cluster_id: str,
        namespace: str | None,
        name: str,
        outcome: Outcome,
        message: str | None = None,
    ) -> bool:
        """Finish the newest `started` record of `action` on that object; False if there is
        none (or it couldn't be read, which is logged). Never raises."""
        try:
            async with self._sessionmaker() as session:
                record_id = await session.scalar(
                    select(AuditRecord.id)
                    .where(
                        AuditRecord.outcome == STARTED,
                        AuditRecord.action == action,
                        AuditRecord.cluster_id == cluster_id,
                        AuditRecord.namespace == namespace,
                        AuditRecord.name == name,
                    )
                    .order_by(AuditRecord.id.desc())
                    .limit(1)
                )
        except Exception as exc:  # noqa: BLE001 (logged; the caller's work is already done)
            log.warning("Could not find the open %s audit record (%s)", action, _reason(exc))
            return False
        if record_id is None:
            return False
        await self.finish(record_id, outcome, message)
        return True

    async def list(
        self,
        *,
        cluster_id: str | None = None,
        action: str | None = None,
        text: str | None = None,
        outcome: Outcome | None = None,
        before: int | None = None,
        limit: int = 100,
    ) -> AuditPage:
        """Newest first. `text` matches (any case) the cluster, namespace, kind, name, actor,
        action, message or details; `before` continues from a page's `next_before`."""
        query = select(AuditRecord).order_by(AuditRecord.id.desc()).limit(limit + 1)
        if cluster_id is not None:
            query = query.where(AuditRecord.cluster_id == cluster_id)
        if action is not None:
            query = query.where(AuditRecord.action == action)
        if outcome is not None:
            query = query.where(AuditRecord.outcome == outcome)
        if before is not None:
            query = query.where(AuditRecord.id < before)
        if text:
            columns = (
                AuditRecord.cluster_name,
                AuditRecord.cluster_id,
                AuditRecord.namespace,
                AuditRecord.kind,
                AuditRecord.name,
                AuditRecord.actor,
                AuditRecord.action,
                AuditRecord.message,
                AuditRecord.details,
            )
            query = query.where(or_(*(c.icontains(text, autoescape=True) for c in columns)))
        async with self._sessionmaker() as session:
            rows = list((await session.execute(query)).scalars())
        more = len(rows) > limit
        rows = rows[:limit]
        return AuditPage(
            records=[_out(row) for row in rows], next_before=rows[-1].id if more else None
        )

    async def mark_interrupted(self) -> int:
        """At startup: records still `started` were cut off when the console stopped; they
        become `unknown`. Returns how many."""
        async with self._sessionmaker() as session:
            result = await session.execute(
                update(AuditRecord)
                .where(AuditRecord.outcome == STARTED)
                .values(outcome="unknown", message=INTERRUPTED)
            )
            await session.commit()
        return result.rowcount
