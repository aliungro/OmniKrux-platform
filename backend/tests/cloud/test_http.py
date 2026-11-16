import asyncio
import socket
from contextlib import asynccontextmanager

import pytest
from aiohttp import web

from omnikrux.cloud.http import CloudError, CloudHttp


@asynccontextmanager
async def serve_cloud_handler(handler):
    app = web.Application()
    app.router.add_route("*", "/{path:.*}", handler)
    runner = web.AppRunner(app)
    await runner.setup()
    try:
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        yield f"http://127.0.0.1:{runner.addresses[0][1]}"
    finally:
        await runner.cleanup()


@pytest.fixture
async def cloud_http():
    http = CloudHttp()
    try:
        yield http
    finally:
        await http.close()


async def test_cloud_http_cannot_reopen_after_close(cloud_http):
    requests = []

    async def reply(request):
        requests.append(request.path)
        return web.json_response({})

    async with serve_cloud_handler(reply) as url:
        await cloud_http.json("GET", f"{url}/first", cloud="Azure", action="sign in")
        await cloud_http.close()
        await cloud_http.close()
        with pytest.raises(CloudError, match="shutting down"):
            await cloud_http.json("GET", f"{url}/late", cloud="Azure", action="sign in")
    assert requests == ["/first"]


@pytest.mark.parametrize(
    ("status", "copy"),
    [
        (
            401,
            (
                "Azure refused access while trying to list clusters: the login wasn't accepted. "
                "Check the login's permissions, then try again."
            ),
        ),
        (
            403,
            (
                "Azure refused access while trying to list clusters: "
                "the login doesn't have permission. Check the login's permissions, then try again."
            ),
        ),
        (
            404,
            (
                "Azure says it doesn't exist while trying to list clusters: "
                "the resource wasn't found. Check the subscription id."
            ),
        ),
        (
            429,
            (
                "Azure is limiting requests while trying to list clusters. "
                "Omnikrux tries again at the next check."
            ),
        ),
        (500, "Azure had a problem while trying to list clusters (500). Try again in a minute."),
    ],
)
async def test_cloud_errors_plain(cloud_http, caplog, status, copy):
    async def fail(request):
        assert (await request.post())["client_secret"] == "request-only-secret"
        return web.json_response(
            {"error": {"code": "untrusted-error-code", "message": "provider-only-secret"}},
            status=status,
        )

    async with serve_cloud_handler(fail) as url:
        with pytest.raises(CloudError) as failure:
            await cloud_http.json(
                "POST",
                url,
                cloud="Azure",
                action="list clusters",
                headers={"Authorization": "Bearer header-only-secret"},
                data={"client_secret": "request-only-secret"},
                id_label="subscription id",
            )
    assert str(failure.value) == copy
    for secret in (
        "request-only-secret",
        "header-only-secret",
        "provider-only-secret",
        "untrusted-error-code",
    ):
        assert secret not in caplog.text


async def test_cloud_text_error_omits_plain_provider_body(cloud_http, caplog):
    async def fail(_request):
        return web.Response(status=403, text="provider-only-secret")

    async with serve_cloud_handler(fail) as url:
        with pytest.raises(CloudError) as failure:
            await cloud_http.text("GET", url, cloud="Azure", action="read cluster")
    assert str(failure.value) == (
        "Azure refused access while trying to read cluster: the login doesn't have permission. "
        "Check the login's permissions, then try again."
    )
    assert "provider-only-secret" not in caplog.text


async def test_cloud_connection_refused_plain(cloud_http):
    with socket.socket() as unopened:
        unopened.bind(("127.0.0.1", 0))
        port = unopened.getsockname()[1]
        with pytest.raises(CloudError) as failure:
            await cloud_http.json(
                "GET", f"http://127.0.0.1:{port}", cloud="Azure", action="list clusters"
            )
    assert str(failure.value) == (
        "Can't reach Azure while trying to list clusters: connection refused. "
        "Check the network, then try again."
    )


async def test_cloud_timeout_plain():
    release = asyncio.Event()

    async def wait(_request):
        await release.wait()
        return web.json_response({})

    http = CloudHttp(timeout=0.05)
    try:
        async with serve_cloud_handler(wait) as url:
            try:
                with pytest.raises(CloudError) as failure:
                    await http.json("GET", url, cloud="Azure", action="list clusters")
            finally:
                release.set()
    finally:
        await http.close()
    assert str(failure.value) == (
        "Azure didn't answer within 20 s while trying to list clusters. Try again in a minute."
    )


@pytest.mark.parametrize("same_origin", [True, False])
async def test_cloud_rejects_authenticated_redirect(cloud_http, same_origin):
    requests = []

    async def redirected(request):
        requests.append((request.path, request.headers.get("Authorization"), await request.text()))
        return web.json_response({})

    async with serve_cloud_handler(redirected) as other_origin:

        async def redirect(request):
            if request.path == "/target":
                return await redirected(request)
            assert request.headers["Authorization"] == "Bearer fake-arm-token"
            assert (await request.post())["client_secret"] == "fake-client-secret"
            return web.Response(
                status=307, headers={"Location": "/target" if same_origin else other_origin}
            )

        async with serve_cloud_handler(redirect) as url:
            with pytest.raises(CloudError, match="redirect"):
                await cloud_http.json(
                    "POST",
                    url,
                    cloud="Azure",
                    action="sign in",
                    headers={"Authorization": "Bearer fake-arm-token"},
                    data={"client_secret": "fake-client-secret"},
                )
    assert requests == []
