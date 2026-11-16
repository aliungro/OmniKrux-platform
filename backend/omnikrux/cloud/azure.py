import asyncio
import base64
import json
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Literal
from urllib.parse import quote, urlencode

import yaml

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
from omnikrux.cloud.http import CloudError, CloudHttp
from omnikrux.cloud.types import GUID, AccountConfig, CloudClusterRef, DiscoveredCluster, NodePool
from omnikrux.kube.tokens import BearerToken, CachedToken, TokenFetch, utcnow

AZURE_CLI_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46"
AKS_SERVER_APP_ID = "6dae42f8-4368-4678-94ff-3960e28e3630"
ARM_SCOPE = "https://management.azure.com/.default"
ARM_API = "2024-09-01"
SUBSCRIPTION_API = "2022-12-01"

_CLI = "Azure CLI"
_LOGIN = "az login"
_PROFILE = "azureProfile.json"
_CACHE = "msal_token_cache.json"
_WINDOWS_CACHE = "msal_token_cache.bin"
_MSAL_ENVIRONMENT = "login.microsoftonline.com"
_MAX_REFRESH_ATTEMPTS = 4
_BAD_LOGIN = "Omnikrux couldn't read the Azure CLI login. Run `az login`, then try again."
_BAD_CLUSTER = "Azure sent unreadable cluster details. Check the subscription, then try again."
_BAD_TOKEN = "Azure sent an unreadable token. Check the login, then try again."


class AzureCliUnavailable(CloudError):
    """The mounted Azure CLI login cannot be used for a grant."""


class AzureCliMissing(AzureCliUnavailable):
    """There is no Azure CLI login at all (as opposed to one that is expired or unreadable)."""


@dataclass(frozen=True)
class AzureSubscription:
    id: str
    name: str
    tenant_id: str
    user: str
    is_default: bool


def _guid(value: object, label: str) -> str:
    if not isinstance(value, str) or not GUID.fullmatch(value):
        raise CloudError(f"The Azure {label} must be a GUID. Check the Azure account settings.")
    return value


def _as_dict(value: object) -> dict:
    if not isinstance(value, dict):
        raise TypeError
    return value


def _required_string(value: object) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError
    return value


def _refresh_modified(item: dict) -> int:
    try:
        return int(item.get("last_modification_time", 0))
    except (TypeError, ValueError, OverflowError):
        return 0


def _read_login(path: Path) -> dict:
    try:
        return _as_dict(json.loads(path.read_text(encoding="utf-8-sig")))
    except (FileNotFoundError, NotADirectoryError):
        raise AzureCliMissing(messages.missing_login(_CLI, path.parent, _LOGIN)) from None
    except OSError:
        raise AzureCliUnavailable(messages.unreadable_login(path.parent)) from None
    except (ValueError, TypeError, RecursionError):
        raise AzureCliUnavailable(_BAD_LOGIN) from None


async def _exchange(http: CloudHttp, endpoints: CloudEndpoints, tenant_id: str, form: dict) -> dict:
    tenant_id = _guid(tenant_id, "tenant id")
    login = endpoints.url("azure_login")
    url = f"{login.rstrip('/')}/{tenant_id}/oauth2/v2.0/token"
    if not same_origin(url, login):
        raise CloudError("The Azure login endpoint is invalid. Check the cloud endpoint.")
    return await http.json("POST", url, cloud="Azure", action="sign in", data=form)


def _bearer(payload: dict) -> BearerToken:
    try:
        token = _required_string(payload.get("access_token"))
        if not token.isascii() or any(not char.isprintable() or char.isspace() for char in token):
            raise ValueError
        lifetime = int(payload["expires_in"])
        if lifetime <= 0:
            raise ValueError
        return BearerToken(token, utcnow() + timedelta(seconds=lifetime))
    except (KeyError, TypeError, ValueError, OverflowError):
        raise CloudError(_BAD_TOKEN) from None


