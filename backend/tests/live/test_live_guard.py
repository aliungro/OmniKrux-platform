"""Default-suite transport contracts. All credentials and destinations here are synthetic."""

import os
import subprocess
import sys
from contextlib import closing
from pathlib import Path
from textwrap import dedent
from types import SimpleNamespace

import aiohttp
import pytest
import requests
from botocore.awsrequest import AWSResponse
from botocore.httpsession import URLLib3Session
from google.auth.transport.requests import Request
from kubernetes_asyncio.client import CoreV1Api

from omnikrux.cloud.aws import AwsKeys, _client
from omnikrux.cloud.endpoints import CloudEndpoints
from omnikrux.cloud.gcp import _OAuthRequest
from omnikrux.cloud.http import CloudHttp
from omnikrux.kube.connections import ClusterConnections
from omnikrux.kube.tokens import BearerToken, CloudTokenSource
from tests.fakekube import kubeconfig_for, serve_fake_api
from tests.live import conftest, opted_in_provider

REGION = "eu-west-1"
LOCAL = "http://127.0.0.1:1"
ENDPOINTS = CloudEndpoints(
    azure_arm=LOCAL,
    aws_eks=LOCAL,
    aws_sts=LOCAL,
    gcp_oauth=f"{LOCAL}/token",
    oci_containerengine=LOCAL,
)


class UnexpectedSend(Exception):
    pass


def refuse_transport(*args, **kwargs):
    raise UnexpectedSend("synthetic transport was reached")


@pytest.fixture
def guard_contract():
    return conftest


@pytest.mark.parametrize(
    ("markers", "expression", "args", "selected", "expected"),
    [
        ({"cloud_live": "gcp"}, "cloud_live", ("-m", "cloud_live"), "aws, gcp", "gcp"),
        ({"cloud_live": "aws"}, "cloud_live", ("-m", "cloud_live"), "gcp", None),
        ({"cloud_live": "gcp"}, "cloud_live", ("-mcloud_live",), "", None),
        ({"cloud_live": "gcp"}, "cloud_live", (), "gcp", None),
        ({"cloud_live": "gcp"}, "", (), "gcp", None),
        ({"cloud_live": "gcp"}, "kind", ("-m", "kind"), "gcp", None),
        ({"cloud_live": "gcp", "kind": None}, "cloud_live", ("-mcloud_live",), "gcp", None),
        ({}, "cloud_live", ("-m", "cloud_live"), "gcp", None),
    ],
)
def test_live_opt_in_is_explicit_and_provider_specific(
    monkeypatch, markers, expression, args, selected, expected
):
    monkeypatch.setattr(os, "getenv", lambda _name, _default: selected)
    item = SimpleNamespace(
        get_closest_marker={
            name: SimpleNamespace(kwargs={"provider": provider})
            for name, provider in markers.items()
        }.get,
        config=SimpleNamespace(
            getoption=lambda _name: expression, invocation_params=SimpleNamespace(args=args)
        ),
    )
    assert opted_in_provider(item) == expected


