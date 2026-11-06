from fastapi.testclient import TestClient

from omnikrux.main import create_app


def test_health_ok(tmp_settings):
    client = TestClient(create_app(tmp_settings))
    assert client.get("/api/health").json() == {"status": "ok"}
