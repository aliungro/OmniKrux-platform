"""Discovery: Prometheus, Loki and Grafana found in a known cluster by their Services, each
probed through the cluster's service proxy; and the cluster probe the alerting check uses."""

import socket

import pytest

from omnikrux.monitoring.sources import messages
from omnikrux.monitoring.sources.connector import NO_OPERATOR
from omnikrux.monitoring.sources.discovery import (
    CLUSTER_GONE,
    KubeClusterProbe,
    candidates,
    pick_port,
)
from tests.fakekube import FakeResource, service

BASE = "/api/monitoring/discovery"
PROM_SELECTOR = {"app.kubernetes.io/name": "prometheus", "prometheus": "kps"}


def tcp(name: str, port: int) -> dict:
    return {"name": name, "port": port, "protocol": "TCP", "targetPort": port}


def seed(fake_api, *services: dict) -> None:
    for svc in services:
        meta = svc["metadata"]
        fake_api.objects["services"][(meta["namespace"], meta["name"])] = svc


def prometheus_server() -> dict:
    return service(
        "monitoring",
        "prometheus-server",
        labels={"app.kubernetes.io/name": "prometheus", "app.kubernetes.io/component": "server"},
        ports=[tcp("http", 80)],
        selector={"app.kubernetes.io/name": "prometheus", "app.kubernetes.io/component": "server"},
    )


def by_type(found: list[dict]) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for tool in found:
        out.setdefault(tool["type"], []).append(tool)
    return out


async def cluster_name(app, cluster_id: str) -> str:
    return (await app.state.registry.get(cluster_id)).name


async def test_discovery_finds_and_probes(
    monitoring_app, fake_api, kube_cluster, fake_prometheus, fake_loki, fake_grafana
):
    http, app = monitoring_app
    seed(
        fake_api,
        prometheus_server(),
        service(
            "monitoring",
            "prometheus-node-exporter",
            labels={
                "app.kubernetes.io/name": "prometheus",
                "app.kubernetes.io/component": "node-exporter",
            },
            ports=[tcp("metrics", 9100)],
            selector={"app.kubernetes.io/component": "node-exporter"},
        ),
        service(
            "monitoring",
            "loki",
            labels={
                "app.kubernetes.io/name": "loki",
                "app.kubernetes.io/component": "single-binary",
            },
            ports=[tcp("grpc", 9095), tcp("http-metrics", 3100)],
            selector={"app.kubernetes.io/name": "loki"},
        ),
        service(
            "monitoring",
            "grafana",
            labels={"app.kubernetes.io/name": "grafana"},
            ports=[tcp("service", 80)],
            selector={"app.kubernetes.io/name": "grafana"},
        ),
    )
    fake_api.service_backends[("monitoring", "prometheus-server:80")] = fake_prometheus.url
    fake_api.service_backends[("monitoring", "loki:3100")] = fake_loki.url
    fake_api.service_backends[("monitoring", "grafana:80")] = fake_grafana.url

    response = await http.get(f"{BASE}/{kube_cluster}")

    assert response.status_code == 200
    body = response.json()
    assert body["cluster_id"] == kube_cluster
    assert body["cluster_name"] == await cluster_name(app, kube_cluster)
    assert body["state"] == "ok" and body["message"] is None
    assert body["checked_at"]
    assert len(body["found"]) == 3
    found = by_type(body["found"])
    [prometheus], [loki], [grafana] = found["prometheus"], found["loki"], found["grafana"]
    assert prometheus == {
        "type": "prometheus",
        "state": "reachable",
        "namespace": "monitoring",
        "service": "prometheus-server",
        "port": "80",
        "scheme": "http",
        "version": "3.1.0",
        "message": None,
        "existing_source_id": None,
        "detail": None,
    }
    assert (loki["state"], loki["service"], loki["port"], loki["version"]) == (
        "reachable",
        "loki",
        "3100",
        "3.3.0",
    )
    assert (grafana["state"], grafana["service"], grafana["version"]) == (
        "reachable",
        "grafana",
        "11.3.0",
    )
    assert [r.path for r in fake_grafana.requests] == ["/api/health"]
    assert not any("node-exporter" in path for path in fake_api.paths)


async def test_missing_tool_and_unreachable_tool(monitoring_app, fake_api, kube_cluster):
    http, app = monitoring_app
    seed(fake_api, prometheus_server())  # no backend: the service has no running Pods

    body = (await http.get(f"{BASE}/{kube_cluster}")).json()

    assert body["state"] == "ok"
    found = by_type(body["found"])
    assert set(found) == {"prometheus", "loki"}  # Grafana has no "missing" entry
    [prometheus], [loki] = found["prometheus"], found["loki"]
    assert prometheus["state"] == "unreachable"
    assert prometheus["message"] == messages.NO_ENDPOINTS.format(
        name="prometheus-server", cluster=await cluster_name(app, kube_cluster)
    )
    assert prometheus["version"] is None
    assert loki == {
        "type": "loki",
        "state": "missing",
        "namespace": None,
        "service": None,
        "port": None,
        "scheme": "http",
        "version": None,
        "message": None,
        "existing_source_id": None,
        "detail": None,
    }


