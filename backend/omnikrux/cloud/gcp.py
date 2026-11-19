import asyncio
import json
import re
from configparser import ConfigParser
from configparser import Error as ConfigError
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Lock
from typing import Literal
from urllib.parse import quote

import requests
from cryptography.exceptions import UnsupportedAlgorithm
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey
from cryptography.hazmat.primitives.serialization import load_pem_private_key
from google.auth import exceptions as google_errors
from google.auth.transport.requests import Request
from google.oauth2 import credentials, service_account

from omnikrux.cloud import messages
from omnikrux.cloud.adapters import (
    AccountIdentity,
    Choice,
    CliLoginInfo,
    ClusterAccess,
    DiscoveryResult,
)
from omnikrux.cloud.dirs import folder_state
from omnikrux.cloud.endpoints import CloudEndpoints, same_origin
from omnikrux.cloud.http import CLOUD_TIMEOUT_SECONDS, CloudError, CloudHttp, cloud_error
from omnikrux.cloud.types import (
    GCP_PROJECT,
    PROFILE_NAME,
    AccountConfig,
    CloudClusterRef,
    DiscoveredCluster,
    NodePool,
)
from omnikrux.kube.tokens import BearerToken, CachedToken, TokenFetch

GCP_SCOPE = "https://www.googleapis.com/auth/cloud-platform"
_CLOUD = "Google Cloud"
_CLI = "gcloud"
_LOGIN = "gcloud auth application-default login"
_ADC_FILE = "application_default_credentials.json"
_REFRESH = "refresh the login"
_LIST = "list clusters"
_BAD_ADC = (
    "The gcloud application-default credentials couldn't be read. "
    "Run `gcloud auth application-default login` on this machine, then try again."
)
_BAD_REFRESH = "Google Cloud sent an unreadable login reply. Sign in again, then try again."
_BAD_CLUSTERS = "Google Cloud sent an unreadable cluster list. Try again in a minute."
_LOCATION = re.compile(r"[a-z][a-z0-9-]{0,62}")
_BEARER_TOKEN = re.compile(r"[A-Za-z0-9._~+/-]+=*")
_USER_FIELDS = ("client_id", "client_secret", "refresh_token")
_KEY_FIELDS = ("client_email", "private_key")
_LOAD_ERRORS = (
    google_errors.GoogleAuthError,
    ValueError,
    TypeError,
    AttributeError,
    RecursionError,
)


@dataclass(frozen=True)
class _OAuthResponse:
    status: int
    data: bytes = field(repr=False)


def _oauth_success(body: bytes) -> _OAuthResponse:
    # Validate before google-auth can assign a rotated refresh token to the credential.
    try:
        payload = _object(json.loads(body.decode("utf-8")))
        if "error" in payload or not _BEARER_TOKEN.fullmatch(
            _required_string(payload.get("access_token"))
        ):
            raise ValueError
        lifetime = payload.get("expires_in")
        if isinstance(lifetime, str):
            lifetime = int(lifetime)
        if type(lifetime) is not int or lifetime <= 0:
            raise ValueError
        datetime.now(UTC) + timedelta(seconds=lifetime)
        if "refresh_token" in payload:
            # The SDK encodes the rotated token into the next form using UTF-8.
            _required_string(payload["refresh_token"]).encode("utf-8")
        if "id_token" in payload:
            _required_string(payload["id_token"])
        if "scope" in payload and not isinstance(payload["scope"], str):
            raise TypeError
    except (ValueError, TypeError, OverflowError, RecursionError):
        raise CloudError(_BAD_REFRESH) from None
    return _OAuthResponse(200, body)


