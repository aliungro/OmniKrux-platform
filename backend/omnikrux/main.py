import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from omnikrux.clusters.api import router as clusters_router
from omnikrux.clusters.kubeconfig import read_kubeconfig_files
from omnikrux.clusters.registry import ClusterRegistry
from omnikrux.config import Settings, get_settings
from omnikrux.db import init_db, make_engine, make_sessionmaker
from omnikrux.security.secrets import SecretBox

log = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings if settings is not None else get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = make_engine(settings.db_url)
        await init_db(engine)
        sessionmaker = make_sessionmaker(engine)
        registry = ClusterRegistry(sessionmaker, SecretBox.from_settings(settings))
        app.state.engine = engine
        app.state.sessionmaker = sessionmaker
        app.state.registry = registry
        try:
            for path in settings.kubeconfig_paths:
                for text in read_kubeconfig_files([path]):
                    try:
                        await registry.upsert_from_kubeconfig(text, in_container=settings.in_container)
                    except ValueError as exc:
                        log.warning("Skipping kubeconfig %s: %s", path, exc)
            yield
        finally:
            await engine.dispose()

    app = FastAPI(title="Omnikrux", lifespan=lifespan)
    app.state.settings = settings
    app.include_router(clusters_router)

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
