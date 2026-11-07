"""Debug containers and node shells against the shared fake Kubernetes API, which starts new
containers through its `start_states` on each read of the pod."""

import asyncio
import re

import httpx
import pytest
import yaml

from omnikrux.clusters.registry import SOURCE_UPLOAD
from omnikrux.config import Settings
from omnikrux.exec import api as exec_api
from omnikrux.exec import debug
from omnikrux.exec.debug import (
    DebugError,
    add_debug_container,
    create_node_shell_pod,
    delete_pod,
)
from omnikrux.kube.client import make_api_client
from omnikrux.main import create_app
from tests.exec.test_session import BrowserSocket, FakeExecChannel
from tests.fakekube import kubeconfig_for
from tests.logs.test_stream import pod

NSENTER = ["nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "sh"]
NODE_SHELL_LABELS = {"app.kubernetes.io/managed-by": "omnikrux", "omnikrux.dev/node-shell": "true"}


@pytest.fixture(autouse=True)
def fast_polls(monkeypatch):
    monkeypatch.setattr(debug, "POLL_SECONDS", 0.01)


@pytest.fixture
async def api(fake_api):
    client = await make_api_client(kubeconfig_for(fake_api))
    try:
        yield client
    finally:
        await client.close()


@pytest.fixture
async def app(fake_api, tmp_path):
    """The real app and registry, with one uploaded cluster pointing at the fake API."""
    app = create_app(
        Settings(
            data_dir=tmp_path,
            kubeconfig="",
            in_container=False,
            rewrite_loopback=False,
            debug_image="registry.local/toolbox:2",
        )
    )
    async with app.router.lifespan_context(app):
        [info] = await app.state.registry.upsert_from_kubeconfig(
            yaml.safe_dump(kubeconfig_for(fake_api)), rewrite_loopback=False, source=SOURCE_UPLOAD
        )
        yield app, info.id


@pytest.fixture
async def http(app):
    app_, cluster_id = app
    transport = httpx.ASGITransport(app=app_)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client, cluster_id


def reads_of(fake_api, path: str) -> int:
    return sum(1 for method, p, _ in fake_api.requests if method == "GET" and p == path)


# --- debug containers -----------------------------------------------------------------------


async def test_debug_patch_body_and_returns_name(api, fake_api):
    fake_api.pods[("demo", "web-a")] = pod("web-a")

    name = await add_debug_container(api, "demo", "web-a", target="app", image="busybox:1.36")

    assert re.fullmatch(r"debug-[a-z0-9]{5}", name)
    assert fake_api.patches == [
        {
            "spec": {
                "ephemeralContainers": [
                    {
                        "name": name,
                        "image": "busybox:1.36",
                        "command": ["sh"],
                        "stdin": True,
                        "tty": True,
                        "targetContainerName": "app",
                    }
                ]
            }
        }
    ]
    # it waited: the container was still being created on the first read, running on the second
    assert reads_of(fake_api, "/api/v1/namespaces/demo/pods/web-a") == 2
    [status] = fake_api.pods[("demo", "web-a")]["status"]["ephemeralContainerStatuses"]
    assert status["name"] == name and "running" in status["state"]


async def test_debug_without_target_and_names_differ(api, fake_api):
    fake_api.pods[("demo", "web-a")] = pod("web-a")

    first = await add_debug_container(api, "demo", "web-a", target=None, image="busybox:1.36")
    second = await add_debug_container(api, "demo", "web-a", target=None, image="busybox:1.36")

    assert first != second
    added = [p["spec"]["ephemeralContainers"][0] for p in fake_api.patches]
    assert [c["name"] for c in added] == [first, second]
    assert all("targetContainerName" not in c for c in added)


async def test_debug_timeout_plain_message(api, fake_api):
    fake_api.pods[("demo", "web-a")] = pod("web-a")
    fake_api.start_states = [{"waiting": {"reason": "ErrImagePull", "message": "pull failed"}}]

    with pytest.raises(DebugError) as e:
        await add_debug_container(api, "demo", "web-a", target=None, image="nope:1", timeout=0.2)

    assert e.value.message == (
        "The debug container didn't start within 0.2 s (last state: ErrImagePull)."
    )
    assert debug.START_SECONDS == 60


async def test_debug_container_that_stops_fails_without_waiting(api, fake_api):
    fake_api.pods[("demo", "web-a")] = pod("web-a")
    fake_api.start_states = [{"terminated": {"reason": "StartError", "exitCode": 128}}]

    with pytest.raises(DebugError) as e:
        await add_debug_container(api, "demo", "web-a", target=None, image="scratch:1")

    assert e.value.message == "The debug container stopped before it started (StartError)."
    assert reads_of(fake_api, "/api/v1/namespaces/demo/pods/web-a") == 1


# --- node shells ----------------------------------------------------------------------------


async def test_node_shell_pod_spec_exact(api, fake_api):
    namespace, name, container = await create_node_shell_pod(
        api, "kind-control-plane", image="busybox:1.36"
    )

    assert (namespace, container) == ("default", "shell")
    assert re.fullmatch(r"omnikrux-node-shell-[a-z0-9]{5}", name)
    assert fake_api.created == [
        {
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {"name": name, "namespace": "default", "labels": NODE_SHELL_LABELS},
            "spec": {
                "nodeName": "kind-control-plane",
                "hostPID": True,
                "hostNetwork": True,
                "restartPolicy": "Never",
                "activeDeadlineSeconds": 3600,
                "tolerations": [{"operator": "Exists"}],
                "containers": [
                    {
                        "name": "shell",
                        "image": "busybox:1.36",
                        "securityContext": {"privileged": True},
                        "command": NSENTER,
                        "stdin": True,
                        "tty": True,
                    }
                ],
            },
        }
    ]
    # it waited for Running
    assert fake_api.pods[("default", name)]["status"]["phase"] == "Running"
    assert reads_of(fake_api, f"/api/v1/namespaces/default/pods/{name}") == 2


async def test_node_shell_pod_has_active_deadline(api, fake_api):
    _, name, _ = await create_node_shell_pod(api, "worker", image="busybox:1.36")

    [created] = fake_api.created
    assert created["spec"]["activeDeadlineSeconds"] == 3600  # gone after an hour, whatever happens
    assert created["spec"]["restartPolicy"] == "Never"
    assert ("default", name) in fake_api.pods


async def test_node_shell_that_never_starts_is_deleted(api, fake_api):
    fake_api.start_states = [{"waiting": {"reason": "ImagePullBackOff"}}]

    with pytest.raises(DebugError) as e:
        await create_node_shell_pod(api, "worker", image="nope:1", timeout=0.2)

    assert e.value.message == (
        "The node shell didn't start within 0.2 s (last state: ImagePullBackOff)."
    )
    [created] = fake_api.created
    assert fake_api.deleted == [("default", created["metadata"]["name"])]
    assert fake_api.pods.get(("default", created["metadata"]["name"])) is None


async def test_node_shell_cancelled_while_starting_is_deleted(api, fake_api):
    fake_api.start_states = [{"waiting": {"reason": "ContainerCreating"}}]
    task = asyncio.create_task(create_node_shell_pod(api, "worker", image="busybox:1.36"))
    for _ in range(500):
        if fake_api.created:
            break
        await asyncio.sleep(0.01)
    await asyncio.sleep(0.05)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    [created] = fake_api.created
    assert fake_api.deleted == [("default", created["metadata"]["name"])]


async def test_delete_pod_is_idempotent(api, fake_api):
    fake_api.pods[("default", "omnikrux-node-shell-abcde")] = pod("omnikrux-node-shell-abcde")

    await delete_pod(api, "default", "omnikrux-node-shell-abcde")
    await delete_pod(api, "default", "omnikrux-node-shell-abcde")  # already gone: fine

    assert fake_api.deleted == [("default", "omnikrux-node-shell-abcde")]


# --- HTTP routes ----------------------------------------------------------------------------


async def test_debug_route_returns_container(http, fake_api):
    client, cluster_id = http
    fake_api.pods[("demo", "web-a")] = pod("web-a")

    r = await client.post(
        f"/api/clusters/{cluster_id}/pods/demo/web-a/debug", json={"target": "app"}
    )

    assert r.status_code == 200
    name = r.json()["container"]
    [patch] = fake_api.patches
    [added] = patch["spec"]["ephemeralContainers"]
    assert added["name"] == name and added["targetContainerName"] == "app"
    assert added["image"] == "registry.local/toolbox:2"  # OMNIKRUX_DEBUG_IMAGE


async def test_debug_route_errors_are_plain(http, fake_api, monkeypatch):
    client, cluster_id = http
    fake_api.pods[("demo", "web-a")] = pod("web-a")
    url = f"/api/clusters/{cluster_id}/pods/demo/web-a/debug"

    r = await client.post(url, json={"target": "nope"})
    assert r.status_code == 502
    assert r.json() == {
        "detail": 'Couldn\'t add a debug container to pod demo/web-a: Pod "web-a" is invalid: '
        'spec.ephemeralContainers[0].targetContainerName: Not found: "nope"'
    }

    r = await client.post(f"/api/clusters/{cluster_id}/pods/demo/ghost/debug", json={})
    assert r.status_code == 404
    assert r.json()["detail"].startswith("add a debug container to pod demo/ghost: not found")

    monkeypatch.setattr(debug, "START_SECONDS", 0.2)
    fake_api.start_states = [{"waiting": {"reason": "ErrImagePull"}}]
    r = await client.post(url, json={"target": None})
    assert r.status_code == 502
    assert r.json() == {
        "detail": "The debug container didn't start within 0.2 s (last state: ErrImagePull)."
    }

    r = await client.post("/api/clusters/nope/pods/demo/web-a/debug", json={})
    assert r.status_code == 404 and r.json() == {"detail": "Unknown cluster"}


async def test_node_shell_route(http, fake_api):
    client, cluster_id = http

    r = await client.post(f"/api/clusters/{cluster_id}/nodes/worker-1/shell")

    assert r.status_code == 200
    body = r.json()
    assert body["namespace"] == "default" and body["container"] == "shell"
    [created] = fake_api.created
    assert body["pod"] == created["metadata"]["name"]
    assert created["spec"]["nodeName"] == "worker-1"
    assert created["spec"]["containers"][0]["image"] == "registry.local/toolbox:2"


# --- node-shell cleanup over the exec socket ------------------------------------------------


def node_shell(name: str = "omnikrux-node-shell-abcde", labels: dict | None = None) -> dict:
    found = pod(name, containers=("shell",), labels=NODE_SHELL_LABELS if labels is None else labels)
    found["metadata"]["namespace"] = "default"
    return found


@pytest.fixture
def fake_channel(monkeypatch):
    """Exec opens a FakeExecChannel instead of a real stream; the test drives it."""
    channel = FakeExecChannel()

    async def open_channel(*args, **kwargs):
        return channel

    monkeypatch.setattr(exec_api.KubeExecChannel, "open", open_channel)
    return channel


def start_shell(app, ws, name, **params) -> asyncio.Task:
    _, cluster_id = app
    params = {"container": None, "command": None} | params
    return asyncio.create_task(
        asyncio.wait_for(
            exec_api.exec_shell(ws, cluster=cluster_id, namespace="default", pod=name, **params),
            10,
        )
    )


@pytest.mark.parametrize("who", ["browser", "shell"])
async def test_node_shell_pod_deleted_on_close(app, fake_api, fake_channel, who):
    fake_api.pods[("default", "omnikrux-node-shell-abcde")] = node_shell()
    ws = BrowserSocket(app[0])
    handler = start_shell(app, ws, "omnikrux-node-shell-abcde", cleanup_pod=True)
    ws.type({"type": "stdin", "data": "uname -a\r"})
    await asyncio.wait_for(fake_channel.got_input.wait(), 5)
    assert fake_api.deleted == []  # not while the session is open

    if who == "browser":
        ws.leave()
    else:
        fake_channel.finish({"metadata": {}, "status": "Success"})
    await handler

    assert fake_channel.closed
    assert fake_api.deleted == [("default", "omnikrux-node-shell-abcde")]


async def test_node_shell_pod_deleted_when_session_cancelled(app, fake_api, fake_channel):
    fake_api.pods[("default", "omnikrux-node-shell-abcde")] = node_shell()
    ws = BrowserSocket(app[0])
    handler = start_shell(app, ws, "omnikrux-node-shell-abcde", cleanup_pod=True)
    ws.type({"type": "stdin", "data": "top\r"})
    await asyncio.wait_for(fake_channel.got_input.wait(), 5)

    handler.cancel()  # e.g. the backend shutting down
    with pytest.raises(asyncio.CancelledError):
        await handler

    assert fake_api.deleted == [("default", "omnikrux-node-shell-abcde")]


async def test_node_shell_pod_deleted_when_shell_cannot_open(app, fake_api, fake_channel):
    stopped = node_shell()
    stopped["status"]["containerStatuses"][0]["state"] = {"terminated": {"reason": "Error"}}
    fake_api.pods[("default", "omnikrux-node-shell-abcde")] = stopped
    ws = BrowserSocket(app[0])

    await start_shell(app, ws, "omnikrux-node-shell-abcde", cleanup_pod=True)

    assert ws.sent[0]["type"] == "error"
    assert fake_api.deleted == [("default", "omnikrux-node-shell-abcde")]


async def test_cleanup_refuses_unlabelled_pod(app, fake_api, fake_channel):
    fake_api.pods[("default", "web-a")] = node_shell("web-a", labels={"app": "web"})
    ws = BrowserSocket(app[0])

    await start_shell(app, ws, "web-a", cleanup_pod=True)

    assert ws.sent == [
        {
            "type": "error",
            "message": "Only node-shell pods are deleted when their session ends, "
            "and pod default/web-a isn't one. Open the shell without cleanup.",
        }
    ]
    assert ws.closed == (1008, None)
    assert fake_api.deleted == [] and ("default", "web-a") in fake_api.pods
    assert not fake_channel.closed and fake_channel.stdin == []  # no shell was opened


async def test_labelled_pod_kept_without_cleanup_flag(app, fake_api, fake_channel):
    fake_api.pods[("default", "omnikrux-node-shell-abcde")] = node_shell()
    ws = BrowserSocket(app[0])
    handler = start_shell(app, ws, "omnikrux-node-shell-abcde")
    fake_channel.finish({"metadata": {}, "status": "Success"})
    await handler

    assert ws.sent == [{"type": "exit", "code": 0, "message": None}]
    assert fake_api.deleted == []
