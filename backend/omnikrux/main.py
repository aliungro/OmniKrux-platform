import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from starlette.middleware.trustedhost import TrustedHostMiddleware

from omnikrux.clusters.api import router as clusters_router
from omnikrux.clusters.kubeconfig import read_kubeconfig_files
from omnikrux.clusters.registry import ClusterRegistry
from omnikrux.config import Settings, get_settings
from omnikrux.db import init_db, make_engine, make_sessionmaker
from omnikrux.kube.client import make_api_client
from omnikrux.kube.source import KubeResourceSource
from omnikrux.resources.kinds import KindSpec
from omnikrux.security.secrets import SecretBox
from omnikrux.watch.api import router as watch_router
from omnikrux.watch.hub import WatchHub
from omnikrux.web import mount_spa

log = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings if settings is not None else get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = make_engine(settings.db_url)
        await init_db(engine)
        sessionmaker = make_sessionmaker(engine)
        registry = ClusterRegistry(sessionmaker, SecretBox.from_settings(settings))

        async def source_for(cluster_id: str, spec: KindSpec) -> KubeResourceSource:
            kubeconfig = await registry.get_kubeconfig(cluster_id)
            api = await make_api_client(kubeconfig)
            return KubeResourceSource(api, spec)  # owns `api` and closes it

        hub = WatchHub(registry, source_for)
        app.state.engine = engine
        app.state.sessionmaker = sessionmaker
        app.state.registry = registry
        app.state.hub = hub
        try:
            for path in settings.kubeconfig_paths:
                try:
                    texts = read_kubeconfig_files([path])
                except OSError as exc:
                    log.warning(
                        "Cannot read kubeconfig %s (%s); make it readable by the container user "
                        "(for example run with --user \"$(id -u):$(id -g)\" or chmod 644 a copy). "
                        "Continuing without it.",
                        path,
                        exc,
                    )
                    continue
                for text in texts:
                    try:
                        await registry.upsert_from_kubeconfig(text, rewrite_loopback=settings.loopback_rewrite)
                    except ValueError as exc:  # our own plain message, free of kubeconfig contents
                        error_type = getattr(exc, "error_type", None)
                        log.warning("Skipping kubeconfig %s: %s%s", path, exc, f" ({error_type})" if error_type else "")
                    except Exception as exc:  # noqa: BLE001 (one file must never stop startup; logged by type)
                        log.warning("Skipping kubeconfig %s: it could not be imported (%s)", path, type(exc).__name__)
            yield
        finally:
            await hub.close()
            await engine.dispose()

    app = FastAPI(title="Omnikrux", lifespan=lifespan)
    app.state.settings = settings
    # No login yet: only answer to the hosts the user reaches us by, so a DNS-rebinding page can't.
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts, www_redirect=False)
    app.include_router(clusters_router)
    app.include_router(watch_router)

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    if settings.static_dir is not None and settings.static_dir.is_dir():
        mount_spa(app, settings.static_dir)  # last: must not shadow /api/*

    return app


app = create_app()
