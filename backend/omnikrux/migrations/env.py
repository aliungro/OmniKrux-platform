from alembic import context
from sqlalchemy import create_engine

# Imported to register their tables on Base.metadata.
from omnikrux.audit import models as audit_models  # noqa: F401
from omnikrux.cloud import models as cloud_models  # noqa: F401
from omnikrux.clusters import models  # noqa: F401
from omnikrux.db import Base

target_metadata = Base.metadata


def run_migrations_online() -> None:
    connection = context.config.attributes.get("connection")
    if connection is not None:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()
        return
    # Developer CLI: `alembic -x url=sqlite:///x.db upgrade head` (sync driver URL).
    url = context.get_x_argument(as_dictionary=True).get("url")
    if not url:
        raise RuntimeError("Pass a sync database URL with -x url=... when running alembic directly")
    engine = create_engine(url)
    with engine.connect() as conn:
        context.configure(connection=conn, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


run_migrations_online()
