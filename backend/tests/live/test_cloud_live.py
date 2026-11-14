"""Read-only checks against existing resources in your own cloud accounts.

From backend, for example:
OMNIKRUX_LIVE_CLOUDS=gcp OMNIKRUX_LIVE_GCP_PROJECT=my-project python -m uv run pytest -m cloud_live tests/live -q

AWS takes OMNIKRUX_LIVE_AWS_PROFILE and comma-separated OMNIKRUX_LIVE_AWS_REGIONS.
OCI takes OMNIKRUX_LIVE_OCI_PROFILE. Azure takes OMNIKRUX_LIVE_AZURE_SUBSCRIPTION.
On Windows, Azure also takes OMNIKRUX_LIVE_AZURE_TENANT_ID,
OMNIKRUX_LIVE_AZURE_CLIENT_ID and OMNIKRUX_LIVE_AZURE_CLIENT_SECRET for an existing
service principal. On supported non-Windows hosts Azure uses the CLI cache.

Set OMNIKRUX_LIVE_CLUSTER_<PROVIDER> to the resource ID of an existing cluster to
check its version and list namespaces with the provider token. These checks only
read and cost nothing beyond what the account already runs.
"""

import os
from types import SimpleNamespace

import pytest
from kubernetes_asyncio.client import CoreV1Api

from omnikrux.cloud.http import CLOUD_TIMEOUT_SECONDS
from omnikrux.cloud.types import CloudClusterRef
from omnikrux.kube.connections import ClusterConnections
from omnikrux.kube.tokens import CachedToken, CloudTokenSource
from tests.live.conftest import SafeLiveFailure, install_kube_guard, safe_live_errors


async def _verify(live_cloud):
    adapter, account, _ = live_cloud
    with safe_live_errors("The live cloud check failed. Check the login and account permissions."):
        identity = await adapter.verify(account)
        assert identity.scope and identity.name


async def _discover(live_cloud):
    adapter, account, _ = live_cloud
    with safe_live_errors("The live cloud check failed. Check the account permissions and scope."):
        result = await adapter.discover(account)
        assert not result.problems and isinstance(result.clusters, list)


async def _probe_cluster(live_cloud, monkeypatch):
    with safe_live_errors(
        "The live cloud check failed. Check the cluster endpoint and Kubernetes permissions."
    ):
        await _read_cluster(live_cloud, monkeypatch)


async def _read_cluster(live_cloud, monkeypatch):
    adapter, account, endpoints = live_cloud
    variable = f"OMNIKRUX_LIVE_CLUSTER_{account.provider.upper()}"
    resource_id = os.getenv(variable)
    if not resource_id or not resource_id.strip():
        pytest.skip(f"Set {variable} to check an existing cluster.")

    result = await adapter.discover(account)
    matches = [cluster for cluster in result.clusters if cluster.resource_id == resource_id]
    if len(matches) != 1:
        raise SafeLiveFailure(f"Discovery did not return exactly one cluster matching {variable}.")
    found = matches[0]
    access = await adapter.access(account, found)
    endpoints.validate_cluster_server(account.provider, access.server)
    ref = CloudClusterRef(
        account.id, account.provider, found.resource_id, found.name, found.region, found.details
    )
    token = CloudTokenSource(CachedToken(adapter.token_fetch(account, ref)))
    cluster = {"server": access.server}
    if access.ca_data is not None:
        cluster["certificate-authority-data"] = access.ca_data
    config = {
        "apiVersion": "v1",
        "kind": "Config",
        "current-context": "live",
        "clusters": [{"name": "live", "cluster": cluster}],
        "users": [{"name": "live", "user": {}}],
        "contexts": [{"name": "live", "context": {"cluster": "live", "user": "live"}}],
    }

    async def get_kubeconfig(_cluster_id):
        return config

    async def tokens_for(_cluster_id):
        return token

    connections = ClusterConnections(
        SimpleNamespace(get_kubeconfig=get_kubeconfig), tokens_for=tokens_for
    )
    async with connections.api(resource_id) as api:
        install_kube_guard(monkeypatch, api, access.server)
        # VersionApi adds a trailing slash. Keep the wire path pinned to /version.
        version = await api.call_api(
            "/version",
            "GET",
            response_types_map={200: "object"},
            auth_settings=["BearerToken"],
            _return_http_data_only=True,
            _request_timeout=CLOUD_TIMEOUT_SECONDS,
        )
        assert isinstance(version, dict) and version.get("gitVersion")
        namespaces = await CoreV1Api(api).list_namespace(_request_timeout=CLOUD_TIMEOUT_SECONDS)
        assert isinstance(namespaces.items, list)


@pytest.mark.cloud_live(provider="azure")
async def test_azure_login_verifies(live_cloud):
    await _verify(live_cloud)


@pytest.mark.cloud_live(provider="azure")
async def test_azure_discovery_lists(live_cloud):
    await _discover(live_cloud)


@pytest.mark.cloud_live(provider="azure")
async def test_azure_cluster_token_reads_version(live_cloud, monkeypatch):
    await _probe_cluster(live_cloud, monkeypatch)


@pytest.mark.cloud_live(provider="aws")
async def test_aws_login_verifies(live_cloud):
    await _verify(live_cloud)


@pytest.mark.cloud_live(provider="aws")
async def test_aws_discovery_lists(live_cloud):
    await _discover(live_cloud)


@pytest.mark.cloud_live(provider="aws")
async def test_aws_cluster_token_reads_version(live_cloud, monkeypatch):
    await _probe_cluster(live_cloud, monkeypatch)


@pytest.mark.cloud_live(provider="gcp")
async def test_gcp_login_verifies(live_cloud):
    await _verify(live_cloud)


@pytest.mark.cloud_live(provider="gcp")
async def test_gcp_discovery_lists(live_cloud):
    await _discover(live_cloud)


@pytest.mark.cloud_live(provider="gcp")
async def test_gcp_cluster_token_reads_version(live_cloud, monkeypatch):
    await _probe_cluster(live_cloud, monkeypatch)


@pytest.mark.cloud_live(provider="oci")
async def test_oci_login_verifies(live_cloud):
    await _verify(live_cloud)


@pytest.mark.cloud_live(provider="oci")
async def test_oci_discovery_lists(live_cloud):
    await _discover(live_cloud)


@pytest.mark.cloud_live(provider="oci")
async def test_oci_cluster_token_reads_version(live_cloud, monkeypatch):
    await _probe_cluster(live_cloud, monkeypatch)
