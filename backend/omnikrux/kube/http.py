"""Raw (`_preload_content=False`) Kubernetes calls: plain JSON dicts, errors as ApiException."""

import json
from collections.abc import Awaitable

import aiohttp
from kubernetes_asyncio.client.exceptions import ApiException

# What a Kubernetes call can raise for the cluster's (or the network's) reasons.
KUBE_ERRORS = (ApiException, aiohttp.ClientError, TimeoutError)


async def read_json(call: Awaitable) -> dict:
    """Await a `_preload_content=False` call; raise ApiException for a non-2xx answer."""
    resp = await call
    try:
        body = await resp.read()
    finally:
        resp.release()
    if not 200 <= resp.status < 300:
        exc = ApiException(status=resp.status, reason=resp.reason)
        exc.body = body.decode("utf-8", "replace")
        raise exc
    return json.loads(body)


def status_message(body: bytes) -> str | None:
    """The `message` of a Kubernetes Status body; None when the body isn't one (e.g. HTML)."""
    try:
        data = json.loads(body)
    except ValueError:
        return None
    message = data.get("message") if isinstance(data, dict) else None
    return message if isinstance(message, str) and message else None
