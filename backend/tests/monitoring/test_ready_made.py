"""Ready-made views: valid generated documents that take a project's filter, which views a
project gets, what each is missing, and how they open, copy and sit in the tree."""

import re
from urllib.parse import quote

import pytest

from omnikrux.monitoring.dashboards.ready_made import (
    NEED_METRIC,
    NEED_NOTE,
    NEEDS,
    READY_ORDER,
    build_ready_made,
    parse_ready_id,
    ready_id,
    ready_keys,
)
from omnikrux.monitoring.dashboards.schema import validate_dashboard
from omnikrux.monitoring.projects.types import Matcher
from omnikrux.monitoring.query.filters import inject_logql, inject_promql
from omnikrux.monitoring.sources.connector import FieldCatalog

API = "/api/monitoring"
DASHBOARDS = f"{API}/dashboards"
FILTER = (Matcher("cluster", "=", "a"),)
READ_ONLY = "Ready-made views can't be changed. Copy one to edit it."
CANT_READ_ALL = "OmniKrux couldn't read every metric name, so it can't tell what's missing."


def kinds_for(key):
    if key == "nodes":
        return [("kubernetes", True), ("kubernetes", False), ("servers", False)]
    return [("kubernetes", True), ("kubernetes", False)]


@pytest.mark.parametrize("key", READY_ORDER)
def test_every_ready_made_view_is_a_valid_document(key):
    for kind, loki in kinds_for(key):
        doc = build_ready_made(key, kind=kind, has_loki=loki)
        assert validate_dashboard(doc, owner_kind="project") == doc
        assert all(s["id"] is None for s in sources_of(doc))
        assert [p["id"] for p in doc["panels"]] == [f"p-{i + 1}" for i in range(len(doc["panels"]))]


def sources_of(doc):
    for variable in doc["variables"]:
        yield variable["source"]
    for panel in doc["panels"]:
        for query in panel["queries"]:
            yield query["source"]


@pytest.mark.parametrize("key", READY_ORDER)
def test_every_ready_made_query_takes_a_filter(key):
    for kind, loki in kinds_for(key):
        doc = build_ready_made(key, kind=kind, has_loki=loki)
        for panel in doc["panels"]:
            for query in panel["queries"]:
                expr = re.sub(r"\$(?!__)\w+", ".+", query["expr"]).replace("$__rate_interval", "2m")
                inject = inject_logql if query["source"]["type"] == "loki" else inject_promql
                filtered = inject(expr, FILTER)
                bodies = re.findall(r"\{([^}]*)\}", filtered)
                assert bodies, filtered
                assert all('cluster="a"' in body for body in bodies), filtered


def test_ready_keys():
    assert ready_keys("kubernetes", True, False) == READY_ORDER
    assert ready_keys("kubernetes", True, True) == READY_ORDER
    for kind in ("docker", "servers", "custom"):
        assert ready_keys(kind, True, True) == ("nodes",)
    for kind in ("kubernetes", "docker", "servers", "custom"):
        assert ready_keys(kind, False, True) == ()
    assert READY_ORDER == ("cluster", "nodes", "namespaces", "workloads", "pods")


def test_ready_ids_round_trip():
    assert ready_id("p1", "pods") == "ready:p1:pods"
    assert parse_ready_id("ready:p1:pods") == ("p1", "pods")
    for other in ("p1", "ready:p1", "ready:p1:nope", "ready::pods", "x:p1:pods", "ready:a:b:pods"):
        assert parse_ready_id(other) is None


def test_pod_health_has_logs_only_with_loki():
    with_logs = build_ready_made("pods", kind="kubernetes", has_loki=True)
    without = build_ready_made("pods", kind="kubernetes", has_loki=False)
    assert [p["type"] for p in with_logs["panels"]].count("logs") == 1
    assert with_logs["panels"][-1]["options"]["limit"] == 200
    assert with_logs["panels"][-1]["queries"][0]["expr"] == '{namespace=~"$namespace", pod=~"$pod"}'
    assert "logs" not in [p["type"] for p in without["panels"]]
    assert len(with_logs["panels"]) == len(without["panels"]) + 1


def test_node_health_outside_kubernetes_has_no_conditions_table():
    kube = build_ready_made("nodes", kind="kubernetes", has_loki=False)
    servers = build_ready_made("nodes", kind="servers", has_loki=False)
    assert [p["title"] for p in kube["panels"]][-1] == "Node conditions"
    assert "Node conditions" not in [p["title"] for p in servers["panels"]]
    assert len(kube["panels"]) == len(servers["panels"]) + 1
    assert kube["title"] == "Node health" and kube["variables"][0]["name"] == "instance"


