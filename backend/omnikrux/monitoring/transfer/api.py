"""Routes for import and export, and for the Grafana connections imports read from.

Every refusal answers `detail = {"code": TransferErrorCode, "message": plain words, "key": the
dashboard or source key it is about or null, "problems": [{path, message}]}` through
`transfer_error`. Bodies are read here, not by FastAPI, so a body of the wrong shape is refused
in the same shape and words. An export is audited (`monitoring_export`) before it is answered,
and so is every change to a Grafana connection (`grafana_add`, `grafana_change`,
`grafana_remove`) before it is made."""

import json
from dataclasses import replace
from datetime import datetime
from typing import Literal, cast
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, SecretStr, ValidationError

from omnikrux.clusters.registry import ClusterRegistry
from omnikrux.monitoring.audit import begin_change, finish_change
from omnikrux.monitoring.dashboards.api import FIELD_INVALID, FIELD_UNKNOWN, NOT_AN_OBJECT, NOT_JSON
from omnikrux.monitoring.models import now
from omnikrux.monitoring.services import MonitoringServices
from omnikrux.monitoring.sources.rules import CLUSTER_NAMES, CLUSTER_UNKNOWN
from omnikrux.monitoring.sources.transport import (
    _DNS_LABEL,
    _PORT,
    HEADER_VALUE_RULE,
    URL_RULE,
    validate_header,
    validate_path_prefix,
    validate_url,
)
from omnikrux.monitoring.sources.types import (
    MAX_NAME,
    NAME_RULE,
    ClusterTarget,
    NameTaken,
    Reach,
    clean_name,
)
from omnikrux.monitoring.transfer.envelope import ExportKind
from omnikrux.monitoring.transfer.export import build_export
from omnikrux.monitoring.transfer.grafana_client import GrafanaError
from omnikrux.monitoring.transfer.grafana_store import (
    GrafanaAuth,
    GrafanaChange,
    GrafanaConfig,
    GrafanaSecrets,
    NewGrafana,
    UnknownGrafana,
    same_grafana,
)
from omnikrux.monitoring.transfer.types import TransferError

EXPORT_KIND_CHOICE = 'Choose "dashboard", "project" or "group" to export.'
EXPORT_ID_NEEDED = "Choose the dashboard, project or group to export by its id."
_FIELD_WORDS = {"kind": EXPORT_KIND_CHOICE, "id": EXPORT_ID_NEEDED}

router = APIRouter()


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ExportIn(_Body):
    kind: ExportKind
    id: str


class ExportOut(BaseModel):
    file_name: str
    export: dict
    dashboards: int
    sources: int
    alerts: int


def transfer_error(exc: TransferError) -> HTTPException:
    """The refusal a route answers for `exc`."""
    return HTTPException(
        status_code=exc.status,
        detail={
            "code": exc.code,
            "message": exc.message,
            "key": exc.key,
            "problems": [{"path": p.path, "message": p.message} for p in exc.problems],
        },
    )


def _schema(model: type[BaseModel]) -> dict:
    """The body's schema for the OpenAPI document (the handler reads the body itself)."""
    return {
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": model.model_json_schema()}},
        }
    }


async def read_body[Body: BaseModel](
    request: Request, model: type[Body], words: dict[str, str] | None = None
) -> Body:
    """The body as `model`; 422 `invalid_input` in plain words when it isn't one (`words`: what
    each field is told). Never the value sent."""
    raw = await request.body()
    try:
        data = json.loads(raw)
    except (ValueError, RecursionError):  # RecursionError: nesting too deep to read
        raise transfer_error(TransferError(422, "invalid_input", NOT_JSON)) from None
    if not isinstance(data, dict):
        raise transfer_error(TransferError(422, "invalid_input", NOT_AN_OBJECT))
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        error = exc.errors()[0]
        if error.get("type") == "extra_forbidden":
            message = FIELD_UNKNOWN
        else:
            field = str((error.get("loc") or ("",))[0])
            message = (words or {}).get(field, FIELD_INVALID)
        raise transfer_error(TransferError(422, "invalid_input", message)) from None


