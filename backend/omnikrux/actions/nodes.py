"""Nodes: cordon, uncordon and drain.

Cordon and uncordon are a JSON patch of `spec.unschedulable` guarded by `test /metadata/uid`, so
a node re-created under the same name since the review answers with the conflict copy.

A drain's plan lists the node's pods and classifies them (`classify_pods`): DaemonSet pods, mirror
pods and finished pods stay; every other pod is evicted. A pod no controller manages won't come
back, and a pod's emptyDir data is lost: the plan is blocked on those until the user says so
(`force`, `delete_emptydir_data`), and then lists them as warnings. It also warns about
PodDisruptionBudgets that will hold pods up.

The apply cordons the node (with the uid test), then starts a job that evicts exactly the pods
the user reviewed, each with its uid as the precondition, at most 5 at a time. An eviction a
PodDisruptionBudget refuses (429), or that meets a write conflict (a 409 other than the uid
precondition), is retried every 5 s; an evicted pod is waited for until it is gone. When
`timeout_s` passes first the job fails and says which pods are still protected, or why it couldn't
tell that they left. A drain that finishes says how many pods it evicted, how many were already
gone, and which pods on the node it left alone because the user didn't review them. The node stays
cordoned however the drain ends."""

import asyncio
import copy
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from functools import partial

from kubernetes_asyncio.client import ApiClient
from kubernetes_asyncio.client.exceptions import ApiException

from omnikrux.actions.delete import controller_of
from omnikrux.actions.evict import request_eviction
from omnikrux.actions.jobs import Job, JobFailed
from omnikrux.actions.pipeline import (
    ActionError,
    Applied,
    ApplyContext,
    ClusterRef,
    Planned,
    Target,
    json_patch,
)
from omnikrux.kube.connections import ClusterConnections, kube_error_message
from omnikrux.kube.http import KUBE_ERRORS, call_json, status_message
from omnikrux.kube.pods import REQUEST_TIMEOUT
from omnikrux.resources.kinds import KindSpec

MIRROR = "kubernetes.io/config.mirror"
MAX_EVICTIONS = 5  # in flight at once
RETRY_SECONDS = 5.0  # between evictions a PodDisruptionBudget refused
POLL_SECONDS = 1.0  # between checks that an evicted pod is gone
DEFAULT_TIMEOUT = 300
MAX_TIMEOUT = 3600

CORDON = "Stop scheduling new pods on {node}."
UNCORDON = "Allow new pods on {node} again."
ALREADY_CORDONED = "Nothing changes: {node} is already cordoned."
ALREADY_SCHEDULABLE = "Nothing changes: {node} already allows new pods."
DRAIN = "Cordon {node}, then evict {n} pods. {d} DaemonSet pods stay."
UNMANAGED = "{n} pods aren't managed by a controller and won't be recreated: {names}."
EMPTYDIR = "{n} pods keep data in emptyDir volumes, which is lost: {names}."
PDB_TIMEOUT = (
    "Drain stopped after {duration}: {n} pods are still protected by a PodDisruptionBudget "
    "({names}). {node} stays cordoned."
)
STILL_THERE = (
    "Drain stopped after {duration}: {n} pods haven't left {node} yet ({names}). "
    "{node} stays cordoned."
)
UNCHECKED = (
    "Drain stopped after {duration}: OmniKrux couldn't check that {n} pods left {node} "
    "({names}): {reason} {node} stays cordoned."
)
CANCELLED = "Drain cancelled. {node} stays cordoned; uncordon it to schedule pods there again."
DRAINED = "Drained {node}: {n} pods evicted."
ALREADY_GONE = "{n} pods were already gone."
NOT_REVIEWED = "{n} pods on {node} weren't in the review and stay: {names}."
UNCHECKED_ARRIVALS = "OmniKrux couldn't check for pods that arrived since the review: {reason}"
STAYS_CORDONED = "{node} stays cordoned."
PDB_NONE = (
    "PodDisruptionBudget {pdb} allows no evictions right now: {names} {verb} until it does, "
    "for up to {duration}."
)
PDB_SOME = (
    "PodDisruptionBudget {pdb} allows {allowed} of {names} to be evicted at once: the others "
    "wait for replacements, for up to {duration}."
)
BAD_DRAIN = (
    "Drain options: force and delete_emptydir_data are true or false, "
    f"timeout_s is a whole number of seconds from 1 to {MAX_TIMEOUT}."
)
NO_JOBS = "Drains can't run right now: the console is stopping. Try again once it's back."
NOT_STARTED = (
    "The drain couldn't start: the console is stopping. {node} stays cordoned; uncordon it, or "
    "drain it again once the console is back."
)
# How the API server says a DeleteOptions uid precondition failed: another pod has the name now.
UID_PRECONDITION = "Precondition failed: UID"
PDB_REFUSED = "A PodDisruptionBudget doesn't allow this eviction yet."


