"""Delete: remove one object, saying first everything that goes with it.

The plan lists each effect (`_cascade`): the replacement a pod's controller starts, the
ReplicaSet a Deployment re-creates, the pods a workload takes with it (counted by its selector), a
CronJob's Jobs and their pods, every object of a CRD's kind, a claim's volume when its reclaim
policy deletes it, a node's pods, everything in a namespace. The apply is a DELETE whose
`preconditions.uid` is the object the user reviewed: a crash-looping pod's resourceVersion moves
every few seconds, but only an object deleted and re-created under the same name has another
uid, and that one answers with the conflict copy instead of being deleted."""

from kubernetes_asyncio.client import ApiClient
from kubernetes_asyncio.client.exceptions import ApiException

from omnikrux.actions.pipeline import (
    ActionError,
    Applied,
    ApplyContext,
    ClusterRef,
    Planned,
    Target,
)
from omnikrux.kube.connections import kube_error_message
from omnikrux.kube.http import KUBE_ERRORS, call_json
from omnikrux.kube.pods import REQUEST_TIMEOUT
from omnikrux.resources.kinds import KindSpec, object_name_problem

REPLACEMENT = "{owner_kind} {owner} starts a replacement pod."
WORKLOAD_PODS = "Its {n} pods are deleted too."
UNCOUNTED_PODS = "Its pods are deleted too."
NAMESPACE_CONTENTS = "Everything in namespace {name} is deleted too."
CRONJOB_JOBS = "Its {j} Jobs and their {n} pods are deleted too."
CRONJOB_UNCOUNTED = "Its Jobs and their pods are deleted too."
CRD_OBJECTS = "Every {kind} object on {cluster} is deleted too ({n} now)."
CRD_UNCOUNTED = "Every {kind} object on {cluster} is deleted too."
PVC_VOLUME = "Its volume {pv} is deleted too, and its data with it."
DEPLOYMENT_REPLACES = "Deployment {owner} creates a new ReplicaSet and pods."
NODE_PODS = "Its {n} pods are removed once the node is gone."
NODE_UNCOUNTED = "Its pods are removed once the node is gone."
NOT_DELETABLE = (
    "{kind} objects can't be deleted on this cluster: it doesn't allow deletes. "
    "Use kubectl if your access allows it."
)
NO_UID = (
    "{kind} {name} has no uid, so OmniKrux can't make sure it deletes the object you reviewed. "
    "Use kubectl to delete it."
)

# Kinds whose pods (selected by `spec.selector`) are deleted with them.
WORKLOADS = frozenset(
    {"deployments.apps", "statefulsets.apps", "replicasets.apps", "daemonsets.apps", "jobs.batch"}
)
CRDS = "customresourcedefinitions.apiextensions.k8s.io"
# The label a Job's pods carry with its uid: the first on Kubernetes 1.27 and later, the second
# before (a newer cluster sets both).
JOB_UID_LABELS = ("batch.kubernetes.io/controller-uid", "controller-uid")

Effect = tuple[str | None, str | None]  # a summary line, and a warning when it can't be counted


def where(target: Target) -> str:
    return f"{target.namespace}/{target.name}" if target.namespace else target.name


def controller_of(obj: dict) -> dict | None:
    """The owner reference marked as the object's controller; None when nothing manages it."""
    refs = (obj.get("metadata") or {}).get("ownerReferences") or []
    return next((r for r in refs if isinstance(r, dict) and r.get("controller") is True), None)


def label_selector(selector: object) -> str | None:
    """A LabelSelector (`matchLabels` and `matchExpressions`) as the API's `labelSelector` text;
    None when it selects nothing that can be written that way (empty or not a selector)."""
    if not isinstance(selector, dict):
        return None
    terms = [f"{k}={v}" for k, v in (selector.get("matchLabels") or {}).items()]
    for expr in selector.get("matchExpressions") or []:
        key, op, values = expr.get("key"), expr.get("operator"), expr.get("values") or []
        if op == "In":
            terms.append(f"{key} in ({','.join(values)})")
        elif op == "NotIn":
            terms.append(f"{key} notin ({','.join(values)})")
        elif op == "Exists":
            terms.append(str(key))
        elif op == "DoesNotExist":
            terms.append(f"!{key}")
        else:
            return None
    return ",".join(terms) or None


