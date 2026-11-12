def test_auto_import_on_startup_and_no_secrets_in_response(app_with_kubeconfig):
    client, _ = app_with_kubeconfig
    body = client.get("/api/clusters").json()
    assert body[0]["provider"] == "kind" and body[0]["environment"] == "development"
    assert body[0]["state"] == "unknown" and body[0]["message"] is None
    assert "token" not in client.get("/api/clusters").text


def test_list_clusters_hides_cloud_endpoint(app_with_kubeconfig):
    from omnikrux.cloud.store import CloudAccountStore
    from omnikrux.security.secrets import SecretBox
    from tests.cloud.test_store import account, add, found
    from tests.clusters.test_kubeconfig import kc

    client, _ = app_with_kubeconfig
    state = client.app.state

    async def seed_cloud_cluster():
        store = CloudAccountStore(state.sessionmaker, SecretBox.from_settings(state.settings))
        owner = await account(store)
        return await add(state.registry, owner, found(), ca_data="synthetic-ca")

    cloud = client.portal.call(seed_cloud_cluster)
    upload_server = "https://upload.example.test"
    response = client.post(
        "/api/clusters/kubeconfig",
        json={"kubeconfig": kc([("uploaded", upload_server, None)])},
    )
    assert response.status_code == 200
    response = client.get("/api/clusters")
    by_name = {cluster["name"]: cluster for cluster in response.json()}
    assert by_name[cloud.name]["server"] is None
    assert by_name["kind-omnikrux-dev"]["server"] == "https://127.0.0.1:6443"
    assert by_name["uploaded"]["server"] == upload_server
    assert cloud.server not in response.text
    assert "synthetic-ca" not in response.text


def test_post_bad_kubeconfig_is_422(app_with_kubeconfig):
    client, _ = app_with_kubeconfig
    r = client.post("/api/clusters/kubeconfig", json={"kubeconfig": "::: nope"})
    assert r.status_code == 422 and r.json()["detail"].startswith("Not a kubeconfig")


def test_post_kubeconfig_imports_clusters(app_with_kubeconfig):
    from tests.clusters.test_kubeconfig import kc

    client, _ = app_with_kubeconfig
    r = client.post(
        "/api/clusters/kubeconfig",
        json={"kubeconfig": kc([("eks-prod", "https://x.eks.amazonaws.com", None)])},
    )
    assert r.status_code == 200 and r.json()[0]["provider"] == "eks"
    assert [c["name"] for c in client.get("/api/clusters").json()] == [
        "eks-prod",
        "kind-omnikrux-dev",
    ]


def test_unparseable_file_is_skipped_at_startup(tmp_path, caplog):
    from fastapi.testclient import TestClient

    from omnikrux.config import Settings
    from omnikrux.main import create_app

    bad = tmp_path / "config"
    bad.write_text("::: nope", encoding="utf-8")
    with TestClient(create_app(Settings(data_dir=tmp_path, kubeconfig=str(bad)))) as client:
        assert client.get("/api/clusters").json() == []
    assert "Skipping kubeconfig" in caplog.text


class StubHub:
    def __init__(self):
        self.retried: list[str] = []
        self.forgotten: list[str] = []
        self.changed = 0

    def status(self, cluster_id):
        return ("error", "Can't reach this cluster: boom")

    async def retry(self, cluster_id):
        self.retried.append(cluster_id)

    async def forget(self, cluster_id):
        self.forgotten.append(cluster_id)

    async def clusters_changed(self):
        self.changed += 1

    async def close(self):
        pass


def test_cluster_state_comes_from_the_hub(app_with_kubeconfig):
    client, _ = app_with_kubeconfig
    client.app.state.hub = StubHub()
    body = client.get("/api/clusters").json()
    assert (body[0]["state"], body[0]["message"]) == ("error", "Can't reach this cluster: boom")


