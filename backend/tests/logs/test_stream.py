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
from tests.fakekube import CUT, kubeconfig_for

CLUSTER = "c1"
NO_PREVIOUS_RUN = (
    "No previous run to show yet: the kubelet can take about a minute to serve the previous run "
    "after a restart. Try again in a minute, or read the current logs."
)
REAL_PREVIOUS_DELAYS = (
    stream_module.PREVIOUS_RETRY_DELAYS if hasattr(stream_module, "PREVIOUS_RETRY_DELAYS") else None
)


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
    assert e.value.message == NO_PREVIOUS_RUN
    assert "{" not in e.value.message


async def test_previous_logs_retry_400_then_soft_message(fake_api, connections, monkeypatch):
    monkeypatch.setattr(stream_module, "PREVIOUS_RETRY_DELAYS", (0.01, 0.02))
    fake_api.pods[("demo", "crasher")] = pod()
    fake_api.previous_refusals[("demo", "crasher", "app")] = 99  # never becomes available

    with pytest.raises(LogStreamError) as e:
        await collect(make(connections, previous=True))

    assert fake_api.previous_requests == 3  # the first try and two retries
    assert e.value.message == NO_PREVIOUS_RUN


async def test_previous_logs_retry_succeeds_when_the_kubelet_catches_up(
    fake_api, connections, monkeypatch
):
    monkeypatch.setattr(stream_module, "PREVIOUS_RETRY_DELAYS", (0.01, 0.02))
    fake_api.pods[("demo", "crasher")] = pod(restarts=1)
    fake_api.logs[("demo", "crasher", "app", True)] = ["boom"]
    fake_api.previous_refusals[("demo", "crasher", "app")] = 2

    items = await collect(make(connections, previous=True))

    assert [i["text"] for i in items] == ["boom"]
    assert fake_api.previous_requests == 3


def test_previous_logs_are_retried_after_half_a_second_then_one_and_a_half():
    assert REAL_PREVIOUS_DELAYS == (0.5, 1.5)


async def test_other_errors_are_not_retried(fake_api, connections, monkeypatch):
    monkeypatch.setattr(stream_module, "PREVIOUS_RETRY_DELAYS", (0.01, 0.02))
    with pytest.raises(LogStreamError):
        await collect(make(connections, name="ghost", previous=True))  # 404: no such pod
    assert fake_api.previous_requests == 0


async def test_native_sidecar_follows_restarts(fake_api, connections, fast_retries):
    """An init container with restartPolicy Always restarts even when the pod's policy is Never."""
    p = pod(containers=("app",))
    p["spec"]["restartPolicy"] = "Never"
    p["spec"]["initContainers"] = [{"name": "proxy", "restartPolicy": "Always"}]
    p["status"]["initContainerStatuses"] = [
        {
            "name": "proxy",
            "restartCount": 0,
            "state": {"running": {"startedAt": "2026-11-07T09:00:00Z"}},
        }
    ]
    fake_api.pods[("demo", "crasher")] = p
    async with aclosing(make(connections, container="proxy", follow=True).lines()) as lines:
        await fake_api.follow_lines.put("up")
        assert (await next_item(lines))["text"] == "up"
        p["status"]["initContainerStatuses"][0]["state"] = {"terminated": {"exitCode": 1}}
        fake_api.pods[("demo", "crasher")] = p
        pending = asyncio.ensure_future(next_item(lines))
        await fake_api.follow_lines.put(None)
        await asyncio.sleep(0.2)
        assert not pending.done()  # waiting for the restart, not ended

        p["status"]["initContainerStatuses"][0] = {
            "name": "proxy",
            "restartCount": 1,
            "state": {"running": {"startedAt": "2026-11-07T10:00:00Z"}},
        }
        fake_api.pods[("demo", "crasher")] = p
        assert await pending == {"marker": "Container restarted at 2026-11-07T10:00:00Z, restart 1"}
    await fake_api.follow_lines.put(None)


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


