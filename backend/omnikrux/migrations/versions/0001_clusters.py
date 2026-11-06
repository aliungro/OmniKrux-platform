"""clusters table

Revision ID: 0001
Revises:
"""

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "clusters",
        sa.Column("id", sa.String(), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("source", sa.String(), nullable=False),
        sa.Column("context_name", sa.String(), nullable=False),
        sa.Column("server", sa.String(), nullable=False),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("region", sa.String(), nullable=True),
        sa.Column("environment", sa.String(), nullable=False),
        sa.Column("kubeconfig_encrypted", sa.LargeBinary(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("source", "context_name", "server"),
    )


def downgrade() -> None:
    op.drop_table("clusters")
