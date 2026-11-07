"""Per-resource calls for the inspector: describe and YAML for a pod, and the containers a
shell can be opened into (a debug container in a pod, a node-shell pod on a node)."""

import logging
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack

import yaml
from fastapi import APIRouter, HTTPException, Request
from kubernetes_asyncio.client import ApiClient, CoreV1Api
from kubernetes_asyncio.client.exceptions import ApiException
from pydantic import BaseModel

from omnikrux.exec.debug import DebugError, add_debug_container, create_node_shell_pod
from omnikrux.kube.connections import kube_error_message
from omnikrux.kube.http import read_json
from omnikrux.resources.describe import PodDescribe, describe_pod

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/clusters/{cluster_id}")

REQUEST_TIMEOUT = 15  # seconds per Kubernetes call: a hung cluster gets a plain answer


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
        except DebugError as exc:  # already in words
            raise HTTPException(status_code=502, detail=exc.message) from exc
        except Exception as exc:  # never a traceback or raw body to the browser
            log.warning("Could not %s (%s)", action, type(exc).__name__)
            raise HTTPException(status_code=502, detail=kube_error_message(exc, action)) from exc


async def _read_pod(api: ApiClient, namespace: str, name: str) -> dict:
    return await read_json(
        CoreV1Api(api).read_namespaced_pod(
            name, namespace, _preload_content=False, _request_timeout=REQUEST_TIMEOUT
        )
    )


@router.get("/pods/{namespace}/{name}/describe")
async def describe(cluster_id: str, namespace: str, name: str, request: Request) -> PodDescribe:
    async def run(api: ApiClient) -> PodDescribe:
        pod = await _read_pod(api, namespace, name)
        uid = (pod.get("metadata") or {}).get("uid", "")
        try:
            events = await read_json(
                CoreV1Api(api).list_namespaced_event(
                    namespace,
                    field_selector=f"involvedObject.uid={uid}",
                    _preload_content=False,
                    _request_timeout=REQUEST_TIMEOUT,
                )
            )
        except Exception as exc:  # noqa: BLE001 (the pod is still worth showing; say why)
            out = describe_pod(pod, [])
            out.events_error = kube_error_message(exc, f"list events for pod {namespace}/{name}")
            return out
        return describe_pod(pod, events.get("items") or [])

    return await _call(request, cluster_id, f"describe pod {namespace}/{name}", run)


@router.get("/pods/{namespace}/{name}/yaml")
async def pod_yaml(cluster_id: str, namespace: str, name: str, request: Request) -> dict[str, str]:
    async def run(api: ApiClient) -> dict[str, str]:
        pod = await _read_pod(api, namespace, name)
        (pod.get("metadata") or {}).pop("managedFields", None)
        return {"yaml": yaml.safe_dump(pod, sort_keys=False)}

    return await _call(request, cluster_id, f"read pod {namespace}/{name} as YAML", run)


class DebugRequest(BaseModel):
    target: str | None = None  # the container whose processes the debug container sees


@router.post("/pods/{namespace}/{name}/debug")
async def debug_container(
    cluster_id: str, namespace: str, name: str, body: DebugRequest, request: Request
) -> dict[str, str]:
    image = request.app.state.settings.debug_image

    async def run(api: ApiClient) -> dict[str, str]:
        target = body.target or None
        return {
            "container": await add_debug_container(api, namespace, name, target=target, image=image)
        }

    return await _call(request, cluster_id, f"add a debug container to pod {namespace}/{name}", run)


@router.post("/nodes/{node}/shell")
async def node_shell(cluster_id: str, node: str, request: Request) -> dict[str, str]:
    image = request.app.state.settings.debug_image

    async def run(api: ApiClient) -> dict[str, str]:
        namespace, pod, container = await create_node_shell_pod(api, node, image=image)
        return {"namespace": namespace, "pod": pod, "container": container}

    return await _call(request, cluster_id, f"start a node shell on {node}", run)
