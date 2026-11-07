from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from omnikrux.config import Settings
from omnikrux.main import create_app
from omnikrux.web_security import is_cross_origin


def ws(**headers):
    return SimpleNamespace(headers=headers)


@pytest.mark.parametrize(
    ("headers", "expected"),
    [
        ({"host": "localhost:8080"}, False),  # no Origin: not a browser
        ({"host": "localhost:8080", "origin": "http://localhost:8080"}, False),
        ({"host": "LOCALHOST:8080", "origin": "http://localhost:8080"}, False),
        ({"host": "localhost:8080", "origin": "http://evil.example"}, True),
        ({"host": "localhost:8080", "origin": "http://localhost:9090"}, True),
        ({"origin": "http://localhost:8080"}, True),  # an Origin but no Host: refuse
    ],
)
def test_is_cross_origin(headers, expected):
    assert is_cross_origin(ws(**headers)) is expected


EVIL = {"origin": "http://evil.example"}


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(data_dir=tmp_path, kubeconfig="", in_container=False))
    with TestClient(app) as client:
        yield client


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/api/clusters/kubeconfig"),
        ("DELETE", "/api/clusters/some-id"),
        ("POST", "/api/clusters/some-id/retry"),
        ("PUT", "/api/clusters/some-id"),
        ("PATCH", "/api/clusters/some-id"),
    ],
)
def test_cross_origin_writes_refused(client, method, path):
    r = client.request(method, path, headers=EVIL, json={"kubeconfig": "x"})
    assert r.status_code == 403
    assert r.json() == {"detail": "Cross-origin request refused"}


def test_cross_origin_upload_changes_nothing(client):
    kubeconfig = "apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\n"
    r = client.post("/api/clusters/kubeconfig", headers=EVIL, json={"kubeconfig": kubeconfig})
    assert r.status_code == 403
    assert client.get("/api/clusters").json() == []


def test_same_origin_and_no_origin_writes_proceed(client):
    r = client.delete("/api/clusters/some-id", headers={"origin": "http://testserver"})
    assert r.status_code == 404 and r.json() == {"detail": "Unknown cluster"}
    r = client.delete("/api/clusters/some-id")
    assert r.status_code == 404 and r.json() == {"detail": "Unknown cluster"}


def test_cross_origin_reads_unaffected(client):
    r = client.get("/api/clusters", headers=EVIL)
    assert r.status_code == 200
    r = client.get("/api/health", headers=EVIL)
    assert r.status_code == 200
