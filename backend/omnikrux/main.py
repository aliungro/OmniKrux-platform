import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from starlette.middleware.trustedhost import TrustedHostMiddleware

from omnikrux.clusters.api import router as clusters_router
from omnikrux.clusters.kubeconfig import (
    ParsedContext,
    parse_kubeconfig_file,
    read_kubeconfig_files,
)
from omnikrux.clusters.registry import SOURCE_FILE, ClusterRegistry
from omnikrux.config import Settings, get_settings
from omnikrux.db import init_db, make_engine, make_sessionmaker
from omnikrux.exec.api import router as exec_router
from omnikrux.kube.connections import ClusterConnections
from omnikrux.kube.source import KubeResourceSource
from omnikrux.logs.api import router as logs_router
from omnikrux.resources.api import router as resources_router
from omnikrux.resources.kinds import KindSpec
from omnikrux.security.secrets import SecretBox
from omnikrux.watch.api import router as watch_router
from omnikrux.watch.hub import WatchHub
from omnikrux.web import mount_spa
from omnikrux.web_security import CrossOriginWriteGuard

log = logging.getLogger(__name__)


async def _import_kubeconfig_files(settings: Settings, registry: ClusterRegistry) -> list[str]:
    """Import every configured kubeconfig file, then drop file clusters whose context is gone.

    Returns the ids of the clusters it removed. Removal only happens when every configured file
    was read and parsed: a missing mount, an unreadable or a broken file must never wipe
    clusters. Kubeconfig problems never stop startup."""
    seen: set[str] = set()
    defined_in: dict[str, Path] = {}  # context name -> the file that defined it first
    complete = bool(settings.kubeconfig_paths)
    for path in settings.kubeconfig_paths:
        try:
            texts = read_kubeconfig_files([path])
        except OSError as exc:
            complete = False
            log.warning(
                "Cannot read kubeconfig %s (%s); make it readable by the container user "
                '(for example run with --user "$(id -u):$(id -g)" or chmod 644 a copy). '
                "Continuing without it.",
                path,
                exc,
            )
            continue
        if not texts:  # nothing at this path (for example no kubeconfig mounted)
            complete = False
        for text in texts:
            names = await _import_file(path, text, settings, registry, defined_in)
            if names is None:
                complete = False
            else:
                seen |= names
    if not complete:
        return []
    try:
        return await registry.reconcile_files(seen)  # logs what it removed
    except Exception as exc:  # noqa: BLE001 (logged by type; the clusters simply stay)
        log.warning(
            "Could not remove clusters that left the kubeconfig files (%s); keeping them",
            type(exc).__name__,
        )
        return []


async def _import_file(
    path: Path,
    text: str,
    settings: Settings,
    registry: ClusterRegistry,
    defined_in: dict[str, Path],
) -> set[str] | None:
    """Import one file's contexts; the context names it accounts for, or None if it failed.

    A context an earlier file already defines is ignored with a warning (the first file wins,
    as with kubectl), but still counts as seen."""
    try:
        parsed = parse_kubeconfig_file(text, rewrite_loopback=settings.loopback_rewrite)
        if parsed.declared and not parsed.contexts:
            log.warning(
                "Skipping kubeconfig %s: none of its %d contexts could be read",
                path,
                parsed.declared,
            )
            return None
        fresh: dict[str, ParsedContext] = {}
        for ctx in parsed.contexts:
            name = ctx.context_name
            first = path if name in fresh else defined_in.get(name)
            if first is not None:
                log.warning(
                    "Ignoring context %r in %s: %s defines it first (the first file wins)",
                    name,
                    path,
                    first,
                )
                continue
            fresh[name] = ctx
        await registry.upsert_contexts(list(fresh.values()), source=SOURCE_FILE)
    except ValueError as exc:  # our own plain message, free of kubeconfig contents
        error_type = getattr(exc, "error_type", None)
        log.warning(
            "Skipping kubeconfig %s: %s%s", path, exc, f" ({error_type})" if error_type else ""
        )
        return None
    except Exception as exc:  # noqa: BLE001 (one file must never stop startup; logged by type)
        log.warning(
            "Skipping kubeconfig %s: it could not be imported (%s)", path, type(exc).__name__
        )
        return None
    defined_in.update(dict.fromkeys(fresh, path))
    return {ctx.context_name for ctx in parsed.contexts}


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings if settings is not None else get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = make_engine(settings.db_url)
        await init_db(engine)
        sessionmaker = make_sessionmaker(engine)
        registry = ClusterRegistry(sessionmaker, SecretBox.from_settings(settings))

        connections = ClusterConnections(registry)

        async def source_for(cluster_id: str, spec: KindSpec) -> KubeResourceSource:
            api = await connections.open_api(cluster_id)
            return KubeResourceSource(api, spec)  # owns `api` and closes it

        hub = WatchHub(registry, source_for)
        app.state.engine = engine
        app.state.sessionmaker = sessionmaker
        app.state.registry = registry
        app.state.connections = connections
        app.state.hub = hub
        try:
            for cluster_id in await _import_kubeconfig_files(settings, registry):
                await hub.forget(cluster_id)
            yield
        finally:
            await hub.close()
            await engine.dispose()

    app = FastAPI(title="Omnikrux", lifespan=lifespan)
    app.state.settings = settings
    # No login yet, so no session cookie to check either: refuse writes that another site's
    # page sends (it could otherwise start a node shell or delete a cluster).
    app.add_middleware(CrossOriginWriteGuard)
    # No login yet: only answer to the hosts the user reaches us by, so a DNS-rebinding page can't.
    app.add_middleware(
        TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts, www_redirect=False
    )
    app.include_router(clusters_router)
    app.include_router(watch_router)
    app.include_router(resources_router)
    app.include_router(logs_router)
    app.include_router(exec_router)

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    if settings.static_dir is not None and settings.static_dir.is_dir():
        mount_spa(app, settings.static_dir)  # last: must not shadow /api/*

    return app


app = create_app()
