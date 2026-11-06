"""clusters.original_server: the kubeconfig address when the server was rewritten

Revision ID: 0002
Revises: 0001
"""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("clusters") as batch:
        batch.add_column(sa.Column("original_server", sa.String(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("clusters") as batch:
        batch.drop_column("original_server")
