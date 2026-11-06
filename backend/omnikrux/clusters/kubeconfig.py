import copy
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import yaml

from omnikrux.clusters.models import Environment, Provider

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "0.0.0.0", "::1"}
DOCKER_HOST = "host.docker.internal"


@dataclass(frozen=True)
class ParsedContext:
    context_name: str
    server: str
    provider: Provider
    environment: Environment
    exec_command: str | None
    standalone: dict
    original_server: str | None = None  # the kubeconfig's own address, when `server` was rewritten


def _basename(command: str | None) -> str:
    if not command:
        return ""
    return command.replace("\\", "/").rsplit("/", 1)[-1]


def detect_provider(context_name: str, server: str, exec_command: str | None) -> Provider:
    host = (urlsplit(server).hostname or "").lower()
    exe = _basename(exec_command)
    if host.endswith(".azmk8s.io") or exe == "kubelogin":
        return Provider.AKS
    if host.endswith(".eks.amazonaws.com") or exe in {"aws", "aws-iam-authenticator"}:
        return Provider.EKS
    if context_name.startswith("gke_") or exe == "gke-gcloud-auth-plugin":
        return Provider.GKE
    if ".oraclecloud.com" in host or exe == "oci":
        return Provider.OKE
    if context_name.startswith("kind-"):
        return Provider.KIND
    return Provider.ONPREM


def guess_environment(name: str, provider: Provider) -> Environment:
    if provider is Provider.KIND:
        return Environment.DEVELOPMENT
    lowered = name.lower()
    if "prod" in lowered or "prd" in lowered:
        return Environment.PRODUCTION
    if any(token in lowered for token in ("dev", "test", "sandbox", "local")):
        return Environment.DEVELOPMENT
    return Environment.UNKNOWN


def to_docker_host(cluster: dict) -> dict:
    """`cluster` with a loopback server address pointed at the Docker host instead."""
    parts = urlsplit(cluster.get("server", ""))
    host = parts.hostname
    if host is None or host not in LOOPBACK_HOSTS:
        return cluster
    netloc = DOCKER_HOST if parts.port is None else f"{DOCKER_HOST}:{parts.port}"
    out = copy.deepcopy(cluster)
    out["server"] = urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))
    out.setdefault("tls-server-name", host)
    return out


def _by_name(items: list, key: str) -> dict:
    return {i["name"]: i[key] for i in items if isinstance(i, dict) and "name" in i and isinstance(i.get(key), dict)}


def parse_kubeconfig(text: str, *, rewrite_loopback: bool) -> list[ParsedContext]:
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise ValueError(f"Not a kubeconfig: invalid YAML ({exc})") from exc
    if not isinstance(doc, dict) or not isinstance(doc.get("contexts"), list):
        raise ValueError("Not a kubeconfig: missing 'contexts' list")  # noqa: TRY004

    clusters = _by_name(doc.get("clusters") or [], "cluster")
    users = _by_name(doc.get("users") or [], "user")
    out: list[ParsedContext] = []
    for entry in doc["contexts"]:
        if not isinstance(entry, dict) or not isinstance(entry.get("context"), dict) or "name" not in entry:
            continue
        name, ctx = entry["name"], entry["context"]
        cluster = clusters.get(ctx.get("cluster"))
        user = users.get(ctx.get("user"))
        if cluster is None or user is None:
            continue
        original = cluster.get("server", "")
        if rewrite_loopback:
            cluster = to_docker_host(cluster)
        server = cluster.get("server", "")
        exec_cfg = user.get("exec")
        exec_command = exec_cfg.get("command") if isinstance(exec_cfg, dict) else None
        provider = detect_provider(name, server, exec_command)
        standalone = copy.deepcopy({
            "apiVersion": "v1",
            "kind": "Config",
            "current-context": name,
            "clusters": [{"name": ctx["cluster"], "cluster": cluster}],
            "users": [{"name": ctx["user"], "user": user}],
            "contexts": [{"name": name, "context": ctx}],
        })
        out.append(
            ParsedContext(
                name,
                server,
                provider,
                guess_environment(name, provider),
                exec_command,
                standalone,
                original_server=original if original != server else None,
            )
        )
    return out


def read_kubeconfig_files(paths: list[Path]) -> list[str]:
    return [p.read_text(encoding="utf-8") for p in paths if p.is_file()]
