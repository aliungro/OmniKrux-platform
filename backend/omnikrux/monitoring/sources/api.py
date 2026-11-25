"""Routes for sources: add, change, test, check and remove them, and read what they hold; and
the tools found in a known cluster, and the filter a project should use on a source.

Secrets are write-only: they come in as `SecretStr`, go straight into the store (encrypted) and
come back only as `has_*` flags. Audit `details` carry names and settings, never a value. The
rules a source must follow (`rules.py`) answer 422 with plain words from the handlers (pydantic
only checks the shape: `omnikrux/validation.py` replaces its messages)."""

import logging
import time
from collections import defaultdict
from dataclasses import replace
from datetime import datetime
from typing import Literal, cast

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from omnikrux.clusters.registry import ClusterRegistry
from omnikrux.monitoring.audit import begin_change, finish_change
from omnikrux.monitoring.projects.types import REVIEW_CHANGED, ReviewChanged, UnknownProject
from omnikrux.monitoring.query.filters import FilterError, parse_matchers, render_matchers
from omnikrux.monitoring.query.suggest import suggest_filter
from omnikrux.monitoring.services import MonitoringServices
from omnikrux.monitoring.sources.capability import CapabilityUnknown
from omnikrux.monitoring.sources.connector import LOKI_LABEL_WINDOW, QueryRejected
from omnikrux.monitoring.sources.discovery import (
    CLUSTER_GONE,
    FoundState,
    FoundType,
    UnknownCluster,
)
from omnikrux.monitoring.sources.health import SECRETS_UNREADABLE, HealthOut, run_test
from omnikrux.monitoring.sources.loki import LokiConnector
from omnikrux.monitoring.sources.rules import (
    AUTH_NEEDS,
    CLUSTER_ONLY,
    HEADER_VALUE,
    ONE_SOURCE,
    AuthIn,
    HeaderIn,
    SourceIn,
    auth_secrets,
    check_auth,
    checked_headers,
    checked_name,
    checked_path_prefix,
    checked_url,
    cluster_target,
    config_from_in,
    details_of,
    new_source_of,
    refuse,
    source_details,
)
from omnikrux.monitoring.sources.store import SourceChange
from omnikrux.monitoring.sources.transport import SourceUnreachable
from omnikrux.monitoring.sources.types import (
    AUTH_SECRET,
    QUERYABLE_TYPES,
    AuthType,
    FilterOrigin,
    NameTaken,
    ProjectKind,
    Reach,
    SourceConfig,
    SourceSecrets,
    SourceType,
)

# The source rules live in `rules.py`; these names stay importable from here.
__all__ = [
    "SECRETS_UNREADABLE",
    "SourceIn",
    "config_from_in",
    "finding_router",
    "new_source_of",
    "router",
]

router = APIRouter(prefix="/sources")
log = logging.getLogger(__name__)
# Discovery and filter suggestions live beside /sources, not under it.
finding_router = APIRouter()

TEST_SECONDS = 10.0

FIXED_KIND = "A source's type and how it's reached can't change. Add a new source instead."
SOURCE_GONE = "That source doesn't exist anymore. It may have been removed."
NOT_LINKED = "This source isn't linked to that project."
NOT_SAVED = "The source couldn't be saved. Try again."


# --- Shapes ------------------------------------------------------------------------------------


