"""Cloud accounts and Kubernetes operations against kind through local fake providers."""

import asyncio
import json
import os
import queue
import subprocess
import time
from contextlib import ExitStack, contextmanager
from dataclasses import asdict, dataclass
from functools import partial
from pathlib import Path
from urllib.parse import urlencode, urlsplit

import pytest
import yaml
from botocore.httpsession import URLLib3Session
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from omnikrux.cloud.discovery import CloudDiscovery
from omnikrux.cloud.exec_bridge import ExecBridge
from omnikrux.config import DEFAULT_ALLOWED_HOSTS, Settings
from omnikrux.main import create_app
from tests.e2e.cloudproxy import CloudKubeProxy
from tests.e2e.support import Reader, wait_for
from tests.e2e.test_operations_kind import fetch
from tests.e2e.test_troubleshooting_kind import ended, log_lines, logs_url, run_shell
from tests.fakecloud import (
    FakeCloud,
    run_fake_cloud_in_thread,
    write_aws_cli_login,
    write_azure_cli_login,
    write_gcloud_login,
    write_oci_cli_login,
)
from tests.kube.test_source_kind import CONTEXT

pytestmark = pytest.mark.kind

SUBSCRIPTION = "11111111-1111-4111-8111-111111111111"
TENANT = "22222222-2222-4222-8222-222222222222"
CLIENT = "33333333-3333-4333-8333-333333333333"
AZURE_SECRET = "synthetic-kind-only-azure-secret"
AWS_KEY = "AKIDEXAMPLE"
AWS_SECRET = "synthetic-kind-only-aws-secret"
AWS_REGION = "eu-west-1"
GCP_PROJECT = "kind-cloud-test"
OCI_REGION = "eu-frankfurt-1"
CLUSTER_NAMES = {"azure": "aks-dev", "aws": "eks-dev", "gcp": "gke-dev", "oci": "oke-dev"}
DEMO_PODS = {"logger", "crasher"}
ROTATION_ANNOTATION = "omnikrux.dev/cloud-kind-rotation"


@dataclass
class CloudKind:
    client: TestClient
    cloud: FakeCloud
    proxies: dict[str, CloudKubeProxy]
    accounts: dict[str, dict]
    kubeconfig: Path

    def kubectl(self, *args: str) -> str:
        command = ["kubectl", "--kubeconfig", str(self.kubeconfig), "--context", CONTEXT]
        result = subprocess.run(
            [*command, "-n", "demo", *args],
            capture_output=True,
            encoding="utf-8",
            check=False,
            timeout=65,
        )
        assert result.returncode == 0, result.stderr
        return result.stdout


