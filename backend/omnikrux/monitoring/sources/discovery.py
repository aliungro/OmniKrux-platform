"""Find Prometheus, Loki and Grafana in a cluster OmniKrux knows.

Discovery lists the cluster's Services (cluster-wide, with the cluster's own connection), picks
the ones that look like a tool by their labels, then by their names, and probes each candidate
through the cluster's service proxy: Prometheus and Loki with their connector's test, Grafana
with `/api/health`. Nothing is written into the cluster and nothing is stored.

Cloud clusters keep their privacy rule: a failure is worded by `cloud_kube_error` (the listing
here, the probes in the transport), never with the cluster's endpoint or a response body.
"""

import asyncio
import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from fnmatch import fnmatchcase
from typing import Literal, cast

from aiohttp.http_exceptions import HttpProcessingError
from kubernetes_asyncio.client.exceptions import ApiException

from omnikrux.clusters.registry import SOURCE_CLOUD, ClusterInfo, ClusterRegistry
from omnikrux.kube.connections import ClusterConnections, cloud_kube_error, kube_error_message
from omnikrux.kube.http import KUBE_ERRORS, call_json
from omnikrux.kube.tokens import ClusterUnavailable
from omnikrux.monitoring.sources.connector import (
    NOT_LIKE,
    ClusterProbe,
    ConnectorRegistry,
    json_object,
    status_message,
)
from omnikrux.monitoring.sources.health import run_test
from omnikrux.monitoring.sources.store import SourceStore
from omnikrux.monitoring.sources.transport import (
    SourceTransport,
    SourceUnreachable,
    TransportFactory,
)
from omnikrux.monitoring.sources.types import ClusterTarget, SourceConfig, SourceSecrets, SourceType

log = logging.getLogger(__name__)

FoundType = Literal["prometheus", "loki", "grafana", "alertmanager"]
FoundState = Literal["reachable", "unreachable", "missing"]
Scheme = Literal["http", "https"]

CLUSTER_GONE = "That cluster isn't connected to OmniKrux any more."
LIST_ACTION = "list the cluster's services"
PROBE_FAILED = "Couldn't check {name}. Try again."
PROBE_FORBIDDEN = (
    "Couldn't check {name}: its login isn't allowed to read the Prometheus Operator's "
    "resources. Give it permission to read them, or run the rule in OmniKrux."
)
UNEXPECTED_LIST = (
    "The cluster answered the list of its services with something unexpected. Try again."
)

LIST_SECONDS = 10.0
PROBE_SECONDS = 5.0
CONCURRENCY = 6

# --- Which Services are tools ------------------------------------------------------------------

NEVER_PROMETHEUS = frozenset(
    {
        "alertmanager",
        "node-exporter",
        "pushgateway",
        "kube-state-metrics",
        "operator",
        "prometheus-operator",
    }
)
PROMETHEUS_LABELS = (
    ("app.kubernetes.io/name", "prometheus"),
    ("app", "prometheus"),
    ("app", "kube-prometheus-stack-prometheus"),
    ("operated-prometheus", "true"),
)
PROMETHEUS_NAMES = (
    "prometheus-server",
    "prometheus-k8s",
    "prometheus-operated",
    "*-prometheus",
    "thanos-query",
    "thanos-query-frontend",
    "vmselect",
    "vmsingle-*",
    "victoria-metrics-single-server",
    "mimir-query-frontend",
)
LOKI_COMPONENTS = frozenset({"single-binary", "read", "gateway", "query-frontend"})
LOKI_NAMES = ("loki", "loki-gateway", "loki-read", "loki-query-frontend")
GRAFANA_NAMES = ("grafana", "*-grafana")
ALERTMANAGER_LABELS = (
    ("app.kubernetes.io/name", "alertmanager"),
    ("app", "alertmanager"),
    ("operated-alertmanager", "true"),
)
ALERTMANAGER_NAMES = (
    "alertmanager",
    "alertmanager-main",
    "alertmanager-operated",
    "*-alertmanager",
)

