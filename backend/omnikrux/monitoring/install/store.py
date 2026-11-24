"""The install records: what OmniKrux installed into each cluster, in what state, and which
sources it made. One record per cluster; nothing in it is secret (contact points keep only a
digest of what was last applied)."""

from __future__ import annotations

import json
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, fields
from datetime import datetime
from types import MappingProxyType
from typing import Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from omnikrux.monitoring.install.settings import Component, InstallSettings, Resources
from omnikrux.monitoring.models import InstallRow, lock_first, now, utc

InstallState = Literal["installing", "installed", "failed", "cancelled", "uninstalling"]

INTERRUPTED = (
    "OmniKrux stopped during the {what}. What Helm applied stays as Helm left it. "
    "Open Monitoring tools to see what's there, then run it again."
)

_RUNNING = ("installing", "uninstalling")
# The keys `finish` takes for the sources an install made, and the columns they fill.
_SOURCE_COLUMNS = {
    "prometheus": "prometheus_source_id",
    "alertmanager": "alertmanager_source_id",
    "loki": "loki_source_id",
}


class InstallBusy(Exception):
    """Another job is installing into or uninstalling from the cluster."""

    def __init__(self, state: str):
        super().__init__(state)
        self.state = state


@dataclass(frozen=True)
class InstallRecord:
    id: str
    cluster_id: str
    namespace: str
    components: tuple[Component, ...]
    settings: InstallSettings
    charts: Mapping[str, str]
    state: InstallState
    message: str | None
    job_id: str | None
    project_id: str | None
    prometheus_source_id: str | None
    alertmanager_source_id: str | None
    loki_source_id: str | None
    contacts_digest: str | None
    contacts_applied_at: datetime | None
    contacts_message: str | None
    created_at: datetime
    updated_at: datetime
    installed_at: datetime | None


def settings_json(settings: InstallSettings) -> str:
    return json.dumps(asdict(settings), sort_keys=True)


def settings_from_json(text: str) -> InstallSettings:
    values = json.loads(text)
    for field in fields(InstallSettings):
        if field.type in (Resources, "Resources"):
            values[field.name] = Resources(**values[field.name])
    return InstallSettings(**values)


def _record(row: InstallRow) -> InstallRecord:
    return InstallRecord(
        id=row.id,
        cluster_id=row.cluster_id,
        namespace=row.namespace,
        components=tuple(json.loads(row.components)),
        settings=settings_from_json(row.settings),
        charts=MappingProxyType(json.loads(row.charts)),
        state=row.state,  # type: ignore[arg-type]
        message=row.message,
        job_id=row.job_id,
        project_id=row.project_id,
        prometheus_source_id=row.prometheus_source_id,
        alertmanager_source_id=row.alertmanager_source_id,
        loki_source_id=row.loki_source_id,
        contacts_digest=row.contacts_digest,
        contacts_applied_at=utc(row.contacts_applied_at),
        contacts_message=row.contacts_message,
        created_at=utc(row.created_at),  # type: ignore[arg-type]
        updated_at=utc(row.updated_at),  # type: ignore[arg-type]
        installed_at=utc(row.installed_at),
    )


async def _by_cluster(session: AsyncSession, cluster_id: str) -> InstallRow | None:
    return await session.scalar(select(InstallRow).where(InstallRow.cluster_id == cluster_id))


async def _existing(session: AsyncSession, cluster_id: str) -> InstallRow:
    row = await _by_cluster(session, cluster_id)
    if row is None:
        raise KeyError(cluster_id)
    return row


def _check_free(row: InstallRow, job_id: str) -> None:
    if row.state in _RUNNING and row.job_id != job_id:
        raise InstallBusy(row.state)