class SourcePatch(BaseModel):
    """Every field optional; `None` keeps what is stored. `ca_pem: ""` removes the CA."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    type: SourceType | None = None
    reach: Reach | None = None
    url: str | None = None
    cluster_id: str | None = None
    namespace: str | None = None
    service: str | None = None
    port: str | None = None
    scheme: Literal["http", "https"] | None = None
    path_prefix: str | None = None
    auth: AuthIn | None = None
    headers: list[HeaderIn] | None = None
    ca_pem: str | None = None


class AuthOut(BaseModel):
    type: AuthType
    username: str | None
    header_name: str | None
    has_password: bool
    has_token: bool
    has_api_key: bool
    has_client_key: bool
    has_client_cert: bool


class HeaderOut(BaseModel):
    name: str
    has_value: bool


class ProjectRefOut(BaseModel):
    id: str
    name: str


class SourceOut(BaseModel):
    id: str
    name: str
    type: SourceType
    reach: Reach
    url: str | None
    cluster_id: str | None
    cluster_name: str | None
    namespace: str | None
    service: str | None
    port: str | None
    scheme: Literal["http", "https"]
    path_prefix: str
    auth: AuthOut
    headers: list[HeaderOut]
    has_ca: bool
    created_by_project_id: str | None
    installed_by_omnikrux: bool
    used_by: list[ProjectRefOut]
    health: HealthOut
    created_at: datetime
    updated_at: datetime


class TestOut(BaseModel):
    __test__ = False  # not a pytest test class, whatever module imports it

    ok: bool
    version: str | None
    message: str | None


class MetricFieldOut(BaseModel):
    name: str
    type: str | None
    help: str | None
    unit: str | None


class FieldCatalogOut(BaseModel):
    metrics: list[MetricFieldOut]
    labels: list[str]
    truncated: bool


class AlertingOut(BaseModel):
    omnikrux_engine: bool
    tool_engine: Literal["prometheus_rule", "loki_ruler"] | None
    reason: str | None


class FoundToolOut(BaseModel):
    type: FoundType
    state: FoundState
    namespace: str | None
    service: str | None
    port: str | None
    scheme: Literal["http", "https"]
    version: str | None
    message: str | None
    existing_source_id: str | None
    detail: str | None


class DiscoveryOut(BaseModel):
    cluster_id: str
    cluster_name: str
    state: Literal["ok", "error"]
    message: str | None
    found: list[FoundToolOut]
    checked_at: datetime


class SuggestIn(BaseModel):
    """Exactly one of `source_id` (a saved source) and `source` (one as entered)."""

    model_config = ConfigDict(extra="forbid")

    cluster_id: str | None = None
    kind: ProjectKind
    source_id: str | None = None
    source: SourceIn | None = None


class FilterCheckIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    filter: str = Field(max_length=2000)


class FilterCheckOut(BaseModel):
    """`matches` is None when the source couldn't say (`message` has the words)."""

    matches: bool | None
    message: str | None


class SuggestOut(BaseModel):
    filter: str
    origin: FilterOrigin
    reason: str | None


class SourceDeleteReviewOut(BaseModel):
    source_id: str
    name: str
    projects: list[ProjectRefOut]
    token: str


# --- Helpers -----------------------------------------------------------------------------------


def _services(request: Request) -> MonitoringServices:
    return request.app.state.monitoring


def _registry(request: Request) -> ClusterRegistry:
    return request.app.state.registry


async def _source(services: MonitoringServices, id: str) -> SourceConfig:
    try:
        return await services.sources.get(id)
    except KeyError:
        raise HTTPException(status_code=404, detail=SOURCE_GONE) from None


def _unreachable(exc: SourceUnreachable | QueryRejected) -> HTTPException:
    if isinstance(exc, QueryRejected):
        return HTTPException(status_code=exc.status, detail=exc.message)
    return HTTPException(status_code=504 if exc.code == "timeout" else 502, detail=exc.message)


def _readable(source: SourceConfig) -> None:
    if source.secrets_unreadable:
        raise HTTPException(status_code=502, detail=SECRETS_UNREADABLE)


async def _outs(
    services: MonitoringServices, registry: ClusterRegistry, sources: list[SourceConfig]
) -> list[SourceOut]:
    clusters = {c.id: c.name for c in await registry.list()}
    used: dict[str, list[ProjectRefOut]] = defaultdict(list)
    for project in await services.projects.list():
        for link in project.links:
            used[link.source_id].append(ProjectRefOut(id=project.id, name=project.name))
    health = await services.health.peek(sources)
    return [_out(s, clusters, used[s.id], health[s.id]) for s in sources]


def _out(
    s: SourceConfig,
    clusters: dict[str, str],
    used_by: list[ProjectRefOut],
    health: HealthOut,
) -> SourceOut:
    secrets, cluster = s.secrets, s.cluster
    return SourceOut(
        id=s.id,
        name=s.name,
        type=s.type,
        reach=s.reach,
        url=s.url,
        cluster_id=cluster.cluster_id if cluster else None,
        cluster_name=clusters.get(cluster.cluster_id) if cluster else None,
        namespace=cluster.namespace if cluster else None,
        service=cluster.service if cluster else None,
        port=cluster.port if cluster else None,
        scheme=cluster.scheme if cluster else "http",
        path_prefix=s.path_prefix,
        auth=AuthOut(
            type=s.auth_type,
            username=s.username,
            header_name=s.header_name,
            has_password=secrets.password is not None,
            has_token=secrets.token is not None,
            has_api_key=secrets.api_key is not None,
            has_client_key=secrets.client_key_pem is not None,
            has_client_cert=bool(s.client_cert_pem),
        ),
        headers=[HeaderOut(name=n, has_value=n in secrets.headers) for n in s.header_names],
        has_ca=bool(s.ca_pem),
        created_by_project_id=s.created_by_project_id,
        installed_by_omnikrux=s.installed_by_omnikrux,
        used_by=used_by,
        health=health,
        created_at=s.created_at,
        updated_at=s.updated_at,
    )


