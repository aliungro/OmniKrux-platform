import asyncio
import json
import logging
from urllib.parse import urlencode

import aiohttp
import pytest
from aiohttp import web
from aiohttp.http_exceptions import TransferEncodingError

from omnikrux.exec.api import exec_shell
from tests.exec.test_session import BrowserSocket
from tests.fakekube import serve_fake_api
from tests.logs.test_api import run as run_logs
from tests.logs.test_api import statuses


@pytest.mark.parametrize("operation", ["describe", "exec"])
async def test_cloud_kubernetes_refuses_redirects_with_echoed_bearer(
    operation, cloud_cluster, cloud_http_client, fake_api, monkeypatch, caplog
):
    app, cluster, _ = cloud_cluster
    route = fake_api._route
    target = "/api/v1/namespaces/demo/pods/web-1"
    if operation == "exec":
        target += "/exec"
    private_host = "private-redirect-api.example.test"
    tokens = []

    async with serve_fake_api() as other:

        async def redirect(request):
            if request.path == target:
                authorization = request.headers["Authorization"]
                tokens.append(authorization.removeprefix("Bearer "))
                params = urlencode({"auth": authorization, "private_host": private_host})
                return web.Response(status=302, headers={"Location": f"{other.url}/echo?{params}"})
            return await route(request)

        monkeypatch.setattr(fake_api, "_route", redirect)
        with caplog.at_level(logging.DEBUG):
            if operation == "exec":
                ws = BrowserSocket(app)
                await asyncio.wait_for(exec_shell(ws, cluster.id, "demo", "web-1"), 5)
                assert ws.sent[-1]["type"] == "error" and ws.closed == (1011, None)
                published = json.dumps(ws.sent)
            else:
                response = await cloud_http_client.get(
                    f"/api/clusters/{cluster.id}/pods/demo/web-1/describe"
                )
                assert response.status_code == 502
                published = response.text
        assert tokens and not other.requests
    for sensitive in [*tokens, private_host]:
        assert sensitive not in published and sensitive not in caplog.text


@pytest.mark.parametrize("operation", ["describe", "logs"])
@pytest.mark.parametrize("error_type", [aiohttp.ClientPayloadError, TransferEncodingError])
async def test_cloud_kubernetes_late_payload_error_hides_echoed_bearer(
    operation, error_type, cloud_cluster, cloud_http_client, fake_api, monkeypatch, caplog
):
    app, cluster, _ = cloud_cluster
    target = "/api/v1/namespaces/demo/pods/web-1"
    if operation == "logs":
        target += "/log"
        fake_api.logs[("demo", "web-1", "app", False)] = ["workload bytes"]
    private_host = "private-payload-api.example.test"
    tokens = []
    payload_errors = {}
    original_start = aiohttp.ClientResponse.start
    original_read = aiohttp.ClientResponse.read
    original_iter = aiohttp.StreamReader.iter_any

    async def start(response, connection):
        await original_start(response, connection)
        if response.url.path == target:
            assert response.status == 200
            authorization = response.request_info.headers["Authorization"]
            tokens.append(authorization.removeprefix("Bearer "))
            payload_errors[response.content] = error_type(
                f"Invalid chunk from {private_host} with {authorization}"
            )
        return response

    async def read(response):
        if response.content in payload_errors:
            raise payload_errors[response.content]
        return await original_read(response)

    def iter_any(reader):
        chunks = original_iter(reader)
        if reader not in payload_errors:
            return chunks

        async def fail_late():
            async for chunk in chunks:
                yield chunk
            raise payload_errors[reader]

        return fail_late()

    monkeypatch.setattr(aiohttp.ClientResponse, "start", start)
    if operation == "logs":
        monkeypatch.setattr(aiohttp.StreamReader, "iter_any", iter_any)
    else:
        monkeypatch.setattr(aiohttp.ClientResponse, "read", read)
    with caplog.at_level(logging.DEBUG):
        if operation == "logs":
            ws = await run_logs(app, cluster.id, pod="web-1", container="app", follow=False)
            assert statuses(ws)[-1][0] == "error"
            published = json.dumps(ws.sent)
        else:
            response = await cloud_http_client.get(
                f"/api/clusters/{cluster.id}/pods/demo/web-1/describe"
            )
            assert response.status_code == 502
            published = response.text
    assert tokens and "The connection to the cluster failed" in published
    for sensitive in [*tokens, private_host]:
        assert sensitive not in published and sensitive not in caplog.text


async def test_cloud_discovery_ignores_unsafe_group_and_version(
    cloud_cluster, cloud_http_client, fake_api, monkeypatch, caplog
):
    _, cluster, _ = cloud_cluster
    private_host = "private-discovery-api.example.test"
    tokens = []
    route = fake_api._route

    async def discovery(request):
        if request.path != "/apis":
            return await route(request)
        authorization = request.headers["Authorization"]
        tokens.append(authorization.removeprefix("Bearer "))
        body = fake_api._group_list()
        body["groups"] += [
            {
                "name": f"https://{private_host}/{authorization}",
                "preferredVersion": {"version": "v1"},
            },
            {
                "name": "invalid.example.test",
                "preferredVersion": {"version": f"v1?auth={authorization}"},
            },
            {"name": "a" * 64, "preferredVersion": {"version": "v1"}},
            {"name": "too-long.example.test", "preferredVersion": {"version": "v" * 64}},
        ]
        return web.json_response(body)

    monkeypatch.setattr(fake_api, "_route", discovery)
    with caplog.at_level(logging.DEBUG):
        response = await cloud_http_client.get("/api/kinds")
    assert response.status_code == 200
    catalog = response.json()
    assert catalog["clusters"][cluster.id]["state"] == "ok"
    assert catalog["clusters"][cluster.id]["failed_groups"] == {}
    assert "deployments.apps" in {kind["key"] for kind in catalog["kinds"]}
    assert "/apis/apps/v1" in fake_api.paths
    assert tokens
    for sensitive in [*tokens, private_host, "too-long.example.test", "invalid.example.test"]:
        assert sensitive not in response.text
        assert sensitive not in caplog.text
        assert sensitive not in json.dumps(fake_api.requests)
