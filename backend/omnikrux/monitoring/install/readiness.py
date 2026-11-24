"""Waiting for what Helm applied to run: each workload is read by name until it is ready, and
the job says which ones hold it up and why (the first Pod's waiting reason, or why it can't be
scheduled). Helm itself never waits (`--wait` is never passed): this is where the install
waits, in steps the user can follow and cancel."""

import asyncio
import logging
import time
from collections.abc import Callable, Sequence
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from urllib.parse import quote

from kubernetes_asyncio.client import ApiClient
from kubernetes_asyncio.client.exceptions import ApiException

from omnikrux.actions.jobs import Job, JobFailed
from omnikrux.kube.http import call_json
from omnikrux.kube.pods import REQUEST_TIMEOUT
from omnikrux.monitoring.install import messages
from omnikrux.monitoring.install.values import WorkloadRef

log = logging.getLogger(__name__)

READY_TIMEOUT_SECONDS = 600.0
READY_INTERVAL_SECONDS = 5.0
MAX_WHY = 200
_PLURAL = {"Deployment": "deployments", "StatefulSet": "statefulsets", "DaemonSet": "daemonsets"}

ApiFor = Callable[[], AbstractAsyncContextManager[ApiClient]]


@dataclass(frozen=True)
class _Seen:
    ready: bool
    why: str