async def test_operated_and_main_service_are_one(
    monitoring_app, fake_api, kube_cluster, fake_prometheus
):
    http, _ = monitoring_app
    seed(
        fake_api,
        service(
            "monitoring",
            "prometheus-operated",
            labels={"operated-prometheus": "true"},
            ports=[tcp("web", 9090)],
            cluster_ip="None",
            selector=PROM_SELECTOR,
        ),
        service(
            "monitoring",
            "kps-kube-prometheus-stack-prometheus",
            labels={"app": "kube-prometheus-stack-prometheus"},
            ports=[tcp("http-web", 9090), tcp("reloader-web", 8080)],
            selector=PROM_SELECTOR,
        ),
        service(
            "monitoring",
            "kps-kube-prometheus-stack-alertmanager",
            labels={"app": "kube-prometheus-stack-alertmanager"},
            ports=[tcp("http-web", 9093)],
            selector={"app.kubernetes.io/name": "alertmanager"},
        ),
    )
    backend = ("monitoring", "kps-kube-prometheus-stack-prometheus:9090")
    fake_api.service_backends[backend] = fake_prometheus.url

    body = (await http.get(f"{BASE}/{kube_cluster}")).json()

    [prometheus] = by_type(body["found"])["prometheus"]
    assert prometheus["service"] == "kps-kube-prometheus-stack-prometheus"
    assert (prometheus["port"], prometheus["state"]) == ("9090", "reachable")


async def test_operated_service_with_a_broader_selector_is_the_same_tool(
    monitoring_app, fake_api, kube_cluster, fake_prometheus
):
    """kube-prometheus-stack as installed: `prometheus-operated` selects every Prometheus Pod,
    the main Service only its own (a superset of the selector)."""
    http, _ = monitoring_app
    seed(
        fake_api,
        service(
            "monitoring",
            "prometheus-operated",
            labels={"operated-prometheus": "true"},
            ports=[tcp("http-web", 9090)],
            cluster_ip="None",
            selector={"app.kubernetes.io/name": "prometheus"},
        ),
        service(
            "monitoring",
            "kps-kube-prometheus-stack-prometheus",
            labels={"app": "kube-prometheus-stack-prometheus"},
            ports=[tcp("http-web", 9090), tcp("reloader-web", 8080)],
            selector={
                "app.kubernetes.io/name": "prometheus",
                "operator.prometheus.io/name": "kps-kube-prometheus-stack-prometheus",
            },
        ),
        # Another Prometheus in another namespace stays its own tool.
        service(
            "other",
            "prometheus-operated",
            labels={"operated-prometheus": "true"},
            ports=[tcp("http-web", 9090)],
            cluster_ip="None",
            selector={"app.kubernetes.io/name": "prometheus"},
        ),
    )
    backend = ("monitoring", "kps-kube-prometheus-stack-prometheus:9090")
    fake_api.service_backends[backend] = fake_prometheus.url

    body = (await http.get(f"{BASE}/{kube_cluster}")).json()

    found = by_type(body["found"])["prometheus"]
    assert [(t["namespace"], t["service"]) for t in found] == [
        ("monitoring", "kps-kube-prometheus-stack-prometheus"),
        ("other", "prometheus-operated"),
    ]
    assert found[0]["state"] == "reachable"


async def test_existing_source_is_recognised(
    monitoring_app, fake_api, kube_cluster, fake_prometheus
):
    http, _ = monitoring_app
    seed(fake_api, prometheus_server())
    fake_api.service_backends[("monitoring", "prometheus-server:80")] = fake_prometheus.url
    created = await http.post(
        "/api/monitoring/sources",
        json={
            "type": "prometheus",
            "reach": "cluster",
            "cluster_id": kube_cluster,
            "namespace": "monitoring",
            "service": "prometheus-server",
            "port": "80",
        },
    )
    assert created.status_code == 201

    body = (await http.get(f"{BASE}/{kube_cluster}")).json()

    [prometheus] = by_type(body["found"])["prometheus"]
    assert prometheus["existing_source_id"] == created.json()["id"]
    assert prometheus["state"] == "reachable"