@router.post("/export", openapi_extra=_schema(ExportIn))
async def export(request: Request) -> ExportOut:
    """The dashboard, project or group as an OmniKrux export file, with its name and counts."""
    body = await read_body(request, ExportIn, _FIELD_WORDS)
    services = cast(MonitoringServices, request.app.state.monitoring)
    try:
        file_name, out, counts = await build_export(
            services, request.app.state.registry, body.kind, body.id, now=now()
        )
    except TransferError as exc:
        raise transfer_error(exc) from None
    if body.kind == "dashboard":
        name = out["dashboards"][0]["dashboard"]["title"]
    else:
        name = out["owner"]["name"]
    details = {"dashboards": counts.dashboards, "sources": counts.sources, "alerts": counts.alerts}
    record = await begin_change(request, "monitoring_export", body.kind, name, details)
    await finish_change(request, record, True)
    return ExportOut(
        file_name=file_name,
        export=out,
        dashboards=counts.dashboards,
        sources=counts.sources,
        alerts=counts.alerts,
    )


# --- Grafana connections -----------------------------------------------------------------------
#
# Secrets are write-only: the token or password comes in as `SecretStr`, goes straight into the
# store (encrypted) and comes back only as `has_*` flags. Audit details say where and which
# sign-in, never a value. A Grafana that can't be read answers `code: "grafana"` with its words.

GRAFANA_GONE = "That Grafana connection no longer exists."
REACH_FIXED = "A connection's reach can't change. Add a new one instead."
CLUSTER_PICK = "Pick the cluster, namespace, service and port."
# M1's address rule with a Grafana example (its own names a Prometheus one).
GRAFANA_URL_RULE = "Use an http or https address with a host, like http://grafana.example:3000."
CLUSTER_NO_SIGN_IN = (
    "A Grafana reached through its cluster is read without a sign-in. Use its address to sign in."
)
TOKEN_NEEDED = "A service account token is needed."
BASIC_NEEDS = "Basic sign-in needs a user name and a password."
GRAFANA_NOT_SAVED = "The Grafana connection couldn't be saved. Try again."


class GrafanaAuthIn(_Body):
    type: GrafanaAuth = "none"
    username: str | None = None
    password: SecretStr | None = None
    token: SecretStr | None = None


class GrafanaIn(_Body):
    name: str | None = None
    reach: Reach
    url: str | None = None
    cluster_id: str | None = None
    namespace: str | None = None
    service: str | None = None
    port: str | None = None
    scheme: Literal["http", "https"] = "http"
    path_prefix: str = ""
    auth: GrafanaAuthIn = Field(default_factory=GrafanaAuthIn)


class GrafanaAuthPatch(_Body):
    """A sign-in change: `type` None keeps the connection's current sign-in."""

    type: GrafanaAuth | None = None
    username: str | None = None
    password: SecretStr | None = None
    token: SecretStr | None = None


class GrafanaPatch(_Body):
    """Every field optional; `None` keeps what is stored. A secret left out keeps the stored one
    while the sign-in stays the same."""

    name: str | None = None
    reach: Reach | None = None
    url: str | None = None
    cluster_id: str | None = None
    namespace: str | None = None
    service: str | None = None
    port: str | None = None
    scheme: Literal["http", "https"] | None = None
    path_prefix: str | None = None
    auth: GrafanaAuthPatch | None = None


class GrafanaAuthOut(BaseModel):
    type: GrafanaAuth
    username: str | None
    has_password: bool
    has_token: bool