def test_needs_and_notes():
    assert NEEDS["nodes"] == ("node_exporter",)
    assert NEED_METRIC["cadvisor"] == "container_cpu_usage_seconds_total"
    assert NEED_NOTE["kube_state"].startswith("kube-state-metrics isn't reporting")


async def kube_project(http, cluster_id, fake_prometheus, name="Cluster apps"):
    source = await http.post(
        f"{API}/sources",
        json={"type": "prometheus", "reach": "url", "url": fake_prometheus.url, "name": name},
    )
    assert source.status_code == 201, source.text
    sources = [{"source_id": source.json()["id"], "filter": 'cluster="a"'}]
    project = await http.post(
        f"{API}/setup",
        json={"name": name, "kind": "kubernetes", "cluster_id": cluster_id, "sources": sources},
    )
    assert project.status_code == 201, project.text
    return project.json()


async def test_a_custom_project_gets_only_node_health(monitoring_app, linked_project):
    http, _ = monitoring_app
    pid = linked_project.project_id
    views = (await http.get(f"{API}/projects/{pid}/ready-made")).json()
    assert [v["key"] for v in views] == ["nodes"]
    assert views[0]["id"] == f"ready:{pid}:nodes" and views[0]["title"] == "Node health"
    missing = await http.get(f"{DASHBOARDS}/{quote(f'ready:{pid}:cluster', safe='')}")
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "not_found"


async def test_ready_made_lists_what_is_missing(monitoring_app, kube_cluster, fake_prometheus):
    http, _ = monitoring_app
    project = await kube_project(http, kube_cluster, fake_prometheus)
    pid = project["id"]
    fake_prometheus.label_values["__name__"] = ["kube_pod_info", "up"]
    response = await http.get(f"{API}/projects/{pid}/ready-made")
    assert response.status_code == 200, response.text
    views = response.json()
    assert [v["key"] for v in views] == list(READY_ORDER)
    pods = next(v for v in views if v["key"] == "pods")
    assert pods["missing"] == ["cadvisor"]
    assert pods["notes"] == [
        "Container usage from the kubelet (cAdvisor) isn't collected, so CPU and memory stay empty."
    ]
    assert pods["id"] == f"ready:{pid}:pods" and pods["checked"] is True
    assert pods["check_message"] is None
    assert pods["title"] == "Pod health"
    assert pods["description"] == "Readiness, restarts, waiting reasons and resource use per Pod."
    nodes = next(v for v in views if v["key"] == "nodes")
    assert nodes["missing"] == ["node_exporter"] and nodes["notes"] == [NEED_NOTE["node_exporter"]]
    # Every metric needed is reported: nothing is missing.
    fake_prometheus.label_values["__name__"] = list(NEED_METRIC.values())
    views = (await http.get(f"{API}/projects/{pid}/ready-made")).json()
    assert all(v["missing"] == [] and v["notes"] == [] and v["checked"] for v in views)


async def test_ready_made_with_an_unreachable_source_says_so(monitoring_app, kube_cluster):
    http, _ = monitoring_app

    class Dead:
        url = "http://127.0.0.1:1"

    project = await kube_project(http, kube_cluster, Dead())
    views = (await http.get(f"{API}/projects/{project['id']}/ready-made")).json()
    assert len(views) == 5
    for view in views:
        assert view["checked"] is False and view["missing"] == [] and view["notes"] == []
        assert view["check_message"].startswith("Can't reach")


async def test_ready_made_never_invents_notes_from_a_cut_catalog(
    monitoring_app, kube_cluster, fake_prometheus
):
    http, app = monitoring_app
    project = await kube_project(http, kube_cluster, fake_prometheus)
    connector = app.state.monitoring.connectors.get("prometheus")
    asked = []

    async def cut(t, *, matchers, limit=2000):
        asked.append(limit)
        return FieldCatalog((), (), True)

    connector.describe_fields = cut
    views = (await http.get(f"{API}/projects/{project['id']}/ready-made")).json()
    assert asked == [100_000]
    for view in views:
        assert view["checked"] is False and view["missing"] == [] and view["notes"] == []
        assert view["check_message"] == CANT_READ_ALL


