"""Monitoring installs: what OmniKrux installed into each cluster.

Revision ID: 0010
Revises: 0009
"""

import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def _moment(name: str, *, nullable: bool = False) -> sa.Column:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable)


def upgrade() -> None:
    op.create_table(
        "monitoring_installs",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("cluster_id", sa.String(), nullable=False),
        sa.Column("namespace", sa.String(), nullable=False),
        sa.Column("components", sa.Text(), nullable=False),
        sa.Column("settings", sa.Text(), nullable=False),
        sa.Column("charts", sa.Text(), nullable=False),
        sa.Column("state", sa.String(), nullable=False),
        sa.Column("message", sa.Text()),
        sa.Column("job_id", sa.String()),
        sa.Column("project_id", sa.String()),
        sa.Column("prometheus_source_id", sa.String()),
        sa.Column("alertmanager_source_id", sa.String()),
        sa.Column("loki_source_id", sa.String()),
        sa.Column("contacts_digest", sa.String()),
        _moment("contacts_applied_at", nullable=True),
        sa.Column("contacts_message", sa.Text()),
        _moment("created_at"),
        _moment("updated_at"),
        _moment("installed_at", nullable=True),
        sa.UniqueConstraint("cluster_id", name="uq_monitoring_installs_cluster"),
    )


def downgrade() -> None:
    op.drop_table("monitoring_installs")