def _uid(obj: dict) -> str | None:
    return (obj.get("metadata") or {}).get("uid")


def _name(pod: dict) -> str:
    md = pod.get("metadata") or {}
    return f"{md.get('namespace')}/{md.get('name')}"


def _names(pods: list[dict]) -> str:
    return ", ".join(_name(p) for p in pods)


def _duration(seconds: int) -> str:
    minutes, rest = divmod(seconds, 60)
    if not minutes:
        return f"{rest} s"
    return f"{minutes} min" + (f" {rest} s" if rest else "")


async def _read(api: ApiClient, spec: KindSpec, target: Target) -> dict:
    return await call_json(api, "GET", spec.object_path(None, target.name), timeout=REQUEST_TIMEOUT)


def _switch_ops(uid: str | None, unschedulable: bool) -> list[dict]:
    return [
        {"op": "test", "path": "/metadata/uid", "value": uid},
        {"op": "add", "path": "/spec/unschedulable", "value": unschedulable},
    ]


async def _switch(
    api: ApiClient, spec: KindSpec, target: Target, uid: str | None, unschedulable: bool
) -> None:
    await json_patch(api, spec.object_path(None, target.name), _switch_ops(uid, unschedulable))


def _cordoned(node: dict) -> bool:
    return (node.get("spec") or {}).get("unschedulable") is True


# --- cordon and uncordon ------------------------------------------------------------------


class _Schedulability:
    kinds = frozenset({"nodes"})
    unschedulable: bool
    verb: str
    summary: str
    unchanged: str

    async def plan(
        self, api: ApiClient, spec: KindSpec, target: Target, params: dict, *, cluster: ClusterRef
    ) -> Planned:
        live = await _read(api, spec, target)
        after = copy.deepcopy(live)
        node_spec = after.setdefault("spec", {})
        if self.unschedulable:
            node_spec["unschedulable"] = True
        else:  # the API server stores false as no field at all
            node_spec.pop("unschedulable", None)
        unchanged = _cordoned(live) == self.unschedulable
        return Planned(
            title=f"{self.verb} {target.name}",
            summary=[self.summary.format(node=target.name)],
            blocked=[self.unchanged.format(node=target.name)] if unchanged else [],
            before=live,
            after=after,
            apply_label=self.verb,
            state={"uid": _uid(live)},
        )

    async def apply(
        self, ctx: ApplyContext, target: Target, spec: KindSpec, planned: Planned
    ) -> Applied:
        await _switch(ctx.api, spec, target, planned.state["uid"], self.unschedulable)
        return Applied(f"{self.verb}ed {target.name}.")


class CordonAction(_Schedulability):
    unschedulable = True
    verb = "Cordon"
    summary = CORDON
    unchanged = ALREADY_CORDONED


class UncordonAction(_Schedulability):
    unschedulable = False
    verb = "Uncordon"
    summary = UNCORDON
    unchanged = ALREADY_SCHEDULABLE


# --- drain: the plan ----------------------------------------------------------------------


