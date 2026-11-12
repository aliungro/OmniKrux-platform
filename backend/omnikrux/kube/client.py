from base64 import b64encode
from collections.abc import AsyncIterator
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass

import aiohttp
from aiohttp.http_exceptions import HttpProcessingError
from kubernetes_asyncio import client, config
from kubernetes_asyncio.client.exceptions import ApiException
from kubernetes_asyncio.client.rest import RESTResponse
from kubernetes_asyncio.stream import WsApiClient

from omnikrux.kube.tokens import (
    CachedToken,
    CloudClusterUnavailable,
    CloudTokenSource,
    ClusterUnavailable,
    ExecPluginToken,
    RunPlugin,
    TokenSource,
    UnsupportedPluginOutput,
    require_live_token,
    utcnow,
)

__all__ = ["ClusterUnavailable", "build_configuration", "make_api_client", "make_ws_api_client"]

# Ping every WebSocket stream (exec) this often: proxies and load balancers in front of managed
# API servers drop idle connections, and a missing pong ends the stream as an error.
WS_HEARTBEAT_SECONDS = 30


def _disable_redirects(session: aiohttp.ClientSession) -> None:
    request = session.request

    def without_redirects(method, url, **kwargs):
        # The WebSocket upgrade uses the same session request entry point.
        kwargs["allow_redirects"] = False
        return request(method, url, **kwargs)

    session.request = without_redirects


@contextmanager
def _cloud_transport_errors():
    try:
        yield
    except TimeoutError:
        raise TimeoutError("The cluster did not answer.") from None
    except (aiohttp.ClientError, HttpProcessingError):
        raise CloudClusterUnavailable(
            "The connection to the cluster failed. Check the network, then try again."
        ) from None


@dataclass(frozen=True)
class _CloudContent:
    stream: aiohttp.StreamReader

    async def iter_any(self) -> AsyncIterator[bytes]:
        with _cloud_transport_errors():
            async for chunk in self.stream.iter_any():
                yield chunk


class _CloudResponse:
    """Read a successful raw response with the cloud transport's diagnostic policy."""

    def __init__(self, response: aiohttp.ClientResponse) -> None:
        self._response = response
        self.status = response.status
        self.reason = response.reason
        self.content = _CloudContent(response.content)

    async def read(self) -> bytes:
        with _cloud_transport_errors():
            return await self._response.read()

    def release(self) -> None:
        self._response.release()

    def close(self) -> None:
        self._response.close()


@dataclass(frozen=True)
class _CloudErrorResponse:
    """The raw callers retain the HTTP status and can release the already closed response."""

    status: int
    reason: str = "The cluster refused the request."

    async def read(self) -> bytes:
        return b""

    def release(self) -> None:
        pass

    close = release


class _CloudApiClient(client.ApiClient):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        _disable_redirects(self.rest_client.pool_manager)

    async def request(self, method, url, *, _preload_content=True, **kwargs):
        # The generated transport logs preloaded bodies before it checks the status.
        with _cloud_transport_errors():
            response = await super().request(method, url, _preload_content=False, **kwargs)
            if not 200 <= response.status < 300:
                failure = _CloudErrorResponse(response.status)
                response.release()
                if not _preload_content:
                    return failure
                error = ApiException(status=failure.status, reason=failure.reason)
                error.body = b""  # ApiClient decodes exception bodies before handing them back.
                raise error
            if not _preload_content:
                return _CloudResponse(response)
            try:
                return RESTResponse(response, await response.read())
            finally:
                response.release()


class CloudWsApiClient(WsApiClient):
    """A streaming client whose callers use safe cloud error diagnostics."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        _disable_redirects(self.rest_client.pool_manager)


def kubeconfig_user(kubeconfig: dict) -> dict:
    users = kubeconfig.get("users") or []
    active = kubeconfig.get("current-context")
    for entry in kubeconfig.get("contexts") or []:
        if entry.get("name") == active:
            name = (entry.get("context") or {}).get("user")
            return next((u.get("user") or {} for u in users if u.get("name") == name), {})
    return (users[0].get("user") or {}) if users else {}


async def build_configuration(
    kubeconfig: dict, *, token: TokenSource | None = None
) -> client.Configuration:
    """The client Configuration for a kubeconfig; every client the console builds starts here."""
    exec_cfg = kubeconfig_user(kubeconfig).get("exec")
    if token is None and isinstance(exec_cfg, dict):
        token = CachedToken(ExecPluginToken(RunPlugin(exec_cfg)))

    async def refresh(configuration: client.Configuration) -> None:
        assert token is not None
        credential = await token()
        require_live_token(credential, utcnow())
        configuration.api_key["BearerToken"] = credential.value

    configuration = type.__call__(client.Configuration)  # not the process-wide default
    if token is not None:
        kubeconfig = deepcopy(kubeconfig)
        user = kubeconfig_user(kubeconfig)
        for key in ("exec", "token", "tokenFile", "auth-provider", "username", "password"):
            user.pop(key, None)
        try:
            await refresh(configuration)
        except UnsupportedPluginOutput as credentials:
            # Let the loader materialize the TLS credentials from the successful exec response.
            # Running exec again through the loader could expose the plugin's stderr on failure.
            user["client-certificate-data"] = b64encode(credentials.certificate.encode()).decode()
            user["client-key-data"] = b64encode(credentials.key.encode()).decode()
        else:
            configuration.api_key_prefix["BearerToken"] = "Bearer"
            configuration.refresh_api_key_hook = refresh
    await config.load_kube_config_from_dict(
        config_dict=kubeconfig, client_configuration=configuration
    )
    clusters = kubeconfig.get("clusters") or []
    tls_server_name = (
        ((clusters[0].get("cluster") or {}).get("tls-server-name")) if clusters else None
    )
    if tls_server_name and not configuration.tls_server_name:
        configuration.tls_server_name = tls_server_name
    return configuration


async def make_api_client(
    kubeconfig: dict, *, token: TokenSource | None = None
) -> client.ApiClient:
    api_type = _CloudApiClient if isinstance(token, CloudTokenSource) else client.ApiClient
    return api_type(configuration=await build_configuration(kubeconfig, token=token))


async def make_ws_api_client(kubeconfig: dict, *, token: TokenSource | None = None) -> WsApiClient:
    configuration = await build_configuration(kubeconfig, token=token)
    api_type = CloudWsApiClient if isinstance(token, CloudTokenSource) else WsApiClient
    api = api_type(configuration=configuration, heartbeat=WS_HEARTBEAT_SECONDS)
    if configuration.tls_server_name:
        # kubernetes_asyncio sets the certificate name on plain requests but not on WebSocket
        # ones, so a rewritten loopback server (kind in the container) would fail verification.
        session = api.rest_client.pool_manager
        ws_connect = session.ws_connect

        def ws_connect_as(url, **kwargs):
            return ws_connect(url, server_hostname=configuration.tls_server_name, **kwargs)

        session.ws_connect = ws_connect_as
    return api
