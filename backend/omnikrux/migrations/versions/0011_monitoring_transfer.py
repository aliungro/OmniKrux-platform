"""Monitoring import and export: Grafana connections, and where imported dashboards came from.

Revision ID: 0011
Revises: 0010
"""

import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def _moment(name: str, *, nullable: bool = False) -> sa.Column:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable)


def upgrade() -> None:
    op.create_table(
        "monitoring_grafana",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("reach", sa.String(), nullable=False),
        sa.Column("url", sa.String()),
        sa.Column("cluster_id", sa.String()),
        sa.Column("namespace", sa.String()),
        sa.Column("service", sa.String()),
        sa.Column("port", sa.String()),
        sa.Column("scheme", sa.String(), nullable=False, server_default="http"),
        sa.Column("path_prefix", sa.String(), nullable=False, server_default=""),
        sa.Column("auth_type", sa.String(), nullable=False),
        sa.Column("username", sa.String()),
        sa.Column("secret_encrypted", sa.LargeBinary()),
        _moment("created_at"),
        _moment("updated_at"),
        sa.UniqueConstraint("name", name="uq_monitoring_grafana_name"),
    )
    op.create_table(
        "monitoring_dashboard_origins",
        sa.Column("dashboard_id", sa.String(), primary_key=True),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("via", sa.String(), nullable=False),
        sa.Column("label", sa.String(), nullable=False),
        sa.Column("grafana_id", sa.String()),
        sa.Column("grafana_uid", sa.String()),
        sa.Column("grafana_version", sa.Integer()),
        sa.Column("export_id", sa.String()),
        sa.Column("source_title", sa.String(), nullable=False),
        sa.Column("mapping", sa.Text(), nullable=False),
        sa.Column("panels", sa.Text(), nullable=False, server_default="{}"),
        sa.Column("digest", sa.String(), nullable=False),
        _moment("imported_at"),
        sa.Column("imported_version", sa.Integer(), nullable=False),
        _moment("updated_at", nullable=True),
        sa.Column("updated_version", sa.Integer()),
    )
    op.create_index(
        "ix_monitoring_dashboard_origins_grafana_id",
        "monitoring_dashboard_origins",
        ["grafana_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_monitoring_dashboard_origins_grafana_id", table_name="monitoring_dashboard_origins"
    )
    op.drop_table("monitoring_dashboard_origins")
    op.drop_table("monitoring_grafana")
