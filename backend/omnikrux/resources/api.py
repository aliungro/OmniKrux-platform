"""Per-resource calls for the inspector: describe and YAML for a pod, and the containers a
shell can be opened into (a debug container in a pod, a node-shell pod on a node)."""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack

import yaml
from fastapi import APIRouter, HTTPException, Request
from kubernetes_asyncio.client import ApiClient, AppsV1Api, BatchV1Api, CoreV1Api
from kubernetes_asyncio.client.exceptions import ApiException
from pydantic import BaseModel

from omnikrux.exec.debug import DebugError, add_debug_container, create_node_shell_pod
from omnikrux.kube.connections import kube_error_message
from omnikrux.kube.http import read_json
from omnikrux.resources.describe import OwnerRef, PodDescribe, describe_pod

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


# The workloads that own pods through a label selector, and how to read each one.
OWNER_READERS: dict[str, Callable[[ApiClient], Callable[..., Awaitable]]] = {
    "ReplicaSet": lambda api: AppsV1Api(api).read_namespaced_replica_set,
    "Deployment": lambda api: AppsV1Api(api).read_namespaced_deployment,
    "StatefulSet": lambda api: AppsV1Api(api).read_namespaced_stateful_set,
    "DaemonSet": lambda api: AppsV1Api(api).read_namespaced_daemon_set,
    "Job": lambda api: BatchV1Api(api).read_namespaced_job,
}


async def _owner_selector(api: ApiClient, namespace: str, owner: OwnerRef) -> str | None:
    """The owner's matchLabels as "k=v,k2=v2"; None when it has none or can't be read."""
    reader = OWNER_READERS.get(owner.kind)
    if reader is None:
        return None
    try:
        body = await read_json(
            reader(api)(
                owner.name, namespace, _preload_content=False, _request_timeout=REQUEST_TIMEOUT
            )
        )
    except Exception as exc:  # noqa: BLE001 (describe never fails over this)
        log.info("Could not read %s %s/%s (%s)", owner.kind, namespace, owner.name, exc)
        return None
    selector = (body.get("spec") or {}).get("selector") or {}
    labels = selector.get("matchLabels") or {}
    # matchExpressions can't be said as k=v; matchLabels alone would select too many pods.
    if not labels or selector.get("matchExpressions"):
        return None
    return ",".join(f"{k}={v}" for k, v in labels.items())


@router.get("/pods/{namespace}/{name}/describe")
async def describe(cluster_id: str, namespace: str, name: str, request: Request) -> PodDescribe:
    async def events_of(api: ApiClient, uid: str) -> dict | Exception:
        try:
            return await read_json(
                CoreV1Api(api).list_namespaced_event(
                    namespace,
                    field_selector=f"involvedObject.uid={uid}",
                    _preload_content=False,
                    _request_timeout=REQUEST_TIMEOUT,
                )
            )
        except Exception as exc:  # noqa: BLE001 (the pod is still worth showing; say why)
            return exc

    async def no_selector() -> None:
        return None

    async def run(api: ApiClient) -> PodDescribe:
        pod = await _read_pod(api, namespace, name)
        uid = (pod.get("metadata") or {}).get("uid", "")
        owner = describe_pod(pod, []).pod.owner
        events, selector = await asyncio.gather(
            events_of(api, uid),
            _owner_selector(api, namespace, owner) if owner else no_selector(),
        )
        if isinstance(events, Exception):
            out = describe_pod(pod, [])
            out.events_error = kube_error_message(events, f"list events for pod {namespace}/{name}")
        else:
            out = describe_pod(pod, events.get("items") or [])
        if out.pod.owner:
            out.pod.owner.selector = selector
        return out

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


class DebugOut(BaseModel):
    container: str
    # The container whose processes it sees; None when none was asked for, or when the one
    # asked for wasn't running (then it isn't attached to that container's processes).
    target: str | None


@router.post("/pods/{namespace}/{name}/debug")
async def debug_container(
    cluster_id: str, namespace: str, name: str, body: DebugRequest, request: Request
) -> DebugOut:
    image = request.app.state.settings.debug_image

    async def run(api: ApiClient) -> DebugOut:
        container, target = await add_debug_container(
            api, namespace, name, target=body.target, image=image
        )
        return DebugOut(container=container, target=target)

    return await _call(request, cluster_id, f"add a debug container to pod {namespace}/{name}", run)


@router.post("/nodes/{node}/shell")
async def node_shell(cluster_id: str, node: str, request: Request) -> dict[str, str]:
    image = request.app.state.settings.debug_image

    async def run(api: ApiClient) -> dict[str, str]:
        namespace, pod, container = await create_node_shell_pod(api, node, image=image)
        return {"namespace": namespace, "pod": pod, "container": container}

    return await _call(request, cluster_id, f"start a node shell on {node}", run)