class GrafanaOut(BaseModel):
    id: str
    name: str
    reach: Reach
    url: str | None
    cluster_id: str | None
    cluster_name: str | None
    namespace: str | None
    service: str | None
    port: str | None
    scheme: Literal["http", "https"]
    path_prefix: str
    auth: GrafanaAuthOut
    dashboards_imported: int
    # The name of another connection that reaches this same Grafana (its target only).
    same_as: str | None
    created_at: datetime
    updated_at: datetime


class GrafanaTestOut(BaseModel):
    __test__ = False  # not a pytest test class, whatever module imports it

    ok: bool
    version: str | None
    message: str | None
    dashboards: int | None
    # After a good test: the name of a saved connection that already reaches this Grafana.
    same_as: str | None = None


class GrafanaDashboardOut(BaseModel):
    uid: str
    title: str
    folder: str | None
    tags: list[str]


class GrafanaDashboardsOut(BaseModel):
    items: list[GrafanaDashboardOut]
    truncated: bool


def _refuse(message: str) -> HTTPException:
    return transfer_error(TransferError(422, "invalid_input", message))


def grafana_error(exc: GrafanaError) -> HTTPException:
    """The refusal a route answers for a Grafana that couldn't be read."""
    return transfer_error(TransferError(exc.status, "grafana", exc.message))


def _gone() -> HTTPException:
    return transfer_error(TransferError(404, "not_found", GRAFANA_GONE))


def _taken(exc: NameTaken) -> HTTPException:
    return transfer_error(TransferError(409, "name_taken", str(exc)))


def _secret(value: SecretStr | None) -> str | None:
    return value.get_secret_value() if value is not None else None


def _name(name: str) -> str:
    try:
        return clean_name(name)
    except ValueError:
        raise _refuse(NAME_RULE) from None


def _url(url: str | None) -> str:
    try:
        return validate_url(url or "")
    except ValueError as exc:
        raise _refuse(GRAFANA_URL_RULE if str(exc) == URL_RULE else str(exc)) from None


def _path_prefix(path_prefix: str) -> str:
    try:
        return validate_path_prefix(path_prefix)
    except ValueError as exc:
        raise _refuse(str(exc)) from None


async def _cluster(
    registry: ClusterRegistry,
    cluster_id: str | None,
    namespace: str | None,
    service: str | None,
    port: str | None,
    scheme: Literal["http", "https"],
) -> tuple[ClusterTarget, str]:
    """The checked cluster service and the cluster's name."""
    if not (cluster_id and namespace and service and port):
        raise _refuse(CLUSTER_PICK)
    if not (_DNS_LABEL.match(namespace) and _DNS_LABEL.match(service) and _PORT.match(port)):
        raise _refuse(CLUSTER_NAMES)
    try:
        info = await registry.get(cluster_id)
    except KeyError:
        raise _refuse(CLUSTER_UNKNOWN) from None
    return ClusterTarget(cluster_id, namespace, service, port, scheme), info.name


def _check_sign_in(
    auth_type: GrafanaAuth, username: str | None, has_password: bool, token: str | None
) -> None:
    """Each sign-in has what it needs, given now or kept from before."""
    if auth_type == "bearer":
        if not token:
            raise _refuse(TOKEN_NEEDED)
        try:
            validate_header("Authorization", token)
        except ValueError:
            raise _refuse(HEADER_VALUE_RULE) from None
    if auth_type == "basic" and not (username and has_password):
        raise _refuse(BASIC_NEEDS)


