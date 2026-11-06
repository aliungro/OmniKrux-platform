import json
from typing import ClassVar

import pytest

from omnikrux.kube import source as source_mod
from omnikrux.kube.client import ClusterUnavailable
from omnikrux.kube.source import KubeResourceSource
from omnikrux.resources.kinds import KINDS
from omnikrux.watch.source import Expired, WatchEvent


class FakeContent:
    def __init__(self, chunks):
        self._chunks = chunks

    async def iter_any(self):
        for chunk in self._chunks:
            yield chunk


class FakeResponse:
    def __init__(self, body=None, chunks=(), status=200, reason="OK", raw=None):
        self._body = body
        self._raw = raw if raw is not None else json.dumps(body).encode()
        self.content = FakeContent(list(chunks))
        self.status = status
        self.reason = reason
        self.closed = False

    async def json(self):
        return self._body

    async def read(self):
        return self._raw

    def release(self):
        self.closed = True

    def close(self):
        self.closed = True


class FakeResource:
    def path(self, name=None, namespace=None):
        assert name is None and namespace is None
        return "/api/v1/pods"


class FakeDynamic:
    """Stands in for kubernetes_asyncio's DynamicClient; scripted request() responses."""

    instances: ClassVar[list["FakeDynamic"]] = []
    script: ClassVar[list] = []

    def __init__(self, api):
        self.api = api
        self.lookups: list[dict] = []
        self.requests: list[tuple[str, str, dict]] = []
        self.resources = self
        FakeDynamic.instances.append(self)

    def __await__(self):
        async def ready():
            return self

        return ready().__await__()

    async def get(self, **kwargs):  # resources.get(...)
        self.lookups.append(kwargs)
        return FakeResource()

    async def request(self, method, path, **params):
        self.requests.append((method, path, params))
        entry = FakeDynamic.script.pop(0)
        if isinstance(entry, BaseException):
            raise entry
        return entry


class FakeApi:
    def __init__(self):
        self.closes = 0

    async def close(self):
        self.closes += 1


@pytest.fixture
def dyn(monkeypatch):
    FakeDynamic.instances = []
    FakeDynamic.script = []
    monkeypatch.setattr(source_mod, "DynamicClient", FakeDynamic)
    return FakeDynamic


def pod(name, rv):
    return {"metadata": {"name": name, "namespace": "demo", "uid": name, "resourceVersion": rv}}


def lines(*events):
    return b"".join(json.dumps(e).encode() + b"\n" for e in events)


async def collect(events):
    return [e async for e in events]


async def test_list_pages_all_namespaces_and_returns_plain_dicts(dyn):
    dyn.script = [
        FakeResponse({"metadata": {"resourceVersion": "10", "continue": "tok"}, "items": [pod("a", "5")]}),
        FakeResponse({"metadata": {"resourceVersion": "10"}, "items": [pod("b", "6")]}),
    ]
    items, rv = await KubeResourceSource(FakeApi(), KINDS["pods"]).list()
    assert items == [pod("a", "5"), pod("b", "6")] and rv == "10"
    d = dyn.instances[0]
    assert d.lookups == [{"prefix": "api", "group": None, "api_version": "v1", "kind": "Pod", "name": "pods"}]
    assert [(m, p, r["limit"], r["_continue"]) for m, p, r in d.requests] == [
        ("get", "/api/v1/pods", 500, None),
        ("get", "/api/v1/pods", 500, "tok"),
    ]


async def test_watch_translates_events_and_skips_bookmarks(dyn):
    stream = lines(
        {"type": "ADDED", "object": pod("a", "11")},
        {"type": "BOOKMARK", "object": {"metadata": {"resourceVersion": "12"}}},
        {"type": "MODIFIED", "object": pod("a", "13")},
        {"type": "DELETED", "object": pod("a", "14")},
    )
    resp = FakeResponse(chunks=[stream[:7], stream[7:50], stream[50:]])  # lines split across chunks
    dyn.script = [resp]
    events = await collect(KubeResourceSource(FakeApi(), KINDS["pods"]).watch("10"))
    assert events == [
        WatchEvent("ADDED", pod("a", "11")),
        WatchEvent("MODIFIED", pod("a", "13")),
        WatchEvent("DELETED", pod("a", "14")),
    ]
    _, path, params = dyn.instances[0].requests[0]
    assert path == "/api/v1/pods"
    assert params["watch"] is True and params["resource_version"] == "10"
    assert params["timeout_seconds"] == 300
    assert ("allowWatchBookmarks", "true") in params["query_params"]
    assert resp.closed


async def test_watch_resumes_from_trailing_bookmark(dyn):
    dyn.script = [
        FakeResponse(chunks=[lines({"type": "ADDED", "object": pod("a", "11")}, {"type": "BOOKMARK", "object": {"metadata": {"resourceVersion": "20"}}})]),
        FakeResponse(chunks=[]),
        FakeResponse(chunks=[]),
    ]
    src = KubeResourceSource(FakeApi(), KINDS["pods"])
    await collect(src.watch("10"))
    await collect(src.watch("11"))  # caller resumes from the last event it saw
    await collect(src.watch("7"))  # an rv the source didn't hand out is used as given
    assert [r["resource_version"] for _, _, r in dyn.instances[0].requests] == ["10", "20", "7"]


async def test_error_event_410_raises_expired(dyn):
    gone = {"type": "ERROR", "object": {"kind": "Status", "code": 410, "reason": "Expired", "message": "too old resource version: 1 (5)"}}
    resp = FakeResponse(chunks=[lines(gone)])
    dyn.script = [resp]
    with pytest.raises(Expired):
        await collect(KubeResourceSource(FakeApi(), KINDS["pods"]).watch("1"))
    assert resp.closed


