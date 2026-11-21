"""Projects, their links to sources, and groups on disk.

A group only lists projects: joining or leaving one never moves a project or changes its links.
Deleting a project, or a group with dashboards, goes through a review; the delete recomputes it
in the same transaction and refuses (`ReviewChanged`) when it no longer matches the token the
user saw. Either delete takes the owner's dashboards and their versions with it. Writes that read
what a delete could remove (a link's project and source, a group's members) take the write lock
first, so a delete can't land between the read and the write."""

from __future__ import annotations

import json
import uuid
from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timedelta

from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from omnikrux.monitoring.dashboards.store import DashboardStore
from omnikrux.monitoring.models import (
    GroupMemberRecord,
    GroupRecord,
    ProjectRecord,
    ProjectSourceRecord,
    SourceRecord,
    lock_first,
    now,
    utc,
    writing,
)
from omnikrux.monitoring.projects.types import (
    Group,
    GroupDeleteReview,
    GroupRef,
    KeptSource,
    Link,
    Matcher,
    Project,
    ProjectDeleteReview,
    ProjectRef,
    ReviewChanged,
    SourceDeleteReview,
    SourceRef,
    UnknownGroup,
    UnknownProject,
    review_token,
)
from omnikrux.monitoring.sources.store import NewSource, SourceStore
from omnikrux.monitoring.sources.types import (
    FilterOrigin,
    NameTaken,
    ProjectKind,
    SourceConfig,
    clean_name,
)


@dataclass(frozen=True)
class SetupLink:
    """One source of a project being set up: a saved one (`source_id`) or a new one (`new`), and
    the filter the project uses on it."""

    matchers: tuple[Matcher, ...]
    origin: FilterOrigin
    source_id: str | None = None
    new: NewSource | None = None


def _matchers_json(matchers: Iterable[Matcher]) -> str:
    return json.dumps([asdict(m) for m in matchers])


def _matchers(text: str) -> tuple[Matcher, ...]:
    return tuple(Matcher(**m) for m in json.loads(text))


def _link(row: ProjectSourceRecord) -> Link:
    return Link(
        project_id=row.project_id,
        source_id=row.source_id,
        matchers=_matchers(row.filter),
        origin=row.filter_origin,  # type: ignore[arg-type]
        created_at=utc(row.created_at),
    )


def _by_name(items: Iterable) -> tuple:
    return tuple(sorted(items, key=lambda item: (item.name.casefold(), item.id)))


def _sealed[R: (ProjectDeleteReview, SourceDeleteReview, GroupDeleteReview)](review: R) -> R:
    """The review with its token: the fingerprint of every other field."""
    fields = asdict(review)
    del fields["token"]
    return replace(review, token=review_token(fields))


async def _name_free(session: AsyncSession, record, kind: str, name: str) -> None:
    if await session.scalar(select(record.id).where(record.name == name)) is not None:
        raise NameTaken(kind, name)


async def _flush(session: AsyncSession, kind: str, name: str) -> None:
    try:
        await session.flush()
    except IntegrityError:
        raise NameTaken(kind, name) from None


async def _project_row(session: AsyncSession, id: str) -> ProjectRecord:
    row = await session.get(ProjectRecord, id)
    if row is None:
        raise UnknownProject(id)
    return row


async def _known_projects(session: AsyncSession, ids: Iterable[str]) -> tuple[str, ...]:
    """The ids once each, in the order given; UnknownProject for the first that doesn't exist."""
    wanted = tuple(dict.fromkeys(ids))
    found = set(await session.scalars(select(ProjectRecord.id).where(ProjectRecord.id.in_(wanted))))
    for id in wanted:
        if id not in found:
            raise UnknownProject(id)
    return wanted