PORT_NAMES = ("http", "http-web", "web", "http-query", "http-metrics", "service")
PORT_NUMBERS: dict[FoundType, tuple[int, ...]] = {
    "prometheus": (9090, 8481, 8080),
    "loki": (3100, 80),
    "grafana": (3000, 80),
    "alertmanager": (9093,),
}
TYPE_ORDER: tuple[FoundType, ...] = ("prometheus", "loki", "grafana", "alertmanager")
# A tool with no candidate gets one "missing" entry; Grafana is only ever reported when found.
REPORTED_MISSING: tuple[FoundType, ...] = ("prometheus", "loki")


def _component(labels: Mapping[str, str]) -> str | None:
    return labels.get("app.kubernetes.io/component") or labels.get("component")


def _named(name: str, patterns: Sequence[str]) -> bool:
    return any(fnmatchcase(name, pattern) for pattern in patterns)


def tool_type(name: str, labels: Mapping[str, str]) -> FoundType | None:
    """Which tool a Service is, by its labels first and then its name; None when it is none
    (or a part of a tool that doesn't answer queries, like an exporter, an operator or the
    gossip ring of a Loki)."""
    if name.endswith("-memberlist") or labels.get("app.kubernetes.io/part-of") == "memberlist":
        return None
    if any(labels.get(k) == v for k, v in ALERTMANAGER_LABELS) or _named(name, ALERTMANAGER_NAMES):
        return "alertmanager"
    may_be_prometheus = _component(labels) not in NEVER_PROMETHEUS
    if may_be_prometheus and any(labels.get(k) == v for k, v in PROMETHEUS_LABELS):
        return "prometheus"
    if labels.get("app.kubernetes.io/name") == "loki":
        component = labels.get("app.kubernetes.io/component")
        return "loki" if component is None or component in LOKI_COMPONENTS else None
    if labels.get("app.kubernetes.io/name") == "grafana":
        return "grafana"
    if may_be_prometheus and _named(name, PROMETHEUS_NAMES):
        return "prometheus"
    if name in LOKI_NAMES:
        return "loki"
    if _named(name, GRAFANA_NAMES):
        return "grafana"
    return None


def _tcp(port: Mapping) -> bool:
    return (port.get("protocol") or "TCP") == "TCP" and isinstance(port.get("port"), int)


def pick_port(
    type: FoundType, ports: Sequence[Mapping], *, any_tcp: bool = True
) -> tuple[str, str | None, Scheme] | None:
    """The port to reach the tool on (its number, its name and its scheme): a port with a usual
    HTTP name, else a usual port number for that tool, else (with `any_tcp`) the first TCP port;
    None when there is none of those."""
    usable = [p for p in ports if isinstance(p, Mapping) and _tcp(p)]
    chosen = next(
        (p for wanted in PORT_NAMES for p in usable if p.get("name") == wanted),
        None,
    )
    if chosen is None:
        chosen = next(
            (p for number in PORT_NUMBERS[type] for p in usable if p["port"] == number),
            None,
        )
    if chosen is None and any_tcp and usable:
        chosen = usable[0]
    if chosen is None:
        return None
    port_name = str(chosen.get("name") or "") or None
    https = (port_name or "").startswith("https") or chosen["port"] == 443
    scheme: Scheme = "https" if https else "http"
    return str(chosen["port"]), port_name, scheme


# --- Shapes ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class FoundTool:
    type: FoundType
    state: FoundState
    namespace: str | None
    service: str | None
    port: str | None
    scheme: Scheme
    version: str | None
    message: str | None
    existing_source_id: str | None
    detail: str | None  # what else is known about the tool; nothing is read for it in M1


@dataclass(frozen=True)
class DiscoveryResult:
    cluster_id: str
    cluster_name: str
    state: Literal["ok", "error"]
    message: str | None
    found: tuple[FoundTool, ...]
    checked_at: datetime


class UnknownCluster(KeyError):
    """OmniKrux doesn't know that cluster (any more)."""


@dataclass(frozen=True)
class _Candidate:
    type: FoundType
    namespace: str
    service: str
    port: str
    port_name: str | None
    scheme: Scheme
    headless: bool
    selector: frozenset[tuple[str, str]] | None  # None: no selector, never merged with another


