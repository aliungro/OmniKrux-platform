"""Reading a Grafana: its health, its dashboards, one dashboard with its data sources and alert
rules. Every request goes through M1's transports (by address with the connection's sign-in, or
through a cluster's service proxy without one), which never follow a redirect, keep to a timeout
and cap an answer at 32 MB.

Failures become a `GrafanaError` in plain words, chosen by the failure's type and status: never
an aiohttp error's text and never a response body (Grafana may echo the `Authorization` header
back). The token or password lives only in the `GrafanaConfig` and the transport's request."""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from urllib.parse import quote

from omnikrux.monitoring.sources.connector import TOOL_ERROR
from omnikrux.monitoring.sources.transport import (
    SourceUnreachable,
    TransportFactory,
    TransportResponse,
)
from omnikrux.monitoring.sources.types import SourceConfig, SourceSecrets
from omnikrux.monitoring.transfer.grafana.datasources import GrafanaContext, GrafanaDatasource
from omnikrux.monitoring.transfer.grafana_store import GrafanaConfig

HEALTH_SECONDS = 10.0
READ_SECONDS = 20.0
SEARCH_LIMIT = 5000

SIGN_IN_CLUSTER = (
    "{name} needs a sign-in, and a Grafana reached through its cluster can't take one. "
    "Reach it by its address instead, with a service account token."
)
SIGN_IN_URL = (
    "{name} rejected the sign-in (HTTP {status}). Check the token, or the user name and password."
)
NOT_GRAFANA = "{name} answered, but not like Grafana. Check the address."
NO_DASHBOARD = "{name} has no dashboard with the id {uid} any more."
RULES_FORBIDDEN = (
    "Couldn't read {name}'s alert rules (HTTP {status}), so no Grafana alert was copied. "
    "A sign-in that can read alert rules fixes this."
)
# Not in the plan's list: a dashboard Grafana's classic API won't send (preflight F20), and alert
# rules that couldn't be read for any other reason.
DASHBOARD_REFUSED = (
    "{name} couldn't send the dashboard {uid} (HTTP {status}). "
    "Export it as JSON in Grafana and import the file."
)
RULES_FAILED = (
    "Couldn't read {name}'s alert rules, so no Grafana alert was copied. Try again later."
)
SECRETS_UNREADABLE = (
    "OmniKrux can't read {name}'s saved sign-in: its encryption key changed. "
    "Enter the token or password again."
)

# A Grafana dashboard uid as it can go into a path: no "/", no "." or ".." segment.
_UID = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._~-]{0,99}$")


class GrafanaError(Exception):
    """A Grafana that couldn't be read, in words that are safe to show, log and store."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message

    def __repr__(self) -> str:
        return f"GrafanaError({self.status!r}, {self.message!r})"


@dataclass(frozen=True)
class GrafanaHealth:
    ok: bool
    version: str | None
    message: str | None


@dataclass(frozen=True)
class GrafanaDashboardItem:
    uid: str
    title: str
    folder: str | None
    tags: list[str]


@dataclass(frozen=True)
class GrafanaSearch:
    items: list[GrafanaDashboardItem]
    truncated: bool


@dataclass(frozen=True)
class GrafanaDashboardDoc:
    raw: dict
    version: int | None
    folder: str | None


def transport_config(cfg: GrafanaConfig) -> SourceConfig:
    """The connection as M1's transports take it. The type only fills the dataclass (no transport
    reads it); a saved connection's SSL context is kept under `grafana:{id}`, apart from the
    sources', and an unsaved one (id "") gets a fresh one each time."""
    return SourceConfig(
        id=f"grafana:{cfg.id}" if cfg.id else "",
        name=cfg.name,
        type="prometheus",
        reach=cfg.reach,
        url=cfg.url,
        cluster=cfg.cluster,
        path_prefix=cfg.path_prefix,
        auth_type=cfg.auth_type,
        username=cfg.username if cfg.auth_type == "basic" else None,
        header_name=None,
        client_cert_pem=None,
        ca_pem=None,
        header_names=(),
        secrets=SourceSecrets(
            password=cfg.secrets.password if cfg.auth_type == "basic" else None,
            token=cfg.secrets.token if cfg.auth_type == "bearer" else None,
        ),
        created_by_project_id=None,
        created_at=cfg.created_at,
        updated_at=cfg.updated_at,
        check=None,
    )


