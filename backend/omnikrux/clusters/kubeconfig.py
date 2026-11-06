import copy
import logging
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import yaml

from omnikrux.clusters.models import Environment, Provider

log = logging.getLogger(__name__)

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "0.0.0.0", "::1"}
DOCKER_HOST = "host.docker.internal"


class KubeconfigError(ValueError):
    """The text isn't a usable kubeconfig. The message never quotes the file (it may hold tokens);
    `error_type` names the underlying parser error, for logs."""

    def __init__(self, message: str, *, error_type: str | None = None):
        super().__init__(message)
        self.error_type = error_type


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


def _name(value: object) -> str | None:
    """A kubeconfig name as text: YAML reads `2024` as an int. None for lists, maps and nulls."""
    if isinstance(value, str):
        return value
    if isinstance(value, int | float):  # bool included: `yes` is a valid if odd name
        return str(value)
    return None


def _by_name(items: object, key: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for item in items if isinstance(items, list) else []:
        if (
            isinstance(item, dict)
            and (name := _name(item.get("name"))) is not None
            and isinstance(item.get(key), dict)
        ):
            out[name] = item[key]
    return out


def parse_kubeconfig(text: str, *, rewrite_loopback: bool) -> list[ParsedContext]:
    """One `ParsedContext` per usable context. A context that can't be read is skipped with a
    warning naming it, so one bad entry never drops the rest of the file."""
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        # Position only: the YAML error's own text quotes the offending line, which may hold a token.
        mark = getattr(exc, "problem_mark", None)
        where = f" at line {mark.line + 1}, column {mark.column + 1}" if mark is not None else ""
        raise KubeconfigError(
            f"Not a kubeconfig: invalid YAML{where}", error_type=type(exc).__name__
        ) from None
    if not isinstance(doc, dict) or not isinstance(doc.get("contexts"), list):
        raise ValueError("Not a kubeconfig: missing 'contexts' list")  # noqa: TRY004

    clusters = _by_name(doc.get("clusters"), "cluster")
    users = _by_name(doc.get("users"), "user")
    out: list[ParsedContext] = []
    for entry in doc["contexts"]:
        if not isinstance(entry, dict) or not isinstance(entry.get("context"), dict):
            continue
        if (name := _name(entry.get("name"))) is None:
            continue
        try:
            parsed = _parse_context(
                name, entry["context"], clusters, users, rewrite_loopback=rewrite_loopback
            )
        except Exception as exc:  # noqa: BLE001 (logged below by type only)
            # The type only: messages can quote kubeconfig values.
            log.warning(
                "Skipping kubeconfig context %r: it could not be read (%s)",
                name,
                type(exc).__name__,
            )
            continue
        if parsed is not None:
            out.append(parsed)
    return out


def _parse_context(
    name: str,
    ctx: dict,
    clusters: dict[str, dict],
    users: dict[str, dict],
    *,
    rewrite_loopback: bool,
) -> ParsedContext | None:
    cluster_name, user_name = _name(ctx.get("cluster")), _name(ctx.get("user"))
    cluster = clusters.get(cluster_name) if cluster_name is not None else None
    user = users.get(user_name) if user_name is not None else None
    if cluster is None or user is None:
        return None
    original = cluster.get("server", "")
    if rewrite_loopback:
        cluster = to_docker_host(cluster)
    server = cluster.get("server", "")
    user = copy.deepcopy(user)
    exec_cfg = user.get("exec")
    exec_command = _name(exec_cfg.get("command")) if isinstance(exec_cfg, dict) else None
    if exec_command is not None:
        exec_cfg["command"] = exec_command
    provider = detect_provider(name, server, exec_command)
    standalone = copy.deepcopy(
        {
            "apiVersion": "v1",
            "kind": "Config",
            "current-context": name,
            "clusters": [{"name": cluster_name, "cluster": cluster}],
            "users": [{"name": user_name, "user": user}],
            "contexts": [
                {"name": name, "context": {**ctx, "cluster": cluster_name, "user": user_name}}
            ],
        }
    )
    return ParsedContext(
        name,
        server,
        provider,
        guess_environment(name, provider),
        exec_command,
        standalone,
        original_server=original if original != server else None,
    )


def read_kubeconfig_files(paths: list[Path]) -> list[str]:
    return [p.read_text(encoding="utf-8") for p in paths if p.is_file()]
