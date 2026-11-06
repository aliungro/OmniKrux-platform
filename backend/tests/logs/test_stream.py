"""LogStream against the shared fake Kubernetes API (real HTTP, nothing mocked in the client)."""

import asyncio
from contextlib import aclosing

import pytest

from omnikrux.kube.connections import ClusterConnections
from omnikrux.logs import stream as stream_module
from omnikrux.logs.stream import (
    LogStream,
    LogStreamError,
    ResumePoint,
    iter_lines,
    split_timestamp,
    ts_key,
)
from tests.fakekube import kubeconfig_for

CLUSTER = "c1"


class Registry:
    def __init__(self, server):
        self.server = server

    async def get_kubeconfig(self, cluster_id: str) -> dict:
        if cluster_id != CLUSTER:
            raise KeyError(cluster_id)
        return kubeconfig_for(self.server)


def pod(
    name: str = "crasher",
    *,
    containers=("app",),
    restarts: int = 0,
    state: dict | None = None,
    labels: dict | None = None,
    phase: str = "Running",
) -> dict:
    state = state if state is not None else {"running": {"startedAt": "2026-11-07T09:00:00Z"}}
    return {
        "metadata": {"name": name, "namespace": "demo", "uid": f"u-{name}", "labels": labels or {}},
        "spec": {"containers": [{"name": c} for c in containers]},
        "status": {
            "phase": phase,
            "containerStatuses": [
                {"name": c, "restartCount": restarts, "state": state} for c in containers
            ],
        },
    }


@pytest.fixture
def connections(fake_api):
    return ClusterConnections(Registry(fake_api))


@pytest.fixture
def fast_retries(monkeypatch):
    monkeypatch.setattr(stream_module, "RETRY_DELAY", 0.01)
    monkeypatch.setattr(stream_module, "POLL_INTERVAL", 0.01)


def make(connections, name="crasher", container="app", **kw) -> LogStream:
    opts = {"previous": False, "follow": False, "since_time": None, "tail_lines": None} | kw
    return LogStream(connections, CLUSTER, "demo", name, container, **opts)


async def collect(stream: LogStream) -> list[dict]:
    async with aclosing(stream.lines()) as lines:
        return [item async for item in lines]


async def next_item(lines):
    return await asyncio.wait_for(anext(lines), 5)


def log_requests(fake_api) -> list[dict]:
    return [q for _, path, q in fake_api.requests if path.endswith("/log")]


async def test_logs_previous_returns_prior_run(fake_api, connections):
    fake_api.pods[("demo", "crasher")] = pod(restarts=3, state={"waiting": {"reason": "Crash"}})
    fake_api.logs[("demo", "crasher", "app", True)] = ["starting", "boom: config missing"]
    fake_api.logs[("demo", "crasher", "app", False)] = ["current run"]

    items = await collect(make(connections, previous=True))

    assert items == [
        {"pod": "crasher", "container": "app", "ts": "2026-01-01T00:00:00.000000000Z",
         "text": "starting"},
        {"pod": "crasher", "container": "app", "ts": "2026-01-01T00:00:01.000000000Z",
         "text": "boom: config missing"},
    ]  # fmt: skip
    [query] = log_requests(fake_api)
    assert query["previous"].lower() == "true" and query["timestamps"].lower() == "true"


async def test_missing_previous_run_is_said_plainly(fake_api, connections):
    fake_api.pods[("demo", "crasher")] = pod()
    with pytest.raises(LogStreamError) as e:
        await collect(make(connections, previous=True))
    assert e.value.message.startswith('No previous run of container "app" in pod demo/crasher')
    assert "{" not in e.value.message


async def test_default_container_tail_and_since(fake_api, connections):
    fake_api.pods[("demo", "crasher")] = pod()
    fake_api.logs[("demo", "crasher", "app", False)] = ["a", "b", "c", "d"]

    items = await collect(
        make(connections, container=None, tail_lines=2, since_time="2026-01-01T00:00:01Z")
    )

    assert [(i["container"], i["text"]) for i in items] == [("app", "c"), ("app", "d")]
    [query] = log_requests(fake_api)
    assert query["tailLines"] == "2" and query["sinceTime"] == "2026-01-01T00:00:01Z"


async def test_unknown_pod_is_a_plain_error(fake_api, connections):
    with pytest.raises(LogStreamError) as e:
        await collect(make(connections, name="ghost"))
    assert "demo/ghost" in e.value.message and "not found" in e.value.message
    assert "{" not in e.value.message and "Traceback" not in e.value.message


async def test_unknown_cluster_is_a_plain_error(connections):
    stream = LogStream(
        connections, "nope", "demo", "x", None,
        previous=False, follow=False, since_time=None, tail_lines=None,
    )  # fmt: skip
    with pytest.raises(LogStreamError) as e:
        await collect(stream)
    assert e.value.message == "Unknown cluster"


async def test_follow_streams_queue_lines(fake_api, connections):
    fake_api.pods[("demo", "crasher")] = pod()
    async with aclosing(make(connections, follow=True).lines()) as lines:
        await fake_api.follow_lines.put("one")
        await fake_api.follow_lines.put("two")
        first, second = await next_item(lines), await next_item(lines)
        assert (first["text"], second["text"]) == ("one", "two")
        assert first["ts"] and first["ts"].endswith("Z") and first["pod"] == "crasher"

        del fake_api.pods[("demo", "crasher")]
        await fake_api.follow_lines.put(None)
        assert await next_item(lines) == {"marker": "Pod deleted"}
        with pytest.raises(StopAsyncIteration):
            await next_item(lines)


