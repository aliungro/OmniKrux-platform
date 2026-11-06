def test_auto_import_on_startup_and_no_secrets_in_response(app_with_kubeconfig):
    client, _ = app_with_kubeconfig
    body = client.get("/api/clusters").json()
    assert body[0]["provider"] == "kind" and body[0]["environment"] == "development"
    assert body[0]["state"] == "unknown" and body[0]["message"] is None
    assert "token" not in client.get("/api/clusters").text


def test_post_bad_kubeconfig_is_422(app_with_kubeconfig):
    client, _ = app_with_kubeconfig
    r = client.post("/api/clusters/kubeconfig", json={"kubeconfig": "::: nope"})
    assert r.status_code == 422 and r.json()["detail"].startswith("Not a kubeconfig")


def test_post_kubeconfig_imports_clusters(app_with_kubeconfig):
    from tests.clusters.test_kubeconfig import kc

    client, _ = app_with_kubeconfig
    r = client.post("/api/clusters/kubeconfig", json={"kubeconfig": kc([("eks-prod", "https://x.eks.amazonaws.com", None)])})
    assert r.status_code == 200 and r.json()[0]["provider"] == "eks"
    assert [c["name"] for c in client.get("/api/clusters").json()] == ["eks-prod", "kind-omnikrux-dev"]


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

    def status(self, cluster_id):
        return ("error", "Can't reach this cluster: boom")

    async def retry(self, cluster_id):
        self.retried.append(cluster_id)

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
    assert client.post("/api/clusters/nope/retry").status_code == 404 and hub.retried == [cluster_id]
