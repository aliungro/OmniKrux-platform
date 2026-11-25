"""Which Prometheus a ready-made view reads when a project links several, and what its notes say
about the exporters none of them (or only a hidden part of one) holds."""

import asyncio
from urllib.parse import quote

from omnikrux.monitoring.dashboards.prometheus_pick import (
    NEED_SELECTOR,
    PromLink,
    pick_prometheus,
)
from omnikrux.monitoring.dashboards.ready_made import NEED_FILTERED, NEED_NOTE
from tests.monitoring.fakes import serve_fake_prometheus

API = "/api/monitoring"
DASHBOARDS = f"{API}/dashboards"
EVERYTHING = ("kube_pod_info", "container_cpu_usage_seconds_total", "node_cpu_seconds_total")
DEAD = "http://127.0.0.1:1"


def series(*names: str, **labels: str) -> list[dict]:
    return [{"__name__": name, **labels} for name in names]


async def add_prometheus(http, url: str, name: str) -> str:
    made = await http.post(
        f"{API}/sources", json={"type": "prometheus", "reach": "url", "url": url, "name": name}
    )
    assert made.status_code == 201, made.text
    return made.json()["id"]


async def project_over(http, cluster: str, links: list[tuple[str, str]], name="Shop") -> str:
    """A Kubernetes project linking each (source id, filter), in this order."""
    made = await http.post(
        f"{API}/setup",
        json={
            "name": name,
            "kind": "kubernetes",
            "cluster_id": cluster,
            "sources": [{"source_id": s, "filter": f} for s, f in links],
        },
    )
    assert made.status_code == 201, made.text
    return made.json()["id"]


async def views_of(http, pid: str) -> dict[str, dict]:
    response = await http.get(f"{API}/projects/{pid}/ready-made")
    assert response.status_code == 200, response.text
    return {view["key"]: view for view in response.json()}


async def spec_of(http, pid: str, key: str) -> dict:
    response = await http.get(f"{DASHBOARDS}/{quote(f'ready:{pid}:{key}', safe='')}")
    assert response.status_code == 200, response.text
    return response.json()["spec"]


def prometheus_ids(doc: dict) -> set:
    ids = {v["source"]["id"] for v in doc["variables"] if v["source"]["type"] == "prometheus"}
    for panel in doc["panels"]:
        for query in panel["queries"]:
            if query["source"]["type"] == "prometheus":
                ids.add(query["source"]["id"])
    return ids


def link(name: str, has=None, hidden=(), message=None) -> PromLink:
    return PromLink(
        name, name, "", None if has is None else frozenset(has), frozenset(hidden), message
    )


def test_the_pick_order():
    full = link("full", {"kube_state", "cadvisor", "node_exporter"})
    cadvisor = link("cadvisor", {"cadvisor"})
    none = link("none", set())
    unread = link("unread", message="Can't reach unread.")
    assert pick_prometheus("cluster", [cadvisor, full]) is full
    assert pick_prometheus("cluster", [unread, full]) is full
    # Nobody has everything: the readable one with the most (ties: link order).
    assert pick_prometheus("cluster", [none, cadvisor]) is cadvisor
    assert pick_prometheus("cluster", [unread, none, link("also none", set())]) is none
    # Nobody readable: the first link.
    assert pick_prometheus("cluster", [unread, link("other", message="x")]) is unread
    assert pick_prometheus("cluster", []) is None