def candidates(items: Sequence) -> list[_Candidate]:
    """The tools among the listed Services. Services of one tool in one namespace whose
    selectors are equal, or one a subset of the other (the operator's `prometheus-operated`
    selects every Prometheus Pod its main Service selects), are one tool: the best ranked is
    kept."""
    found_all: list[_Candidate] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        meta = item.get("metadata") or {}
        spec = item.get("spec") or {}
        name, namespace = meta.get("name"), meta.get("namespace")
        if not isinstance(name, str) or not isinstance(namespace, str):
            continue
        labels = meta.get("labels") or {}
        labels = {str(k): str(v) for k, v in labels.items()} if isinstance(labels, dict) else {}
        found = tool_type(name, labels)
        if found is None:
            continue
        ports = spec.get("ports")
        ports = [p for p in ports if isinstance(p, dict)] if isinstance(ports, list) else []
        # Without a component label the Service may be any part of the tool: only a port that
        # looks like its HTTP API makes it one.
        picked = pick_port(found, ports, any_tcp=_component(labels) is not None)
        if picked is None:
            continue
        port, port_name, scheme = picked
        selector = spec.get("selector")
        found_all.append(
            _Candidate(
                type=found,
                namespace=namespace,
                service=name,
                port=port,
                port_name=port_name,
                scheme=scheme,
                headless=spec.get("clusterIP") == "None",
                selector=(
                    frozenset((str(k), str(v)) for k, v in selector.items())
                    if isinstance(selector, dict) and selector
                    else None
                ),
            )
        )
    kept = [c for c in found_all if not any(_outranked_by(c, other) for other in found_all)]
    return sorted(kept, key=lambda c: (TYPE_ORDER.index(c.type), c.namespace, c.service))


def _outranked_by(candidate: _Candidate, other: _Candidate) -> bool:
    """`other` is the same tool as `candidate` and ranks better, so `candidate` is dropped."""
    if other is candidate or (other.type, other.namespace) != (candidate.type, candidate.namespace):
        return False
    mine, theirs = candidate.selector, other.selector
    if mine is None or theirs is None or not (mine <= theirs or theirs <= mine):
        return False
    return _rank(other) < _rank(candidate)


def _rank(candidate: _Candidate) -> tuple[bool, bool, str]:
    """Lower is better: a Service with a cluster IP, then a name that isn't the operator's
    `-operated` or a `-headless` twin, then the name."""
    twin = candidate.service.endswith(("-operated", "-headless"))
    return candidate.headless, twin, candidate.service


def transient_config(name: str, type: FoundType, target: ClusterTarget) -> SourceConfig:
    """An unsaved (`id=""`) config reaching a found tool through its cluster, without
    authentication, so the transport factory can build its transport."""
    now = datetime.now(UTC)
    return SourceConfig(
        id="",
        name=name,
        # The transport never reads the type; Grafana isn't a source type (yet).
        type=cast(SourceType, type),
        reach="cluster",
        url=None,
        cluster=target,
        path_prefix="",
        auth_type="none",
        username=None,
        header_name=None,
        client_cert_pem=None,
        ca_pem=None,
        header_names=(),
        secrets=SourceSecrets(),
        created_by_project_id=None,
        created_at=now,
        updated_at=now,
        check=None,
    )


# --- The cluster probe the alerting check uses -------------------------------------------------


