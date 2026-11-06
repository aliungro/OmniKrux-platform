"""Per-resource reads for the inspector: describe and YAML for a pod."""

import json
import logging
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack

import yaml
from fastapi import APIRouter, HTTPException, Request
from kubernetes_asyncio.client import ApiClient, CoreV1Api
from kubernetes_asyncio.client.exceptions import ApiException

from omnikrux.kube.connections import kube_error_message
from omnikrux.resources.describe import PodDescribe, describe_pod

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/clusters/{cluster_id}")

REQUEST_TIMEOUT = 15  # seconds per Kubernetes call: a hung cluster gets a plain answer


async def _json(call: Awaitable) -> dict:
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


async def _call[T](
    request: Request, cluster_id: str, action: str, fn: Callable[[ApiClient], Awaitable[T]]
) -> T:
    """Run `fn` with the cluster's client; failures become a plain 404 or 502 `detail`."""
    async with AsyncExitStack() as stack:
        try:
            api = await stack.enter_async_context(request.app.state.connections.api(cluster_id))
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Unknown cluster") from exc
        except Exception as exc:  # e.g. a missing exec plugin, said in words
            raise HTTPException(status_code=502, detail=kube_error_message(exc, action)) from exc
        try:
            return await fn(api)
        except ApiException as exc:
            status = 404 if exc.status == 404 else 502
            raise HTTPException(status_code=status, detail=kube_error_message(exc, action)) from exc
        except Exception as exc:  # never a traceback or raw body to the browser
            log.warning("Could not %s (%s)", action, type(exc).__name__)
            raise HTTPException(status_code=502, detail=kube_error_message(exc, action)) from exc


async def _read_pod(api: ApiClient, namespace: str, name: str) -> dict:
    return await _json(
        CoreV1Api(api).read_namespaced_pod(
            name, namespace, _preload_content=False, _request_timeout=REQUEST_TIMEOUT
        )
    )


@router.get("/pods/{namespace}/{name}/describe")
async def describe(cluster_id: str, namespace: str, name: str, request: Request) -> PodDescribe:
    async def run(api: ApiClient) -> PodDescribe:
        pod = await _read_pod(api, namespace, name)
        uid = (pod.get("metadata") or {}).get("uid", "")
        events = await _json(
            CoreV1Api(api).list_namespaced_event(
                namespace,
                field_selector=f"involvedObject.uid={uid}",
                _preload_content=False,
                _request_timeout=REQUEST_TIMEOUT,
            )
        )
        return describe_pod(pod, events.get("items") or [])

    return await _call(request, cluster_id, f"describe pod {namespace}/{name}", run)


@router.get("/pods/{namespace}/{name}/yaml")
async def pod_yaml(cluster_id: str, namespace: str, name: str, request: Request) -> dict[str, str]:
    async def run(api: ApiClient) -> dict[str, str]:
        pod = await _read_pod(api, namespace, name)
        (pod.get("metadata") or {}).pop("managedFields", None)
        return {"yaml": yaml.safe_dump(pod, sort_keys=False)}

    return await _call(request, cluster_id, f"read pod {namespace}/{name} as YAML", run)