async def grafana_config_from_in(body: GrafanaIn, registry: ClusterRegistry) -> GrafanaConfig:
    """A checked, unsaved connection (`id=""`) as the user entered it; 422 `invalid_input` with
    plain words when it breaks a rule. Without a name it gets `Grafana · {host or cluster}` (not
    yet made unique: `GrafanaStore.unique_name` does that when it is saved)."""
    auth = body.auth
    url: str | None = None
    cluster: ClusterTarget | None = None
    if body.reach == "url":
        url = _url(body.url)
        where = urlsplit(url).hostname or url
    else:
        if auth.type != "none":
            raise _refuse(CLUSTER_NO_SIGN_IN)
        cluster, where = await _cluster(
            registry, body.cluster_id, body.namespace, body.service, body.port, body.scheme
        )
    path_prefix = _path_prefix(body.path_prefix)
    password, token = _secret(auth.password), _secret(auth.token)
    _check_sign_in(auth.type, auth.username, bool(password), token)
    moment = now()
    default = f"Grafana · {where}"[:MAX_NAME].strip()
    return GrafanaConfig(
        id="",
        name=_name(body.name) if body.name is not None else default,
        reach=body.reach,
        url=url,
        cluster=cluster,
        path_prefix=path_prefix,
        auth_type=auth.type,
        username=auth.username if auth.type == "basic" else None,
        secrets=GrafanaSecrets(
            password=password if auth.type == "basic" else None,
            token=token if auth.type == "bearer" else None,
        ),
        created_at=moment,
        updated_at=moment,
    )


def _services(request: Request) -> MonitoringServices:
    return cast(MonitoringServices, request.app.state.monitoring)


def _registry(request: Request) -> ClusterRegistry:
    return request.app.state.registry


async def _stored(services: MonitoringServices, id: str) -> GrafanaConfig:
    try:
        return await services.grafana.get(id)
    except UnknownGrafana:
        raise _gone() from None


def _target(cfg: GrafanaConfig, clusters: dict[str, str]) -> str:
    c = cfg.cluster
    if c is None:
        return cfg.url or ""
    return f"{clusters.get(c.cluster_id, c.cluster_id)}/{c.namespace}/{c.service}:{c.port}"


async def _details(registry: ClusterRegistry, cfg: GrafanaConfig) -> dict:
    """What an audit record says about a connection: where it is and its sign-in, never a
    secret."""
    clusters = {c.id: c.name for c in await registry.list()}
    return {"reach": cfg.reach, "target": _target(cfg, clusters), "auth": cfg.auth_type}


async def _other_reaching(
    services: MonitoringServices, cfg: GrafanaConfig, others: list[GrafanaConfig] | None = None
) -> GrafanaConfig | None:
    """The oldest other saved connection reaching the same Grafana as `cfg`."""
    found = [
        g
        for g in (await services.grafana.list() if others is None else others)
        if g.id != cfg.id and same_grafana(g, cfg)
    ]
    return min(found, key=lambda g: (g.created_at, g.id), default=None)


async def _outs(
    services: MonitoringServices, registry: ClusterRegistry, configs: list[GrafanaConfig]
) -> list[GrafanaOut]:
    clusters = {c.id: c.name for c in await registry.list()}
    outs = []
    saved = await services.grafana.list()
    for g in configs:
        c = g.cluster
        other = await _other_reaching(services, g, saved)
        outs.append(
            GrafanaOut(
                id=g.id,
                name=g.name,
                reach=g.reach,
                url=g.url,
                cluster_id=c.cluster_id if c else None,
                cluster_name=clusters.get(c.cluster_id) if c else None,
                namespace=c.namespace if c else None,
                service=c.service if c else None,
                port=c.port if c else None,
                scheme=c.scheme if c else "http",
                path_prefix=g.path_prefix,
                auth=GrafanaAuthOut(
                    type=g.auth_type,
                    username=g.username,
                    has_password=g.secrets.password is not None,
                    has_token=g.secrets.token is not None,
                ),
                dashboards_imported=len(await services.origins.from_grafana(g.id)),
                same_as=other.name if other else None,
                created_at=g.created_at,
                updated_at=g.updated_at,
            )
        )
    return outs


@router.get("/grafana")
async def list_grafana(request: Request) -> list[GrafanaOut]:
    services = _services(request)
    return await _outs(services, _registry(request), await services.grafana.list())


