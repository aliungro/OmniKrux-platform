"""Monitoring tables. Kept identical to migrations 0007 and 0008 (`tests/test_db.py` compares
them)."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    false,
    update,
)
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.orm import Mapped, mapped_column

from omnikrux.db import Base


def now() -> datetime:
    return datetime.now(UTC)


def utc(moment: datetime | None) -> datetime | None:
    """SQLite hands datetimes back without their zone; they were written in UTC."""
    if moment is None or moment.tzinfo is not None:
        return moment
    return moment.replace(tzinfo=UTC)


@asynccontextmanager
async def writing(
    sessionmaker: async_sessionmaker[AsyncSession], session: AsyncSession | None
) -> AsyncIterator[AsyncSession]:
    """The caller's session (it commits once, at the end of its operation) or a new one that
    commits when the block ends."""
    if session is not None:
        yield session
        return
    async with sessionmaker.begin() as own:
        yield own


class SourceRecord(Base):
    __tablename__ = "monitoring_sources"
    __table_args__ = (UniqueConstraint("name", name="uq_monitoring_sources_name"),)

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    type: Mapped[str] = mapped_column(String)
    reach: Mapped[str] = mapped_column(String)
    url: Mapped[str | None] = mapped_column(String)
    cluster_id: Mapped[str | None] = mapped_column(String)
    namespace: Mapped[str | None] = mapped_column(String)
    service: Mapped[str | None] = mapped_column(String)
    port: Mapped[str | None] = mapped_column(String)
    scheme: Mapped[str] = mapped_column(String, server_default="http")
    path_prefix: Mapped[str] = mapped_column(String, server_default="")
    auth_type: Mapped[str] = mapped_column(String)
    # JSON: username, header_name, client_cert_pem (none of them secret).
    auth_settings: Mapped[str] = mapped_column(Text)
    header_names: Mapped[str] = mapped_column(Text)  # JSON list; the values are secrets
    ca_pem: Mapped[str | None] = mapped_column(Text)
    # SecretBox-encrypted JSON: password, token, api_key, client_key_pem, headers {name: value}.
    secret_encrypted: Mapped[bytes | None] = mapped_column(LargeBinary)
    created_by_project_id: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    check_ok: Mapped[bool | None] = mapped_column(Boolean)
    check_message: Mapped[str | None] = mapped_column(Text)
    version: Mapped[str | None] = mapped_column(String)


class ProjectRecord(Base):
    __tablename__ = "monitoring_projects"
    __table_args__ = (UniqueConstraint("name", name="uq_monitoring_projects_name"),)

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    kind: Mapped[str] = mapped_column(String)
    cluster_id: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class ProjectSourceRecord(Base):
    """A project's link to a source, with the filter that keeps the project's data apart."""

    __tablename__ = "monitoring_project_sources"

    project_id: Mapped[str] = mapped_column(String, primary_key=True)
    source_id: Mapped[str] = mapped_column(String, primary_key=True, index=True)
    filter: Mapped[str] = mapped_column(Text)  # JSON list of {label, op, value}
    filter_origin: Mapped[str] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class GroupRecord(Base):
    __tablename__ = "monitoring_groups"
    __table_args__ = (UniqueConstraint("name", name="uq_monitoring_groups_name"),)

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class GroupMemberRecord(Base):
    __tablename__ = "monitoring_group_members"

    group_id: Mapped[str] = mapped_column(String, primary_key=True)
    project_id: Mapped[str] = mapped_column(String, primary_key=True, index=True)


class DashboardRow(Base):
    """A dashboard as it is now: its owner (a project or a group), its title (the document's) and
    the document itself, at `version`."""

    __tablename__ = "monitoring_dashboards"
    __table_args__ = (
        UniqueConstraint(
            "owner_kind", "owner_id", "title", name="uq_monitoring_dashboards_owner_title"
        ),
        Index("ix_monitoring_dashboards_owner", "owner_kind", "owner_id"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True)
    owner_kind: Mapped[str] = mapped_column(String)
    owner_id: Mapped[str] = mapped_column(String)
    title: Mapped[str] = mapped_column(String)
    spec: Mapped[str] = mapped_column(Text)  # JSON: the normalised document
    version: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class DashboardVersionRow(Base):
    """Every version a dashboard has had, the current one included."""

    __tablename__ = "monitoring_dashboard_versions"

    dashboard_id: Mapped[str] = mapped_column(String, primary_key=True)
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    spec: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(String)
    panel_count: Mapped[int] = mapped_column(Integer)
    origin: Mapped[str] = mapped_column(String)  # created, copied, saved or restored
    restored_from: Mapped[int | None] = mapped_column(Integer)
    copied_from: Mapped[str | None] = mapped_column(String)
    saved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


async def lock_first(session: AsyncSession) -> None:
    """Take SQLite's write lock now, before the transaction reads anything: a write that matches
    no row still opens the write transaction, so a delete running beside it waits until this one
    commits and what it reads next can't change under it (no link or member to a project or
    source deleted in between)."""
    await session.execute(
        update(ProjectRecord).where(false()).values(updated_at=ProjectRecord.updated_at)
    )