async def test_a_source_using_the_port_name_is_recognised_too(
    monitoring_app, fake_api, kube_cluster, fake_prometheus
):
    http, _ = monitoring_app
    seed(fake_api, prometheus_server())
    fake_api.service_backends[("monitoring", "prometheus-server:http")] = fake_prometheus.url
    created = await http.post(
        "/api/monitoring/sources",
        json={
            "type": "prometheus",
            "reach": "cluster",
            "cluster_id": kube_cluster,
            "namespace": "monitoring",
            "service": "prometheus-server",
            "port": "http",
        },
    )

    body = (await http.get(f"{BASE}/{kube_cluster}")).json()

    [prometheus] = by_type(body["found"])["prometheus"]
    assert prometheus["existing_source_id"] == created.json()["id"]


async def test_unknown_cluster_is_404(monitoring_app):
    http, _ = monitoring_app
    response = await http.get(f"{BASE}/no-such-cluster")
    assert response.status_code == 404
    assert response.json() == {"detail": CLUSTER_GONE}
    assert CLUSTER_GONE == "That cluster isn't connected to OmniKrux any more."


async def test_services_that_cant_be_listed_are_an_error(monitoring_app, fake_api, kube_cluster):
    http, _ = monitoring_app
    fake_api.forbidden_kinds = {"services"}

    body = (await http.get(f"{BASE}/{kube_cluster}")).json()

    assert body["state"] == "error"
    assert body["found"] == []
    assert body["message"].startswith("Not allowed to list the cluster's services")


def closed_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


async def test_discovery_on_a_cloud_cluster_keeps_the_endpoint_private(
    cloud_cluster, cloud_http_client, monkeypatch
):
    app, cluster, _ = cloud_cluster
    port = closed_port()
    registry = app.state.registry
    real = registry.get_kubeconfig

    async def unreachable(cluster_id: str) -> dict:
        kubeconfig = await real(cluster_id)
        for entry in kubeconfig["clusters"]:
            entry["cluster"]["server"] = f"https://127.0.0.1:{port}"
        return kubeconfig

    monkeypatch.setattr(registry, "get_kubeconfig", unreachable)

    response = await cloud_http_client.get(f"{BASE}/{cluster.id}")

    assert response.status_code == 200
    body = response.json()
    assert body["state"] == "error" and body["found"] == []
    # The cloud client's own safe words (`CloudClusterUnavailable`), passed on unchanged.
    assert body["message"] == (
        "The connection to the cluster failed. Check the network, then try again."
    )
    assert "127.0.0.1" not in response.text
    assert str(port) not in response.text


async def test_the_cluster_probe_reads_what_the_cluster_serves(
    monitoring_app, fake_api, kube_cluster
):
    _, app = monitoring_app
    probe = app.state.monitoring.discovery.probe(kube_cluster)
    assert isinstance(probe, KubeClusterProbe)
    assert not await probe.serves("monitoring.coreos.com", "v1", "prometheusrules")
    fake_api.resources.append(
        FakeResource("monitoring.coreos.com", "v1", "prometheusrules", "PrometheusRule", True)
    )
    assert await probe.serves("monitoring.coreos.com", "v1", "prometheusrules")
    assert not await probe.serves("monitoring.coreos.com", "v1", "alertmanagers")


async def test_alerting_asks_the_cluster_for_the_operator(
    monitoring_app, fake_api, kube_cluster, fake_prometheus
):
    http, _ = monitoring_app
    fake_api.service_backends[("monitoring", "prometheus-server:80")] = fake_prometheus.url
    created = (
        await http.post(
            "/api/monitoring/sources",
            json={
                "type": "prometheus",
                "reach": "cluster",
                "cluster_id": kube_cluster,
                "namespace": "monitoring",
                "service": "prometheus-server",
                "port": "80",
            },
        )
    ).json()
    url = f"/api/monitoring/sources/{created['id']}/alerting"

    assert (await http.get(url)).json() == {
        "omnikrux_engine": True,
        "tool_engine": None,
        "reason": NO_OPERATOR,
    }
    fake_api.resources.append(
        FakeResource("monitoring.coreos.com", "v1", "prometheusrules", "PrometheusRule", True)
    )
    assert (await http.get(url)).json() == {
        "omnikrux_engine": True,
        "tool_engine": "prometheus_rule",
        "reason": None,
    }


