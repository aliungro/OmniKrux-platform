"""Monitoring: sources, projects, their links, groups and group members.

Revision ID: 0007
Revises: 0006
"""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "monitoring_sources",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("type", sa.String(), nullable=False),
        sa.Column("reach", sa.String(), nullable=False),
        sa.Column("url", sa.String()),
        sa.Column("cluster_id", sa.String()),
        sa.Column("namespace", sa.String()),
        sa.Column("service", sa.String()),
        sa.Column("port", sa.String()),
        sa.Column("scheme", sa.String(), nullable=False, server_default="http"),
        sa.Column("path_prefix", sa.String(), nullable=False, server_default=""),
        sa.Column("auth_type", sa.String(), nullable=False),
        sa.Column("auth_settings", sa.Text(), nullable=False),
        sa.Column("header_names", sa.Text(), nullable=False),
        sa.Column("ca_pem", sa.Text()),
        sa.Column("secret_encrypted", sa.LargeBinary()),
        sa.Column("created_by_project_id", sa.String()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("checked_at", sa.DateTime(timezone=True)),
        sa.Column("check_ok", sa.Boolean()),
        sa.Column("check_message", sa.Text()),
        sa.Column("version", sa.String()),
        sa.UniqueConstraint("name", name="uq_monitoring_sources_name"),
    )
    op.create_table(
        "monitoring_projects",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("cluster_id", sa.String()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("name", name="uq_monitoring_projects_name"),
    )
    op.create_table(
        "monitoring_project_sources",
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("source_id", sa.String(), nullable=False),
        sa.Column("filter", sa.Text(), nullable=False),
        sa.Column("filter_origin", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("project_id", "source_id"),
    )
    op.create_index(
        "ix_monitoring_project_sources_source_id", "monitoring_project_sources", ["source_id"]
    )
    op.create_table(
        "monitoring_groups",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("name", name="uq_monitoring_groups_name"),
    )
    op.create_table(
        "monitoring_group_members",
        sa.Column("group_id", sa.String(), nullable=False),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.PrimaryKeyConstraint("group_id", "project_id"),
    )
    op.create_index(
        "ix_monitoring_group_members_project_id", "monitoring_group_members", ["project_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_monitoring_group_members_project_id", table_name="monitoring_group_members")
    op.drop_table("monitoring_group_members")
    op.drop_table("monitoring_groups")
    op.drop_index(
        "ix_monitoring_project_sources_source_id", table_name="monitoring_project_sources"
    )
    op.drop_table("monitoring_project_sources")
    op.drop_table("monitoring_projects")
    op.drop_table("monitoring_sources")