class _OAuthRequest(Request):
    def __init__(self, session: requests.Session, endpoint: str, *, adc: bool) -> None:
        super().__init__(session)
        self._endpoint = endpoint
        self._adc = adc

    def __call__(self, url, method="GET", body=None, headers=None, **_kwargs):
        if method != "POST" or url != self._endpoint or not same_origin(url, self._endpoint):
            raise CloudError(
                "Google Cloud has an invalid login endpoint. Check the cloud endpoint."
            )
        try:
            # The SDK's default transport can log request and response bodies at DEBUG.
            response = self.session.post(
                url,
                data=body,
                headers=headers,
                timeout=CLOUD_TIMEOUT_SECONDS,
                allow_redirects=False,
            )
        except requests.Timeout:
            raise cloud_error(_CLOUD, _REFRESH, timed_out=True) from None
        except requests.RequestException:
            raise cloud_error(_CLOUD, _REFRESH) from None
        if response.status_code == 200:
            return _oauth_success(response.content)

        reason = None
        if response.status_code in {400, 401}:
            try:
                error = response.json()
            except (ValueError, RecursionError):
                error = None
            if isinstance(error, dict) and error.get("error") in (
                "invalid_grant",
                "invalid_client",
            ):
                reason = error["error"]
        if self._adc and reason == "invalid_grant":
            raise CloudError(messages.expired_login(_CLI, _LOGIN))
        # Handle status here to prevent the SDK from retrying the grant.
        raise cloud_error(_CLOUD, _REFRESH, status=response.status_code, reason=reason)


class _GcpLogin:
    def __init__(self, endpoints: CloudEndpoints, *, adc: bool) -> None:
        self._endpoint = endpoints.url("gcp_oauth")
        self._adc = adc
        self._refresh_lock = Lock()

    def _load(self):
        raise NotImplementedError

    def _refresh(self) -> BearerToken:
        with self._refresh_lock, requests.Session() as session:
            session.trust_env = False
            credential = self._load()
            try:
                credential.refresh(_OAuthRequest(session, self._endpoint, adc=self._adc))
                value = _required_string(credential.token)
                if not isinstance(credential.expiry, datetime):
                    raise TypeError
            except (*_LOAD_ERRORS, OverflowError):
                raise CloudError(_BAD_REFRESH) from None
            expires = credential.expiry
            return BearerToken(
                value, expires.replace(tzinfo=UTC) if expires.tzinfo is None else expires
            )

    async def token(self) -> BearerToken:
        return await asyncio.to_thread(self._refresh)


