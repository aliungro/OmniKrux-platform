import asyncio
import logging
import re
from datetime import datetime
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, SecretStr, StringConstraints

from omnikrux.audit.store import AuditEntry, AuditUnavailable, actor_of, no_audit_message
from omnikrux.cloud import messages
from omnikrux.cloud.endpoints import InvalidClusterEndpoint
from omnikrux.cloud.http import CloudError
from omnikrux.cloud.models import DiscoverySnapshot, DiscoveryState
from omnikrux.cloud.store import AccountExists, CloudAccount, Discovered
from omnikrux.cloud.types import (
    AWS_REGION,
    GCP_PROJECT,
    GUID,
    KUBE_PROVIDER,
    OCI_OCID,
    OCI_REGION,
    PROFILE_NAME,
    AccountConfig,
    CloudClusterRef,
    CloudProvider,
    CredentialSourceKind,
)
from omnikrux.clusters.api import ClusterOut, NodePoolOut, cluster_out
from omnikrux.clusters.models import Environment, Provider
from omnikrux.clusters.registry import DiscoveryChanged

router = APIRouter(prefix="/api")
log = logging.getLogger(__name__)


def _whole(pattern: re.Pattern[str]) -> StringConstraints:
    # Pydantic searches Python patterns, where `$` also matches before a final newline.
    return StringConstraints(pattern=re.compile(pattern.pattern.removesuffix("$") + r"\Z"))


AzureId = Annotated[str, _whole(GUID)]
AwsRegion = Annotated[str, _whole(AWS_REGION)]
ProjectId = Annotated[str, _whole(GCP_PROJECT)]
Ocid = Annotated[str, _whole(OCI_OCID)]
OciRegion = Annotated[str, _whole(OCI_REGION)]
Profile = Annotated[str, _whole(PROFILE_NAME)]
DiscoveryId = Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{32}$")]


class _AccountInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider: CloudProvider


class _WorkloadIn(_AccountInput):
    source: Literal["workload"]


class _AzureIn(_AccountInput):
    provider: Literal["azure"]


class _AzureCliIn(_AzureIn):
    source: Literal["cli"]
    subscription_id: AzureId


class _AzureEnteredIn(_AzureIn):
    source: Literal["entered"]
    subscription_id: AzureId
    tenant_id: AzureId
    client_id: AzureId
    client_secret: SecretStr = Field(min_length=1)


class _AzureWorkloadIn(_AzureIn, _WorkloadIn):
    pass


class _AwsIn(_AccountInput):
    provider: Literal["aws"]


class _AwsCliIn(_AwsIn):
    source: Literal["cli"]
    profile: Profile
    regions: list[AwsRegion] = Field(default_factory=list)


class _AwsEnteredIn(_AwsIn):
    source: Literal["entered"]
    regions: list[AwsRegion] = Field(min_length=1)
    access_key_id: str = Field(min_length=1)
    secret_access_key: SecretStr = Field(min_length=1)


class _AwsWorkloadIn(_AwsIn, _WorkloadIn):
    pass


class _GcpIn(_AccountInput):
    provider: Literal["gcp"]


class _GcpCliIn(_GcpIn):
    source: Literal["cli"]
    project_id: ProjectId


class _GcpEnteredIn(_GcpIn):
    source: Literal["entered"]
    project_id: ProjectId
    service_account_key: SecretStr = Field(min_length=1)


class _GcpWorkloadIn(_GcpIn, _WorkloadIn):
    pass


class _OciIn(_AccountInput):
    provider: Literal["oci"]


class _OciCliIn(_OciIn):
    source: Literal["cli"]
    profile: Profile = "DEFAULT"
    regions: list[OciRegion] = Field(default_factory=list)


class _OciEnteredIn(_OciIn):
    source: Literal["entered"]
    regions: list[OciRegion] = Field(min_length=1)
    tenancy_ocid: Ocid
    user_ocid: Ocid
    fingerprint: str = Field(pattern=r"^[A-Fa-f0-9:]+$")
    private_key: SecretStr = Field(min_length=1)
    passphrase: SecretStr | None = None


class _OciWorkloadIn(_OciIn, _WorkloadIn):
    pass


AccountIn = Annotated[
    Annotated[_AzureCliIn | _AzureEnteredIn | _AzureWorkloadIn, Field(discriminator="source")]
    | Annotated[_AwsCliIn | _AwsEnteredIn | _AwsWorkloadIn, Field(discriminator="source")]
    | Annotated[_GcpCliIn | _GcpEnteredIn | _GcpWorkloadIn, Field(discriminator="source")]
    | Annotated[_OciCliIn | _OciEnteredIn | _OciWorkloadIn, Field(discriminator="source")],
    Field(discriminator="provider"),
]