@dataclass
class DrainPlan:
    """A node's pods by what a drain does with them. `evict` is every pod it evicts;
    `unmanaged` and `emptydir` are those of them that need the user's say-so."""

    evict: list[dict] = field(default_factory=list)
    daemonset: list[dict] = field(default_factory=list)
    mirror: list[dict] = field(default_factory=list)
    finished: list[dict] = field(default_factory=list)
    unmanaged: list[dict] = field(default_factory=list)
    emptydir: list[dict] = field(default_factory=list)


def classify_pods(pods: list[dict]) -> DrainPlan:
    """What a drain does with each pod, as kubectl drain decides: mirror pods (the kubelet's
    static pods), finished pods and DaemonSet pods stay; every other pod is evicted."""
    drain = DrainPlan()
    for pod in sorted(pods, key=_name):
        md = pod.get("metadata") or {}
        owner = controller_of(pod)
        if MIRROR in (md.get("annotations") or {}):
            drain.mirror.append(pod)
        elif (pod.get("status") or {}).get("phase") in ("Succeeded", "Failed"):
            drain.finished.append(pod)
        elif owner is not None and owner.get("kind") == "DaemonSet":
            drain.daemonset.append(pod)
        else:
            drain.evict.append(pod)
            if owner is None:
                drain.unmanaged.append(pod)
            volumes = (pod.get("spec") or {}).get("volumes") or []
            if any(isinstance(v, dict) and "emptyDir" in v for v in volumes):
                drain.emptydir.append(pod)
    return drain


def selector_matches(selector: object, labels: dict) -> bool:
    """Whether a LabelSelector selects these labels; an empty selector selects everything, a
    missing one nothing (as a PodDisruptionBudget's does)."""
    if not isinstance(selector, dict):
        return False
    for key, value in (selector.get("matchLabels") or {}).items():
        if labels.get(key) != value:
            return False
    for expr in selector.get("matchExpressions") or []:
        key, op, values = expr.get("key"), expr.get("operator"), expr.get("values") or []
        if op == "In" and labels.get(key) not in values:
            return False
        if op == "NotIn" and key in labels and labels[key] in values:
            return False
        if op == "Exists" and key not in labels:
            return False
        if op == "DoesNotExist" and key in labels:
            return False
        if op not in ("In", "NotIn", "Exists", "DoesNotExist"):
            return False
    return True


async def _pdb_warnings(api: ApiClient, pods: list[dict], timeout_s: int) -> list[str]:
    """The PodDisruptionBudgets that will hold some of these pods up, as warnings."""
    if not pods:
        return []
    path = "/apis/policy/v1/poddisruptionbudgets"
    try:
        pdbs = (await call_json(api, "GET", path, timeout=REQUEST_TIMEOUT)).get("items") or []
    except ApiException as exc:
        if exc.status == 404:  # policy/v1 isn't served: nothing can hold an eviction up
            return []
        return [kube_error_message(exc, "check for PodDisruptionBudgets")]
    except KUBE_ERRORS as exc:
        return [kube_error_message(exc, "check for PodDisruptionBudgets")]
    warnings = []
    duration = _duration(timeout_s)
    for pdb in sorted(pdbs, key=_name):
        md = pdb.get("metadata") or {}
        allowed = (pdb.get("status") or {}).get("disruptionsAllowed")
        if not isinstance(allowed, int):  # not worked out yet: nothing to say
            continue
        selector = (pdb.get("spec") or {}).get("selector")
        covered = [
            p
            for p in pods
            if (p.get("metadata") or {}).get("namespace") == md.get("namespace")
            and selector_matches(selector, (p.get("metadata") or {}).get("labels") or {})
        ]
        if not covered or len(covered) <= allowed:
            continue
        if allowed <= 0:
            verb = "waits" if len(covered) == 1 else "wait"
            warnings.append(
                PDB_NONE.format(pdb=_name(pdb), names=_names(covered), verb=verb, duration=duration)
            )
        else:
            warnings.append(
                PDB_SOME.format(
                    pdb=_name(pdb), allowed=allowed, names=_names(covered), duration=duration
                )
            )
    return warnings


