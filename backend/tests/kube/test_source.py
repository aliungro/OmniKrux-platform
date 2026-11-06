import json
from typing import ClassVar

import pytest
from kubernetes_asyncio.client.rest import ApiException

from omnikrux.kube import source as source_mod
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
    def __init__(self, body=None, chunks=()):
        self._body = body
        self.content = FakeContent(list(chunks))
        self.closed = False

    async def json(self):
        return self._body

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


async def test_http_410_raises_expired(dyn):
    dyn.script = [ApiException(status=410, reason="Gone")]
    with pytest.raises(Expired):
        await collect(KubeResourceSource(FakeApi(), KINDS["pods"]).watch("1"))


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