class AzureCliLogin:
    def __init__(
        self,
        dir: Path,
        http: CloudHttp,
        endpoints: CloudEndpoints,
        *,
        subscription: AzureSubscription | None = None,
    ) -> None:
        self.dir = dir
        self._http = http
        self._endpoints = endpoints
        self._subscription = subscription
        self._refresh_lock = asyncio.Lock()
        self._rotated: dict[tuple[str, str], str] = {}

    def subscriptions(self) -> list[AzureSubscription]:
        profile = _read_login(self.dir / _PROFILE)
        try:
            rows = profile["subscriptions"]
            if not isinstance(rows, list):
                raise TypeError
            return [
                AzureSubscription(
                    id=_guid(row["id"], "subscription id"),
                    name=_required_string(row["name"]),
                    tenant_id=_guid(row["tenantId"], "tenant id"),
                    user=_required_string(row["user"]["name"]),
                    is_default=row.get("isDefault") is True,
                )
                for row in rows
            ]
        except (KeyError, TypeError, ValueError, CloudError):
            raise AzureCliUnavailable(_BAD_LOGIN) from None

    def require_cache(self) -> None:
        cache = folder_state(self.dir, (_CACHE,))
        if cache.state == "found":
            return
        if cache.state == "unreadable":
            raise AzureCliUnavailable(messages.unreadable_login(self.dir))
        encrypted = folder_state(self.dir, (_WINDOWS_CACHE,))
        if encrypted.state != "missing":
            raise AzureCliUnavailable(messages.windows_azure_cache())
        raise AzureCliUnavailable(messages.expired_login(_CLI, _LOGIN))

    def _user(self, tenant_id: str) -> str:
        if self._subscription is not None:
            return self._subscription.user
        subscriptions = [
            row for row in self.subscriptions() if row.tenant_id.casefold() == tenant_id.casefold()
        ]
        if not subscriptions:
            raise AzureCliUnavailable(messages.expired_login(_CLI, _LOGIN))
        return next((row.user for row in subscriptions if row.is_default), subscriptions[0].user)

    def _refresh_tokens(self, tenant_id: str, user: str) -> list[str]:
        self.require_cache()
        cache = _read_login(self.dir / _CACHE)
        try:
            accounts = _as_dict(cache.get("Account", {}))
            tokens = _as_dict(cache.get("RefreshToken", {}))
            user_accounts = [
                item
                for item in map(_as_dict, accounts.values())
                if item.get("environment") == _MSAL_ENVIRONMENT
                and _required_string(item.get("username")).casefold() == user
            ]
            matching_tenant = [
                item for item in user_accounts if item.get("realm", "").lower() == tenant_id
            ]
            home_ids = {
                _required_string(item.get("home_account_id"))
                for item in matching_tenant or user_accounts
            }
            if len(home_ids) != 1:
                return []
            home_id = next(iter(home_ids))
            matching = [
                item
                for item in map(_as_dict, tokens.values())
                if item.get("home_account_id") == home_id
                and item.get("environment") == _MSAL_ENVIRONMENT
                and item.get("client_id") == AZURE_CLI_CLIENT_ID
            ]
            matching.sort(key=_refresh_modified, reverse=True)
            return [_required_string(item.get("secret")) for item in matching]
        except (AttributeError, TypeError, ValueError):
            raise AzureCliUnavailable(_BAD_LOGIN) from None

    def _refresh_candidates(self, key: tuple[str, str]) -> Iterator[str]:
        if rotated := self._rotated.get(key):
            yield rotated
        yield from self._refresh_tokens(*key)

    async def token(self, tenant_id: str, scope: str) -> BearerToken:
        tenant_id = _guid(tenant_id, "tenant id").casefold()
        async with self._refresh_lock:
            user = self._user(tenant_id).casefold()
            key = (tenant_id, user)
            attempted: set[str] = set()
            for refresh in self._refresh_candidates(key):
                if refresh in attempted:
                    continue
                attempted.add(refresh)
                try:
                    payload = await _exchange(
                        self._http,
                        self._endpoints,
                        tenant_id,
                        {
                            "client_id": AZURE_CLI_CLIENT_ID,
                            "grant_type": "refresh_token",
                            "refresh_token": refresh,
                            "scope": f"{scope} offline_access openid profile",
                        },
                    )
                except CloudError as exc:
                    if exc.code != "invalid_grant":
                        raise
                    if self._rotated.get(key) == refresh:
                        del self._rotated[key]
                    if len(attempted) == _MAX_REFRESH_ATTEMPTS:
                        break
                    continue
                token = _bearer(payload)
                rotated = payload.get("refresh_token")
                if isinstance(rotated, str) and rotated:
                    try:
                        rotated.encode("utf-8")
                    except UnicodeError:
                        raise CloudError(_BAD_TOKEN) from None
                    self._rotated[key] = rotated
                return token
            raise AzureCliUnavailable(messages.expired_login(_CLI, _LOGIN))