def _drain_params(params: dict) -> tuple[bool, bool, int]:
    force = params.get("force", False)
    emptydir = params.get("delete_emptydir_data", False)
    timeout_s = params.get("timeout_s", DEFAULT_TIMEOUT)
    if (
        not isinstance(force, bool)
        or not isinstance(emptydir, bool)
        or not isinstance(timeout_s, int)
        or isinstance(timeout_s, bool)
        or not 1 <= timeout_s <= MAX_TIMEOUT
    ):
        raise ActionError(422, BAD_DRAIN)
    return force, emptydir, timeout_s


class DrainAction:
    kinds = frozenset({"nodes"})

    async def plan(
        self, api: ApiClient, spec: KindSpec, target: Target, params: dict, *, cluster: ClusterRef
    ) -> Planned:
        force, delete_emptydir_data, timeout_s = _drain_params(params)
        node = target.name
        live = await _read(api, spec, target)
        query = (("fieldSelector", f"spec.nodeName={node}"),)
        listed = await call_json(api, "GET", "/api/v1/pods", timeout=REQUEST_TIMEOUT, query=query)
        drain = classify_pods(listed.get("items") or [])
        blocked, warnings = [], []
        if drain.unmanaged:
            effect = UNMANAGED.format(n=len(drain.unmanaged), names=_names(drain.unmanaged))
            (warnings if force else blocked).append(effect)
        if drain.emptydir:
            effect = EMPTYDIR.format(n=len(drain.emptydir), names=_names(drain.emptydir))
            (warnings if delete_emptydir_data else blocked).append(effect)
        warnings += await _pdb_warnings(api, drain.evict, timeout_s)
        return Planned(
            title=f"Drain {node}",
            summary=[
                DRAIN.format(node=node, n=len(drain.evict), d=len(drain.daemonset)),
                *(_name(p) for p in drain.evict),
            ],
            warnings=warnings,
            blocked=blocked,
            apply_label="Drain",
            state={
                "uid": _uid(live),
                "timeout_s": timeout_s,
                "pods": [
                    {
                        "namespace": (p.get("metadata") or {}).get("namespace"),
                        "name": (p.get("metadata") or {}).get("name"),
                        "uid": _uid(p),
                    }
                    for p in drain.evict
                ],
            },
        )

    async def apply(
        self, ctx: ApplyContext, target: Target, spec: KindSpec, planned: Planned
    ) -> Applied:
        if ctx.jobs is None or ctx.jobs.closed:  # checked before the node is cordoned
            raise ActionError(503, NO_JOBS)
        state, node = planned.state, target.name
        # Cordoned here, before the job: a node re-created since the review answers with the
        # conflict copy at once, and nothing is evicted.
        await _switch(ctx.api, spec, target, state["uid"], True)
        pods = state["pods"]
        work = partial(
            drain_pods,
            connections=ctx.connections,
            cluster_id=target.cluster_id,
            node=node,
            pods=pods,
            timeout_s=state["timeout_s"],
        )
        try:
            job_id = ctx.jobs.start(
                "drain",
                work,
                actor=ctx.actor,
                audit_id=ctx.audit_id,
                cancelled_message=CANCELLED.format(node=node),
                message=f"Evicting {len(pods)} pods from {node}.",
                cluster_id=target.cluster_id,
            )
        except RuntimeError:  # the runner closed since the check: the node is cordoned now
            raise ActionError(503, NOT_STARTED.format(node=node)) from None
        return Applied(f"Cordoned {node}; evicting {len(pods)} pods.", job_id=job_id)


# --- drain: the job -----------------------------------------------------------------------