def _seed(cloud, proxies, dirs):
    cloud.azure.subscriptions[SUBSCRIPTION] = {"name": "Synthetic subscription", "tenant": TENANT}
    cloud.azure.add_aks(SUBSCRIPTION, "aks-dev", server=proxies["azure"].url)
    if os.name == "nt":
        cloud.azure.service_principals[TENANT, CLIENT] = AZURE_SECRET
        azure = {
            "source": "entered",
            "subscription_id": SUBSCRIPTION,
            "tenant_id": TENANT,
            "client_id": CLIENT,
            "client_secret": AZURE_SECRET,
        }
    else:
        refresh, user = "synthetic-kind-azure-refresh", "azure-kind@example.test"
        cloud.azure.refresh_tokens[refresh] = TENANT, user
        write_azure_cli_login(
            dirs.azure,
            refresh_token=refresh,
            user=user,
            subscriptions=[
                {
                    "id": SUBSCRIPTION,
                    "name": "Synthetic subscription",
                    "tenantId": TENANT,
                    "isDefault": True,
                }
            ],
        )
        azure = {"source": "cli", "subscription_id": SUBSCRIPTION}

    cloud.aws.keys[AWS_KEY] = AWS_SECRET
    cloud.aws.add_eks(AWS_REGION, "eks-dev", server=proxies["aws"].url)
    write_aws_cli_login(
        dirs.aws,
        profiles={"default": {"region": AWS_REGION}},
        credentials={
            "default": {"aws_access_key_id": AWS_KEY, "aws_secret_access_key": AWS_SECRET}
        },
    )
    refresh, user = "synthetic-kind-gcp-refresh", "gcp-kind@example.test"
    cloud.gcp.refresh_tokens[refresh] = user
    cloud.gcp.add_gke(GCP_PROJECT, "gke-dev", server=proxies["gcp"].url)
    write_gcloud_login(
        dirs.gcloud,
        project=GCP_PROJECT,
        adc={
            "type": "authorized_user",
            "account": user,
            "client_id": "fake.apps.googleusercontent.com",
            "client_secret": "synthetic-kind-gcp-secret",
            "refresh_token": refresh,
            "token_uri": cloud.endpoints().gcp_oauth,
        },
    )

    tenancy = cloud.oci.tenancy["id"]
    user = "ocid1.user.oc1..kindtest"
    fingerprint = "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99"
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    cloud.oci.keys[f"{tenancy}/{user}/{fingerprint}"] = key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    cloud.oci.add_oke(OCI_REGION, "oke-dev", server=proxies["oci"].url, compartment=tenancy)
    write_oci_cli_login(
        dirs.oci,
        key_path_as_written=str(dirs.oci / "kind.pem"),
        profiles={
            "DEFAULT": {
                "region": OCI_REGION,
                "tenancy": tenancy,
                "user": user,
                "fingerprint": fingerprint,
            }
        },
        key_pem=key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ),
    )
    return {
        "azure": {"provider": "azure", **azure},
        "aws": {
            "provider": "aws",
            "source": "entered",
            "access_key_id": AWS_KEY,
            "secret_access_key": AWS_SECRET,
            "regions": [AWS_REGION],
        },
        "gcp": {"provider": "gcp", "source": "cli", "project_id": GCP_PROJECT},
        "oci": {"provider": "oci", "source": "cli", "profile": "DEFAULT", "regions": [OCI_REGION]},
    }


def _local_auth_only(monkeypatch, cloud):
    def bridge(dirs, endpoints, http):
        return ExecBridge(dirs, endpoints, http, which=lambda _: None)

    async def deny_plugin(*_args, **_kwargs):
        pytest.fail("Unexpected credential plugin subprocess")

    def send_local(session, request):
        target = urlsplit(request.url)
        assert (target.scheme, target.hostname, target.port) == ("http", "127.0.0.1", fake_port)
        return send(session, request)

    fake_port = urlsplit(cloud.url).port
    send = URLLib3Session.send
    monkeypatch.setattr("omnikrux.main.ExecBridge", bridge)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", deny_plugin)
    monkeypatch.setattr(URLLib3Session, "send", send_local)


@pytest.fixture
def cloud_kind(tmp_path, kind_kubeconfig, monkeypatch):
    for name in ("OMNIKRUX_DATABASE_URL", "OMNIKRUX_SECRET_KEY", "OMNIKRUX_STATIC_DIR"):
        monkeypatch.delenv(name, raising=False)
    config = yaml.safe_load(kind_kubeconfig.read_text(encoding="utf-8"))
    assert config["current-context"] == CONTEXT
    with ExitStack() as stack:
        fake = run_fake_cloud_in_thread()
        stack.callback(fake.stop)
        cloud = fake.cloud
        # Runs after app/proxy cleanup, even for early assertion failures.
        stack.callback(lambda: assert_read_only(cloud))
        proxies = {}
        for provider in CLUSTER_NAMES:
            proxy = CloudKubeProxy(config, cloud.kube_token_ok(provider))
            stack.callback(proxy.stop)
            proxies[provider] = proxy
        endpoints = asdict(cloud.endpoints())
        assert all(urlsplit(endpoint).hostname == "127.0.0.1" for endpoint in endpoints.values())
        settings = Settings(
            data_dir=tmp_path / "data",
            kubeconfig="",
            in_container=False,
            rewrite_loopback=False,
            allowed_hosts=[*DEFAULT_ALLOWED_HOSTS, "testserver"],
            port_forward_ports="30100-30119",
            port_forward_bind="127.0.0.1",
            azure_dir=tmp_path / "azure",
            aws_dir=tmp_path / "aws",
            gcloud_dir=tmp_path / "gcloud",
            oci_dir=tmp_path / "oci",
            cloud_endpoints=json.dumps(endpoints),
        )
        _local_auth_only(monkeypatch, cloud)
        accounts = _seed(cloud, proxies, settings.cloud_dirs)
        client = stack.enter_context(TestClient(create_app(settings)))
        assert client.get("/api/clusters").json() == []
        yield CloudKind(client, cloud, proxies, accounts, kind_kubeconfig)


