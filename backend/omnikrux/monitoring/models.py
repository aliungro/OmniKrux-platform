"""Monitoring tables. Kept identical to migrations 0007, 0008, 0009 and 0010 (`tests/test_db.py`
compares them)."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
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
    # OmniKrux installed this tool itself (M5): only then may contact-point secrets go into it.
    installed_by_omnikrux: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=false()
    )


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


class AlertRuleRow(Base):
    """An alert rule: a query and a condition, for a project or a group. A panel rule
    (`origin` "panel") belongs to a dashboard panel. A deleted rule keeps its row (`deleted_at`)
    until its last target is removed."""

    __tablename__ = "monitoring_alert_rules"
    __table_args__ = (
        Index("ix_monitoring_alert_rules_scope", "scope_kind", "scope_id"),
        Index("ix_monitoring_alert_rules_panel", "dashboard_id", "panel_id"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    scope_kind: Mapped[str] = mapped_column(String)
    scope_id: Mapped[str] = mapped_column(String)
    source_type: Mapped[str] = mapped_column(String)
    source_id: Mapped[str | None] = mapped_column(String)
    expr: Mapped[str] = mapped_column(Text)
    cond_of: Mapped[str] = mapped_column(String)
    cond_op: Mapped[str] = mapped_column(String)
    threshold: Mapped[float] = mapped_column(Float)
    for_seconds: Mapped[int] = mapped_column(Integer)
    every_seconds: Mapped[int] = mapped_column(Integer)
    severity: Mapped[str] = mapped_column(String)
    message: Mapped[str] = mapped_column(Text)
    contact_point_ids: Mapped[str] = mapped_column(Text)  # JSON list
    engine: Mapped[str] = mapped_column(String)
    channel: Mapped[str | None] = mapped_column(Text)  # JSON {receiver, labels}
    paused: Mapped[bool] = mapped_column(Boolean)
    origin: Mapped[str] = mapped_column(String)  # page or panel
    dashboard_id: Mapped[str | None] = mapped_column(String)
    panel_id: Mapped[str | None] = mapped_column(String)
    version: Mapped[int] = mapped_column(Integer)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AlertTargetRow(Base):
    """Where a rule runs for one project: checked by OmniKrux, or applied in a tool."""

    __tablename__ = "monitoring_alert_targets"
    __table_args__ = (
        UniqueConstraint("rule_id", "project_id", name="uq_monitoring_alert_targets_rule_project"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True)
    rule_id: Mapped[str] = mapped_column(String, index=True)
    project_id: Mapped[str] = mapped_column(String, index=True)
    engine: Mapped[str] = mapped_column(String)
    engine_note: Mapped[str | None] = mapped_column(Text)
    source_id: Mapped[str | None] = mapped_column(String)
    eval_expr: Mapped[str] = mapped_column(Text)
    rule_text: Mapped[str] = mapped_column(Text)
    state: Mapped[str] = mapped_column(String)
    state_since: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    message: Mapped[str | None] = mapped_column(Text)
    last_eval_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_eval_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failures: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    tool_kind: Mapped[str | None] = mapped_column(String)
    tool_object: Mapped[str | None] = mapped_column(Text)  # JSON ToolObject
    tool_state: Mapped[str | None] = mapped_column(String)
    tool_message: Mapped[str | None] = mapped_column(Text)
    applied_version: Mapped[int | None] = mapped_column(Integer)
    leaving: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AlertInstanceRow(Base):
    """One series of a target that is pending or firing, by its labels' fingerprint."""

    __tablename__ = "monitoring_alert_instances"

    target_id: Mapped[str] = mapped_column(String, primary_key=True)
    fingerprint: Mapped[str] = mapped_column(String, primary_key=True)
    labels: Mapped[str] = mapped_column(Text)  # JSON {name: value}
    state: Mapped[str] = mapped_column(String)
    active_since: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    fired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    value: Mapped[float | None] = mapped_column(Float)
    last_notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    silenced: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())


