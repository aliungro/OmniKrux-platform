import uuid
from datetime import UTC, datetime
from enum import StrEnum

from sqlalchemy import DateTime, LargeBinary, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from omnikrux.db import Base


class Provider(StrEnum):
    AKS = "aks"
    EKS = "eks"
    GKE = "gke"
    OKE = "oke"
    KIND = "kind"
    ONPREM = "onprem"


class Environment(StrEnum):
    PRODUCTION = "production"
    DEVELOPMENT = "development"
    UNKNOWN = "unknown"


def _now() -> datetime:
    return datetime.now(UTC)


class ClusterRecord(Base):
    __tablename__ = "clusters"
    # Identity is where the cluster came from plus its context name, not its address: a kind
    # cluster re-created on a new port is the same cluster.
    __table_args__ = (
        UniqueConstraint("source", "context_name", name="uq_clusters_source_context_name"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: uuid.uuid4().hex)
    name: Mapped[str] = mapped_column(String)
    source: Mapped[str] = mapped_column(String)
    context_name: Mapped[str] = mapped_column(String)
    server: Mapped[str] = mapped_column(String)
    original_server: Mapped[str | None] = mapped_column(
        String, nullable=True
    )  # set when `server` was rewritten
    provider: Mapped[str] = mapped_column(String)
    region: Mapped[str | None] = mapped_column(String, nullable=True)
    environment: Mapped[str] = mapped_column(String)
    kubeconfig_encrypted: Mapped[bytes] = mapped_column(LargeBinary)
    cloud_account_id: Mapped[str | None] = mapped_column(String)
    cloud_resource_id: Mapped[str | None] = mapped_column(String)
    cloud_details: Mapped[str | None] = mapped_column(Text)
    kubernetes_version: Mapped[str | None] = mapped_column(String)
    node_pools: Mapped[str | None] = mapped_column(Text)
    node_count: Mapped[int | None]
    cloud_missing_since: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )
