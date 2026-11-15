import asyncio
import json
import os
from contextlib import asynccontextmanager
from dataclasses import asdict
from urllib.parse import urlsplit

import httpx
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from omnikrux.cloud.store import CloudAccountStore
from omnikrux.cloud.types import CloudClusterRef, DiscoveredCluster
from omnikrux.clusters.models import Environment, Provider
from omnikrux.clusters.registry import ClusterInfo, ClusterRegistry
from omnikrux.config import DEFAULT_ALLOWED_HOSTS, Settings
from omnikrux.db import init_db, make_engine, make_sessionmaker
from omnikrux.main import create_app
from omnikrux.security.secrets import SecretBox
from omnikrux.watch.api import watch
from omnikrux.watch.hub import WatchHub
from tests.clusters.test_kubeconfig import kc
from tests.fakecloud import (
    fake_cloud,  # noqa: F401  (shared fixture)
    write_azure_cli_login,
    write_gcloud_login,
)
from tests.fakekube import fake_api  # noqa: F401  (shared fixture)
from tests.live import PROVIDERS, opted_in_provider
from tests.logs.test_stream import pod
from tests.netguard import install as install_network_guard
from tests.watch.fakes import FakeSource


@pytest.fixture(autouse=True)
def allow_testserver_host(monkeypatch):
    """Starlette's TestClient sends `Host: testserver`; allow it next to the real defaults."""
    monkeypatch.setenv("OMNIKRUX_ALLOWED_HOSTS", ",".join([*DEFAULT_ALLOWED_HOSTS, "testserver"]))


@pytest.fixture
def tmp_settings(tmp_path):
    return Settings(data_dir=tmp_path, kubeconfig="", in_container=False)


@pytest_asyncio.fixture
async def registry(tmp_path):
    settings = Settings(data_dir=tmp_path, kubeconfig="", in_container=False)
    engine = make_engine(f"sqlite+aiosqlite:///{tmp_path}/omnikrux.db")
    await init_db(engine)
    yield ClusterRegistry(make_sessionmaker(engine), SecretBox.from_settings(settings))
    await engine.dispose()


@pytest.fixture
def app_with_kubeconfig(tmp_path):
    path = tmp_path / "config"
    path.write_text(kc([("kind-omnikrux-dev", "https://127.0.0.1:6443", None)]), encoding="utf-8")
    app = create_app(Settings(data_dir=tmp_path, kubeconfig=str(path)))
    with TestClient(app) as client:
        yield client, path


class FakeRegistry:
    def __init__(self, infos: list[ClusterInfo]):
        self._infos = infos

    async def list(self) -> list[ClusterInfo]:
        return list(self._infos)


def _cluster(cluster_id: str) -> ClusterInfo:
    return ClusterInfo(
        id=cluster_id,
        name=cluster_id,
        context_name=cluster_id,
        server=f"https://{cluster_id}.example:6443",
        original_server=None,
        provider=Provider.KIND,
        region=None,
        environment=Environment.DEVELOPMENT,
    )


@pytest.fixture
def fake_registry_two_clusters():
    return FakeRegistry([_cluster("good"), _cluster("bad")])


@pytest.fixture
def app_with_fake_sources(tmp_path, fake_registry_two_clusters):
    """The real app, with `app.state.hub` swapped (inside the lifespan) for a hub of FakeSources."""
    from tests.watch.test_cache import p

    async def source_for(cluster_id, spec):
        return await FakeSource(lists=[([p("a")], "1")], watches=[[]]).factory()

    app = create_app(Settings(data_dir=tmp_path, kubeconfig="", in_container=False))
    real_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(app):
        async with real_lifespan(app):
            app.state.hub = WatchHub(fake_registry_two_clusters, source_for)
            try:
                yield
            finally:
                await app.state.hub.close()

    app.router.lifespan_context = lifespan
    with TestClient(app) as client:
        yield client