class KubeClusterProbe(ClusterProbe):
    """Whether a known cluster serves a resource (`/apis/{group}/{version}` lists `plural`).
    Anything that stops the answer reads as "not served": the caller only decides what to offer."""

    def __init__(
        self, connections: ClusterConnections, cluster_id: str, *, timeout: float = PROBE_SECONDS
    ) -> None:
        self._connections = connections
        self._cluster_id = cluster_id
        self._timeout = timeout

    async def serves(self, group: str, version: str, plural: str) -> bool:
        try:
            async with (
                asyncio.timeout(self._timeout),
                self._connections.api(self._cluster_id) as api,
            ):
                data = await call_json(
                    api, "GET", f"/apis/{group}/{version}", timeout=self._timeout
                )
        except (*KUBE_ERRORS, KeyError, OSError, ValueError, HttpProcessingError) as exc:
            log.info("Couldn't read whether a cluster serves %s (%s)", plural, type(exc).__name__)
            return False
        return _lists(data, plural)

    async def check(self, group: str, version: str, plural: str) -> bool:
        """Like `serves`, with three outcomes: True or False only when the cluster answered (a
        404 for the group version is a "no"); ProbeFailed when it didn't (unreachable, timed out,
        refused, an unreadable answer), so a cluster that can't be asked never reads as "no"."""
        try:
            async with (
                asyncio.timeout(self._timeout),
                self._connections.api(self._cluster_id) as api,
            ):
                data = await call_json(
                    api, "GET", f"/apis/{group}/{version}", timeout=self._timeout
                )
        except ApiException as exc:
            if exc.status == 404:
                return False
            log.info("Couldn't read whether a cluster serves %s (HTTP %s)", plural, exc.status)
            raise ProbeFailed(timed_out=False, forbidden=exc.status == 403) from None
        except (*KUBE_ERRORS, KeyError, OSError, ValueError, HttpProcessingError) as exc:
            log.info("Couldn't read whether a cluster serves %s (%s)", plural, type(exc).__name__)
            raise ProbeFailed(timed_out=isinstance(exc, TimeoutError)) from None
        return _lists(data, plural)

    async def read(self, path: str) -> dict | None:
        """The object at an API path; None when the cluster says it isn't there (404);
        ProbeFailed when the cluster can't be asked (like `check`)."""
        try:
            async with (
                asyncio.timeout(self._timeout),
                self._connections.api(self._cluster_id) as api,
            ):
                data = await call_json(api, "GET", path, timeout=self._timeout)
        except ApiException as exc:
            if exc.status == 404:
                return None
            log.info("Couldn't read a cluster object for the alerting check (HTTP %s)", exc.status)
            raise ProbeFailed(timed_out=False, forbidden=exc.status == 403) from None
        except (*KUBE_ERRORS, KeyError, OSError, ValueError, HttpProcessingError) as exc:
            log.info(
                "Couldn't read a cluster object for the alerting check (%s)", type(exc).__name__
            )
            raise ProbeFailed(timed_out=isinstance(exc, TimeoutError)) from None
        return data if isinstance(data, dict) else None


class ProbeFailed(Exception):
    """The cluster couldn't be asked what it serves (`KubeClusterProbe.check`): it didn't answer
    (`timed_out` when it took too long), or it refused the login (`forbidden`, HTTP 403)."""

    def __init__(self, *, timed_out: bool, forbidden: bool = False) -> None:
        super().__init__("The cluster couldn't be asked what it serves.")
        self.timed_out = timed_out
        self.forbidden = forbidden


def _lists(data: object, plural: str) -> bool:
    """Whether a `/apis/{group}/{version}` answer lists `plural`."""
    resources = data.get("resources") if isinstance(data, dict) else None
    return isinstance(resources, list) and any(
        isinstance(r, dict) and r.get("name") == plural for r in resources
    )


# --- Discovery ---------------------------------------------------------------------------------