def _json(body: bytes) -> object:
    try:
        return json.loads(body)
    except (ValueError, RecursionError):
        return None


def _text(value: object) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def _int(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _sign_in(cfg: GrafanaConfig, status: int | None) -> GrafanaError:
    if cfg.reach == "cluster":
        return GrafanaError(502, SIGN_IN_CLUSTER.format(name=cfg.name))
    return GrafanaError(502, SIGN_IN_URL.format(name=cfg.name, status=status or 401))


def _refused(exc: SourceUnreachable) -> bool:
    """Grafana itself refused the sign-in (not the cluster's API server, not the network)."""
    return exc.code == "unauthorized" and exc.status is not None


class GrafanaClient:
    def __init__(self, transports: TransportFactory) -> None:
        self._transports = transports

    async def _get(
        self,
        cfg: GrafanaConfig,
        path: str,
        params: list[tuple[str, str]] | None = None,
        *,
        timeout: float = READ_SECONDS,
    ) -> TransportResponse:
        """The answer, whatever its status. SourceUnreachable passes through for the caller to
        word (a refused sign-in reads differently per call); GrafanaError when the saved secret
        can't be read."""
        if cfg.secrets_unreadable:
            raise GrafanaError(502, SECRETS_UNREADABLE.format(name=cfg.name))
        transport = self._transports.for_source(transport_config(cfg))
        return await transport.request("GET", path, params=params or [], timeout=timeout)

    async def _read(
        self, cfg: GrafanaConfig, path: str, params: list[tuple[str, str]] | None = None
    ) -> TransportResponse:
        """`_get` for the reads a sign-in decides: a refusal is the sign-in copy, any other
        failure M1's words."""
        try:
            return await self._get(cfg, path, params)
        except SourceUnreachable as exc:
            if _refused(exc):
                raise _sign_in(cfg, exc.status) from None
            raise GrafanaError(502, exc.message) from None

    async def health(self, cfg: GrafanaConfig) -> GrafanaHealth:
        """Whether it answers like Grafana, and its version. Never raises."""
        try:
            got = await self._get(cfg, "/api/health", timeout=HEALTH_SECONDS)
        except GrafanaError as exc:
            return GrafanaHealth(False, None, exc.message)
        except SourceUnreachable as exc:
            message = _sign_in(cfg, exc.status).message if _refused(exc) else exc.message
            return GrafanaHealth(False, None, message)
        data = _json(got.body)
        if got.status == 404 or (
            got.status == 200 and not (isinstance(data, dict) and "database" in data)
        ):
            return GrafanaHealth(False, None, NOT_GRAFANA.format(name=cfg.name))
        if got.status != 200:
            return GrafanaHealth(False, None, TOOL_ERROR.format(name=cfg.name, status=got.status))
        version = data.get("version") if isinstance(data, dict) else None
        return GrafanaHealth(True, _text(version), None)

    async def search(self, cfg: GrafanaConfig) -> GrafanaSearch:
        """Its dashboards (not folders), by folder (the root first) then title."""
        params = [("type", "dash-db"), ("limit", str(SEARCH_LIMIT)), ("page", "1")]
        got = await self._read(cfg, "/api/search", params)
        if got.status == 404:
            raise GrafanaError(502, NOT_GRAFANA.format(name=cfg.name))
        if got.status != 200:
            raise GrafanaError(502, TOOL_ERROR.format(name=cfg.name, status=got.status))
        data = _json(got.body)
        if not isinstance(data, list):
            raise GrafanaError(502, NOT_GRAFANA.format(name=cfg.name))
        items: list[GrafanaDashboardItem] = []
        for hit in data:
            if not isinstance(hit, dict) or hit.get("type", "dash-db") != "dash-db":
                continue
            uid, title = _text(hit.get("uid")), hit.get("title")
            if uid is None or not isinstance(title, str):
                continue
            tags = hit.get("tags")
            items.append(
                GrafanaDashboardItem(
                    uid=uid,
                    title=title,
                    folder=_text(hit.get("folderTitle")),
                    tags=[t for t in tags if isinstance(t, str)] if isinstance(tags, list) else [],
                )
            )
        items.sort(
            key=lambda i: (
                i.folder is not None,
                (i.folder or "").casefold(),
                i.title.casefold(),
                i.uid,
            )
        )
        return GrafanaSearch(items=items, truncated=len(data) >= SEARCH_LIMIT)

    async def dashboard(self, cfg: GrafanaConfig, uid: str) -> GrafanaDashboardDoc:
        """The dashboard's JSON, its version and folder. 404 when it is gone; a dashboard the
        classic API won't send is that dashboard's problem in words."""
        if not _UID.match(uid) or ".." in uid:
            raise GrafanaError(404, NO_DASHBOARD.format(name=cfg.name, uid=uid))
        got = await self._read(cfg, f"/api/dashboards/uid/{quote(uid, safe='')}")
        if got.status == 404:
            raise GrafanaError(404, NO_DASHBOARD.format(name=cfg.name, uid=uid))
        if got.status != 200:
            raise GrafanaError(
                502, DASHBOARD_REFUSED.format(name=cfg.name, uid=uid, status=got.status)
            )
        data = _json(got.body)
        if not isinstance(data, dict) or not isinstance(data.get("dashboard"), dict):
            raise GrafanaError(502, NOT_GRAFANA.format(name=cfg.name))
        raw: dict = data["dashboard"]
        meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
        version = _int(raw.get("version"))
        if version is None:
            version = _int(meta.get("version"))
        folder = _text(meta.get("folderTitle"))
        if folder == "General" and not _text(meta.get("folderUid")):
            folder = None  # older Grafanas name the root "General"
        return GrafanaDashboardDoc(raw=raw, version=version, folder=folder)

    async def datasources(self, cfg: GrafanaConfig) -> tuple[GrafanaDatasource, ...] | None:
        """Its data sources; None when the sign-in may not list them."""
        try:
            got = await self._get(cfg, "/api/datasources")
        except SourceUnreachable as exc:
            if _refused(exc):
                return None
            raise GrafanaError(502, exc.message) from None
        if got.status in (401, 403, 404):
            return None
        if got.status != 200:
            raise GrafanaError(502, TOOL_ERROR.format(name=cfg.name, status=got.status))
        data = _json(got.body)
        if not isinstance(data, list):
            raise GrafanaError(502, NOT_GRAFANA.format(name=cfg.name))
        found: list[GrafanaDatasource] = []
        for ds in data:
            if not isinstance(ds, dict) or _text(ds.get("uid")) is None:
                continue
            found.append(
                GrafanaDatasource(
                    uid=ds["uid"],
                    name=ds.get("name") if isinstance(ds.get("name"), str) else ds["uid"],
                    type=ds.get("type") if isinstance(ds.get("type"), str) else "",
                    url=_text(ds.get("url")),
                    is_default=ds.get("isDefault") is True,
                )
            )
        return tuple(found)

    async def alert_rules(
        self, cfg: GrafanaConfig, uid: str
    ) -> tuple[tuple[dict, ...] | None, str | None]:
        """The Grafana-managed alert rules of one dashboard, flattened out of their folders and
        groups; `(None, note)` when they couldn't be read, `((), None)` when the Grafana has no
        ruler."""
        params = [("dashboard_uid", uid)]
        try:
            got = await self._get(cfg, "/api/ruler/grafana/api/v1/rules", params)
        except SourceUnreachable as exc:
            if _refused(exc):
                return None, RULES_FORBIDDEN.format(name=cfg.name, status=exc.status)
            raise GrafanaError(502, exc.message) from None
        if got.status == 404:
            return (), None
        if got.status in (401, 403):
            return None, RULES_FORBIDDEN.format(name=cfg.name, status=got.status)
        data = _json(got.body)
        if got.status != 200 or not isinstance(data, dict):
            return None, RULES_FAILED.format(name=cfg.name)
        rules: list[dict] = []
        for groups in data.values():
            for group in groups if isinstance(groups, list) else ():
                found = group.get("rules") if isinstance(group, dict) else None
                if isinstance(found, list):
                    rules.extend(r for r in found if isinstance(r, dict))
        return tuple(rules), None

    async def context(
        self, cfg: GrafanaConfig, uid: str
    ) -> tuple[GrafanaDashboardDoc, GrafanaContext]:
        """One dashboard, with what its conversion reads from the Grafana around it."""
        doc = await self.dashboard(cfg, uid)
        datasources, (rules, note) = await asyncio.gather(
            self.datasources(cfg), self.alert_rules(cfg, uid)
        )
        return doc, GrafanaContext(
            datasources=datasources or (), alert_rules=rules, alert_rules_note=note
        )
