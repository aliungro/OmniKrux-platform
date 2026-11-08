"""The audit table: one row per change, shell, debug container, node shell, port-forward or
secret reveal."""

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from omnikrux.db import Base


class AuditRecord(Base):
    __tablename__ = "audit"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    actor: Mapped[str] = mapped_column(String)
    action: Mapped[str] = mapped_column(String)
    cluster_id: Mapped[str] = mapped_column(String, index=True)
    # Snapshots: the record still reads right after the cluster is renamed or removed.
    cluster_name: Mapped[str] = mapped_column(String)
    provider: Mapped[str] = mapped_column(String)
    namespace: Mapped[str | None] = mapped_column(String, nullable=True)  # cluster-scoped: None
    kind: Mapped[str] = mapped_column(String)
    name: Mapped[str | None] = mapped_column(String, nullable=True)
    outcome: Mapped[str] = mapped_column(String)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    diff: Mapped[str | None] = mapped_column(Text, nullable=True)
    details: Mapped[str | None] = mapped_column(Text, nullable=True)  # JSON