class InstallStore:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sessionmaker = sessionmaker

    async def get(
        self, cluster_id: str, *, session: AsyncSession | None = None
    ) -> InstallRecord | None:
        """The cluster's record; read in `session` when given (a review that must see the
        record in its own transaction)."""
        if session is not None:
            row = await _by_cluster(session, cluster_id)
            return _record(row) if row is not None else None
        async with self._sessionmaker() as own:
            row = await _by_cluster(own, cluster_id)
            return _record(row) if row is not None else None

    async def list(self) -> list[InstallRecord]:
        async with self._sessionmaker() as session:
            rows = await session.scalars(select(InstallRow).order_by(InstallRow.created_at))
            return [_record(row) for row in rows]

    async def begin(
        self,
        cluster_id: str,
        namespace: str,
        components: Sequence[Component],
        settings: InstallSettings,
        charts: Mapping[str, str],
        *,
        job_id: str,
        project_id: str | None,
    ) -> InstallRecord:
        """Create the cluster's record or update it, in state `installing`. InstallBusy when
        another job's install or uninstall is running there."""
        moment = now()
        async with self._sessionmaker.begin() as session:
            await lock_first(session)
            row = await _by_cluster(session, cluster_id)
            if row is None:
                row = InstallRow(id=uuid.uuid4().hex, cluster_id=cluster_id, created_at=moment)
                session.add(row)
            else:
                _check_free(row, job_id)
            row.namespace = namespace
            row.components = json.dumps(list(components))
            row.settings = settings_json(settings)
            row.charts = json.dumps(dict(charts), sort_keys=True)
            row.state = "installing"
            row.message = None
            row.job_id = job_id
            row.project_id = project_id
            row.updated_at = moment
            await session.flush()
            return _record(row)

    async def finish(
        self,
        cluster_id: str,
        state: InstallState,
        message: str | None,
        *,
        sources: Mapping[str, str | None] | None = None,
        job_id: str | None = None,
    ) -> InstallRecord | None:
        """End a job: the state and message, and the sources it made (`prometheus`,
        `alertmanager`, `loki`; a key left out keeps what the record has). KeyError if the
        cluster has no record. With `job_id`, only that job's running record is finished: when
        another job has begun since, or the record was already finished, nothing changes and
        None is returned (a stale job never ends a newer one's record)."""
        moment = now()
        async with self._sessionmaker.begin() as session:
            await lock_first(session)
            row = await _existing(session, cluster_id)
            if job_id is not None and (row.job_id != job_id or row.state not in _RUNNING):
                return None
            row.state = state
            row.message = message
            row.updated_at = moment
            if state == "installed":
                row.installed_at = moment
            for key, source_id in (sources or {}).items():
                setattr(row, _SOURCE_COLUMNS[key], source_id)
            return _record(row)

    async def attach_job(self, cluster_id: str, old: str, new: str) -> bool:
        """Hand the running record begun under `old` to job `new`. False when it isn't
        running under `old` any more (another job holds it, or it was finished)."""
        async with self._sessionmaker.begin() as session:
            await lock_first(session)
            row = await _by_cluster(session, cluster_id)
            if row is None or row.job_id != old or row.state not in _RUNNING:
                return False
            row.job_id = new
            row.updated_at = now()
            return True

    async def begin_uninstall(self, cluster_id: str, *, job_id: str) -> InstallRecord:
        """State `uninstalling`. KeyError without a record; InstallBusy when another job runs."""
        async with self._sessionmaker.begin() as session:
            await lock_first(session)
            row = await _existing(session, cluster_id)
            _check_free(row, job_id)
            row.state = "uninstalling"
            row.message = None
            row.job_id = job_id
            row.updated_at = now()
            return _record(row)

    async def remove(self, cluster_id: str, *, job_id: str | None = None) -> bool:
        """Delete the cluster's record. With `job_id`, only while that job's uninstall holds it
        (a newer job's record is never removed). Whether a record was removed."""
        async with self._sessionmaker.begin() as session:
            await lock_first(session)
            row = await _by_cluster(session, cluster_id)
            if row is None:
                return False
            if job_id is not None and (row.job_id != job_id or row.state != "uninstalling"):
                return False
            await session.delete(row)
            return True

    async def set_contacts(
        self, cluster_id: str, *, digest: str | None, message: str | None, at: datetime | None
    ) -> InstallRecord:
        """Keep the digest of the contact points' configuration last applied, and how it went."""
        async with self._sessionmaker.begin() as session:
            row = await _existing(session, cluster_id)
            row.contacts_digest = digest
            row.contacts_message = message
            row.contacts_applied_at = at
            row.updated_at = now()
            return _record(row)

    async def set_contacts_message(self, cluster_id: str, message: str | None) -> None:
        """Keep (or clear) why the contact points couldn't be worked out or applied, leaving
        the digest of what was last applied as it is. A cluster without a record is fine."""
        async with self._sessionmaker.begin() as session:
            row = await _by_cluster(session, cluster_id)
            if row is not None:
                row.contacts_message = message
                row.updated_at = now()

    async def mark_interrupted(self, at: datetime) -> int:
        """At startup nothing is running: every install or uninstall still marked as running
        stopped with OmniKrux. Returns how many records changed."""
        async with self._sessionmaker.begin() as session:
            rows = await session.scalars(select(InstallRow).where(InstallRow.state.in_(_RUNNING)))
            count = 0
            for row in rows:
                what = "install" if row.state == "installing" else "uninstall"
                row.state = "failed"
                row.message = INTERRUPTED.format(what=what)
                row.updated_at = at
                count += 1
            return count