@pytest.fixture(autouse=True)
def loopback_only(request, monkeypatch):
    """Fail any test that reaches a non-loopback host (an opted-in live cloud check aside)."""
    if opted_in_provider(request.node) is not None:
        yield
        return
    violations: list[str] = []
    install_network_guard(monkeypatch, violations)
    yield
    if violations:
        pytest.fail(f"The test tried to reach the network outside loopback: {violations}")


# The developer's own settings never reach a test; the opt-in live suite keeps its variables.
KEPT_SETTINGS = ("OMNIKRUX_ALLOWED_HOSTS", "OMNIKRUX_LIVE_")


@pytest.fixture(autouse=True)
def isolate_cloud_logins(request, tmp_path, monkeypatch):
    """Keep test apps and credential chains away from developer login files and settings."""
    for variable in [name for name in os.environ if name.upper().startswith("OMNIKRUX_")]:
        if not variable.upper().startswith(KEPT_SETTINGS):
            monkeypatch.delenv(variable)
    provider = opted_in_provider(request.node)
    for cloud in PROVIDERS.values():
        if cloud == PROVIDERS.get(provider):
            continue
        folder = tmp_path / cloud
        folder.mkdir()
        monkeypatch.setenv(f"OMNIKRUX_{cloud.upper()}_DIR", str(folder))
    for variable in (
        "AWS_PROFILE",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "OMNIKRUX_CLOUD_ENDPOINTS",
    ):
        monkeypatch.delenv(variable, raising=False)
    if provider != "gcp":
        monkeypatch.delenv("CLOUDSDK_CONFIG", raising=False)


AZURE_SUBSCRIPTION = "050d52ed-0bc8-46c3-95e1-a7aef67ff331"
AZURE_TENANT = "a1656f69-93d5-4e1b-9583-d3722c77dafe"
AZURE_SERVER_APP = "6dae42f8-4368-4678-94ff-3960e28e3630"
FAKE_CLOUD_USER = "cloud-user@example.test"
FAKE_CLOUD_REFRESH = "synthetic-cluster-refresh-token"


