from base64 import b64encode
from copy import deepcopy

from kubernetes_asyncio import client, config
from kubernetes_asyncio.stream import WsApiClient

from omnikrux.kube.tokens import (
    CachedToken,
    ClusterUnavailable,
    ExecPluginToken,
    RunPlugin,
    TokenSource,
    UnsupportedPluginOutput,
)

__all__ = ["ClusterUnavailable", "build_configuration", "make_api_client", "make_ws_api_client"]

# Ping every WebSocket stream (exec) this often: proxies and load balancers in front of managed
# API servers drop idle connections, and a missing pong ends the stream as an error.
WS_HEARTBEAT_SECONDS = 30


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
        configuration.api_key["BearerToken"] = (await token()).value

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
    return client.ApiClient(configuration=await build_configuration(kubeconfig, token=token))


async def make_ws_api_client(kubeconfig: dict, *, token: TokenSource | None = None) -> WsApiClient:
    configuration = await build_configuration(kubeconfig, token=token)
    api = WsApiClient(configuration=configuration, heartbeat=WS_HEARTBEAT_SECONDS)
    if configuration.tls_server_name:
        # kubernetes_asyncio sets the certificate name on plain requests but not on WebSocket
        # ones, so a rewritten loopback server (kind in the container) would fail verification.
        session = api.rest_client.pool_manager
        ws_connect = session.ws_connect

        def ws_connect_as(url, **kwargs):
            return ws_connect(url, server_hostname=configuration.tls_server_name, **kwargs)

        session.ws_connect = ws_connect_as
    return api
