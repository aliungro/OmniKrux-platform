from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from omnikrux.audit.store import AuditEntry, AuditUnavailable, actor_of, no_audit_message
from omnikrux.cloud.messages import missing_from_cloud
from omnikrux.cloud.types import NodePool
from omnikrux.clusters.models import Environment, Provider
from omnikrux.clusters.registry import (
    SOURCE_CLOUD,
    SOURCE_UPLOAD,
    ClusterConflict,
    ClusterInfo,
    Source,
)
from omnikrux.exec.debug import finish_even_if_cancelled

router = APIRouter(prefix="/api/clusters")


class NodePoolOut(BaseModel):
    name: str
    count: int | None
    machine_type: str | None
    version: str | None

    @classmethod
    def from_pool(cls, pool: NodePool) -> "NodePoolOut":
        return cls(
            name=pool.name, count=pool.count, machine_type=pool.machine_type, version=pool.version
        )


class CloudLinkOut(BaseModel):
    account_id: str
    account_name: str
    resource_id: str


class ClusterOut(BaseModel):
    id: str
    name: str
    context_name: str
    server: str | None
    original_server: str | None  # the kubeconfig's address when `server` was rewritten, else null
    provider: Provider
    region: str | None
    environment: Environment
    source: Source
    kubernetes_version: str | None
    node_pools: list[NodePoolOut] | None  # null: the cloud couldn't say (unknown, not none)
    node_count: int | None
    cloud: CloudLinkOut | None
    cloud_note: str | None
    state: Literal["unknown", "syncing", "ready", "error"] = "unknown"
    message: str | None = None


class KubeconfigIn(BaseModel):
    kubeconfig: str


def cluster_out(
    info: ClusterInfo, request: Request, *, account_name: str | None = None
) -> ClusterOut:
    state, message = request.app.state.hub.status(info.id)
    is_cloud = info.source == SOURCE_CLOUD
    link = None
    note = None
    if is_cloud and info.cloud_account_id is not None and info.cloud_resource_id is not None:
        if account_name is not None:
            link = CloudLinkOut(
                account_id=info.cloud_account_id,
                account_name=account_name,
                resource_id=info.cloud_resource_id,
            )
        if info.cloud_missing_since is not None:
            note = missing_from_cloud(account_name or "its cloud account")
    return ClusterOut(
        id=info.id,
        name=info.name,
        context_name=info.context_name,
        server=None if is_cloud else info.server,
        original_server=None if is_cloud else info.original_server,
        provider=info.provider,
        region=info.region,
        environment=info.environment,
        source=info.source,
        kubernetes_version=(
            info.kubernetes_version
            if is_cloud
            else request.app.state.catalog.cached_version(info.id)
        ),
        node_pools=(
            None
            if info.node_pools is None
            else [NodePoolOut.from_pool(pool) for pool in info.node_pools]
        ),
        node_count=info.node_count,
        cloud=link,
        cloud_note=note,
        state=state,
        message=message,
    )


@router.get("")
async def list_clusters(request: Request) -> list[ClusterOut]:
    infos = await request.app.state.registry.list()
    account_names = {}
    if any(info.source == SOURCE_CLOUD for info in infos):
        account_names = {
            account.id: account.name for account in await request.app.state.cloud.store.list()
        }
    return [
        cluster_out(info, request, account_name=account_names.get(info.cloud_account_id))
        for info in infos
    ]


@router.post("/{cluster_id}/retry", status_code=204)
async def retry_cluster(cluster_id: str, request: Request) -> None:
    try:
        await request.app.state.registry.get(cluster_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Unknown cluster") from exc
    await request.app.state.hub.retry(cluster_id)


@router.delete("/{cluster_id}", status_code=204)
async def delete_cluster(cluster_id: str, request: Request) -> None:
    state = request.app.state
    audit = state.audit
    try:
        info = await state.registry.get(cluster_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Unknown cluster") from None
    try:
        record = await audit.begin(
            AuditEntry(actor_of(request), "cluster_remove", cluster_id, None, "clusters", info.name)
        )
    except AuditUnavailable as exc:
        raise HTTPException(status_code=503, detail=no_audit_message(exc)) from None

    async def remove() -> None:
        async with state.streams.removing(cluster_id=cluster_id):
            try:
                await state.registry.delete(cluster_id)
            except KeyError:
                await audit.finish(record, "failed", "Unknown cluster")
                raise HTTPException(status_code=404, detail="Unknown cluster") from None
            except Exception:  # noqa: BLE001 (the removal could not be committed)
                message = "Couldn't remove this cluster from OmniKrux. Try again."
                await audit.finish(record, "failed", message)
                raise HTTPException(status_code=503, detail=message) from None
            await audit.finish(record, "succeeded")
            await state.hub.forget(cluster_id)

    await finish_even_if_cancelled(remove())


@router.post("/kubeconfig")
async def import_kubeconfig(body: KubeconfigIn, request: Request) -> list[ClusterOut]:
    settings = request.app.state.settings
    try:
        infos = await request.app.state.registry.upsert_from_kubeconfig(
            body.kubeconfig, rewrite_loopback=settings.loopback_rewrite, source=SOURCE_UPLOAD
        )
    except ClusterConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await request.app.state.hub.clusters_changed()  # open watch sockets pick up new clusters
    return [cluster_out(info, request) for info in infos]
