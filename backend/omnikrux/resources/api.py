"""Per-resource calls for the inspector: describe and YAML for a pod and for any other kind, a
Secret's value one key at a time (audited, never cached), and the containers a shell can be
opened into (a debug container in a pod, a node-shell pod on a node)."""

import asyncio
import base64
import binascii
import logging
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from kubernetes_asyncio.client import ApiClient, AppsV1Api, BatchV1Api, CoreV1Api
from kubernetes_asyncio.client.exceptions import ApiException
from pydantic import BaseModel, ConfigDict, Field

from omnikrux.actions import authz
from omnikrux.actions.authz import NotAllowed
from omnikrux.actions.workloads import Revision, deployment_revisions
from omnikrux.audit.store import (
    NO_AUDIT,
    AuditEntry,
    AuditLog,
    AuditUnavailable,
    actor_of,
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
from omnikrux.resources.catalog import KindNotServed
from omnikrux.resources.describe import OwnerRef, PodDescribe, describe_pod
from omnikrux.resources.describe_any import (
    RelatedList,
    ResourceDescribe,
    describe_resource,
    event_uids,
    related_lists,
)
from omnikrux.resources.kinds import (
    KindSpec,
    matches_selector,
    object_name_problem,
    target_problem,
)
from omnikrux.resources.yaml_out import dump_yaml, is_secret_resource

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/clusters/{cluster_id}")

CANCELLED = "The request stopped before the cluster answered."
NO_KEY = "Secret {name} has no key {key}."
NOT_SELECTED = "{label} {where} not found: that object doesn't have the label {selector}."
UNRECORDED = "The value isn't shown: the audit log couldn't record the reveal. Try again."
NO_REVEAL = "The value isn't shown: the audit log can't be written ({reason})."
# A revealed value is kept by no cache: not the browser's, not a proxy's.
NO_STORE = {"Cache-Control": "no-store", "Pragma": "no-cache"}


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
        except HTTPException:  # `fn` already said it in words
            raise
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


async def _get_json(api: ApiClient, path: str, params: tuple[tuple[str, str], ...] = ()) -> dict:
    """GET a Kubernetes path as plain JSON; a non-2xx answer raises ApiException."""
    return await read_json(
        api.call_api(
            path,
            "GET",
            query_params=list(params),
            header_params={"Accept": "application/json"},
            auth_settings=["BearerToken"],
            _preload_content=False,
            _return_http_data_only=True,
            _request_timeout=REQUEST_TIMEOUT,
        )
    )


async def _kind_spec(request: Request, cluster_id: str, kind_key: str) -> KindSpec:
    try:
        return await request.app.state.catalog.spec(cluster_id, kind_key)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Unknown cluster") from exc
    except KindNotServed as exc:
        raise HTTPException(status_code=404, detail=exc.message) from exc
    except Exception as exc:  # unreachable, or discovery failed: said in words
        detail = kube_error_message(exc, "read which kinds the cluster serves")
        raise HTTPException(status_code=502, detail=detail) from exc


async def _target(
    request: Request, cluster_id: str, kind_key: str, name: str, namespace: str
) -> tuple[KindSpec, str | None, str]:
    """The kind's spec, the namespace (None for a cluster-scoped kind) and "ns/name" for words."""
    spec = await _kind_spec(request, cluster_id, kind_key)
    ns = namespace or None
    if (problem := target_problem(spec, name, ns)) is not None:
        raise HTTPException(status_code=422, detail=problem)
    return spec, ns, f"{ns}/{name}" if ns else name


async def _events(api: ApiClient, spec: KindSpec, obj: dict, namespace: str | None) -> list[dict]:
    path = f"/api/v1/namespaces/{namespace}/events" if namespace else "/api/v1/events"
    answers = await asyncio.gather(
        *(
            _get_json(api, path, (("fieldSelector", f"involvedObject.uid={uid}"),))
            for uid in event_uids(spec, obj)
        )
    )
    found: dict[str, dict] = {}
    for answer in answers:
        for event in answer.get("items") or []:
            found.setdefault((event.get("metadata") or {}).get("uid") or str(id(event)), event)
    return list(found.values())


async def _read_object(api: ApiClient, spec: KindSpec, namespace: str | None, name: str) -> dict:
    """The object; a 404 in words when it lacks the spec's labels (a Secret that isn't a Helm
    release, read as one)."""
    obj = await _get_json(api, spec.object_path(namespace, name))
    if not matches_selector(spec, obj):
        where = f"{namespace}/{name}" if namespace else name
        detail = NOT_SELECTED.format(label=spec.label, where=where, selector=spec.label_selector)
        raise HTTPException(status_code=404, detail=detail)
    return obj


async def _related(api: ApiClient, wanted: RelatedList) -> list[dict] | str:
    """The list's items, or why it couldn't be read (the describe is still worth showing)."""
    try:
        return (await _get_json(api, wanted.path, wanted.params)).get("items") or []
    except Exception as exc:  # noqa: BLE001 (said in the section's note)
        return kube_error_message(exc, wanted.what)


@router.get("/resources/{kind_key}/{name}/describe")
async def describe_any(
    cluster_id: str, kind_key: str, name: str, request: Request, namespace: str = ""
) -> ResourceDescribe:
    spec, ns, where = await _target(request, cluster_id, kind_key, name, namespace)

    async def events_of(api: ApiClient, obj: dict) -> list[dict] | Exception:
        try:
            return await _events(api, spec, obj, ns)
        except Exception as exc:  # noqa: BLE001 (the object is still worth showing; say why)
            return exc

    async def run(api: ApiClient) -> ResourceDescribe:
        obj = await _read_object(api, spec, ns, name)
        wanted = related_lists(spec, obj)
        events, *lists = await asyncio.gather(
            events_of(api, obj), *(_related(api, w) for w in wanted)
        )
        pairs = list(zip(wanted, lists, strict=True))
        related = {w.key: items for w, items in pairs if isinstance(items, list)}
        errors = {w.key: why for w, why in pairs if isinstance(why, str)}
        if isinstance(events, Exception):
            out = describe_resource(spec, obj, [], related, errors)
            out.events_error = kube_error_message(events, f"list events for {spec.kind} {where}")
            return out
        return describe_resource(spec, obj, events, related, errors)

    return await _call(request, cluster_id, f"describe {spec.kind} {where}", run)


@router.get("/resources/{kind_key}/{name}/yaml")
async def resource_yaml(
    cluster_id: str, kind_key: str, name: str, request: Request, namespace: str = ""
) -> dict[str, str]:
    """The object as the API returns it, without managedFields; a Secret's values masked."""
    spec, ns, where = await _target(request, cluster_id, kind_key, name, namespace)

    async def run(api: ApiClient) -> dict[str, str]:
        obj = await _read_object(api, spec, ns, name)
        (obj.get("metadata") or {}).pop("managedFields", None)
        return {"yaml": dump_yaml(obj, secret=is_secret_resource(spec))}

    return await _call(request, cluster_id, f"read {spec.kind} {where} as YAML", run)


@router.get("/deployments/{namespace}/{name}/revisions")
async def revisions(cluster_id: str, namespace: str, name: str, request: Request) -> list[Revision]:
    """The deployment's revisions (its ReplicaSets), newest first."""
    spec, ns, where = await _target(request, cluster_id, "deployments.apps", name, namespace)

    async def run(api: ApiClient) -> list[Revision]:
        return await deployment_revisions(api, await _read_object(api, spec, ns, name))

    return await _call(request, cluster_id, f"list the revisions of deployment {where}", run)


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
    request: Request,
    entry: AuditEntry,
    object_kind: str,
    object_name: str,
    *,
    refused: str = NO_AUDIT,
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
            None if object_kind == "nodes" else entry.namespace,
            object_kind,
            object_name,
        )
    except NotAllowed as exc:
        raise HTTPException(status_code=403, detail=exc.message) from exc
    try:
        return await request.app.state.audit.begin(entry)
    except AuditUnavailable as exc:
        raise HTTPException(status_code=503, detail=refused.format(reason=exc.reason)) from exc


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
        await audit.finish(audit_id, "failed", str(exc.detail))
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


class RevealIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str = Field(min_length=1)


class RevealOut(BaseModel):
    key: str
    value: str
    encoding: Literal["utf-8", "base64"]  # base64: the value isn't UTF-8 text


def _decoded(encoded: str) -> tuple[str, Literal["utf-8", "base64"]]:
    try:
        return base64.b64decode(encoded, validate=True).decode("utf-8"), "utf-8"
    except (binascii.Error, ValueError):  # UnicodeDecodeError is a ValueError
        return encoded, "base64"


@router.post("/secrets/{namespace}/{name}/reveal")
async def reveal_secret(
    cluster_id: str,
    namespace: str,
    name: str,
    body: RevealIn,
    request: Request,
    response: Response,
) -> RevealOut:
    """One key's value: a POST (never in a URL), answered `no-store`, audited by key name only.
    No audit, no reveal: the Secret isn't read until its record is written."""
    entry = AuditEntry(
        actor=actor_of(request),
        action="secret_reveal",
        cluster_id=cluster_id,
        namespace=namespace,
        kind="secrets",
        name=name,
        details={"key": body.key},
    )
    # The names go into the API path unencoded: "db?x" would read Secret db.
    if (problem := object_name_problem(name, namespace)) is not None:
        raise HTTPException(status_code=422, detail=problem)
    audit: AuditLog = request.app.state.audit
    audit_id = await _begin_audit(request, entry, "secrets", name, refused=NO_REVEAL)

    async def run(api: ApiClient) -> str | None:
        secret = await _get_json(api, f"/api/v1/namespaces/{namespace}/secrets/{name}")
        value = (secret.get("data") or {}).get(body.key)
        return value if isinstance(value, str) else None

    words = f"reveal a key of secret {namespace}/{name}"
    encoded = await _audited_call(request, audit_id, cluster_id, words, run)
    if encoded is None:
        message = NO_KEY.format(name=name, key=body.key)
        await audit.finish(audit_id, "failed", message)
        raise HTTPException(status_code=404, detail=message)
    if not await audit.finish(audit_id, "succeeded", f"Key {body.key} revealed."):
        # Not on record as revealed: the value is withheld (the row is marked unknown later).
        raise HTTPException(status_code=503, detail=UNRECORDED)
    value, encoding = _decoded(encoded)
    response.headers.update(NO_STORE)
    return RevealOut(key=body.key, value=value, encoding=encoding)