async def test_the_view_reads_the_prometheus_that_has_its_metrics(
    monitoring_app, kube_cluster, fake_prometheus
):
    http, _ = monitoring_app
    async with serve_fake_prometheus() as second:
        for fake in (fake_prometheus, second):
            fake.label_values_from_series = True
        # The first holds only cAdvisor's metrics; the second, kube-state-metrics' too.
        fake_prometheus.series = series("container_cpu_usage_seconds_total")
        second.series = series(*EVERYTHING)
        first_id = await add_prometheus(http, fake_prometheus.url, "Operator Prometheus")
        second_id = await add_prometheus(http, second.url, "Prometheus server")
        pid = await project_over(http, kube_cluster, [(first_id, ""), (second_id, "")])

        for key in ("cluster", "namespaces", "nodes", "pods"):
            assert prometheus_ids(await spec_of(http, pid, key)) == {second_id}, key
        views = await views_of(http, pid)
        for key in ("cluster", "nodes", "namespaces", "workloads", "pods"):
            view = views[key]
            assert view["source_name"] == "Prometheus server", key
            assert view["checked"] and view["missing"] == [] and view["notes"] == [], view

        # Where both hold what a view needs, the first link is read.
        fake_prometheus.series = series(*EVERYTHING)
        assert prometheus_ids(await spec_of(http, pid, "cluster")) == {first_id}
        assert (await views_of(http, pid))["cluster"]["source_name"] == "Operator Prometheus"
        # The names asked for: the three that prove an exporter, ten at most.
        asked = [r for r in second.requests if r.path == "/api/v1/label/__name__/values"]
        assert asked and all(r.params["match[]"] == [NEED_SELECTOR] for r in asked)
        assert all("start" not in r.params and "end" not in r.params for r in asked)


async def test_a_view_with_no_prometheus_holding_its_metrics_says_none_does(
    monitoring_app, kube_cluster, fake_prometheus
):
    http, _ = monitoring_app
    assert NEED_NOTE == {
        "kube_state": "kube-state-metrics isn't reporting to any Prometheus this project uses, "
        "so counts and states stay empty.",
        "cadvisor": "No Prometheus this project uses collects container usage from the kubelet "
        "(cAdvisor), so CPU and memory stay empty.",
        "node_exporter": "node-exporter isn't reporting to any Prometheus this project uses, so "
        "node panels stay empty.",
    }
    async with serve_fake_prometheus() as second:
        for fake in (fake_prometheus, second):
            fake.label_values_from_series = True
        fake_prometheus.series = series("up")
        second.series = series("container_cpu_usage_seconds_total")
        first_id = await add_prometheus(http, fake_prometheus.url, "Operator Prometheus")
        second_id = await add_prometheus(http, second.url, "Prometheus server")
        pid = await project_over(http, kube_cluster, [(first_id, ""), (second_id, "")])

        views = await views_of(http, pid)
        cluster = views["cluster"]
        # It reads the one with the most of what it needs, and says what none has.
        assert cluster["source_name"] == "Prometheus server"
        assert cluster["checked"] is True and cluster["missing"] == ["kube_state"]
        assert cluster["notes"] == [NEED_NOTE["kube_state"]]
        nodes = views["nodes"]
        assert nodes["missing"] == ["node_exporter"]
        assert nodes["notes"] == [NEED_NOTE["node_exporter"]]
        # Nobody has any of it: the first link.
        assert nodes["source_name"] == "Operator Prometheus"
        assert prometheus_ids(await spec_of(http, pid, "nodes")) == {first_id}
        # Without filters, nothing was read twice.
        for fake in (fake_prometheus, second):
            assert len([r for r in fake.requests if "__name__" in r.path]) == 2