class AzureServicePrincipal:
    def __init__(
        self,
        tenant_id: str,
        client_id: str,
        client_secret: str,
        http: CloudHttp,
        endpoints: CloudEndpoints,
    ) -> None:
        self.tenant_id = _guid(tenant_id, "tenant id")
        self.client_id = _guid(client_id, "client id")
        if not isinstance(client_secret, str) or not client_secret:
            raise CloudError(
                "The Azure client secret is missing. Enter the service principal secret."
            )
        self._client_secret = client_secret
        self._http = http
        self._endpoints = endpoints

    async def token(self, tenant_id: str, scope: str) -> BearerToken:
        return _bearer(
            await _exchange(
                self._http,
                self._endpoints,
                tenant_id,
                {
                    "client_id": self.client_id,
                    "client_secret": self._client_secret,
                    "grant_type": "client_credentials",
                    "scope": scope,
                },
            )
        )


@dataclass(frozen=True)
class _AccountLogin:
    credential: AzureCliLogin | AzureServicePrincipal
    principal: str
    tenant_id: str

    async def arm_token(self) -> BearerToken:
        return await self.credential.token(self.tenant_id, ARM_SCOPE)


def _resource_parts(resource_id: str, subscription_id: str) -> list[str]:
    parts = resource_id.split("/")
    if (
        len(parts) != 9
        or parts[0] != ""
        or parts[1].lower() != "subscriptions"
        or parts[2].lower() != subscription_id.lower()
        or parts[3].lower() != "resourcegroups"
        or parts[5].lower() != "providers"
        or parts[6].lower() != "microsoft.containerservice"
        or parts[7].lower() != "managedclusters"
        or any(part in {"", ".", ".."} for part in (parts[4], parts[8]))
    ):
        raise ValueError
    return parts


def _node_pool(row: object) -> NodePool:
    pool = _as_dict(row)
    count = pool.get("count")
    if count is not None and (type(count) is not int or count < 0):
        raise ValueError
    return NodePool(
        name=_required_string(pool.get("name")),
        count=count,
        machine_type=pool.get("vmSize"),
        version=pool.get("currentOrchestratorVersion") or pool.get("orchestratorVersion"),
    )