def _account_config(body: AccountIn) -> AccountConfig:
    settings = body.model_dump(exclude={"provider", "source"}, exclude_none=True)
    secret = {
        name: settings.pop(name).get_secret_value()
        for name, value in tuple(settings.items())
        if isinstance(value, SecretStr)
    }
    return AccountConfig(uuid4().hex, body.provider, body.source, "", settings, secret or None)


class EncryptionOut(BaseModel):
    source: Literal["environment", "file"]
    path: str | None


class SettingsOut(BaseModel):
    encryption: EncryptionOut
    discovery_interval_s: int


class ChoiceOut(BaseModel):
    value: str
    label: str


class CliLoginOut(BaseModel):
    provider: CloudProvider
    path: str
    state: Literal["found", "missing", "unreadable"]
    note: str | None
    choices: list[ChoiceOut]


class CheckOut(BaseModel):
    state: Literal["never", "ok", "error"]
    checked_at: datetime | None
    message: str | None
    problems: list[str]


class CountsOut(BaseModel):
    found: int = 0
    added: int = 0
    new: int = 0


class CloudAccountOut(BaseModel):
    id: str
    provider: CloudProvider
    kube_provider: Provider
    name: str
    source: CredentialSourceKind
    scope: str
    principal: str
    regions: list[str]
    profile: str | None
    has_secret: bool
    check: CheckOut
    counts: CountsOut


class DiscoveredOut(BaseModel):
    id: str
    account_id: str
    account_name: str
    provider: Provider
    name: str
    region: str
    kubernetes_version: str | None
    node_pools: list[NodePoolOut]
    node_count: int | None
    environment: Environment
    private: bool
    why_not: str | None
    state: DiscoveryState
    cluster_id: str | None
    first_seen: datetime
    last_seen: datetime
    missing_since: datetime | None


class IdsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ids: list[DiscoveryId] = Field(min_length=1, max_length=50)


class FailedOut(BaseModel):
    id: str
    message: str


class AddOut(BaseModel):
    added: list[ClusterOut]
    failed: list[FailedOut]


def _counts(rows: list[Discovered]) -> dict[str, CountsOut]:
    counts: dict[str, CountsOut] = {}
    for row in rows:
        account = counts.setdefault(row.account_id, CountsOut())
        if row.state == "added":
            account.added += 1
        if row.missing_since is None:
            account.found += 1
            if row.state == "new" and row.cluster.addable:
                account.new += 1
    return counts


def _account_out(account: CloudAccount, counts: CountsOut | None = None) -> CloudAccountOut:
    check_state: Literal["never", "ok", "error"] = "never"
    if account.check_ok is not None:
        check_state = "ok" if account.check_ok else "error"
    return CloudAccountOut(
        id=account.id,
        provider=account.provider,
        kube_provider=KUBE_PROVIDER[account.provider],
        name=account.name,
        source=account.source,
        scope=account.scope,
        principal=account.principal,
        regions=account.settings.get("regions", []),
        profile=account.settings.get("profile"),
        has_secret=account.has_secret,
        check=CheckOut(
            state=check_state,
            checked_at=account.checked_at,
            message=account.check_message,
            problems=account.problems,
        ),
        counts=counts if counts is not None else CountsOut(),
    )


def _discovered_out(row: Discovered, account: CloudAccount) -> DiscoveredOut:
    found = row.cluster
    return DiscoveredOut(
        id=row.id,
        account_id=account.id,
        account_name=account.name,
        provider=KUBE_PROVIDER[account.provider],
        name=found.name,
        region=found.region,
        kubernetes_version=found.kubernetes_version,
        node_pools=[NodePoolOut.from_pool(pool) for pool in found.node_pools],
        node_count=found.node_count,
        environment=row.environment,
        private=found.private,
        why_not=None if found.addable else found.why_not or messages.PRIVATE,
        state=row.state,
        cluster_id=row.cluster_id,
        first_seen=row.first_seen,
        last_seen=row.last_seen,
        missing_since=row.missing_since,
    )


@router.get("/settings")
async def get_settings(request: Request) -> SettingsOut:
    settings = request.app.state.settings
    encryption = (
        EncryptionOut(source="environment", path=None)
        if settings.secret_key
        else EncryptionOut(source="file", path=str(settings.data_dir / "secret.key"))
    )
    return SettingsOut(encryption=encryption, discovery_interval_s=settings.cloud_discovery_seconds)