class AlertHistoryRow(Base):
    """What happened to a target; kept for 7 days and within bounds (`AlertStore.prune`)."""

    __tablename__ = "monitoring_alert_history"
    __table_args__ = (
        Index("ix_monitoring_alert_history_rule_at", "rule_id", "at"),
        Index("ix_monitoring_alert_history_at", "at"),
        Index("ix_monitoring_alert_history_project_id", "project_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    target_id: Mapped[str] = mapped_column(String)
    rule_id: Mapped[str] = mapped_column(String)
    # The target's project: the entry still names it once the target is gone.
    project_id: Mapped[str] = mapped_column(String)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    kind: Mapped[str] = mapped_column(String)
    labels: Mapped[str | None] = mapped_column(Text)  # JSON {name: value}
    value: Mapped[float | None] = mapped_column(Float)
    message: Mapped[str | None] = mapped_column(Text)


class ContactPointRow(Base):
    """Where notifications go. Secret values are SecretBox-encrypted JSON."""

    __tablename__ = "monitoring_contact_points"
    __table_args__ = (UniqueConstraint("name", name="uq_monitoring_contact_points_name"),)

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    type: Mapped[str] = mapped_column(String)
    settings: Mapped[str] = mapped_column(Text)  # JSON, nothing secret
    secret_encrypted: Mapped[bytes | None] = mapped_column(LargeBinary)
    last_delivery_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_delivery_ok: Mapped[bool | None] = mapped_column(Boolean)
    last_delivery_message: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class SilenceRow(Base):
    """An OmniKrux silence: instances whose labels match stay quiet until it ends."""

    __tablename__ = "monitoring_silences"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    matchers: Mapped[str] = mapped_column(Text)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    comment: Mapped[str] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DeliveryRow(Base):
    """One notification sent (or not) to a contact point; kept for 7 days and within a bound."""

    __tablename__ = "monitoring_alert_deliveries"
    __table_args__ = (Index("ix_monitoring_alert_deliveries_at", "at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    contact_point_id: Mapped[str] = mapped_column(String)
    target_id: Mapped[str | None] = mapped_column(String)
    kind: Mapped[str] = mapped_column(String)
    ok: Mapped[bool] = mapped_column(Boolean)
    message: Mapped[str | None] = mapped_column(Text)


class InstallRow(Base):
    """What OmniKrux installed into a cluster (one record per cluster); JSON columns hold the
    components, the settings and the chart versions. Nothing secret."""

    __tablename__ = "monitoring_installs"
    __table_args__ = (UniqueConstraint("cluster_id", name="uq_monitoring_installs_cluster"),)

    id: Mapped[str] = mapped_column(String, primary_key=True)
    cluster_id: Mapped[str] = mapped_column(String)
    namespace: Mapped[str] = mapped_column(String)
    components: Mapped[str] = mapped_column(Text)  # JSON list
    settings: Mapped[str] = mapped_column(Text)  # JSON
    charts: Mapped[str] = mapped_column(Text)  # JSON {release: version}
    state: Mapped[str] = mapped_column(String)
    message: Mapped[str | None] = mapped_column(Text)
    job_id: Mapped[str | None] = mapped_column(String)
    project_id: Mapped[str | None] = mapped_column(String)
    prometheus_source_id: Mapped[str | None] = mapped_column(String)
    alertmanager_source_id: Mapped[str | None] = mapped_column(String)
    loki_source_id: Mapped[str | None] = mapped_column(String)
    contacts_digest: Mapped[str | None] = mapped_column(String)
    contacts_applied_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    contacts_message: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    installed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


async def lock_first(session: AsyncSession) -> None:
    """Take SQLite's write lock now, before the transaction reads anything: a write that matches
    no row still opens the write transaction, so a delete running beside it waits until this one
    commits and what it reads next can't change under it (no link or member to a project or
    source deleted in between)."""
    await session.execute(
        update(ProjectRecord).where(false()).values(updated_at=ProjectRecord.updated_at)
    )