def test_retry_cluster(app_with_kubeconfig):
    client, _ = app_with_kubeconfig
    client.app.state.hub = hub = StubHub()
    cluster_id = client.get("/api/clusters").json()[0]["id"]
    r = client.post(f"/api/clusters/{cluster_id}/retry")
    assert r.status_code == 204 and r.content == b"" and hub.retried == [cluster_id]
    assert client.post("/api/clusters/nope/retry").status_code == 404 and hub.retried == [
        cluster_id
    ]


def test_loopback_rewrite_follows_the_setting_not_in_container(tmp_path):
    from fastapi.testclient import TestClient

    from omnikrux.config import Settings
    from omnikrux.main import create_app
    from tests.clusters.test_kubeconfig import kc

    path = tmp_path / "config"
    path.write_text(kc([("kind-omnikrux-dev", "https://127.0.0.1:6443", None)]), encoding="utf-8")
    # --network host on Linux: in a container, but 127.0.0.1 already is the host.
    settings = Settings(
        data_dir=tmp_path / "a", kubeconfig=str(path), in_container=True, rewrite_loopback=False
    )
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/clusters").json()[0]["server"] == "https://127.0.0.1:6443"
    settings = Settings(
        data_dir=tmp_path / "b", kubeconfig="", in_container=False, rewrite_loopback=True
    )
    with TestClient(create_app(settings)) as client:
        r = client.post(
            "/api/clusters/kubeconfig", json={"kubeconfig": path.read_text(encoding="utf-8")}
        )
        assert r.json()[0]["server"] == "https://host.docker.internal:6443"


def test_api_reports_the_original_server_only_when_rewritten(tmp_path):
    from fastapi.testclient import TestClient

    from omnikrux.config import Settings
    from omnikrux.main import create_app
    from tests.clusters.test_kubeconfig import kc

    path = tmp_path / "config"
    path.write_text(kc([("kind-omnikrux-dev", "https://127.0.0.1:6443", None)]), encoding="utf-8")
    with TestClient(
        create_app(Settings(data_dir=tmp_path, kubeconfig=str(path), rewrite_loopback=True))
    ) as client:
        [kind] = client.get("/api/clusters").json()
        assert kind["server"] == "https://host.docker.internal:6443"
        assert kind["original_server"] == "https://127.0.0.1:6443"
        [eks] = client.post(
            "/api/clusters/kubeconfig",
            json={"kubeconfig": kc([("eks-prod", "https://x.eks.amazonaws.com", None)])},
        ).json()
        assert eks["original_server"] is None


SECRET = "s3cr3t-token-value"
LEAKY = f"""apiVersion: v1
kind: Config
users:
- name: u
  user:
    token: {SECRET}: oops
"""


def test_invalid_yaml_never_echoes_kubeconfig_contents(app_with_kubeconfig):
    client, _ = app_with_kubeconfig
    r = client.post("/api/clusters/kubeconfig", json={"kubeconfig": LEAKY})
    assert r.status_code == 422
    assert r.json()["detail"] == "Not a kubeconfig: invalid YAML at line 6, column 30"
    assert SECRET not in r.text


def test_invalid_yaml_file_at_startup_logs_no_contents(tmp_path, caplog):
    import logging

    from fastapi.testclient import TestClient

    from omnikrux.config import Settings
    from omnikrux.main import create_app

    bad = tmp_path / "config"
    bad.write_text(LEAKY, encoding="utf-8")
    with (
        caplog.at_level(logging.DEBUG),
        TestClient(create_app(Settings(data_dir=tmp_path, kubeconfig=str(bad)))),
    ):
        pass
    assert SECRET not in caplog.text
    [warning] = [r.getMessage() for r in caplog.records if r.name == "omnikrux.main"]
    assert str(bad) in warning and "ScannerError" in warning and "line 6, column 30" in warning


def test_delete_cluster_204_then_404(app_with_kubeconfig):
    client, _ = app_with_kubeconfig
    cluster_id = client.get("/api/clusters").json()[0]["id"]
    r = client.delete(f"/api/clusters/{cluster_id}")
    assert r.status_code == 204 and r.content == b""
    assert client.get("/api/clusters").json() == []
    r = client.delete(f"/api/clusters/{cluster_id}")
    assert r.status_code == 404 and r.json()["detail"] == "Unknown cluster"


