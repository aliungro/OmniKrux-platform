"""A tiny Kubernetes API over real HTTP, shared by every test that needs one.

Nothing is mocked inside kubernetes_asyncio: the code under test talks to a real aiohttp server
on 127.0.0.1. Tests seed `pods`, `events`, `workloads`, `logs` and `follow_lines` (None ends a
followed stream, CUT breaks it) and read back `requests`.

Exec is served over WebSocket (`v4.channel.k8s.io`) by a tiny echo shell: see `_exec`.

Creating a pod (recorded in `created`) or adding an ephemeral container (recorded in `patches`)
starts its containers: each read of the pod moves a new container one step through
`start_states`, and the last state sticks. Deleted pods are recorded in `deleted`.
"""

import asyncio
import copy
import json
import re
import tempfile
from datetime import UTC, datetime, timedelta

import pytest
from aiohttp import web

from omnikrux.kube.client import make_api_client
from omnikrux.kube.source import KubeResourceSource
from omnikrux.resources.kinds import KINDS

TOKEN = "fake-api-token"

# Put CUT on `follow_lines` to break a followed stream's connection mid-stream (a transient error).
CUT = "<cut the connection>"

# Seeded log lines are plain strings; line i is stamped LOG_EPOCH + i seconds, which is what
# `timestamps` prints and `sinceTime` compares against. Followed lines are stamped with "now".
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

ROUTES = {
    "/version": {"major": "1", "minor": "31", "gitVersion": "v1.31.0"},
    "/api": {"kind": "APIVersions", "versions": ["v1"]},
    "/apis": {"kind": "APIGroupList", "apiVersion": "v1", "groups": []},
    "/api/v1": {
        "kind": "APIResourceList",
        "groupVersion": "v1",
        "resources": [
            {
                "name": "pods",
                "singularName": "pod",
                "namespaced": True,
                "kind": "Pod",
                "verbs": ["get", "list", "watch"],
            }
        ],
    },
}

POD_ROUTE = re.compile(r"^/api/v1/namespaces/(?P<ns>[^/]+)/pods/(?P<name>[^/]+)(?P<sub>/[a-z]+)?$")
PODS_ROUTE = re.compile(r"^/api/v1/namespaces/(?P<ns>[^/]+)/pods$")
EVENTS_ROUTE = re.compile(r"^/api/v1/namespaces/(?P<ns>[^/]+)/events$")
WORKLOAD_ROUTE = re.compile(
    r"^/apis/(?:apps|batch)/v1/namespaces/(?P<ns>[^/]+)/(?P<plural>[a-z]+)/(?P<name>[^/]+)$"
)


def _flag(query, name: str) -> bool:
    """Go's ParseBool via urlencode: kubernetes_asyncio sends Python True as `True`."""
    return query.get(name, "").lower() in ("1", "true")


class PodStore(dict):
    """Pods by (namespace, name); stored copies, so seeding a shared constant is safe."""

    def __setitem__(self, key, value) -> None:
        super().__setitem__(key, copy.deepcopy(value))


def bad_request(message: str) -> web.Response:
    return web.json_response(status_body(400, "BadRequest", message), status=400)


def invalid(message: str) -> web.Response:
    return web.json_response(status_body(422, "Invalid", message), status=422)


STRATEGIC_MERGE = "application/strategic-merge-patch+json"
STARTED = {"running": {"startedAt": "2026-11-07T09:00:00Z"}}