async def _one_out(request: Request, source: SourceConfig) -> SourceOut:
    [out] = await _outs(_services(request), _registry(request), [source])
    return out


# --- Routes ------------------------------------------------------------------------------------


@router.get("")
async def list_sources(request: Request) -> list[SourceOut]:
    services = _services(request)
    return await _outs(services, _registry(request), await services.sources.list())


@router.post("", status_code=201)
async def add_source(body: SourceIn, request: Request) -> SourceOut:
    services, registry = _services(request), _registry(request)
    config = await config_from_in(body, registry)
    if body.name is None:
        config = replace(config, name=await services.sources.unique_name(config.name))
    record = await begin_change(
        request, "source_add", "source", config.name, await details_of(registry, config)
    )
    try:
        created = await services.sources.create(new_source_of(config))
    except NameTaken as exc:
        await finish_change(request, record, False, str(exc))
        raise HTTPException(status_code=409, detail=str(exc)) from None
    except Exception:
        await finish_change(request, record, False, NOT_SAVED)
        raise
    await finish_change(request, record, True)
    return await _one_out(request, created)


@router.post("/test")
async def test_unsaved_source(body: SourceIn, request: Request) -> TestOut:
    """Test a source as entered; nothing is stored and nothing is audited."""
    services = _services(request)
    config = await config_from_in(body, _registry(request))
    connector = services.connectors.get(config.type)
    result = await run_test(
        connector, services.transports.for_source(config), config.name, TEST_SECONDS
    )
    return TestOut(ok=result.ok, version=result.version, message=result.message)


@router.get("/health")
async def sources_health(request: Request, refresh: bool = False) -> dict[str, HealthOut]:
    services = _services(request)
    return await services.health.all(await services.sources.list(), refresh=refresh)


@router.patch("/{id}")
async def change_source(id: str, body: SourcePatch, request: Request) -> SourceOut:
    services, registry = _services(request), _registry(request)
    old = await _source(services, id)
    if (body.type is not None and body.type != old.type) or (
        body.reach is not None and body.reach != old.reach
    ):
        raise refuse(FIXED_KIND)
    change = await _change(registry, old, body)
    name = change.name or old.name
    details = await source_details(
        registry,
        type=old.type,
        reach=old.reach,
        url=change.url or old.url,
        cluster=change.cluster or old.cluster,
        auth_type=change.auth_type or old.auth_type,
        header_names=(change.header_names if change.header_names is not None else old.header_names),
    )
    record = await begin_change(request, "source_change", "source", name, details)
    try:
        updated = await services.sources.update(id, change)
    except NameTaken as exc:
        await finish_change(request, record, False, str(exc))
        raise HTTPException(status_code=409, detail=str(exc)) from None
    except KeyError:
        await finish_change(request, record, False, SOURCE_GONE)
        raise HTTPException(status_code=404, detail=SOURCE_GONE) from None
    except Exception:
        await finish_change(request, record, False, NOT_SAVED)
        raise
    await finish_change(request, record, True)
    services.health.forget(id)
    return await _one_out(request, updated)