@pytest.mark.parametrize("trace_option", ["--tb=long", "--full-trace"])
def test_live_failure_reports_hide_credentials(tmp_path, trace_option):
    cases = tmp_path / "test_report.py"
    cases.write_text(
        dedent(
            """
            from contextlib import asynccontextmanager
            from types import SimpleNamespace
            import logging
            import sys

            import pytest
            from kubernetes_asyncio.client.exceptions import ApiException

            from omnikrux.cloud.http import CloudError
            from omnikrux.cloud.types import AccountConfig, DiscoveredCluster
            from tests.live import conftest, test_cloud_live as checks

            live = pytest.mark.cloud_live(provider="azure")

            @pytest.fixture
            def isolate_cloud_logins():
                pass

            class FakeAdapter:
                async def verify(self, account):
                    await self._sign_in(account.secret["client_secret"])

                async def _sign_in(self, client_secret):
                    raise CloudError(f"Azure refused access (401) for {client_secret}.")

                async def discover(self, account):
                    cluster = DiscoveredCluster(
                        "synthetic", "synthetic", "test", None, (), None, {}, False, None, {}
                    )
                    return SimpleNamespace(clusters=[cluster])

                async def access(self, account, cluster):
                    return SimpleNamespace(server="https://cluster.example.test", ca_data=None)

                def token_fetch(self, account, ref):
                    return None

            class FakeConnections:
                def __init__(self, *args, **kwargs):
                    pass

                @asynccontextmanager
                async def api(self, cluster_id):
                    yield SimpleNamespace(call_api=self._call)

                async def _call(self, *args, **kwargs):
                    await self._transport("synthetic-kube-bearer-canary")

                async def _transport(self, authorization):
                    raise ApiException(status=403, reason=f"Forbidden: {authorization}")

            @pytest.fixture(autouse=True)
            def synthetic_inputs(request, monkeypatch):
                if request.node.get_closest_marker("cloud_live") is None:
                    yield
                    return

                def make_adapters(http, endpoints, cloud_dirs):
                    if request.node.name == "test_fixture":
                        raise OSError("synthetic-fixture-path-canary")
                    return {"azure": FakeAdapter()}

                monkeypatch.setattr(conftest, "opted_in_provider", lambda _: "azure")
                monkeypatch.setattr(conftest, "_account", lambda _: AccountConfig(
                    "synthetic", "azure", "entered", "", {},
                    {"client_secret": "synthetic-azure-secret-canary"},
                ))
                monkeypatch.setattr(conftest, "Settings", lambda **_: SimpleNamespace(cloud_dirs=None))
                monkeypatch.setattr(conftest, "make_adapters", make_adapters)
                monkeypatch.setattr(checks, "ClusterConnections", FakeConnections)
                monkeypatch.setattr(checks, "install_kube_guard", lambda *args: None)
                print("synthetic-stdout-canary")
                print("synthetic-stderr-canary", file=sys.stderr)
                logging.warning("synthetic-log-canary")
                yield
                if request.node.name == "test_provider":
                    logging.warning("synthetic-successful-teardown-canary")
                if request.node.name == "test_teardown":
                    raise OSError("synthetic-teardown-canary")

            @live
            @pytest.mark.asyncio
            async def test_provider(live_cloud):
                await checks.test_azure_login_verifies(live_cloud)

            @live
            @pytest.mark.asyncio
            async def test_kubernetes(live_cloud, monkeypatch):
                monkeypatch.setenv("OMNIKRUX_LIVE_CLUSTER_AZURE", "synthetic")
                await checks.test_azure_cluster_token_reads_version(live_cloud, monkeypatch)

            @live
            @pytest.mark.asyncio
            async def test_fixture(live_cloud):
                raise AssertionError("fixture should have failed")

            @live
            @pytest.mark.asyncio
            async def test_cluster_skip(live_cloud, monkeypatch):
                monkeypatch.delenv("OMNIKRUX_LIVE_CLUSTER_AZURE", raising=False)
                await checks.test_azure_cluster_token_reads_version(live_cloud, monkeypatch)

            @live
            def test_teardown():
                pass

            def test_unmarked():
                logging.warning("unmarked capture remains visible")
                pytest.fail("unmarked failure remains visible")
            """
        ),
        encoding="utf-8",
    )
    backend = Path(__file__).resolve().parents[2]
    child_env = os.environ.copy()
    child_env.pop("PYTEST_ADDOPTS", None)
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "-p",
            "tests.live.conftest",
            "-c",
            str(backend / "pyproject.toml"),
            trace_option,
            "--showlocals",
            "-q",
            str(cases),
        ],
        cwd=backend,
        env=child_env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    report = result.stdout + result.stderr
    assert result.returncode == 1
    assert "3 failed, 1 passed, 1 skipped, 2 errors" in report
    for canary in (
        "azure-secret",
        "kube-bearer",
        "fixture-path",
        "stdout",
        "stderr",
        "log",
        "successful-teardown",
        "teardown",
    ):
        if f"synthetic-{canary}-canary" in report:
            pytest.fail(f"The nested pytest report exposed the {canary} canary.", pytrace=False)
    assert "The live cloud check failed. Check the login and account permissions." in report
    assert (
        "The live cloud check failed. Check the cluster endpoint and Kubernetes permissions."
        in report
    )
    assert "Live cloud check setup failed." in report
    assert "unmarked capture remains visible" in report
    assert "unmarked failure remains visible" in report


