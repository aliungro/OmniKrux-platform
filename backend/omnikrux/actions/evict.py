"""Evict one reviewed pod using the Kubernetes disruption-budget-aware API."""

from kubernetes_asyncio.client import ApiClient
from kubernetes_asyncio.client.exceptions import ApiException

from omnikrux.actions.delete import REPLACEMENT, controller_of, where
from omnikrux.actions.pipeline import (
    ActionError,
    Applied,
    ApplyContext,
    ClusterRef,
    Planned,
    Target,
)
from omnikrux.kube.http import call_json, status_message
from omnikrux.kube.pods import REQUEST_TIMEOUT
from omnikrux.resources.kinds import KindSpec


async def request_eviction(api: ApiClient, namespace: str, name: str, uid: str) -> None:
    body = {
        "apiVersion": "policy/v1",
        "kind": "Eviction",
        "metadata": {"name": name, "namespace": namespace},
        "deleteOptions": {"preconditions": {"uid": uid}},
    }
    path = f"/api/v1/namespaces/{namespace}/pods/{name}/eviction"
    await call_json(api, "POST", path, timeout=REQUEST_TIMEOUT, body=body)


class EvictAction:
    kinds = frozenset({"pods"})

    async def plan(
        self, api: ApiClient, spec: KindSpec, target: Target, params: dict, *, cluster: ClusterRef
    ) -> Planned:
        live = await call_json(
            api, "GET", spec.object_path(target.namespace, target.name), timeout=REQUEST_TIMEOUT
        )
        uid = (live.get("metadata") or {}).get("uid")
        if not uid:
            raise ActionError(422, "The pod has no UID. Refresh the pod and review it again.")
        if "expected_uid" in params and params["expected_uid"] != uid:
            raise ActionError(
                409, f"{spec.kind} {where(target)} was replaced. Select it again to evict it."
            )
        summary = [
            f"Evict pod {where(target)} on {cluster.name}.",
            "Kubernetes checks any PodDisruptionBudget before terminating this pod.",
        ]
        if owner := controller_of(live):
            summary.append(
                REPLACEMENT.format(owner_kind=owner.get("kind"), owner=owner.get("name"))
            )
        return Planned(
            title=f"Evict pod {target.name}",
            summary=summary,
            typed=True,
            apply_label="Evict",
            state={"uid": uid},
        )

    async def apply(
        self, ctx: ApplyContext, target: Target, spec: KindSpec, planned: Planned
    ) -> Applied:
        try:
            await request_eviction(
                ctx.api, target.namespace or "", target.name, planned.state["uid"]
            )
        except ApiException as exc:
            if exc.status == 429:
                why = (
                    status_message((exc.body or "").encode()) or "The cluster is limiting requests."
                )
                raise ActionError(
                    429,
                    f"Kubernetes didn't evict the pod: {why[:300]} Review the eviction again later.",
                ) from exc
            if exc.status == 404:
                raise ActionError(
                    404, "Couldn't evict the pod: the pod or its eviction endpoint is unavailable."
                ) from exc
            raise
        return Applied(f"Kubernetes accepted the eviction of pod {where(target)}.")
