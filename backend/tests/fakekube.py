"""A tiny Kubernetes API over real HTTP, shared by every test that needs one.

Nothing is mocked inside kubernetes_asyncio: the code under test talks to a real aiohttp server
on 127.0.0.1. Tests seed `pods`, `objects`, `events`, `logs` and `follow_lines` (None ends a
followed stream, CUT breaks it) and read back `requests`.

Discovery (`/api/v1`, `/apis`, `/apis/{group}/{version}`) is generated from `resources`; a group in
`broken_groups` answers 503 there, as an aggregated API whose backend is down does, and one in
`hanging_groups` doesn't answer at all until `release`. Every served
kind can be listed (cluster-wide or in a namespace, with a `labelSelector` and a
`fieldSelector` on `metadata.name` or `spec.nodeName`), read one by one and watched (each object
ADDED, then the watch stays open until `release`). Objects live in `objects[kind_key]`, keyed by
(namespace, name), "" for the namespace of a cluster-scoped object; `pods` is `objects["pods"]` and
`events` is a list of its own.

A service can be reached through the API server's proxy
(`/api/v1/namespaces/{ns}/services/{name:port}/proxy/...`): `service_backends` maps
(namespace, "name:port") or (namespace, "https:name:port") to the base URL of a real local server,
and the request (method, rest of the path, query, body) is relayed to it, its status, body,
content type and any `Location` relayed back (a redirect is passed on, never followed). An unknown service answers 503 "no endpoints available"; with
`proxy_forbidden` set every proxy request answers 403.

Any served object can be replaced (PUT, honouring `metadata.resourceVersion` with a 409 like the
API server, and `dryRun=All`) and patched (`application/merge-patch+json`, or
`application/json-patch+json` with `test` / `add` / `replace` / `remove`; a failed `test` answers
the API server's bare 422). Each write bumps `resourceVersion` (and `generation` when `spec` changed)
and is recorded in `writes`. Any served object can be deleted (recorded in `deletes`), honouring
DeleteOptions `preconditions.uid` (and `resourceVersion`) with the API server's 409.

A pod can be evicted (`POST .../pods/{name}/eviction`, recorded in `eviction_requests`): each
eviction of a pod takes the next status of `evictions[(ns, name)]` (the last one sticks; none:
201). 201 deletes the pod, honouring `deleteOptions.preconditions.uid`; 429 is the API server's
PodDisruptionBudget refusal; 409 its "the object has been modified" conflict. A deleted or
evicted pod in `linger` stays, with a `deletionTimestamp`, until the test removes it (a pod still
terminating).

Exec is served over WebSocket (`v4.channel.k8s.io`) by a tiny echo shell: see `_exec`. Port-forward
is served over WebSocket too, as the kubelet does, with an echo server behind every port: see
`_portforward`.

Creating a pod (recorded in `created`) or adding an ephemeral container (recorded in `patches`)
starts its containers: each read of the pod moves a new container one step through
`start_states`, and the last state sticks. Deleted pods are recorded in `deleted`.
"""

import asyncio
import copy
import json
import re
from collections.abc import Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import aiohttp
import pytest
from aiohttp import web

from omnikrux.kube.client import make_api_client
from omnikrux.kube.source import KubeResourceSource
from omnikrux.resources.kinds import KINDS

TOKEN = "fake-api-token"

# Put CUT on `follow_lines` to break a followed stream's connection mid-stream (a transient error).
CUT = "<cut the connection>"

# Seeded log lines are plain strings; line i is stamped LOG_EPOCH + i seconds, which is what
# `timestamps` prints and `sinceTime` compares against. A line may also be `(seconds, text)`,
# stamped LOG_EPOCH + that many seconds. Followed lines are stamped with "now".
LOG_EPOCH = datetime(2026, 1, 1, tzinfo=UTC)


FORBIDDEN = 'pods is forbidden: User "fake" cannot get resource "pods" in the namespace "demo"'
EVENTS_FORBIDDEN = (
    'events is forbidden: User "fake" cannot list resource "events" in the namespace "demo"'
)


def status_body(code: int, reason: str, message: str) -> dict:
    return {
        "kind": "Status",
        "apiVersion": "v1",
        "status": "Failure",
        "code": code,
        "reason": reason,
        "message": message,
    }


def not_found(message: str = "not found") -> web.Response:
    return web.json_response(status_body(404, "NotFound", message), status=404)


POD = {"metadata": {"name": "web-1", "namespace": "demo", "uid": "u1", "resourceVersion": "41"}}

VERSION = {"major": "1", "minor": "31", "gitVersion": "v1.31.0"}


@dataclass(frozen=True)
class FakeResource:
    group: str
    version: str
    plural: str
    kind: str
    namespaced: bool
    verbs: tuple[str, ...] = ("create", "delete", "get", "list", "patch", "update", "watch")
    short_names: tuple[str, ...] = ()

    @property
    def key(self) -> str:
        return f"{self.plural}.{self.group}" if self.group else self.plural


def default_resources() -> list[FakeResource]:
    """What a small real cluster serves, plus one CRD and a few things discovery must skip."""
    R = FakeResource
    return [
        R("", "v1", "pods", "Pod", True, short_names=("po",)),
        R("", "v1", "pods/log", "Pod", True, ("get",)),
        R("", "v1", "pods/exec", "PodExecOptions", True, ("create", "get")),
        R("", "v1", "bindings", "Binding", True, ("create",)),
        R("", "v1", "nodes", "Node", False, short_names=("no",)),
        R("", "v1", "events", "Event", True, short_names=("ev",)),
        R("", "v1", "namespaces", "Namespace", False, short_names=("ns",)),
        R("", "v1", "services", "Service", True, short_names=("svc",)),
        R("", "v1", "configmaps", "ConfigMap", True, short_names=("cm",)),
        R("", "v1", "secrets", "Secret", True),
        R("", "v1", "persistentvolumeclaims", "PersistentVolumeClaim", True, short_names=("pvc",)),
        R("", "v1", "persistentvolumes", "PersistentVolume", False, short_names=("pv",)),
        R("apps", "v1", "deployments", "Deployment", True, short_names=("deploy",)),
        R("apps", "v1", "deployments/scale", "Scale", True, ("get", "patch", "update")),
        R("apps", "v1", "replicasets", "ReplicaSet", True, short_names=("rs",)),
        R("apps", "v1", "statefulsets", "StatefulSet", True, short_names=("sts",)),
        R("apps", "v1", "daemonsets", "DaemonSet", True, short_names=("ds",)),
        R("batch", "v1", "jobs", "Job", True),
        R("batch", "v1", "cronjobs", "CronJob", True, short_names=("cj",)),
        R("discovery.k8s.io", "v1", "endpointslices", "EndpointSlice", True),
        R("networking.k8s.io", "v1", "ingresses", "Ingress", True, short_names=("ing",)),
        R(
            "autoscaling",
            "v2",
            "horizontalpodautoscalers",
            "HorizontalPodAutoscaler",
            True,
            short_names=("hpa",),
        ),
        R(
            "apiextensions.k8s.io",
            "v1",
            "customresourcedefinitions",
            "CustomResourceDefinition",
            False,
            short_names=("crd", "crds"),
        ),
        R("example.omnikrux.dev", "v1", "widgets", "Widget", True, short_names=("wd",)),
        R(METRICS_GROUP, "v1beta1", "pods", "PodMetrics", True, ("get", "list")),
        R(METRICS_GROUP, "v1beta1", "nodes", "NodeMetrics", False, ("get", "list")),
    ]