async def test_guard_refuses_a_write(monkeypatch, guard_contract):
    monkeypatch.setattr(aiohttp.ClientSession, "request", refuse_transport)
    guard_contract.install_cloud_guard(monkeypatch, "azure", ENDPOINTS)
    http = CloudHttp()
    try:
        with pytest.raises(guard_contract.ReadOnlyViolation):
            await http.json("POST", f"{LOCAL}/write", cloud="Azure", action="synthetic write")
    finally:
        await http.close()


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("DELETE", "/20180222/clusters"),
        ("GET", "/20180222/clusters/extra"),
        ("GET", "/20180222/clusters?__method=DELETE"),
    ],
)
async def test_oci_array_page_is_guarded(monkeypatch, guard_contract, method, path):
    monkeypatch.setattr(aiohttp.ClientSession, "request", refuse_transport)
    guard_contract.install_cloud_guard(monkeypatch, "oci", ENDPOINTS)
    http = CloudHttp()
    try:
        with pytest.raises(guard_contract.ReadOnlyViolation):
            await http.array_page(method, LOCAL + path, cloud="Oracle Cloud", action="test page")
    finally:
        await http.close()


async def test_oci_array_page_allows_encoded_pagination(monkeypatch, guard_contract):
    class Page:
        status = 200

        def __init__(self):
            self.headers = {"opc-next-page": "next+/="}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            pass

        async def read(self):
            return b'[{"id":"synthetic"}]'

    url = f"{LOCAL}/20180222/clusters?compartmentId=ocid1.tenancy.oc1..test&page=opaque%2B%2F%3D"

    def send(_session, method, sent_url, **kwargs):
        assert method == "GET" and str(sent_url) == url
        assert kwargs["allow_redirects"] is False
        return Page()

    monkeypatch.setattr(aiohttp.ClientSession, "request", send)
    guard_contract.install_cloud_guard(monkeypatch, "oci", ENDPOINTS)
    http = CloudHttp()
    try:
        assert await http.array_page("GET", url, cloud="Oracle Cloud", action="test page") == (
            [{"id": "synthetic"}],
            "next+/=",
        )
    finally:
        await http.close()


def test_botocore_rejects_a_mutating_sdk_operation(monkeypatch, guard_contract):
    monkeypatch.setattr(URLLib3Session, "send", refuse_transport)
    guard_contract.install_cloud_guard(monkeypatch, "aws", ENDPOINTS)
    keys = AwsKeys("AKIDEXAMPLE", "synthetic-test-secret", None)
    with (
        closing(_client("eks", REGION, ENDPOINTS, "test delete", keys)) as sdk,
        pytest.raises(guard_contract.ReadOnlyViolation),
    ):
        sdk.delete_cluster(name="synthetic")


def test_botocore_checks_sts_action_at_send(monkeypatch, guard_contract):
    monkeypatch.setattr(URLLib3Session, "send", refuse_transport)
    guard_contract.install_cloud_guard(monkeypatch, "aws", ENDPOINTS)
    keys = AwsKeys("AKIDEXAMPLE", "synthetic-test-secret", None)
    with closing(_client("sts", REGION, ENDPOINTS, "test identity", keys)) as sdk:

        def replace_action(request, **kwargs):
            request.body = b"Action=GetSessionToken&Version=2011-06-15"

        sdk.meta.events.register_first("before-send.sts.GetCallerIdentity", replace_action)
        with pytest.raises(guard_contract.ReadOnlyViolation):
            sdk.get_caller_identity()


