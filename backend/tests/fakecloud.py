"""Loopback cloud APIs with explicit read-only routes and expiring fake credentials."""

import base64
import json
import re
import time
from collections.abc import Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

import pytest
import yaml
from aiohttp import web
from multidict import CIMultiDict

from omnikrux.cloud.azure import AKS_SERVER_APP_ID, ARM_SCOPE, AZURE_CLI_CLIENT_ID
from omnikrux.cloud.endpoints import CloudEndpoints
from omnikrux.cloud.types import CloudProvider

_GUID = r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
_AZURE_TOKEN = re.compile(rf"/(?P<tenant>{_GUID})/oauth2/v2\.0/token", re.IGNORECASE)
_AZURE_SUBSCRIPTION = re.compile(rf"/subscriptions/(?P<sub>{_GUID})", re.IGNORECASE)
_AZURE_CLUSTERS = re.compile(
    rf"/subscriptions/(?P<sub>{_GUID})/providers/Microsoft\.ContainerService/managedClusters",
    re.IGNORECASE,
)
_AZURE_KUBECONFIG = re.compile(
    rf"(?P<id>/subscriptions/(?P<sub>{_GUID})/resourceGroups/[^/]+"
    r"/providers/Microsoft\.ContainerService/managedClusters/[^/]+)/listClusterUserCredential",
    re.IGNORECASE,
)
_AKS_SCOPE = re.compile(rf"{_GUID}/\.default", re.IGNORECASE)
_READ_ONLY = (
    ("POST", _AZURE_TOKEN),
    ("GET", _AZURE_SUBSCRIPTION),
    ("GET", _AZURE_CLUSTERS),
    ("POST", _AZURE_KUBECONFIG),
)


@dataclass(frozen=True)
class CloudRequest:
    method: str
    path: str
    query: dict[str, str]
    headers: CIMultiDict[str] = field(repr=False)
    body: object = field(repr=False)


@dataclass(frozen=True)
class _IssuedToken:
    tenant: str
    scope: str
    expires: float


class FakeAzure:
    def __init__(self):
        self.subscriptions: dict[str, dict[str, str]] = {}
        self.clusters: dict[str, list[dict]] = {}
        self.service_principals: dict[tuple[str, str], str] = {}
        self.refresh_tokens: dict[str, tuple[str, str]] = {}
        self.issued_tokens: dict[str, _IssuedToken] = {}
        self._servers: dict[str, str] = {}

    def add_aks(
        self,
        sub: str,
        name: str,
        *,
        server: str,
        location: str = "westeurope",
        private: bool = False,
        entra: bool = True,
        pools: list[dict] | None = None,
        tags: dict[str, str] | None = None,
    ) -> dict:
        resource_id = (
            f"/subscriptions/{sub}/resourceGroups/test-rg"
            f"/providers/Microsoft.ContainerService/managedClusters/{name}"
        )
        tenant = self.subscriptions[sub]["tenant"]
        cluster = {
            "id": resource_id,
            "name": name,
            "location": location,
            "tags": dict(tags or {}),
            "properties": {
                "kubernetesVersion": "1.31.0",
                "agentPoolProfiles": pools
                if pools is not None
                else [
                    {
                        "name": "system",
                        "count": 1,
                        "vmSize": "Standard_D2",
                        "orchestratorVersion": "1.31.0",
                    }
                ],
                "apiServerAccessProfile": {"enablePrivateCluster": private},
                "aadProfile": {"tenantID": tenant} if entra else None,
            },
        }
        self.clusters.setdefault(sub, []).append(cluster)
        self._servers[resource_id.lower()] = server
        return cluster

    def token_response(self, tenant: str, form: dict, lifetime: int) -> web.Response:
        grant = form.get("grant_type")
        client = form.get("client_id")
        if grant == "client_credentials":
            secret = self.service_principals.get((tenant, client))
            if not secret or secret != form.get("client_secret"):
                return web.json_response(
                    {"error": "invalid_client", "error_description": "Unknown service principal."},
                    status=401,
                )
        elif grant == "refresh_token":
            login = self.refresh_tokens.get(form.get("refresh_token"))
            if client != AZURE_CLI_CLIENT_ID or not login or login[0] != tenant:
                return web.json_response(
                    {"error": "invalid_grant", "error_description": "Unknown refresh token."},
                    status=400,
                )
        else:
            return web.json_response({"error": "unsupported_grant_type"}, status=400)
        scopes = form.get("scope", "").split()
        if not scopes:
            return web.json_response({"error": "invalid_scope"}, status=400)
        token = f"az-{len(self.issued_tokens) + 1}"
        self.issued_tokens[token] = _IssuedToken(tenant, scopes[0], time.monotonic() + lifetime)
        return web.json_response({"access_token": token, "expires_in": lifetime})

    def _live_token(self, authorization: str | None) -> _IssuedToken | None:
        if not authorization or not authorization.startswith("Bearer "):
            return None
        token = self.issued_tokens.get(authorization.removeprefix("Bearer "))
        return token if token and time.monotonic() < token.expires else None

    def kube_token_ok(self, authorization: str | None) -> bool:
        token = self._live_token(authorization)
        if token is None or not _AKS_SCOPE.fullmatch(token.scope):
            return False
        app_id = token.scope.removesuffix("/.default")
        return app_id == AKS_SERVER_APP_ID or any(
            (cluster["properties"].get("aadProfile") or {}).get("serverAppID") == app_id
            for clusters in self.clusters.values()
            for cluster in clusters
        )

    def arm_response(
        self, route: re.Pattern, match: re.Match, request: web.Request, base: str
    ) -> web.Response:
        token = self._live_token(request.headers.get("Authorization"))
        if not token or token.scope != ARM_SCOPE:
            return _arm_error(401, "InvalidAuthenticationToken", "An ARM token is required.")
        sub = match["sub"].lower()
        subscription = self.subscriptions.get(sub)
        if not subscription:
            return _arm_error(404, "SubscriptionNotFound", "Unknown subscription.")
        if token.tenant != subscription["tenant"]:
            return _arm_error(
                403, "AuthorizationFailed", "The ARM token is for a different tenant."
            )
        if route is _AZURE_SUBSCRIPTION:
            return web.json_response({"subscriptionId": sub, "displayName": subscription["name"]})
        if route is _AZURE_CLUSTERS:
            clusters = self.clusters.get(sub, [])
            offset = int(request.query.get("$skiptoken", "0"))
            page = {"value": clusters[offset : offset + 2]}
            if offset + 2 < len(clusters):
                query = dict(request.query)
                query["$skiptoken"] = str(offset + 2)
                page["nextLink"] = f"{base}{request.rel_url.with_query(query)}"
            return web.json_response(page)

        server = self._servers.get(match["id"].lower())
        if not server:
            return _arm_error(404, "ResourceNotFound", "Unknown managed cluster.")
        config = {
            "apiVersion": "v1",
            "kind": "Config",
            "clusters": [
                {
                    "name": "test",
                    "cluster": {"server": server, "certificate-authority-data": "ZmFrZS1jYQ=="},
                }
            ],
            "users": [{"name": "test", "user": {"token": "never-keep-this-token"}}],
        }
        data = base64.b64encode(yaml.safe_dump(config).encode()).decode()
        return web.json_response({"kubeconfigs": [{"name": "clusterUser", "value": data}]})


