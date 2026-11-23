"""Dashboards on disk, with every version they have had.

A dashboard belongs to one project or one group, and its title (the document's own) is unique
for that owner. Every create, save and restore writes a new version row next to the dashboard's
current state, in one transaction. A save, a restore or a delete names the version it started
from; when another save landed since, it is refused (`VersionConflict`) and nothing changes.

The store trusts its caller to pass a validated, normalised document (`validate_dashboard`)."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Literal

from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from omnikrux.monitoring.dashboards.schema import OwnerKind, panel_count
from omnikrux.monitoring.models import (
    DashboardRow,
    DashboardVersionRow,
    GroupRecord,
    ProjectRecord,
    lock_first,
    now,
    utc,
)
from omnikrux.monitoring.projects.types import UnknownGroup, UnknownProject
from omnikrux.monitoring.sources.types import NameTaken

Origin = Literal["created", "copied", "saved", "restored"]

MAX_TITLE = 120
VERSION_CONFLICT = (
    "This dashboard was saved somewhere else since you started (version {current}). "
    "Review the differences before saving."
)


class UnknownDashboard(KeyError):
    pass


class UnknownVersion(KeyError):
    pass


class VersionConflict(Exception):
    """The dashboard is no longer at the version the change started from; nothing changed."""

    def __init__(self, current: int) -> None:
        super().__init__(VERSION_CONFLICT.format(current=current))
        self.current = current


@dataclass(frozen=True)
class DashboardRecord:
    id: str
    owner_kind: OwnerKind
    owner_id: str
    title: str
    spec: dict
    version: int
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True)
class DashboardSummary:
    id: str
    owner_kind: OwnerKind
    owner_id: str
    title: str
    version: int
    panel_count: int
    updated_at: datetime


@dataclass(frozen=True)
class VersionRecord:
    version: int
    saved_at: datetime
    title: str
    panel_count: int
    origin: Origin
    restored_from: int | None
    copied_from: str | None


@dataclass(frozen=True)
class DashboardRef:
    """A dashboard an owner's delete takes with it (frozen: it enters the review's token)."""

    id: str
    title: str
    versions: int


def _spec_text(spec: dict) -> str:
    """The document as stored: compact JSON in the document's own key order."""
    return json.dumps(spec, ensure_ascii=False, separators=(",", ":"))


def _record(row: DashboardRow) -> DashboardRecord:
    return DashboardRecord(
        id=row.id,
        owner_kind=row.owner_kind,  # type: ignore[arg-type]
        owner_id=row.owner_id,
        title=row.title,
        spec=json.loads(row.spec),
        version=row.version,
        created_at=utc(row.created_at),
        updated_at=utc(row.updated_at),
    )


_VERSION_COLUMNS = (
    DashboardVersionRow.version,
    DashboardVersionRow.saved_at,
    DashboardVersionRow.title,
    DashboardVersionRow.panel_count,
    DashboardVersionRow.origin,
    DashboardVersionRow.restored_from,
    DashboardVersionRow.copied_from,
)


def _version(values) -> VersionRecord:
    version, saved_at, title, panels, origin, restored_from, copied_from = values
    return VersionRecord(
        version=version,
        saved_at=utc(saved_at),
        title=title,
        panel_count=panels,
        origin=origin,
        restored_from=restored_from,
        copied_from=copied_from,
    )


def _version_row(
    id: str,
    version: int,
    spec: dict,
    text: str,
    moment: datetime,
    origin: Origin,
    *,
    restored_from: int | None = None,
    copied_from: str | None = None,
) -> DashboardVersionRow:
    """`text` is `spec` as stored (`_spec_text`), serialised once by the caller."""
    return DashboardVersionRow(
        dashboard_id=id,
        version=version,
        spec=text,
        title=spec["title"],
        panel_count=panel_count(spec),
        origin=origin,
        restored_from=restored_from,
        copied_from=copied_from,
        saved_at=moment,
    )


def _owned(owner_kind: OwnerKind, owner_id: str):
    return (DashboardRow.owner_kind == owner_kind, DashboardRow.owner_id == owner_id)


async def _owner_exists(session: AsyncSession, owner_kind: OwnerKind, owner_id: str) -> None:
    if owner_kind == "project":
        if await session.get(ProjectRecord, owner_id) is None:
            raise UnknownProject(owner_id)
    elif owner_kind == "group":
        if await session.get(GroupRecord, owner_id) is None:
            raise UnknownGroup(owner_id)
    else:
        raise ValueError(f"Unknown dashboard owner kind {owner_kind!r}")


async def _title_free(
    session: AsyncSession,
    owner_kind: OwnerKind,
    owner_id: str,
    title: str,
    *,
    besides: str | None = None,
) -> None:
    query = select(DashboardRow.id).where(
        *_owned(owner_kind, owner_id), DashboardRow.title == title
    )
    if besides is not None:
        query = query.where(DashboardRow.id != besides)
    if await session.scalar(query) is not None:
        raise NameTaken("dashboard", title)


