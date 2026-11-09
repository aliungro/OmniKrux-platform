"""PortForwardManager: real TCP listeners bridged to the fake API's port-forward streams."""

import asyncio

import pytest

from omnikrux.config import Settings
from omnikrux.portforward import manager
from omnikrux.portforward.manager import PortForwardManager
from tests.portforward.conftest import (
    SECONDS,
    closed_by_peer,
    connect,
    echo,
    forward_tasks,
    hang_up,
    pod,
    refused,
    service,
    until,
)
from tests.portforward.test_channel import KUBELET_REFUSED, REFUSED

GONE = "Pod web-1 is gone; stop this forward and start a new one."


@pytest.mark.parametrize(
    ("bind", "address"),
    [
        ("0.0.0.0", "127.0.0.1:30100"),
        ("127.0.0.1", "127.0.0.1:30100"),
        ("::", "[::1]:30100"),
        ("::1", "[::1]:30100"),
        ("192.0.2.10", "192.0.2.10:30100"),
        ("2001:db8::10", "[2001:db8::10]:30100"),
    ],
)
def test_forward_address_follows_bind(bind, address):
    assert manager.forward_address(bind, 30100) == address


async def test_forward_output_keeps_the_listener_bind(env):
    cluster = await env.app.state.registry.get(env.cluster_id)
    forward = manager.Forward(
        id="forward", req=env.request(), cluster=cluster, local_port=30100, pod="web-1"
    )
    forward.bind = "2001:db8::10"
    assert forward.out().address == "[2001:db8::10]:30100"


async def test_forward_pod_port_relays_bytes(env):
    out = await env.forwards.start(env.request(), "local")

    port = env.ports[0]  # the lowest free one
    assert (out.local_port, out.address, out.remote_port) == (port, f"127.0.0.1:{port}", 8080)
    assert (out.kind, out.name, out.namespace, out.pod) == ("pod", "web-1", "demo", "web-1")
    assert (out.state, out.message, out.connections) == ("listening", None, 0)
    assert (out.cluster_id, out.cluster_name, out.provider) == (env.cluster_id, "fake", "onprem")
    assert env.fake.forwards == []  # nothing is opened until a connection arrives

    # Two connections at once: each gets its own stream to the pod.
    first, second = await connect(port), await connect(port)
    for reader, writer in (first, second):
        writer.write(b"ping")
        await writer.drain()
    for reader, writer in (second, first):
        assert await asyncio.wait_for(reader.readexactly(4), SECONDS) == b"ping"
    [listed] = env.forwards.list()
    assert listed.connections == 2
    for _, writer in (first, second):
        await hang_up(writer)
    await until(lambda: env.forwards.list()[0].connections == 0)
    await until(lambda: env.fake.forwards_open == 0)
    assert [f["ports"] for f in env.fake.forwards] == [[8080], [8080]]
    assert {f["pod"] for f in env.fake.forwards} == {"web-1"}

    [record] = await env.records()
    assert (record.action, record.outcome, record.kind, record.name) == (
        "port_forward",
        "started",
        "pods",
        "web-1",
    )
    assert record.details == {"remote_port": 8080, "local_port": port}


async def test_forward_service_resolves_ready_pod_and_named_port(env):
    env.fake.objects["services"][("demo", "web")] = service(
        ports=[
            {"name": "http", "port": 80, "targetPort": "http"},
            {"name": "metrics", "port": 81, "targetPort": 9090},
            {"name": "plain", "port": 82},
        ]
    )
    env.fake.pods[("demo", "web-0")] = pod("web-0", ports=(("metrics", 9090),))  # no "http"
    env.fake.pods[("demo", "web-a")] = pod("web-a", ready=False)
    env.fake.pods[("demo", "web-b")] = pod("web-b")
    env.fake.pods[("demo", "zzz")] = pod("zzz", labels={"app": "other"})

    out = await env.forwards.start(env.request(kind="service", name="web", port=80), "local")
    assert (out.kind, out.name, out.remote_port, out.pod) == ("service", "web", 80, "web-b")
    assert await echo(out.local_port) == b"ping"
    assert env.fake.forwards[-1] | {"protocol": None} == {
        "namespace": "demo",
        "pod": "web-b",
        "ports": [8080],  # the pod's port named "http"
        "protocol": None,
    }

    # Each new connection looks for a ready pod again.
    env.fake.pods[("demo", "web-b")] = pod("web-b", ready=False)
    env.fake.pods[("demo", "web-c")] = pod("web-c", ports=(("http", 8081),))
    assert await echo(out.local_port) == b"ping"
    assert (env.fake.forwards[-1]["pod"], env.fake.forwards[-1]["ports"]) == ("web-c", [8081])
    assert env.forwards.list()[0].pod == "web-c"

    numbered = await env.forwards.start(env.request(kind="service", name="web", port=81), "local")
    assert await echo(numbered.local_port) == b"ping"
    assert (env.fake.forwards[-1]["pod"], env.fake.forwards[-1]["ports"]) == ("web-0", [9090])

    [record, _] = await env.records()
    assert (record.kind, record.name, record.details) == (
        "services",
        "web",
        {"remote_port": 81, "local_port": numbered.local_port, "pod": "web-0"},
    )


async def test_service_port_without_target_port_is_the_same_number(env):
    env.fake.objects["services"][("demo", "web")] = service(ports=[{"port": 82}])
    env.fake.pods[("demo", "web-b")] = pod("web-b")
    out = await env.forwards.start(env.request(kind="service", name="web", port=82), "local")
    assert await echo(out.local_port) == b"ping"
    assert env.fake.forwards[-1]["ports"] == [82]