class Discovery:
    def __init__(
        self,
        connections: ClusterConnections,
        registry: ClusterRegistry,
        transports: TransportFactory,
        connectors: ConnectorRegistry,
        sources: SourceStore,
        *,
        probe_seconds: float = PROBE_SECONDS,
        concurrency: int = CONCURRENCY,
    ) -> None:
        self._connections = connections
        self._registry = registry
        self._transports = transports
        self._connectors = connectors
        self._sources = sources
        self._probe_seconds = probe_seconds
        self._concurrency = concurrency

    def probe(self, cluster_id: str) -> KubeClusterProbe:
        """The probe that asks this cluster what it serves."""
        return KubeClusterProbe(self._connections, cluster_id, timeout=self._probe_seconds)

    async def find(self, cluster_id: str) -> DiscoveryResult:
        """What the cluster runs; `UnknownCluster` when OmniKrux doesn't know it."""
        try:
            info = await self._registry.get(cluster_id)
        except KeyError:
            raise UnknownCluster(cluster_id) from None
        try:
            items = await self._list_services(cluster_id)
        except UnknownCluster:
            raise
        except Exception as exc:  # noqa: BLE001 - worded below, by type only for cloud clusters
            return self._result(info, "error", self._list_error(info, exc), ())
        tools = candidates(items)
        limit = asyncio.Semaphore(self._concurrency)

        async def one(candidate: _Candidate) -> FoundTool:
            async with limit:
                return await self._probe(cluster_id, candidate)

        found = list(await asyncio.gather(*(one(c) for c in tools)))
        present = {tool.type for tool in found}
        for missing in REPORTED_MISSING:
            if missing not in present:
                found.append(
                    FoundTool(missing, "missing", None, None, None, "http", None, None, None, None)
                )
        found.sort(key=lambda t: TYPE_ORDER.index(t.type))  # stable: candidates keep their order
        return self._result(info, "ok", None, tuple(found))

    @staticmethod
    def _result(
        info: ClusterInfo,
        state: Literal["ok", "error"],
        message: str | None,
        found: tuple[FoundTool, ...],
    ) -> DiscoveryResult:
        return DiscoveryResult(info.id, info.name, state, message, found, datetime.now(UTC))

    async def _list_services(self, cluster_id: str) -> list:
        try:
            async with (
                asyncio.timeout(LIST_SECONDS),
                self._connections.api(cluster_id) as api,
            ):
                data = await call_json(api, "GET", "/api/v1/services", timeout=LIST_SECONDS)
        except KeyError:  # removed between the lookup and the call
            raise UnknownCluster(cluster_id) from None
        items = data.get("items") if isinstance(data, dict) else None
        if not isinstance(items, list):
            raise ClusterUnavailable(UNEXPECTED_LIST)
        return items

    @staticmethod
    def _list_error(info: ClusterInfo, exc: Exception) -> str:
        if info.source == SOURCE_CLOUD:
            return cloud_kube_error(LIST_ACTION, exc=exc).message
        log.info("Couldn't list a cluster's services (%s)", type(exc).__name__)
        return kube_error_message(exc, LIST_ACTION)

    async def _probe(self, cluster_id: str, c: _Candidate) -> FoundTool:
        target = ClusterTarget(cluster_id, c.namespace, c.service, c.port, c.scheme)
        transport = self._transports.for_source(transient_config(c.service, c.type, target))
        if c.type == "grafana":
            ok, version, message = await self._grafana(transport, c.service)
        else:
            connector = self._connectors.get(c.type)
            result = await run_test(connector, transport, c.service, self._probe_seconds)
            ok, version, message = result.ok, result.version, result.message
        return FoundTool(
            type=c.type,
            state="reachable" if ok else "unreachable",
            namespace=c.namespace,
            service=c.service,
            port=c.port,
            scheme=c.scheme,
            version=version,
            message=message,
            existing_source_id=await self._existing(target, c.port_name),
            detail=None,
        )

    async def _existing(self, target: ClusterTarget, port_name: str | None) -> str | None:
        """A stored source reaching that service port already, by its number or its name."""
        for port in (target.port, port_name):
            if port:
                found = await self._sources.find_cluster_target(
                    ClusterTarget(target.cluster_id, target.namespace, target.service, port, "http")
                )
                if found is not None:
                    return found.id
        return None

    async def _grafana(
        self, transport: SourceTransport, name: str
    ) -> tuple[bool, str | None, str | None]:
        try:  # the transport keeps to the timeout and words its failures (cloud ones too)
            got = await transport.request("GET", "/api/health", timeout=self._probe_seconds)
        except SourceUnreachable as exc:
            return False, None, exc.message
        except Exception as exc:  # noqa: BLE001 - becomes the probe's answer, in words
            log.warning("Could not probe a Grafana (%s)", type(exc).__name__)
            return False, None, PROBE_FAILED.format(name=name)
        if got.status != 200:
            return False, None, status_message(name, got.status)
        data = json_object(got.body)
        if data is None:
            return False, None, NOT_LIKE.format(name=name, what="a Grafana server")
        version = data.get("version")
        return True, version if isinstance(version, str) else None, None