async def _flush(session: AsyncSession, title: str) -> None:
    try:
        await session.flush()
    except IntegrityError:
        raise NameTaken("dashboard", title) from None


async def _current(session: AsyncSession, id: str):
    """(owner_kind, owner_id, version, created_at) of the dashboard; UnknownDashboard."""
    found = (
        await session.execute(
            select(
                DashboardRow.owner_kind,
                DashboardRow.owner_id,
                DashboardRow.version,
                DashboardRow.created_at,
            ).where(DashboardRow.id == id)
        )
    ).one_or_none()
    if found is None:
        raise UnknownDashboard(id)
    return found


class DashboardStore:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sessionmaker = sessionmaker

    # -- reading -------------------------------------------------------------------------------

    async def list(
        self, owner_kind: OwnerKind | None = None, owner_id: str | None = None
    ) -> list[DashboardSummary]:
        """Every dashboard, or an owner kind's, or one owner's; by title (any case)."""
        query = select(
            DashboardRow.id,
            DashboardRow.owner_kind,
            DashboardRow.owner_id,
            DashboardRow.title,
            DashboardRow.version,
            DashboardVersionRow.panel_count,
            DashboardRow.updated_at,
        ).join(
            DashboardVersionRow,
            (DashboardVersionRow.dashboard_id == DashboardRow.id)
            & (DashboardVersionRow.version == DashboardRow.version),
        )
        if owner_kind is not None:
            query = query.where(DashboardRow.owner_kind == owner_kind)
        if owner_id is not None:
            query = query.where(DashboardRow.owner_id == owner_id)
        async with self._sessionmaker() as session:
            found = (await session.execute(query)).all()
        summaries = [
            DashboardSummary(id, kind, owner, title, version, panels, utc(updated_at))
            for id, kind, owner, title, version, panels, updated_at in found
        ]
        return sorted(summaries, key=lambda s: (s.title.casefold(), s.id))

    async def get(self, id: str) -> DashboardRecord:
        async with self._sessionmaker() as session:
            row = await session.get(DashboardRow, id)
        if row is None:
            raise UnknownDashboard(id)
        return _record(row)

    async def versions(self, id: str) -> list[VersionRecord]:
        """Every version of the dashboard, newest first. UnknownDashboard."""
        async with self._sessionmaker() as session:
            await _current(session, id)
            found = await session.execute(
                select(*_VERSION_COLUMNS)
                .where(DashboardVersionRow.dashboard_id == id)
                .order_by(DashboardVersionRow.version.desc())
            )
            return [_version(values) for values in found]

    async def version(self, id: str, version: int) -> tuple[VersionRecord, dict]:
        """One version and its document. UnknownDashboard, UnknownVersion."""
        async with self._sessionmaker() as session:
            row = await session.get(DashboardVersionRow, (id, version))
            if row is None:
                await _current(session, id)
                raise UnknownVersion(version)
        record = _version(
            (
                row.version,
                row.saved_at,
                row.title,
                row.panel_count,
                row.origin,
                row.restored_from,
                row.copied_from,
            )
        )
        return record, json.loads(row.spec)

    async def unique_title(self, owner_kind: OwnerKind, owner_id: str, base: str) -> str:
        """`base`, or `base (2)`, `base (3)`… : the first title the owner doesn't have yet, cut
        so that it keeps to 120 characters."""
        base = base.strip()[:MAX_TITLE]
        async with self._sessionmaker() as session:
            taken = set(
                await session.scalars(
                    select(DashboardRow.title).where(*_owned(owner_kind, owner_id))
                )
            )
        title, n = base, 1
        while title in taken:
            n += 1
            suffix = f" ({n})"
            title = base[: MAX_TITLE - len(suffix)].rstrip() + suffix
        return title

    # -- writing -------------------------------------------------------------------------------

    async def create(
        self,
        owner_kind: OwnerKind,
        owner_id: str,
        spec: dict,
        *,
        origin: Origin = "created",
        copied_from: str | None = None,
    ) -> DashboardRecord:
        """A new dashboard at version 1, titled after the document. UnknownProject or
        UnknownGroup (the owner), NameTaken."""
        title = spec["title"]
        text = _spec_text(spec)
        moment = now()
        row = DashboardRow(
            id=uuid.uuid4().hex,
            owner_kind=owner_kind,
            owner_id=owner_id,
            title=title,
            spec=text,
            version=1,
            created_at=moment,
            updated_at=moment,
        )
        async with self._sessionmaker.begin() as session:
            # The owner can't be deleted between this check and the commit.
            await lock_first(session)
            await _owner_exists(session, owner_kind, owner_id)
            await _title_free(session, owner_kind, owner_id, title)
            session.add(row)
            session.add(
                _version_row(row.id, 1, spec, text, moment, origin, copied_from=copied_from)
            )
            await _flush(session, title)
        return _record(row)

    async def _advance(
        self,
        session: AsyncSession,
        id: str,
        base_version: int,
        spec: dict,
        origin: Origin,
        *,
        restored_from: int | None = None,
    ) -> DashboardRecord:
        """Write `spec` as the version after `base_version`, inside the caller's (locked)
        transaction. UnknownDashboard, VersionConflict, NameTaken."""
        owner_kind, owner_id, current, created_at = await _current(session, id)
        if current != base_version:
            raise VersionConflict(current)
        title = spec["title"]
        await _title_free(session, owner_kind, owner_id, title, besides=id)
        text = _spec_text(spec)
        moment = now()
        try:
            version = await session.scalar(
                update(DashboardRow)
                .where(DashboardRow.id == id, DashboardRow.version == base_version)
                .values(
                    version=DashboardRow.version + 1,
                    title=title,
                    spec=text,
                    updated_at=moment,
                )
                .returning(DashboardRow.version)
            )
        except IntegrityError:
            raise NameTaken("dashboard", title) from None
        if version is None:
            raise VersionConflict((await _current(session, id))[2])
        session.add(
            _version_row(id, version, spec, text, moment, origin, restored_from=restored_from)
        )
        await session.flush()
        return DashboardRecord(
            id=id,
            owner_kind=owner_kind,
            owner_id=owner_id,
            title=title,
            spec=json.loads(text),
            version=version,
            created_at=utc(created_at),
            updated_at=moment,
        )

    async def save(
        self, id: str, base_version: int, spec: dict, *, session: AsyncSession | None = None
    ) -> DashboardRecord:
        """Save `spec` as the next version when the dashboard is still at `base_version`.
        UnknownDashboard, VersionConflict (nothing changed), NameTaken. With `session` (a
        transaction that already holds the write lock), the save is part of the caller's
        transaction and commits with it."""
        if session is not None:
            return await self._advance(session, id, base_version, spec, "saved")
        async with self._sessionmaker.begin() as own:
            await lock_first(own)
            return await self._advance(own, id, base_version, spec, "saved")

    async def restore(self, id: str, version: int, base_version: int) -> DashboardRecord:
        """Save an earlier version's document as the next version when the dashboard is still at
        `base_version`. UnknownDashboard, VersionConflict, UnknownVersion, NameTaken."""
        async with self._sessionmaker.begin() as session:
            await lock_first(session)
            current = (await _current(session, id))[2]
            if current != base_version:
                raise VersionConflict(current)
            old = await session.scalar(
                select(DashboardVersionRow.spec).where(
                    DashboardVersionRow.dashboard_id == id, DashboardVersionRow.version == version
                )
            )
            if old is None:
                raise UnknownVersion(version)
            return await self._advance(
                session, id, base_version, json.loads(old), "restored", restored_from=version
            )

    async def delete(self, id: str, version: int) -> None:
        """Delete the dashboard and all its versions when it is still at `version`.
        UnknownDashboard, VersionConflict (nothing changed)."""
        async with self._sessionmaker.begin() as session:
            removed = await session.scalar(
                delete(DashboardRow)
                .where(DashboardRow.id == id, DashboardRow.version == version)
                .returning(DashboardRow.id)
            )
            if removed is None:
                raise VersionConflict((await _current(session, id))[2])
            await session.execute(
                delete(DashboardVersionRow).where(DashboardVersionRow.dashboard_id == id)
            )

    # -- owners --------------------------------------------------------------------------------

    async def owned_refs(
        self, owner_kind: OwnerKind, owner_id: str, *, session: AsyncSession | None = None
    ) -> list[DashboardRef]:
        """The owner's dashboards by title, with how many versions each has. Pass a delete's own
        session to recompute them in its transaction."""
        if session is not None:
            return await self._refs(session, owner_kind, owner_id)
        async with self._sessionmaker() as own:
            return await self._refs(own, owner_kind, owner_id)

    async def _refs(
        self, session: AsyncSession, owner_kind: OwnerKind, owner_id: str
    ) -> list[DashboardRef]:
        found = await session.execute(
            select(DashboardRow.id, DashboardRow.title, func.count(DashboardVersionRow.version))
            .outerjoin(DashboardVersionRow, DashboardVersionRow.dashboard_id == DashboardRow.id)
            .where(*_owned(owner_kind, owner_id))
            .group_by(DashboardRow.id, DashboardRow.title)
        )
        refs = [DashboardRef(id, title, versions) for id, title, versions in found]
        return sorted(refs, key=lambda r: (r.title.casefold(), r.id))

    async def delete_owned(
        self, owner_kind: OwnerKind, owner_id: str, *, session: AsyncSession
    ) -> list[DashboardRef]:
        """Delete the owner's dashboards and their versions inside the owner's delete
        transaction (`session`; it commits); return what was deleted."""
        refs = await self._refs(session, owner_kind, owner_id)
        if refs:
            ids = [r.id for r in refs]
            await session.execute(
                delete(DashboardVersionRow).where(DashboardVersionRow.dashboard_id.in_(ids))
            )
            await session.execute(delete(DashboardRow).where(DashboardRow.id.in_(ids)))
        return refs
