"""Debug containers and node shells against the shared fake Kubernetes API, which starts new
containers through its `start_states` on each read of the pod."""

import asyncio
import re

import httpx
import pytest
import yaml
from aiohttp import web

from omnikrux.clusters.registry import SOURCE_UPLOAD
from omnikrux.config import Settings
from omnikrux.exec import api as exec_api
from omnikrux.exec import debug
from omnikrux.exec.debug import (
    DebugError,
    add_debug_container,
    create_node_shell_pod,
    delete_node_shell_pod,
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

    name, target = await add_debug_container(
        api, "demo", "web-a", target="app", image="busybox:1.36"
    )

    assert re.fullmatch(r"debug-[a-z0-9]{5}", name)
    assert target == "app"  # running, so kept
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
    # one read to check the target; then it waited: still being created, then running
    assert reads_of(fake_api, "/api/v1/namespaces/demo/pods/web-a") == 3
    [status] = fake_api.pods[("demo", "web-a")]["status"]["ephemeralContainerStatuses"]
    assert status["name"] == name and "running" in status["state"]


async def test_debug_without_target_and_names_differ(api, fake_api):
    fake_api.pods[("demo", "web-a")] = pod("web-a")

    first, t1 = await add_debug_container(api, "demo", "web-a", target=None, image="busybox:1.36")
    second, t2 = await add_debug_container(api, "demo", "web-a", target="", image="busybox:1.36")

    assert first != second and t1 is t2 is None
    added = [p["spec"]["ephemeralContainers"][0] for p in fake_api.patches]
    assert [c["name"] for c in added] == [first, second]
    assert all("targetContainerName" not in c for c in added)


@pytest.mark.parametrize(
    "state",
    [
        {"waiting": {"reason": "CrashLoopBackOff"}},
        {"terminated": {"reason": "Error", "exitCode": 1}},
        {},
    ],
)
async def test_debug_target_not_running_is_dropped(api, fake_api, state):
    # The kubelet can't start a container that targets one which isn't running
    # ("invalid target container ... is not running"), so the target is left out.
    fake_api.pods[("demo", "crasher")] = pod("crasher", state=state, restarts=5)

    name, target = await add_debug_container(
        api, "demo", "crasher", target="app", image="busybox:1.36"
    )

    assert target is None
    [patch] = fake_api.patches
    [added] = patch["spec"]["ephemeralContainers"]
    assert added["name"] == name and "targetContainerName" not in added


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


async def test_node_shell_whose_create_answer_is_lost_is_deleted(api, fake_api, monkeypatch):
    """The API server created the pod, but the answer never arrived (a client timeout or a
    cancel): the pod must not be left behind."""
    create = fake_api._create_pod

    async def create_then_hang(request, ns):
        await create(request, ns)
        await asyncio.Event().wait()  # the answer never comes

    monkeypatch.setattr(fake_api, "_create_pod", create_then_hang)
    task = asyncio.create_task(create_node_shell_pod(api, "worker", image="busybox:1.36"))
    for _ in range(500):
        if fake_api.created:
            break
        await asyncio.sleep(0.01)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    [created] = fake_api.created
    assert fake_api.deleted == [("default", created["metadata"]["name"])]


async def test_delete_node_shell_pod_is_idempotent(api, fake_api):
    fake_api.pods[("default", "omnikrux-node-shell-abcde")] = node_shell()

    await delete_node_shell_pod(api, "default", "omnikrux-node-shell-abcde")
    await delete_node_shell_pod(api, "default", "omnikrux-node-shell-abcde")  # gone: fine

    assert fake_api.deleted == [("default", "omnikrux-node-shell-abcde")]


async def test_delete_node_shell_pod_needs_the_label(api, fake_api):
    fake_api.pods[("default", "web-a")] = node_shell("web-a", labels={"app": "web"})

    await delete_node_shell_pod(api, "default", "web-a")

    assert fake_api.deleted == [] and ("default", "web-a") in fake_api.pods


# --- HTTP routes ----------------------------------------------------------------------------


async def test_debug_route_returns_container(http, fake_api):
    client, cluster_id = http
    fake_api.pods[("demo", "web-a")] = pod("web-a")

    r = await client.post(
        f"/api/clusters/{cluster_id}/pods/demo/web-a/debug", json={"target": "app"}
    )

    assert r.status_code == 200
    name = r.json()["container"]
    assert r.json() == {"container": name, "target": "app"}
    [patch] = fake_api.patches
    [added] = patch["spec"]["ephemeralContainers"]
    assert added["name"] == name and added["targetContainerName"] == "app"
    assert added["image"] == "registry.local/toolbox:2"  # OMNIKRUX_DEBUG_IMAGE


async def test_debug_route_says_when_target_was_dropped(http, fake_api):
    client, cluster_id = http
    fake_api.pods[("demo", "crasher")] = pod("crasher", state={"waiting": {"reason": "Error"}})

    r = await client.post(
        f"/api/clusters/{cluster_id}/pods/demo/crasher/debug", json={"target": "app"}
    )

    assert r.status_code == 200
    assert r.json() == {"container": r.json()["container"], "target": None}


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


async def test_node_shell_pod_deleted_when_it_cannot_be_read(
    app, fake_api, fake_channel, monkeypatch
):
    """The pod read fails (the API server hiccups): the session ends, and the pod still goes,
    through a delete that only matches it while it carries the node-shell label."""
    fake_api.pods[("default", "omnikrux-node-shell-abcde")] = node_shell()
    fake_api.pods[("default", "web-a")] = node_shell("web-a", labels={"app": "web"})

    def unavailable(key):
        body = {"kind": "Status", "status": "Failure", "code": 503, "message": "etcd is down"}
        return web.json_response(body, status=503)

    monkeypatch.setattr(fake_api, "_pod_or_404", unavailable)
    for name in ("omnikrux-node-shell-abcde", "web-a"):
        ws = BrowserSocket(app[0])
        await start_shell(app, ws, name, cleanup_pod=True)
        assert ws.sent[0]["type"] == "error" and ws.closed == (1011, None)

    assert fake_api.deleted == [("default", "omnikrux-node-shell-abcde")]  # not web-a
    assert not fake_channel.closed and fake_channel.stdin == []  # no shell was opened


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

    assert ws.sent == [{"type": "exit", "code": 0, "message": None, "cannot_run": False}]
    assert fake_api.deleted == []


# --- node-shell default command -------------------------------------------------------------


async def test_node_shell_exec_defaults_to_nsenter(app, fake_api):
    fake_api.pods[("default", "omnikrux-node-shell-abcde")] = node_shell()
    ws = BrowserSocket(app[0])
    handler = start_shell(app, ws, "omnikrux-node-shell-abcde")
    ws.type({"type": "stdin", "data": "exit 0"})
    await handler

    [call] = fake_api.execs
    assert (call["container"], call["command"]) == ("shell", NSENTER)


async def test_node_shell_explicit_command_wins(app, fake_api):
    fake_api.pods[("default", "omnikrux-node-shell-abcde")] = node_shell()
    ws = BrowserSocket(app[0])
    handler = start_shell(app, ws, "omnikrux-node-shell-abcde", command=["sh"])
    ws.type({"type": "stdin", "data": "exit 0"})
    await handler

    [call] = fake_api.execs
    assert call["command"] == ["sh"]


async def test_other_pods_keep_default_command(app, fake_api):
    fake_api.pods[("default", "web-a")] = node_shell("web-a", labels={"app": "web"})
    ws = BrowserSocket(app[0])
    handler = start_shell(app, ws, "web-a")
    ws.type({"type": "stdin", "data": "exit 0"})
    await handler

    [call] = fake_api.execs
    assert call["command"] == exec_api.DEFAULT_COMMAND


# --- cross-origin writes --------------------------------------------------------------------


async def test_cross_origin_node_shell_refused(http, fake_api):
    client, cluster_id = http

    r = await client.post(
        f"/api/clusters/{cluster_id}/nodes/worker-1/shell",
        headers={"origin": "http://evil.example"},
    )

    assert r.status_code == 403
    assert r.json() == {"detail": "Cross-origin request refused"}
    assert fake_api.created == []


@pytest.mark.parametrize("origin", [None, "http://testserver"])
async def test_same_origin_or_no_origin_node_shell_proceeds(http, fake_api, origin):
    client, cluster_id = http
    headers = {"origin": origin} if origin else {}

    r = await client.post(f"/api/clusters/{cluster_id}/nodes/worker-1/shell", headers=headers)

    assert r.status_code == 200
    assert len(fake_api.created) == 1
