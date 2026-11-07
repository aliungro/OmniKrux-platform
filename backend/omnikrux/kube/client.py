import shutil

from kubernetes_asyncio import client, config
from kubernetes_asyncio.stream import WsApiClient

# Ping every WebSocket stream (exec) this often: proxies and load balancers in front of managed
# API servers drop idle connections, and a missing pong ends the stream as an error.
WS_HEARTBEAT_SECONDS = 30


class ClusterUnavailable(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


async def build_configuration(kubeconfig: dict) -> client.Configuration:
    """The client Configuration for a kubeconfig; every client the console builds starts here."""
    users = kubeconfig.get("users") or []
    user = (users[0].get("user") or {}) if users else {}
    command = (user.get("exec") or {}).get("command")
    # Checked before loading: the loader may try to run the plugin.
    if command and shutil.which(command) is None:
        raise ClusterUnavailable(
            f"This cluster signs in with '{command}', which isn't installed in the console."
        )
    configuration = type.__call__(client.Configuration)  # not the process-wide default
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


async def make_api_client(kubeconfig: dict) -> client.ApiClient:
    return client.ApiClient(configuration=await build_configuration(kubeconfig))


async def make_ws_api_client(kubeconfig: dict) -> WsApiClient:
    configuration = await build_configuration(kubeconfig)
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