def _required_string(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError
    return value


def _optional_string(value: object) -> str | None:
    return None if value is None else _required_string(value)


def _service_account_credential(info: dict, endpoint: str) -> service_account.Credentials:
    try:
        if not isinstance(info, dict) or info.get("type") != "service_account":
            raise ValueError
        data = {name: _required_string(info.get(name)) for name in _KEY_FIELDS}
        key = load_pem_private_key(data["private_key"].encode("utf-8"), password=None)
        if not isinstance(key, RSAPrivateKey):
            raise TypeError
        data.update(type="service_account", token_uri=endpoint)
        if isinstance(info.get("private_key_id"), str):
            data["private_key_id"] = info["private_key_id"]
        return service_account.Credentials.from_service_account_info(data, scopes=[GCP_SCOPE])
    except (*_LOAD_ERRORS, UnsupportedAlgorithm):
        raise CloudError(messages.NOT_GCP_SERVICE_ACCOUNT_KEY) from None


class GcpAdcLogin(_GcpLogin):
    def __init__(self, dir: Path, endpoints: CloudEndpoints) -> None:
        super().__init__(endpoints, adc=True)
        self._dir = dir
        self._credential = None
        self._principal: str | None = None

    def default_project(self) -> str | None:
        try:
            root = self._dir.resolve()
            active = (root / "active_config").resolve()
            if not active.is_relative_to(root):
                return None
            name = active.read_text(encoding="utf-8").strip()
            if not PROFILE_NAME.fullmatch(name):
                return None
            path = (root / "configurations" / f"config_{name}").resolve()
            if not path.is_relative_to(root):
                return None
            config = ConfigParser(interpolation=None)
            with path.open(encoding="utf-8") as file:
                config.read_file(file)
            project = config.get("core", "project", fallback="").strip()
        except (OSError, ValueError, ConfigError, RuntimeError):
            return None
        return project if GCP_PROJECT.fullmatch(project) else None

    def account(self) -> str | None:
        self._load()
        return self._principal

    def _read_info(self) -> dict:
        path = self._dir / _ADC_FILE
        try:
            if not path.resolve().is_relative_to(self._dir.resolve()):
                raise ValueError
            info = json.loads(path.read_text(encoding="utf-8-sig"))
            if not isinstance(info, dict):
                raise TypeError
        except (FileNotFoundError, NotADirectoryError):
            config = folder_state(self._dir, ("configurations",))
            if config.state == "unreadable":
                raise CloudError(messages.unreadable_login(config.path)) from None
            if config.state == "found":
                raise CloudError(messages.no_adc()) from None
            raise CloudError(messages.missing_login(_CLI, self._dir, _LOGIN)) from None
        except PermissionError:
            raise CloudError(messages.unreadable_login(path)) from None
        except (OSError, ValueError, TypeError, RuntimeError):
            raise CloudError(_BAD_ADC) from None
        return info

    def _load(self):
        if self._credential is not None:
            return self._credential
        info = self._read_info()
        kind = info.get("type")
        if kind == "service_account":
            credential = _service_account_credential(info, self._endpoint)
            principal = credential.service_account_email
        elif kind == "authorized_user":
            try:
                data = {name: _required_string(info.get(name)) for name in _USER_FIELDS}
                account = info.get("account")
                principal = account if isinstance(account, str) and account.strip() else None
                credential = credentials.Credentials.from_authorized_user_info(
                    data, scopes=[GCP_SCOPE]
                ).with_token_uri(self._endpoint)
            except _LOAD_ERRORS:
                raise CloudError(_BAD_ADC) from None
        else:
            raise CloudError(messages.WORKLOAD)
        self._principal = principal
        self._credential = credential
        return self._credential


class GcpServiceAccountKey(_GcpLogin):
    def __init__(self, info: dict, endpoints: CloudEndpoints) -> None:
        super().__init__(endpoints, adc=False)
        self._credential = _service_account_credential(info, self._endpoint)
        self.client_email = self._credential.service_account_email

    def _load(self):
        return self._credential


def _object(value: object) -> dict:
    if not isinstance(value, dict):
        raise TypeError
    return value


def _array(value: object) -> list:
    if not isinstance(value, list):
        raise TypeError
    return value


def _private(cluster: dict) -> bool:
    control_plane = _object(cluster.get("controlPlaneEndpointsConfig", {}))
    ip_endpoints = _object(control_plane.get("ipEndpointsConfig", {}))
    if "enablePublicEndpoint" in ip_endpoints:
        public = ip_endpoints["enablePublicEndpoint"]
        if not isinstance(public, bool):
            raise TypeError
        return not public
    legacy = _object(cluster.get("privateClusterConfig", {}))
    private = legacy.get("enablePrivateEndpoint", False)
    if not isinstance(private, bool):
        raise TypeError
    return private


def _node_pool(value: object) -> NodePool:
    pool = _object(value)
    return NodePool(
        _required_string(pool.get("name")),
        None,
        _optional_string(_object(pool.get("config", {})).get("machineType")),
        _optional_string(pool.get("version")),
    )


def _discovered(project: str, value: object) -> DiscoveredCluster:
    cluster = _object(value)
    name = _required_string(cluster.get("name"))
    location = _required_string(cluster.get("location"))
    if not _LOCATION.fullmatch(location):
        raise ValueError
    private = _private(cluster)
    count = cluster.get("currentNodeCount")
    if count is not None and (type(count) is not int or count < 0):
        raise ValueError
    labels = _object(cluster.get("resourceLabels", {}))
    if not all(isinstance(value, str) for value in labels.values()):
        raise ValueError
    return DiscoveredCluster(
        resource_id=f"projects/{project}/locations/{location}/clusters/{name}",
        name=name,
        region=location,
        kubernetes_version=_optional_string(cluster.get("currentMasterVersion")),
        node_pools=(
            None  # a missing list is unknown, not empty
            if cluster.get("nodePools") is None
            else tuple(_node_pool(pool) for pool in _array(cluster["nodePools"]))
        ),
        node_count=count,
        tags=labels,
        private=private,
        why_not=messages.PRIVATE if private else None,
        details={
            "endpoint": _optional_string(cluster.get("endpoint")),
            "ca": _optional_string(
                _object(cluster.get("masterAuth", {})).get("clusterCaCertificate")
            ),
        },
    )


class GcpAdapter:
    provider: Literal["gcp"] = "gcp"

    def __init__(self, http: CloudHttp, endpoints: CloudEndpoints, cli_dir: Path) -> None:
        self._http = http
        self._endpoints = endpoints
        self._dir = cli_dir
        self._container = endpoints.url("gcp_container").rstrip("/")
        self._tokens: dict[str, CachedToken] = {}

    async def cli_login(self) -> CliLoginInfo:
        folder = folder_state(self._dir, (_ADC_FILE, "configurations"))
        path = str(self._dir)
        if folder.state == "missing":
            return CliLoginInfo(self.provider, path, "missing", None, [])
        login = GcpAdcLogin(self._dir, self._endpoints)
        try:
            await asyncio.to_thread(login.account)
        except CloudError as exc:
            return CliLoginInfo(self.provider, path, "unreadable", exc.message, [])
        project = login.default_project()
        choices = [Choice(project, project)] if project else []
        return CliLoginInfo(self.provider, path, "found", None, choices)

    @staticmethod
    def _project(account: AccountConfig) -> str:
        if account.source == "workload":
            raise CloudError(messages.WORKLOAD)
        project = account.settings.get("project_id")
        if not isinstance(project, str) or not GCP_PROJECT.fullmatch(project):
            raise CloudError(
                "That isn't a Google Cloud project id. Check the project id, then try again."
            )
        return project

    def _login(self, account: AccountConfig) -> GcpAdcLogin | GcpServiceAccountKey:
        if account.source == "cli":
            return GcpAdcLogin(self._dir, self._endpoints)
        try:
            info = json.loads((account.secret or {}).get("service_account_key", ""))
        except (ValueError, TypeError, RecursionError):
            raise CloudError(messages.NOT_GCP_SERVICE_ACCOUNT_KEY) from None
        return GcpServiceAccountKey(info, self._endpoints)

    def _cached_token(self, account: AccountConfig) -> CachedToken:
        if account.id not in self._tokens:
            login = self._login(account)
            self._tokens[account.id] = CachedToken(login.token)
        return self._tokens[account.id]

    async def _clusters(self, project: str, token: BearerToken) -> DiscoveryResult:
        try:
            response = await self._http.json(
                "GET",
                f"{self._container}/v1/projects/{quote(project, safe='')}/locations/-/clusters",
                cloud=_CLOUD,
                action=_LIST,
                id_label="project id",
                headers={"Authorization": f"Bearer {token.value}"},
            )
        except CloudError as exc:
            if exc.status == 403 and exc.code == "SERVICE_DISABLED":
                raise CloudError(messages.gke_api_disabled(project), status=403) from None
            raise
        try:
            clusters = [
                _discovered(project, cluster) for cluster in _array(response.get("clusters", []))
            ]
            zones = _array(response.get("missingZones", []))
            if not all(isinstance(zone, str) and _LOCATION.fullmatch(zone) for zone in zones):
                raise ValueError
        except (ValueError, TypeError):
            raise CloudError(_BAD_CLUSTERS) from None
        return DiscoveryResult(
            clusters,
            [
                messages.region_problem(zone, "Google Cloud didn't answer for this zone.")
                for zone in zones
            ],
        )

    async def verify(self, account: AccountConfig) -> AccountIdentity:
        project = self._project(account)
        login = self._login(account)
        await self._clusters(project, await login.token())
        principal = login.account() if isinstance(login, GcpAdcLogin) else login.client_email
        return AccountIdentity(project, project, principal or "")

    async def discover(self, account: AccountConfig) -> DiscoveryResult:
        project = self._project(account)
        try:
            async with asyncio.timeout(60):
                return await self._clusters(project, await self._cached_token(account)())
        except TimeoutError:
            raise cloud_error(_CLOUD, _LIST, timed_out=True) from None

    async def access(self, account: AccountConfig, found: DiscoveredCluster) -> ClusterAccess:
        self._project(account)
        if found.private:
            raise CloudError(messages.PRIVATE)
        endpoint = found.details.get("endpoint")
        if not isinstance(endpoint, str) or not endpoint:
            raise CloudError(
                "Google Cloud didn't provide a cluster endpoint. Check the cluster, then try again."
            )
        server = endpoint if "://" in endpoint else f"https://{endpoint}"
        if not same_origin(server, server):
            raise CloudError(
                "Google Cloud sent an invalid cluster endpoint. Check the cluster, then try again."
            )
        return ClusterAccess(server, found.details.get("ca"))

    def token_fetch(self, account: AccountConfig, ref: CloudClusterRef) -> TokenFetch:
        self._project(account)
        return self._cached_token(account)

    def forget(self, account_id: str) -> None:
        self._tokens.pop(account_id, None)