@router.post("/grafana", status_code=201, openapi_extra=_schema(GrafanaIn))
async def add_grafana(request: Request) -> GrafanaOut:
    body = await read_body(request, GrafanaIn)
    services, registry = _services(request), _registry(request)
    cfg = await grafana_config_from_in(body, registry)
    if body.name is None:
        cfg = replace(cfg, name=await services.grafana.unique_name(cfg.name))
    record = await begin_change(
        request, "grafana_add", "grafana", cfg.name, await _details(registry, cfg)
    )
    try:
        created = await services.grafana.create(
            NewGrafana(
                name=cfg.name,
                reach=cfg.reach,
                url=cfg.url,
                cluster=cfg.cluster,
                path_prefix=cfg.path_prefix,
                auth_type=cfg.auth_type,
                username=cfg.username,
                secrets=cfg.secrets,
            )
        )
    except NameTaken as exc:
        await finish_change(request, record, False, str(exc))
        raise _taken(exc) from None
    except Exception:
        await finish_change(request, record, False, GRAFANA_NOT_SAVED)
        raise
    await finish_change(request, record, True)
    [out] = await _outs(services, registry, [created])
    return out


async def _change(
    registry: ClusterRegistry, old: GrafanaConfig, body: GrafanaPatch
) -> tuple[GrafanaChange, GrafanaConfig]:
    """The checked change for a PATCH, and the connection as it will read (for the audit)."""
    if body.reach is not None and body.reach != old.reach:
        raise _refuse(REACH_FIXED)
    name = _name(body.name) if body.name is not None else None
    url = _url(body.url) if body.url is not None and old.reach == "url" else None
    cluster = None
    fields = (body.cluster_id, body.namespace, body.service, body.port, body.scheme)
    if old.reach == "cluster" and any(v is not None for v in fields):
        was = old.cluster
        cluster, _ = await _cluster(
            registry,
            body.cluster_id or (was.cluster_id if was else None),
            body.namespace or (was.namespace if was else None),
            body.service or (was.service if was else None),
            body.port or (was.port if was else None),
            body.scheme or (was.scheme if was else "http"),
        )
    path_prefix = _path_prefix(body.path_prefix) if body.path_prefix is not None else None

    auth_type, username = None, None
    secrets = GrafanaSecrets()
    if body.auth is not None:
        auth = body.auth
        # Without a type the sign-in stays as it is; only the values given change.
        kind: GrafanaAuth = auth.type if auth.type is not None else old.auth_type
        if old.reach == "cluster" and kind != "none":
            raise _refuse(CLUSTER_NO_SIGN_IN)
        # What is stored counts only for the same sign-in, and only while it can be read.
        same = kind == old.auth_type and not old.secrets_unreadable
        password, token = _secret(auth.password), _secret(auth.token)
        username = auth.username if auth.username is not None else (old.username if same else None)
        has_password = bool(password) or (password is None and same and bool(old.secrets.password))
        kept_token = old.secrets.token if same and token is None else None
        _check_sign_in(kind, username, has_password, token or kept_token)
        auth_type = kind
        secrets = GrafanaSecrets(
            password=password if kind == "basic" else None,
            token=token if kind == "bearer" else None,
        )
        username = username or ""  # the store reads None as "keep"
    change = GrafanaChange(
        name=name,
        url=url,
        cluster=cluster,
        path_prefix=path_prefix,
        auth_type=auth_type,
        username=username,
        secrets=secrets,
    )
    after = replace(
        old,
        name=name or old.name,
        url=url or old.url,
        cluster=cluster or old.cluster,
        auth_type=auth_type or old.auth_type,
    )
    return change, after