def assert_read_only(cloud):
    assert cloud.read_only_violations() == []


def _json(response, status=200):
    assert response.status_code == status, response.text
    return response.json()


def _connect(case, providers):
    accounts = {}
    for provider in providers:
        connected = _json(
            case.client.post("/api/cloud/accounts", json=case.accounts[provider]), 201
        )
        account_id = connected["id"]

        def checked(account_id=account_id):
            account = next(
                a for a in _json(case.client.get("/api/cloud/accounts")) if a["id"] == account_id
            )
            assert account["check"]["state"] != "error", account["check"]
            return account if account["check"]["state"] == "ok" else None

        accounts[provider] = wait_for(checked, f"first discovery for {provider}", interval=0.1)
    rows = _json(case.client.get("/api/cloud/discovered"))
    return accounts, {row["name"]: row for row in rows}


def _add(case, *providers):
    _, rows = _connect(case, providers)
    ids = [rows[CLUSTER_NAMES[provider]]["id"] for provider in providers]
    result = _json(case.client.post("/api/cloud/discovered/add", json={"ids": ids}))
    assert not result["failed"], result["failed"]
    assert {row["name"] for row in result["added"]} == {CLUSTER_NAMES[p] for p in providers}
    return {row["name"]: row["id"] for row in result["added"]}


def _watch_pods(reader, cluster_ids):
    ready, complete = set(), set()
    pods = {cluster: set() for cluster in cluster_ids}

    def collected(message):
        assert message["type"] != "closed", message
        cluster = message.get("cluster_id")
        if cluster not in pods:
            return False
        if message["type"] == "cluster_status":
            assert message["state"] != "error", message
            if message["state"] == "ready":
                ready.add(cluster)
        if message["type"] == "snapshot":
            pods[cluster].update(
                row["name"] for row in message["rows"] if row["namespace"] == "demo"
            )
            if message["last"]:
                complete.add(cluster)
        return complete == ready == set(cluster_ids)

    reader.until(collected, "ready pod bands and complete snapshots")
    assert all(DEMO_PODS <= names for names in pods.values()), pods


def test_connect_four_accounts_and_discover(cloud_kind):
    accounts, rows = _connect(cloud_kind, CLUSTER_NAMES)
    assert set(rows) == set(CLUSTER_NAMES.values())
    for provider, name in CLUSTER_NAMES.items():
        assert rows[name]["state"] == "new"
        assert rows[name]["account_id"] == accounts[provider]["id"]


def test_add_clusters_and_watch_demo_pods(cloud_kind):
    clusters = _add(cloud_kind, *CLUSTER_NAMES)
    with cloud_kind.client.websocket_connect("/api/watch?kind=pods") as ws:
        _watch_pods(Reader(ws), set(clusters.values()))


def test_cloud_cluster_logs_exec_and_port_forward(cloud_kind):
    cluster = _add(cloud_kind, "aws")["eks-dev"]
    client = cloud_kind.client
    cloud_kind.kubectl("wait", "--for=condition=Ready", "pod/logger", "--timeout=60s")
    with client.websocket_connect(
        logs_url(cluster, pod="logger", follow="true", tail_lines=0)
    ) as ws:
        seen = []

        def ticks(message):
            assert not ended(message), message
            seen.append(message)
            return sum(line.get("text", "").startswith("tick ") for line in log_lines(seen)) >= 3

        Reader(ws).until(ticks, "three EKS logger ticks", timeout=20)

    command = urlencode(
        [
            ("cluster", cluster),
            ("namespace", "demo"),
            ("pod", "logger"),
            ("container", "logger"),
            ("command", "sh"),
            ("command", "-c"),
            ("command", "echo hi"),
        ]
    )
    output, last = run_shell(client, f"/api/exec?{command}", [])
    assert output.strip() == "hi"
    assert last["type"] == "exit" and last["code"] == 0, last

    cloud_kind.kubectl("rollout", "status", "deployment/web", "--timeout=60s")
    forward = _json(
        client.post(
            "/api/port-forwards",
            json={
                "cluster_id": cluster,
                "namespace": "demo",
                "kind": "service",
                "name": "web",
                "port": 80,
            },
        )
    )
    try:
        assert forward["state"] == "listening" and forward["address"].startswith("127.0.0.1:")

        def served():
            try:
                return fetch(f"http://{forward['address']}/")
            except OSError:
                return None

        assert "Welcome to nginx!" in wait_for(served, "nginx via EKS", timeout=30)
    finally:
        assert client.delete(f"/api/port-forwards/{forward['id']}").status_code == 204
    paths = {record.path for record in cloud_kind.proxies["aws"].accepted if record.kind == "ws"}
    assert "/api/v1/namespaces/demo/pods/logger/exec" in paths
    assert any(path.endswith("/portforward") for path in paths)