def status(code, reason, message):
    body = {"kind": "Status", "apiVersion": "v1", "status": "Failure", "code": code, "reason": reason, "message": message}
    return FakeResponse(body, status=code, reason=reason)


async def test_http_410_on_watch_raises_expired(dyn):
    resp = status(410, "Gone", "too old resource version: 1 (5)")
    dyn.script = [resp]
    with pytest.raises(Expired, match="too old resource version"):
        await collect(KubeResourceSource(FakeApi(), KINDS["pods"]).watch("1"))
    assert resp.closed


async def test_bare_status_line_in_watch_stream_raises_expired(dyn):
    gone = {"kind": "Status", "apiVersion": "v1", "status": "Failure", "code": 410, "message": "too old resource version"}
    dyn.script = [FakeResponse(chunks=[lines(gone)])]
    with pytest.raises(Expired):
        await collect(KubeResourceSource(FakeApi(), KINDS["pods"]).watch("1"))


async def test_forbidden_list_raises_instead_of_returning_nothing(dyn):
    resp = status(403, "Forbidden", 'pods is forbidden: User "x" cannot list resource "pods"')
    dyn.script = [resp]
    with pytest.raises(ClusterUnavailable) as info:
        await KubeResourceSource(FakeApi(), KINDS["pods"]).list()
    assert info.value.message == 'Not allowed to list pods: pods is forbidden: User "x" cannot list resource "pods"'
    assert resp.closed


async def test_forbidden_watch_raises_cluster_unavailable(dyn):
    dyn.script = [status(403, "Forbidden", "nope")]
    with pytest.raises(ClusterUnavailable, match="^Not allowed to watch pods: nope$"):
        await collect(KubeResourceSource(FakeApi(), KINDS["pods"]).watch("1"))


async def test_unauthorized_list_raises_credentials_message(dyn):
    dyn.script = [status(401, "Unauthorized", "Unauthorized")]
    with pytest.raises(ClusterUnavailable) as info:
        await KubeResourceSource(FakeApi(), KINDS["pods"]).list()
    assert info.value.message == "The cluster rejected the console's credentials: Unauthorized"


async def test_server_error_on_list_raises_with_status_message(dyn):
    dyn.script = [status(503, "ServiceUnavailable", "etcd is down")]
    with pytest.raises(RuntimeError, match="^Kubernetes API returned 503: etcd is down$"):
        await KubeResourceSource(FakeApi(), KINDS["pods"]).list()


async def test_non_json_error_body_gives_a_clean_message(dyn):
    resp = FakeResponse(status=502, reason="Bad Gateway", raw=b"<html><body>upstream gone</body></html>")
    dyn.script = [resp]
    with pytest.raises(RuntimeError) as info:
        await collect(KubeResourceSource(FakeApi(), KINDS["pods"]).watch("1"))
    assert str(info.value) == "Kubernetes API returned 502: Bad Gateway"
    assert resp.closed


async def test_expired_continue_token_restarts_the_list(dyn):
    dyn.script = [
        FakeResponse({"metadata": {"resourceVersion": "10", "continue": "tok"}, "items": [pod("a", "5")]}),
        status(410, "Expired", "continue token too old"),
        FakeResponse({"metadata": {"resourceVersion": "20", "continue": "tok2"}, "items": [pod("a", "5")]}),
        FakeResponse({"metadata": {"resourceVersion": "20"}, "items": [pod("b", "6")]}),
    ]
    items, rv = await KubeResourceSource(FakeApi(), KINDS["pods"]).list()
    assert items == [pod("a", "5"), pod("b", "6")] and rv == "20"
    assert [r["_continue"] for _, _, r in dyn.instances[0].requests] == [None, "tok", None, "tok2"]


async def test_list_gives_up_after_repeated_expiry(dyn):
    page = {"metadata": {"resourceVersion": "10", "continue": "tok"}, "items": [pod("a", "5")]}
    dyn.script = [FakeResponse(page), status(410, "Expired", "continue token too old")] * 3
    with pytest.raises(RuntimeError, match="^Kubernetes API returned 410: continue token too old$") as info:
        await KubeResourceSource(FakeApi(), KINDS["pods"]).list()
    assert not isinstance(info.value, Expired)
    assert len(dyn.instances[0].requests) == 6


async def test_other_error_event_raises_with_status_message(dyn):
    err = {"type": "ERROR", "object": {"kind": "Status", "code": 500, "message": "etcdserver: leader changed"}}
    dyn.script = [FakeResponse(chunks=[lines(err)])]
    with pytest.raises(Exception, match="etcdserver: leader changed") as info:
        await collect(KubeResourceSource(FakeApi(), KINDS["pods"]).watch("1"))
    assert not isinstance(info.value, Expired)


async def test_closing_the_watch_early_closes_the_stream(dyn):
    resp = FakeResponse(chunks=[lines({"type": "ADDED", "object": pod("a", "11")}, {"type": "ADDED", "object": pod("b", "12")})])
    dyn.script = [resp]
    events = KubeResourceSource(FakeApi(), KINDS["pods"]).watch("10")
    assert (await anext(events)).object == pod("a", "11")
    await events.aclose()
    assert resp.closed


async def test_aclose_closes_the_api_client_once():
    api = FakeApi()
    src = KubeResourceSource(api, KINDS["pods"])
    await src.aclose()
    await src.aclose()
    assert api.closes == 1