METRICS_GROUP = "metrics.k8s.io"
CRDS_KEY = "customresourcedefinitions.apiextensions.k8s.io"
WIDGET_CRD = {
    "apiVersion": "apiextensions.k8s.io/v1",
    "kind": "CustomResourceDefinition",
    "metadata": {"name": "widgets.example.omnikrux.dev", "uid": "u-crd-widgets"},
    "spec": {
        "group": "example.omnikrux.dev",
        "names": {"plural": "widgets", "singular": "widget", "kind": "Widget"},
        "scope": "Namespaced",
        "versions": [
            {
                "name": "v1",
                "served": True,
                "storage": True,
                "additionalPrinterColumns": [
                    {"name": "Size", "type": "integer", "jsonPath": ".spec.size"},
                    {"name": "Age", "type": "date", "jsonPath": ".metadata.creationTimestamp"},
                ],
            }
        ],
    },
}

UNAVAILABLE = "the server is currently unable to handle the request"

POD_ROUTE = re.compile(r"^/api/v1/namespaces/(?P<ns>[^/]+)/pods/(?P<name>[^/]+)(?P<sub>/[a-z]+)?$")
PODS_ROUTE = re.compile(r"^/api/v1/namespaces/(?P<ns>[^/]+)/pods$")
EVENTS_ROUTE = re.compile(r"^/api/v1/namespaces/(?P<ns>[^/]+)/events$")
# /api/v1/... or /apis/{group}/{version}/...: the group, the version and the rest of the path.
SERVICE_PROXY_ROUTE = re.compile(
    r"^/api/v1/namespaces/(?P<ns>[^/]+)/services/(?P<svc>[^/]+)/proxy(?P<rest>/.*)?$"
)
API_PATH = re.compile(
    r"^/(?:api/(?P<core>v1)|apis/(?P<group>[^/]+)/(?P<version>[^/]+))(?P<rest>/.*)?$"
)


METRICS_PREFIX = f"/apis/{METRICS_GROUP}/v1beta1"


def _metric_item(kind: str, namespace: str, name: str, metric: dict) -> dict:
    meta = {"name": name, **({"namespace": namespace} if namespace else {})}
    return {
        "kind": kind,
        "apiVersion": f"{METRICS_GROUP}/v1beta1",
        "metadata": meta,
        "window": "30s",
        **metric,
    }


def _metric_list(kind: str, entries: list[tuple[str, str, dict]]) -> dict:
    return {
        "kind": kind,
        "apiVersion": f"{METRICS_GROUP}/v1beta1",
        "metadata": {},
        "items": [_metric_item(kind[:-4], ns, name, m) for ns, name, m in entries],
    }


def _flag(query, name: str) -> bool:
    """Go's ParseBool via urlencode: kubernetes_asyncio sends Python True as `True`."""
    return query.get(name, "").lower() in ("1", "true")


class PodStore(dict):
    """Objects by (namespace, name); stored copies, so seeding a shared constant is safe."""

    def __setitem__(self, key, value) -> None:
        super().__setitem__(key, copy.deepcopy(value))


class ObjectStore(dict):
    """A `PodStore` per kind key, created on first use."""

    def __missing__(self, key: str) -> PodStore:
        store = self[key] = PodStore()
        return store


def bad_request(message: str) -> web.Response:
    return web.json_response(status_body(400, "BadRequest", message), status=400)


def invalid(message: str) -> web.Response:
    return web.json_response(status_body(422, "Invalid", message), status=422)


STRATEGIC_MERGE = "application/strategic-merge-patch+json"
MERGE_PATCH = "application/merge-patch+json"
JSON_PATCH = "application/json-patch+json"
REJECTED = "the server rejected our request due to an error in our request"
STARTED = {"running": {"startedAt": "2026-11-07T09:00:00Z"}}