def _streams(records, kind):
    path = "/api/v1/pods" if kind == "watch" else "/api/v1/namespaces/demo/pods/logger/log"
    return {record.token for record in records if record.kind == kind and record.path == path}


@contextmanager
def _annotated_logger(cloud_kind):
    pod = json.loads(cloud_kind.kubectl("get", "pod/logger", "-o", "json"))
    previous = pod["metadata"].get("annotations", {}).get(ROTATION_ANNOTATION)
    value = "verified" if previous == "renewed" else "renewed"
    restore = (
        f"{ROTATION_ANNOTATION}={previous}" if previous is not None else f"{ROTATION_ANNOTATION}-"
    )
    try:
        updated = cloud_kind.kubectl(
            "annotate",
            "pod/logger",
            f"{ROTATION_ANNOTATION}={value}",
            "--overwrite",
            "-o",
            "json",
        )
        yield json.loads(updated)["metadata"]["resourceVersion"]
    finally:
        cloud_kind.kubectl("annotate", "pod/logger", restore, "--overwrite")


def test_token_rotation_keeps_watch_and_logs_alive(cloud_kind):
    cloud_kind.kubectl("wait", "--for=condition=Ready", "pod/logger", "--timeout=60s")
    cloud_kind.cloud.token_lifetime["gcp"] = 20
    cluster = _add(cloud_kind, "gcp")["gke-dev"]
    client, proxy = cloud_kind.client, cloud_kind.proxies["gcp"]
    with (
        client.websocket_connect("/api/watch?kind=pods") as watch_ws,
        client.websocket_connect(
            logs_url(cluster, pod="logger", follow="true", tail_lines=0)
        ) as log_ws,
    ):
        watch, logs = Reader(watch_ws), Reader(log_ws)
        _watch_pods(watch, {cluster})
        deadline = time.monotonic() + 50
        last_tick = 0.0
        marked_version = None
        saw_annotation = False

        def check_log(message):
            nonlocal last_tick
            assert not ended(message), message
            for line in log_lines([message]):
                assert "marker" not in line, line
                if line.get("text", "").startswith("tick "):
                    last_tick = time.monotonic()

        def check_watch(message):
            nonlocal saw_annotation
            assert message["type"] != "closed" and message.get("state") != "error", message
            if message["type"] == "upsert" and message["cluster_id"] == cluster:
                row = message["row"]
                if (
                    row["namespace"] == "demo"
                    and row["name"] == "logger"
                    and marked_version is not None
                    and row["columns"]["resource_version"] == marked_version
                ):
                    opened = _streams(proxy.opened, "watch")
                    expired = _streams(proxy.expired, "watch")
                    assert len(opened) == 3 and len(expired) == 2 and expired < opened
                    saw_annotation = True

        with ExitStack() as cleanup:
            while (remaining := deadline - time.monotonic()) > 0:
                try:
                    check_log(logs.messages.get(timeout=min(0.25, remaining)))
                except queue.Empty:
                    pass
                _drain(watch, check_watch)
                if marked_version is None and len(_streams(proxy.opened, "watch")) >= 3:
                    marked_version = cleanup.enter_context(_annotated_logger(cloud_kind))
            _drain(watch, check_watch)
            _drain(logs, check_log)
            assert saw_annotation, "the renewed watch did not deliver the logger annotation"

        assert last_tick >= deadline - 3, "logger stopped before the observation window ended"
        for kind in ("watch", "logs"):
            assert len(_streams(proxy.opened, kind)) >= 3, f"too few successful {kind} streams"
            assert len(_streams(proxy.expired, kind)) >= 2, f"too few {kind} stream expiries"
        assert len(set(proxy.tokens_seen)) >= 3