async def _change(registry: ClusterRegistry, old: SourceConfig, body: SourcePatch) -> SourceChange:
    """The checked change for a PATCH; HTTPException 422 with plain words."""
    name = checked_name(body.name) if body.name is not None else None
    url = checked_url(body.url) if body.url is not None and old.reach == "url" else None
    cluster = None
    cluster_fields = (body.cluster_id, body.namespace, body.service, body.port, body.scheme)
    if old.reach == "cluster" and any(v is not None for v in cluster_fields):
        was = old.cluster
        cluster = await cluster_target(
            registry,
            body.cluster_id or (was.cluster_id if was else None),
            body.namespace or (was.namespace if was else None),
            body.service or (was.service if was else None),
            body.port or (was.port if was else None),
            body.scheme or (was.scheme if was else "http"),
        )
    path_prefix = checked_path_prefix(body.path_prefix) if body.path_prefix is not None else None
    if old.reach == "cluster" and (
        (body.auth is not None and body.auth.type != "none") or body.headers
    ):
        raise refuse(CLUSTER_ONLY)

    auth_type = username = header_name = client_cert_pem = None
    secrets = SourceSecrets()
    if body.auth is not None:
        auth = body.auth
        same = auth.type == old.auth_type
        secrets = auth_secrets(auth)
        username = auth.username if auth.username is not None else (old.username if same else None)
        header_name = (
            auth.header_name
            if auth.header_name is not None
            else (old.header_name if same else None)
        )
        client_cert_pem = (
            auth.client_cert_pem
            if auth.client_cert_pem is not None
            else (old.client_cert_pem if same else None)
        )
        stored = set()
        if same and not old.secrets_unreadable:
            stored = {
                key
                for key in ("password", "token", "api_key", "client_key_pem")
                if getattr(old.secrets, key) is not None
            }
        check_auth(auth.type, username, header_name, client_cert_pem, secrets, stored)
        auth_type = auth.type
        # The store reads None as "keep": a type change clears the old type's settings itself.
        username, header_name, client_cert_pem = (
            username or "",
            header_name or "",
            client_cert_pem or "",
        )

    if old.secrets_unreadable and (body.auth is not None or body.headers is not None):
        # Nothing readable is left to keep: every secret the source still uses is entered again.
        if body.auth is None and AUTH_SECRET.get(old.auth_type) is not None:
            raise refuse(AUTH_NEEDS[old.auth_type])
        if body.headers is None and old.header_names:
            raise refuse(HEADER_VALUE.format(name=old.header_names[0]))

    header_names = None
    if body.headers is not None:
        kept = () if old.secrets_unreadable else old.header_names
        header_names, values = checked_headers(body.headers, kept=kept)
        secrets = replace(secrets, headers=values)

    return SourceChange(
        name=name,
        url=url,
        cluster=cluster,
        path_prefix=path_prefix,
        auth_type=auth_type,
        username=username,
        header_name=header_name,
        client_cert_pem=client_cert_pem,
        ca_pem=body.ca_pem,
        header_names=header_names,
        secrets=secrets,
    )


@router.post("/{id}/test")
async def test_source(id: str, request: Request) -> TestOut:
    """Test a stored source; the result is kept as its last check and refreshes the cache."""
    services = _services(request)
    health = await services.health.check(await _source(services, id), timeout=TEST_SECONDS)
    return TestOut(ok=health.state == "up", version=health.version, message=health.message)


@router.get("/{id}/delete-review")
async def source_delete_review(id: str, request: Request) -> SourceDeleteReviewOut:
    services = _services(request)
    review = await services.projects.source_delete_review(await _source(services, id))
    return SourceDeleteReviewOut(
        source_id=review.source_id,
        name=review.name,
        projects=[ProjectRefOut(id=p.id, name=p.name) for p in review.projects],
        token=review.token,
    )


@router.delete("/{id}", status_code=204)
async def remove_source(id: str, token: str, request: Request) -> Response:
    services, registry = _services(request), _registry(request)
    source = await _source(services, id)
    record = await begin_change(
        request, "source_remove", "source", source.name, await details_of(registry, source)
    )
    try:
        review = await services.projects.delete_source(id, token, services.sources)
    except ReviewChanged:
        await finish_change(request, record, False, REVIEW_CHANGED)
        raise HTTPException(status_code=409, detail=REVIEW_CHANGED) from None
    except KeyError:
        await finish_change(request, record, False, SOURCE_GONE)
        raise HTTPException(status_code=404, detail=SOURCE_GONE) from None
    except Exception:
        await finish_change(request, record, False, "The source couldn't be removed. Try again.")
        raise
    await finish_change(request, record, True)
    services.health.forget(id)
    services.transports.forget(id)
    # The projects that linked it: their alert rules read another source of the type, or say
    # they have none.
    for project in review.projects:
        try:
            await services.alert_sync.reconcile_scope("project", project.id)
        except Exception as exc:  # noqa: BLE001 (the source is gone; rules converge at start)
            log.warning(
                "Bringing the alert rules of project %s up to date failed (%s)",
                project.id,
                type(exc).__name__,
            )
    return Response(status_code=204)


