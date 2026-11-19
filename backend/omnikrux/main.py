import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError
from starlette.middleware.trustedhost import TrustedHostMiddleware

from omnikrux.actions.jobs import JobRunner
from omnikrux.actions.pipeline import PlanStore
from omnikrux.actions.pipeline import router as actions_router
from omnikrux.audit.api import router as audit_router
from omnikrux.audit.store import AuditLog
from omnikrux.cloud.adapters import make_adapters
from omnikrux.cloud.api import router as cloud_router
from omnikrux.cloud.discovery import CloudDiscovery
from omnikrux.cloud.exec_bridge import ExecBridge
from omnikrux.cloud.http import CloudHttp
from omnikrux.cloud.store import CloudAccountStore
from omnikrux.cloud.tokens import CloudServices, TokenBroker
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
from omnikrux.kube.client import CloudApiClient
from omnikrux.kube.connections import ClusterConnections, cloud_kube_error
from omnikrux.kube.source import KubeResourceSource
from omnikrux.logs.api import router as logs_router
from omnikrux.metrics.api import router as metrics_router
from omnikrux.metrics.cache import MetricsCache
from omnikrux.portforward.api import router as portforward_router
from omnikrux.portforward.manager import PortForwardManager
from omnikrux.resources.api import router as resources_router
from omnikrux.resources.catalog import KindCatalog
from omnikrux.resources.kinds_api import router as kinds_router
from omnikrux.security.secrets import SecretBox
from omnikrux.stream_sessions import StreamSessions
from omnikrux.validation import validation_error
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


async def _mark_interrupted(audit: AuditLog) -> None:
    """Records the last run left `started` can't be finished any more: they become `unknown`."""
    try:
        count = await audit.mark_interrupted()
    except Exception as exc:  # noqa: BLE001 (never stops startup; writes say why if it's broken)
        log.warning("Could not check the audit log for unfinished records (%s)", type(exc).__name__)
        return
    if count:
        log.warning(
            "%d audit record(s) were still open when the console stopped; marked unknown", count
        )


def create_app(settings: Settings | None = None) -> FastAPI:
    if settings is None:
        try:
            settings = get_settings()
        except ValidationError as exc:
            fields = {
                error["loc"] for error in exc.errors(include_input=False, include_context=False)
            }
            if ("cloud_discovery_seconds",) in fields:
                raise SystemExit(
                    "OmniKrux can't start: OMNIKRUX_CLOUD_DISCOVERY_SECONDS must be a whole "
                    "number of at least 60."
                ) from None
            raise
    try:
        forward_ports = settings.forward_ports
        forward_bind = settings.forward_bind
        endpoints = settings.endpoints
        if settings.cloud_discovery_seconds < 60:
            raise ValueError(
                "OMNIKRUX_CLOUD_DISCOVERY_SECONDS must be at least 60, "
                f"not {settings.cloud_discovery_seconds}."
            )
    except ValueError as exc:  # said in plain words, without a traceback
        raise SystemExit(f"OmniKrux can't start: {exc}") from None

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = make_engine(settings.db_url)
        await init_db(engine)
        sessionmaker = make_sessionmaker(engine)
        box = SecretBox.from_settings(settings)
        registry = ClusterRegistry(sessionmaker, box, endpoints=endpoints)

        http = CloudHttp()
        store = CloudAccountStore(sessionmaker, box)
        dirs = settings.cloud_dirs
        adapters = make_adapters(http, endpoints, dirs)
        broker = TokenBroker(registry, store, adapters)
        bridge = ExecBridge(dirs, endpoints, http)
        connections = ClusterConnections(
            registry, tokens_for=broker.tokens_for, exec_resolver=bridge.resolve
        )
        catalog = KindCatalog(connections, registry, is_cloud=registry.is_cloud)

        async def source_for(cluster_id: str, kind_key: str) -> KubeResourceSource:
            spec = await catalog.spec(cluster_id, kind_key)  # KindNotServed: the cache says so
            cloud = await registry.is_cloud(cluster_id)
            try:
                api = await connections.open_api(cluster_id)
            except Exception as exc:
                if not cloud:
                    raise
                raise cloud_kube_error("open the cluster connection", exc=exc) from None
            return KubeResourceSource(api, spec, cloud=cloud or isinstance(api, CloudApiClient))

        audit = AuditLog(sessionmaker, registry)
        forwards = PortForwardManager(
            connections, registry, audit, ports=forward_ports, bind=forward_bind
        )
        streams = StreamSessions(registry)

        async def on_forget(cluster_id: str) -> None:
            catalog.forget(cluster_id)
            connections.forget(cluster_id)
            broker.forget(cluster_id)
            await asyncio.gather(
                forwards.stop_cluster(cluster_id),
                streams.stop_cluster(cluster_id),
                app.state.jobs.stop_cluster(cluster_id),
            )

        hub = WatchHub(registry, source_for, on_forget=on_forget)
        discovery = CloudDiscovery(
            store, adapters, registry, hub, broker, interval=settings.cloud_discovery_seconds
        )
        await _mark_interrupted(audit)
        app.state.engine = engine
        app.state.sessionmaker = sessionmaker
        app.state.registry = registry
        app.state.cloud = CloudServices(store, adapters, broker, http, discovery)
        app.state.connections = connections
        app.state.catalog = catalog
        app.state.hub = hub
        app.state.audit = audit
        metrics = app.state.metrics = MetricsCache(connections)
        app.state.plans = PlanStore()
        jobs = app.state.jobs = JobRunner(audit)
        app.state.forwards = forwards
        app.state.streams = streams
        try:
            for cluster_id in await _import_kubeconfig_files(settings, registry):
                await hub.forget(cluster_id)
            discovery.start()
            yield
        finally:
            await discovery.close()
            await jobs.close()  # first: a stopped drain still writes its audit record
            await forwards.close()  # likewise: every forward's record is finished
            await streams.close()
            await hub.close()
            await metrics.close()
            await catalog.close()
            await broker.close()
            await bridge.close()
            await http.close()
            await engine.dispose()

    app = FastAPI(title="OmniKrux", lifespan=lifespan)
    app.add_exception_handler(RequestValidationError, validation_error)
    app.state.settings = settings
    # No login yet, so no session cookie to check either: refuse writes that another site's
    # page sends (it could otherwise start a node shell or delete a cluster).
    app.add_middleware(CrossOriginWriteGuard)
    # No login yet: only answer to the hosts the user reaches us by, so a DNS-rebinding page can't.
    app.add_middleware(
        TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts, www_redirect=False
    )
    app.include_router(clusters_router)
    app.include_router(cloud_router)
    app.include_router(watch_router)
    app.include_router(resources_router)
    app.include_router(kinds_router)
    app.include_router(logs_router)
    app.include_router(exec_router)
    app.include_router(audit_router)
    app.include_router(actions_router)
    app.include_router(metrics_router)
    app.include_router(portforward_router)

    @app.get("/api/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    if settings.static_dir is not None and settings.static_dir.is_dir():
        mount_spa(app, settings.static_dir)  # last: must not shadow /api/*

    return app


app = create_app()
