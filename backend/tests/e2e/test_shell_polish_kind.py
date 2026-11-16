"""Container health, node sizes and event times through the real app on omnikrux-dev."""

from datetime import datetime

import pytest

from tests.e2e.support import Reader, kubectl, wait_for

pytestmark = pytest.mark.kind


def snapshot_rows(client, kind: str) -> list[dict]:
    with client.websocket_connect(f"/api/watch?kind={kind}") as ws:
        messages = Reader(ws).until(
            lambda m: m["type"] == "closed" or (m["type"] == "snapshot" and m["last"]),
            f"the {kind} snapshot",
        )
    assert messages[-1]["type"] == "snapshot", messages[-3:]
    return [row for m in messages if m["type"] == "snapshot" for row in m["rows"]]


def pod_row(client, name: str) -> dict | None:
    return next(
        (
            r
            for r in snapshot_rows(client, "pods")
            if r["namespace"] == "demo" and r["name"] == name
        ),
        None,
    )


def test_two_containers_are_ready_and_finished_init_is_left_out(client, cluster):
    def ready():
        row = pod_row(client, "two-containers")
        return row if row and row["columns"]["ready"] == "2/2" else None

    row = wait_for(ready, "demo/two-containers to have two ready containers", timeout=120)
    containers = row["columns"]["containers"]
    assert [c["name"] for c in containers] == ["web", "helper"]
    assert all(c["state"] == "ready" and c["init"] is False for c in containers), containers


def test_crasher_container_is_failing(client, cluster):
    def failing():
        row = pod_row(client, "crasher")
        if row:
            containers = row["columns"]["containers"]
            if (
                len(containers) == 1
                and containers[0]["state"] == "failing"
                and containers[0]["restarts"] >= 1
            ):
                return containers[0]
        return None

    container = wait_for(failing, "crasher to fail after restarting", timeout=120)
    assert container["name"] == "crasher"
    assert container["reason"] in {"CrashLoopBackOff", "Error"}, container
    assert container["restarts"] >= 1


def test_pod_metrics_carry_both_node_sizes(client, cluster):
    nodes = set(kubectl("get", "nodes", "-o", "jsonpath={.items[*].metadata.name}").split())
    assert len(nodes) == 2, nodes

    def live():
        response = client.get("/api/metrics/pods")
        assert response.status_code == 200, response.text
        answer = response.json()["clusters"][cluster]
        if (
            answer["state"] == "ok"
            and set(answer["nodes"]) == nodes
            and "demo/two-containers" in answer["items"]
        ):
            return answer
        return None

    answer = wait_for(live, "pod metrics with both node sizes and two-containers", timeout=120)
    for size in answer["nodes"].values():
        assert size["cpu_m"] > 0 and size["memory_b"] > 0, answer


def test_event_rows_have_last_seen(client, cluster):
    rows = snapshot_rows(client, "events")
    assert any(row["namespace"] == "demo" for row in rows), rows
    for row in rows:
        seen = datetime.fromisoformat(row["columns"]["last_seen"])
        assert seen.tzinfo is not None, row


def test_demo_secret_has_two_revealable_keys(client, cluster):
    row = next(
        r
        for r in snapshot_rows(client, "secrets")
        if r["namespace"] == "demo" and r["name"] == "db-credentials"
    )
    assert row["columns"]["keys"] >= 2
    for key in ("password", "username"):
        response = client.post(
            f"/api/clusters/{cluster}/secrets/demo/db-credentials/reveal", json={"key": key}
        )
        assert response.status_code == 200
        assert response.json()["key"] == key
        assert response.headers["cache-control"] == "no-store"