def _int(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def is_ready(kind: str, obj: dict) -> bool:
    """Deployment and StatefulSet: every wanted replica ready. DaemonSet: every Node it should
    run on has a ready Pod (and there is at least one)."""
    spec = obj.get("spec") if isinstance(obj.get("spec"), dict) else {}
    status = obj.get("status") if isinstance(obj.get("status"), dict) else {}
    if kind == "DaemonSet":
        desired = _int(status.get("desiredNumberScheduled"))
        return desired > 0 and _int(status.get("numberReady")) >= desired
    replicas = spec.get("replicas", 1)
    replicas = _int(replicas) if replicas is not None else 1
    return _int(status.get("readyReplicas")) >= replicas


def _one_line(text: str) -> str:
    return " ".join("".join(c if c.isprintable() else " " for c in text).split())


def _trim(text: str) -> str:
    text = _one_line(text)
    return text if len(text) <= MAX_WHY else text[: MAX_WHY - 1].rstrip() + "…"


def pod_reason(pod: dict) -> str | None:
    """Why a Pod isn't running: a container's waiting (or last terminated) reason with its
    message, else `Pending: {why it can't be scheduled}`."""
    status = pod.get("status") if isinstance(pod.get("status"), dict) else {}
    containers = [
        *(status.get("initContainerStatuses") or []),
        *(status.get("containerStatuses") or []),
    ]
    for container in containers:
        if not isinstance(container, dict) or container.get("ready") is True:
            continue
        state = container.get("state") if isinstance(container.get("state"), dict) else {}
        for key in ("waiting", "terminated"):
            detail = state.get(key)
            if isinstance(detail, dict) and isinstance(detail.get("reason"), str):
                message = detail.get("message")
                if isinstance(message, str) and message.strip():
                    return f"{detail['reason']}: {message}"
                return detail["reason"]
    if status.get("phase") == "Pending":
        for condition in status.get("conditions") or []:
            if (
                isinstance(condition, dict)
                and condition.get("type") == "PodScheduled"
                and condition.get("status") == "False"
            ):
                return f"Pending: {condition.get('message') or condition.get('reason') or ''}"
    return None


def _selector(obj: dict) -> str | None:
    spec = obj.get("spec") if isinstance(obj.get("spec"), dict) else {}
    selector = spec.get("selector") if isinstance(spec.get("selector"), dict) else {}
    labels = selector.get("matchLabels")
    if not isinstance(labels, dict) or not labels:
        return None
    return ",".join(f"{k}={v}" for k, v in sorted(labels.items()))


def _read_failed(exc: Exception) -> str:
    """A failed read in words, never the transport's own text."""
    if isinstance(exc, ApiException) and exc.status:
        return messages.READ_REFUSED.format(status=exc.status)
    return messages.READ_NO_ANSWER


async def _why_not(api: ApiClient, namespace: str, obj: dict) -> str:
    selector = _selector(obj)
    if selector is None:
        return messages.NOT_READY_YET
    answer = await call_json(
        api,
        "GET",
        f"/api/v1/namespaces/{quote(namespace, safe='')}/pods",
        timeout=REQUEST_TIMEOUT,
        query=[("labelSelector", selector)],
    )
    items = answer.get("items") if isinstance(answer.get("items"), list) else []
    pods = sorted(
        (p for p in items if isinstance(p, dict)),
        key=lambda p: str((p.get("metadata") or {}).get("name") or ""),
    )
    for pod in pods:
        if (reason := pod_reason(pod)) is not None:
            return reason
    return messages.NOT_READY_YET


async def _look(api: ApiClient, namespace: str, workload: WorkloadRef) -> _Seen:
    path = (
        f"/apis/apps/v1/namespaces/{quote(namespace, safe='')}/{_PLURAL[workload.kind]}/"
        f"{quote(workload.name, safe='')}"
    )
    try:
        obj = await call_json(api, "GET", path, timeout=REQUEST_TIMEOUT)
    except ApiException as exc:
        if exc.status == 404:
            return _Seen(False, messages.NOT_CREATED)
        return _Seen(False, _read_failed(exc))
    if is_ready(workload.kind, obj):
        return _Seen(True, "")
    try:
        return _Seen(False, _trim(await _why_not(api, namespace, obj)))
    except Exception as exc:  # noqa: BLE001 (a failed read only means "not ready yet")
        return _Seen(False, _read_failed(exc))


async def _look_all(
    api_for: ApiFor, namespace: str, workloads: Sequence[WorkloadRef]
) -> list[_Seen]:
    try:
        async with api_for() as api:
            return list(await asyncio.gather(*(_look(api, namespace, w) for w in workloads)))
    except Exception as exc:  # noqa: BLE001 (the cluster didn't answer: try again next time)
        log.info("Reading the install's workloads failed (%s)", type(exc).__name__)
        return [_Seen(False, _read_failed(exc)) for _ in workloads]


def _strip_period(text: str) -> str:
    return text.removesuffix(".")


async def wait_ready(
    api_for: ApiFor,
    namespace: str,
    workloads: Sequence[WorkloadRef],
    job: Job,
    *,
    timeout: float = READY_TIMEOUT_SECONDS,
    interval: float = READY_INTERVAL_SECONDS,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], object] = asyncio.sleep,
) -> None:
    """Read every workload each `interval` seconds until all are ready. While it waits,
    `job.message` names the first that isn't, `job.blocked` lists each that isn't and why, and
    `job.done` counts the ready ones (on top of what it counted before). Past `timeout`:
    JobFailed(INSTALL_NOT_READY). A read that fails is that workload's reason, never the end."""
    if not workloads:
        return
    base = job.done
    counted = 0
    deadline = clock() + timeout
    while True:
        seen = await _look_all(api_for, namespace, workloads)
        ready = sum(1 for s in seen if s.ready)
        counted = max(counted, ready)
        job.done = base + counted
        waiting = [(w, s) for w, s in zip(workloads, seen, strict=True) if not s.ready]
        job.blocked = [
            {"namespace": namespace, "name": f"{w.kind} {w.name}", "message": s.why}
            for w, s in waiting
        ]
        if not waiting:
            job.blocked = []
            return
        first, why = waiting[0][0], waiting[0][1].why
        job.message = messages.STEP_WAIT.format(
            label=first.label, ready=ready, total=len(workloads)
        )
        job.cancelled_message = messages.INSTALL_CANCELLED.format(
            step=step_words(messages.STEP_WAIT_WORDS.format(label=first.label))
        )
        if clock() >= deadline:
            raise JobFailed(
                messages.INSTALL_NOT_READY.format(
                    label=first.label, why=_strip_period(why), namespace=namespace
                )
            )
        await sleep(interval)  # type: ignore[misc]


def step_words(message: str) -> str:
    """A step's message as INSTALL_CANCELLED names it: lower case, without the ellipsis."""
    return message.removesuffix("…").lower()