HTTP = [tcp("http", 80)]
# (Service name, labels, the tool it is), all with an `http` port.
RULE_CASES = [
    ("anything", {"app.kubernetes.io/name": "prometheus"}, "prometheus"),
    ("anything", {"app": "prometheus"}, "prometheus"),
    ("anything", {"app": "kube-prometheus-stack-prometheus"}, "prometheus"),
    ("anything", {"operated-prometheus": "true"}, "prometheus"),
    ("prometheus-k8s", {}, "prometheus"),
    ("thanos-query-frontend", {}, "prometheus"),
    ("vmsingle-main", {}, "prometheus"),
    ("victoria-metrics-single-server", {}, "prometheus"),
    ("mimir-query-frontend", {}, "prometheus"),
    ("team-prometheus", {}, "prometheus"),
    ("prometheus-server", {"app": "prometheus", "component": "alertmanager"}, None),
    (
        "x",
        {"app.kubernetes.io/name": "prometheus", "app.kubernetes.io/component": "operator"},
        None,
    ),
    ("kps-prometheus", {"app.kubernetes.io/component": "prometheus-operator"}, None),
    ("prometheus-pushgateway", {"app": "prometheus", "component": "pushgateway"}, None),
    ("ksm", {"app": "prometheus", "component": "kube-state-metrics"}, None),
    ("x", {"app.kubernetes.io/name": "loki"}, "loki"),
    ("x", {"app.kubernetes.io/name": "loki", "app.kubernetes.io/component": "read"}, "loki"),
    ("x", {"app.kubernetes.io/name": "loki", "app.kubernetes.io/component": "gateway"}, "loki"),
    (
        "loki-write",
        {"app.kubernetes.io/name": "loki", "app.kubernetes.io/component": "write"},
        None,
    ),
    ("loki-gateway", {}, "loki"),
    ("loki-query-frontend", {}, "loki"),
    ("x", {"app.kubernetes.io/name": "grafana"}, "grafana"),
    ("grafana", {}, "grafana"),
    ("kps-grafana", {}, "grafana"),
    ("prometheus-node-exporter", {}, None),
    ("alertmanager", {}, "alertmanager"),
    # A Loki's gossip ring is never a tool, whatever its ports.
    ("loki-memberlist", {"app.kubernetes.io/name": "loki"}, None),
    ("ring", {"app.kubernetes.io/name": "loki", "app.kubernetes.io/part-of": "memberlist"}, None),
]
GOSSIP = [tcp("tcp", 7946)]
# (Service name, labels, ports, the tool it is): without a component label only a port that
# looks like the tool's HTTP API makes it a candidate.
PORT_CASES = [
    ("loki-memberlist", {"app.kubernetes.io/name": "loki"}, [tcp("http", 3100)], None),
    ("loki-memberlist", {"app.kubernetes.io/name": "loki"}, GOSSIP, None),
    ("loki-ring", {"app.kubernetes.io/name": "loki"}, GOSSIP, None),
    ("loki-ring", {"app.kubernetes.io/name": "loki"}, [tcp("tcp", 3100)], "loki"),
    ("grafana", {}, [tcp("ui", 7777)], None),
    ("grafana", {}, [tcp("ui", 3000)], "grafana"),
    (
        "x",
        {"app.kubernetes.io/name": "loki", "app.kubernetes.io/component": "read"},
        GOSSIP,
        "loki",
    ),
    ("loki", {"app.kubernetes.io/name": "loki"}, [], None),
]


@pytest.mark.parametrize(
    ("name", "labels", "ports", "expected"),
    [(name, labels, HTTP, expected) for name, labels, expected in RULE_CASES] + PORT_CASES,
)
def test_candidate_rules(name, labels, ports, expected):
    found = candidates([service("monitoring", name, labels=labels, ports=ports)])
    assert [c.type for c in found] == ([expected] if expected else [])


@pytest.mark.parametrize(
    ("type", "ports", "expected"),
    [
        ("prometheus", [tcp("grpc", 10901), tcp("http", 9090)], ("9090", "http", "http")),
        (
            "prometheus",
            [tcp("reloader-web", 8080), tcp("http-web", 9090)],
            ("9090", "http-web", "http"),
        ),
        ("prometheus", [tcp("a", 1234), tcp("b", 8481)], ("8481", "b", "http")),
        ("loki", [tcp("grpc", 9095), tcp("x", 3100)], ("3100", "x", "http")),
        ("grafana", [tcp("a", 1), tcp("b", 3000)], ("3000", "b", "http")),
        (
            "grafana",
            [{"name": "udp", "port": 53, "protocol": "UDP"}, tcp("z", 7777)],
            ("7777", "z", "http"),
        ),
        ("prometheus", [tcp("https", 8443)], ("8443", "https", "https")),
        ("prometheus", [tcp("other", 443)], ("443", "other", "https")),
        ("prometheus", [], None),
        # The UDP port of the same number never lends its name.
        (
            "loki",
            [{"name": "dns", "port": 3100, "protocol": "UDP"}, tcp("api", 3100)],
            ("3100", "api", "http"),
        ),
    ],
)
def test_port_rules(type, ports, expected):
    assert pick_port(type, ports) == expected


def test_only_the_named_or_numbered_port_without_any_tcp():
    assert pick_port("loki", [tcp("tcp", 7946)], any_tcp=False) is None
    assert pick_port("loki", [tcp("tcp", 7946)]) == ("7946", "tcp", "http")