async def _workload_pods(api: ApiClient, spec: KindSpec, target: Target, live: dict) -> Effect:
    """The summary line for the pods a workload takes with it, and a warning if they couldn't
    be counted."""
    selector = label_selector((live.get("spec") or {}).get("selector"))
    if selector is None:
        return UNCOUNTED_PODS, None
    path = f"/api/v1/namespaces/{target.namespace}/pods"
    try:
        found = await call_json(
            api, "GET", path, timeout=REQUEST_TIMEOUT, query=(("labelSelector", selector),)
        )
    except KUBE_ERRORS as exc:
        return UNCOUNTED_PODS, kube_error_message(
            exc, f"count the pods of {spec.kind} {target.name}"
        )
    count = len(found.get("items") or [])
    return (WORKLOAD_PODS.format(n=count) if count else None), None


async def _items(api: ApiClient, path: str, query: tuple = ()) -> list[dict]:
    found = await call_json(api, "GET", path, timeout=REQUEST_TIMEOUT, query=query)
    return found.get("items") or []


async def _cronjob_jobs(api: ApiClient, target: Target, live: dict) -> Effect:
    """A CronJob's Jobs (those it controls, by uid) and their pods, running ones included."""
    try:
        jobs = await _items(api, f"/apis/batch/v1/namespaces/{target.namespace}/jobs")
    except KUBE_ERRORS as exc:
        words = f"count the Jobs of CronJob {target.name}"
        return CRONJOB_UNCOUNTED, kube_error_message(exc, words)
    uid = (live.get("metadata") or {}).get("uid")
    owned = [j for j in jobs if (controller_of(j) or {}).get("uid") == uid]
    if not owned:
        return None, None
    uids: dict[str, list[str]] = {}  # label -> the Jobs' uids, as their selectors carry them
    for job in owned:
        labels = ((job.get("spec") or {}).get("selector") or {}).get("matchLabels") or {}
        label = next((k for k in JOB_UID_LABELS if k in labels), JOB_UID_LABELS[0])
        uids.setdefault(label, []).append(labels.get(label) or _uid(job))
    count = 0
    for label, values in uids.items():
        query = (("labelSelector", f"{label} in ({','.join(values)})"),)
        try:
            count += len(await _items(api, f"/api/v1/namespaces/{target.namespace}/pods", query))
        except KUBE_ERRORS as exc:
            words = f"count the pods of the Jobs of CronJob {target.name}"
            return CRONJOB_UNCOUNTED, kube_error_message(exc, words)
    return CRONJOB_JOBS.format(j=len(owned), n=count), None


async def _crd_objects(api: ApiClient, live: dict, cluster: ClusterRef) -> Effect:
    """Every object of the CRD's kind, cluster-wide, read at its storage version."""
    crd = live.get("spec") or {}
    names = crd.get("names") or {}
    kind = names.get("kind") or (live.get("metadata") or {}).get("name")
    served = [v for v in crd.get("versions") or [] if isinstance(v, dict) and v.get("served")]
    version = next((v for v in served if v.get("storage")), served[0] if served else None)
    uncounted = CRD_UNCOUNTED.format(kind=kind, cluster=cluster.name)
    if version is None or not crd.get("group") or not names.get("plural"):
        return uncounted, f"Couldn't count the {kind} objects: the CRD serves no version."
    path = f"/apis/{crd['group']}/{version.get('name')}/{names['plural']}"
    try:
        count = len(await _items(api, path))
    except KUBE_ERRORS as exc:
        return uncounted, kube_error_message(exc, f"count the {kind} objects")
    return CRD_OBJECTS.format(kind=kind, cluster=cluster.name, n=count), None