class ProjectStore:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sessionmaker = sessionmaker

    def _dashboards(self, dashboards: DashboardStore | None) -> DashboardStore:
        return dashboards if dashboards is not None else DashboardStore(self._sessionmaker)

    # -- reading -------------------------------------------------------------------------------

    async def _projects(self, session: AsyncSession, ids: Sequence[str] | None) -> list[Project]:
        query = select(ProjectRecord)
        links_query = select(ProjectSourceRecord).order_by(
            ProjectSourceRecord.created_at, ProjectSourceRecord.source_id
        )
        members_query = select(GroupMemberRecord)
        if ids is not None:
            query = query.where(ProjectRecord.id.in_(ids))
            links_query = links_query.where(ProjectSourceRecord.project_id.in_(ids))
            members_query = members_query.where(GroupMemberRecord.project_id.in_(ids))
        links: dict[str, list[Link]] = defaultdict(list)
        for row in await session.scalars(links_query):
            links[row.project_id].append(_link(row))
        groups: dict[str, list[str]] = defaultdict(list)
        for row in await session.scalars(members_query):
            groups[row.project_id].append(row.group_id)
        return list(
            _by_name(
                Project(
                    id=row.id,
                    name=row.name,
                    kind=row.kind,  # type: ignore[arg-type]
                    cluster_id=row.cluster_id,
                    links=tuple(links[row.id]),
                    group_ids=tuple(sorted(groups[row.id])),
                    created_at=utc(row.created_at),
                    updated_at=utc(row.updated_at),
                )
                for row in await session.scalars(query)
            )
        )

    async def list(self) -> list[Project]:
        async with self._sessionmaker() as session:
            return await self._projects(session, None)

    async def get(self, id: str) -> Project:
        async with self._sessionmaker() as session:
            found = await self._projects(session, [id])
        if not found:
            raise UnknownProject(id)
        return found[0]

    async def projects_using(self, source_id: str) -> list[ProjectRef]:
        async with self._sessionmaker() as session:
            return await self._using(session, source_id)

    async def _using(self, session: AsyncSession, source_id: str) -> list[ProjectRef]:
        rows = await session.execute(
            select(ProjectRecord.id, ProjectRecord.name)
            .join(ProjectSourceRecord, ProjectSourceRecord.project_id == ProjectRecord.id)
            .where(ProjectSourceRecord.source_id == source_id)
        )
        return list(_by_name(ProjectRef(id, name) for id, name in rows))

    # -- writing -------------------------------------------------------------------------------

    async def create(
        self,
        name: str,
        kind: ProjectKind,
        cluster_id: str | None,
        *,
        session: AsyncSession | None = None,
    ) -> Project:
        name = clean_name(name)
        moment = now()
        row = ProjectRecord(
            id=uuid.uuid4().hex,
            name=name,
            kind=kind,
            cluster_id=cluster_id,
            created_at=moment,
            updated_at=moment,
        )
        async with writing(self._sessionmaker, session) as s:
            await _name_free(s, ProjectRecord, "project", name)
            s.add(row)
            await _flush(s, "project", name)
        return Project(row.id, name, kind, cluster_id, (), (), moment, moment)

    async def rename(self, id: str, name: str) -> Project:
        name = clean_name(name)
        async with self._sessionmaker.begin() as session:
            await lock_first(session)
            row = await _project_row(session, id)
            if row.name != name:
                await _name_free(session, ProjectRecord, "project", name)
                row.name = name
                row.updated_at = now()
                await _flush(session, "project", name)
        return await self.get(id)

    async def link(
        self,
        project_id: str,
        source_id: str,
        matchers: Sequence[Matcher],
        origin: FilterOrigin,
        *,
        session: AsyncSession | None = None,
        created_at: datetime | None = None,
    ) -> Link:
        """Link the source to the project with that filter, or replace the filter of an existing
        link. UnknownProject or KeyError (the source) if either doesn't exist. A new link is
        dated `created_at` (default now): links are listed in that order."""
        async with writing(self._sessionmaker, session) as s:
            await lock_first(s)
            await _project_row(s, project_id)
            if await s.get(SourceRecord, source_id) is None:
                raise KeyError(source_id)
            row = await s.get(ProjectSourceRecord, (project_id, source_id))
            if row is None:
                row = ProjectSourceRecord(
                    project_id=project_id, source_id=source_id, created_at=created_at or now()
                )
                s.add(row)
            row.filter = _matchers_json(matchers)
            row.filter_origin = origin
            await s.flush()
            return _link(row)

    async def set_up(
        self,
        name: str,
        kind: ProjectKind,
        cluster_id: str | None,
        links: Sequence[SetupLink],
        sources: SourceStore,
    ) -> Project:
        """Create the project, its new sources (created by it) and its links in one transaction:
        all of them or, on NameTaken, UnknownProject or KeyError (a saved source that is gone),
        none. The links keep the order given."""
        async with self._sessionmaker.begin() as session:
            await lock_first(session)
            project = await self.create(name, kind, cluster_id, session=session)
            moment = now()
            for i, link in enumerate(links):
                if link.new is not None:
                    new = replace(link.new, created_by_project_id=project.id)
                    source_id = (await sources.create(new, session=session)).id
                elif link.source_id is not None:
                    source_id = link.source_id
                else:
                    raise ValueError("A setup link needs a saved source or a new one")
                # One moment for the whole setup; a microsecond apart keeps the order given.
                await self.link(
                    project.id,
                    source_id,
                    link.matchers,
                    link.origin,
                    session=session,
                    created_at=moment + timedelta(microseconds=i),
                )
        return await self.get(project.id)

    async def unlink(self, project_id: str, source_id: str) -> None:
        """KeyError if the project doesn't link that source."""
        async with self._sessionmaker.begin() as session:
            removed = await session.scalar(
                delete(ProjectSourceRecord)
                .where(
                    ProjectSourceRecord.project_id == project_id,
                    ProjectSourceRecord.source_id == source_id,
                )
                .returning(ProjectSourceRecord.source_id)
            )
            if removed is None:
                raise KeyError((project_id, source_id))

    # -- reviews and deletes -------------------------------------------------------------------

    async def _review(
        self, session: AsyncSession, id: str, dashboards: DashboardStore | None = None
    ) -> ProjectDeleteReview:
        project = await _project_row(session, id)
        linked = set(
            await session.scalars(
                select(ProjectSourceRecord.source_id).where(ProjectSourceRecord.project_id == id)
            )
        )
        sources = {
            row.id: row
            for row in await session.scalars(
                select(SourceRecord).where(
                    (SourceRecord.created_by_project_id == id) | SourceRecord.id.in_(linked)
                )
            )
        }
        others: dict[str, list[str]] = defaultdict(list)
        for source_id, name in await session.execute(
            select(ProjectSourceRecord.source_id, ProjectRecord.name)
            .join(ProjectRecord, ProjectRecord.id == ProjectSourceRecord.project_id)
            .where(ProjectSourceRecord.source_id.in_(list(sources)), ProjectRecord.id != id)
        ):
            others[source_id].append(name)
        removed, kept, unlinked = [], [], []
        for row in sources.values():
            if row.created_by_project_id != id:
                unlinked.append(SourceRef(row.id, row.name))
            elif others[row.id]:
                kept.append(KeptSource(row.id, row.name, tuple(sorted(others[row.id]))))
            else:
                removed.append(SourceRef(row.id, row.name))
        groups = [
            GroupRef(group_id, name)
            for group_id, name in await session.execute(
                select(GroupRecord.id, GroupRecord.name)
                .join(GroupMemberRecord, GroupMemberRecord.group_id == GroupRecord.id)
                .where(GroupMemberRecord.project_id == id)
            )
        ]
        review = ProjectDeleteReview(
            project_id=id,
            name=project.name,
            sources_removed=_by_name(removed),
            sources_kept=_by_name(kept),
            sources_unlinked=_by_name(unlinked),
            groups_left=_by_name(groups),
            dashboards=tuple(
                await self._dashboards(dashboards).owned_refs("project", id, session=session)
            ),
            token="",
        )
        return _sealed(review)

    async def delete_review(
        self, id: str, dashboards: DashboardStore | None = None
    ) -> ProjectDeleteReview:
        """What deleting the project would do. UnknownProject if it doesn't exist."""
        async with self._sessionmaker() as session:
            return await self._review(session, id, dashboards)

    async def delete(
        self,
        id: str,
        token: str,
        sources: SourceStore,
        dashboards: DashboardStore | None = None,
    ) -> ProjectDeleteReview:
        """Delete the project, the sources only it used and created, its links, its group
        memberships and its dashboards with their versions, in one transaction. ReviewChanged
        (nothing changed) when the review no longer matches `token`."""
        async with self._sessionmaker.begin() as session:
            # Write first: SQLite then holds the write lock, so nothing can change in between.
            locked = await session.scalar(
                update(ProjectRecord)
                .where(ProjectRecord.id == id)
                .values(updated_at=ProjectRecord.updated_at)
                .returning(ProjectRecord.id)
            )
            if locked is None:
                raise UnknownProject(id)
            review = await self._review(session, id, dashboards)
            if review.token != token:
                raise ReviewChanged()
            await self._dashboards(dashboards).delete_owned("project", id, session=session)
            for source in review.sources_removed:
                await sources.delete(source.id, session=session)
            if review.sources_kept:
                await session.execute(
                    update(SourceRecord)
                    .where(SourceRecord.id.in_([s.id for s in review.sources_kept]))
                    .values(created_by_project_id=None)
                )
            await session.execute(
                delete(ProjectSourceRecord).where(ProjectSourceRecord.project_id == id)
            )
            await session.execute(
                delete(GroupMemberRecord).where(GroupMemberRecord.project_id == id)
            )
            await session.execute(delete(ProjectRecord).where(ProjectRecord.id == id))
        return review

    async def source_delete_review(
        self, source: SourceConfig, *, session: AsyncSession | None = None
    ) -> SourceDeleteReview:
        """Which projects deleting the source would take it from. Pass the delete's own session
        to recompute it in the same transaction before deleting."""
        if session is not None:
            return await self._source_review(session, source.id, source.name)
        async with self._sessionmaker() as own:
            return await self._source_review(own, source.id, source.name)

    async def _source_review(
        self, session: AsyncSession, source_id: str, name: str
    ) -> SourceDeleteReview:
        projects = await self._using(session, source_id)
        return _sealed(SourceDeleteReview(source_id, name, tuple(projects), token=""))

    async def delete_source(
        self, source_id: str, token: str, sources: SourceStore
    ) -> SourceDeleteReview:
        """Delete the source and every project's link to it, in one transaction. KeyError if it
        doesn't exist; ReviewChanged (nothing changed) when the review no longer matches `token`."""
        async with self._sessionmaker.begin() as session:
            # Write first: SQLite then holds the write lock, so no link can be made in between.
            name = await session.scalar(
                update(SourceRecord)
                .where(SourceRecord.id == source_id)
                .values(updated_at=SourceRecord.updated_at)
                .returning(SourceRecord.name)
            )
            if name is None:
                raise KeyError(source_id)
            review = await self._source_review(session, source_id, name)
            if review.token != token:
                raise ReviewChanged()
            await sources.delete(source_id, session=session)
        return review