def _seed_cloud_credentials(provider, fake_cloud, fake_api, dirs):  # noqa: F811
    """Return store/registry inputs, without prefetching credentials via verify or discovery."""
    name = "cloud-dev"
    if provider == "azure":
        scope, region = AZURE_SUBSCRIPTION, "westeurope"
        fake_cloud.azure.subscriptions[scope] = {"name": "Test Azure", "tenant": AZURE_TENANT}
        fake_cloud.azure.refresh_tokens[FAKE_CLOUD_REFRESH] = (AZURE_TENANT, FAKE_CLOUD_USER)
        write_azure_cli_login(
            dirs.azure,
            subscriptions=[
                {"id": scope, "name": "Test Azure", "tenantId": AZURE_TENANT, "isDefault": True}
            ],
            refresh_token=FAKE_CLOUD_REFRESH,
            user=FAKE_CLOUD_USER,
        )
        raw = fake_cloud.azure.add_aks(scope, name, server=fake_api.url, location=region)
        return (
            "cli",
            scope,
            {"subscription_id": scope},
            None,
            raw["id"],
            region,
            {"tenant_id": AZURE_TENANT, "server_app_id": AZURE_SERVER_APP},
        )
    if provider == "gcp":
        scope, region = "fake-gke-project", "europe-west1"
        fake_cloud.gcp.refresh_tokens[FAKE_CLOUD_REFRESH] = FAKE_CLOUD_USER
        write_gcloud_login(
            dirs.gcloud,
            adc={
                "type": "authorized_user",
                "account": FAKE_CLOUD_USER,
                "client_id": "synthetic-test-client-id.apps.googleusercontent.com",
                "client_secret": "synthetic-test-client-secret",
                "refresh_token": FAKE_CLOUD_REFRESH,
                "token_uri": fake_cloud.endpoints().gcp_oauth,
            },
            project=scope,
        )
        fake_cloud.gcp.add_gke(scope, name, server=fake_api.url, location=region)
        resource_id = f"projects/{scope}/locations/{region}/clusters/{name}"
        return "cli", scope, {"project_id": scope}, None, resource_id, region, {}
    if provider == "aws":
        region = "eu-west-1"
        scope = fake_cloud.aws.account
        key = "AKIDEXAMPLE"
        secret = "synthetic-test-aws-secret"
        fake_cloud.aws.keys[key] = secret
        fake_cloud.aws.add_eks(region, name, server=fake_api.url)
        return (
            "entered",
            scope,
            {"access_key_id": key, "regions": [region]},
            {"secret_access_key": secret},
            f"arn:aws:eks:{region}:{scope}:cluster/{name}",
            region,
            {},
        )
    assert provider == "oci"
    scope, region = "ocid1.tenancy.oc1..testtenancy", "eu-frankfurt-1"
    user = "ocid1.user.oc1..testuser"
    fingerprint = "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99"
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    fake_cloud.oci.keys[f"{scope}/{user}/{fingerprint}"] = key.public_key().public_bytes(
        serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    resource_id = fake_cloud.oci.add_oke(region, name, server=fake_api.url, compartment=scope)
    secret = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    return (
        "entered",
        scope,
        {"tenancy_ocid": scope, "user_ocid": user, "fingerprint": fingerprint, "regions": [region]},
        {"private_key": secret},
        resource_id,
        region,
        {"region": region, "compartment_id": scope},
    )


@pytest.fixture
def cloud_cluster_context(fake_cloud, fake_api, tmp_settings):  # noqa: F811
    """Start the real app and register a cloud cluster directly through the real Task 4 store."""

    @asynccontextmanager
    async def start(provider):
        endpoints = asdict(fake_cloud.endpoints())
        assert all(urlsplit(url).hostname == "127.0.0.1" for url in endpoints.values())
        settings = tmp_settings.model_copy(
            update={"cloud_endpoints": json.dumps(endpoints), "rewrite_loopback": False}
        )
        source, scope, fields, secret, resource_id, region, details = _seed_cloud_credentials(
            provider, fake_cloud, fake_api, settings.cloud_dirs
        )
        app = create_app(settings)
        fake_api.token_check = fake_cloud.kube_token_ok(provider)
        fake_api.pods[("demo", "web-1")] = pod("web-1", containers=("app",))
        async with app.router.lifespan_context(app):
            store = CloudAccountStore(app.state.sessionmaker, SecretBox.from_settings(settings))
            account = await store.create(
                provider, source, scope, f"Test {provider}", FAKE_CLOUD_USER, fields, secret
            )
            found = DiscoveredCluster(
                resource_id, "cloud-dev", region, None, (), None, {}, False, None, details
            )
            ref = CloudClusterRef(account.id, provider, resource_id, found.name, region, details)
            cluster = await app.state.registry.upsert_cloud_cluster(
                ref, found, server=fake_api.url, ca_data=None, environment=Environment.DEVELOPMENT
            )
            yield app, cluster, account

    return start


@pytest.fixture
async def cloud_cluster(request, cloud_cluster_context):
    async with cloud_cluster_context(getattr(request, "param", "gcp")) as cluster:
        yield cluster


@pytest.fixture
async def cloud_http_client(cloud_cluster):
    app, _, _ = cloud_cluster
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        yield client


@pytest.fixture
def cloud_pods_watch(cloud_cluster):
    from tests.watch.test_ws import RecordingWebSocket

    @asynccontextmanager
    async def running():
        app, _, _ = cloud_cluster
        ws = RecordingWebSocket(app)
        handler = asyncio.create_task(watch(ws, "pods"))
        try:
            yield ws.sent
        finally:
            ws.gone.set()
            await asyncio.wait_for(handler, 5)

    return running
