import dataclasses
import json

import pytest

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


class FakeApi:
    """The ApiClient: answers the `/api` probe with 200 and every other call from `script`.

    Each non-probe call is recorded in `requests` as (path, query params as a dict).
    """

    def __init__(self, script=()):
        self.script = list(script)
        self.requests: list[tuple[str, dict]] = []
        self.closes = 0
        self.probes = 0

    async def call_api(self, path, method, **kwargs):
        assert method == "GET" and kwargs["_preload_content"] is False
        assert kwargs["auth_settings"] == ["BearerToken"]
        if path == "/api":
            self.probes += 1
            return FakeResponse({"kind": "APIVersions", "versions": ["v1"]})
        self.requests.append((path, dict(kwargs.get("query_params") or [])))
        entry = self.script.pop(0)
        if isinstance(entry, BaseException):
            raise entry
        return entry

    async def close(self):
        self.closes += 1


def pod(name, rv):
    return {"metadata": {"name": name, "namespace": "demo", "uid": name, "resourceVersion": rv}}


def lines(*events):
    return b"".join(json.dumps(e).encode() + b"\n" for e in events)


async def collect(events):
    return [e async for e in events]


def source(*script, spec=None):
    api = FakeApi(script)
    return api, KubeResourceSource(api, spec or KINDS["pods"])


async def test_list_pages_all_namespaces_and_returns_plain_dicts():
    api, src = source(
        FakeResponse(
            {"metadata": {"resourceVersion": "10", "continue": "tok"}, "items": [pod("a", "5")]}
        ),
        FakeResponse({"metadata": {"resourceVersion": "10"}, "items": [pod("b", "6")]}),
    )
    items, rv = await src.list()
    assert items == [pod("a", "5"), pod("b", "6")] and rv == "10"
    assert api.requests == [
        ("/api/v1/pods", {"limit": 500}),
        ("/api/v1/pods", {"limit": 500, "continue": "tok"}),
    ]
    assert api.probes == 1


async def test_list_and_watch_use_the_specs_path_and_label_selector():
    spec = dataclasses.replace(
        KINDS["pods"], group="apps", plural="deployments", label_selector="owner=helm"
    )
    api, src = source(
        FakeResponse({"metadata": {"resourceVersion": "10"}, "items": []}),
        FakeResponse(chunks=[]),
        spec=spec,
    )
    await src.list()
    await collect(src.watch("10"))
    assert [(path, q["labelSelector"]) for path, q in api.requests] == [
        ("/apis/apps/v1/deployments", "owner=helm"),
        ("/apis/apps/v1/deployments", "owner=helm"),
    ]
    assert api.probes == 1  # once per source


async def test_watch_translates_events_and_skips_bookmarks():
    stream = lines(
        {"type": "ADDED", "object": pod("a", "11")},
        {"type": "BOOKMARK", "object": {"metadata": {"resourceVersion": "12"}}},
        {"type": "MODIFIED", "object": pod("a", "13")},
        {"type": "DELETED", "object": pod("a", "14")},
    )
    resp = FakeResponse(chunks=[stream[:7], stream[7:50], stream[50:]])  # lines split across chunks
    api, src = source(resp)
    events = await collect(src.watch("10"))
    assert events == [
        WatchEvent("ADDED", pod("a", "11")),
        WatchEvent("MODIFIED", pod("a", "13")),
        WatchEvent("DELETED", pod("a", "14")),
    ]
    [(path, params)] = api.requests
    assert path == "/api/v1/pods"
    assert params == {
        "watch": "true",
        "resourceVersion": "10",
        "timeoutSeconds": 300,
        "allowWatchBookmarks": "true",
    }
    assert resp.closed


async def test_watch_resumes_from_trailing_bookmark():
    api, src = source(
        FakeResponse(
            chunks=[
                lines(
                    {"type": "ADDED", "object": pod("a", "11")},
                    {"type": "BOOKMARK", "object": {"metadata": {"resourceVersion": "20"}}},
                )
            ]
        ),
        FakeResponse(chunks=[]),
        FakeResponse(chunks=[]),
    )
    await collect(src.watch("10"))
    await collect(src.watch("11"))  # caller resumes from the last event it saw
    await collect(src.watch("7"))  # an rv the source didn't hand out is used as given
    assert [q["resourceVersion"] for _, q in api.requests] == ["10", "20", "7"]


async def test_error_event_410_raises_expired():
    gone = {
        "type": "ERROR",
        "object": {
            "kind": "Status",
            "code": 410,
            "reason": "Expired",
            "message": "too old resource version: 1 (5)",
        },
    }
    resp = FakeResponse(chunks=[lines(gone)])
    _, src = source(resp)
    with pytest.raises(Expired):
        await collect(src.watch("1"))
    assert resp.closed


