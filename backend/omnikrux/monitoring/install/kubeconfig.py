"""The kubeconfig handed to Helm: built from the console's own client configuration (so a cloud
login or an exec plugin becomes a plain token Helm can use), written into a private temporary
folder for one Helm call, and removed with that folder when the call ends, however it ends."""

import asyncio
import base64
import logging
import os
import shutil
import tempfile
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

import yaml
from kubernetes_asyncio.client import Configuration

from omnikrux.kube.connections import ClusterConnections

log = logging.getLogger(__name__)

FOLDER_PREFIX = "omnikrux-helm-"
_REMOVE_ATTEMPTS = 5
_REMOVE_PAUSE_SECONDS = 0.2


def _file_data(path: str | None) -> str | None:
    """A file's bytes as base64 (kubernetes_asyncio keeps CA, certificate and key as files)."""
    if not path:
        return None
    return base64.b64encode(Path(path).read_bytes()).decode()


def _credential(cfg: Configuration) -> tuple[str, str | None]:
    """("token", value), ("basic", "user:password") or ("", None) from the client's api key.
    The kubeconfig loader keeps the scheme in the value; the refresh hook keeps it apart."""
    value = (cfg.api_key or {}).get("BearerToken")
    if not isinstance(value, str) or not value:
        return "", None
    scheme, _, rest = value.partition(" ")
    if scheme.lower() == "bearer" and rest:
        return "token", rest
    if scheme.lower() == "basic" and rest:
        try:
            return "basic", base64.b64decode(rest).decode()
        except ValueError:
            return "", None
    return "token", value


def kubeconfig_from_configuration(cfg: Configuration, *, name: str = "omnikrux") -> dict:
    """One cluster, user and context; never an `exec` or `auth-provider` entry."""
    cluster: dict = {"server": cfg.host}
    if cfg.verify_ssl is False:
        cluster["insecure-skip-tls-verify"] = True
    elif ca := _file_data(cfg.ssl_ca_cert):
        cluster["certificate-authority-data"] = ca
    if cfg.tls_server_name:
        cluster["tls-server-name"] = cfg.tls_server_name
    if cfg.proxy:
        cluster["proxy-url"] = cfg.proxy

    user: dict = {}
    if cert := _file_data(cfg.cert_file):
        user["client-certificate-data"] = cert
    if key := _file_data(cfg.key_file):
        user["client-key-data"] = key
    kind, value = _credential(cfg)
    if kind == "token":
        user["token"] = value
    elif kind == "basic" and value is not None:
        username, _, password = value.partition(":")
        user["username"], user["password"] = username, password

    return {
        "apiVersion": "v1",
        "kind": "Config",
        "current-context": name,
        "clusters": [{"name": name, "cluster": cluster}],
        "users": [{"name": name, "user": user}],
        "contexts": [{"name": name, "context": {"cluster": name, "user": name}}],
    }


def secrets_of(cfg: Configuration) -> list[str]:
    """What must never appear in anything shown or logged: the token (or basic password) and
    the client key's text."""
    found: list[str] = []
    kind, value = _credential(cfg)
    if kind == "token" and value:
        found.append(value)
    elif kind == "basic" and value:
        found.append(value.partition(":")[2])
    if cfg.key_file:
        found.append(Path(cfg.key_file).read_text(encoding="utf-8", errors="replace"))
    return [s for s in found if s]


def hosts_of(cfg: Configuration) -> list[str]:
    """The server's host and the TLS server name (hidden from a cloud cluster's messages)."""
    hosts = [urlsplit(cfg.host or "").hostname, cfg.tls_server_name]
    return [h for h in dict.fromkeys(hosts) if h]


def secrets_and_hosts(path: Path) -> tuple[list[str], list[str]]:
    """`secrets_of` and `hosts_of` for a kubeconfig `helm_kubeconfig` wrote, read while the block
    is open, so a caller scrubs exactly the credentials that Helm call was given."""
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    cluster = doc["clusters"][0]["cluster"]
    user = doc["users"][0]["user"]
    secrets = [user.get("token"), user.get("password")]
    if key := user.get("client-key-data"):
        secrets.append(base64.b64decode(key).decode("utf-8", errors="replace"))
    hosts = [urlsplit(cluster.get("server") or "").hostname, cluster.get("tls-server-name")]
    return [s for s in secrets if s], [h for h in dict.fromkeys(hosts) if h]


def _write_private(path: Path, text: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)


async def _remove(folder: Path) -> None:
    """Remove the folder; on Windows a file can stay locked for a moment after its reader ends."""
    for attempt in range(_REMOVE_ATTEMPTS):
        try:
            shutil.rmtree(folder)
            return
        except FileNotFoundError:
            return
        except OSError:
            if attempt + 1 == _REMOVE_ATTEMPTS:
                log.error("Couldn't remove a temporary Helm kubeconfig folder (%s)", folder.name)
                return
            await asyncio.sleep(_REMOVE_PAUSE_SECONDS)


@asynccontextmanager
async def helm_kubeconfig(connections: ClusterConnections, cluster_id: str) -> AsyncIterator[Path]:
    """A kubeconfig file for one Helm call, in a new private folder (0700, the file 0600) that is
    removed when the block ends: normally, on failure, on cancel or on timeout."""
    cfg = await connections.configuration(cluster_id)
    text = yaml.safe_dump(kubeconfig_from_configuration(cfg), sort_keys=False)
    folder = Path(tempfile.mkdtemp(prefix=FOLDER_PREFIX))
    try:
        path = folder / "kubeconfig"
        _write_private(path, text)
        yield path
    finally:
        await _remove(folder)