def _discovered(row: object, subscription: str, tenant_id: str) -> DiscoveredCluster:
    try:
        item = _as_dict(row)
        resource_id = _required_string(item.get("id"))
        resource_group = _resource_parts(resource_id, subscription)[4]
        properties = _as_dict(item.get("properties"))
        profiles = properties.get("agentPoolProfiles")
        # Every AKS cluster has a system pool: a missing list is unknown, not empty.
        pools = None if profiles is None else tuple(map(_node_pool, profiles))
        network = _as_dict(properties.get("apiServerAccessProfile") or {})
        private = network.get("enablePrivateCluster") is True
        aad = properties.get("aadProfile")
        entra = _as_dict(aad) if aad is not None else {}
        tags = _as_dict(item.get("tags") or {})
        if not all(isinstance(key, str) and isinstance(value, str) for key, value in tags.items()):
            raise ValueError
        counts = [None] if pools is None else [pool.count for pool in pools]
        return DiscoveredCluster(
            resource_id=resource_id.lower(),
            name=_required_string(item.get("name")),
            region=_required_string(item.get("location")),
            kubernetes_version=properties.get("currentKubernetesVersion")
            or properties.get("kubernetesVersion"),
            node_pools=pools,
            node_count=sum(count for count in counts if count is not None)
            if None not in counts
            else None,
            tags=tags,
            private=private,
            why_not=messages.PRIVATE
            if private
            else messages.AKS_LOCAL_ACCOUNTS
            if aad is None
            else None,
            details={
                "resource_group": resource_group,
                "server_app_id": _guid(
                    entra.get("serverAppID") or AKS_SERVER_APP_ID, "server app id"
                ),
                "tenant_id": _guid(entra.get("tenantID") or tenant_id, "tenant id"),
            },
        )
    except (TypeError, ValueError, CloudError):
        raise CloudError(_BAD_CLUSTER) from None