def _stamp(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%S.%f000Z")


class FakeKubeApi:
    """A tiny Kubernetes API: `mode` picks how it answers.

    ok: everything works; unauthorized: 401 everywhere; hang: never answers until `release`;
    apis_unauthorized: everything works except `/apis`, which answers 401;
    forbidden: 403 everywhere, with FORBIDDEN as the Status message;
    events_forbidden: listing events answers 403 (EVENTS_FORBIDDEN), everything else works;
    watch_forbidden: a pod watch answers 403; instant_close: a pod watch ends after its event.
    A pod watch in `ok` mode stays open until `release` is set.
    """

    def __init__(self) -> None:
        self.mode = "ok"
        self.paths: list[str] = []
        self.requests: list[tuple[str, str, dict]] = []
        self.auth: set[str | None] = set()
        self.release = asyncio.Event()
        self.url = ""
        self.pods: dict[tuple[str, str], dict] = PodStore()
        self.pods[("demo", "web-1")] = POD
        self.events: list[dict] = []
        # (plural, namespace, name) -> object, e.g. ("replicasets", "demo", "web-7c9")
        self.workloads: dict[tuple[str, str, str], dict] = {}
        self.logs: dict[tuple[str, str, str, bool], list[str]] = {}
        self.follow_lines: asyncio.Queue[str | None] = asyncio.Queue()
        self.execs: list[dict] = []
        self.exec_resizes: list[dict] = []
        # A Status the exec sends at once, then ends: a command that couldn't start (no shell).
        self.exec_status: dict | None = None
        self.start_states: list[dict] = [{"waiting": {"reason": "ContainerCreating"}}, STARTED]
        self.created: list[dict] = []
        self.patches: list[dict] = []
        self.deleted: list[tuple[str, str]] = []
        # (namespace, pod) -> [status field, container, states still to go through]
        self._starting: dict[tuple[str, str], list[tuple[str, str, list[dict]]]] = {}

    async def handle(self, request: web.Request) -> web.StreamResponse:
        self.paths.append(request.path)
        self.requests.append((request.method, request.path, dict(request.query)))
        self.auth.add(request.headers.get("Authorization"))
        if self.mode == "hang":
            await self.release.wait()
        if self.mode == "forbidden":
            return web.json_response(status_body(403, "Forbidden", FORBIDDEN), status=403)
        if self.mode == "unauthorized" or (
            self.mode == "apis_unauthorized" and request.path == "/apis"
        ):
            return web.json_response(status_body(401, "Unauthorized", "Unauthorized"), status=401)
        return await self._route(request)

    async def _route(self, request: web.Request) -> web.StreamResponse:
        method, path = request.method, request.path
        if method == "GET":
            if path == "/api/v1/pods":
                if _flag(request.query, "watch"):
                    return await self._watch(request)
                return web.json_response(
                    {
                        "kind": "PodList",
                        "apiVersion": "v1",
                        "metadata": {"resourceVersion": "42"},
                        "items": list(self.pods.values()),
                    }
                )
            if (body := ROUTES.get(path)) is not None:
                return web.json_response(body)
            if match := EVENTS_ROUTE.match(path):
                if self.mode == "events_forbidden":
                    body = status_body(403, "Forbidden", EVENTS_FORBIDDEN)
                    return web.json_response(body, status=403)
                return self._events(request, match["ns"])
            if match := WORKLOAD_ROUTE.match(path):
                found = self.workloads.get((match["plural"], match["ns"], match["name"]))
                return not_found() if found is None else web.json_response(found)
        if match := PODS_ROUTE.match(path):
            if method == "POST":
                return await self._create_pod(request, match["ns"])
            if method == "GET":
                return self._list_pods(request, match["ns"])
            if method == "DELETE":
                return self._delete_pods(request, match["ns"])
        if match := POD_ROUTE.match(path):
            key, sub = (match["ns"], match["name"]), match["sub"]
            if method == "GET" and sub is None:
                return self._pod_or_404(key)
            if method == "GET" and sub == "/log":
                return await self._log(request, key)
            if method == "GET" and sub == "/exec":
                return await self._exec(request, key)
            if method == "PATCH" and sub == "/ephemeralcontainers":
                return await self._patch_ephemeral(request, key)
            if method == "DELETE" and sub is None:
                return self._delete_pod(key)
        return not_found()

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

    def _selected(self, request: web.Request, ns: str) -> list[tuple[tuple[str, str], dict]]:
        """Pods in `ns` matching an equality `labelSelector` (`k=v,k2=v2`) and a
        `fieldSelector` of `metadata.name=...`."""

        def terms(name: str) -> list[list[str]]:
            return [t.partition("=")[::2] for t in request.query.get(name, "").split(",") if t]

        labels = terms("labelSelector")
        names = [v for k, v in terms("fieldSelector") if k == "metadata.name"]
        return [
            (key, pod)
            for key, pod in self.pods.items()
            if key[0] == ns
            and all((pod.get("metadata", {}).get("labels") or {}).get(k) == v for k, v in labels)
            and all(key[1] == name for name in names)
        ]

    def _list_pods(self, request: web.Request, ns: str) -> web.Response:
        return web.json_response(
            {
                "kind": "PodList",
                "apiVersion": "v1",
                "metadata": {"resourceVersion": "42"},
                "items": [pod for _, pod in self._selected(request, ns)],
            }
        )

    def _delete_pods(self, request: web.Request, ns: str) -> web.Response:
        """DELETE on the collection: every selected pod; none selected is fine (an empty list)."""
        items = []
        for key, pod in self._selected(request, ns):
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

    def _delete_pod(self, key: tuple[str, str]) -> web.Response:
        pod = self.pods.pop(key, None)
        if pod is None:
            return not_found(f'pods "{key[1]}" not found')
        self.deleted.append(key)
        self._starting.pop(key, None)
        return web.json_response(pod)

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

        moments = [(LOG_EPOCH + timedelta(seconds=i), line) for i, line in enumerate(seeded or [])]
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


@pytest.fixture
async def fake_api(tmp_path, monkeypatch):
    # The dynamic client caches discovery in the temp dir, keyed by host: keep runs independent.
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
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
