import uuid
from datetime import UTC, datetime
from typing import Literal

from sqlalchemy import Boolean, DateTime, LargeBinary, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from omnikrux.cloud.types import CloudProvider, CredentialSourceKind
from omnikrux.db import Base

DiscoveryState = Literal["new", "added", "dismissed"]


def _now() -> datetime:
    return datetime.now(UTC)


class CloudAccountRecord(Base):
    __tablename__ = "cloud_accounts"
    __table_args__ = (
        UniqueConstraint("provider", "scope", name="uq_cloud_accounts_provider_scope"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: uuid.uuid4().hex)
    provider: Mapped[CloudProvider] = mapped_column(String)
    source: Mapped[CredentialSourceKind] = mapped_column(String)
    scope: Mapped[str] = mapped_column(String)
    name: Mapped[str] = mapped_column(String)
    principal: Mapped[str] = mapped_column(String)
    settings: Mapped[str] = mapped_column(Text)
    secret_encrypted: Mapped[bytes | None] = mapped_column(LargeBinary)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )
    checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    check_ok: Mapped[bool | None] = mapped_column(Boolean)
    check_message: Mapped[str | None] = mapped_column(Text)
    problems: Mapped[str | None] = mapped_column(Text)


class DiscoveredRecord(Base):
    __tablename__ = "cloud_discovered"
    __table_args__ = (
        UniqueConstraint("account_id", "resource_id", name="uq_cloud_discovered_account_resource"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: uuid.uuid4().hex)
    account_id: Mapped[str] = mapped_column(String, index=True)
    resource_id: Mapped[str] = mapped_column(String)
    name: Mapped[str] = mapped_column(String)
    region: Mapped[str] = mapped_column(String)
    kubernetes_version: Mapped[str | None] = mapped_column(String)
    node_pools: Mapped[str] = mapped_column(Text)
    node_count: Mapped[int | None]
    tags: Mapped[str] = mapped_column(Text)
    environment: Mapped[str] = mapped_column(String)
    private: Mapped[bool] = mapped_column(Boolean)
    why_not: Mapped[str | None] = mapped_column(Text)
    details: Mapped[str] = mapped_column(Text)
    state: Mapped[DiscoveryState] = mapped_column(String)
    cluster_id: Mapped[str | None] = mapped_column(String)
    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    missing_since: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
