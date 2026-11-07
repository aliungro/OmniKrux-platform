"""Delete: remove one object, saying first everything that goes with it.

The plan lists each effect: the replacement a pod's controller starts, the pods a workload takes
with it (counted by its selector), everything in a namespace. The apply is a DELETE whose
`preconditions.uid` is the object the user reviewed: a crash-looping pod's resourceVersion moves
every few seconds, but only an object deleted and re-created under the same name has another
uid, and that one answers with the conflict copy instead of being deleted."""

from kubernetes_asyncio.client import ApiClient

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
from omnikrux.resources.kinds import KindSpec

REPLACEMENT = "{owner_kind} {owner} starts a replacement pod."
WORKLOAD_PODS = "Its {n} pods are deleted too."
UNCOUNTED_PODS = "Its pods are deleted too."
NAMESPACE_CONTENTS = "Everything in namespace {name} is deleted too."
NOT_DELETABLE = (
    "{kind} objects can't be deleted on this cluster: it doesn't allow deletes. "
    "Use kubectl if your access allows it."
)
NO_UID = (
    "{kind} {name} has no uid, so Omnikrux can't make sure it deletes the object you reviewed. "
    "Use kubectl to delete it."
)

# Kinds whose pods (selected by `spec.selector`) are deleted with them.
WORKLOADS = frozenset(
    {"deployments.apps", "statefulsets.apps", "replicasets.apps", "daemonsets.apps", "jobs.batch"}
)


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


async def _workload_pods(api: ApiClient, spec: KindSpec, target: Target, live: dict):
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
        summary = [f"Delete {spec.kind} {where(target)} on {cluster.name}."]
        warnings: list[str] = []
        if spec.key == "pods" and (owner := controller_of(live)) is not None:
            summary.append(
                REPLACEMENT.format(owner_kind=owner.get("kind"), owner=owner.get("name"))
            )
        if spec.key in WORKLOADS:
            line, warning = await _workload_pods(api, spec, target, live)
            summary += [line] if line else []
            warnings += [warning] if warning else []
        if spec.key == "namespaces":
            summary.append(NAMESPACE_CONTENTS.format(name=target.name))
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
