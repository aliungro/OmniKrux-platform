from fastapi.testclient import TestClient

from omnikrux.main import create_app


def test_health_ok(tmp_settings):
    client = TestClient(create_app(tmp_settings))
    assert client.get("/api/health").json() == {"status": "ok"}


def test_unknown_host_header_is_rejected(tmp_settings):
    client = TestClient(create_app(tmp_settings))
    assert client.get("/api/health", headers={"host": "evil.example"}).status_code == 400
    assert client.get("/api/health", headers={"host": "rebind.attacker.example:8080"}).status_code == 400


def test_loopback_hosts_are_allowed_by_default(tmp_path, monkeypatch):
    from omnikrux.config import Settings

    monkeypatch.delenv("OMNIKRUX_ALLOWED_HOSTS")
    client = TestClient(create_app(Settings(data_dir=tmp_path, kubeconfig="")))
    for host in ("localhost:8090", "127.0.0.1:8080", "[::1]:8080", "omnikrux.localhost"):
        assert client.get("/api/health", headers={"host": host}).status_code == 200, host
    assert client.get("/api/health").status_code == 400  # "testserver" is not on the default list


def test_star_allows_any_host(tmp_settings):
    client = TestClient(create_app(tmp_settings.model_copy(update={"allowed_hosts": ["*"]})))
    assert client.get("/api/health", headers={"host": "anything.example"}).status_code == 200