def test_botocore_allows_a_list_operation(monkeypatch, guard_contract):
    def send(_session, request):
        assert request.method == "GET" and request.url == f"{LOCAL}/clusters"
        return AWSResponse(
            request.url, 200, {}, SimpleNamespace(stream=lambda: [b'{"clusters":[]}'])
        )

    monkeypatch.setattr(URLLib3Session, "send", send)
    guard_contract.install_cloud_guard(monkeypatch, "aws", ENDPOINTS)
    keys = AwsKeys("AKIDEXAMPLE", "synthetic-test-secret", None)
    with closing(_client("eks", REGION, ENDPOINTS, "test list", keys)) as sdk:
        assert sdk.list_clusters()["clusters"] == []


@pytest.mark.parametrize(
    "transport", [Request, _OAuthRequest], ids=["google-sdk", "omnikrux-oauth"]
)
def test_gcp_blocks_wrong_grant_before_requests_transport(monkeypatch, guard_contract, transport):
    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", refuse_transport)
    guard_contract.install_cloud_guard(monkeypatch, "gcp", ENDPOINTS)
    with requests.Session() as session:
        session.trust_env = False
        url = ENDPOINTS.gcp_oauth
        request = (
            transport(session, url, adc=True) if transport is _OAuthRequest else transport(session)
        )
        with pytest.raises(guard_contract.ReadOnlyViolation):
            request(
                url,
                method="POST",
                body=b"grant_type=delete_everything",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )


def test_gcp_allows_the_adapter_refresh_grant(monkeypatch, guard_contract):
    def send(_adapter, request, **kwargs):
        assert request.method == "POST" and request.url == ENDPOINTS.gcp_oauth
        response = requests.Response()
        response.status_code = 200
        response._content = b'{"access_token":"synthetic-access","expires_in":3600}'
        return response

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", send)
    guard_contract.install_cloud_guard(monkeypatch, "gcp", ENDPOINTS)
    with requests.Session() as session:
        session.trust_env = False
        request = _OAuthRequest(session, ENDPOINTS.gcp_oauth, adc=True)
        response = request(
            ENDPOINTS.gcp_oauth,
            method="POST",
            body=b"grant_type=refresh_token&refresh_token=synthetic-refresh",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        assert response.status == 200


async def test_cluster_probe_limits_bearer_to_version_and_namespaces(monkeypatch, guard_contract):
    bearer = "synthetic-live-cluster-token"

    async def token():
        return BearerToken(bearer, None)

    async def tokens_for(_cluster_id):
        return CloudTokenSource(token)

    async with serve_fake_api() as kube:
        kube.token_check = lambda authorization: authorization == f"Bearer {bearer}"
        config = kubeconfig_for(kube)
        config["users"][0]["user"] = {}

        async def get_kubeconfig(_cluster_id):
            return config

        connections = ClusterConnections(
            SimpleNamespace(get_kubeconfig=get_kubeconfig), tokens_for=tokens_for
        )
        async with connections.api("synthetic") as api:
            guard_contract.install_kube_guard(monkeypatch, api, kube.url)
            version = await api.call_api(
                "/version",
                "GET",
                response_types_map={200: "object"},
                auth_settings=["BearerToken"],
                _return_http_data_only=True,
            )
            assert version["gitVersion"]
            assert isinstance((await CoreV1Api(api).list_namespace()).items, list)
            with pytest.raises(guard_contract.ReadOnlyViolation):
                await CoreV1Api(api).list_pod_for_all_namespaces()
            with pytest.raises(guard_contract.ReadOnlyViolation):
                await api.call_api("/api/v1/namespaces", "POST", auth_settings=["BearerToken"])
            with pytest.raises(guard_contract.ReadOnlyViolation):
                await CoreV1Api(api).list_namespace(watch=True, _request_timeout=1)

        assert kube.requests == [("GET", "/version", {}), ("GET", "/api/v1/namespaces", {})]