def _drain(reader, check):
    while True:
        try:
            message = reader.messages.get_nowait()
        except queue.Empty:
            return
        check(message)


def test_imported_kubeconfig_with_aws_exec_uses_bridge(cloud_kind):
    config = {
        "apiVersion": "v1",
        "kind": "Config",
        "current-context": "imported-eks",
        "clusters": [{"name": "eks", "cluster": {"server": cloud_kind.proxies["aws"].url}}],
        "contexts": [{"name": "imported-eks", "context": {"cluster": "eks", "user": "aws"}}],
        "users": [
            {
                "name": "aws",
                "user": {
                    "exec": {
                        "apiVersion": "client.authentication.k8s.io/v1beta1",
                        "command": "aws",
                        "args": [
                            "eks",
                            "get-token",
                            "--cluster-name",
                            "eks-dev",
                            "--region",
                            AWS_REGION,
                        ],
                    }
                },
            }
        ],
    }
    client = cloud_kind.client
    [imported] = _json(
        client.post("/api/clusters/kubeconfig", json={"kubeconfig": yaml.safe_dump(config)})
    )
    assert imported["source"] == "upload"
    with client.websocket_connect("/api/watch?kind=pods") as ws:
        _watch_pods(Reader(ws), {imported["id"]})
    assert cloud_kind.proxies["aws"].tokens_seen


@pytest.fixture
def manual_cloud_kind(request, monkeypatch):
    monkeypatch.setattr("omnikrux.main.CloudDiscovery", partial(CloudDiscovery, startup_delay=600))
    return request.getfixturevalue("cloud_kind")


def test_new_cluster_found_after_check(manual_cloud_kind):
    cloud_kind = manual_cloud_kind
    accounts, rows = _connect(cloud_kind, ["aws"])
    assert set(rows) == {"eks-dev"}
    existing_id = rows["eks-dev"]["id"]
    cloud_kind.cloud.aws.add_eks(AWS_REGION, "eks-two", server=cloud_kind.proxies["aws"].url)
    assert {row["name"] for row in _json(cloud_kind.client.get("/api/cloud/discovered"))} == {
        "eks-dev"
    }
    account_id = accounts["aws"]["id"]
    checked = _json(cloud_kind.client.post(f"/api/cloud/accounts/{account_id}/check"))
    assert checked["check"]["state"] == "ok"
    rows = {row["name"]: row for row in _json(cloud_kind.client.get("/api/cloud/discovered"))}
    assert rows["eks-dev"]["id"] == existing_id and rows["eks-dev"]["state"] == "new"
    assert rows["eks-two"]["account_id"] == account_id and rows["eks-two"]["state"] == "new"


def test_remove_cloud_cluster_audited_and_gone(cloud_kind):
    cluster = _add(cloud_kind, "aws")["eks-dev"]
    client = cloud_kind.client
    with client.websocket_connect("/api/watch?kind=pods") as ws:
        reader = Reader(ws)
        _watch_pods(reader, {cluster})
        assert client.delete(f"/api/clusters/{cluster}").status_code == 204
        messages = reader.until(lambda msg: msg["type"] in {"cluster_removed", "closed"}, "removal")
        assert messages[-1] == {"type": "cluster_removed", "cluster_id": cluster}
    assert all(row["id"] != cluster for row in _json(client.get("/api/clusters")))
    [found] = _json(client.get("/api/cloud/discovered"))
    assert found["name"] == "eks-dev" and found["state"] == "dismissed"
    [record] = _json(client.get("/api/audit", params={"action": "cluster_remove"}))["records"]
    assert record["cluster_id"] == cluster and record["outcome"] == "succeeded"


def test_fake_cloud_saw_only_reads(cloud_kind):
    _add(cloud_kind, *CLUSTER_NAMES)
    assert cloud_kind.cloud.requests
    assert_read_only(cloud_kind.cloud)