async def test_ready_made_without_prometheus_is_empty(monitoring_app, kube_cluster):
    http, _ = monitoring_app
    made = await http.post(
        f"{API}/setup",
        json={"name": "Bare", "kind": "kubernetes", "cluster_id": kube_cluster, "sources": []},
    )
    assert made.status_code == 201, made.text
    assert (await http.get(f"{API}/projects/{made.json()['id']}/ready-made")).json() == []
    assert (await http.get(f"{API}/projects/nope/ready-made")).status_code == 404


async def test_ready_made_opens_and_copies(monitoring_app, kube_cluster, fake_prometheus):
    http, _ = monitoring_app
    project = await kube_project(http, kube_cluster, fake_prometheus)
    pid = project["id"]
    url = f"{DASHBOARDS}/{quote(f'ready:{pid}:cluster', safe='')}"

    opened = await http.get(url)
    assert opened.status_code == 200, opened.text
    body = opened.json()
    assert body["ready_made"] is True and body["version"] == 0
    assert body["created_at"] is None and body["updated_at"] is None
    assert body["id"] == f"ready:{pid}:cluster" and body["title"] == "Cluster health"
    assert body["owner_kind"] == "project" and body["owner_id"] == pid
    assert body["owner_name"] == "Cluster apps"
    assert body["spec"] == build_ready_made("cluster", kind="kubernetes", has_loki=False)

    save = await http.put(url, json={"base_version": 0, "spec": body["spec"]})
    assert save.status_code == 409
    assert save.json()["detail"] == {"code": "read_only", "message": READ_ONLY}
    gone = await http.delete(f"{url}?version=0")
    assert gone.status_code == 409 and gone.json()["detail"]["code"] == "read_only"
    restore = await http.post(f"{url}/versions/1/restore", json={"base_version": 0})
    assert restore.status_code == 409 and restore.json()["detail"]["code"] == "read_only"

    titles = []
    for _ in range(2):
        copied = await http.post(
            f"{DASHBOARDS}/copy",
            json={"from_id": f"ready:{pid}:cluster", "owner_kind": "project", "owner_id": pid},
        )
        assert copied.status_code == 201, copied.text
        assert copied.json()["ready_made"] is False
        titles.append(copied.json()["title"])
    assert titles == ["Cluster health", "Cluster health (2)"]
    versions = (await http.get(f"{DASHBOARDS}/{copied.json()['id']}/versions")).json()
    assert versions[0]["origin"] == "copied" and versions[0]["copied_from"] == "Cluster health"

    absent = await http.post(
        f"{DASHBOARDS}/copy",
        json={"from_id": f"ready:{pid}:nope", "owner_kind": "project", "owner_id": pid},
    )
    assert absent.status_code == 404 and absent.json()["detail"]["code"] == "not_found"


async def test_a_ready_made_copy_goes_to_another_owner(
    monitoring_app, kube_cluster, fake_prometheus, linked_project
):
    http, _ = monitoring_app
    project = await kube_project(http, kube_cluster, fake_prometheus)
    group = await http.post(f"{API}/groups", json={"name": "Ops", "project_ids": [project["id"]]})
    copied = await http.post(
        f"{DASHBOARDS}/copy",
        json={
            "from_id": f"ready:{project['id']}:pods",
            "owner_kind": "group",
            "owner_id": group.json()["id"],
        },
    )
    assert copied.status_code == 201, copied.text
    assert copied.json()["title"] == "Pod health" and copied.json()["owner_kind"] == "group"


async def test_tree_appends_ready_made_after_saved(monitoring_app, kube_cluster, fake_prometheus):
    http, _ = monitoring_app
    project = await kube_project(http, kube_cluster, fake_prometheus)
    pid = project["id"]
    saved = await http.post(
        DASHBOARDS,
        json={
            "owner_kind": "project",
            "owner_id": pid,
            "spec": {"schemaVersion": 1, "title": "Zebra"},
        },
    )
    assert saved.status_code == 201, saved.text
    [tree_project] = (await http.get(f"{API}/tree")).json()["projects"]
    got = tree_project["dashboards"]
    assert got[0] == {"id": saved.json()["id"], "title": "Zebra", "ready_made": False}
    assert got[1:] == [
        {"id": f"ready:{pid}:{key}", "title": title, "ready_made": True}
        for key, title in (
            ("cluster", "Cluster health"),
            ("nodes", "Node health"),
            ("namespaces", "Namespace health"),
            ("workloads", "Workload health"),
            ("pods", "Pod health"),
        )
    ]
