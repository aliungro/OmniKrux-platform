"""The port-forward routes, startup and shutdown."""

import pytest
from sqlalchemy import text

from omnikrux.actions import authz
from omnikrux.actions.authz import NotAllowed
from omnikrux.config import Settings
from omnikrux.main import create_app
from tests.portforward.conftest import (
    closed_by_peer,
    connect,
    echo,
    free_ports,
    hang_up,
    make_env,
    pod,
    refused,
    service,
    until,
)

NO_READY = "Service web has no ready pods to forward to."


async def test_start_list_and_stop_over_http(env):
    r = await env.client.post("/api/port-forwards", json=env.body())
    assert r.status_code == 200, r.text
    out = r.json()
    port = env.ports[0]
    assert {k: v for k, v in out.items() if k not in ("id", "started_at")} == {
        "cluster_id": env.cluster_id,
        "cluster_name": "fake",
        "provider": "onprem",
        "namespace": "demo",
        "kind": "pod",
        "name": "web-1",
        "remote_port": 8080,
        "local_port": port,
        "address": f"127.0.0.1:{port}",
        "pod": "web-1",
        "state": "listening",
        "message": None,
        "connections": 0,
    }
    assert out["started_at"].endswith(("Z", "+00:00"))
    assert await echo(port) == b"ping"

    r = await env.client.get("/api/port-forwards")
    assert [f["id"] for f in r.json()] == [out["id"]]

    r = await env.client.delete(f"/api/port-forwards/{out['id']}")
    assert (r.status_code, r.content) == (204, b"")
    assert (await env.client.get("/api/port-forwards")).json() == []
    assert await refused(port)

    r = await env.client.delete(f"/api/port-forwards/{out['id']}")
    assert r.status_code == 404
    assert r.json() == {"detail": "This port-forward isn't running any more."}


async def test_pod_not_running_is_plain_422(env):
    env.fake.pods[("demo", "web-1")] = pod("web-1") | {"status": {"phase": "Pending"}}

    r = await env.client.post("/api/port-forwards", json=env.body())

    assert (r.status_code, r.json()) == (
        422,
        {
            "detail": "Pod web-1 isn't running (Pending), so nothing in it can be reached. "
            "Wait for it to start, or pick a running pod."
        },
    )
    assert env.forwards.list() == []
    assert await env.records() == []


async def test_service_without_ready_pods_plain_422(env):
    env.fake.objects["services"][("demo", "web")] = service()
    env.fake.pods[("demo", "web-a")] = pod("web-a", ready=False)
    env.fake.pods[("demo", "web-b")] = pod("web-b") | {
        "status": {"phase": "Pending", "conditions": []}
    }

    r = await env.client.post(
        "/api/port-forwards", json=env.body(kind="service", name="web", port=80)
    )

    assert (r.status_code, r.json()) == (422, {"detail": NO_READY})
    assert env.forwards.list() == []
    assert await env.records() == []  # nothing was started
    assert await refused(env.ports[0])

    # A service with no selector has no pods to forward to either.
    env.fake.objects["services"][("demo", "web")] = service(selector={})
    r = await env.client.post(
        "/api/port-forwards", json=env.body(kind="service", name="web", port=80)
    )
    assert (r.status_code, r.json()) == (422, {"detail": NO_READY})


async def test_service_turning_unready_reports_error_state(env):
    env.fake.objects["services"][("demo", "web")] = service()
    env.fake.pods[("demo", "web-b")] = pod("web-b")
    r = await env.client.post(
        "/api/port-forwards", json=env.body(kind="service", name="web", port=80)
    )
    port = r.json()["local_port"]

    env.fake.pods[("demo", "web-b")] = pod("web-b", ready=False)
    reader, writer = await connect(port)
    assert await closed_by_peer(reader)
    await hang_up(writer)
    [listed] = (await env.client.get("/api/port-forwards")).json()
    assert (listed["state"], listed["message"]) == ("error", NO_READY)

    del env.fake.objects["services"][("demo", "web")]
    reader, writer = await connect(port)
    assert await closed_by_peer(reader)
    await hang_up(writer)
    [listed] = (await env.client.get("/api/port-forwards")).json()
    assert listed["message"] == "Service web is gone; stop this forward and start a new one."


async def test_service_port_that_does_not_exist_is_plain_422(env):
    env.fake.objects["services"][("demo", "web")] = service(
        ports=[{"port": 80, "targetPort": 8080}, {"port": 443, "targetPort": 8443}]
    )
    env.fake.pods[("demo", "web-b")] = pod("web-b")
    r = await env.client.post(
        "/api/port-forwards", json=env.body(kind="service", name="web", port=8080)
    )
    assert (r.status_code, r.json()) == (
        422,
        {"detail": "Service web has no port 8080. Pick one of its ports: 80, 443."},
    )


