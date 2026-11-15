"""Cloud Kubernetes error bodies reach the callers that decide on them, with credentials removed."""

import asyncio
import json
import logging

from aiohttp import web

from omnikrux.actions import nodes
from omnikrux.actions.jobs import Job
from omnikrux.exec.api import exec_shell
from omnikrux.metrics.client import NO_DATA_YET
from tests.exec.test_session import BrowserSocket
from tests.fakekube import status_body
from tests.logs.test_stream import pod

PRIVATE_HOST = "private-cloud-api.example.test"


def _echo_failure(fake_api, monkeypatch, method, target, kube_status, message, sent):
    """Answer `method target` with a Status whose message echoes the caller's bearer token."""
    route = fake_api._route

    async def refuse(request):
        if (request.method, request.path) != (method, target):
            return await route(request)
        bearer = request.headers["Authorization"]
        sent.append(bearer.removeprefix("Bearer "))
        text = f"{message} (https://{PRIVATE_HOST} saw {bearer})"
        return web.json_response(status_body(kube_status, "Invalid", text), status=kube_status)

    monkeypatch.setattr(fake_api, "_route", refuse)


async def test_cloud_drain_counts_a_replaced_pod_as_gone(cloud_cluster, fake_api, monkeypatch):
    """A same-name replacement answers the uid precondition with 409; the drain must see why."""
    monkeypatch.setattr(nodes, "RETRY_SECONDS", 0.01)
    monkeypatch.setattr(nodes, "POLL_SECONDS", 0.01)
    app, cluster, _ = cloud_cluster
    replacement = pod("web-0", containers=("app",))
    replacement["metadata"]["uid"] = "u-replacement"
    replacement["spec"]["nodeName"] = "worker"
    fake_api.pods[("demo", "web-0")] = replacement
    job = Job(id="drain-cloud", action="drain", actor="test", audit_id=0, cancelled_message="")

    message = await asyncio.wait_for(
        nodes.drain_pods(
            job,
            connections=app.state.connections,
            cluster_id=cluster.id,
            node="worker",
            pods=[{"namespace": "demo", "name": "web-0", "uid": "u-reviewed"}],
            timeout_s=2,
        ),
        timeout=5,
    )

    assert job.done == 1
    assert "1 pods were already gone." in message
    assert ("demo", "web-0") in fake_api.pods  # the replacement is never evicted


async def test_cloud_pod_without_metrics_yet_is_not_called_uninstalled(
    cloud_cluster, cloud_http_client, fake_api
):
    _, cluster, _ = cloud_cluster
    response = await cloud_http_client.get(f"/api/clusters/{cluster.id}/pods/demo/web-1/metrics")
    assert response.status_code == 200, response.text
    assert response.json()["message"] == NO_DATA_YET.format(name="web-1")


async def test_cloud_eviction_refusal_keeps_the_budget_reason(
    cloud_cluster, cloud_http_client, fake_api, monkeypatch, caplog
):
    _, cluster, _ = cloud_cluster
    sent: list[str] = []
    target = {"cluster_id": cluster.id, "kind_key": "pods", "namespace": "demo", "name": "web-1"}
    planned = await cloud_http_client.post(
        "/api/actions/plan", json={"action": "evict", "target": target}
    )
    assert planned.status_code == 200, planned.text
    _echo_failure(
        fake_api,
        monkeypatch,
        "POST",
        "/api/v1/namespaces/demo/pods/web-1/eviction",
        429,
        "Cannot evict pod as it would violate the pod's disruption budget.",
        sent,
    )
    with caplog.at_level(logging.DEBUG):
        applied = await cloud_http_client.post(
            f"/api/actions/{planned.json()['plan_id']}/apply", json={"confirm_text": "web-1"}
        )
    assert applied.status_code == 429, applied.text
    detail = applied.json()["detail"]
    assert "would violate the pod's disruption budget" in detail
    assert sent
    for sensitive in (*sent, PRIVATE_HOST):
        assert sensitive not in applied.text and sensitive not in caplog.text


async def test_cloud_admission_denial_keeps_its_cause(
    cloud_cluster, cloud_http_client, fake_api, monkeypatch, caplog
):
    """A webhook or validation refusal says why, never with the echoed bearer or endpoint."""
    _, cluster, _ = cloud_cluster
    sent: list[str] = []
    target = {"cluster_id": cluster.id, "kind_key": "pods", "namespace": "demo", "name": "web-1"}
    planned = await cloud_http_client.post(
        "/api/actions/plan", json={"action": "delete", "target": target}
    )
    assert planned.status_code == 200, planned.text
    _echo_failure(
        fake_api,
        monkeypatch,
        "DELETE",
        "/api/v1/namespaces/demo/pods/web-1",
        422,
        'admission webhook "policy.example" denied the request: deletes are frozen',
        sent,
    )
    with caplog.at_level(logging.DEBUG):
        applied = await cloud_http_client.post(
            f"/api/actions/{planned.json()['plan_id']}/apply", json={"confirm_text": "web-1"}
        )
    assert "deletes are frozen" in applied.text, applied.text
    assert sent
    for sensitive in (*sent, PRIVATE_HOST):
        assert sensitive not in applied.text and sensitive not in caplog.text


async def test_cloud_shell_that_cannot_start_says_why(cloud_cluster, fake_api, monkeypatch, caplog):
    """The runtime's reason reaches the browser; the token the console sent does not."""
    app, cluster, _ = cloud_cluster
    exec_pod = fake_api._exec
    sent: list[str] = []

    async def cannot_start(request, key):
        token = request.headers["Authorization"].removeprefix("Bearer ")
        sent.append(token)
        text = f'exec: "bash": executable file not found in $PATH (caller {token})'
        fake_api.exec_status = status_body(500, "InternalError", text)
        return await exec_pod(request, key)

    monkeypatch.setattr(fake_api, "_exec", cannot_start)
    ws = BrowserSocket(app)
    with caplog.at_level(logging.DEBUG):
        await asyncio.wait_for(exec_shell(ws, cluster.id, "demo", "web-1"), 5)
    [frame] = ws.sent
    assert frame["type"] == "exit" and frame["cannot_run"]
    assert "executable file not found in $PATH" in frame["message"], frame
    assert sent
    for token in sent:
        assert token not in json.dumps(ws.sent) and token not in caplog.text