async def _evict(api: ApiClient, pod: dict, node: str) -> tuple[str, str | None]:
    """Ask the API server to evict the reviewed pod. One of:
    ("evicted", None); ("gone", None) when it no longer exists or another pod (another uid) has
    its name; ("blocked", why) when a PodDisruptionBudget refuses for now; ("retry", None) when
    the API server's own write conflicted (a 409 that isn't the uid precondition)."""
    ns, name = pod["namespace"], pod["name"]
    try:
        await request_eviction(api, ns, name, pod["uid"])
    except ApiException as exc:
        why = status_message((exc.body or "").encode())
        if exc.status == 429:
            return "blocked", why or PDB_REFUSED
        if exc.status == 404:
            return "gone", None
        if exc.status == 409:
            return ("gone" if why and UID_PRECONDITION in why else "retry"), None
        raise JobFailed(_eviction_failed(exc, ns, name, node)) from None
    except KUBE_ERRORS as exc:
        raise JobFailed(_eviction_failed(exc, ns, name, node)) from None
    return "evicted", None


def _eviction_failed(exc: Exception, ns: str, name: str, node: str) -> str:
    return f"{kube_error_message(exc, f'evict pod {ns}/{name}')} {STAYS_CORDONED.format(node=node)}"


def _sentence(text: str) -> str:
    return text if text.endswith(".") else f"{text}."


async def _gone(api: ApiClient, node: str) -> tuple[set[str] | None, str | None]:
    """The uids still on the node, or why they couldn't be listed."""
    try:
        listed = await call_json(
            api,
            "GET",
            "/api/v1/pods",
            timeout=REQUEST_TIMEOUT,
            query=(("fieldSelector", f"spec.nodeName={node}"),),
        )
    except KUBE_ERRORS as exc:
        return None, kube_error_message(exc, f"list the pods on {node}")
    return {_uid(p) for p in listed.get("items") or []}, None


async def _left_alone(api: ApiClient, node: str, reviewed: set[str]) -> str | None:
    """What the outcome says about pods now on the node that the user didn't review (they
    arrived since, or replaced a reviewed pod): they are never evicted."""
    query = (("fieldSelector", f"spec.nodeName={node}"),)
    try:
        listed = await call_json(api, "GET", "/api/v1/pods", timeout=REQUEST_TIMEOUT, query=query)
    except KUBE_ERRORS as exc:
        reason = kube_error_message(exc, f"list the pods on {node}")
        return UNCHECKED_ARRIVALS.format(reason=_sentence(reason))
    arrived = [p for p in classify_pods(listed.get("items") or []).evict if _uid(p) not in reviewed]
    if not arrived:
        return None
    return NOT_REVIEWED.format(n=len(arrived), node=node, names=_names(arrived))