async def test_a_filter_that_hides_the_metrics_is_named(
    monitoring_app, kube_cluster, fake_prometheus
):
    http, _ = monitoring_app
    assert NEED_FILTERED == (
        "{exporter} reports to {source}, but this project's filter there ({filter}) hides it, "
        "so {what} stay empty. Check the filter on the project page."
    )
    fake_prometheus.label_values_from_series = True
    # kube-state-metrics' series carry another cluster label than the project's filter.
    fake_prometheus.series = series("kube_pod_info", "node_cpu_seconds_total", cluster="b")
    fake_prometheus.series += series("container_cpu_usage_seconds_total", cluster="a")
    source = await add_prometheus(http, fake_prometheus.url, "Prom")
    pid = await project_over(http, kube_cluster, [(source, 'cluster="a"')])

    views = await views_of(http, pid)
    cluster = views["cluster"]
    assert cluster["checked"] is True and cluster["missing"] == ["kube_state"]
    hidden_kube_state = (
        'kube-state-metrics reports to Prom, but this project\'s filter there (cluster="a") '
        "hides it, so counts and states stay empty. Check the filter on the project page."
    )
    assert cluster["notes"] == [hidden_kube_state]
    hidden_node_exporter = (
        'node-exporter reports to Prom, but this project\'s filter there (cluster="a") hides '
        "it, so node panels stay empty. Check the filter on the project page."
    )
    assert views["nodes"]["notes"] == [hidden_node_exporter]
    # cAdvisor's series are the ones the filter hides now.
    fake_prometheus.series = series("kube_pod_info", "node_cpu_seconds_total", cluster="a")
    fake_prometheus.series += series("container_cpu_usage_seconds_total", cluster="b")
    pods = (await views_of(http, pid))["pods"]
    hidden_cadvisor = (
        "Container usage from the kubelet (cAdvisor) reports to Prom, but this project's filter "
        'there (cluster="a") hides it, so CPU and memory stay empty. Check the filter on the '
        "project page."
    )
    assert pods["notes"] == [hidden_cadvisor]
    # No cAdvisor series at all: the plain words.
    fake_prometheus.series = series("kube_pod_info", "node_cpu_seconds_total", cluster="a")
    assert (await views_of(http, pid))["pods"]["notes"] == [NEED_NOTE["cadvisor"]]

    # The first read is the project's (filtered); the second, only when one is missing, isn't.
    asked = [
        r.params["match[]"]
        for r in fake_prometheus.requests
        if r.path == "/api/v1/label/__name__/values"
    ]
    filtered = [NEED_SELECTOR[:-1] + ',cluster="a"}']
    assert asked[:2] == [filtered, [NEED_SELECTOR]]
    assert set(map(tuple, asked)) == {tuple(filtered), (NEED_SELECTOR,)}


async def test_an_unreadable_prometheus_is_not_called_missing(
    monitoring_app, kube_cluster, fake_prometheus
):
    http, _ = monitoring_app
    fake_prometheus.label_values_from_series = True
    fake_prometheus.series = series("container_cpu_usage_seconds_total")
    dead = await add_prometheus(http, DEAD, "Gone")
    alive = await add_prometheus(http, fake_prometheus.url, "Prom")
    pid = await project_over(http, kube_cluster, [(dead, ""), (alive, "")])

    views = await views_of(http, pid)
    # kube-state-metrics might report to the one that can't be read: nothing is called missing.
    cluster = views["cluster"]
    assert cluster["checked"] is False and cluster["missing"] == [] and cluster["notes"] == []
    assert cluster["check_message"].startswith("Can't reach Gone")
    assert cluster["source_name"] == "Prom"

    # The one that can be read has everything: it is read, and nothing is said.
    fake_prometheus.series = series(*EVERYTHING)
    views = await views_of(http, pid)
    for view in views.values():
        assert view["checked"] and view["notes"] == [] and view["source_name"] == "Prom", view
    assert prometheus_ids(await spec_of(http, pid, "cluster")) == {alive}

    # Only the dead one: it is read, unchecked, with its reason.
    only_dead = await project_over(http, kube_cluster, [(dead, "")], name="Dead")
    for view in (await views_of(http, only_dead)).values():
        assert view["checked"] is False and view["notes"] == [] and view["missing"] == []
        assert view["source_name"] == "Gone" and view["check_message"].startswith("Can't reach")
    assert prometheus_ids(await spec_of(http, only_dead, "cluster")) == {dead}


async def test_links_are_read_at_once(monitoring_app, kube_cluster, fake_prometheus):
    http, app = monitoring_app
    async with serve_fake_prometheus() as second:
        first_id = await add_prometheus(http, fake_prometheus.url, "One")
        second_id = await add_prometheus(http, second.url, "Two")
        pid = await project_over(http, kube_cluster, [(first_id, ""), (second_id, "")])
        connector = app.state.monitoring.connectors.get("prometheus")
        started: list[str] = []
        both = asyncio.Event()

        async def slow(t, label, *, matchers, limit=1000, selector=None, start=None, end=None):
            started.append(selector)
            if len(started) == 2:
                both.set()
            # Read one after the other, the first would wait here alone and time out.
            await asyncio.wait_for(both.wait(), 5)
            return list(EVERYTHING)

        connector.label_values = slow
        views = await views_of(http, pid)
        assert len(started) == 2 and all(v["checked"] for v in views.values())