def _stamp(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%S.%f000Z")


class FakeKubeApi:
    """A tiny Kubernetes API: `mode` picks how it answers.

    ok: everything works; unauthorized: 401 everywhere; hang: never answers until `release`;
    apis_unexpected: everything works except `/apis`, which answers 200 with an HTML page;
    forbidden: 403 everywhere, with FORBIDDEN as the Status message;
    events_forbidden: listing events answers 403 (EVENTS_FORBIDDEN), everything else works;
    watch_forbidden: a pod watch answers 403; instant_close: a pod watch ends after its event.
    A pod watch in `ok` mode stays open until `release` is set. A kind key in `forbidden_kinds`
    answers 403 to every list, watch and read of that kind.
    """

    def __init__(self) -> None:
        self.mode = "ok"
        self.paths: list[str] = []
        self.requests: list[tuple[str, str, dict]] = []
        self.auth: set[str | None] = set()
        self.token_check: Callable[[str | None], bool] | None = None
        self.release = asyncio.Event()
        self.url = ""
        self.resources: list[FakeResource] = default_resources()
        self.broken_groups: set[str] = set()
        self.hanging_groups: set[str] = set()
        self.forbidden_kinds: set[str] = set()
        self.fail_lists: dict[str, list[int]] = {}
        # metrics-server: ok; missing (the group is not served: absent from discovery, 404);
        # unavailable (the aggregated API answers 503, also in discovery).
        self.metrics_mode = "ok"
        # (namespace, pod) -> {"timestamp", "window", "containers": [{"name", "usage"}]}
        self.pod_metrics: dict[tuple[str, str], dict] = {}
        # node name -> {"timestamp", "window", "usage": {"cpu", "memory"}}
        self.node_metrics: dict[str, dict] = {}
        # Seconds a metrics answer takes (a slow metrics-server).
        self.metrics_delay = 0.0
        # kind key -> (namespace, name) -> object, e.g. objects["deployments.apps"][("demo", "web")]
        self.objects: dict[str, dict[tuple[str, str], dict]] = ObjectStore()
        self.objects[CRDS_KEY][("", WIDGET_CRD["metadata"]["name"])] = WIDGET_CRD
        self.pods: dict[tuple[str, str], dict] = self.objects["pods"]
        self.pods[("demo", "web-1")] = POD
        self.events: list[dict] = []
        self.logs: dict[tuple[str, str, str, bool], list[str | tuple[float, str]]] = {}
        # (ns, pod, container) -> how many more requests for the previous log answer 400, as the
        # kubelet does while a container is being replaced.
        self.previous_refusals: dict[tuple[str, str, str], int] = {}
        self.previous_requests = 0
        self.follow_lines: asyncio.Queue[str | None] = asyncio.Queue()
        self.execs: list[dict] = []
        self.exec_resizes: list[dict] = []
        # A Status the exec sends at once, then ends: a command that couldn't start (no shell).
        self.exec_status: dict | None = None
        # Every port-forward stream: namespace, pod, ports and the protocol asked for.
        self.forwards: list[dict] = []
        # How many port-forward streams are open right now.
        self.forwards_open = 0
        # Text the port-forward's error channel carries at once, ending the stream (what the
        # kubelet sends when nothing listens on the port, say).
        self.forward_fail: str | None = None
        # Instead of echoing, the pod answers the first data with these chunks, `forward_gap`
        # seconds apart, then closes the stream ([]: it never answers, and never closes).
        self.forward_answer: list[bytes] | None = None
        self.forward_gap = 0.0
        self.start_states: list[dict] = [{"waiting": {"reason": "ContainerCreating"}}, STARTED]
        self.created: list[dict] = []
        self.patches: list[dict] = []
        self.deleted: list[tuple[str, str]] = []
        # Every DELETE of one object: its path and DeleteOptions body.
        self.deletes: list[dict] = []
        # (namespace, pod) -> the statuses its evictions answer with, in turn (the last sticks).
        self.evictions: dict[tuple[str, str], list[int]] = {}
        self.eviction_requests: list[dict] = []
        # Pods that stay, terminating, when deleted or evicted, until the test removes them.
        self.linger: set[tuple[str, str]] = set()
        # Set to 403 or 405: DELETE on the pod collection is refused (no deletecollection verb).
        self.refuse_deletecollection: int | None = None
        # Seconds each eviction takes, and the most evictions seen in flight at once.
        self.eviction_delay = 0.0
        self.evictions_in_flight_max = 0
        self._evicting = 0
        # Every PUT and PATCH of an object: method, path, query, content type and body.
        self.writes: list[dict] = []
        # (namespace, "name:port" or "https:name:port") -> base URL the service proxy relays to.
        self.service_backends: dict[tuple[str, str], str] = {}
        # True: every service proxy request answers 403, as when RBAC lacks `services/proxy`.
        self.proxy_forbidden = False
        # (namespace, pod) -> [status field, container, states still to go through]
        self._starting: dict[tuple[str, str], list[tuple[str, str, list[dict]]]] = {}

    async def handle(self, request: web.Request) -> web.StreamResponse:
        self.paths.append(request.path)
        self.requests.append((request.method, request.path, dict(request.query)))
        authorization = request.headers.get("Authorization")
        self.auth.add(authorization)
        if self.token_check is not None and not self.token_check(authorization):
            return web.json_response(status_body(401, "Unauthorized", "Unauthorized"), status=401)
        if self.mode == "hang":
            await self.release.wait()
        if self.mode == "forbidden":
            return web.json_response(status_body(403, "Forbidden", FORBIDDEN), status=403)
        if self.mode == "unauthorized":
            return web.json_response(status_body(401, "Unauthorized", "Unauthorized"), status=401)
        if self.mode == "apis_unexpected" and request.path == "/apis":
            return web.Response(text="<html><body>Sign in</body></html>", content_type="text/html")
        return await self._route(request)

    async def _route(self, request: web.Request) -> web.StreamResponse:
        method, path = request.method, request.path
        if match := SERVICE_PROXY_ROUTE.match(path):
            return await self._proxy(request, match)
        if method == "GET":
            if path == "/version":
                return web.json_response(VERSION)
            if path == "/api":
                return web.json_response({"kind": "APIVersions", "versions": ["v1"]})
            if path == "/apis":
                return web.json_response(self._group_list())
            if match := EVENTS_ROUTE.match(path):
                if self.mode == "events_forbidden":
                    body = status_body(403, "Forbidden", EVENTS_FORBIDDEN)
                    return web.json_response(body, status=403)
                return self._events(request, match["ns"])
        if match := PODS_ROUTE.match(path):
            if method == "POST":
                return await self._create_pod(request, match["ns"])
            if method == "DELETE":
                return self._delete_pods(request, match["ns"])
        if match := POD_ROUTE.match(path):
            key, sub = (match["ns"], match["name"]), match["sub"]
            if method == "GET" and sub == "/log":
                return await self._log(request, key)
            if method == "GET" and sub == "/exec":
                return await self._exec(request, key)
            if method == "GET" and sub == "/portforward":
                return await self._portforward(request, key)
            if method == "PATCH" and sub == "/ephemeralcontainers":
                return await self._patch_ephemeral(request, key)
            if method == "DELETE" and sub is None:
                return await self._delete_pod(request, key)
            if method == "POST" and sub == "/eviction":
                return await self._evict(request, key)
        if method == "GET" and path.startswith(METRICS_PREFIX):
            return await self._metrics(path)
        if method == "GET" and (match := API_PATH.match(path)):
            return await self._get(request, match)
        if method in ("PUT", "PATCH") and (match := API_PATH.match(path)):
            return await self._write(request, match)
        if method == "DELETE" and (match := API_PATH.match(path)):
            return await self._delete(request, match)
        return not_found()

    async def _proxy(self, request: web.Request, match: re.Match) -> web.Response:
        """Relay a service proxy request to its backend, or refuse it like the API server."""
        ns, svc = match["ns"], match["svc"]
        if self.proxy_forbidden:
            message = (
                f'services "{svc}" is forbidden: User "fake" cannot get resource '
                f'"services/proxy" in API group "" in the namespace "{ns}"'
            )
            return web.json_response(status_body(403, "Forbidden", message), status=403)
        backend = self.service_backends.get((ns, svc))
        if backend is None:
            message = f'no endpoints available for service "{svc}"'
            return web.json_response(status_body(503, "ServiceUnavailable", message), status=503)
        url = backend.rstrip("/") + (match["rest"] or "/")
        headers = {
            name: value
            for name, value in request.headers.items()
            if name.lower() in ("content-type", "accept", "x-scope-orgid")
        }
        async with (
            aiohttp.ClientSession() as session,
            session.request(
                request.method,
                url,
                params=list(request.query.items()),
                data=await request.read() or None,
                headers=headers,
                ssl=False,
                allow_redirects=False,  # like the API server: a redirect is relayed, not followed
            ) as upstream,
        ):
            relayed = {"Content-Type": upstream.headers.get("Content-Type", "text/plain")}
            if "Location" in upstream.headers:
                relayed["Location"] = upstream.headers["Location"]
            return web.Response(body=await upstream.read(), status=upstream.status, headers=relayed)

    async def _metrics(self, path: str) -> web.Response:
        """The metrics.k8s.io API: discovery, lists and single reads, per `metrics_mode`."""
        if self.metrics_mode == "missing":
            return not_found("the server could not find the requested resource")
        if self.metrics_mode == "unavailable":
            return web.json_response(
                status_body(503, "ServiceUnavailable", UNAVAILABLE), status=503
            )
        if self.metrics_delay:
            await asyncio.sleep(self.metrics_delay)
        parts = [p for p in path[len(METRICS_PREFIX) :].split("/") if p]
        if not parts:
            return self._resource_list(METRICS_GROUP, "v1beta1")
        if parts[0] == "nodes":
            if len(parts) == 1:
                return web.json_response(
                    _metric_list(
                        "NodeMetricsList", [("", n, m) for n, m in self.node_metrics.items()]
                    )
                )
            node = self.node_metrics.get(parts[1])
            if node is None:
                return not_found(f'nodemetrics.metrics.k8s.io "{parts[1]}" not found')
            return web.json_response(_metric_item("NodeMetrics", "", parts[1], node))
        ns = None
        if parts[0] == "namespaces" and len(parts) >= 3:
            ns, parts = parts[1], parts[2:]
        if parts[0] != "pods":
            return not_found()
        if len(parts) == 1:
            items = [(n, name, m) for (n, name), m in self.pod_metrics.items() if ns in (None, n)]
            return web.json_response(_metric_list("PodMetricsList", items))
        pod = self.pod_metrics.get((ns or "", parts[1]))
        if pod is None:
            return not_found(f'podmetrics.metrics.k8s.io "{parts[1]}" not found')
        return web.json_response(_metric_item("PodMetrics", ns or "", parts[1], pod))

    # --- discovery and generic reads ----------------------------------------------------

    def _group_list(self) -> dict:
        versions: dict[str, list[str]] = {}
        for res in self.resources:
            if res.group == METRICS_GROUP and self.metrics_mode == "missing":
                continue
            if res.group and res.version not in versions.setdefault(res.group, []):
                versions[res.group].append(res.version)
        return {
            "kind": "APIGroupList",
            "apiVersion": "v1",
            "groups": [
                {
                    "name": group,
                    "versions": [{"groupVersion": f"{group}/{v}", "version": v} for v in vs],
                    "preferredVersion": {"groupVersion": f"{group}/{vs[0]}", "version": vs[0]},
                }
                for group, vs in versions.items()
            ],
        }

    def _resource_list(self, group: str, version: str) -> web.Response:
        served = [r for r in self.resources if (r.group, r.version) == (group, version)]
        if not served:
            return not_found()
        return web.json_response(
            {
                "kind": "APIResourceList",
                "apiVersion": "v1",
                "groupVersion": f"{group}/{version}" if group else version,
                "resources": [
                    {
                        "name": r.plural,
                        "singularName": "",
                        "namespaced": r.namespaced,
                        "kind": r.kind,
                        "verbs": list(r.verbs),
                        **({"shortNames": list(r.short_names)} if r.short_names else {}),
                    }
                    for r in served
                ],
            }
        )

    async def _get(self, request: web.Request, match: re.Match) -> web.StreamResponse:
        """Discovery, then list, watch or read any served kind."""
        group, version = match["group"] or "", match["core"] or match["version"]
        if group in self.hanging_groups:
            await self.release.wait()
        if group in self.broken_groups:
            return web.json_response(
                status_body(503, "ServiceUnavailable", UNAVAILABLE), status=503
            )
        parts = [part for part in (match["rest"] or "").split("/") if part]
        if not parts:
            return self._resource_list(group, version)
        found = self._resolve(group, version, parts)
        if found is None:
            return not_found()
        res, ns, parts = found
        if res.key in self.forbidden_kinds:
            message = f'{res.plural} is forbidden: User "fake" cannot list resource "{res.plural}"'
            return web.json_response(status_body(403, "Forbidden", message), status=403)
        if len(parts) == 2:
            key = (ns or "", parts[1])
            if res.key == "pods":
                return self._pod_or_404(key)
            obj = dict(self._items(res.key)).get(key)
            if obj is None:
                return not_found(f'{res.plural} "{parts[1]}" not found')
            return web.json_response(obj)
        if _flag(request.query, "watch"):
            if res.key == "pods" and ns is None:
                return await self._watch(request)  # the pod watch keeps its modes
            return await self._watch_any(request, res, ns)
        if failures := self.fail_lists.get(request.path):
            status = failures.pop(0)
            return web.json_response(
                status_body(status, "InternalError", f"listing {res.plural} failed"), status=status
            )
        selected = self._selected(request, res.key, ns)
        if isinstance(selected, web.Response):
            return selected
        return web.json_response(
            {
                "kind": f"{res.kind}List",
                "apiVersion": f"{group}/{version}" if group else version,
                "metadata": {"resourceVersion": "42"},
                "items": [obj for _, obj in selected],
            }
        )

    def _resolve(
        self, group: str, version: str, parts: list[str]
    ) -> tuple[FakeResource, str | None, list[str]] | None:
        """The served resource a path names, its namespace, and the path from the plural on."""
        ns = None
        if len(parts) >= 3 and parts[0] == "namespaces":
            ns, parts = parts[1], parts[2:]
        res = next(
            (
                r
                for r in self.resources
                if (r.group, r.version, r.plural) == (group, version, parts[0])
            ),
            None,
        )
        if res is None or len(parts) > 2 or (ns is not None and not res.namespaced):
            return None
        return res, ns, parts

    # --- writes -------------------------------------------------------------------------

    async def _write(self, request: web.Request, match: re.Match) -> web.Response:
        """PUT or PATCH one served object."""
        group, version = match["group"] or "", match["core"] or match["version"]
        parts = [part for part in (match["rest"] or "").split("/") if part]
        found = self._resolve(group, version, parts) if parts else None
        if found is None or len(found[2]) != 2:
            return not_found()
        res, ns, parts = found
        key = (ns or "", parts[1])
        body = await request.json()
        self.writes.append(
            {
                "method": request.method,
                "path": request.path,
                "query": dict(request.query),
                "content_type": request.content_type,
                "body": copy.deepcopy(body),
            }
        )
        live = self.objects[res.key].get(key)
        if live is None:
            return not_found(f'{res.plural} "{parts[1]}" not found')
        name = f"{res.plural}.{res.group}" if res.group else res.plural
        if request.method == "PUT":
            changed = _replaced(live, body, key, name)
        elif request.content_type == JSON_PATCH:
            changed = _json_patched(live, body)
        elif request.content_type == MERGE_PATCH:
            changed = _merged(live, body, key, name)
        else:
            message = f"the fake only accepts {MERGE_PATCH} or {JSON_PATCH} here"
            return web.json_response(status_body(415, "UnsupportedMediaType", message), status=415)
        if isinstance(changed, web.Response):
            return changed
        md = changed.setdefault("metadata", {})
        md["resourceVersion"] = (live.get("metadata") or {}).get("resourceVersion")
        if request.query.get("dryRun") != "All":
            md["resourceVersion"] = str(int(md["resourceVersion"] or 0) + 1)
            if changed.get("spec") != live.get("spec") and "generation" in md:
                md["generation"] += 1
            self.objects[res.key][key] = changed
        return web.json_response(changed)

    def _items(self, kind_key: str) -> list[tuple[tuple[str, str], dict]]:
        if kind_key == "events":
            items = []
            for event in self.events:
                md = event.get("metadata") or {}
                items.append(((md.get("namespace") or "", md.get("name") or ""), event))
            return items
        return list(self.objects[kind_key].items())

    async def _watch_any(
        self, request: web.Request, res: FakeResource, ns: str | None
    ) -> web.StreamResponse:
        selected = self._selected(request, res.key, ns)
        if isinstance(selected, web.Response):
            return selected
        response = web.StreamResponse(headers={"Content-Type": "application/json"})
        response.enable_chunked_encoding()
        await response.prepare(request)
        for _, obj in selected:
            await response.write(json.dumps({"type": "ADDED", "object": obj}).encode() + b"\n")
        if self.mode != "instant_close":
            await self.release.wait()
        await response.write_eof()
        return response

    def _pod_or_404(self, key: tuple[str, str]) -> web.Response:
        pod = self.pods.get(key)
        if pod is None:
            return not_found(f'pods "{key[1]}" not found')
        self._advance(key, pod)
        return web.json_response(pod)

    def _start(self, key: tuple[str, str], field: str, container: str) -> None:
        self._starting.setdefault(key, []).append((field, container, list(self.start_states)))

    def _advance(self, key: tuple[str, str], pod: dict) -> None:
        """One step of each starting container's `start_states`; the last one sticks."""
        status = pod.setdefault("status", {})
        for field, container, states in self._starting.get(key, []):
            state = states.pop(0) if len(states) > 1 else states[0]
            entries = [e for e in status.get(field) or [] if e.get("name") != container]
            status[field] = [*entries, {"name": container, "state": state}]
            if field == "containerStatuses" and "running" in state:
                status["phase"] = "Running"

    def _selected(
        self, request: web.Request, kind_key: str, ns: str | None
    ) -> list[tuple[tuple[str, str], dict]] | web.Response:
        """Objects of `kind_key` in `ns` (None: every namespace) matching a `labelSelector`
        (`k=v`, `k!=v`, `k in (a,b)`, `k notin (a,b)`, `k`, `!k`; see `_label_matches`) and a
        `fieldSelector` on `metadata.name`,
        `metadata.namespace`, `spec.nodeName` or (events) `involvedObject.uid`; a 400 for any
        other field."""

        def terms(name: str) -> list[list[str]]:
            return [t.partition("=")[::2] for t in request.query.get(name, "").split(",") if t]

        def field(key: tuple[str, str], obj: dict, name: str) -> str | None:
            if name == "metadata.name":
                return key[1]
            if name == "metadata.namespace":
                return key[0]
            if name == "involvedObject.uid":
                return (obj.get("involvedObject") or {}).get("uid")
            return (obj.get("spec") or {}).get("nodeName")

        labels = _label_terms(request.query.get("labelSelector", ""))
        fields = terms("fieldSelector")
        supported = ("metadata.name", "metadata.namespace", "spec.nodeName", "involvedObject.uid")
        for name, _ in fields:
            if name not in supported:
                return bad_request(f'field label not supported: "{name}"')
        return [
            (key, obj)
            for key, obj in self._items(kind_key)
            if (ns is None or key[0] == ns)
            and all(_label_matches(t, obj.get("metadata", {}).get("labels") or {}) for t in labels)
            and all(field(key, obj, k) == v for k, v in fields)
        ]

    def _delete_pods(self, request: web.Request, ns: str) -> web.Response:
        """DELETE on the collection: every selected pod; none selected is fine (an empty list); refused
        with `refuse_deletecollection` (403 or 405)."""
        if self.refuse_deletecollection is not None:
            code = self.refuse_deletecollection
            reason = "Forbidden" if code == 403 else "MethodNotAllowed"
            message = (
                f'pods is forbidden: cannot deletecollection resource "pods" in namespace "{ns}"'
            )
            return web.json_response(status_body(code, reason, message), status=code)
        selected = self._selected(request, "pods", ns)
        if isinstance(selected, web.Response):
            return selected
        items = []
        for key, pod in selected:
            self.pods.pop(key)
            self._starting.pop(key, None)
            self.deleted.append(key)
            items.append(pod)
        return web.json_response(
            {"kind": "PodList", "apiVersion": "v1", "metadata": {}, "items": items}
        )

    def _events(self, request: web.Request, ns: str) -> web.Response:
        items = [e for e in self.events if e.get("metadata", {}).get("namespace", ns) == ns]
        for term in request.query.get("fieldSelector", "").split(","):
            field, eq, value = term.partition("=")
            if eq and field == "involvedObject.uid":
                items = [e for e in items if e.get("involvedObject", {}).get("uid") == value]
        return web.json_response(
            {
                "kind": "EventList",
                "apiVersion": "v1",
                "metadata": {"resourceVersion": "42"},
                "items": items,
            }
        )

    async def _create_pod(self, request: web.Request, ns: str) -> web.Response:
        pod = await request.json()
        self.created.append(copy.deepcopy(pod))
        name = pod.get("metadata", {}).get("name", "")
        pod.setdefault("metadata", {})["namespace"] = ns
        pod["status"] = {"phase": "Pending"}
        self.pods[(ns, name)] = pod
        for container in pod.get("spec", {}).get("containers", []):
            self._start((ns, name), "containerStatuses", container.get("name", ""))
        return web.json_response(pod, status=201)

    async def _patch_ephemeral(self, request: web.Request, key: tuple[str, str]) -> web.Response:
        """Strategic merge only: a JSON merge patch would replace the whole list (and the real
        API server refuses to remove an ephemeral container)."""
        if request.content_type != STRATEGIC_MERGE:
            message = f"the fake only accepts {STRATEGIC_MERGE}, got {request.content_type}"
            return web.json_response(status_body(415, "UnsupportedMediaType", message), status=415)
        pod = self.pods.get(key)
        if pod is None:
            return not_found(f'pods "{key[1]}" not found')
        patch = await request.json()
        self.patches.append(patch)
        added = patch.get("spec", {}).get("ephemeralContainers", [])
        spec = pod.setdefault("spec", {})
        existing = {c.get("name") for c in spec.get("ephemeralContainers", [])}
        regular = {c.get("name") for c in spec.get("containers", [])}
        for container in added:
            if container.get("name") in existing:
                return invalid(f'Pod "{key[1]}" is invalid: ephemeral containers may not change')
            target = container.get("targetContainerName")
            if target is not None and target not in regular:
                return invalid(
                    f'Pod "{key[1]}" is invalid: spec.ephemeralContainers[0].'
                    f'targetContainerName: Not found: "{target}"'
                )
        spec["ephemeralContainers"] = [*spec.get("ephemeralContainers", []), *added]
        for container in added:
            self._start(key, "ephemeralContainerStatuses", container["name"])
        return web.json_response(pod)

    async def _delete_pod(self, request: web.Request, key: tuple[str, str]) -> web.Response:
        options = await _body(request)
        self.deletes.append({"path": request.path, "body": copy.deepcopy(options)})
        pod = self.pods.get(key)
        if pod is None:
            return not_found(f'pods "{key[1]}" not found')
        if (refused := _precondition_failed(pod, options, "pods", key[1])) is not None:
            return refused
        return web.json_response(self._remove_pod(key))

    def _remove_pod(self, key: tuple[str, str]) -> dict:
        """Delete a pod; one in `linger` stays, terminating, until the test removes it."""
        self.deleted.append(key)
        self._starting.pop(key, None)
        if key in self.linger:
            pod = self.pods[key]
            pod.setdefault("metadata", {})["deletionTimestamp"] = "2026-11-07T09:00:00Z"
            return pod
        return self.pods.pop(key)

    async def _delete(self, request: web.Request, match: re.Match) -> web.Response:
        """DELETE one served object, honouring DeleteOptions preconditions."""
        group, version = match["group"] or "", match["core"] or match["version"]
        parts = [part for part in (match["rest"] or "").split("/") if part]
        found = self._resolve(group, version, parts) if parts else None
        if found is None or len(found[2]) != 2:
            return not_found()
        res, ns, parts = found
        key = (ns or "", parts[1])
        options = await _body(request)
        self.deletes.append({"path": request.path, "body": copy.deepcopy(options)})
        live = self.objects[res.key].get(key)
        if live is None:
            return not_found(f'{res.plural} "{parts[1]}" not found')
        name = f"{res.plural}.{res.group}" if res.group else res.plural
        if (refused := _precondition_failed(live, options, name, key[1])) is not None:
            return refused
        return web.json_response(self.objects[res.key].pop(key))

    async def _evict(self, request: web.Request, key: tuple[str, str]) -> web.Response:
        """A policy/v1 Eviction: the pod's next scripted status (201 when none is scripted)."""
        body = await _body(request)
        self.eviction_requests.append({"pod": key, "body": copy.deepcopy(body)})
        self._evicting += 1
        self.evictions_in_flight_max = max(self.evictions_in_flight_max, self._evicting)
        try:
            await asyncio.sleep(self.eviction_delay)
        finally:
            self._evicting -= 1
        pod = self.pods.get(key)
        if pod is None:
            return not_found(f'pods "{key[1]}" not found')
        options = body.get("deleteOptions") if isinstance(body, dict) else None
        if (refused := _precondition_failed(pod, options, "pods", key[1])) is not None:
            return refused
        script = self.evictions.get(key) or [201]
        status = script.pop(0) if len(script) > 1 else script[0]
        if status == 429:
            return web.json_response(_pdb_refusal(key[1]), status=429)
        if status == 409:  # the API server's own write conflict, not a precondition
            return _conflict("pods", key[1])
        if status != 201:
            failure = status_body(status, "InternalError", f"eviction of {key[1]} failed")
            return web.json_response(failure, status=status)
        self._remove_pod(key)
        success = {"kind": "Status", "apiVersion": "v1", "status": "Success", "code": 201}
        return web.json_response(success, status=201)

    async def _log(self, request: web.Request, key: tuple[str, str]) -> web.StreamResponse:
        accept = request.headers.get("Accept", "*/*")
        if not any(t in accept for t in ("*/*", "application/json", "application/yaml")):
            # The real API negotiates against its serializers: "text/plain" alone is refused.
            message = (
                "the server was unable to respond with a content type that the client supports"
            )
            return web.json_response(status_body(406, "NotAcceptable", message), status=406)
        pod = self.pods.get(key)
        if pod is None:
            return not_found(f'pods "{key[1]}" not found')
        query = request.query
        spec = pod.get("spec", {})
        names = [c["name"] for c in spec.get("containers", [])]
        valid = [
            c["name"]
            for field in ("initContainers", "containers", "ephemeralContainers")
            for c in spec.get(field, [])
        ]
        container = query.get("container", "")
        if not container:
            if len(names) != 1:
                return bad_request(
                    f"a container name must be specified for pod {key[1]}, "
                    f"choose one of: [{' '.join(valid)}]"
                )
            container = names[0]
        elif container not in valid:
            return bad_request(f"container {container} is not valid for pod {key[1]}")
        previous = _flag(query, "previous")
        stamped = _flag(query, "timestamps")

        def render(moment: datetime, line: str) -> bytes:
            return f"{_stamp(moment) + ' ' if stamped else ''}{line}\n".encode()

        seeded = self.logs.get((key[0], key[1], container, previous))
        if previous:
            self.previous_requests += 1
            refusals = (key[0], key[1], container)
            if self.previous_refusals.get(refusals, 0) > 0:
                self.previous_refusals[refusals] -= 1
                return bad_request(
                    f'container "{container}" in pod "{key[1]}" is waiting to start: '
                    "ContainerCreating"
                )
        if seeded is None and previous:
            return bad_request(
                f'previous terminated container "{container}" in pod "{key[1]}" not found'
            )
        headers = {"Content-Type": "text/plain"}
        if _flag(query, "follow"):
            response = web.StreamResponse(headers=headers)
            response.enable_chunked_encoding()
            await response.prepare(request)
            while (line := await self.follow_lines.get()) is not None:
                if line == CUT:  # the connection breaks mid-stream (no final chunk)
                    request.transport.abort()
                    return response
                await response.write(render(datetime.now(UTC), line))
            await response.write_eof()
            return response

        moments = [
            (LOG_EPOCH + timedelta(seconds=item[0]), item[1])
            if isinstance(item, tuple)
            else (LOG_EPOCH + timedelta(seconds=i), item)
            for i, item in enumerate(seeded or [])
        ]
        if since := query.get("sinceTime"):
            cutoff = datetime.fromisoformat(since)
            if cutoff.tzinfo is None:
                cutoff = cutoff.replace(tzinfo=UTC)
            moments = [(m, line) for m, line in moments if m >= cutoff]
        if tail := query.get("tailLines"):
            moments = moments[-int(tail) :] if int(tail) else []
        return web.Response(body=b"".join(render(m, line) for m, line in moments), headers=headers)

    async def _exec(self, request: web.Request, key: tuple[str, str]) -> web.StreamResponse:
        """An echo shell: stdin comes back on stdout; "exit N" ends it with exit code N. Each call
        is recorded in `execs`, each resize in `exec_resizes`. With `exec_status` set, the command
        "couldn't start": that Status is sent at once and the stream ends."""
        if key not in self.pods:
            return not_found(f'pods "{key[1]}" not found')
        query = request.query
        self.execs.append(
            {
                "command": query.getall("command", []),
                "container": query.get("container"),
                "flags": {f: _flag(query, f) for f in ("stdin", "stdout", "stderr", "tty")},
                "protocol": request.headers.get("Sec-WebSocket-Protocol"),
            }
        )
        ws = web.WebSocketResponse(protocols=("v4.channel.k8s.io",))
        await ws.prepare(request)
        for channel in (1, 2, 3):  # the API server opens each stream with an empty frame
            await ws.send_bytes(bytes([channel]))
        if self.exec_status is not None:
            await ws.send_bytes(bytes([3]) + json.dumps(self.exec_status).encode())
            await ws.close()
            return ws
        async for msg in ws:
            channel, data = msg.data[0], msg.data[1:]
            if channel == 4:
                self.exec_resizes.append(json.loads(data))
            elif data.startswith(b"exit "):
                code = int(data.split()[1])
                status = {"metadata": {}, "status": "Success"}
                if code:
                    status = status_body(500, "NonZeroExitCode", f"exit status {code}")
                    status["details"] = {"causes": [{"reason": "ExitCode", "message": str(code)}]}
                await ws.send_bytes(bytes([3]) + json.dumps(status).encode())
                await ws.close()
            else:
                await ws.send_bytes(bytes([1]) + data)
        return ws

    async def _portforward(self, request: web.Request, key: tuple[str, str]) -> web.StreamResponse:
        """Port-forward over WebSocket, framed as the kubelet does: port i gets a data channel
        (2i) and an error channel (2i+1), and each opens with the port number (2 bytes, little
        endian). What arrives on a data channel comes back on it (an echo server in the pod), or
        `forward_answer` is sent once (slowly, see `forward_gap`). With `forward_fail` set, the
        error channel carries that text and the stream ends. Each stream is recorded in
        `forwards`; `forwards_open` counts the ones still open."""
        if key not in self.pods:
            return not_found(f'pods "{key[1]}" not found')
        ports = [int(p) for value in request.query.getall("ports", []) for p in value.split(",")]
        self.forwards.append(
            {
                "namespace": key[0],
                "pod": key[1],
                "ports": ports,
                "protocol": request.headers.get("Sec-WebSocket-Protocol"),
            }
        )
        ws = web.WebSocketResponse(protocols=("v4.channel.k8s.io", "portforward.k8s.io"))
        await ws.prepare(request)
        self.forwards_open += 1
        try:
            for i, port in enumerate(ports):
                prefix = port.to_bytes(2, "little")
                await ws.send_bytes(bytes([2 * i]) + prefix)
                await ws.send_bytes(bytes([2 * i + 1]) + prefix)
            if self.forward_fail is not None:
                await ws.send_bytes(bytes([1]) + self.forward_fail.encode())
                await ws.close()
                return ws
            async for msg in ws:
                if msg.type != web.WSMsgType.BINARY or not msg.data:
                    continue
                channel, data = msg.data[0], msg.data[1:]
                if channel % 2 or not data:
                    continue
                if self.forward_answer is None:
                    await ws.send_bytes(bytes([channel]) + data)
                elif self.forward_answer:
                    for chunk in self.forward_answer:
                        await asyncio.sleep(self.forward_gap)
                        await ws.send_bytes(bytes([channel]) + chunk)
                    await ws.close()
            return ws
        finally:
            self.forwards_open -= 1

    async def _watch(self, request: web.Request) -> web.StreamResponse:
        if self.mode == "watch_forbidden":
            return web.json_response(status_body(403, "Forbidden", "forbidden"), status=403)
        response = web.StreamResponse(headers={"Content-Type": "application/json"})
        response.enable_chunked_encoding()
        await response.prepare(request)
        pod = next(iter(self.pods.values()), POD)
        await response.write(json.dumps({"type": "ADDED", "object": pod}).encode() + b"\n")
        if self.mode != "instant_close":
            await self.release.wait()
        await response.write_eof()
        return response


_SET_TERM = re.compile(r"^(?P<key>\S+)\s+(?P<op>in|notin)\s+\((?P<values>[^)]*)\)$")


def _label_terms(text: str) -> list[str]:
    """A label selector's terms: split at the commas outside `(...)`."""
    terms, depth, start = [], 0, 0
    for i, char in enumerate(text):
        depth += {"(": 1, ")": -1}.get(char, 0)
        if char == "," and depth == 0:
            terms.append(text[start:i])
            start = i + 1
    terms.append(text[start:])
    return [t.strip() for t in terms if t.strip()]


def _label_matches(term: str, labels: dict) -> bool:
    """One label selector term, as the API server reads it."""
    if match := _SET_TERM.match(term):
        values = {v.strip() for v in match["values"].split(",")}
        key = match["key"]
        if match["op"] == "in":
            return key in labels and labels[key] in values
        return key not in labels or labels[key] not in values
    if term.startswith("!"):
        return term[1:] not in labels
    if "!=" in term:
        key, value = term.split("!=", 1)
        return labels.get(key) != value
    if "=" in term:
        key, value = term.split("=", 1)
        return labels.get(key) == value.removeprefix("=")
    return term in labels


async def _body(request: web.Request) -> dict:
    """A request's JSON body; {} when it has none."""
    raw = await request.read()
    return json.loads(raw) if raw else {}


PDB_REFUSAL = "Cannot evict pod as it would violate the pod's disruption budget."


def _pdb_refusal(pod: str) -> dict:
    """How the API server refuses an eviction a PodDisruptionBudget doesn't allow (a 429)."""
    body = status_body(429, "TooManyRequests", PDB_REFUSAL)
    message = f"The disruption budget for {pod} needs 1 healthy pods and has 1 currently"
    body["details"] = {"causes": [{"reason": "DisruptionBudget", "message": message}]}
    return body


def _precondition_failed(
    live: dict, options: dict | None, name: str, object_name: str
) -> web.Response | None:
    """The API server's 409 for DeleteOptions preconditions the live object doesn't meet."""
    wanted = (options or {}).get("preconditions") or {}
    md = live.get("metadata") or {}
    for field, label in (("uid", "UID"), ("resourceVersion", "ResourceVersion")):
        if wanted.get(field) is not None and wanted[field] != md.get(field):
            message = (
                f'Operation cannot be fulfilled on {name} "{object_name}": Precondition failed: '
                f"{label} in precondition: {wanted[field]}, {label} in object meta: "
                f"{md.get(field)}"
            )
            return web.json_response(status_body(409, "Conflict", message), status=409)
    return None


def _conflict(name: str, object_name: str) -> web.Response:
    message = (
        f'Operation cannot be fulfilled on {name} "{object_name}": the object has been modified; '
        "please apply your changes to the latest version and try again"
    )
    return web.json_response(status_body(409, "Conflict", message), status=409)


def _replaced(live: dict, body: dict, key: tuple[str, str], name: str) -> dict | web.Response:
    """A PUT: the body, with what the server owns (uid, creation time, status) kept, refused with
    a 409 when its `resourceVersion` isn't the live one."""
    md = body.get("metadata") or {}
    live_md = live.get("metadata") or {}
    if md.get("name") != key[1]:
        return bad_request(
            f"the name of the object ({md.get('name')}) does not match the name on the URL "
            f"({key[1]})"
        )
    if (md.get("namespace") or "") not in ("", key[0]):
        return bad_request(
            "the namespace of the provided object does not match the namespace sent on the request"
        )
    if (rv := md.get("resourceVersion")) is not None and rv != live_md.get("resourceVersion"):
        return _conflict(name, key[1])
    changed = copy.deepcopy(body)
    out_md = changed.setdefault("metadata", {})
    for field in ("uid", "creationTimestamp", "generation"):
        if field in live_md:
            out_md[field] = live_md[field]
    if key[0]:
        out_md["namespace"] = key[0]
    changed.pop("status", None)
    if "status" in live:
        changed["status"] = copy.deepcopy(live["status"])
    return changed


def _merged(live: dict, patch: dict, key: tuple[str, str], name: str) -> dict | web.Response:
    """A JSON merge patch (RFC 7386); `metadata.resourceVersion` in it is a precondition."""
    rv = (patch.get("metadata") or {}).get("resourceVersion")
    if rv is not None and rv != (live.get("metadata") or {}).get("resourceVersion"):
        return _conflict(name, key[1])
    return _merge(live, patch)


def _merge(target: object, patch: object) -> object:
    if not isinstance(patch, dict):
        return copy.deepcopy(patch)
    out = copy.deepcopy(target) if isinstance(target, dict) else {}
    for key, value in patch.items():
        if value is None:
            out.pop(key, None)
        else:
            out[key] = _merge(out.get(key), value)
    return out


_MISSING = object()


def _parent(doc: object, path: str) -> tuple[object, str]:
    """The container holding a JSON pointer's last token, and that token; KeyError if missing."""
    tokens = [t.replace("~1", "/").replace("~0", "~") for t in path.split("/")[1:]]
    node = doc
    for token in tokens[:-1]:
        if isinstance(node, dict) and token in node:
            node = node[token]
        elif isinstance(node, list) and token.isdigit() and int(token) < len(node):
            node = node[int(token)]
        else:
            raise KeyError(path)
    return node, tokens[-1]


def _value_at(doc: object, path: str) -> object:
    try:
        node, token = _parent(doc, path)
    except KeyError:
        return _MISSING
    if isinstance(node, dict):
        return node.get(token, _MISSING)
    if isinstance(node, list) and token.isdigit() and int(token) < len(node):
        return node[int(token)]
    return _MISSING


def _patch_failed(message: str) -> web.Response:
    """How a real API server (checked on kind, Kubernetes 1.37) answers a JSON patch it can't
    apply, a failed `test` included: a bare 422, the reason (`message`) nowhere in the body."""
    body = status_body(422, "Invalid", REJECTED)
    body["details"] = {}
    return web.json_response(body, status=422)


def _json_patched(live: dict, ops: list[dict]) -> dict | web.Response:
    """RFC 6902 `test`, `add`, `replace` and `remove`, all or nothing."""
    doc = copy.deepcopy(live)
    for op in ops:
        kind, path, value = op.get("op"), op.get("path", ""), copy.deepcopy(op.get("value"))
        if kind == "test":
            if _value_at(doc, path) != value:
                return _patch_failed(f"testing value {path} failed: test failed")
            continue
        try:
            node, token = _parent(doc, path)
        except KeyError:
            return _patch_failed(f"{kind} operation does not apply: doc is missing path: {path}")
        if kind == "add" and isinstance(node, dict):
            node[token] = value
        elif kind == "add" and isinstance(node, list):
            node.insert(len(node) if token == "-" else int(token), value)
        elif kind in ("replace", "remove") and _value_at(doc, path) is not _MISSING:
            index = token if isinstance(node, dict) else int(token)
            if kind == "remove":
                del node[index]
            else:
                node[index] = value
        else:
            return _patch_failed(f"{kind} operation does not apply: doc is missing key: {path}")
    return doc


@asynccontextmanager
async def serve_fake_api():
    """A `FakeKubeApi` served on 127.0.0.1 for the duration of the block."""
    server = FakeKubeApi()
    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", server.handle)
    runner = web.AppRunner(app, shutdown_timeout=1)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    server.url = f"http://127.0.0.1:{port}"
    try:
        yield server
    finally:
        server.release.set()
        await runner.cleanup()


def service(
    namespace: str,
    name: str,
    *,
    labels: dict[str, str] | None = None,
    ports: list[dict],
    cluster_ip: str = "10.96.0.10",
    selector: dict[str, str] | None = None,
) -> dict:
    """A Service object as the API serves it, for `objects["services"][(namespace, name)]`."""
    spec: dict = {"ports": ports, "clusterIP": cluster_ip}
    if selector is not None:
        spec["selector"] = selector
    return {
        "metadata": {
            "name": name,
            "namespace": namespace,
            "uid": f"u-svc-{namespace}-{name}",
            "labels": dict(labels or {}),
        },
        "spec": spec,
    }


@pytest.fixture
async def fake_api():
    async with serve_fake_api() as server:
        yield server


def kubeconfig_for(server: FakeKubeApi) -> dict:
    return {
        "apiVersion": "v1",
        "kind": "Config",
        "current-context": "fake",
        "clusters": [{"name": "fake", "cluster": {"server": server.url}}],
        "users": [{"name": "fake", "user": {"token": TOKEN}}],
        "contexts": [{"name": "fake", "context": {"cluster": "fake", "user": "fake"}}],
    }


async def source_for(server: FakeKubeApi, **kwargs) -> KubeResourceSource:
    return KubeResourceSource(
        await make_api_client(kubeconfig_for(server)), KINDS["pods"], **kwargs
    )
