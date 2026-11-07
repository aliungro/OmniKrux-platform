"""cluster identity is (source, context_name); kubeconfig sources become "file"

Revision ID: 0003
Revises: 0002
"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

OLD_UQ = "uq_clusters_source_context_name_server"
NEW_UQ = "uq_clusters_source_context_name"
# 0001 left its unique constraint unnamed; this names it on reflection so batch mode can drop it.
NAMING = {"uq": "uq_%(table_name)s_%(column_0_N_name)s"}


def _collapse(*identity: str) -> None:
    """Keep only the newest row (by updated_at, then id) per `identity` columns."""
    same = " AND ".join(f"newer.{col} = clusters.{col}" for col in identity)
    op.execute(
        sa.text(
            "DELETE FROM clusters WHERE EXISTS (SELECT 1 FROM clusters AS newer"
            f" WHERE {same} AND (newer.updated_at > clusters.updated_at"
            " OR (newer.updated_at = clusters.updated_at AND newer.id > clusters.id)))"
        )
    )


def upgrade() -> None:
    op.execute(sa.text("UPDATE clusters SET source = 'file' WHERE source = 'kubeconfig'"))
    _collapse("source", "context_name")
    with op.batch_alter_table("clusters", naming_convention=NAMING) as batch:
        batch.drop_constraint(OLD_UQ, type_="unique")
        batch.create_unique_constraint(NEW_UQ, ["source", "context_name"])


def downgrade() -> None:
    # Drop first: a file and an upload of one context become the same source.
    with op.batch_alter_table("clusters") as batch:
        batch.drop_constraint(NEW_UQ, type_="unique")
    op.execute(sa.text("UPDATE clusters SET source = 'kubeconfig'"))
    _collapse("source", "context_name", "server")
    with op.batch_alter_table("clusters") as batch:
        batch.create_unique_constraint(OLD_UQ, ["source", "context_name", "server"])