async def test_ports_exhausted_409_exact(env):
    first, last = env.ports[0], env.ports[-1]
    started = [(await env.client.post("/api/port-forwards", json=env.body())).json() for _ in "ab"]
    assert [f["local_port"] for f in started] == [first, last]

    r = await env.client.post("/api/port-forwards", json=env.body())

    assert r.status_code == 409
    assert r.json() == {
        "detail": f"All 2 port-forward ports ({first}–{last}) are in use. Stop one first."
    }
    assert len(env.forwards.list()) == 2
    assert len(await env.records()) == 2  # the refused one wrote nothing

    await env.client.delete(f"/api/port-forwards/{started[0]['id']}")
    r = await env.client.post("/api/port-forwards", json=env.body())
    assert (r.status_code, r.json()["local_port"]) == (200, first)


async def test_port_used_by_another_program_is_skipped(env):
    import socket

    other = socket.socket()
    other.bind(("127.0.0.1", env.ports[0]))
    other.listen()
    try:
        r = await env.client.post("/api/port-forwards", json=env.body())
        assert r.json()["local_port"] == env.ports[1]
        r = await env.client.post("/api/port-forwards", json=env.body())
        assert r.status_code == 409
    finally:
        other.close()


async def test_start_refusals_are_plain(env, monkeypatch):
    post = env.client.post
    r = await post("/api/port-forwards", json=env.body(cluster_id="nope"))
    assert (r.status_code, r.json()) == (404, {"detail": "Unknown cluster"})
    r = await post("/api/port-forwards", json=env.body(name="gone"))
    assert r.status_code == 404
    assert r.json()["detail"] == (
        "Pod demo/gone not found. It may have been deleted; pick it again from the list."
    )
    r = await post("/api/port-forwards", json=env.body(kind="service", name="gone", port=80))
    assert r.status_code == 404
    assert r.json()["detail"] == (
        "Service demo/gone not found. It may have been deleted; pick it again from the list."
    )
    r = await post("/api/port-forwards", json=env.body(name="../secrets"))
    assert r.status_code == 422
    for port in (0, 65536):
        r = await post("/api/port-forwards", json=env.body() | {"port": port})
        assert r.status_code == 422
    r = await post("/api/port-forwards", json=env.body() | {"local_port": 30001})
    assert r.status_code == 422
    r = await post("/api/port-forwards", json=env.body() | {"kind": "deployment"})
    assert r.status_code == 422

    async def refuse(*args):
        raise NotAllowed("Not allowed to port-forward here.")

    monkeypatch.setattr(authz, "authorize", refuse)
    r = await post("/api/port-forwards", json=env.body())
    assert (r.status_code, r.json()) == (403, {"detail": "Not allowed to port-forward here."})

    assert env.forwards.list() == []
    assert await env.records() == []
    assert env.fake.forwards == []


async def test_no_audit_no_forward(env):
    async with env.app.state.engine.begin() as conn:
        await conn.execute(text("DROP TABLE audit"))

    r = await env.client.post("/api/port-forwards", json=env.body())

    assert r.status_code == 503
    assert r.json() == {
        "detail": "Nothing was changed: the audit log can't be written (no such table: audit)."
    }
    assert env.forwards.list() == []
    assert await refused(env.ports[0])


async def test_removed_cluster_stops_its_forwards(env):
    out = (await env.client.post("/api/port-forwards", json=env.body())).json()

    r = await env.client.delete(f"/api/clusters/{env.cluster_id}")

    assert r.status_code == 204
    assert (await env.client.get("/api/port-forwards")).json() == []
    assert await refused(out["local_port"])
    [record] = await env.records()
    assert (record.outcome, record.message) == ("ended", "The cluster was removed from Omnikrux.")


async def test_forwards_stopped_on_shutdown(fake_api, tmp_path):
    ports = free_ports(2)
    fake_api.pods[("demo", "web-1")] = pod("web-1", labels={})
    async with make_env(fake_api, tmp_path, ports) as env:
        out = (await env.client.post("/api/port-forwards", json=env.body())).json()
        reader, writer = await connect(out["local_port"])
        writer.write(b"ping")
        await writer.drain()
        assert await reader.readexactly(4) == b"ping"

    assert await closed_by_peer(reader)
    await hang_up(writer)
    await until(lambda: fake_api.forwards_open == 0)
    assert await refused(out["local_port"])

    async with make_env(fake_api, tmp_path, ports) as env:  # the record was finished, not cut off
        [record] = await env.records()
        assert (record.action, record.outcome, record.message) == (
            "port_forward",
            "ended",
            "The console stopped.",
        )


@pytest.mark.parametrize("value", ["abc", "30010-30000", "0-10", "30000-70000", "30000-", ""])
def test_bad_port_range_plain_startup_error(tmp_path, value):
    with pytest.raises(SystemExit) as stopped:
        create_app(Settings(data_dir=tmp_path, kubeconfig="", port_forward_ports=value))
    assert str(stopped.value) == (
        "Omnikrux can't start: OMNIKRUX_PORT_FORWARD_PORTS must be a range of ports like "
        f"30000-30019 (each from 1 to 65535, the first no larger than the last), not {value!r}."
    )


def test_port_range_from_the_environment(monkeypatch):
    monkeypatch.setenv("OMNIKRUX_PORT_FORWARD_PORTS", "31000-31004")
    assert Settings().forward_ports == range(31000, 31005)