async def _claimed_volume(api: ApiClient, live: dict) -> Effect:
    """The PersistentVolume a claim is bound to, when its reclaim policy deletes it too."""
    pv = (live.get("spec") or {}).get("volumeName")
    if not isinstance(pv, str) or object_name_problem(pv, None) is not None:
        return None, None
    words = f"check whether volume {pv} is deleted too"
    try:
        path = f"/api/v1/persistentvolumes/{pv}"
        volume = await call_json(api, "GET", path, timeout=REQUEST_TIMEOUT)
    except ApiException as exc:
        return None, (None if exc.status == 404 else kube_error_message(exc, words))
    except KUBE_ERRORS as exc:
        return None, kube_error_message(exc, words)
    if (volume.get("spec") or {}).get("persistentVolumeReclaimPolicy") == "Delete":
        return PVC_VOLUME.format(pv=pv), None
    return None, None


async def _node_pods(api: ApiClient, target: Target) -> Effect:
    query = (("fieldSelector", f"spec.nodeName={target.name}"),)
    try:
        count = len(await _items(api, "/api/v1/pods", query))
    except KUBE_ERRORS as exc:
        return NODE_UNCOUNTED, kube_error_message(exc, f"count the pods on {target.name}")
    return (NODE_PODS.format(n=count) if count else None), None


async def _cascade(
    api: ApiClient, spec: KindSpec, target: Target, live: dict, cluster: ClusterRef
) -> Effect:
    """What deleting the object takes with it, beyond itself."""
    owner = controller_of(live)
    if spec.key == "pods" and owner is not None:
        return REPLACEMENT.format(owner_kind=owner.get("kind"), owner=owner.get("name")), None
    if spec.key == "replicasets.apps" and owner is not None and owner.get("kind") == "Deployment":
        return DEPLOYMENT_REPLACES.format(owner=owner.get("name")), None
    if spec.key in WORKLOADS:
        return await _workload_pods(api, spec, target, live)
    if spec.key == "cronjobs.batch":
        return await _cronjob_jobs(api, target, live)
    if spec.key == CRDS:
        return await _crd_objects(api, live, cluster)
    if spec.key == "persistentvolumeclaims":
        return await _claimed_volume(api, live)
    if spec.key == "nodes":
        return await _node_pods(api, target)
    if spec.key == "namespaces":
        return NAMESPACE_CONTENTS.format(name=target.name), None
    return None, None


def _uid(obj: dict) -> str | None:
    return (obj.get("metadata") or {}).get("uid")


class DeleteAction:
    kinds = None  # any served kind that allows deletes

    async def plan(
        self, api: ApiClient, spec: KindSpec, target: Target, params: dict, *, cluster: ClusterRef
    ) -> Planned:
        if "delete" not in spec.verbs:
            raise ActionError(422, NOT_DELETABLE.format(kind=spec.kind))
        path = spec.object_path(target.namespace, target.name)
        live = await call_json(api, "GET", path, timeout=REQUEST_TIMEOUT)
        uid = (live.get("metadata") or {}).get("uid")
        if not uid:
            raise ActionError(422, NO_UID.format(kind=spec.kind, name=target.name))
        if "expected_uid" in params and params["expected_uid"] != uid:
            raise ActionError(
                409, f"{spec.kind} {where(target)} was replaced. Select it again to delete it."
            )
        summary = [f"Delete {spec.kind} {where(target)} on {cluster.name}."]
        line, warning = await _cascade(api, spec, target, live, cluster)
        summary += [line] if line else []
        warnings = [warning] if warning else []
        return Planned(
            title=f"Delete {spec.kind} {target.name}",
            summary=summary,
            warnings=warnings,
            before=live,
            after=None,
            apply_label="Delete",
            state={"uid": uid},
        )

    async def apply(
        self, ctx: ApplyContext, target: Target, spec: KindSpec, planned: Planned
    ) -> Applied:
        # The uid precondition: an object re-created under this name since the review answers
        # 409 (the conflict copy) and stays.
        body = {"propagationPolicy": "Background", "preconditions": {"uid": planned.state["uid"]}}
        path = spec.object_path(target.namespace, target.name)
        await call_json(ctx.api, "DELETE", path, timeout=REQUEST_TIMEOUT, body=body)
        return Applied(f"Deleted {spec.kind} {where(target)}.")
