import shutil

from kubernetes_asyncio import client, config


class ClusterUnavailable(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


async def make_api_client(kubeconfig: dict) -> client.ApiClient:
    users = kubeconfig.get("users") or []
    user = (users[0].get("user") or {}) if users else {}
    command = (user.get("exec") or {}).get("command")
    # Checked before loading: the loader may try to run the plugin.
    if command and shutil.which(command) is None:
        raise ClusterUnavailable(
            f"This cluster signs in with '{command}', which isn't installed in the console."
        )
    api = await config.new_client_from_config_dict(kubeconfig)
    clusters = kubeconfig.get("clusters") or []
    tls_server_name = (
        ((clusters[0].get("cluster") or {}).get("tls-server-name")) if clusters else None
    )
    if tls_server_name and not api.configuration.tls_server_name:
        api.configuration.tls_server_name = tls_server_name
    return api