class AzureAdapter:
    provider: Literal["azure"] = "azure"

    def __init__(self, http: CloudHttp, endpoints: CloudEndpoints, cli_dir: Path) -> None:
        self._http = http
        self._endpoints = endpoints
        self._cli_dir = cli_dir
        self._arm = endpoints.url("azure_arm").rstrip("/")
        self._accounts: dict[str, _AccountLogin] = {}
        self._arm_tokens: dict[str, CachedToken] = {}

    async def cli_login(self) -> CliLoginInfo:
        folder = folder_state(self._cli_dir, (_PROFILE,))
        path = str(folder.path)
        if folder.state == "missing":
            return CliLoginInfo(self.provider, path, "missing", None, [])
        if folder.state == "unreadable":
            return CliLoginInfo(
                self.provider, path, "unreadable", messages.unreadable_login(folder.path), []
            )
        login = AzureCliLogin(self._cli_dir, self._http, self._endpoints)
        try:
            subscriptions = login.subscriptions()
            login.require_cache()
        except CloudError as exc:
            return CliLoginInfo(self.provider, path, "unreadable", exc.message, [])
        return CliLoginInfo(
            self.provider,
            path,
            "found",
            None,
            [Choice(item.id, f"{item.name} ({item.id})") for item in subscriptions],
        )

    def _login(self, account: AccountConfig, subscription_id: str) -> _AccountLogin:
        if account.source == "cli":
            profile = AzureCliLogin(self._cli_dir, self._http, self._endpoints)
            subscription = next(
                (
                    item
                    for item in profile.subscriptions()
                    if item.id.lower() == subscription_id.lower()
                ),
                None,
            )
            if subscription is None:
                raise CloudError(
                    "The Azure CLI login doesn't contain this subscription. "
                    "Choose a subscription from the current Azure CLI login."
                )
            return _AccountLogin(
                AzureCliLogin(
                    self._cli_dir, self._http, self._endpoints, subscription=subscription
                ),
                subscription.user,
                subscription.tenant_id,
            )
        principal = AzureServicePrincipal(
            account.settings.get("tenant_id"),
            account.settings.get("client_id"),
            (account.secret or {}).get("client_secret"),
            self._http,
            self._endpoints,
        )
        return _AccountLogin(principal, principal.client_id, principal.tenant_id)

    def _subscription(self, account: AccountConfig) -> str:
        if account.source == "workload":
            raise CloudError(messages.WORKLOAD)
        return _guid(account.settings.get("subscription_id"), "subscription id").lower()

    def _cached_login(self, account: AccountConfig, subscription_id: str) -> _AccountLogin:
        if account.id not in self._accounts:
            login = self._login(account, subscription_id)
            self._accounts[account.id] = login
            self._arm_tokens[account.id] = CachedToken(login.arm_token)
        return self._accounts[account.id]

    async def verify(self, account: AccountConfig) -> AccountIdentity:
        subscription = self._subscription(account)
        login = self._login(account, subscription)
        token = await login.arm_token()
        response = await self._http.json(
            "GET",
            f"{self._arm}/subscriptions/{subscription}?api-version={SUBSCRIPTION_API}",
            cloud="Azure",
            action="verify the subscription",
            id_label="subscription id",
            headers={"Authorization": f"Bearer {token.value}"},
        )
        try:
            name = _required_string(response.get("displayName"))
        except ValueError:
            raise CloudError(
                "Azure sent unreadable subscription details. Check the subscription, then try again."
            ) from None
        return AccountIdentity(subscription, name, login.principal)

    async def discover(self, account: AccountConfig) -> DiscoveryResult:
        subscription = self._subscription(account)
        login = self._cached_login(account, subscription)
        token = await self._arm_tokens[account.id]()
        headers = {"Authorization": f"Bearer {token.value}"}
        path = f"/subscriptions/{subscription}/providers/Microsoft.ContainerService/managedClusters"
        url = f"{self._arm}{path}?api-version={ARM_API}"
        clusters: list[DiscoveredCluster] = []
        visited: set[str] = set()
        while True:
            if not isinstance(url, str) or not same_origin(url, self._arm) or url in visited:
                raise CloudError(
                    "Azure returned an invalid link to the next page of clusters. Try again in a minute."
                )
            visited.add(url)
            response = await self._http.json(
                "GET",
                url,
                cloud="Azure",
                action="list clusters",
                headers=headers,
                id_label="subscription id",
            )
            rows = response.get("value")
            if not isinstance(rows, list):
                raise CloudError(_BAD_CLUSTER)
            clusters.extend(_discovered(row, subscription, login.tenant_id) for row in rows)
            url = response.get("nextLink")
            if url is None or url == "":
                return DiscoveryResult(clusters, [])

    async def access(self, account: AccountConfig, found: DiscoveredCluster) -> ClusterAccess:
        subscription = self._subscription(account)
        if not found.addable:
            raise CloudError(messages.PRIVATE if found.private else messages.AKS_LOCAL_ACCOUNTS)
        try:
            path = "/".join(
                quote(part, safe="") for part in _resource_parts(found.resource_id, subscription)
            )
        except (ValueError, AttributeError):
            raise CloudError(_BAD_CLUSTER) from None
        self._cached_login(account, subscription)
        token = await self._arm_tokens[account.id]()
        query = urlencode({"api-version": ARM_API, "format": "exec"})
        response = await self._http.json(
            "POST",
            f"{self._arm}{path}/listClusterUserCredential?{query}",
            cloud="Azure",
            action="read cluster access",
            id_label="cluster id",
            headers={"Authorization": f"Bearer {token.value}"},
        )
        try:
            config = yaml.safe_load(
                base64.b64decode(response["kubeconfigs"][0]["value"], validate=True)
            )
            cluster = _as_dict(config["clusters"][0]["cluster"])
            server = _required_string(cluster.get("server"))
            if not same_origin(server, server):
                raise ValueError
            ca_data = cluster.get("certificate-authority-data")
            if ca_data is not None and not isinstance(ca_data, str):
                raise ValueError
        except (ValueError, KeyError, IndexError, TypeError, yaml.YAMLError, RecursionError):
            raise CloudError(
                "Azure sent unreadable cluster access details. Check the cluster, then try again."
            ) from None
        return ClusterAccess(server, ca_data)

    def token_fetch(self, account: AccountConfig, ref: CloudClusterRef) -> TokenFetch:
        async def fetch() -> BearerToken:
            subscription = self._subscription(account)
            tenant = _guid(ref.details.get("tenant_id"), "tenant id")
            app = _guid(ref.details.get("server_app_id"), "server app id")
            login = self._cached_login(account, subscription)
            return await login.credential.token(tenant, f"{app}/.default")

        return fetch

    def forget(self, account_id: str) -> None:
        self._arm_tokens.pop(account_id, None)
        self._accounts.pop(account_id, None)
