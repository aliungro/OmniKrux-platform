"""Cloud accounts, discovery and cluster metadata.

Revision ID: 0005
Revises: 0004
"""

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "cloud_accounts",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("scope", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("principal", sa.String(), nullable=False),
        sa.Column("settings", sa.Text(), nullable=False),
        sa.Column("secret_encrypted", sa.LargeBinary()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("checked_at", sa.DateTime(timezone=True)),
        sa.Column("check_ok", sa.Boolean()),
        sa.Column("check_message", sa.Text()),
        sa.Column("problems", sa.Text()),
        sa.UniqueConstraint("provider", "scope", name="uq_cloud_accounts_provider_scope"),
    )
    op.create_table(
        "cloud_discovered",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("account_id", sa.String(), nullable=False),
        sa.Column("resource_id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("region", sa.String(), nullable=False),
        sa.Column("kubernetes_version", sa.String()),
        sa.Column("node_pools", sa.Text(), nullable=False),
        sa.Column("node_count", sa.Integer()),
        sa.Column("tags", sa.Text(), nullable=False),
        sa.Column("environment", sa.String(), nullable=False),
        sa.Column("private", sa.Boolean(), nullable=False),
        sa.Column("why_not", sa.Text()),
        sa.Column("details", sa.Text(), nullable=False),
        sa.Column("state", sa.String(), nullable=False),
        sa.Column("cluster_id", sa.String()),
        sa.Column("first_seen", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen", sa.DateTime(timezone=True), nullable=False),
        sa.Column("missing_since", sa.DateTime(timezone=True)),
        sa.UniqueConstraint(
            "account_id", "resource_id", name="uq_cloud_discovered_account_resource"
        ),
    )
    op.create_index("ix_cloud_discovered_account_id", "cloud_discovered", ["account_id"])

    op.add_column("clusters", sa.Column("cloud_account_id", sa.String()))
    op.add_column("clusters", sa.Column("cloud_resource_id", sa.String()))
    op.add_column("clusters", sa.Column("cloud_details", sa.Text()))
    op.add_column("clusters", sa.Column("kubernetes_version", sa.String()))
    op.add_column("clusters", sa.Column("node_pools", sa.Text()))
    op.add_column("clusters", sa.Column("node_count", sa.Integer()))
    op.add_column("clusters", sa.Column("cloud_missing_since", sa.DateTime(timezone=True)))


def downgrade() -> None:
    clusters = sa.table("clusters", sa.column("source"))
    op.execute(clusters.delete().where(clusters.c.source == "cloud"))
    for column in (
        "cloud_missing_since",
        "node_count",
        "node_pools",
        "kubernetes_version",
        "cloud_details",
        "cloud_resource_id",
        "cloud_account_id",
    ):
        op.drop_column("clusters", column)
    op.drop_index("ix_cloud_discovered_account_id", table_name="cloud_discovered")
    op.drop_table("cloud_discovered")
    op.drop_table("cloud_accounts")
