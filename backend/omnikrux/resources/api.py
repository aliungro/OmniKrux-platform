"""Per-resource calls for the inspector: describe and YAML for a pod, and the containers a
shell can be opened into (a debug container in a pod, a node-shell pod on a node)."""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack

from fastapi import APIRouter, HTTPException, Request
from kubernetes_asyncio.client import ApiClient, AppsV1Api, BatchV1Api, CoreV1Api
from kubernetes_asyncio.client.exceptions import ApiException
from pydantic import BaseModel

from omnikrux.actions import authz
from omnikrux.actions.authz import NotAllowed
from omnikrux.actions.pipeline import dump_yaml
from omnikrux.audit.store import (
    AuditEntry,
    AuditLog,
    AuditUnavailable,
    actor_of,
    no_audit_message,
)
from omnikrux.exec.debug import (
    NODE_SHELL_NAMESPACE,
    DebugError,
    add_debug_container,
    create_node_shell_pod,
    finish_even_if_cancelled,
    new_debug_container_name,
    new_node_shell_pod_name,
)
from omnikrux.kube.connections import kube_error_message
from omnikrux.kube.http import read_json
from omnikrux.kube.pods import REQUEST_TIMEOUT, read_pod
from omnikrux.resources.describe import OwnerRef, PodDescribe, describe_pod

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/clusters/{cluster_id}")

CANCELLED = "The request stopped before the cluster answered."


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
        pod = await read_pod(api, namespace, name, timeout=REQUEST_TIMEOUT)
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
        pod = await read_pod(api, namespace, name, timeout=REQUEST_TIMEOUT)
        (pod.get("metadata") or {}).pop("managedFields", None)
        return {"yaml": dump_yaml(pod)}

    return await _call(request, cluster_id, f"read pod {namespace}/{name} as YAML", run)


class DebugRequest(BaseModel):
    target: str | None = None  # the container whose processes the debug container sees


class DebugOut(BaseModel):
    container: str
    # The container whose processes it sees; None when none was asked for, or when the one
    # asked for wasn't running (then it isn't attached to that container's processes).
    target: str | None


async def _begin_audit(
    request: Request, entry: AuditEntry, object_kind: str, object_name: str
) -> int:
    """Check the cluster and the actor, then write the `started` record (no audit, no change).
    `object_kind`/`object_name`: what is authorized (a node shell is authorized on its node)."""
    try:
        await request.app.state.registry.get(entry.cluster_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Unknown cluster") from exc
    try:
        await authz.authorize(
            entry.actor,
            entry.action,
            entry.cluster_id,
            entry.namespace if object_kind == "pods" else None,
            object_kind,
            object_name,
        )
    except NotAllowed as exc:
        raise HTTPException(status_code=403, detail=exc.message) from exc
    try:
        return await request.app.state.audit.begin(entry)
    except AuditUnavailable as exc:
        raise HTTPException(status_code=503, detail=no_audit_message(exc)) from exc


async def _audited_call[T](
    request: Request,
    audit_id: int,
    cluster_id: str,
    action: str,
    fn: Callable[[ApiClient], Awaitable[T]],
) -> T:
    """`_call`, finishing the audit record `failed` (with the same words) if it fails."""
    audit: AuditLog = request.app.state.audit
    try:
        return await _call(request, cluster_id, action, fn)
    except HTTPException as exc:
        await audit.finish(audit_id, "failed", exc.detail)
        raise
    except BaseException:  # cancelled: whether it happened isn't known
        await finish_even_if_cancelled(audit.finish(audit_id, "unknown", CANCELLED))
        raise


@router.post("/pods/{namespace}/{name}/debug")
async def debug_container(
    cluster_id: str, namespace: str, name: str, body: DebugRequest, request: Request
) -> DebugOut:
    image = request.app.state.settings.debug_image
    container = new_debug_container_name()
    entry = AuditEntry(
        actor=actor_of(request),
        action="debug_container",
        cluster_id=cluster_id,
        namespace=namespace,
        kind="pods",
        name=name,
        details={"container": container, "target": body.target},
    )
    audit_id = await _begin_audit(request, entry, "pods", name)

    async def run(api: ApiClient) -> DebugOut:
        added, target = await add_debug_container(
            api, namespace, name, target=body.target, image=image, name=container
        )
        return DebugOut(container=added, target=target)

    out = await _audited_call(
        request, audit_id, cluster_id, f"add a debug container to pod {namespace}/{name}", run
    )
    message = f"Debug container {out.container} started."
    if body.target and out.target is None:
        message += f" Container {body.target} wasn't running, so it isn't attached to it."
    await request.app.state.audit.finish(audit_id, "succeeded", message)
    return out


@router.post("/nodes/{node}/shell")
async def node_shell(cluster_id: str, node: str, request: Request) -> dict[str, str]:
    """The pod's audit record stays `started` while the pod exists: the shell session's cleanup
    finishes it when it deletes the pod (see `exec.api`)."""
    image = request.app.state.settings.debug_image
    pod_name = new_node_shell_pod_name()
    entry = AuditEntry(
        actor=actor_of(request),
        action="node_shell",
        cluster_id=cluster_id,
        namespace=NODE_SHELL_NAMESPACE,
        kind="pods",
        name=pod_name,
        details={"node": node},
    )
    audit_id = await _begin_audit(request, entry, "nodes", node)

    async def run(api: ApiClient) -> dict[str, str]:
        namespace, pod, container = await create_node_shell_pod(
            api, node, image=image, name=pod_name
        )
        return {"namespace": namespace, "pod": pod, "container": container}

    return await _audited_call(request, audit_id, cluster_id, f"start a node shell on {node}", run)