async def test_stop_closes_listener_and_audits(env):
    out = await env.forwards.start(env.request(), "local")
    reader, writer = await connect(out.local_port)
    writer.write(b"ping")
    await writer.drain()
    assert await asyncio.wait_for(reader.readexactly(4), SECONDS) == b"ping"
    assert env.fake.forwards_open == 1

    await env.forwards.stop(out.id, "local")

    assert env.forwards.list() == []
    assert await closed_by_peer(reader)  # the open connection is closed too
    await hang_up(writer)
    assert env.fake.forwards_open == 0  # and its stream to the pod
    assert await refused(out.local_port)
    [record] = await env.records()
    assert (record.outcome, record.message) == ("ended", "Stopped by local.")
    assert record.finished_at is not None

    again = await env.forwards.start(env.request(), "local")  # the port is free again
    assert again.local_port == out.local_port


async def test_new_connection_after_pod_gone_reports_error_state(env):
    out = await env.forwards.start(env.request(), "local")
    del env.fake.pods[("demo", "web-1")]

    reader, writer = await connect(out.local_port)
    assert await closed_by_peer(reader)
    await hang_up(writer)

    [listed] = env.forwards.list()
    assert (listed.state, listed.message) == ("error", GONE)
    assert listed.connections == 0
    [record] = await env.records()
    assert record.outcome == "started"  # the forward still listens until it is stopped


async def test_error_frame_sets_error_state_until_a_connection_works(env):
    out = await env.forwards.start(env.request(), "local")
    env.fake.forward_fail = KUBELET_REFUSED

    reader, writer = await connect(out.local_port)
    assert await closed_by_peer(reader)
    await hang_up(writer)
    [listed] = env.forwards.list()
    assert (listed.state, listed.message) == ("error", REFUSED)

    env.fake.forward_fail = None
    assert await echo(out.local_port) == b"ping"
    [listed] = env.forwards.list()
    assert (listed.state, listed.message) == ("listening", None)


async def test_bind_address_defaults_to_loopback(env):
    assert Settings(in_container=True).forward_bind == "127.0.0.1"
    assert Settings(in_container=False).forward_bind == "127.0.0.1"
    assert Settings().forward_ports == range(30000, 30020)
    assert Settings(port_forward_ports=" 30005 ").forward_ports == range(30005, 30006)

    # The app passes the settings on, and listeners bind only there.
    assert (env.forwards.bind, env.forwards.ports) == ("127.0.0.1", env.ports)
    out = await env.forwards.start(env.request(), "local")
    assert env.forwards.bound_addresses(out.id) == [("127.0.0.1", out.local_port)]

    manager = PortForwardManager(
        env.app.state.connections,
        env.app.state.registry,
        env.app.state.audit,
        ports=env.ports,
        bind="0.0.0.0",
    )
    try:
        everywhere = await manager.start(env.request(), "local")
        assert manager.bound_addresses(everywhere.id) == [("0.0.0.0", everywhere.local_port)]
        assert everywhere.address == f"127.0.0.1:{everywhere.local_port}"  # as published
    finally:
        await manager.close()


async def test_close_and_stop_cluster_end_every_forward(env):
    first = await env.forwards.start(env.request(), "local")
    second = await env.forwards.start(env.request(), "local")
    reader, writer = await connect(first.local_port)
    writer.write(b"x")
    await writer.drain()
    await asyncio.wait_for(reader.readexactly(1), SECONDS)
    assert forward_tasks()  # the check below sees a live connection

    await env.forwards.stop_cluster("another-cluster")
    assert len(env.forwards.list()) == 2

    await env.forwards.stop_cluster(env.cluster_id)
    assert env.forwards.list() == []
    assert await closed_by_peer(reader)
    await hang_up(writer)
    assert await refused(first.local_port) and await refused(second.local_port)
    assert env.fake.forwards_open == 0
    records = await env.records()
    assert [(r.outcome, r.message) for r in records] == [
        ("ended", "The cluster was removed from Omnikrux."),
    ] * 2
    assert forward_tasks() == []


async def test_slow_answer_after_local_eof_arrives_complete(env, monkeypatch):
    monkeypatch.setattr(manager, "IDLE_AFTER_EOF_SECONDS", 0.5)
    chunks = [f"part {i};".encode() for i in range(8)]
    env.fake.forward_answer, env.fake.forward_gap = chunks, 0.15  # 1.2 s in all
    out = await env.forwards.start(env.request(), "local")

    reader, writer = await connect(out.local_port)
    writer.write(b"GET / HTTP/1.0\r\n\r\n")
    writer.write_eof()  # half-close, as `nc -N` or shutdown(SHUT_WR) does
    answer = await asyncio.wait_for(reader.read(), SECONDS)
    await hang_up(writer)

    assert answer == b"".join(chunks)
    [listed] = env.forwards.list()
    assert (listed.state, listed.message) == ("listening", None)


async def test_half_closed_connection_closes_once_the_pod_goes_quiet(env, monkeypatch):
    monkeypatch.setattr(manager, "IDLE_AFTER_EOF_SECONDS", 0.3)
    env.fake.forward_answer = []  # the pod never answers, and never closes
    out = await env.forwards.start(env.request(), "local")

    reader, writer = await connect(out.local_port)
    writer.write(b"hello")
    writer.write_eof()
    assert await asyncio.wait_for(reader.read(), SECONDS) == b""
    await hang_up(writer)
    await until(lambda: env.fake.forwards_open == 0)
    await until(lambda: env.forwards.list()[0].connections == 0)