@router.get("/cloud/logins")
async def list_logins(request: Request) -> list[CliLoginOut]:
    logins = await asyncio.gather(
        *(adapter.cli_login() for adapter in request.app.state.cloud.adapters.values())
    )
    return [
        CliLoginOut(
            provider=login.provider,
            path=login.path,
            state=login.state,
            note=login.note,
            choices=[ChoiceOut(value=choice.value, label=choice.label) for choice in login.choices],
        )
        for login in logins
    ]


@router.get("/cloud/accounts")
async def list_accounts(request: Request) -> list[CloudAccountOut]:
    store = request.app.state.cloud.store
    accounts = await store.list()
    counts = _counts(await store.discovered())
    return [_account_out(account, counts.get(account.id)) for account in accounts]


@router.post("/cloud/accounts", status_code=201)
async def connect_account(body: AccountIn, request: Request) -> CloudAccountOut:
    if body.source == "workload":
        raise HTTPException(status_code=422, detail=messages.WORKLOAD)
    cloud = request.app.state.cloud
    audit = request.app.state.audit
    account = _account_config(body)
    try:
        identity = await cloud.adapters[account.provider].verify(account)
    except CloudError as exc:
        raise HTTPException(status_code=422, detail=exc.message) from None
    except Exception as exc:  # noqa: BLE001 (only curated provider diagnostics are public)
        log.warning("Could not verify the cloud account (%s)", type(exc).__name__)
        raise HTTPException(status_code=422, detail=messages.CHECK_FAILED) from None
    try:
        record = await audit.begin(
            AuditEntry(
                actor_of(request),
                "cloud_account_add",
                "",
                None,
                "cloud-account",
                identity.name,
                provider=KUBE_PROVIDER[account.provider].value,
            )
        )
    except AuditUnavailable as exc:
        raise HTTPException(status_code=503, detail=no_audit_message(exc)) from None
    try:
        created = await cloud.store.create(
            account.provider,
            account.source,
            identity.scope,
            identity.name,
            identity.principal,
            account.settings,
            account.secret,
        )
    except AccountExists as exc:
        message = messages.already_connected(
            messages.ACCOUNT_KINDS[account.provider], exc.existing_name
        )
        await audit.finish(record, "failed", message)
        raise HTTPException(status_code=409, detail=message) from None
    except Exception as exc:  # noqa: BLE001 (do not expose database parameters)
        log.warning("Could not save the cloud account (%s)", type(exc).__name__)
        await audit.finish(record, "failed", messages.ACCOUNT_SAVE_FAILED)
        raise HTTPException(status_code=503, detail=messages.ACCOUNT_SAVE_FAILED) from None
    await audit.finish(record, "succeeded")
    cloud.discovery.schedule(created.id)
    return _account_out(created)


@router.delete("/cloud/accounts/{account_id}", status_code=204)
async def remove_account(account_id: str, request: Request) -> None:
    state = request.app.state
    cloud = state.cloud
    audit = state.audit
    try:
        account = await cloud.store.get(account_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=messages.UNKNOWN_ACCOUNT) from None
    try:
        record = await audit.begin(
            AuditEntry(
                actor_of(request),
                "cloud_account_remove",
                "",
                None,
                "cloud-account",
                account.name,
                provider=KUBE_PROVIDER[account.provider].value,
            )
        )
    except AuditUnavailable as exc:
        raise HTTPException(status_code=503, detail=no_audit_message(exc)) from None
    try:
        removed = await cloud.store.delete(account_id)
    except KeyError:
        await audit.finish(record, "failed", messages.UNKNOWN_ACCOUNT)
        raise HTTPException(status_code=404, detail=messages.UNKNOWN_ACCOUNT) from None
    except Exception as exc:  # noqa: BLE001 (do not expose database parameters)
        log.warning("Could not remove the cloud account (%s)", type(exc).__name__)
        await audit.finish(record, "failed", messages.ACCOUNT_REMOVE_FAILED)
        raise HTTPException(status_code=503, detail=messages.ACCOUNT_REMOVE_FAILED) from None
    cloud.broker.forget_account(account_id)
    await audit.finish(record, "succeeded")
    for cluster_id in removed:
        await state.hub.forget(cluster_id)  # also forgets the broker source


