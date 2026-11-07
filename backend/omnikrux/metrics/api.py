"""Metrics routes: every cluster's usage at once, and one pod's or one node's with its context."""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Literal
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from kubernetes_asyncio.client import ApiClient
from kubernetes_asyncio.client.exceptions import ApiException

from omnikrux.kube.connections import kube_error_message
from omnikrux.kube.http import call_json
from omnikrux.kube.pods import REQUEST_TIMEOUT
from omnikrux.metrics.cache import MetricsCache
from omnikrux.metrics.client import failure_of, fetch_one, is_stale, parse_window
from omnikrux.metrics.models import (
    ClusterMetrics,
    ContainerUsage,
    MetricsOut,
    NodeMetrics,
    PodMetrics,
)
from omnikrux.resources.quantity import parse_bytes, parse_cpu_m

log = logging.getLogger(__name__)

router = APIRouter()


@router.get("/api/metrics/{kind}")
async def metrics(kind: Literal["pods", "nodes"], request: Request) -> MetricsOut:
    cache: MetricsCache = request.app.state.metrics
    clusters = await request.app.state.registry.list()
    answers = await asyncio.gather(*(cache.get(c.id, kind) for c in clusters))
    out: dict[str, ClusterMetrics] = {c.id: answer for c, answer in zip(clusters, answers)}
    return MetricsOut(kind=kind, clusters=out)


async def _read_object[T](
    request: Request, cluster_id: str, what: str, fn: Callable[[ApiClient], Awaitable[T]]
) -> T:
    """Run `fn(api)`; a failure of the object read inside it is a plain 404 / 502 `detail`."""
    try:
        async with request.app.state.connections.api(cluster_id) as api:
            return await fn(api)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Unknown cluster") from exc
    except ApiException as exc:
        status = 404 if exc.status == 404 else 502
        raise HTTPException(status_code=status, detail=kube_error_message(exc, what)) from exc
    except HTTPException:
        raise
    except Exception as exc:  # never a traceback or raw body to the browser
        log.warning("Could not %s (%s)", what, type(exc).__name__)
        raise HTTPException(status_code=502, detail=kube_error_message(exc, what)) from exc


async def _metrics_or_failure(
    api: ApiClient, kind: str, namespace: str | None, name: str
) -> tuple[dict | None, tuple[str, str] | None]:
    try:
        return await fetch_one(api, kind, namespace, name, timeout=REQUEST_TIMEOUT), None
    except Exception as exc:  # noqa: BLE001 (becomes the state and words of the answer)
        return None, failure_of(exc)


def _quantity(parse, resources: dict, field: str, resource: str) -> int | None:
    value = (resources.get(field) or {}).get(resource)
    try:
        return parse(value) if value is not None else None
    except ValueError:
        return None


def _container_usage(name: str, usage: dict, spec: dict) -> ContainerUsage:
    resources = spec.get("resources") or {}
    return ContainerUsage(
        name=name,
        cpu_m=parse_cpu_m(usage.get("cpu", "0")),
        memory_b=parse_bytes(usage.get("memory", "0")),
        cpu_request_m=_quantity(parse_cpu_m, resources, "requests", "cpu"),
        cpu_limit_m=_quantity(parse_cpu_m, resources, "limits", "cpu"),
        memory_request_b=_quantity(parse_bytes, resources, "requests", "memory"),
        memory_limit_b=_quantity(parse_bytes, resources, "limits", "memory"),
    )


@router.get("/api/clusters/{cluster_id}/pods/{namespace}/{name}/metrics")
async def pod_metrics(cluster_id: str, namespace: str, name: str, request: Request) -> PodMetrics:
    async def read(api: ApiClient) -> PodMetrics:
        pod = await call_json(
            api,
            "GET",
            f"/api/v1/namespaces/{quote(namespace, safe='')}/pods/{quote(name, safe='')}",
            timeout=REQUEST_TIMEOUT,
        )
        fetched = datetime.now(UTC)
        body, failure = await _metrics_or_failure(api, "pods", namespace, name)
        if body is None:
            state, message = failure
            return PodMetrics(state=state, message=message)
        specs = {c.get("name"): c for c in (pod.get("spec") or {}).get("containers") or []}
        containers = [
            _container_usage(c.get("name", ""), c.get("usage") or {}, specs.get(c.get("name"), {}))
            for c in body.get("containers") or []
        ]
        return PodMetrics(
            state="ok",
            at=str(body.get("timestamp") or ""),
            window_s=parse_window(body.get("window")),
            stale=is_stale(body.get("timestamp"), fetched),
            containers=containers,
        )

    return await _read_object(request, cluster_id, "read the pod", read)


@router.get("/api/clusters/{cluster_id}/nodes/{name}/metrics")
async def node_metrics(cluster_id: str, name: str, request: Request) -> NodeMetrics:
    async def read(api: ApiClient) -> NodeMetrics:
        node = await call_json(
            api, "GET", f"/api/v1/nodes/{quote(name, safe='')}", timeout=REQUEST_TIMEOUT
        )
        status = node.get("status") or {}
        sizes = {
            "allocatable_cpu_m": _quantity(parse_cpu_m, status, "allocatable", "cpu"),
            "allocatable_memory_b": _quantity(parse_bytes, status, "allocatable", "memory"),
            "capacity_cpu_m": _quantity(parse_cpu_m, status, "capacity", "cpu"),
            "capacity_memory_b": _quantity(parse_bytes, status, "capacity", "memory"),
        }
        fetched = datetime.now(UTC)
        body, failure = await _metrics_or_failure(api, "nodes", None, name)
        if body is None:
            state, message = failure
            return NodeMetrics(state=state, message=message, **sizes)
        usage = body.get("usage") or {}
        return NodeMetrics(
            state="ok",
            at=str(body.get("timestamp") or ""),
            window_s=parse_window(body.get("window")),
            stale=is_stale(body.get("timestamp"), fetched),
            cpu_m=parse_cpu_m(usage.get("cpu", "0")),
            memory_b=parse_bytes(usage.get("memory", "0")),
            **sizes,
        )

    return await _read_object(request, cluster_id, "read the node", read)
