"""Monitoring alerts: rules, their targets, instances and history, contact points, silences and
deliveries; and whether OmniKrux installed a source's tool.

Revision ID: 0009
Revises: 0008
"""

import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def _moment(name: str, *, nullable: bool = False) -> sa.Column:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable)


def upgrade() -> None:
    op.create_table(
        "monitoring_alert_rules",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("scope_kind", sa.String(), nullable=False),
        sa.Column("scope_id", sa.String(), nullable=False),
        sa.Column("source_type", sa.String(), nullable=False),
        sa.Column("source_id", sa.String()),
        sa.Column("expr", sa.Text(), nullable=False),
        sa.Column("cond_of", sa.String(), nullable=False),
        sa.Column("cond_op", sa.String(), nullable=False),
        sa.Column("threshold", sa.Float(), nullable=False),
        sa.Column("for_seconds", sa.Integer(), nullable=False),
        sa.Column("every_seconds", sa.Integer(), nullable=False),
        sa.Column("severity", sa.String(), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("contact_point_ids", sa.Text(), nullable=False),
        sa.Column("engine", sa.String(), nullable=False),
        sa.Column("channel", sa.Text()),
        sa.Column("paused", sa.Boolean(), nullable=False),
        sa.Column("origin", sa.String(), nullable=False),
        sa.Column("dashboard_id", sa.String()),
        sa.Column("panel_id", sa.String()),
        sa.Column("version", sa.Integer(), nullable=False),
        _moment("deleted_at", nullable=True),
        _moment("created_at"),
        _moment("updated_at"),
    )
    op.create_index(
        "ix_monitoring_alert_rules_scope", "monitoring_alert_rules", ["scope_kind", "scope_id"]
    )
    op.create_index(
        "ix_monitoring_alert_rules_panel", "monitoring_alert_rules", ["dashboard_id", "panel_id"]
    )
    op.create_table(
        "monitoring_alert_targets",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("rule_id", sa.String(), nullable=False),
        sa.Column("project_id", sa.String(), nullable=False),
        sa.Column("engine", sa.String(), nullable=False),
        sa.Column("engine_note", sa.Text()),
        sa.Column("source_id", sa.String()),
        sa.Column("eval_expr", sa.Text(), nullable=False),
        sa.Column("rule_text", sa.Text(), nullable=False),
        sa.Column("state", sa.String(), nullable=False),
        _moment("state_since"),
        sa.Column("message", sa.Text()),
        _moment("last_eval_at", nullable=True),
        _moment("next_eval_at", nullable=True),
        sa.Column("failures", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("tool_kind", sa.String()),
        sa.Column("tool_object", sa.Text()),
        sa.Column("tool_state", sa.String()),
        sa.Column("tool_message", sa.Text()),
        sa.Column("applied_version", sa.Integer()),
        sa.Column("leaving", sa.Boolean(), nullable=False, server_default=sa.false()),
        _moment("created_at"),
        _moment("updated_at"),
        sa.UniqueConstraint(
            "rule_id", "project_id", name="uq_monitoring_alert_targets_rule_project"
        ),
    )
    op.create_index("ix_monitoring_alert_targets_rule_id", "monitoring_alert_targets", ["rule_id"])
    op.create_index(
        "ix_monitoring_alert_targets_project_id", "monitoring_alert_targets", ["project_id"]
    )
    op.create_table(
        "monitoring_alert_instances",
        sa.Column("target_id", sa.String(), nullable=False),
        sa.Column("fingerprint", sa.String(), nullable=False),
        sa.Column("labels", sa.Text(), nullable=False),
        sa.Column("state", sa.String(), nullable=False),
        _moment("active_since"),
        _moment("fired_at", nullable=True),
        sa.Column("value", sa.Float()),
        _moment("last_notified_at", nullable=True),
        sa.Column("silenced", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.PrimaryKeyConstraint("target_id", "fingerprint"),
    )
    op.create_table(
        "monitoring_alert_history",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("target_id", sa.String(), nullable=False),
        sa.Column("rule_id", sa.String(), nullable=False),
        sa.Column("project_id", sa.String(), nullable=False),
        _moment("at"),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("labels", sa.Text()),
        sa.Column("value", sa.Float()),
        sa.Column("message", sa.Text()),
    )
    op.create_index(
        "ix_monitoring_alert_history_rule_at", "monitoring_alert_history", ["rule_id", "at"]
    )
    op.create_index("ix_monitoring_alert_history_at", "monitoring_alert_history", ["at"])
    op.create_index(
        "ix_monitoring_alert_history_project_id", "monitoring_alert_history", ["project_id"]
    )
    op.create_table(
        "monitoring_contact_points",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("type", sa.String(), nullable=False),
        sa.Column("settings", sa.Text(), nullable=False),
        sa.Column("secret_encrypted", sa.LargeBinary()),
        _moment("last_delivery_at", nullable=True),
        sa.Column("last_delivery_ok", sa.Boolean()),
        sa.Column("last_delivery_message", sa.Text()),
        _moment("created_at"),
        _moment("updated_at"),
        sa.UniqueConstraint("name", name="uq_monitoring_contact_points_name"),
    )
    op.create_table(
        "monitoring_silences",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("matchers", sa.Text(), nullable=False),
        _moment("starts_at"),
        _moment("ends_at"),
        sa.Column("comment", sa.Text(), nullable=False),
        sa.Column("created_by", sa.String(), nullable=False),
        _moment("created_at"),
        _moment("expired_at", nullable=True),
    )
    op.create_table(
        "monitoring_alert_deliveries",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        _moment("at"),
        sa.Column("contact_point_id", sa.String(), nullable=False),
        sa.Column("target_id", sa.String()),
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("ok", sa.Boolean(), nullable=False),
        sa.Column("message", sa.Text()),
    )
    op.create_index("ix_monitoring_alert_deliveries_at", "monitoring_alert_deliveries", ["at"])
    op.add_column(
        "monitoring_sources",
        sa.Column("installed_by_omnikrux", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    with op.batch_alter_table("monitoring_sources") as batch:
        batch.drop_column("installed_by_omnikrux")
    op.drop_index("ix_monitoring_alert_deliveries_at", table_name="monitoring_alert_deliveries")
    op.drop_table("monitoring_alert_deliveries")
    op.drop_table("monitoring_silences")
    op.drop_table("monitoring_contact_points")
    op.drop_index("ix_monitoring_alert_history_project_id", table_name="monitoring_alert_history")
    op.drop_index("ix_monitoring_alert_history_at", table_name="monitoring_alert_history")
    op.drop_index("ix_monitoring_alert_history_rule_at", table_name="monitoring_alert_history")
    op.drop_table("monitoring_alert_history")
    op.drop_table("monitoring_alert_instances")
    op.drop_index("ix_monitoring_alert_targets_project_id", table_name="monitoring_alert_targets")
    op.drop_index("ix_monitoring_alert_targets_rule_id", table_name="monitoring_alert_targets")
    op.drop_table("monitoring_alert_targets")
    op.drop_index("ix_monitoring_alert_rules_panel", table_name="monitoring_alert_rules")
    op.drop_index("ix_monitoring_alert_rules_scope", table_name="monitoring_alert_rules")
    op.drop_table("monitoring_alert_rules")