def test_delete_cluster_forgets_it_in_the_hub(app_with_kubeconfig):
    client, _ = app_with_kubeconfig
    client.app.state.hub = hub = StubHub()
    cluster_id = client.get("/api/clusters").json()[0]["id"]
    assert client.delete(f"/api/clusters/{cluster_id}").status_code == 204
    assert hub.forgotten == [cluster_id]
    assert client.delete(f"/api/clusters/{cluster_id}").status_code == 404
    assert hub.forgotten == [cluster_id]


def test_import_tells_the_hub_clusters_changed(app_with_kubeconfig):
    from tests.clusters.test_kubeconfig import kc

    client, _ = app_with_kubeconfig
    client.app.state.hub = hub = StubHub()
    r = client.post(
        "/api/clusters/kubeconfig",
        json={"kubeconfig": kc([("eks-prod", "https://x.eks.amazonaws.com", None)])},
    )
    assert r.status_code == 200 and hub.changed == 1
    assert (
        client.post("/api/clusters/kubeconfig", json={"kubeconfig": "::: nope"}).status_code == 422
    )
    assert hub.changed == 1


def test_uploaded_cluster_survives_restart_without_it_in_files(tmp_path):
    from fastapi.testclient import TestClient

    from omnikrux.config import Settings
    from omnikrux.main import create_app
    from tests.clusters.test_kubeconfig import kc

    path = tmp_path / "config"
    path.write_text(kc([("kind-omnikrux-dev", "https://127.0.0.1:6443", None)]), encoding="utf-8")
    settings = Settings(data_dir=tmp_path, kubeconfig=str(path))
    with TestClient(create_app(settings)) as client:
        r = client.post(
            "/api/clusters/kubeconfig",
            json={"kubeconfig": kc([("eks-prod", "https://x.eks.amazonaws.com", None)])},
        )
        assert r.status_code == 200
    with TestClient(create_app(settings)) as client:
        names = [c["name"] for c in client.get("/api/clusters").json()]
    assert names == ["eks-prod", "kind-omnikrux-dev"]


def test_upload_conflict_is_409_and_keeps_the_original(app_with_kubeconfig):
    from tests.clusters.test_kubeconfig import kc

    client, _ = app_with_kubeconfig
    first = client.post(
        "/api/clusters/kubeconfig", json={"kubeconfig": kc([("lab", "https://lab-a:6443", None)])}
    ).json()
    r = client.post(
        "/api/clusters/kubeconfig",
        json={
            "kubeconfig": kc(
                [("eks-prod", "https://x.eks.amazonaws.com", None), ("lab", "https://lab-b", None)]
            )
        },
    )
    assert r.status_code == 409
    assert r.json()["detail"] == (
        "A cluster called lab was already uploaded for https://lab-a:6443."
        " Delete it first to replace it."
    )
    clusters = {c["name"]: c for c in client.get("/api/clusters").json()}
    assert sorted(clusters) == ["kind-omnikrux-dev", "lab"]
    assert clusters["lab"]["id"] == first[0]["id"]
    assert clusters["lab"]["server"] == "https://lab-a:6443"


def test_upload_on_the_same_server_updates_in_place(app_with_kubeconfig):
    from tests.clusters.test_kubeconfig import kc

    client, _ = app_with_kubeconfig
    body = {"kubeconfig": kc([("lab", "https://lab-a:6443", None)])}
    [first] = client.post("/api/clusters/kubeconfig", json=body).json()
    r = client.post("/api/clusters/kubeconfig", json=body)
    assert r.status_code == 200 and r.json()[0]["id"] == first["id"]
    assert [c["name"] for c in client.get("/api/clusters").json()] == ["kind-omnikrux-dev", "lab"]