async def test_restart_emits_marker_and_resumes(fake_api, connections, fast_retries):
    fake_api.pods[("demo", "crasher")] = pod(restarts=0)
    async with aclosing(make(connections, follow=True, tail_lines=100).lines()) as lines:
        await fake_api.follow_lines.put("before")
        assert (await next_item(lines))["text"] == "before"

        # The container died: until the kubelet starts it again, nothing is reopened.
        fake_api.pods[("demo", "crasher")] = pod(restarts=0, state={"terminated": {"exitCode": 1}})
        pending = asyncio.ensure_future(next_item(lines))
        await fake_api.follow_lines.put(None)
        await asyncio.sleep(0.2)
        assert not pending.done() and len(log_requests(fake_api)) == 1

        fake_api.pods[("demo", "crasher")] = pod(
            restarts=1, state={"running": {"startedAt": "2026-11-07T10:00:00Z"}}
        )
        assert await pending == {"marker": "Container restarted at 2026-11-07T10:00:00Z, restart 1"}
        await fake_api.follow_lines.put("after")
        assert (await next_item(lines))["text"] == "after"
    await fake_api.follow_lines.put(None)

    first, reopened = log_requests(fake_api)
    assert first["tailLines"] == "100" and "sinceTime" not in first
    assert reopened["sinceTime"] == "2026-11-07T10:00:00Z" and "tailLines" not in reopened


async def test_closed_stream_reopens_from_last_timestamp(fake_api, connections):
    fake_api.pods[("demo", "crasher")] = pod()
    async with aclosing(make(connections, follow=True, tail_lines=10).lines()) as lines:
        await fake_api.follow_lines.put("one")
        one = await next_item(lines)
        await fake_api.follow_lines.put(None)  # e.g. the API server's own timeout
        await asyncio.sleep(0.05)  # "two" gets a later stamp, even on a coarse clock
        await fake_api.follow_lines.put("two")
        assert (await next_item(lines))["text"] == "two"
    await fake_api.follow_lines.put(None)

    _, reopened = log_requests(fake_api)
    assert reopened["sinceTime"] == one["ts"] and "tailLines" not in reopened


async def test_gives_up_after_five_immediate_failures(fake_api, connections, fast_retries):
    fake_api.pods[("demo", "crasher")] = pod()
    async with aclosing(make(connections, follow=True).lines()) as lines:
        await fake_api.follow_lines.put("one")
        await next_item(lines)
        fake_api.mode = "forbidden"
        await fake_api.follow_lines.put(None)
        with pytest.raises(LogStreamError) as e:
            await next_item(lines)
    assert e.value.message.startswith("Lost the log stream after 5 attempts: Not allowed")


async def test_previous_is_never_followed(fake_api, connections):
    fake_api.pods[("demo", "crasher")] = pod(restarts=1)
    fake_api.logs[("demo", "crasher", "app", True)] = ["old"]
    items = await asyncio.wait_for(collect(make(connections, previous=True, follow=True)), 5)
    assert [i["text"] for i in items] == ["old"]
    [query] = log_requests(fake_api)
    assert query.get("follow", "false").lower() == "false"


def test_split_timestamp():
    assert split_timestamp("2026-01-01T00:00:00.5Z hello world") == (
        "2026-01-01T00:00:00.5Z",
        "hello world",
    )
    assert split_timestamp("2026-01-01T00:00:00+02:00 x") == ("2026-01-01T00:00:00+02:00", "x")
    assert split_timestamp("no timestamp here") == (None, "no timestamp here")
    assert split_timestamp("2026-01-01T00:00:00Z") == ("2026-01-01T00:00:00Z", "")
    assert split_timestamp("") == (None, "")


def test_ts_key_orders_variable_fractions():
    keys = [
        ts_key("2026-01-01T00:00:00.1Z"),
        ts_key("2026-01-01T00:00:00.123Z"),
        ts_key("2026-01-01T02:00:00.2+02:00"),
        ts_key("2026-01-01T00:00:01Z"),
    ]
    assert keys[1] > keys[0] and keys[2] > keys[1] and keys[3] > keys[2]
    assert ts_key("garbage") is None


async def test_iter_lines_splits_chunks_and_keeps_last_partial_line():
    async def chunks():
        for chunk in [b"a\nb", b"c\r\n", "é".encode()[:1], "é".encode()[1:] + b"\n",
                      b"\xff\n", b"last"]:  # fmt: skip
            yield chunk

    assert [line async for line in iter_lines(chunks())] == ["a", "bc", "é", "�", "last"]


def test_resume_point_skips_exactly_what_was_sent():
    t1, t2, t3 = (f"2026-01-01T00:00:0{i}Z" for i in (1, 2, 3))
    position = ResumePoint()
    assert not position.repeats()(t1)  # nothing sent: nothing skipped
    for ts in (t1, t2, t2):  # two lines share t2
        position.sent(ts)
    assert position.ts == t2
    skip = position.repeats()
    # The reopened stream (sinceTime=t2, rounded down to t1 here) repeats t1, t2, t2, then
    # carries a third line stamped t2 that was never sent, then new lines.
    assert [skip(ts) for ts in (t1, t2, t2, t2, t3, t1)] == [True, True, True, False, False, False]
