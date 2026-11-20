"""What a source as entered must follow, and what it becomes: the checks behind every source
form (add, test, suggest a filter, project setup), the default name, the stored shape, and what
an audit record says about it.

A rule that is broken answers 422 with plain words from here (pydantic only checks the shape:
`omnikrux/validation.py` replaces its messages). Secrets come in as `SecretStr` and never reach
an audit detail."""

from collections.abc import Iterable
from dataclasses import replace
from datetime import UTC, datetime
from typing import Literal
from urllib.parse import urlsplit

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, SecretStr

from omnikrux.clusters.registry import ClusterRegistry
from omnikrux.monitoring.sources.store import NewSource
from omnikrux.monitoring.sources.transport import (
    _DNS_LABEL,
    _PORT,
    validate_header,
    validate_path_prefix,
    validate_url,
)
from omnikrux.monitoring.sources.types import (
    MAX_NAME,
    NAME_RULE,
    AuthType,
    ClusterTarget,
    Reach,
    SourceConfig,
    SourceSecrets,
    SourceType,
    clean_name,
)

MAX_HEADERS = 20
LABELS = {"prometheus": "Prometheus", "loki": "Loki"}
CLUSTER_ONLY = (
    "A source reached through its cluster uses the cluster's connection; "
    "it takes no other authentication."
)
URL_NEEDED = "A source reached by its address needs a URL."
CLUSTER_FIELDS = (
    "A source reached through its cluster needs the cluster, namespace, service and port."
)
CLUSTER_NAMES = (
    "The namespace and service are lowercase names like monitoring, "
    "and the port is a number or a port name."
)
CLUSTER_UNKNOWN = "OmniKrux doesn't know that cluster. Pick one of the connected clusters."
TOO_MANY_HEADERS = f"A source takes at most {MAX_HEADERS} custom headers."
HEADER_TWICE = "Each custom header can be listed only once."
HEADER_VALUE = "Enter a value for the {name} header."
AUTH_NEEDS = {
    "basic": "Basic authentication needs a user name and a password.",
    "bearer": "Bearer authentication needs a token.",
    "api_key": "API key authentication needs a header name and a key.",
    "mtls": "Client certificate authentication needs a certificate and its private key.",
}
ONE_SOURCE = "Give a saved source or a new one, but not both."


# --- Shapes ------------------------------------------------------------------------------------


class AuthIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: AuthType = "none"
    username: str | None = None
    password: SecretStr | None = None
    token: SecretStr | None = None
    header_name: str | None = None
    api_key: SecretStr | None = None
    client_cert_pem: str | None = None
    client_key_pem: SecretStr | None = None


class HeaderIn(BaseModel):
    """On PATCH, a `None` value keeps the stored one."""

    model_config = ConfigDict(extra="forbid")

    name: str
    value: SecretStr | None = None


class SourceIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    type: SourceType
    reach: Reach
    url: str | None = None
    cluster_id: str | None = None
    namespace: str | None = None
    service: str | None = None
    port: str | None = None
    scheme: Literal["http", "https"] = "http"
    path_prefix: str = ""
    auth: AuthIn = AuthIn()
    headers: list[HeaderIn] = []
    ca_pem: str | None = None


# --- Rules -------------------------------------------------------------------------------------


def refuse(detail: str) -> HTTPException:
    return HTTPException(status_code=422, detail=detail)


def checked_name(name: str) -> str:
    try:
        return clean_name(name)
    except ValueError:
        raise refuse(NAME_RULE) from None


def checked_url(url: str | None) -> str:
    if not url:
        raise refuse(URL_NEEDED)
    try:
        return validate_url(url)
    except ValueError as exc:
        raise refuse(str(exc)) from None


def checked_path_prefix(path_prefix: str) -> str:
    try:
        return validate_path_prefix(path_prefix)
    except ValueError as exc:
        raise refuse(str(exc)) from None


async def cluster_target(
    registry: ClusterRegistry,
    cluster_id: str | None,
    namespace: str | None,
    service: str | None,
    port: str | None,
    scheme: Literal["http", "https"],
) -> ClusterTarget:
    if not (cluster_id and namespace and service and port):
        raise refuse(CLUSTER_FIELDS)
    if not (_DNS_LABEL.match(namespace) and _DNS_LABEL.match(service) and _PORT.match(port)):
        raise refuse(CLUSTER_NAMES)
    try:
        await registry.get(cluster_id)
    except KeyError:
        raise refuse(CLUSTER_UNKNOWN) from None
    return ClusterTarget(cluster_id, namespace, service, port, scheme)


def _secret(value: SecretStr | None) -> str | None:
    return value.get_secret_value() if value is not None else None


def _check_header(name: str, value: str) -> None:
    try:
        validate_header(name, value)
    except ValueError as exc:
        raise refuse(str(exc)) from None