class GroupStore:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sessionmaker = sessionmaker

    def _dashboards(self, dashboards: DashboardStore | None) -> DashboardStore:
        return dashboards if dashboards is not None else DashboardStore(self._sessionmaker)

    async def _groups(self, session: AsyncSession, ids: Sequence[str] | None) -> list[Group]:
        query = select(GroupRecord)
        members_query = select(GroupMemberRecord)
        if ids is not None:
            query = query.where(GroupRecord.id.in_(ids))
            members_query = members_query.where(GroupMemberRecord.group_id.in_(ids))
        members: dict[str, list[str]] = defaultdict(list)
        for row in await session.scalars(members_query):
            members[row.group_id].append(row.project_id)
        return list(
            _by_name(
                Group(
                    id=row.id,
                    name=row.name,
                    project_ids=tuple(sorted(members[row.id])),
                    created_at=utc(row.created_at),
                    updated_at=utc(row.updated_at),
                )
                for row in await session.scalars(query)
            )
        )

    async def list(self) -> list[Group]:
        async with self._sessionmaker() as session:
            return await self._groups(session, None)

    async def get(self, id: str) -> Group:
        async with self._sessionmaker() as session:
            found = await self._groups(session, [id])
        if not found:
            raise UnknownGroup(id)
        return found[0]

    async def create(self, name: str, project_ids: Sequence[str]) -> Group:
        name = clean_name(name)
        moment = now()
        row = GroupRecord(id=uuid.uuid4().hex, name=name, created_at=moment, updated_at=moment)
        async with self._sessionmaker.begin() as session:
            await lock_first(session)
            members = await _known_projects(session, project_ids)
            await _name_free(session, GroupRecord, "group", name)
            session.add(row)
            session.add_all(GroupMemberRecord(group_id=row.id, project_id=p) for p in members)
            await _flush(session, "group", name)
        return await self.get(row.id)

    async def update(
        self, id: str, *, name: str | None = None, project_ids: Sequence[str] | None = None
    ) -> Group:
        """Rename the group and/or replace its members. UnknownGroup, UnknownProject."""
        async with self._sessionmaker.begin() as session:
            await lock_first(session)
            row = await session.get(GroupRecord, id)
            if row is None:
                raise UnknownGroup(id)
            if name is not None:
                name = clean_name(name)
                if name != row.name:
                    await _name_free(session, GroupRecord, "group", name)
                    row.name = name
            if project_ids is not None:
                members = await _known_projects(session, project_ids)
                await session.execute(
                    delete(GroupMemberRecord).where(GroupMemberRecord.group_id == id)
                )
                session.add_all(GroupMemberRecord(group_id=id, project_id=p) for p in members)
            row.updated_at = now()
            await _flush(session, "group", row.name)
        return await self.get(id)

    async def _review(
        self, session: AsyncSession, id: str, dashboards: DashboardStore | None
    ) -> GroupDeleteReview:
        name = await session.scalar(select(GroupRecord.name).where(GroupRecord.id == id))
        if name is None:
            raise UnknownGroup(id)
        refs = await self._dashboards(dashboards).owned_refs("group", id, session=session)
        return _sealed(GroupDeleteReview(id, name, tuple(refs), token=""))

    async def delete_review(
        self, id: str, dashboards: DashboardStore | None = None
    ) -> GroupDeleteReview:
        """What deleting the group would do: the dashboards it takes. UnknownGroup."""
        async with self._sessionmaker() as session:
            return await self._review(session, id, dashboards)

    async def delete(
        self, id: str, token: str | None = None, dashboards: DashboardStore | None = None
    ) -> GroupDeleteReview:
        """Remove the group, its member list and its dashboards with their versions, in one
        transaction; the projects stay as they are. A group with dashboards needs the token of a
        review that still matches; one without deletes without a token (a token given must
        still match). UnknownGroup; ReviewChanged (nothing changed)."""
        async with self._sessionmaker.begin() as session:
            # Write first: nothing can change between the recomputed review and the delete.
            await lock_first(session)
            review = await self._review(session, id, dashboards)
            if not review.accepts(token):
                raise ReviewChanged()
            await self._dashboards(dashboards).delete_owned("group", id, session=session)
            await session.execute(delete(GroupMemberRecord).where(GroupMemberRecord.group_id == id))
            await session.execute(delete(GroupRecord).where(GroupRecord.id == id))
        return review