def _arm_error(status: int, code: str, message: str) -> web.Response:
    return web.json_response({"error": {"code": code, "message": message}}, status=status)


class FakeCloud:
    def __init__(self):
        self.url = ""
        self.requests: list[CloudRequest] = []
        self.token_lifetime: dict[CloudProvider, int] = {
            "azure": 3600,
            "aws": 3600,
            "gcp": 3600,
            "oci": 3600,
        }
        self.fail: dict[str, tuple[int, str]] = {}
        self.azure = FakeAzure()

    def endpoints(self) -> CloudEndpoints:
        return CloudEndpoints(azure_login=self.url, azure_arm=self.url)

    def read_only_violations(self) -> list[str]:
        return [
            f"{request.method} {request.path}"
            for request in self.requests
            if not any(
                request.method == method and route.fullmatch(request.path)
                for method, route in _READ_ONLY
            )
        ]

    def kube_token_ok(self, provider: CloudProvider) -> Callable[[str | None], bool]:
        if provider == "azure":
            return self.azure.kube_token_ok
        return lambda _authorization: False

    async def handle(self, request: web.Request) -> web.Response:
        body: object = None
        if request.can_read_body:
            if request.content_type == "application/x-www-form-urlencoded":
                body = dict(await request.post())
            else:
                body = await request.text()
        self.requests.append(
            CloudRequest(
                request.method,
                request.path,
                dict(request.query),
                CIMultiDict(request.headers),
                body,
            )
        )
        for pattern, (status, message) in self.fail.items():
            if re.search(pattern, request.path):
                return _arm_error(status, "FakeFailure", message)
        for method, route in _READ_ONLY:
            match = route.fullmatch(request.path)
            if request.method == method and match is not None:
                if route is _AZURE_TOKEN:
                    return self.azure.token_response(
                        match["tenant"],
                        body if isinstance(body, dict) else {},
                        self.token_lifetime["azure"],
                    )
                return self.azure.arm_response(route, match, request, self.url)
        return _arm_error(404, "ResourceNotFound", "This operation isn't served by the fake cloud.")


@asynccontextmanager
async def serve_fake_cloud():
    cloud = FakeCloud()
    app = web.Application()
    app.router.add_route("*", "/{path:.*}", cloud.handle)
    runner = web.AppRunner(app)
    await runner.setup()
    try:
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        cloud.url = f"http://127.0.0.1:{runner.addresses[0][1]}"
        yield cloud
    finally:
        await runner.cleanup()


@pytest.fixture
async def fake_cloud():
    async with serve_fake_cloud() as cloud:
        yield cloud


def write_azure_cli_login(dir, *, subscriptions, refresh_token, user):
    """Write a profile and MSAL cache in a disposable test login directory."""
    dir.mkdir(parents=True, exist_ok=True)
    rows = [{"user": {"name": user, "type": "user"}, **row} for row in subscriptions]
    (dir / "azureProfile.json").write_text(
        json.dumps({"subscriptions": rows}), encoding="utf-8-sig"
    )
    environment = "login.microsoftonline.com"
    accounts = {}
    tokens = {}
    for row in rows:
        tenant = row["tenantId"]
        username = row["user"]["name"]
        home = f"fake-{username}.{tenant}"
        accounts[f"{home}-{environment}-{tenant}"] = {
            "home_account_id": home,
            "environment": environment,
            "realm": tenant,
            "username": username,
        }
        tokens[f"{home}-{environment}-refreshtoken-{AZURE_CLI_CLIENT_ID}--"] = {
            "credential_type": "RefreshToken",
            "home_account_id": home,
            "environment": environment,
            "client_id": AZURE_CLI_CLIENT_ID,
            "secret": refresh_token,
        }
    (dir / "msal_token_cache.json").write_text(
        json.dumps({"Account": accounts, "RefreshToken": tokens}), encoding="utf-8"
    )