def check_auth(
    auth_type: str,
    username: str | None,
    header_name: str | None,
    client_cert_pem: str | None,
    secrets: SourceSecrets,
    stored: set[str],
) -> None:
    """Each type has the fields it needs: given now (never empty), or, when not given, kept from
    before (`stored`)."""

    def has(secret: str) -> bool:
        value = getattr(secrets, secret)
        return bool(value) if value is not None else secret in stored

    needed = {
        "none": True,
        "basic": bool(username) and has("password"),
        "bearer": has("token"),
        "api_key": bool(header_name) and has("api_key"),
        "mtls": bool(client_cert_pem) and has("client_key_pem"),
    }
    if not needed[auth_type]:
        raise refuse(AUTH_NEEDS[auth_type])
    if auth_type == "api_key" and header_name:
        _check_header(header_name, secrets.api_key or "")
    if auth_type == "bearer" and secrets.token:
        _check_header("Authorization", secrets.token)


def checked_headers(
    headers: list[HeaderIn], *, kept: Iterable[str] = ()
) -> tuple[tuple[str, ...], dict[str, str]]:
    """The header names in order and the values given; a header without a value is allowed
    only when it is one of `kept` (its stored value stays)."""
    if len(headers) > MAX_HEADERS:
        raise refuse(TOO_MANY_HEADERS)
    kept = set(kept)
    names: list[str] = []
    values: dict[str, str] = {}
    for header in headers:
        if header.name.lower() in {n.lower() for n in names}:
            raise refuse(HEADER_TWICE)
        value = _secret(header.value)
        if value is None and header.name not in kept:
            _check_header(header.name, "")
            raise refuse(HEADER_VALUE.format(name=header.name))
        _check_header(header.name, value or "")
        names.append(header.name)
        if value is not None:
            values[header.name] = value
    return tuple(names), values


def auth_secrets(auth: AuthIn) -> SourceSecrets:
    return SourceSecrets(
        password=_secret(auth.password),
        token=_secret(auth.token),
        api_key=_secret(auth.api_key),
        client_key_pem=_secret(auth.client_key_pem),
    )


def default_name(type: str, where: str) -> str:
    """`Prometheus · prometheus.example`, `Loki · production`."""
    return f"{LABELS.get(type, type)} · {where}"[:MAX_NAME].strip()


async def config_from_in(body: SourceIn, registry: ClusterRegistry) -> SourceConfig:
    """A checked, unsaved config (`id=""`) for a source as the user entered it; HTTPException
    422 with plain words when it breaks a rule. Without a name it gets the default one (not yet
    made unique: `SourceStore.unique_name` does that when it is saved)."""
    target: ClusterTarget | None = None
    url: str | None = None
    if body.reach == "url":
        url = checked_url(body.url)
        where = urlsplit(url).hostname or url
    else:
        if body.auth.type != "none" or body.headers:
            raise refuse(CLUSTER_ONLY)
        target = await cluster_target(
            registry, body.cluster_id, body.namespace, body.service, body.port, body.scheme
        )
        where = (await registry.get(target.cluster_id)).name
    path_prefix = checked_path_prefix(body.path_prefix)
    auth = body.auth
    secrets = auth_secrets(auth)
    check_auth(auth.type, auth.username, auth.header_name, auth.client_cert_pem, secrets, set())
    header_names, header_values = checked_headers(body.headers)
    moment = datetime.now(UTC)
    return SourceConfig(
        id="",
        name=checked_name(body.name) if body.name is not None else default_name(body.type, where),
        type=body.type,
        reach=body.reach,
        url=url,
        cluster=target,
        path_prefix=path_prefix,
        auth_type=auth.type,
        username=auth.username if auth.type == "basic" else None,
        header_name=auth.header_name if auth.type == "api_key" else None,
        client_cert_pem=auth.client_cert_pem if auth.type == "mtls" else None,
        ca_pem=body.ca_pem or None,
        header_names=header_names,
        secrets=replace(secrets, headers=header_values),
        created_by_project_id=None,
        created_at=moment,
        updated_at=moment,
        check=None,
    )


def new_source_of(config: SourceConfig, *, created_by_project_id: str | None = None) -> NewSource:
    """What to store for a config `config_from_in` made."""
    return NewSource(
        name=config.name,
        type=config.type,
        reach=config.reach,
        url=config.url,
        cluster=config.cluster,
        path_prefix=config.path_prefix,
        auth_type=config.auth_type,
        username=config.username,
        header_name=config.header_name,
        client_cert_pem=config.client_cert_pem,
        ca_pem=config.ca_pem,
        header_names=config.header_names,
        secrets=config.secrets,
        created_by_project_id=created_by_project_id,
    )


async def source_details(
    registry: ClusterRegistry,
    *,
    type: str,
    reach: str,
    url: str | None,
    cluster: ClusterTarget | None,
    auth_type: str,
    header_names: Iterable[str],
) -> dict:
    """What an audit record says about a source: settings and names, never a secret."""
    if cluster is not None:
        try:
            where = (await registry.get(cluster.cluster_id)).name
        except KeyError:
            where = cluster.cluster_id
        target = f"{where}/{cluster.namespace}/{cluster.service}:{cluster.port}"
    else:
        target = url or ""
    return {
        "type": type,
        "reach": reach,
        "target": target,
        "auth": auth_type,
        "headers": list(header_names),
    }


async def details_of(registry: ClusterRegistry, config: SourceConfig) -> dict:
    return await source_details(
        registry,
        type=config.type,
        reach=config.reach,
        url=config.url,
        cluster=config.cluster,
        auth_type=config.auth_type,
        header_names=config.header_names,
    )
