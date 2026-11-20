"""Audit entries record which app made them.

Revision ID: 0006
Revises: 0005
"""

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "audit", sa.Column("app", sa.String(), nullable=False, server_default="kubernetes")
    )


def downgrade() -> None:
    op.drop_column("audit", "app")