def status(code, reason, message):
    body = {
        "kind": "Status",
        "apiVersion": "v1",
        "status": "Failure",
        "code": code,
        "reason": reason,
        "message": message,
    }
    return FakeResponse(body, status=code, reason=reason)


async def test_http_410_on_watch_raises_expired():
    resp = status(410, "Gone", "too old resource version: 1 (5)")
    _, src = source(resp)
    with pytest.raises(Expired, match="too old resource version"):
        await collect(src.watch("1"))
    assert resp.closed


async def test_bare_status_line_in_watch_stream_raises_expired():
    gone = {
        "kind": "Status",
        "apiVersion": "v1",
        "status": "Failure",
        "code": 410,
        "message": "too old resource version",
    }
    _, src = source(FakeResponse(chunks=[lines(gone)]))
    with pytest.raises(Expired):
        await collect(src.watch("1"))


async def test_forbidden_list_raises_instead_of_returning_nothing():
    resp = status(403, "Forbidden", 'pods is forbidden: User "x" cannot list resource "pods"')
    _, src = source(resp)
    with pytest.raises(ClusterUnavailable) as info:
        await src.list()
    assert (
        info.value.message
        == 'Not allowed to list pods: pods is forbidden: User "x" cannot list resource "pods"'
    )
    assert resp.closed


async def test_forbidden_watch_raises_cluster_unavailable():
    _, src = source(status(403, "Forbidden", "nope"))
    with pytest.raises(ClusterUnavailable, match="^Not allowed to watch pods: nope$"):
        await collect(src.watch("1"))


async def test_unauthorized_list_raises_credentials_message():
    _, src = source(status(401, "Unauthorized", "Unauthorized"))
    with pytest.raises(ClusterUnavailable) as info:
        await src.list()
    assert info.value.message == "The cluster rejected the console's credentials: Unauthorized"


async def test_server_error_on_list_raises_with_status_message():
    _, src = source(status(503, "ServiceUnavailable", "etcd is down"))
    with pytest.raises(RuntimeError, match="^Kubernetes API returned 503: etcd is down$"):
        await src.list()


async def test_non_json_error_body_gives_a_clean_message():
    resp = FakeResponse(
        status=502, reason="Bad Gateway", raw=b"<html><body>upstream gone</body></html>"
    )
    _, src = source(resp)
    with pytest.raises(RuntimeError) as info:
        await collect(src.watch("1"))
    assert str(info.value) == "Kubernetes API returned 502: Bad Gateway"
    assert resp.closed


async def test_expired_continue_token_restarts_the_list():
    api, src = source(
        FakeResponse(
            {"metadata": {"resourceVersion": "10", "continue": "tok"}, "items": [pod("a", "5")]}
        ),
        status(410, "Expired", "continue token too old"),
        FakeResponse(
            {"metadata": {"resourceVersion": "20", "continue": "tok2"}, "items": [pod("a", "5")]}
        ),
        FakeResponse({"metadata": {"resourceVersion": "20"}, "items": [pod("b", "6")]}),
    )
    items, rv = await src.list()
    assert items == [pod("a", "5"), pod("b", "6")] and rv == "20"
    assert [q.get("continue") for _, q in api.requests] == [None, "tok", None, "tok2"]


async def test_list_gives_up_after_repeated_expiry():
    page = {"metadata": {"resourceVersion": "10", "continue": "tok"}, "items": [pod("a", "5")]}
    api, src = source(*[FakeResponse(page), status(410, "Expired", "continue token too old")] * 3)
    with pytest.raises(
        RuntimeError, match="^Kubernetes API returned 410: continue token too old$"
    ) as info:
        await src.list()
    assert not isinstance(info.value, Expired)
    assert len(api.requests) == 6


async def test_other_error_event_raises_with_status_message():
    err = {
        "type": "ERROR",
        "object": {"kind": "Status", "code": 500, "message": "etcdserver: leader changed"},
    }
    _, src = source(FakeResponse(chunks=[lines(err)]))
    with pytest.raises(Exception, match="etcdserver: leader changed") as info:
        await collect(src.watch("1"))
    assert not isinstance(info.value, Expired)


async def test_closing_the_watch_early_closes_the_stream():
    resp = FakeResponse(
        chunks=[
            lines(
                {"type": "ADDED", "object": pod("a", "11")},
                {"type": "ADDED", "object": pod("b", "12")},
            )
        ]
    )
    _, src = source(resp)
    events = src.watch("10")
    assert (await anext(events)).object == pod("a", "11")
    await events.aclose()
    assert resp.closed


async def test_aclose_closes_the_api_client_once():
    api, src = source()
    await src.aclose()
    await src.aclose()
    assert api.closes == 1


async def test_to_row_is_the_specs():
    _, src = source()
    row = src.to_row(pod("a", "5"), "cl")
    assert (row.kind, row.name, row.cluster_id) == ("Pod", "a", "cl")
