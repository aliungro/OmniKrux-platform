"""Monitoring against the Prometheus and Loki installed in kind's `monitoring` namespace."""

import time
from contextlib import contextmanager

import pytest

pytestmark = pytest.mark.kind

API = "/api/monitoring"
NOT_INSTALLED = (
    "Prometheus and Loki aren't installed in the monitoring namespace "
    "(see docs/guide/developer/monitoring.md)."
)
LIVE_CHECK_LINES = 3


def reachable(found: list[dict], type: str, service: str) -> dict | None:
    for tool in found:
        if (
            tool["type"] == type
            and tool["state"] == "reachable"
            and tool["namespace"] == "monitoring"
            and tool["service"] == service
        ):
            return tool
    return None


@pytest.fixture
def tools(client, cluster) -> dict[str, dict]:
    """The found Prometheus and Loki, or a skip when the cluster doesn't have them."""
    response = client.get(f"{API}/discovery/{cluster}")
    assert response.status_code == 200, response.text
    found = response.json()["found"]
    prometheus = reachable(found, "prometheus", "prometheus-server")
    loki = reachable(found, "loki", "loki")
    if prometheus is None or loki is None:
        pytest.skip(NOT_INSTALLED)
    return {"prometheus": prometheus, "loki": loki}


def new_source(cluster: str, tool: dict) -> dict:
    return {
        "type": tool["type"],
        "reach": "cluster",
        "cluster_id": cluster,
        "namespace": tool["namespace"],
        "service": tool["service"],
        "port": tool["port"],
        "scheme": tool["scheme"],
    }


def delete_project(client, project_id: str) -> None:
    """Delete through the API, with its review; the sources only it created go with it."""
    review = client.get(f"{API}/projects/{project_id}/delete-review")
    assert review.status_code == 200, review.text
    response = client.delete(
        f"{API}/projects/{project_id}", params={"token": review.json()["token"]}
    )
    assert response.status_code == 204, response.text


@contextmanager
def project_cleanup(client):
    """Collects the ids of projects a test makes and deletes them (newest first) afterwards."""
    made: list[str] = []
    try:
        yield made
    finally:
        for project_id in reversed(made):
            delete_project(client, project_id)


def set_up(client, cluster: str, name: str, sources: list[dict]) -> dict:
    response = client.post(
        f"{API}/setup",
        json={"name": name, "kind": "kubernetes", "cluster_id": cluster, "sources": sources},
    )
    assert response.status_code == 201, response.text
    return response.json()


def link_of(project: dict, type: str) -> dict:
    return next(link for link in project["links"] if link["source_type"] == type)


def query(client, project: dict, type: str, **body) -> dict:
    response = client.post(
        f"{API}/query",
        json={"source_id": link_of(project, type)["source_id"], "project_id": project["id"]} | body,
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_discovery_finds_the_installed_tools(client, cluster):
    response = client.get(f"{API}/discovery/{cluster}")
    assert response.status_code == 200, response.text
    found = response.json()["found"]
    prometheus = reachable(found, "prometheus", "prometheus-server")
    loki = reachable(found, "loki", "loki")
    if prometheus is None or loki is None:
        pytest.skip(NOT_INSTALLED)
    assert prometheus["version"]
    assert loki["namespace"] == "monitoring"


def test_setup_and_query_through_the_cluster(client, cluster, tools):
    sources = [{"source": new_source(cluster, tools[t]), "filter": ""} for t in tools]
    with project_cleanup(client) as made:
        project = set_up(client, cluster, "Kind live check", sources)
        made.append(project["id"])

        instant = query(client, project, "prometheus", kind="instant", query="up")
        assert len(instant["series"]) >= 1

        now = time.time()
        ranged = query(
            client,
            project,
            "prometheus",
            kind="range",
            query="rate(prometheus_http_requests_total[5m])",
            start=now - 15 * 60,
            end=now,
            step=30,
        )
        assert ranged["series"]
        assert all(series["points"] for series in ranged["series"])

        logs = query(
            client, project, "loki", kind="range", query='{job="omnikrux-live-check"}',
            start=now - 7 * 86400, end=now, step=60, limit=10,
        )  # fmt: skip
        lines = [line for stream in logs["streams"] for _, line in stream["entries"]]
        assert len(lines) == LIVE_CHECK_LINES


def test_a_filtered_project_sees_only_its_part(client, cluster, tools):
    prometheus = new_source(cluster, tools["prometheus"])
    with project_cleanup(client) as made:
        wide = set_up(client, cluster, "Kind wide", [{"source": prometheus, "filter": ""}])
        made.append(wide["id"])
        source_id = wide["links"][0]["source_id"]
        narrow = set_up(
            client,
            cluster,
            "Kind narrow",
            [{"source_id": source_id, "filter": 'job="prometheus"'}],
        )
        made.append(narrow["id"])

        only = query(client, narrow, "prometheus", kind="instant", query="up")
        assert only["series"]
        assert all(s["labels"]["job"] == "prometheus" for s in only["series"])
        assert only["applied_filter"] == 'job="prometheus"'

        everything = query(client, wide, "prometheus", kind="instant", query="up")
        assert any(s["labels"]["job"] != "prometheus" for s in everything["series"])
