"""Monitoring dashboards and every version they have had.

Revision ID: 0008
Revises: 0007
"""

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "monitoring_dashboards",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("owner_kind", sa.String(), nullable=False),
        sa.Column("owner_id", sa.String(), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("spec", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "owner_kind", "owner_id", "title", name="uq_monitoring_dashboards_owner_title"
        ),
    )
    op.create_index(
        "ix_monitoring_dashboards_owner", "monitoring_dashboards", ["owner_kind", "owner_id"]
    )
    op.create_table(
        "monitoring_dashboard_versions",
        sa.Column("dashboard_id", sa.String(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("spec", sa.Text(), nullable=False),
        sa.Column("title", sa.String(), nullable=False),
        sa.Column("panel_count", sa.Integer(), nullable=False),
        sa.Column("origin", sa.String(), nullable=False),
        sa.Column("restored_from", sa.Integer()),
        sa.Column("copied_from", sa.String()),
        sa.Column("saved_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("dashboard_id", "version"),
    )


def downgrade() -> None:
    op.drop_table("monitoring_dashboard_versions")
    op.drop_index("ix_monitoring_dashboards_owner", table_name="monitoring_dashboards")
    op.drop_table("monitoring_dashboards")