async def drain_pods(
    job: Job,
    *,
    connections: ClusterConnections,
    cluster_id: str,
    node: str,
    pods: list[dict],
    timeout_s: int,
) -> str:
    """The drain job: evict `pods` (the reviewed ones), at most MAX_EVICTIONS at a time, and
    wait until they are gone. Returns the message it ends with; JobFailed otherwise."""
    job.total = len(pods)
    blocked: dict[tuple[str, str], dict] = {}  # a PodDisruptionBudget refuses them for now
    unreadable: dict[tuple[str, str], str] = {}  # evicted, but reading them back fails: why
    evicted: list[tuple[str, str]] = []
    already_gone: list[tuple[str, str]] = []

    def show_blocked() -> None:
        job.blocked = [blocked[k] for k in sorted(blocked)]

    async with AsyncExitStack() as stack:
        try:
            api = await stack.enter_async_context(connections.api(cluster_id))
        except Exception as exc:  # noqa: BLE001 (said in words)
            message = kube_error_message(exc, "connect to the cluster")
            raise JobFailed(f"{message} {STAYS_CORDONED.format(node=node)}") from None
        slots = asyncio.Semaphore(MAX_EVICTIONS)
        waiters: dict[str, tuple[asyncio.Future, tuple[str, str]]] = {}
        poller: asyncio.Task | None = None

        async def poll() -> None:
            while waiters:
                # Only release pods registered before the request: an eviction that finishes
                # during this list must wait for a fresh observation of its uid.
                checking = dict(waiters)
                present, problem = await _gone(api, node)
                for uid, (ready, key) in checking.items():
                    if problem:
                        unreadable[key] = problem
                    else:
                        unreadable.pop(key, None)
                        if uid not in present:
                            waiters.pop(uid)
                            ready.set_result(None)
                if waiters:
                    await asyncio.sleep(POLL_SECONDS)

        def poll_finished(task: asyncio.Task) -> None:
            # Unexpected read/parse failures must reach the monitored pod tasks too.
            if not task.cancelled() and (failure := task.exception()) is not None:
                for ready, _ in waiters.values():
                    if not ready.done():
                        ready.set_exception(failure)
                waiters.clear()

        async def one(pod: dict) -> None:
            nonlocal poller
            key = (pod["namespace"], pod["name"])
            while True:
                async with slots:
                    result, why = await _evict(api, pod, node)
                if result == "blocked":
                    blocked[key] = {"namespace": key[0], "name": key[1], "message": why}
                    show_blocked()
                elif result != "retry":
                    break
                await asyncio.sleep(RETRY_SECONDS)
            if blocked.pop(key, None) is not None:
                show_blocked()
            if result == "gone":
                already_gone.append(key)
            else:
                ready = asyncio.get_running_loop().create_future()
                waiters[pod["uid"]] = (ready, key)
                if poller is None or poller.done():
                    poller = asyncio.create_task(poll())
                    poller.add_done_callback(poll_finished)
                await ready
                evicted.append(key)
            job.done += 1

        tasks = {asyncio.create_task(one(p)): p for p in pods}
        pending: set[asyncio.Task] = set()
        try:
            if tasks:
                _, pending = await asyncio.wait(
                    tasks, timeout=timeout_s, return_when=asyncio.FIRST_EXCEPTION
                )
        finally:
            if poller is not None:
                poller.cancel()
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if poller is not None:
                await asyncio.gather(poller, return_exceptions=True)

        for task in tasks:
            if not task.cancelled() and task.exception() is not None:
                raise task.exception()
        if pending:
            raise JobFailed(_timed_out(node, timeout_s, pending, tasks, blocked, unreadable))
        left_alone = await _left_alone(api, node, {p["uid"] for p in pods})

    parts = [DRAINED.format(node=node, n=len(evicted))]
    if already_gone:
        parts.append(ALREADY_GONE.format(n=len(already_gone)))
    if left_alone:
        parts.append(left_alone)
    parts.append(STAYS_CORDONED.format(node=node))
    return " ".join(parts)


def _timed_out(
    node: str,
    timeout_s: int,
    pending: set[asyncio.Task],
    tasks: dict[asyncio.Task, dict],
    blocked: dict[tuple[str, str], dict],
    unreadable: dict[tuple[str, str], str],
) -> str:
    """Why the drain stopped when its time was up: the pods a PodDisruptionBudget still
    protects, else the pods that couldn't be read back (and why), else the pods still there."""
    duration = _duration(timeout_s)
    if blocked:
        names = ", ".join(f"{ns}/{name}" for ns, name in sorted(blocked))
        return PDB_TIMEOUT.format(duration=duration, n=len(blocked), names=names, node=node)
    left = sorted((tasks[t]["namespace"], tasks[t]["name"]) for t in pending)
    unchecked = [k for k in left if k in unreadable]
    if unchecked:
        names = ", ".join(f"{ns}/{name}" for ns, name in unchecked)
        reason = _sentence(unreadable[unchecked[0]])
        return UNCHECKED.format(
            duration=duration, n=len(unchecked), node=node, names=names, reason=reason
        )
    names = ", ".join(f"{ns}/{name}" for ns, name in left)
    return STILL_THERE.format(duration=duration, n=len(left), names=names, node=node)