async def test_slow_failing_reopens_still_count_as_failures(
    fake_api, connections, fast_retries, monkeypatch
):
    """A reopen that times out after a long connect never lived: the stream must give up, not
    retry forever while showing "streaming"."""
    monkeypatch.setattr(stream_module, "IMMEDIATE_SECONDS", 0.05)
    real_open = LogStream._open
    calls = 0

    async def open_then_time_out(self, *args):
        nonlocal calls
        calls += 1
        if calls == 1:
            return await real_open(self, *args)
        await asyncio.sleep(0.1)  # longer than IMMEDIATE_SECONDS, like a 30 s connect timeout
        raise TimeoutError

    monkeypatch.setattr(LogStream, "_open", open_then_time_out)
    fake_api.pods[("demo", "crasher")] = pod()
    async with aclosing(make(connections, follow=True).lines()) as lines:
        await fake_api.follow_lines.put("one")
        await next_item(lines)
        await fake_api.follow_lines.put(None)
        with pytest.raises(LogStreamError) as e:
            await next_item(lines)
    assert e.value.message.startswith("Lost the log stream after 5 attempts")


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


async def test_transient_error_in_first_followed_stream_resumes(
    fake_api, connections, fast_retries
):
    fake_api.pods[("demo", "crasher")] = pod()
    async with aclosing(make(connections, follow=True, tail_lines=5).lines()) as lines:
        await fake_api.follow_lines.put("one")
        one = await next_item(lines)
        await fake_api.follow_lines.put(CUT)  # the connection breaks: not the end
        await asyncio.sleep(0.05)
        await fake_api.follow_lines.put("two")
        assert (await next_item(lines))["text"] == "two"
    await fake_api.follow_lines.put(None)
    _, reopened = log_requests(fake_api)
    assert reopened["sinceTime"] == one["ts"]


async def test_errors_after_lines_are_not_consecutive_failures(fake_api, connections, fast_retries):
    fake_api.pods[("demo", "crasher")] = pod()
    async with aclosing(make(connections, follow=True).lines()) as lines:
        for i in range(stream_module.MAX_FAILURES + 1):
            await fake_api.follow_lines.put(f"line {i}")
            assert (await next_item(lines))["text"] == f"line {i}"
            await fake_api.follow_lines.put(CUT)
            await asyncio.sleep(0.02)  # distinct stamps, even on a coarse clock
        await fake_api.follow_lines.put("still here")
        assert (await next_item(lines))["text"] == "still here"
    await fake_api.follow_lines.put(None)


async def end_of(lines) -> None:
    with pytest.raises(StopAsyncIteration):
        await next_item(lines)


async def test_completed_init_container_ends_the_stream(fake_api, connections, fast_retries):
    p = pod(containers=("app",))
    p["spec"]["initContainers"] = [{"name": "migrate"}]
    p["status"]["initContainerStatuses"] = [
        {"name": "migrate", "restartCount": 0, "state": {"running": {}}}
    ]
    fake_api.pods[("demo", "crasher")] = p
    async with aclosing(make(connections, container="migrate", follow=True).lines()) as lines:
        await fake_api.follow_lines.put("migrated")
        assert (await next_item(lines))["text"] == "migrated"
        p["status"]["initContainerStatuses"][0]["state"] = {"terminated": {"exitCode": 0}}
        fake_api.pods[("demo", "crasher")] = p  # the pod runs on; this container is done
        await fake_api.follow_lines.put(None)
        await end_of(lines)


@pytest.mark.parametrize(("policy", "exit_code"), [("Never", 1), ("OnFailure", 0)])
async def test_container_that_will_not_restart_ends_the_stream(
    fake_api, connections, fast_retries, policy, exit_code
):
    p = pod(containers=("app", "sidecar"))
    p["spec"]["restartPolicy"] = policy
    fake_api.pods[("demo", "crasher")] = p
    async with aclosing(make(connections, follow=True).lines()) as lines:
        await fake_api.follow_lines.put("bye")
        await next_item(lines)
        p["status"]["containerStatuses"][0]["state"] = {"terminated": {"exitCode": exit_code}}
        fake_api.pods[("demo", "crasher")] = p  # phase still Running: the sidecar runs on
        await fake_api.follow_lines.put(None)
        await end_of(lines)


async def test_pod_recreated_under_the_same_name_is_replaced(fake_api, connections):
    fake_api.pods[("demo", "crasher")] = pod()
    async with aclosing(make(connections, follow=True).lines()) as lines:
        await fake_api.follow_lines.put("old pod")
        await next_item(lines)
        replacement = pod()
        replacement["metadata"]["uid"] = "u-crasher-2"
        fake_api.pods[("demo", "crasher")] = replacement
        await fake_api.follow_lines.put(None)
        assert await next_item(lines) == {"marker": "Pod replaced"}
        await end_of(lines)