@router.post("/cloud/accounts/{account_id}/check")
async def check_account(account_id: str, request: Request) -> CloudAccountOut:
    cloud = request.app.state.cloud
    try:
        checked = await cloud.discovery.check(account_id)
    except KeyError:
        raise HTTPException(status_code=404, detail=messages.UNKNOWN_ACCOUNT) from None
    except Exception as exc:  # noqa: BLE001 (do not expose database parameters)
        log.warning("Could not check the cloud account (%s)", type(exc).__name__)
        raise HTTPException(status_code=503, detail=messages.CHECK_FAILED) from None
    counts = _counts(await cloud.store.discovered(account_id))
    return _account_out(checked, counts.get(account_id))


@router.get("/cloud/discovered")
async def list_discovered(request: Request) -> list[DiscoveredOut]:
    store = request.app.state.cloud.store
    accounts = {account.id: account for account in await store.list()}
    return [
        _discovered_out(row, accounts[row.account_id])
        for row in await store.discovered()
        if row.account_id in accounts
    ]


async def _add_cluster(discovery_id: str, request: Request) -> ClusterOut | FailedOut:
    state = request.app.state
    cloud = state.cloud
    audit = state.audit
    try:
        row = await cloud.store.discovered_one(discovery_id)
    except KeyError:
        return FailedOut(id=discovery_id, message=messages.UNKNOWN_DISCOVERED)
    found = row.cluster
    if not found.addable:
        return FailedOut(id=discovery_id, message=found.why_not or messages.PRIVATE)
    if row.missing_since is not None:
        return FailedOut(id=discovery_id, message=messages.DISCOVERED_MISSING)
    try:
        account = await cloud.store.get(row.account_id)
        config = await cloud.store.config(row.account_id)
    except KeyError:
        return FailedOut(id=discovery_id, message=messages.UNKNOWN_ACCOUNT)
    access = None
    access_message = messages.CLUSTER_ADD_FAILED
    try:
        access = await cloud.adapters[account.provider].access(config, found)
    except CloudError as exc:
        access_message = exc.message
    except Exception as exc:  # noqa: BLE001 (only curated provider diagnostics are public)
        log.warning("Could not read cloud cluster access (%s)", type(exc).__name__)
    finally:
        # Access can start after DELETE has already forgotten the account's adapter cache.
        try:
            await cloud.store.get(account.id)
        except KeyError:
            cloud.broker.forget_account(account.id)
            access = None
            access_message = messages.UNKNOWN_ACCOUNT
    if access is None:
        return FailedOut(id=discovery_id, message=access_message)

    try:
        record = await audit.begin(
            AuditEntry(
                actor_of(request),
                "cluster_add",
                "",
                None,
                "clusters",
                found.name,
                cluster_name=found.name,
                provider=KUBE_PROVIDER[account.provider].value,
                details={"account": account.name, "resource_id": found.resource_id},
            )
        )
    except AuditUnavailable as exc:
        return FailedOut(id=discovery_id, message=no_audit_message(exc))

    ref = CloudClusterRef(
        account.id, account.provider, found.resource_id, found.name, found.region, found.details
    )
    try:
        info = await state.registry.upsert_cloud_cluster(
            ref,
            found,
            server=access.server,
            ca_data=access.ca_data,
            environment=row.environment,
            discovery=DiscoverySnapshot(row.id, row.last_seen, row.state, row.cluster_id),
        )
    except KeyError:
        cloud.broker.forget_account(account.id)
        message = messages.UNKNOWN_ACCOUNT
    except InvalidClusterEndpoint:
        message = messages.CLOUD_CLUSTER_ENDPOINT_INVALID
    except DiscoveryChanged:
        message = messages.DISCOVERY_CHANGED
    except Exception as exc:  # noqa: BLE001 (do not expose database parameters)
        log.warning("Could not save the cloud cluster (%s)", type(exc).__name__)
        message = messages.CLUSTER_ADD_FAILED
    else:
        await audit.finish(record, "succeeded")
        return cluster_out(info, request, account_name=account.name)
    await audit.finish(record, "failed", message)
    return FailedOut(id=discovery_id, message=message)


@router.post("/cloud/discovered/add")
async def add_discovered(body: IdsIn, request: Request) -> AddOut:
    added, failed = [], []
    for discovery_id in dict.fromkeys(body.ids):
        result = await _add_cluster(discovery_id, request)
        if isinstance(result, FailedOut):
            failed.append(result)
        else:
            added.append(result)
    if added:
        await request.app.state.hub.clusters_changed()
    return AddOut(added=added, failed=failed)


@router.post("/cloud/discovered/dismiss", status_code=204)
async def dismiss_discovered(body: IdsIn, request: Request) -> None:
    await request.app.state.cloud.store.dismiss(body.ids)
