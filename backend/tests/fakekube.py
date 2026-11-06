"""A tiny Kubernetes API over real HTTP, shared by every test that needs one.

Nothing is mocked inside kubernetes_asyncio: the code under test talks to a real aiohttp server
on 127.0.0.1. Tests seed `pods`, `events`, `logs` and `follow_lines` and read back `requests`.

Exec is not served (it needs a SPDY/WebSocket upgrade); it is covered elsewhere.
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

# Seeded log lines are plain strings; line i is stamped LOG_EPOCH + i seconds, which is what
# `timestamps` prints and `sinceTime` compares against. Followed lines are stamped with "now".
LOG_EPOCH = datetime(2026, 1, 1, tzinfo=UTC)


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


def _stamp(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%S.%f000Z")


class FakeKubeApi:
    """A tiny Kubernetes API: `mode` picks how it answers.

    ok: everything works; unauthorized: 401 everywhere; hang: never answers until `release`;
    apis_unauthorized: everything works except `/apis`, which answers 401;
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
        self.pods: dict[tuple[str, str], dict] = {("demo", "web-1"): copy.deepcopy(POD)}
        self.events: list[dict] = []
        self.logs: dict[tuple[str, str, str, bool], list[str]] = {}
        self.follow_lines: asyncio.Queue[str | None] = asyncio.Queue()

    async def handle(self, request: web.Request) -> web.StreamResponse:
        self.paths.append(request.path)
        self.requests.append((request.method, request.path, dict(request.query)))
        self.auth.add(request.headers.get("Authorization"))
        if self.mode == "hang":
            await self.release.wait()
        if self.mode == "unauthorized" or (
            self.mode == "apis_unauthorized" and request.path == "/apis"
        ):
            return web.json_response(status_body(401, "Unauthorized", "Unauthorized"), status=401)
        return await self._route(request)

    async def _route(self, request: web.Request) -> web.StreamResponse:
        method, path = request.method, request.path
        if method == "GET":
            if path == "/api/v1/pods":
                if request.query.get("watch") in ("1", "true"):
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
                return self._events(request, match["ns"])
        if (match := PODS_ROUTE.match(path)) and method == "POST":
            return await self._create_pod(request, match["ns"])
        if match := POD_ROUTE.match(path):
            key, sub = (match["ns"], match["name"]), match["sub"]
            if method == "GET" and sub is None:
                return self._pod_or_404(key)
            if method == "GET" and sub == "/log":
                return await self._log(request, key)
            if method == "PATCH" and sub == "/ephemeralcontainers":
                return await self._patch_ephemeral(request, key)
            if method == "DELETE" and sub is None:
                return self._delete_pod(key)
        return not_found()

    def _pod_or_404(self, key: tuple[str, str]) -> web.Response:
        pod = self.pods.get(key)
        if pod is None:
            return not_found(f'pods "{key[1]}" not found')
        return web.json_response(pod)

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
        name = pod.get("metadata", {}).get("name", "")
        pod.setdefault("metadata", {})["namespace"] = ns
        pod["status"] = {"phase": "Pending"}
        self.pods[(ns, name)] = pod
        return web.json_response(pod, status=201)

    async def _patch_ephemeral(self, request: web.Request, key: tuple[str, str]) -> web.Response:
        pod = self.pods.get(key)
        if pod is None:
            return not_found(f'pods "{key[1]}" not found')
        patch = await request.json()
        added = patch.get("spec", {}).get("ephemeralContainers", [])
        spec = pod.setdefault("spec", {})
        spec["ephemeralContainers"] = [*spec.get("ephemeralContainers", []), *added]
        return web.json_response(pod)

    def _delete_pod(self, key: tuple[str, str]) -> web.Response:
        pod = self.pods.pop(key, None)
        if pod is None:
            return not_found(f'pods "{key[1]}" not found')
        return web.json_response(pod)

    async def _log(self, request: web.Request, key: tuple[str, str]) -> web.StreamResponse:
        pod = self.pods.get(key)
        if pod is None:
            return not_found(f'pods "{key[1]}" not found')
        query = request.query
        container = query.get("container") or next(
            (c["name"] for c in pod.get("spec", {}).get("containers", [])), ""
        )
        previous = query.get("previous") in ("1", "true")
        stamped = query.get("timestamps") in ("1", "true")

        def render(moment: datetime, line: str) -> bytes:
            return f"{_stamp(moment) + ' ' if stamped else ''}{line}\n".encode()

        headers = {"Content-Type": "text/plain"}
        if query.get("follow") in ("1", "true"):
            response = web.StreamResponse(headers=headers)
            response.enable_chunked_encoding()
            await response.prepare(request)
            while (line := await self.follow_lines.get()) is not None:
                await response.write(render(datetime.now(UTC), line))
            await response.write_eof()
            return response

        seeded = self.logs.get((key[0], key[1], container, previous), [])
        moments = [(LOG_EPOCH + timedelta(seconds=i), line) for i, line in enumerate(seeded)]
        if since := query.get("sinceTime"):
            cutoff = datetime.fromisoformat(since)
            moments = [(m, line) for m, line in moments if m >= cutoff]
        if tail := query.get("tailLines"):
            moments = moments[-int(tail) :] if int(tail) else []
        return web.Response(body=b"".join(render(m, line) for m, line in moments), headers=headers)

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