@router.get("/{id}/fields")
async def source_fields(id: str, project: str, request: Request) -> FieldCatalogOut:
    """The metrics and labels the source holds for that project (its link filter applied)."""
    services = _services(request)
    source = await _source(services, id)
    try:
        linked = await services.projects.get(project)
    except UnknownProject:
        raise HTTPException(status_code=404, detail=NOT_LINKED) from None
    link = next((link for link in linked.links if link.source_id == id), None)
    if link is None:
        raise HTTPException(status_code=404, detail=NOT_LINKED)
    _readable(source)
    connector = services.connectors.get(source.type)
    try:
        catalog = await connector.describe_fields(
            services.transports.for_source(source), matchers=link.matchers
        )
    except (SourceUnreachable, QueryRejected) as exc:
        raise _unreachable(exc) from None
    return FieldCatalogOut(
        metrics=[
            MetricFieldOut(name=m.name, type=m.type, help=m.help, unit=m.unit)
            for m in catalog.metrics
        ],
        labels=list(catalog.labels),
        truncated=catalog.truncated,
    )


@router.post("/{id}/filter-check")
async def check_filter(id: str, body: FilterCheckIn, request: Request) -> FilterCheckOut:
    """Whether anything in the source matches the filter: one small question to the source
    (a metric name under the filter, or the label names of its streams in the last seven days).
    Nothing is stored. An empty filter matches by definition."""
    services = _services(request)
    source = await _source(services, id)
    try:
        matchers = parse_matchers(body.filter)
    except FilterError as exc:
        raise refuse(str(exc)) from None
    if not matchers:
        return FilterCheckOut(matches=True, message=None)
    if source.secrets_unreadable:
        return FilterCheckOut(matches=None, message=SECRETS_UNREADABLE)
    if source.type not in QUERYABLE_TYPES:
        return FilterCheckOut(matches=None, message=None)
    connector = services.connectors.get(source.type)
    transport = services.transports.for_source(source)
    try:
        if source.type == "loki":
            now = time.time()
            names = await cast("LokiConnector", connector).label_names(
                transport, matchers=matchers, start=now - LOKI_LABEL_WINDOW, end=now
            )
            found = bool(names)
        else:
            found = bool(
                await connector.label_values(transport, "__name__", matchers=matchers, limit=1)
            )
    except (SourceUnreachable, QueryRejected) as exc:
        return FilterCheckOut(matches=None, message=exc.message)
    return FilterCheckOut(matches=found, message=None)


@router.get("/{id}/alerting")
async def source_alerting(id: str, request: Request) -> AlertingOut:
    """What the source's tool can run, read now (the answer refreshes the rules' cache)."""
    services = _services(request)
    source = await _source(services, id)
    _readable(source)
    try:
        capability = await services.capabilities.get(source, refresh=True)
    except CapabilityUnknown as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message) from None
    return AlertingOut(
        omnikrux_engine=capability.omnikrux_engine,
        tool_engine=capability.tool_engine,
        reason=capability.reason,
    )


@finding_router.get("/discovery/{cluster_id}")
async def discover_tools(cluster_id: str, request: Request) -> DiscoveryOut:
    """The Prometheus, Loki and Grafana running in a known cluster, each probed now."""
    try:
        result = await _services(request).discovery.find(cluster_id)
    except UnknownCluster:
        raise HTTPException(status_code=404, detail=CLUSTER_GONE) from None
    return DiscoveryOut(
        cluster_id=result.cluster_id,
        cluster_name=result.cluster_name,
        state=result.state,
        message=result.message,
        found=[
            FoundToolOut(
                type=t.type,
                state=t.state,
                namespace=t.namespace,
                service=t.service,
                port=t.port,
                scheme=t.scheme,
                version=t.version,
                message=t.message,
                existing_source_id=t.existing_source_id,
                detail=t.detail,
            )
            for t in result.found
        ],
        checked_at=result.checked_at,
    )


@finding_router.post("/suggest-filter")
async def suggest_source_filter(body: SuggestIn, request: Request) -> SuggestOut:
    """The label filter a project should use on a source; nothing is stored or audited."""
    if (body.source_id is None) == (body.source is None):
        raise refuse(ONE_SOURCE)
    services, registry = _services(request), _registry(request)
    cluster = None
    if body.cluster_id is not None:
        try:
            cluster = await registry.get(body.cluster_id)
        except KeyError:
            raise HTTPException(status_code=404, detail=CLUSTER_GONE) from None
    if body.source is not None:
        source = await config_from_in(body.source, registry)
    else:
        source = await _source(services, body.source_id or "")
    suggestion = await suggest_filter(
        kind=body.kind,
        cluster=cluster,
        source=source,
        connector=services.connectors.get(source.type),
        transport=services.transports.for_source(source),
    )
    return SuggestOut(
        filter=render_matchers(suggestion.matchers),
        origin=suggestion.origin,
        reason=suggestion.reason,
    )