@router.patch("/grafana/{id}", openapi_extra=_schema(GrafanaPatch))
async def change_grafana(id: str, request: Request) -> GrafanaOut:
    body = await read_body(request, GrafanaPatch)
    services, registry = _services(request), _registry(request)
    old = await _stored(services, id)
    change, after = await _change(registry, old, body)
    record = await begin_change(
        request, "grafana_change", "grafana", after.name, await _details(registry, after)
    )
    try:
        updated = await services.grafana.update(id, change)
    except NameTaken as exc:
        await finish_change(request, record, False, str(exc))
        raise _taken(exc) from None
    except UnknownGrafana:
        await finish_change(request, record, False, GRAFANA_GONE)
        raise _gone() from None
    except Exception:
        await finish_change(request, record, False, GRAFANA_NOT_SAVED)
        raise
    await finish_change(request, record, True)
    services.transports.forget(f"grafana:{id}")
    [out] = await _outs(services, registry, [updated])
    return out


@router.delete("/grafana/{id}", status_code=204)
async def remove_grafana(id: str, request: Request) -> Response:
    """Remove the connection; the dashboards imported through it stay."""
    services = _services(request)
    old = await _stored(services, id)
    imported = len(await services.origins.from_grafana(id))
    record = await begin_change(
        request, "grafana_remove", "grafana", old.name, {"dashboards_imported": imported}
    )
    other = await _other_reaching(services, old)
    try:
        await services.grafana.delete(id, hand_over_to=other.id if other else None)
    except UnknownGrafana:
        await finish_change(request, record, False, GRAFANA_GONE)
        raise _gone() from None
    except Exception:
        await finish_change(request, record, False, GRAFANA_NOT_SAVED)
        raise
    await finish_change(request, record, True)
    services.transports.forget(f"grafana:{id}")
    return Response(status_code=204)


async def _test(services: MonitoringServices, cfg: GrafanaConfig) -> GrafanaTestOut:
    """Its health, then its dashboards: a Grafana whose dashboards can't be listed can't be
    imported from, so the test says why."""
    client = services.grafana_client
    health = await client.health(cfg)
    if not health.ok:
        return GrafanaTestOut(
            ok=False, version=health.version, message=health.message, dashboards=None
        )
    try:
        found = await client.search(cfg)
    except GrafanaError as exc:
        return GrafanaTestOut(
            ok=False, version=health.version, message=exc.message, dashboards=None
        )
    other = await _other_reaching(services, cfg)
    return GrafanaTestOut(
        ok=True,
        version=health.version,
        message=None,
        dashboards=len(found.items),
        same_as=other.name if other else None,
    )


@router.post("/grafana/test", openapi_extra=_schema(GrafanaIn))
async def test_unsaved_grafana(request: Request) -> GrafanaTestOut:
    """Test a connection as entered; nothing is stored and nothing is audited."""
    body = await read_body(request, GrafanaIn)
    cfg = await grafana_config_from_in(body, _registry(request))
    return await _test(_services(request), cfg)


@router.post("/grafana/{id}/test")
async def test_grafana(id: str, request: Request) -> GrafanaTestOut:
    services = _services(request)
    return await _test(services, await _stored(services, id))


async def _dashboards(services: MonitoringServices, cfg: GrafanaConfig) -> GrafanaDashboardsOut:
    try:
        found = await services.grafana_client.search(cfg)
    except GrafanaError as exc:
        raise grafana_error(exc) from None
    return GrafanaDashboardsOut(
        items=[
            GrafanaDashboardOut(uid=i.uid, title=i.title, folder=i.folder, tags=i.tags)
            for i in found.items
        ],
        truncated=found.truncated,
    )


@router.get("/grafana/{id}/dashboards")
async def grafana_dashboards(id: str, request: Request) -> GrafanaDashboardsOut:
    services = _services(request)
    return await _dashboards(services, await _stored(services, id))


@router.post("/grafana/dashboards", openapi_extra=_schema(GrafanaIn))
async def unsaved_grafana_dashboards(request: Request) -> GrafanaDashboardsOut:
    """The dashboards of a connection as entered; nothing is stored."""
    body = await read_body(request, GrafanaIn)
    cfg = await grafana_config_from_in(body, _registry(request))
    return await _dashboards(_services(request), cfg)
